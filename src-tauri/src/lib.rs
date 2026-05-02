mod claude_web_sync;
mod diagnostics;
mod hook_watcher;
mod pty_manager;
mod workspace_store;

use jieba_rs::Jieba;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::Duration;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{self, Value as TantivyValue, *};
use tantivy::tokenizer::{LowerCaser, TextAnalyzer, Token, TokenStream, Tokenizer};
use tantivy::{doc, Index, IndexWriter, ReloadPolicy};
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
use objc::runtime::YES;
#[cfg(target_os = "macos")]
use objc::*;

// Global jieba instance for Chinese tokenization
static JIEBA: LazyLock<Jieba> = LazyLock::new(|| Jieba::new());

// Cache for command stats with incremental update support
// (stats, scanned_files with their mtime)
static COMMAND_STATS_CACHE: LazyLock<Mutex<CommandStatsCache>> =
    LazyLock::new(|| Mutex::new(CommandStatsCache::default()));

#[derive(Default)]
struct CommandStatsCache {
    stats: HashMap<String, usize>,
    scanned: HashMap<String, u64>, // path -> file_size (for incremental read)
}

// Custom tokenizer for Chinese + English mixed content
#[derive(Clone)]
struct JiebaTokenizer;

impl Tokenizer for JiebaTokenizer {
    type TokenStream<'a> = JiebaTokenStream;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        let words = JIEBA.cut_for_search(text, true);
        let mut tokens = Vec::new();
        let base = text.as_ptr() as usize;

        for word in words {
            let word_str = word.trim();
            if !word_str.is_empty() {
                let start = word.as_ptr() as usize - base;
                let end = start + word.len();
                tokens.push(Token {
                    offset_from: start,
                    offset_to: end,
                    position: tokens.len(),
                    text: word_str.to_string(),
                    position_length: 1,
                });
            }
        }

        JiebaTokenStream { tokens, index: 0 }
    }
}

struct JiebaTokenStream {
    tokens: Vec<Token>,
    index: usize,
}

impl TokenStream for JiebaTokenStream {
    fn advance(&mut self) -> bool {
        if self.index < self.tokens.len() {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn token(&self) -> &Token {
        &self.tokens[self.index - 1]
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.tokens[self.index - 1]
    }
}

// Global search index state
static SEARCH_INDEX: Mutex<Option<SearchIndex>> = Mutex::new(None);

// Distill watch state
static DISTILL_WATCH_ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

// Claude Code install process PID (for cancellation)
static CC_INSTALL_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

struct SearchIndex {
    index: Index,
    schema: Schema,
}

fn get_index_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("lovcode")
        .join("search-index")
}

fn get_command_stats_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("lovcode")
        .join("command-stats.json")
}

const JIEBA_TOKENIZER_NAME: &str = "jieba";

fn create_schema() -> Schema {
    let mut schema_builder = Schema::builder();

    // Use custom jieba tokenizer for content fields to support Chinese
    let text_options = TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(JIEBA_TOKENIZER_NAME)
                .set_index_option(schema::IndexRecordOption::WithFreqsAndPositions),
        )
        .set_stored();

    schema_builder.add_text_field("uuid", STRING | STORED);
    schema_builder.add_text_field("content", text_options.clone());
    schema_builder.add_text_field("role", STRING | STORED);
    schema_builder.add_text_field("project_id", STRING | STORED);
    schema_builder.add_text_field("project_path", STRING | STORED);
    schema_builder.add_text_field("session_id", STRING | STORED);
    schema_builder.add_text_field("session_summary", text_options);
    schema_builder.add_text_field("timestamp", STRING | STORED);
    schema_builder.build()
}

fn register_jieba_tokenizer(index: &Index) {
    let tokenizer = TextAnalyzer::builder(JiebaTokenizer)
        .filter(LowerCaser)
        .build();
    index.tokenizers().register(JIEBA_TOKENIZER_NAME, tokenizer);
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub path: String,
    pub session_count: usize,
    pub last_active: u64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SessionUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: f64, // estimated cost in USD
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub project_path: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub message_count: usize,
    pub created_at: u64,
    pub last_modified: u64,
    pub usage: Option<SessionUsage>,
    /// One of:
    ///   "cli"        — local Claude Code CLI session (~/.claude/projects/<encoded>/<uuid>.jsonl)
    ///   "app-code"   — Claude desktop app's Code tab session (richer metadata, links to same CLI .jsonl)
    ///   "app-web"    — claude.ai web conversation synced via Claude desktop app cookie
    ///   "app-cowork" — Claude desktop app Cowork session (reserved, not yet implemented)
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "cli".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String, summary: String },
    #[serde(rename = "tool_result")]
    ToolResult { tool_use_id: String, content: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Message {
    pub uuid: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub is_meta: bool,  // slash command 展开的内容
    pub is_tool: bool,  // tool_use 或 tool_result
    pub line_number: usize,
    pub content_blocks: Option<Vec<ContentBlock>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub uuid: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub project_id: String,
    pub project_path: String,
    pub session_id: String,
    pub session_summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatsResponse {
    pub items: Vec<ChatMessage>,
    pub total: usize,
}

#[derive(Debug, Deserialize)]
struct RawLine {
    #[serde(rename = "type")]
    line_type: Option<String>,
    summary: Option<String>,
    slug: Option<String>,
    uuid: Option<String>,
    cwd: Option<String>,
    message: Option<RawMessage>,
    timestamp: Option<String>,
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
struct RawUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RawMessage {
    role: Option<String>,
    content: Option<serde_json::Value>,
    usage: Option<RawUsage>,
}

/// Entry from history.jsonl - used as fast session index
#[derive(Debug, Deserialize)]
struct HistoryEntry {
    display: Option<String>,
    timestamp: Option<u64>,
    project: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

// ============================================================================
// Commands & Settings Types
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalCommand {
    pub name: String,
    pub path: String,
    pub description: Option<String>,
    pub allowed_tools: Option<String>,
    pub argument_hint: Option<String>,
    pub content: String,
    pub version: Option<String>,
    pub status: String,                // "active" | "deprecated" | "archived"
    pub deprecated_by: Option<String>, // replacement command name
    pub changelog: Option<String>,     // changelog content if .changelog file exists
    pub aliases: Vec<String>,          // previous names for stats aggregation
    pub frontmatter: Option<String>,   // raw frontmatter text (if any)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub server_type: Option<String>, // "http" | "sse" | "stdio"
    pub url: Option<String>,         // for http/sse servers
    pub command: Option<String>,     // for stdio servers
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClaudeSettings {
    pub raw: Value,
    pub permissions: Option<Value>,
    pub hooks: Option<Value>,
    pub mcp_servers: Vec<McpServer>,
}

fn get_claude_dir() -> PathBuf {
    dirs::home_dir().unwrap().join(".claude")
}

fn get_lovstudio_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".lovstudio")
        .join("lovcode")
}

fn get_disabled_env_path() -> PathBuf {
    get_lovstudio_dir().join("disabled_env.json")
}

fn load_disabled_env() -> Result<serde_json::Map<String, Value>, String> {
    let path = get_disabled_env_path();
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(value.as_object().cloned().unwrap_or_default())
}

fn save_disabled_env(disabled: &serde_json::Map<String, Value>) -> Result<(), String> {
    let path = get_disabled_env_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let output = serde_json::to_string_pretty(&Value::Object(disabled.clone()))
        .map_err(|e| e.to_string())?;
    fs::write(&path, output).map_err(|e| e.to_string())?;
    Ok(())
}

fn get_provider_contexts_path() -> PathBuf {
    get_lovstudio_dir().join("provider_contexts.json")
}

fn load_provider_contexts() -> Result<serde_json::Map<String, Value>, String> {
    let path = get_provider_contexts_path();
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(value.as_object().cloned().unwrap_or_default())
}

fn save_provider_contexts(contexts: &serde_json::Map<String, Value>) -> Result<(), String> {
    let path = get_provider_contexts_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let output = serde_json::to_string_pretty(&Value::Object(contexts.clone()))
        .map_err(|e| e.to_string())?;
    fs::write(&path, output).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// MaaS Registry (provider + model mappings for empty-state cascading picker)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaasModel {
    id: String,
    display_name: String,
    model_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaasProvider {
    key: String,
    label: String,
    base_url: String,
    auth_env_key: String,
    models: Vec<MaasModel>,
}

fn get_maas_registry_path() -> PathBuf {
    get_lovstudio_dir().join("maas_registry.json")
}

fn default_maas_registry() -> Vec<MaasProvider> {
    fn m(id: &str, display: &str, name: &str) -> MaasModel {
        MaasModel {
            id: id.to_string(),
            display_name: display.to_string(),
            model_name: name.to_string(),
        }
    }
    let anthropic_native_models = vec![
        m("opus-4-7", "Claude Opus 4.7", "claude-opus-4-7-20251101"),
        m("sonnet-4-6", "Claude Sonnet 4.6", "claude-sonnet-4-6-20251001"),
        m("haiku-4-5", "Claude Haiku 4.5", "claude-haiku-4-5-20250930"),
    ];
    vec![
        MaasProvider {
            key: "anthropic-subscription".into(),
            label: "Anthropic Subscription".into(),
            base_url: "".into(),
            auth_env_key: "CLAUDE_CODE_USE_OAUTH".into(),
            models: anthropic_native_models.clone(),
        },
        MaasProvider {
            key: "native".into(),
            label: "Anthropic API".into(),
            base_url: "https://api.anthropic.com".into(),
            auth_env_key: "ANTHROPIC_API_KEY".into(),
            models: anthropic_native_models,
        },
        MaasProvider {
            key: "zenmux".into(),
            label: "ZenMux".into(),
            base_url: "https://zenmux.ai/api/anthropic".into(),
            auth_env_key: "ZENMUX_API_KEY".into(),
            models: vec![
                m("sonnet-4-6", "Claude Sonnet 4.6", "anthropic/claude-sonnet-4-6-20251001"),
                m("sonnet-4-5", "Claude Sonnet 4.5", "anthropic/claude-sonnet-4.5"),
                m("haiku-4-5", "Claude Haiku 4.5", "anthropic/claude-haiku-4.5"),
            ],
        },
        MaasProvider {
            key: "modelgate".into(),
            label: "ModelGate".into(),
            base_url: "https://mg.aid.pub/claude-proxy".into(),
            auth_env_key: "MODELGATE_API_KEY".into(),
            models: vec![
                m("sonnet-4-6", "Claude Sonnet 4.6", "anthropic/claude-sonnet-4-6-20251001"),
                m("sonnet-4-5", "Claude Sonnet 4.5", "anthropic/claude-sonnet-4.5"),
                m("haiku-4-5", "Claude Haiku 4.5", "anthropic/claude-haiku-4.5"),
            ],
        },
        MaasProvider {
            key: "qiniu".into(),
            label: "Qiniu Cloud".into(),
            base_url: "https://api.qnaigc.com".into(),
            auth_env_key: "QINIU_API_KEY".into(),
            models: vec![
                m("sonnet-4-6", "Claude Sonnet 4.6", "claude-sonnet-4-6-20251001"),
                m("haiku-4-5", "Claude Haiku 4.5", "claude-haiku-4-5-20250930"),
            ],
        },
        MaasProvider {
            key: "siliconflow".into(),
            label: "SiliconFlow".into(),
            base_url: "https://api.siliconflow.com/v1".into(),
            auth_env_key: "SILICONFLOW_API_KEY".into(),
            models: vec![
                m("sonnet-4-5", "Claude Sonnet 4.5", "claude-sonnet-4-5"),
                m("haiku-4-5", "Claude Haiku 4.5", "claude-haiku-4-5"),
            ],
        },
        MaasProvider {
            key: "univibe".into(),
            label: "UniVibe".into(),
            base_url: "https://api.univibe.cc/anthropic".into(),
            auth_env_key: "UNIVIBE_API_KEY".into(),
            models: vec![
                m("sonnet-4-6", "Claude Sonnet 4.6", "claude-sonnet-4-6-20251001"),
                m("haiku-4-5", "Claude Haiku 4.5", "claude-haiku-4-5-20250930"),
            ],
        },
    ]
}

fn load_maas_registry() -> Result<Vec<MaasProvider>, String> {
    let path = get_maas_registry_path();
    if !path.exists() {
        return Ok(default_maas_registry());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn persist_maas_registry(registry: &[MaasProvider]) -> Result<(), String> {
    let path = get_maas_registry_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let output = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    fs::write(&path, output).map_err(|e| e.to_string())?;
    Ok(())
}

/// Get path to ~/.claude.json (MCP servers config)
fn get_claude_json_path() -> PathBuf {
    dirs::home_dir().unwrap().join(".claude.json")
}

/// Encode project path to project ID (inverse of decode_project_path).
/// Claude Code encodes: `/.` -> `--`, then `/` -> `-`
fn encode_project_path(path: &str) -> String {
    path.replace("/.", "--").replace("/", "-")
}

/// Decode project ID to actual filesystem path.
/// Claude Code encodes: `/` -> `-`, and `.` -> `-`
/// So `/.` becomes `--`, but `-` in directory names is NOT escaped
fn decode_project_path(id: &str) -> String {
    // Check for custom display name (used by imported data sources)
    let display_name_file = get_claude_dir().join("projects").join(id).join(".display_name");
    if let Ok(name) = fs::read_to_string(&display_name_file) {
        let name = name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }

    // First, handle `--` which means `/.` (hidden directories like .claude)
    // Replace `--` with a placeholder, then `-` with `/`, then restore `/.`
    let base = id
        .replace("--", "\x00")
        .replace("-", "/")
        .replace("\x00", "/.");

    // Normalize: strip trailing /. and / segments (e.g. /Users/mark/././ → /Users/mark)
    let base = base.trim_end_matches('/').to_string();
    let base = {
        let mut b = base.as_str();
        while b.ends_with("/.") {
            b = b.trim_end_matches("/.").trim_end_matches('/');
        }
        b.to_string()
    };

    // If the base path exists, we're done
    if PathBuf::from(&base).exists() {
        return base;
    }

    // Otherwise, the project name likely contains hyphens
    // Try progressively merging path segments after common base directories
    for base_dir in &["/projects/", "/repos/", "/Documents/", "/Desktop/"] {
        if let Some(idx) = base.find(base_dir) {
            let prefix = &base[..idx + base_dir.len()];
            let rest = &base[idx + base_dir.len()..];

            // Try merging segments: /a/b/c -> a-b-c, a-b/c, a/b-c, etc.
            if let Some(merged) = try_merge_segments(prefix, rest) {
                return merged;
            }
        }
    }

    // Try merging from /Users/mark/ (home dir) as base
    if let Some(home) = dirs::home_dir() {
        let home_str = format!("{}/", home.display());
        if base.starts_with(&home_str) {
            let rest = &base[home_str.len()..];
            if let Some(merged) = try_merge_segments(&home_str, rest) {
                return merged;
            }
        }
    }

    // Fallback to base interpretation
    base
}

/// Try different combinations of merging path segments with hyphens
fn try_merge_segments(prefix: &str, rest: &str) -> Option<String> {
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return None;
    }

    // Try merging all segments into one (most common: project-name-here)
    let all_merged = format!("{}{}", prefix, segments.join("-"));
    if PathBuf::from(&all_merged).exists() {
        return Some(all_merged);
    }

    // Try merging first N segments, leaving rest as subdirs
    for merge_count in (1..segments.len()).rev() {
        let merged_part = segments[..=merge_count].join("-");
        let rest_part = segments[merge_count + 1..].join("/");
        let candidate = if rest_part.is_empty() {
            format!("{}{}", prefix, merged_part)
        } else {
            format!("{}{}/{}", prefix, merged_part, rest_part)
        };
        if PathBuf::from(&candidate).exists() {
            return Some(candidate);
        }
    }

    None
}

#[tauri::command]
async fn list_projects() -> Result<Vec<Project>, String> {
    // Run blocking IO on a separate thread to avoid blocking the main thread
    tauri::async_runtime::spawn_blocking(|| {
        let projects_dir = get_claude_dir().join("projects");

        if !projects_dir.exists() {
            return Ok(vec![]);
        }

        let mut projects = Vec::new();

        for entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();

            if path.is_dir() {
                let id = path.file_name().unwrap().to_string_lossy().to_string();
                let display_path = decode_project_path(&id);

                let mut session_count = 0;
                let mut last_active: u64 = 0;

                if let Ok(entries) = fs::read_dir(&path) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.ends_with(".jsonl") && !name.starts_with("agent-") {
                            session_count += 1;
                            if let Ok(meta) = entry.metadata() {
                                if let Ok(modified) = meta.modified() {
                                    if let Ok(duration) =
                                        modified.duration_since(std::time::UNIX_EPOCH)
                                    {
                                        last_active = last_active.max(duration.as_secs());
                                    }
                                }
                            }
                        }
                    }
                }

                projects.push(Project {
                    id: id.clone(),
                    path: display_path,
                    session_count,
                    last_active,
                });
            }
        }

        projects.sort_by(|a, b| b.last_active.cmp(&a.last_active));
        Ok(projects)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_sessions(project_id: String) -> Result<Vec<Session>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project_dir = get_claude_dir().join("projects").join(&project_id);

        if !project_dir.exists() {
            return Err("Project not found".to_string());
        }

        let mut sessions = Vec::new();

        for entry in fs::read_dir(&project_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();

            if name.ends_with(".jsonl") && !name.starts_with("agent-") {
                let session_id = name.trim_end_matches(".jsonl").to_string();

                let head = read_session_head(&path, 20);

                let metadata = fs::metadata(&path).ok();
                let last_modified = metadata.as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let created_at = metadata.as_ref()
                    .and_then(|m| m.created().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(last_modified);

                sessions.push(Session {
                    id: session_id,
                    project_id: project_id.clone(),
                    project_path: None,
                    title: head.title,
                    summary: head.summary,
                    message_count: head.message_count,
                    created_at,
                    last_modified,
                    usage: None,
                    source: "cli".to_string(),
                });
            }
        }

        sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
        Ok(sessions)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pricing constants (USD per 1M tokens) - Claude Opus 4.5 pricing as baseline
const PRICE_INPUT_PER_M: f64 = 15.0;
const PRICE_OUTPUT_PER_M: f64 = 75.0;
const PRICE_CACHE_WRITE_PER_M: f64 = 3.75; // cache creation
const PRICE_CACHE_READ_PER_M: f64 = 0.30;  // cache read

/// Calculate cost from token counts
fn calculate_cost(usage: &SessionUsage) -> f64 {
    let input_cost = (usage.input_tokens as f64 / 1_000_000.0) * PRICE_INPUT_PER_M;
    let output_cost = (usage.output_tokens as f64 / 1_000_000.0) * PRICE_OUTPUT_PER_M;
    let cache_write_cost = (usage.cache_creation_tokens as f64 / 1_000_000.0) * PRICE_CACHE_WRITE_PER_M;
    let cache_read_cost = (usage.cache_read_tokens as f64 / 1_000_000.0) * PRICE_CACHE_READ_PER_M;
    input_cost + output_cost + cache_write_cost + cache_read_cost
}

/// Read usage data from a session file
fn read_session_usage(path: &Path) -> SessionUsage {
    use std::io::{BufRead, BufReader};

    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return SessionUsage::default(),
    };

    let reader = BufReader::new(file);
    let mut usage = SessionUsage::default();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if let Ok(parsed) = serde_json::from_str::<RawLine>(&line) {
            // Only assistant messages have usage data. Match both legacy
            // (type=assistant) and Claude desktop app (type=message + role=assistant).
            let lt = parsed.line_type.as_deref();
            let is_assistant = lt == Some("assistant")
                || (lt == Some("message")
                    && parsed.message.as_ref().and_then(|m| m.role.as_deref()) == Some("assistant"));
            if is_assistant {
                if let Some(msg) = &parsed.message {
                    if let Some(u) = &msg.usage {
                        usage.input_tokens += u.input_tokens.unwrap_or(0);
                        usage.output_tokens += u.output_tokens.unwrap_or(0);
                        usage.cache_creation_tokens += u.cache_creation_input_tokens.unwrap_or(0);
                        usage.cache_read_tokens += u.cache_read_input_tokens.unwrap_or(0);
                    }
                }
            }
        }
    }

    usage.cost_usd = calculate_cost(&usage);
    usage
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionUsageEntry {
    pub session_id: String,
    pub usage: SessionUsage,
}

#[tauri::command]
async fn get_sessions_usage(project_id: String) -> Result<Vec<SessionUsageEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project_dir = get_claude_dir().join("projects").join(&project_id);

        if !project_dir.exists() {
            return Err("Project not found".to_string());
        }

        let mut results = Vec::new();

        for entry in fs::read_dir(&project_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();

            if name.ends_with(".jsonl") && !name.starts_with("agent-") {
                let session_id = name.trim_end_matches(".jsonl").to_string();
                let usage = read_session_usage(&path);
                results.push(SessionUsageEntry { session_id, usage });
            }
        }

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Session head info parsed from first N lines
struct SessionHead {
    title: Option<String>,
    summary: Option<String>,
    cwd: Option<String>,
    message_count: usize,
}

/// Convert slug like "soft-petting-wave" to "Soft Petting Wave"
fn slug_to_title(slug: &str) -> String {
    slug.split('-')
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(c) => format!("{}{}", c.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Count user+assistant messages by streaming the whole file.
/// Cheap: only parses the `type` field via a tiny regex-free string check.
///
/// Two on-disk formats need to be supported:
/// - Legacy CLI: top-level `"type":"user"` / `"type":"assistant"`
/// - Claude desktop app (Code 栏): top-level `"type":"user"` / `"type":"message"`,
///   where assistant turns are wrapped as `{"type":"message","message":{"role":"assistant",...}}`.
fn count_session_messages(path: &Path) -> usize {
    use std::io::{BufRead, BufReader};
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return 0,
    };
    let reader = BufReader::new(file);
    let mut count = 0;
    for line in reader.lines().map_while(Result::ok) {
        if line.contains("\"type\":\"user\"") || line.contains("\"type\":\"assistant\"") {
            count += 1;
        } else if line.contains("\"type\":\"message\"") && line.contains("\"role\":\"assistant\"") {
            count += 1;
        }
    }
    count
}

/// Read only the first N lines of a session file to get summary (much faster than reading entire file)
fn read_session_head(path: &Path, max_lines: usize) -> SessionHead {
    use std::io::{BufRead, BufReader};

    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return SessionHead { title: None, summary: None, cwd: None, message_count: 0 },
    };

    let reader = BufReader::new(file);
    let mut summary = None;
    let mut slug: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut first_user_message: Option<String> = None;
    let mut message_count = 0;

    for line in reader.lines().take(max_lines) {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if let Ok(parsed) = serde_json::from_str::<RawLine>(&line) {
            // Capture slug from any line that has it
            if slug.is_none() {
                if let Some(s) = &parsed.slug {
                    if !s.is_empty() {
                        slug = Some(s.clone());
                    }
                }
            }
            if parsed.line_type.as_deref() == Some("summary") {
                summary = parsed.summary;
            }
            if parsed.line_type.as_deref() == Some("user") {
                message_count += 1;
                // Capture cwd from first user message
                if cwd.is_none() {
                    if let Some(c) = &parsed.cwd {
                        if !c.is_empty() {
                            cwd = Some(c.clone());
                        }
                    }
                }
                // Capture first user message as fallback summary
                if first_user_message.is_none() {
                    if let Some(msg) = &parsed.message {
                        if let Some(content) = &msg.content {
                            // Extract text from content (can be string or array)
                            let text_content = match content {
                                serde_json::Value::String(s) => Some(s.clone()),
                                serde_json::Value::Array(arr) => {
                                    // Find first text block
                                    arr.iter().find_map(|item| {
                                        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                            item.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                                        } else {
                                            None
                                        }
                                    })
                                }
                                _ => None,
                            };
                            if let Some(text) = text_content {
                                let restored = restore_slash_command(&text);
                                let display = if restored.chars().count() > 80 {
                                    format!("{}...", restored.chars().take(80).collect::<String>())
                                } else {
                                    restored
                                };
                                first_user_message = Some(display);
                            }
                        }
                    }
                }
            }
            if parsed.line_type.as_deref() == Some("assistant") {
                message_count += 1;
            }
            // Claude desktop app format wraps assistant turns as type=message + role=assistant
            if parsed.line_type.as_deref() == Some("message") {
                if let Some(msg) = &parsed.message {
                    if msg.role.as_deref() == Some("assistant") || msg.role.as_deref() == Some("user") {
                        message_count += 1;
                    }
                }
            }
        }
    }

    let title = slug.map(|s| slug_to_title(&s));
    let final_summary = summary.or(first_user_message).map(|s| restore_slash_command(&s));

    // The head sample (first N lines) only sees messages in the front of the
    // file. For accurate counts (esp. for sessions where the head is filled
    // with non-message entries like queue-operation/summary/hook events), do
    // one cheap streaming pass over the whole file. This is fast — we only
    // substring-match `"type":"user|assistant"` per line, no JSON parse.
    let _ = message_count;
    let message_count = count_session_messages(path);

    SessionHead { title, summary: final_summary, cwd, message_count }
}

/// Convert <command-message>...</command-message><command-name>/cmd</command-name> to /cmd format
fn restore_slash_command(content: &str) -> String {
    use regex::Regex;
    lazy_static::lazy_static! {
        // Extract command name
        static ref NAME_RE: Regex = Regex::new(r"<command-name>(/[^<]+)</command-name>").unwrap();
        // Extract args (handles multi-line)
        static ref ARGS_RE: Regex = Regex::new(r"(?s)<command-args>(.*?)</command-args>").unwrap();
        // Strip all command-related XML tags
        static ref STRIP_RE: Regex = Regex::new(r"(?s)<command-message>.*?</command-message>|</?command-[^>]*>").unwrap();
    }

    // Extract command name and args first
    let cmd = NAME_RE.captures(content)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    let args = ARGS_RE.captures(content)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| !s.is_empty());

    // Build result: command + args, then strip remaining tags
    let prefix = match (cmd, args) {
        (Some(c), Some(a)) => format!("{} {}", c, a),
        (Some(c), None) => c,
        _ => String::new(),
    };

    // Strip all command tags from original content
    let cleaned = STRIP_RE.replace_all(content, "").trim().to_string();

    // If we extracted a command, return it; otherwise return cleaned content
    if prefix.is_empty() {
        cleaned
    } else {
        prefix
    }
}

/// Build session index from history.jsonl (fast: only reads one file)
fn build_session_index_from_history() -> HashMap<(String, String), (u64, Option<String>)> {
    use std::io::{BufRead, BufReader};

    let history_path = get_claude_dir().join("history.jsonl");
    let mut index: HashMap<(String, String), (u64, Option<String>)> = HashMap::new();

    let file = match fs::File::open(&history_path) {
        Ok(f) => f,
        Err(_) => return index,
    };

    let reader = BufReader::new(file);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if let Ok(entry) = serde_json::from_str::<HistoryEntry>(&line) {
            if let (Some(session_id), Some(project), Some(timestamp)) =
                (entry.session_id, entry.project, entry.timestamp)
            {
                let project_id = encode_project_path(&project);
                // Keep the latest timestamp and display for each session
                index
                    .entry((project_id, session_id))
                    .and_modify(|(ts, disp)| {
                        if timestamp > *ts {
                            *ts = timestamp;
                            *disp = entry.display.clone();
                        }
                    })
                    .or_insert((timestamp, entry.display));
            }
        }
    }

    index
}

#[tauri::command]
async fn list_all_sessions() -> Result<Vec<Session>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let projects_dir = get_claude_dir().join("projects");

        if !projects_dir.exists() {
            return Ok(vec![]);
        }

        // Build index from history.jsonl first (fast)
        let history_index = build_session_index_from_history();

        let mut all_sessions = Vec::new();
        let mut seen_sessions: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();

        // First pass: use history index for sessions with sessionId
        for ((project_id, session_id), (timestamp, display)) in &history_index {
            let session_path = projects_dir
                .join(project_id)
                .join(format!("{}.jsonl", session_id));

            if !session_path.exists() {
                continue;
            }

            seen_sessions.insert((project_id.clone(), session_id.clone()));

            let head = read_session_head(&session_path, 20);

            // Use display as fallback summary
            let final_summary = head.summary.or_else(|| display.clone().map(|d| restore_slash_command(&d)));

            let metadata = fs::metadata(&session_path).ok();
            let last_modified = metadata.as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(*timestamp / 1000);
            let created_at = metadata.as_ref()
                .and_then(|m| m.created().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(last_modified);

            let display_path = head.cwd.clone().unwrap_or_else(|| decode_project_path(project_id));

            all_sessions.push(Session {
                id: session_id.clone(),
                project_id: project_id.clone(),
                project_path: Some(display_path),
                title: head.title,
                summary: final_summary,
                message_count: head.message_count,
                created_at,
                last_modified,
                usage: None,
                source: "cli".to_string(),
            });
        }

        // Second pass: scan for sessions not in history (older sessions without sessionId)
        for project_entry in fs::read_dir(&projects_dir).into_iter().flatten().flatten() {
            let project_path = project_entry.path();
            if !project_path.is_dir() {
                continue;
            }

            let project_id = project_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();
            let display_path = decode_project_path(&project_id);

            for entry in fs::read_dir(&project_path).into_iter().flatten().flatten() {
                let path = entry.path();
                let name = path.file_name().unwrap().to_string_lossy().to_string();

                if name.ends_with(".jsonl") && !name.starts_with("agent-") {
                    let session_id = name.trim_end_matches(".jsonl").to_string();

                    // Skip if already processed from history
                    if seen_sessions.contains(&(project_id.clone(), session_id.clone())) {
                        continue;
                    }

                    let head = read_session_head(&path, 20);
                    let session_path = head.cwd.clone().unwrap_or_else(|| display_path.clone());

                    let metadata = fs::metadata(&path).ok();
                    let last_modified = metadata.as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let created_at = metadata.as_ref()
                        .and_then(|m| m.created().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(last_modified);

                    all_sessions.push(Session {
                        id: session_id,
                        project_id: project_id.clone(),
                        project_path: Some(session_path),
                        title: head.title,
                        summary: head.summary,
                        message_count: head.message_count,
                        created_at,
                        last_modified,
                        usage: None,
                        source: "cli".to_string(),
                    });
                }
            }
        }

        // Third pass: Claude desktop app Code tab sessions
        // ~/Library/Application Support/Claude/claude-code-sessions/<deviceId>/<accountId>/local_*.json
        // These have richer metadata (title, cwd, lastActivityAt) and link to the same CLI .jsonl files.
        if let Some(home) = dirs::home_dir() {
            let app_sessions_root = home
                .join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude-code-sessions");
            if app_sessions_root.exists() {
                // walk deviceId / accountId levels
                for device_entry in fs::read_dir(&app_sessions_root).into_iter().flatten().flatten() {
                    for account_entry in fs::read_dir(device_entry.path()).into_iter().flatten().flatten() {
                        for file_entry in fs::read_dir(account_entry.path()).into_iter().flatten().flatten() {
                            let file_path = file_entry.path();
                            let fname = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                            if !fname.starts_with("local_") || !fname.ends_with(".json") {
                                continue;
                            }
                            let Ok(content) = fs::read_to_string(&file_path) else { continue };
                            let Ok(meta) = serde_json::from_str::<serde_json::Value>(&content) else { continue };

                            let cli_session_id = match meta.get("cliSessionId").and_then(|v| v.as_str()) {
                                Some(id) => id.to_string(),
                                None => continue,
                            };
                            let cwd = match meta.get("cwd").and_then(|v| v.as_str()) {
                                Some(p) => p.to_string(),
                                None => continue,
                            };

                            // Claude CLI encodes non-ASCII chars (e.g. 手工川 -> ----) in
                            // a lossy way that cannot be reversed by string substitution.
                            // Instead, scan project_dirs for the dir containing this jsonl.
                            let jsonl_filename = format!("{}.jsonl", cli_session_id);
                            let project_id = match seen_sessions.iter().find(|(_, sid)| sid == &cli_session_id) {
                                Some((pid, _)) => pid.clone(),
                                None => {
                                    // Fall back to filesystem scan
                                    let mut found = None;
                                    if let Ok(entries) = fs::read_dir(&projects_dir) {
                                        for e in entries.flatten() {
                                            if e.path().join(&jsonl_filename).exists() {
                                                found = Some(e.file_name().to_string_lossy().to_string());
                                                break;
                                            }
                                        }
                                    }
                                    // Last resort: synthesize encoded id (works for ASCII-only paths)
                                    found.unwrap_or_else(|| encode_project_path(&cwd))
                                }
                            };

                            // Skip if CLI already loaded this session with better data
                            if seen_sessions.contains(&(project_id.clone(), cli_session_id.clone())) {
                                // Upgrade title if app has one and CLI didn't
                                if let Some(s) = all_sessions.iter_mut().find(|s| s.id == cli_session_id && s.project_id == project_id) {
                                    if s.title.is_none() {
                                        s.title = meta.get("title").and_then(|v| v.as_str()).map(|t| t.to_string());
                                    }
                                    s.source = "app-code".to_string();
                                }
                                continue;
                            }

                            // Find the CLI .jsonl to get message_count
                            let jsonl_path = projects_dir.join(&project_id).join(&jsonl_filename);
                            let (message_count, jsonl_modified, jsonl_created) = if jsonl_path.exists() {
                                let head = read_session_head(&jsonl_path, 20);
                                let metadata = fs::metadata(&jsonl_path).ok();
                                let modified = metadata.as_ref()
                                    .and_then(|m| m.modified().ok())
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_secs())
                                    .unwrap_or(0);
                                let created = metadata.as_ref()
                                    .and_then(|m| m.created().ok())
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_secs())
                                    .unwrap_or(modified);
                                (head.message_count, modified, created)
                            } else {
                                (0, 0, 0)
                            };

                            let last_activity_ms = meta.get("lastActivityAt").and_then(|v| v.as_u64()).unwrap_or(0);
                            let last_modified = if jsonl_modified > 0 { jsonl_modified } else { last_activity_ms / 1000 };
                            let created_at = if jsonl_created > 0 { jsonl_created } else {
                                meta.get("createdAt").and_then(|v| v.as_u64()).map(|ms| ms / 1000).unwrap_or(last_modified)
                            };

                            let title = meta.get("title").and_then(|v| v.as_str()).map(|t| t.to_string());

                            seen_sessions.insert((project_id.clone(), cli_session_id.clone()));
                            all_sessions.push(Session {
                                id: cli_session_id,
                                project_id,
                                project_path: Some(cwd),
                                title,
                                summary: None,
                                message_count,
                                created_at,
                                last_modified,
                                usage: None,
                                source: "app-code".to_string(),
                            });
                        }
                    }
                }
            }
        }

        // Mark sessions living under the synthetic "-claude-ai" project as
        // app-web (synced from claude.ai). This stays after the desktop-app
        // Code pass so app-code wins if the same id ever appeared in both
        // (shouldn't happen — different id space — but defensive).
        for s in all_sessions.iter_mut() {
            if s.project_id == "-claude-ai" && s.source == "cli" {
                s.source = "app-web".to_string();
            }
        }

        // De-duplicate by session id. The same cliSessionId can be registered
        // from multiple passes if its project path encodes inconsistently
        // (e.g. CLI uses a different lossy encoding than ours for non-ASCII
        // cwds). When duplicates appear, keep the entry with the most
        // complete data (highest message_count, prefer source=app for title).
        let mut by_id: std::collections::HashMap<String, Session> = std::collections::HashMap::new();
        for s in all_sessions.into_iter() {
            match by_id.get(&s.id) {
                Some(existing) => {
                    let take_new = s.message_count > existing.message_count
                        || (s.source.starts_with("app") && !existing.source.starts_with("app"));
                    if take_new {
                        let merged = Session {
                            title: s.title.clone().or_else(|| existing.title.clone()),
                            summary: s.summary.clone().or_else(|| existing.summary.clone()),
                            ..s
                        };
                        by_id.insert(merged.id.clone(), merged);
                    }
                }
                None => {
                    by_id.insert(s.id.clone(), s);
                }
            }
        }
        let mut all_sessions: Vec<Session> = by_id.into_values().collect();

        all_sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
        Ok(all_sessions)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read Claude desktop app's "starredIds" (its name for pinned sessions) and
/// translate them into our session ids (cliSessionIds).
///
/// The state lives in IndexedDB LevelDB at:
///   ~/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb/*.log
///
/// We can't open the LevelDB while Claude app is running (it holds an exclusive
/// lock). Instead we scan the .log file (an append-only text-ish format) and
/// extract the most recent `{"state":{"starredIds":[...]}}` blob — last write
/// wins. This is read-only and lock-free.
///
/// The starredIds use app session ids (`local_<uuid>`); we map each to its
/// cliSessionId by reading the matching `local_<uuid>.json` metadata file.
#[tauri::command]
async fn get_app_starred_session_ids() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(home) = dirs::home_dir() else { return Ok(vec![]); };
        let leveldb_dir = home
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("IndexedDB")
            .join("https_claude.ai_0.indexeddb.leveldb");
        if !leveldb_dir.exists() {
            return Ok(vec![]);
        }

        // Find the most recent starredIds entry across all .log/.ldb files
        let mut latest: Option<(u64, Vec<String>)> = None;
        let needle = b"\"starredIds\"";

        for entry in fs::read_dir(&leveldb_dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext != "log" && ext != "ldb" {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };

            // Find every occurrence of `"starredIds"` and back up to the
            // enclosing `{"state":...,"updatedAt":<num>}` object.
            let mut search_from = 0;
            while let Some(idx) = find_subslice(&bytes[search_from..], needle) {
                let abs_idx = search_from + idx;
                // Walk backward to nearest `{"state":` (start of the JSON object)
                let start_marker = b"{\"state\":";
                let start = match find_subslice_rev(&bytes[..abs_idx], start_marker) {
                    Some(s) => s,
                    None => { search_from = abs_idx + needle.len(); continue; },
                };
                // Walk forward to find the matching closing `}` by brace counting
                let end = match scan_balanced_json(&bytes, start) {
                    Some(e) => e,
                    None => { search_from = abs_idx + needle.len(); continue; },
                };
                if let Ok(text) = std::str::from_utf8(&bytes[start..end]) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
                        let updated_at = v.get("updatedAt").and_then(|x| x.as_u64()).unwrap_or(0);
                        let ids: Vec<String> = v.get("state")
                            .and_then(|s| s.get("starredIds"))
                            .and_then(|a| a.as_array())
                            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        if !ids.is_empty() {
                            match &latest {
                                Some((ts, _)) if *ts >= updated_at => {}
                                _ => latest = Some((updated_at, ids)),
                            }
                        }
                    }
                }
                search_from = end;
            }
        }

        let app_ids = match latest {
            Some((_, ids)) => ids,
            None => return Ok(vec![]),
        };

        // Map app session ids (local_<uuid>) -> cliSessionId by scanning
        // claude-code-sessions/<deviceId>/<accountId>/local_*.json
        let app_sessions_root = home
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude-code-sessions");

        let mut id_to_cli: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        if app_sessions_root.exists() {
            for d in fs::read_dir(&app_sessions_root).into_iter().flatten().flatten() {
                for a in fs::read_dir(d.path()).into_iter().flatten().flatten() {
                    for f in fs::read_dir(a.path()).into_iter().flatten().flatten() {
                        let p = f.path();
                        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                        if !name.starts_with("local_") || !name.ends_with(".json") { continue; }
                        let Ok(content) = fs::read_to_string(&p) else { continue };
                        let Ok(meta) = serde_json::from_str::<serde_json::Value>(&content) else { continue };
                        let session_id = meta.get("sessionId").and_then(|v| v.as_str()).map(String::from);
                        let cli_id = meta.get("cliSessionId").and_then(|v| v.as_str()).map(String::from);
                        if let (Some(sid), Some(cli)) = (session_id, cli_id) {
                            id_to_cli.insert(sid, cli);
                        }
                    }
                }
            }
        }

        let mut resolved: Vec<String> = app_ids.into_iter()
            .filter_map(|aid| id_to_cli.get(&aid).cloned())
            .collect();

        // Also include web-starred conversation uuids cached by the latest
        // sync_claude_web_conversations run. These are claude.ai web pins
        // (separate from Code-tab starredIds) — we union them here so the
        // frontend gets a single source of "what's app-starred".
        let web_cache = get_lovstudio_dir().join("claude-web-starred.json");
        if let Ok(content) = fs::read_to_string(&web_cache) {
            if let Ok(arr) = serde_json::from_str::<Vec<String>>(&content) {
                for uuid in arr { resolved.push(uuid); }
            }
        }

        Ok(resolved)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn find_subslice_rev(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

/// Scan a balanced JSON object starting at `start`. Returns one-past-end index.
/// Naively counts braces while skipping over strings (which may contain `{}`).
fn scan_balanced_json(bytes: &[u8], start: usize) -> Option<usize> {
    if start >= bytes.len() || bytes[start] != b'{' { return None; }
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escape = false;
    for i in start..bytes.len() {
        let b = bytes[i];
        if in_str {
            if escape { escape = false; continue; }
            if b == b'\\' { escape = true; continue; }
            if b == b'"' { in_str = false; }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 { return Some(i + 1); }
            }
            _ => {}
        }
    }
    None
}

#[tauri::command]
async fn list_all_chats(
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<ChatsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let projects_dir = get_claude_dir().join("projects");
        let max_messages = limit.unwrap_or(50);
        let skip = offset.unwrap_or(0);

        if !projects_dir.exists() {
            return Ok(ChatsResponse {
                items: vec![],
                total: 0,
            });
        }

        // Collect all session files with metadata
        let mut session_files: Vec<(PathBuf, String, String, u64)> = Vec::new();

        for project_entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
            let project_entry = project_entry.map_err(|e| e.to_string())?;
            let project_path = project_entry.path();

            if !project_path.is_dir() {
                continue;
            }

            let project_id = project_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();
            let display_path = decode_project_path(&project_id);

            for entry in fs::read_dir(&project_path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                let name = path.file_name().unwrap().to_string_lossy().to_string();

                if name.ends_with(".jsonl") && !name.starts_with("agent-") {
                    let last_modified = entry
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);

                    session_files.push((
                        path,
                        project_id.clone(),
                        display_path.clone(),
                        last_modified,
                    ));
                }
            }
        }

        // Sort by last modified (newest first)
        session_files.sort_by(|a, b| b.3.cmp(&a.3));

        let mut all_chats: Vec<ChatMessage> = Vec::new();

        // Process all sessions to get total count
        for (path, project_id, project_path, _) in session_files {
            let session_id = path.file_stem().unwrap().to_string_lossy().to_string();
            let content = fs::read_to_string(&path).unwrap_or_default();

            let mut session_summary: Option<String> = None;
            let mut session_cwd: Option<String> = None;
            let mut session_messages: Vec<ChatMessage> = Vec::new();

            for line in content.lines() {
                if let Ok(parsed) = serde_json::from_str::<RawLine>(line) {
                    let line_type = parsed.line_type.as_deref();

                    if line_type == Some("summary") {
                        session_summary = parsed.summary;
                    }

                    // Capture cwd from first user message
                    if session_cwd.is_none() {
                        if let Some(c) = &parsed.cwd {
                            if !c.is_empty() {
                                session_cwd = Some(c.clone());
                            }
                        }
                    }

                    let is_msg_line = matches!(line_type, Some("user") | Some("assistant") | Some("message"));
                    if is_msg_line {
                        if let Some(msg) = &parsed.message {
                            let role = msg.role.clone().unwrap_or_default();
                            if role == "user" || role == "assistant" {
                                let (text_content, _is_tool) = extract_content_with_meta(&msg.content);
                                let is_meta = parsed.is_meta.unwrap_or(false);

                                // Skip meta messages and empty content
                                if !is_meta && !text_content.is_empty() {
                                    session_messages.push(ChatMessage {
                                        uuid: parsed.uuid.unwrap_or_default(),
                                        role,
                                        content: text_content,
                                        timestamp: parsed.timestamp.unwrap_or_default(),
                                        project_id: project_id.clone(),
                                        project_path: project_path.clone(),
                                        session_id: session_id.clone(),
                                        session_summary: None, // Will be filled later
                                    });
                                }
                            }
                        }
                    }
                }
            }

            // Update session_summary and project_path for all messages
            let resolved_path = session_cwd.unwrap_or(project_path);
            for msg in &mut session_messages {
                msg.session_summary = session_summary.clone();
                msg.project_path = resolved_path.clone();
            }

            all_chats.extend(session_messages);
        }

        // Sort all by timestamp (newest first)
        all_chats.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

        let total = all_chats.len();
        let items: Vec<ChatMessage> = all_chats
            .into_iter()
            .skip(skip)
            .take(max_messages)
            .collect();

        Ok(ChatsResponse { items, total })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_session_messages(
    project_id: String,
    session_id: String,
) -> Result<Vec<Message>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session_path = get_claude_dir()
            .join("projects")
            .join(&project_id)
            .join(format!("{}.jsonl", session_id));

        if !session_path.exists() {
            return Err("Session not found".to_string());
        }

        let content = fs::read_to_string(&session_path).map_err(|e| e.to_string())?;
        let mut messages = Vec::new();

        for (idx, line) in content.lines().enumerate() {
            if let Ok(parsed) = serde_json::from_str::<RawLine>(line) {
                let line_type = parsed.line_type.as_deref();
                // Accept legacy CLI format (type=user|assistant) and Claude desktop
                // app format (type=message wrapping a {role:user|assistant} payload).
                let is_msg_line = matches!(line_type, Some("user") | Some("assistant") | Some("message"));
                if !is_msg_line {
                    continue;
                }
                if let Some(msg) = &parsed.message {
                    let role = msg.role.clone().unwrap_or_default();
                    if role != "user" && role != "assistant" {
                        continue;
                    }
                    let (content, is_tool) = extract_content_with_meta(&msg.content);
                    let content_blocks = extract_content_blocks(&msg.content);
                    let is_meta = parsed.is_meta.unwrap_or(false);

                    if !content.is_empty() {
                        messages.push(Message {
                            uuid: parsed.uuid.unwrap_or_default(),
                            role,
                            content,
                            timestamp: parsed.timestamp.unwrap_or_default(),
                            is_meta,
                            is_tool,
                            line_number: idx + 1,
                            content_blocks,
                        });
                    }
                }
            }
        }

        Ok(messages)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================================
// Search Feature
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub uuid: String,
    pub content: String,
    pub role: String,
    pub project_id: String,
    pub project_path: String,
    pub session_id: String,
    pub session_summary: Option<String>,
    pub timestamp: String,
    pub score: f32,
}

#[tauri::command]
async fn build_search_index() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let index_dir = get_index_dir();

        // Remove old index if exists
        if index_dir.exists() {
            fs::remove_dir_all(&index_dir).map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(&index_dir).map_err(|e| e.to_string())?;

        let schema = create_schema();
        let index = Index::create_in_dir(&index_dir, schema.clone()).map_err(|e| e.to_string())?;

        // Register jieba tokenizer for Chinese support
        register_jieba_tokenizer(&index);

        let mut index_writer: IndexWriter = index
            .writer(50_000_000) // 50MB heap
            .map_err(|e| e.to_string())?;

        let uuid_field = schema.get_field("uuid").unwrap();
        let content_field = schema.get_field("content").unwrap();
        let role_field = schema.get_field("role").unwrap();
        let project_id_field = schema.get_field("project_id").unwrap();
        let project_path_field = schema.get_field("project_path").unwrap();
        let session_id_field = schema.get_field("session_id").unwrap();
        let session_summary_field = schema.get_field("session_summary").unwrap();
        let timestamp_field = schema.get_field("timestamp").unwrap();

        let projects_dir = get_claude_dir().join("projects");
        let mut indexed_count = 0;

        // === Command stats collection ===
        let mut command_stats: HashMap<String, HashMap<String, usize>> = HashMap::new();
        let command_pattern = regex::Regex::new(r"<command-name>(/[^<]+)</command-name>")
            .map_err(|e| e.to_string())?;

        // Build alias -> canonical name mapping
        let mut alias_map: HashMap<String, String> = HashMap::new();
        let commands_dir = get_claude_dir().join("commands");

        fn scan_commands_for_aliases(dir: &std::path::Path, alias_map: &mut HashMap<String, String>, base_dir: &std::path::Path) {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let path = entry.path();
                    if path.is_dir() {
                        scan_commands_for_aliases(&path, alias_map, base_dir);
                    } else if path.extension().map_or(false, |e| e == "md") {
                        let rel_path = path.strip_prefix(base_dir).unwrap_or(&path);
                        let canonical = rel_path
                            .with_extension("")
                            .to_string_lossy()
                            .replace('/', ":")
                            .replace('\\', ":");

                        if let Ok(content) = fs::read_to_string(&path) {
                            if content.starts_with("---") {
                                if let Some(end) = content[3..].find("---") {
                                    let fm = &content[3..3 + end];
                                    for line in fm.lines() {
                                        if line.starts_with("aliases:") {
                                            let aliases_str = line.trim_start_matches("aliases:").trim();
                                            for alias in aliases_str.split(',') {
                                                let alias = alias.trim()
                                                    .trim_matches('"')
                                                    .trim_matches('\'')
                                                    .trim_start_matches('/')
                                                    .to_string();
                                                if !alias.is_empty() {
                                                    alias_map.insert(alias, canonical.clone());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if commands_dir.exists() {
            scan_commands_for_aliases(&commands_dir, &mut alias_map, &commands_dir);
        }
        // === End command stats setup ===

        if !projects_dir.exists() {
            return Ok(0);
        }

        for project_entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
            let project_entry = project_entry.map_err(|e| e.to_string())?;
            let project_path_buf = project_entry.path();

            if !project_path_buf.is_dir() {
                continue;
            }

            let project_id = project_path_buf.file_name().unwrap().to_string_lossy().to_string();
            let display_path = decode_project_path(&project_id);

            for entry in fs::read_dir(&project_path_buf).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                let name = path.file_name().unwrap().to_string_lossy().to_string();

                if name.ends_with(".jsonl") && !name.starts_with("agent-") {
                    let session_id = name.trim_end_matches(".jsonl").to_string();
                    let file_content = fs::read_to_string(&path).unwrap_or_default();

                    let mut session_summary: Option<String> = None;

                    // First pass: get summary
                    for line in file_content.lines() {
                        if let Ok(parsed) = serde_json::from_str::<RawLine>(line) {
                            if parsed.line_type.as_deref() == Some("summary") {
                                session_summary = parsed.summary;
                                break;
                            }
                        }
                    }

                    // Second pass: index messages + collect command stats
                    for line in file_content.lines() {
                        if let Ok(parsed) = serde_json::from_str::<RawLine>(line) {
                            let line_type = parsed.line_type.as_deref();

                            let is_msg_line = matches!(line_type, Some("user") | Some("assistant") | Some("message"));
                            if is_msg_line {
                                if let Some(msg) = &parsed.message {
                                    let role = msg.role.clone().unwrap_or_default();
                                    if role == "user" || role == "assistant" {
                                        let (text_content, _) = extract_content_with_meta(&msg.content);
                                        let is_meta = parsed.is_meta.unwrap_or(false);

                                        if !is_meta && !text_content.is_empty() {
                                            index_writer.add_document(doc!(
                                                uuid_field => parsed.uuid.clone().unwrap_or_default(),
                                                content_field => text_content,
                                                role_field => role,
                                                project_id_field => project_id.clone(),
                                                project_path_field => display_path.clone(),
                                                session_id_field => session_id.clone(),
                                                session_summary_field => session_summary.clone().unwrap_or_default(),
                                                timestamp_field => parsed.timestamp.clone().unwrap_or_default(),
                                            )).map_err(|e| e.to_string())?;

                                            indexed_count += 1;
                                        }
                                    }
                                }
                            }

                            // Collect command stats from any line containing <command-name>
                            // Skip queue-operation entries (internal logs, not actual command invocations)
                            if line.contains("<command-name>") && !line.contains("\"type\":\"queue-operation\"") {
                                if let Some(ts_str) = &parsed.timestamp {
                                    if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(ts_str) {
                                        let week_key = ts.format("%Y-W%V").to_string();
                                        for cap in command_pattern.captures_iter(line) {
                                            if let Some(cmd_match) = cap.get(1) {
                                                let raw_name = cmd_match.as_str().trim_start_matches('/').to_string();
                                                let name = alias_map.get(&raw_name).cloned().unwrap_or(raw_name);
                                                command_stats
                                                    .entry(name)
                                                    .or_default()
                                                    .entry(week_key.clone())
                                                    .and_modify(|c| *c += 1)
                                                    .or_insert(1);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        index_writer.commit().map_err(|e| e.to_string())?;

        // Store search index in global state
        let mut guard = SEARCH_INDEX.lock().map_err(|e| e.to_string())?;
        *guard = Some(SearchIndex { index, schema });

        // Write command stats to file
        let stats_path = get_command_stats_path();
        if let Some(parent) = stats_path.parent() {
            fs::create_dir_all(parent).ok();
        }
        let stats_json = serde_json::json!({
            "updated_at": chrono::Utc::now().timestamp(),
            "commands": command_stats,
        });
        fs::write(&stats_path, serde_json::to_string_pretty(&stats_json).unwrap_or_default()).ok();

        Ok(indexed_count)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn search_chats(
    query: String,
    limit: Option<usize>,
    project_id: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    let max_results = limit.unwrap_or(50);

    // Try to get index from global state or load from disk
    let mut guard = SEARCH_INDEX.lock().map_err(|e| e.to_string())?;

    if guard.is_none() {
        let index_dir = get_index_dir();
        if !index_dir.exists() {
            return Err("Search index not built. Please build index first.".to_string());
        }

        let schema = create_schema();
        let index = Index::open_in_dir(&index_dir).map_err(|e| e.to_string())?;
        // Register jieba tokenizer for Chinese support
        register_jieba_tokenizer(&index);
        *guard = Some(SearchIndex { index, schema });
    }

    let search_index = guard.as_ref().unwrap();
    let reader = search_index
        .index
        .reader_builder()
        .reload_policy(ReloadPolicy::OnCommitWithDelay)
        .try_into()
        .map_err(|e: tantivy::TantivyError| e.to_string())?;

    let searcher = reader.searcher();

    let content_field = search_index.schema.get_field("content").unwrap();
    let session_summary_field = search_index.schema.get_field("session_summary").unwrap();

    let query_parser = QueryParser::for_index(
        &search_index.index,
        vec![content_field, session_summary_field],
    );
    let parsed_query = query_parser
        .parse_query(&query)
        .map_err(|e| e.to_string())?;

    let top_docs = searcher
        .search(&parsed_query, &TopDocs::with_limit(max_results))
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();

    for (score, doc_address) in top_docs {
        let retrieved_doc: tantivy::TantivyDocument =
            searcher.doc(doc_address).map_err(|e| e.to_string())?;

        let get_text = |field_name: &str| -> String {
            let field = search_index.schema.get_field(field_name).unwrap();
            retrieved_doc
                .get_first(field)
                .and_then(|v| TantivyValue::as_str(&v))
                .unwrap_or("")
                .to_string()
        };

        let doc_project_id = get_text("project_id");

        // Filter by project_id if specified
        if let Some(ref filter_id) = project_id {
            if &doc_project_id != filter_id {
                continue;
            }
        }

        let summary = get_text("session_summary");

        results.push(SearchResult {
            uuid: get_text("uuid"),
            content: get_text("content"),
            role: get_text("role"),
            project_id: doc_project_id,
            project_path: get_text("project_path"),
            session_id: get_text("session_id"),
            session_summary: if summary.is_empty() {
                None
            } else {
                Some(summary)
            },
            timestamp: get_text("timestamp"),
            score,
        });
    }

    Ok(results)
}

fn summarize_tool_input(name: &str, input: &serde_json::Value) -> String {
    let obj = match input.as_object() {
        Some(o) => o,
        None => return String::new(),
    };
    match name {
        "Read" | "Write" => obj.get("file_path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "Edit" => {
            let path = obj.get("file_path").and_then(|v| v.as_str()).unwrap_or("");
            let old = obj.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
            if old.is_empty() { path.to_string() } else {
                format!("{} ({}...)", path, &old.chars().take(40).collect::<String>())
            }
        }
        "Bash" => obj.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "Grep" => obj.get("pattern").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "Glob" => obj.get("pattern").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "Task" => obj.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "WebFetch" => obj.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "WebSearch" => obj.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        _ => {
            // Try common field names
            for key in &["file_path", "path", "command", "query", "pattern", "url", "description"] {
                if let Some(v) = obj.get(*key).and_then(|v| v.as_str()) {
                    return v.to_string();
                }
            }
            String::new()
        }
    }
}

fn extract_tool_result_content(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => {
            arr.iter()
                .filter_map(|item| {
                    let obj = item.as_object()?;
                    if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                        obj.get("text").and_then(|v| v.as_str()).map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => String::new(),
    }
}

fn extract_content_blocks(value: &Option<serde_json::Value>) -> Option<Vec<ContentBlock>> {
    let arr = match value {
        Some(serde_json::Value::Array(arr)) => arr,
        Some(serde_json::Value::String(s)) => {
            return Some(vec![ContentBlock::Text { text: s.clone() }]);
        }
        _ => return None,
    };

    let blocks: Vec<ContentBlock> = arr
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let block_type = obj.get("type").and_then(|v| v.as_str())?;
            match block_type {
                "text" => {
                    let text = obj.get("text").and_then(|v| v.as_str())?.to_string();
                    if text.is_empty() { None } else { Some(ContentBlock::Text { text }) }
                }
                "tool_use" => {
                    let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let input = obj.get("input").cloned().unwrap_or(serde_json::Value::Null);
                    let summary = summarize_tool_input(&name, &input);
                    Some(ContentBlock::ToolUse { id, name, summary })
                }
                "tool_result" => {
                    let tool_use_id = obj.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let content = obj.get("content")
                        .map(|v| extract_tool_result_content(v))
                        .unwrap_or_default();
                    Some(ContentBlock::ToolResult { tool_use_id, content })
                }
                "thinking" => {
                    let thinking = obj.get("thinking").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if thinking.is_empty() { None } else { Some(ContentBlock::Thinking { thinking }) }
                }
                _ => None,
            }
        })
        .collect();

    if blocks.is_empty() { None } else { Some(blocks) }
}

fn extract_content_with_meta(value: &Option<serde_json::Value>) -> (String, bool) {
    match value {
        Some(serde_json::Value::String(s)) => (s.clone(), false),
        Some(serde_json::Value::Array(arr)) => {
            // Check if array contains tool_use or tool_result
            let has_tool = arr.iter().any(|item| {
                if let Some(obj) = item.as_object() {
                    let t = obj.get("type").and_then(|v| v.as_str());
                    return t == Some("tool_use") || t == Some("tool_result");
                }
                false
            });

            let text = arr
                .iter()
                .filter_map(|item| {
                    if let Some(obj) = item.as_object() {
                        if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                            return obj.get("text").and_then(|v| v.as_str()).map(String::from);
                        }
                    }
                    None
                })
                .collect::<Vec<_>>()
                .join("\n");

            (text, has_tool)
        }
        _ => (String::new(), false),
    }
}

// ============================================================================
// Commands Feature
// ============================================================================

#[tauri::command]
fn list_local_commands() -> Result<Vec<LocalCommand>, String> {
    let claude_dir = get_claude_dir();
    let commands_dir = claude_dir.join("commands");
    let dot_commands_dir = claude_dir.join(".commands");
    let archived_dir = dot_commands_dir.join("archived");

    // One-time migration: check version marker
    let migration_marker = dot_commands_dir.join("migrated");
    let current_version = fs::read_to_string(&migration_marker).unwrap_or_default();

    // Run migrations if needed
    if !current_version.contains("v4") {
        run_command_migrations(&claude_dir, &commands_dir, &archived_dir);
        let _ = fs::create_dir_all(&dot_commands_dir);
        let _ = fs::write(&migration_marker, "v4");
    }

    let mut commands = Vec::new();

    // Collect active commands from commands/
    if commands_dir.exists() {
        collect_commands_from_dir(&commands_dir, &commands_dir, &mut commands, "active")?;
    }

    // Collect deprecated commands from .commands/archived/
    if archived_dir.exists() {
        collect_commands_from_dir(&archived_dir, &archived_dir, &mut commands, "deprecated")?;
    }

    commands.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(commands)
}

/// Run all pending migrations
fn run_command_migrations(claude_dir: &PathBuf, commands_dir: &PathBuf, archived_dir: &PathBuf) {
    // Migrate legacy .md.deprecated files
    migrate_deprecated_files_recursive(commands_dir, commands_dir, archived_dir);

    // Migrate files from old .archive/ subdirectories
    migrate_archive_subdirs_recursive(commands_dir, commands_dir, archived_dir);

    // Migrate from old .archived-commands/ directory (v3 format)
    let old_archived_dir = claude_dir.join(".archived-commands");
    if old_archived_dir.exists() {
        migrate_old_archived_commands(&old_archived_dir, archived_dir);
    }

    // Migrate orphan .changelog files
    migrate_orphan_changelogs(commands_dir, archived_dir);
}

/// Migrate from old .archived-commands/ to new .commands/archived/
fn migrate_old_archived_commands(old_dir: &PathBuf, new_dir: &PathBuf) {
    if let Ok(entries) = fs::read_dir(old_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(relative) = path.strip_prefix(old_dir) {
                let dest = new_dir.join(relative);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::rename(&path, &dest);
            }
        }
    }
    // Try to remove old directory
    let _ = fs::remove_dir_all(old_dir);
}

/// Recursively migrate .md.deprecated files to archived directory
fn migrate_deprecated_files_recursive(
    base_dir: &PathBuf,
    current_dir: &PathBuf,
    archived_dir: &PathBuf,
) {
    if let Ok(entries) = fs::read_dir(current_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir()
                && !path
                    .file_name()
                    .map_or(false, |n| n.to_string_lossy().starts_with('.'))
            {
                migrate_deprecated_files_recursive(base_dir, &path, archived_dir);
            } else if path.extension().map_or(false, |e| e == "deprecated") {
                // Migrate .md.deprecated file
                if let Ok(relative) = path.strip_prefix(base_dir) {
                    let new_name = relative
                        .to_string_lossy()
                        .trim_end_matches(".deprecated")
                        .to_string();
                    let dest = archived_dir.join(&new_name);
                    if let Some(parent) = dest.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = fs::rename(&path, &dest);

                    // Also migrate changelog if exists
                    let changelog_src = PathBuf::from(
                        path.to_string_lossy()
                            .replace(".md.deprecated", ".changelog"),
                    );
                    if changelog_src.exists() {
                        let changelog_dest =
                            archived_dir.join(new_name.replace(".md", ".changelog"));
                        let _ = fs::rename(&changelog_src, &changelog_dest);
                    }
                }
            }
        }
    }
}

/// Recursively migrate files from .archive/ subdirectories
fn migrate_archive_subdirs_recursive(
    base_dir: &PathBuf,
    current_dir: &PathBuf,
    archived_dir: &PathBuf,
) {
    if let Ok(entries) = fs::read_dir(current_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                if name == ".archive" {
                    // Found .archive/ directory - migrate its contents
                    if let Ok(archive_entries) = fs::read_dir(&path) {
                        for archive_entry in archive_entries.flatten() {
                            let file_path = archive_entry.path();
                            if file_path.is_file() {
                                // Calculate relative path from base commands dir
                                let parent_relative =
                                    current_dir.strip_prefix(base_dir).unwrap_or(Path::new(""));
                                let filename = file_path.file_name().unwrap_or_default();
                                let dest = archived_dir.join(parent_relative).join(filename);
                                if let Some(parent) = dest.parent() {
                                    let _ = fs::create_dir_all(parent);
                                }
                                let _ = fs::rename(&file_path, &dest);
                            }
                        }
                    }
                    // Try to remove empty .archive/ directory
                    let _ = fs::remove_dir(&path);
                } else if !name.starts_with('.') {
                    migrate_archive_subdirs_recursive(base_dir, &path, archived_dir);
                }
            }
        }
    }
}

/// Migrate orphan .changelog files whose .md is in archived directory
fn migrate_orphan_changelogs(commands_dir: &PathBuf, archived_dir: &PathBuf) {
    if !archived_dir.exists() {
        return;
    }
    migrate_orphan_changelogs_recursive(commands_dir, commands_dir, archived_dir);
}

fn migrate_orphan_changelogs_recursive(
    base_dir: &PathBuf,
    current_dir: &PathBuf,
    archived_dir: &PathBuf,
) {
    if let Ok(entries) = fs::read_dir(current_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir()
                && !path
                    .file_name()
                    .map_or(false, |n| n.to_string_lossy().starts_with('.'))
            {
                migrate_orphan_changelogs_recursive(base_dir, &path, archived_dir);
            } else if path.extension().map_or(false, |e| e == "changelog") {
                // Check if corresponding .md exists in archived_dir
                if let Ok(relative) = path.strip_prefix(base_dir) {
                    let md_name = relative.to_string_lossy().replace(".changelog", ".md");
                    let archived_md = archived_dir.join(&md_name);
                    if archived_md.exists() {
                        let dest = archived_dir.join(relative);
                        if let Some(parent) = dest.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        let _ = fs::rename(&path, &dest);
                    }
                }
            }
        }
    }
}

/// Collect commands from a directory with a given status
fn collect_commands_from_dir(
    base_dir: &PathBuf,
    current_dir: &PathBuf,
    commands: &mut Vec<LocalCommand>,
    status: &str,
) -> Result<(), String> {
    for entry in fs::read_dir(current_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            // Skip hidden directories
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with('.') {
                collect_commands_from_dir(base_dir, &path, commands, status)?;
            }
        } else {
            let filename = path.file_name().unwrap_or_default().to_string_lossy();

            // Determine file type
            let (is_command, name_suffix) = if filename.ends_with(".md.archived") {
                (true, ".md.archived")
            } else if filename.ends_with(".md") {
                (true, ".md")
            } else {
                (false, "")
            };

            if is_command {
                let relative = path.strip_prefix(base_dir).unwrap_or(&path);
                let name = relative
                    .to_string_lossy()
                    .trim_end_matches(name_suffix)
                    .replace("\\", "/")
                    .to_string();

                let content = fs::read_to_string(&path).unwrap_or_default();
                let (frontmatter, raw_frontmatter, body) = parse_frontmatter(&content);

                // Use "archived" status for .md.archived files, otherwise use provided status
                let actual_status = if filename.ends_with(".md.archived") {
                    "archived"
                } else {
                    status
                };

                // Read changelog if exists (same directory, .changelog extension)
                let changelog = path
                    .parent()
                    .map(|dir| {
                        let base = path.file_stem().unwrap_or_default().to_string_lossy();
                        dir.join(format!("{}.changelog", base))
                    })
                    .filter(|p| p.exists())
                    .and_then(|p| fs::read_to_string(p).ok());

                // Parse aliases: comma-separated list of previous command names
                let aliases = frontmatter
                    .get("aliases")
                    .map(|s| {
                        s.split(',')
                            .map(|a| {
                                a.trim()
                                    .trim_matches(|c| c == '[' || c == ']' || c == '"' || c == '\'')
                                    .to_string()
                            })
                            .filter(|a| !a.is_empty())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();

                commands.push(LocalCommand {
                    name: format!("/{}", name),
                    path: path.to_string_lossy().to_string(),
                    description: frontmatter.get("description").cloned(),
                    allowed_tools: frontmatter.get("allowed-tools").cloned(),
                    argument_hint: frontmatter.get("argument-hint").cloned(),
                    content: body,
                    version: frontmatter.get("version").cloned(),
                    status: actual_status.to_string(),
                    deprecated_by: frontmatter.get("replaced-by").cloned(),
                    changelog,
                    aliases,
                    frontmatter: raw_frontmatter,
                });
            }
        }
    }
    Ok(())
}

fn parse_frontmatter(content: &str) -> (HashMap<String, String>, Option<String>, String) {
    let mut frontmatter = HashMap::new();
    let mut raw_frontmatter: Option<String> = None;
    let mut body = content.to_string();

    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("---") {
            let fm_content = &content[3..end_idx + 3];
            raw_frontmatter = Some(fm_content.trim().to_string());
            body = content[end_idx + 6..].trim_start().to_string();

            for line in fm_content.lines() {
                if let Some(colon_idx) = line.find(':') {
                    let key = line[..colon_idx].trim().to_string();
                    let value = line[colon_idx + 1..].trim();
                    // Strip surrounding quotes from YAML values
                    let value = value.trim_matches('"').trim_matches('\'').to_string();
                    frontmatter.insert(key, value);
                }
            }
        }
    }

    (frontmatter, raw_frontmatter, body)
}

/// Rename a command file (supports path changes like /foo/bar -> /foo/baz/bar)
#[tauri::command]
fn rename_command(
    path: String,
    new_name: String,
    create_dir: Option<bool>,
) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("Command file not found: {}", path));
    }

    if !path.ends_with(".md") {
        return Err("Can only rename .md commands".to_string());
    }

    // Parse new_name as a command path (e.g., /lovstudio/repo/takeover)
    let name = new_name.trim().trim_start_matches('/');
    if name.is_empty() {
        return Err("New name cannot be empty".to_string());
    }

    // Build destination path from command name
    let commands_dir = get_claude_dir().join("commands");
    let new_filename = if name.ends_with(".md") {
        name.to_string()
    } else {
        format!("{}.md", name)
    };
    let dest = commands_dir.join(&new_filename);

    // Check if destination directory exists
    if let Some(dest_parent) = dest.parent() {
        if !dest_parent.exists() {
            if create_dir.unwrap_or(false) {
                fs::create_dir_all(dest_parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            } else {
                // Return special error for frontend to show confirmation
                return Err(format!("DIR_NOT_EXIST:{}", dest_parent.to_string_lossy()));
            }
        }
    }

    if dest.exists() && dest != src {
        return Err(format!(
            "A command with name '{}' already exists",
            new_filename
        ));
    }

    if dest != src {
        // Calculate old command name (derive from filename without .md)
        let old_basename = src
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("Cannot get old filename")?;
        let old_name =
            if let Ok(relative) = src.parent().unwrap_or(&src).strip_prefix(&commands_dir) {
                if relative.as_os_str().is_empty() {
                    format!("/{}", old_basename)
                } else {
                    format!("/{}/{}", relative.to_string_lossy(), old_basename)
                }
            } else {
                format!("/{}", old_basename)
            };

        // Calculate new command name
        let new_basename = dest
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("Cannot get new filename")?;
        let new_name =
            if let Ok(relative) = dest.parent().unwrap_or(&dest).strip_prefix(&commands_dir) {
                if relative.as_os_str().is_empty() {
                    format!("/{}", new_basename)
                } else {
                    format!("/{}/{}", relative.to_string_lossy(), new_basename)
                }
            } else {
                format!("/{}", new_basename)
            };

        // Update aliases: add old name, remove new name if it was an alias
        let content = fs::read_to_string(&src).map_err(|e| e.to_string())?;
        let updated = update_aliases_on_rename(&content, &old_name, &new_name);
        if updated != content {
            fs::write(&src, &updated).map_err(|e| e.to_string())?;
        }

        fs::rename(&src, &dest).map_err(|e| e.to_string())?;

        // Also rename associated .changelog file if exists
        let changelog_src = src.with_extension("changelog");
        if changelog_src.exists() {
            let changelog_dest = dest.with_extension("changelog");
            let _ = fs::rename(&changelog_src, &changelog_dest);
        }
    }

    Ok(dest.to_string_lossy().to_string())
}

fn update_aliases_on_rename(content: &str, old_name: &str, new_name: &str) -> String {
    // Parse existing aliases from frontmatter
    let (existing_aliases, has_frontmatter) = if content.starts_with("---") {
        let parts: Vec<&str> = content.splitn(3, "---").collect();
        if parts.len() >= 3 {
            let frontmatter = parts[1];
            if let Some(line) = frontmatter
                .lines()
                .find(|l| l.trim_start().starts_with("aliases:"))
            {
                let value_part = line.split(':').nth(1).unwrap_or("").trim();
                let aliases: Vec<String> = value_part
                    .trim_matches('"')
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                (aliases, true)
            } else {
                (Vec::new(), true)
            }
        } else {
            (Vec::new(), false)
        }
    } else {
        (Vec::new(), false)
    };

    // Build new aliases: add old_name, remove new_name
    let mut new_aliases: Vec<String> = existing_aliases
        .into_iter()
        .filter(|a| a != new_name)
        .collect();

    if !new_aliases.contains(&old_name.to_string()) {
        new_aliases.push(old_name.to_string());
    }

    // Update frontmatter
    if !has_frontmatter {
        if new_aliases.is_empty() {
            return content.to_string();
        }
        return format!(
            "---\naliases: \"{}\"\n---\n\n{}",
            new_aliases.join(", "),
            content
        );
    }

    let parts: Vec<&str> = content.splitn(3, "---").collect();
    let frontmatter = parts[1];
    let body = parts[2];

    if let Some(aliases_line_idx) = frontmatter
        .lines()
        .position(|l| l.trim_start().starts_with("aliases:"))
    {
        let lines: Vec<&str> = frontmatter.lines().collect();

        let new_frontmatter: Vec<String> = lines
            .iter()
            .enumerate()
            .filter_map(|(i, &l)| {
                if i == aliases_line_idx {
                    if new_aliases.is_empty() {
                        None // Remove the line if no aliases
                    } else {
                        Some(format!("aliases: \"{}\"", new_aliases.join(", ")))
                    }
                } else {
                    Some(l.to_string())
                }
            })
            .collect();

        format!("---{}---{}", new_frontmatter.join("\n"), body)
    } else if !new_aliases.is_empty() {
        // No aliases field, add it
        let new_frontmatter = format!(
            "{}\naliases: \"{}\"",
            frontmatter.trim_end(),
            new_aliases.join(", ")
        );
        format!("---{}---{}", new_frontmatter, body)
    } else {
        content.to_string()
    }
}

/// Deprecate a command by moving it to ~/.claude/.commands/archived/
/// This moves it outside the commands directory so Claude Code won't load it
#[tauri::command]
fn deprecate_command(
    path: String,
    replaced_by: Option<String>,
    note: Option<String>,
) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("Command file not found: {}", path));
    }

    let commands_dir = get_claude_dir().join("commands");
    let archived_dir = get_claude_dir().join(".commands").join("archived");

    // Only allow deprecating active .md files from commands directory
    if !path.ends_with(".md") {
        return Err("Can only deprecate .md commands".to_string());
    }

    // Check if already archived
    if src.starts_with(&archived_dir) {
        return Err("Command is already archived".to_string());
    }

    // Update frontmatter with replaced_by and/or note
    let content = fs::read_to_string(&src).map_err(|e| e.to_string())?;
    let mut updated = content.clone();
    if let Some(replacement) = &replaced_by {
        updated = add_frontmatter_field(&updated, "replaced-by", replacement);
    }
    if let Some(n) = &note {
        updated = add_frontmatter_field(&updated, "deprecation-note", n);
    }
    if updated != content {
        fs::write(&src, updated).map_err(|e| e.to_string())?;
    }

    // Calculate relative path from commands directory
    let relative = src
        .strip_prefix(&commands_dir)
        .map_err(|_| "Command is not in commands directory")?;

    // Create destination path in archived directory (preserving subdirectory structure)
    let dest = archived_dir.join(relative);
    if let Some(dest_parent) = dest.parent() {
        fs::create_dir_all(dest_parent).map_err(|e| e.to_string())?;
    }

    fs::rename(&src, &dest).map_err(|e| e.to_string())?;

    // Also move associated .changelog file if exists
    let base_name = src.with_extension("");
    let changelog_src = base_name.with_extension("changelog");
    if changelog_src.exists() {
        let changelog_relative = changelog_src
            .strip_prefix(&commands_dir)
            .map_err(|_| "Changelog is not in commands directory")?;
        let changelog_dest = archived_dir.join(changelog_relative);
        let _ = fs::rename(&changelog_src, &changelog_dest);
    }

    Ok(dest.to_string_lossy().to_string())
}

/// Archive a command by moving it to versions/ directory with version suffix
#[tauri::command]
fn archive_command(path: String, version: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("Command file not found: {}", path));
    }

    // Get the commands directory and create versions/ if needed
    let commands_dir = src.parent().unwrap_or(&src);
    let versions_dir = commands_dir.join("versions");
    fs::create_dir_all(&versions_dir).map_err(|e| e.to_string())?;

    // Get base name and create versioned filename
    let filename = src.file_name().unwrap_or_default().to_string_lossy();
    let base_name = filename.trim_end_matches(".md");
    let versioned_name = format!("{}.v{}.md.archived", base_name, version);
    let dest = versions_dir.join(versioned_name);

    fs::rename(&src, &dest).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().to_string())
}

/// Restore a deprecated or archived command to active status
#[tauri::command]
fn restore_command(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("Command file not found: {}", path));
    }

    let commands_dir = get_claude_dir().join("commands");
    let archived_dir = get_claude_dir().join(".commands").join("archived");
    let path_str = src.to_string_lossy();

    // Determine source type and calculate destination
    let dest = if src.starts_with(&archived_dir) {
        // From .commands/archived/ - restore to commands/
        let relative = src
            .strip_prefix(&archived_dir)
            .map_err(|_| "Cannot get relative path")?;
        commands_dir.join(relative)
    } else if path_str.contains("/.archive/") || path_str.contains("\\.archive\\") {
        // Legacy: from .archive/ subdirectory - move to parent
        let archive_dir = src.parent().ok_or("Cannot get parent directory")?;
        let parent = archive_dir
            .parent()
            .ok_or("Cannot get grandparent directory")?;
        let filename = src.file_name().ok_or("Cannot get filename")?;
        parent.join(filename)
    } else if path_str.ends_with(".md.deprecated") {
        // Legacy: remove .deprecated suffix
        PathBuf::from(path_str.trim_end_matches(".deprecated"))
    } else if path_str.ends_with(".md.archived") {
        // From versions/ - restore to parent with base name
        let parent = src.parent().and_then(|p| p.parent()).unwrap_or(&src);
        let file_name = src.file_name().unwrap_or_default().to_string_lossy();
        let base = file_name.split(".v").next().unwrap_or(&file_name);
        parent.join(format!("{}.md", base))
    } else {
        return Err("File is not deprecated or archived".to_string());
    };

    // Check if destination already exists
    if dest.exists() {
        return Err(format!("Cannot restore: {} already exists", dest.display()));
    }

    // Create destination directory if needed
    if let Some(dest_parent) = dest.parent() {
        fs::create_dir_all(dest_parent).map_err(|e| e.to_string())?;
    }

    fs::rename(&src, &dest).map_err(|e| e.to_string())?;

    // Also restore associated .changelog file if exists
    if src.starts_with(&archived_dir) {
        let base_name = src.with_extension("");
        let changelog_src = base_name.with_extension("changelog");
        if changelog_src.exists() {
            let changelog_relative = changelog_src
                .strip_prefix(&archived_dir)
                .map_err(|_| "Cannot get changelog relative path")?;
            let changelog_dest = commands_dir.join(changelog_relative);
            let _ = fs::rename(&changelog_src, &changelog_dest);
        }
    }

    Ok(dest.to_string_lossy().to_string())
}

/// Helper to add a field to frontmatter
fn add_frontmatter_field(content: &str, key: &str, value: &str) -> String {
    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("---") {
            let fm_content = &content[3..end_idx + 3];
            let body = &content[end_idx + 6..];
            return format!("---\n{}{}: {}\n---{}", fm_content, key, value, body);
        }
    }
    // No frontmatter, add one
    format!("---\n{}: {}\n---\n\n{}", key, value, content)
}

/// Helper to update or add a field in frontmatter
fn update_frontmatter_field(content: &str, key: &str, value: &str) -> String {
    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("---") {
            let fm_content = &content[3..end_idx + 3];
            let body = &content[end_idx + 6..];

            // Check if key exists and update it
            let mut found = false;
            let mapped: Vec<String> = fm_content
                .lines()
                .map(|line| {
                    if let Some(colon_idx) = line.find(':') {
                        let k = line[..colon_idx].trim();
                        if k == key {
                            found = true;
                            if value.is_empty() {
                                return String::new(); // Remove the field
                            }
                            return format!("{}: {}", key, value);
                        }
                    }
                    line.to_string()
                })
                .collect();
            let updated_fm: Vec<String> = mapped
                .into_iter()
                .filter(|l| !l.is_empty() || !found)
                .collect();

            let fm_str = updated_fm.join("\n");
            if found {
                return format!("---\n{}\n---{}", fm_str, body);
            } else if !value.is_empty() {
                // Key not found, add it
                return format!("---\n{}\n{}: {}\n---{}", fm_str, key, value, body);
            }
            return format!("---\n{}\n---{}", fm_str, body);
        }
    }
    // No frontmatter, add one if value is not empty
    if value.is_empty() {
        content.to_string()
    } else {
        format!("---\n{}: {}\n---\n\n{}", key, value, content)
    }
}

/// Update aliases for a command
#[tauri::command]
fn update_command_aliases(path: String, aliases: Vec<String>) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("Command file not found: {}", path));
    }

    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;

    // Format aliases as comma-separated string
    let aliases_value = aliases.join(", ");
    let updated_content = update_frontmatter_field(&content, "aliases", &aliases_value);

    fs::write(&file_path, updated_content).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// Agents Feature (commands with 'model' field = agents)
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct LocalAgent {
    pub name: String,
    pub path: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub tools: Option<String>,
    pub content: String,
}

#[tauri::command]
fn list_local_agents() -> Result<Vec<LocalAgent>, String> {
    let commands_dir = get_claude_dir().join("commands");

    if !commands_dir.exists() {
        return Ok(vec![]);
    }

    let mut agents = Vec::new();
    collect_agents(&commands_dir, &commands_dir, &mut agents)?;

    agents.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(agents)
}

fn collect_agents(
    base_dir: &PathBuf,
    current_dir: &PathBuf,
    agents: &mut Vec<LocalAgent>,
) -> Result<(), String> {
    for entry in fs::read_dir(current_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            collect_agents(base_dir, &path, agents)?;
        } else if path.extension().map_or(false, |e| e == "md") {
            let content = fs::read_to_string(&path).unwrap_or_default();
            let (frontmatter, _, body) = parse_frontmatter(&content);

            // Only include if it has a 'model' field (agents have model, commands don't)
            if frontmatter.contains_key("model") {
                let relative = path.strip_prefix(base_dir).unwrap_or(&path);
                let name = relative
                    .to_string_lossy()
                    .trim_end_matches(".md")
                    .replace("\\", "/")
                    .to_string();

                agents.push(LocalAgent {
                    name,
                    path: path.to_string_lossy().to_string(),
                    description: frontmatter.get("description").cloned(),
                    model: frontmatter.get("model").cloned(),
                    tools: frontmatter.get("tools").cloned(),
                    content: body,
                });
            }
        }
    }
    Ok(())
}

// ============================================================================
// Skills Feature
// ============================================================================

/// Marketplace metadata stored alongside installed components
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct MarketplaceMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloads: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LocalSkill {
    pub name: String,
    pub path: String,
    pub description: Option<String>,
    pub content: String,
    // Marketplace metadata (if installed from marketplace)
    #[serde(flatten)]
    pub marketplace: Option<MarketplaceMeta>,
}

#[tauri::command]
fn list_local_skills() -> Result<Vec<LocalSkill>, String> {
    let skills_dir = get_claude_dir().join("skills");

    if !skills_dir.exists() {
        return Ok(vec![]);
    }

    let mut skills = Vec::new();

    for entry in fs::read_dir(&skills_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            let skill_name = path.file_name().unwrap().to_string_lossy().to_string();
            let skill_md = path.join("SKILL.md");

            if skill_md.exists() {
                let content = fs::read_to_string(&skill_md).unwrap_or_default();
                let (frontmatter, _, _) = parse_frontmatter(&content);

                // Load marketplace metadata if exists
                let meta_path = path.join(".meta.json");
                let marketplace = if meta_path.exists() {
                    fs::read_to_string(&meta_path)
                        .ok()
                        .and_then(|s| serde_json::from_str::<MarketplaceMeta>(&s).ok())
                } else {
                    None
                };

                skills.push(LocalSkill {
                    name: skill_name,
                    path: skill_md.to_string_lossy().to_string(),
                    description: frontmatter.get("description").cloned(),
                    content,  // Return raw content with frontmatter for frontend display
                    marketplace,
                });
            }
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

// ============================================================================
// Codex Commands Feature
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct CodexCommand {
    pub name: String,
    pub path: Option<String>,
    pub description: Option<String>,
    pub is_builtin: bool,
}

fn get_codex_dir() -> PathBuf {
    dirs::home_dir()
        .expect("Could not find home directory")
        .join(".codex")
}

#[tauri::command]
fn list_codex_commands() -> Result<Vec<CodexCommand>, String> {
    let mut commands = Vec::new();

    // Add built-in commands
    let builtins = [
        ("model", "Switch between models"),
        ("approvals", "Adjust approval settings"),
        ("status", "Display session status and token usage"),
        ("compact", "Summarize conversation to free tokens"),
        ("diff", "Show Git changes including untracked files"),
        ("mention", "Attach files or folders to conversation"),
        ("new", "Start a fresh conversation"),
        ("review", "Request analysis of working tree changes"),
        ("mcp", "List configured MCP tools"),
        ("init", "Generate AGENTS.md scaffold"),
        ("feedback", "Submit logs and diagnostics"),
        ("logout", "Clear local credentials"),
        ("quit", "Terminate the CLI session"),
        ("exit", "Terminate the CLI session"),
        ("skills", "Browse available skills"),
    ];

    for (name, desc) in builtins {
        commands.push(CodexCommand {
            name: format!("/{}", name),
            path: None,
            description: Some(desc.to_string()),
            is_builtin: true,
        });
    }

    // Add custom prompts from ~/.codex/prompts/
    let prompts_dir = get_codex_dir().join("prompts");
    if prompts_dir.exists() {
        for entry in fs::read_dir(&prompts_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();

            // Only top-level .md files (subdirectories are ignored per Codex docs)
            if path.is_file() && path.extension().map_or(false, |ext| ext == "md") {
                let content = fs::read_to_string(&path).unwrap_or_default();
                let (frontmatter, _, _) = parse_frontmatter(&content);

                let name = path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();

                commands.push(CodexCommand {
                    name: format!("/prompts:{}", name),
                    path: Some(path.to_string_lossy().to_string()),
                    description: frontmatter.get("description").cloned(),
                    is_builtin: false,
                });
            }
        }
    }

    commands.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(commands)
}

// ============================================================================
// Knowledge Base (Distill Documents)
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DistillDocument {
    pub date: String,
    pub file: String,
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub session: Option<String>,
}

fn get_distill_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".lovstudio/docs/distill")
}

fn get_reference_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".lovstudio/docs/reference")
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReferenceSource {
    pub name: String,
    pub path: String,
    pub doc_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReferenceDoc {
    pub name: String,
    pub path: String,
    pub group: Option<String>,
}

/// Scan a directory for reference sources (subdirectories with markdown files)
fn scan_reference_dir(dir: &Path) -> Vec<ReferenceSource> {
    if !dir.exists() {
        return vec![];
    }

    let mut sources = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            // Follow symlinks and check if it's a directory
            if let Ok(metadata) = fs::metadata(&path) {
                if metadata.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let doc_count = fs::read_dir(&path)
                        .map(|entries| {
                            entries
                                .filter(|e| {
                                    e.as_ref()
                                        .ok()
                                        .map(|e| {
                                            e.path().extension().map(|ext| ext == "md").unwrap_or(false)
                                        })
                                        .unwrap_or(false)
                                })
                                .count()
                        })
                        .unwrap_or(0);

                    sources.push(ReferenceSource {
                        name,
                        path: path.to_string_lossy().to_string(),
                        doc_count,
                    });
                }
            }
        }
    }
    sources
}

/// Get bundled reference docs directories from app resources
fn get_bundled_reference_dirs(app_handle: &tauri::AppHandle) -> Vec<(String, PathBuf)> {
    let bundled_docs = [
        ("claude-code", "third-parties/claude-code-docs/docs"),
        ("codex", "third-parties/codex/docs"),
    ];

    let mut result = Vec::new();

    // Try resource directory (production)
    if let Ok(resource_path) = app_handle.path().resource_dir() {
        for (name, rel_path) in &bundled_docs {
            let path = resource_path.join(rel_path);
            if path.exists() {
                result.push((name.to_string(), path));
            }
        }
    }

    // If not found in resources, try development paths
    if result.is_empty() {
        let candidates = [
            std::env::current_dir().ok(),
            std::env::current_dir()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf())),
        ];

        for candidate in candidates.into_iter().flatten() {
            for (name, rel_path) in &bundled_docs {
                let path = candidate.join(rel_path);
                if path.exists() && !result.iter().any(|(n, _)| n == *name) {
                    result.push((name.to_string(), path));
                }
            }
        }
    }

    result
}

#[tauri::command]
fn list_reference_sources(app_handle: tauri::AppHandle) -> Result<Vec<ReferenceSource>, String> {
    let mut sources = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    // 1. Scan user's custom reference directory first (higher priority)
    let ref_dir = get_reference_dir();
    for source in scan_reference_dir(&ref_dir) {
        seen_names.insert(source.name.clone());
        sources.push(source);
    }

    // 2. Add bundled reference docs (if not overridden by user)
    for (name, path) in get_bundled_reference_dirs(&app_handle) {
        if !seen_names.contains(&name) {
            let doc_count = fs::read_dir(&path)
                .map(|entries| {
                    entries
                        .filter(|e| {
                            e.as_ref()
                                .ok()
                                .map(|e| e.path().extension().map(|ext| ext == "md").unwrap_or(false))
                                .unwrap_or(false)
                        })
                        .count()
                })
                .unwrap_or(0);

            sources.push(ReferenceSource {
                name,
                path: path.to_string_lossy().to_string(),
                doc_count,
            });
        }
    }

    sources.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(sources)
}

/// Find reference source directory by name (checks user dir first, then bundled)
fn find_reference_source_dir(app_handle: &tauri::AppHandle, source: &str) -> Option<PathBuf> {
    // 1. Check user's custom reference directory first
    let user_dir = get_reference_dir().join(source);
    if user_dir.exists() {
        return Some(user_dir);
    }

    // 2. Check bundled reference docs
    for (name, path) in get_bundled_reference_dirs(app_handle) {
        if name == source {
            return Some(path);
        }
    }

    None
}

#[tauri::command]
fn list_reference_docs(app_handle: tauri::AppHandle, source: String) -> Result<Vec<ReferenceDoc>, String> {
    let source_dir = match find_reference_source_dir(&app_handle, &source) {
        Some(dir) => dir,
        None => return Ok(vec![]),
    };

    // Read _order.txt if exists, parse groups from comments
    let order_file = source_dir.join("_order.txt");
    let mut order_map: HashMap<String, (usize, Option<String>)> = HashMap::new(); // name -> (order, group)

    if order_file.exists() {
        if let Ok(content) = fs::read_to_string(&order_file) {
            let mut current_group: Option<String> = None;
            let mut order_idx = 0;

            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.starts_with('#') {
                    // Comment line = group name (strip # and trim)
                    let group_name = trimmed.trim_start_matches('#').trim();
                    if !group_name.is_empty() {
                        current_group = Some(group_name.to_string());
                    }
                } else {
                    // Doc name
                    order_map.insert(trimmed.to_string(), (order_idx, current_group.clone()));
                    order_idx += 1;
                }
            }
        }
    }

    let mut docs = Vec::new();
    for entry in fs::read_dir(&source_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().map(|e| e == "md").unwrap_or(false) {
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            let group = order_map.get(&name).and_then(|(_, g)| g.clone());

            docs.push(ReferenceDoc {
                name,
                path: path.to_string_lossy().to_string(),
                group,
            });
        }
    }

    // Sort by _order.txt if available, otherwise alphabetically
    if !order_map.is_empty() {
        docs.sort_by(|a, b| {
            let a_idx = order_map
                .get(&a.name)
                .map(|(i, _)| *i)
                .unwrap_or(usize::MAX);
            let b_idx = order_map
                .get(&b.name)
                .map(|(i, _)| *i)
                .unwrap_or(usize::MAX);
            a_idx.cmp(&b_idx)
        });
    } else {
        docs.sort_by(|a, b| a.name.cmp(&b.name));
    }

    Ok(docs)
}

#[tauri::command]
fn list_distill_documents() -> Result<Vec<DistillDocument>, String> {
    let distill_dir = get_distill_dir();
    let index_path = distill_dir.join("index.jsonl");

    if !index_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
    let mut docs: Vec<DistillDocument> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut doc: DistillDocument = serde_json::from_str(line).ok()?;
            // Use actual file modification time instead of index.jsonl date
            let file_path = distill_dir.join(&doc.file);
            if let Ok(metadata) = fs::metadata(&file_path) {
                if let Ok(modified) = metadata.modified() {
                    let datetime: chrono::DateTime<chrono::Local> = modified.into();
                    doc.date = datetime.format("%Y-%m-%dT%H:%M:%S").to_string();
                }
            }
            Some(doc)
        })
        .collect();

    // Sort by date descending (newest first)
    docs.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(docs)
}

#[tauri::command]
fn find_session_project(session_id: String) -> Result<Option<Session>, String> {
    let projects_dir = get_claude_dir().join("projects");
    if !projects_dir.exists() {
        return Ok(None);
    }

    for project_entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
        let project_entry = project_entry.map_err(|e| e.to_string())?;
        let project_path = project_entry.path();

        if !project_path.is_dir() {
            continue;
        }

        let session_file = project_path.join(format!("{}.jsonl", session_id));
        if session_file.exists() {
            let project_id = project_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();
            let display_path = decode_project_path(&project_id);
            let content = fs::read_to_string(&session_file).unwrap_or_default();

            let mut summary = None;
            for line in content.lines() {
                if let Ok(parsed) = serde_json::from_str::<RawLine>(line) {
                    if parsed.line_type.as_deref() == Some("summary") {
                        summary = parsed.summary;
                        break;
                    }
                }
            }

            return Ok(Some(Session {
                id: session_id,
                project_id,
                project_path: Some(display_path),
                title: None,
                summary,
                message_count: 0,
                created_at: 0,
                last_modified: 0,
                usage: None,
                source: "cli".to_string(),
            }));
        }
    }
    Ok(None)
}

#[tauri::command]
fn get_distill_watch_enabled() -> bool {
    DISTILL_WATCH_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

#[tauri::command]
fn set_distill_watch_enabled(enabled: bool) {
    DISTILL_WATCH_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

// ============================================================================
// Marketplace Feature - Multi-Source Support
// ============================================================================

/// Plugin source configuration
#[derive(Debug, Clone)]
struct PluginSource {
    id: &'static str,
    name: &'static str,
    icon: &'static str,
    priority: u32,
    path: &'static str, // Relative to project root
}

/// Available marketplace sources (ordered by priority)
const PLUGIN_SOURCES: &[PluginSource] = &[
    PluginSource {
        id: "anthropic",
        name: "Anthropic Official",
        icon: "🔷",
        priority: 1,
        path: "third-parties/claude-plugins-official",
    },
    PluginSource {
        id: "lovstudio",
        name: "Lovstudio",
        icon: "💜",
        priority: 2,
        path: "marketplace/lovstudio",
    },
    PluginSource {
        id: "lovstudio-plugins",
        name: "Lovstudio Plugins",
        icon: "💜",
        priority: 3,
        path: "../lovstudio-plugins-official",
    },
    PluginSource {
        id: "community",
        name: "Community",
        icon: "🌍",
        priority: 4,
        path: "third-parties/claude-code-templates/docs/components.json",
    },
];

/// Plugin metadata from .claude-plugin/plugin.json
#[derive(Debug, Serialize, Deserialize, Clone)]
struct PluginMetadata {
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    author: Option<PluginAuthor>,
    #[serde(default)]
    repository: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PluginAuthor {
    name: String,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TemplateComponent {
    pub name: String,
    pub path: String,
    pub category: String,
    #[serde(rename = "type")]
    pub component_type: String,
    pub description: Option<String>,
    pub downloads: Option<u32>,
    pub content: Option<String>,
    // Source attribution
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_name: Option<String>,
    #[serde(default)]
    pub source_icon: Option<String>,
    #[serde(default)]
    pub plugin_name: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TemplatesCatalog {
    pub agents: Vec<TemplateComponent>,
    pub commands: Vec<TemplateComponent>,
    pub mcps: Vec<TemplateComponent>,
    pub hooks: Vec<TemplateComponent>,
    pub settings: Vec<TemplateComponent>,
    pub skills: Vec<TemplateComponent>,
    pub statuslines: Vec<TemplateComponent>,
    #[serde(default)]
    pub sources: Vec<SourceInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub count: usize,
}

/// Resolve source path (handles both bundled and development paths)
fn resolve_source_path(
    app_handle: Option<&tauri::AppHandle>,
    relative_path: &str,
) -> Option<PathBuf> {
    // In production: try bundled resources first
    if let Some(handle) = app_handle {
        if let Ok(resource_path) = handle.path().resource_dir() {
            // Tauri maps "../" to "_up_/" in the resource bundle
            let bundled_path = relative_path.replace("../", "_up_/");
            let bundled = resource_path.join("_up_").join(&bundled_path);
            if bundled.exists() {
                return Some(bundled);
            }
        }
    }

    // In development: try from current dir and parent
    let candidates = [
        std::env::current_dir().ok(),
        std::env::current_dir()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf())),
    ];

    for candidate in candidates.into_iter().flatten() {
        let path = candidate.join(relative_path);
        if path.exists() {
            return Some(path);
        }
    }

    None
}

/// Load community catalog from JSON file (claude-code-templates)
fn load_community_catalog(
    app_handle: Option<&tauri::AppHandle>,
    source: &PluginSource,
) -> Vec<TemplateComponent> {
    let Some(path) = resolve_source_path(app_handle, source.path) else {
        return Vec::new();
    };

    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };

    let Ok(raw): Result<serde_json::Value, _> = serde_json::from_str(&content) else {
        return Vec::new();
    };

    let mut components = Vec::new();

    // Load each component type and add source info
    for (key, comp_type) in [
        ("agents", "agent"),
        ("commands", "command"),
        ("mcps", "mcp"),
        ("hooks", "hook"),
        ("settings", "setting"),
        ("skills", "skill"),
    ] {
        if let Some(items) = raw.get(key) {
            if let Ok(mut parsed) = serde_json::from_value::<Vec<TemplateComponent>>(items.clone())
            {
                for comp in &mut parsed {
                    comp.source_id = Some(source.id.to_string());
                    comp.source_name = Some(source.name.to_string());
                    comp.source_icon = Some(source.icon.to_string());
                    if comp.component_type.is_empty() {
                        comp.component_type = comp_type.to_string();
                    }
                }
                components.extend(parsed);
            }
        }
    }

    components
}

/// Parse SKILL.md frontmatter to extract metadata
fn parse_skill_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    if !content.starts_with("---") {
        return (None, None);
    }

    let parts: Vec<&str> = content.splitn(3, "---").collect();
    if parts.len() < 3 {
        return (None, None);
    }

    let frontmatter = parts[1];
    let mut name = None;
    let mut description = None;

    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("name:") {
            name = Some(val.trim().to_string());
        } else if let Some(val) = line.strip_prefix("description:") {
            description = Some(val.trim().to_string());
        }
    }

    (name, description)
}

/// Load plugins from a directory structure (claude-plugins-official style)
fn load_plugin_directory(
    app_handle: Option<&tauri::AppHandle>,
    source: &PluginSource,
) -> Vec<TemplateComponent> {
    let Some(base_path) = resolve_source_path(app_handle, source.path) else {
        return Vec::new();
    };

    let mut components = Vec::new();

    // Scan both plugins/ and external_plugins/ directories
    for subdir in ["plugins", "external_plugins"] {
        let dir = base_path.join(subdir);
        if !dir.exists() {
            continue;
        }

        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.filter_map(|e| e.ok()) {
            let plugin_dir = entry.path();
            if !plugin_dir.is_dir() {
                continue;
            }

            // Read plugin metadata
            let plugin_json = plugin_dir.join(".claude-plugin/plugin.json");
            let metadata: Option<PluginMetadata> = fs::read_to_string(&plugin_json)
                .ok()
                .and_then(|c| serde_json::from_str(&c).ok());

            let plugin_name = metadata
                .as_ref()
                .map(|m| m.name.clone())
                .unwrap_or_else(|| {
                    plugin_dir
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string()
                });

            let plugin_desc = metadata.as_ref().and_then(|m| m.description.clone());
            let author = metadata
                .as_ref()
                .and_then(|m| m.author.as_ref().map(|a| a.name.clone()));

            // Scan commands/
            let commands_dir = plugin_dir.join("commands");
            if commands_dir.exists() {
                if let Ok(cmd_entries) = fs::read_dir(&commands_dir) {
                    for cmd_entry in cmd_entries.filter_map(|e| e.ok()) {
                        let cmd_path = cmd_entry.path();
                        if cmd_path.extension().map_or(false, |e| e == "md") {
                            let name = cmd_path
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            let content = fs::read_to_string(&cmd_path).ok();

                            components.push(TemplateComponent {
                                name: name.clone(),
                                path: cmd_path.to_string_lossy().to_string(),
                                category: plugin_name.clone(),
                                component_type: "command".to_string(),
                                description: plugin_desc.clone(),
                                downloads: None,
                                content,
                                source_id: Some(source.id.to_string()),
                                source_name: Some(source.name.to_string()),
                                source_icon: Some(source.icon.to_string()),
                                plugin_name: Some(plugin_name.clone()),
                                author: author.clone(),
                            });
                        }
                    }
                }
            }

            // Scan skills/
            let skills_dir = plugin_dir.join("skills");
            if skills_dir.exists() {
                if let Ok(skill_entries) = fs::read_dir(&skills_dir) {
                    for skill_entry in skill_entries.filter_map(|e| e.ok()) {
                        let skill_path = skill_entry.path();
                        if skill_path.is_dir() {
                            let skill_md = skill_path.join("SKILL.md");
                            if skill_md.exists() {
                                let name = skill_path
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string();
                                let content = fs::read_to_string(&skill_md).ok();
                                let (parsed_name, parsed_desc) = content
                                    .as_ref()
                                    .map(|c| parse_skill_frontmatter(c))
                                    .unwrap_or((None, None));

                                components.push(TemplateComponent {
                                    name: parsed_name.unwrap_or(name.clone()),
                                    path: skill_md.to_string_lossy().to_string(),
                                    category: plugin_name.clone(),
                                    component_type: "skill".to_string(),
                                    description: parsed_desc.or_else(|| plugin_desc.clone()),
                                    downloads: None,
                                    content,
                                    source_id: Some(source.id.to_string()),
                                    source_name: Some(source.name.to_string()),
                                    source_icon: Some(source.icon.to_string()),
                                    plugin_name: Some(plugin_name.clone()),
                                    author: author.clone(),
                                });
                            }
                        }
                    }
                }
            }

            // Scan agents/
            let agents_dir = plugin_dir.join("agents");
            if agents_dir.exists() {
                if let Ok(agent_entries) = fs::read_dir(&agents_dir) {
                    for agent_entry in agent_entries.filter_map(|e| e.ok()) {
                        let agent_path = agent_entry.path();
                        if agent_path.extension().map_or(false, |e| e == "md") {
                            let name = agent_path
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            let content = fs::read_to_string(&agent_path).ok();

                            components.push(TemplateComponent {
                                name: name.clone(),
                                path: agent_path.to_string_lossy().to_string(),
                                category: plugin_name.clone(),
                                component_type: "agent".to_string(),
                                description: plugin_desc.clone(),
                                downloads: None,
                                content,
                                source_id: Some(source.id.to_string()),
                                source_name: Some(source.name.to_string()),
                                source_icon: Some(source.icon.to_string()),
                                plugin_name: Some(plugin_name.clone()),
                                author: author.clone(),
                            });
                        }
                    }
                }
            }

            // Check for .mcp.json
            let mcp_json = plugin_dir.join(".mcp.json");
            if mcp_json.exists() {
                let content = fs::read_to_string(&mcp_json).ok();
                components.push(TemplateComponent {
                    name: plugin_name.clone(),
                    path: mcp_json.to_string_lossy().to_string(),
                    category: plugin_name.clone(),
                    component_type: "mcp".to_string(),
                    description: plugin_desc.clone(),
                    downloads: None,
                    content,
                    source_id: Some(source.id.to_string()),
                    source_name: Some(source.name.to_string()),
                    source_icon: Some(source.icon.to_string()),
                    plugin_name: Some(plugin_name.clone()),
                    author: author.clone(),
                });
            }
        }
    }

    components
}

/// Load a single plugin (lovstudio-plugins-official style)
fn load_single_plugin(
    app_handle: Option<&tauri::AppHandle>,
    source: &PluginSource,
) -> Vec<TemplateComponent> {
    let Some(base_path) = resolve_source_path(app_handle, source.path) else {
        return Vec::new();
    };

    let mut components = Vec::new();

    // Read plugin metadata
    let plugin_json = base_path.join(".claude-plugin/plugin.json");
    let metadata: Option<PluginMetadata> = fs::read_to_string(&plugin_json)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok());

    let plugin_name = metadata
        .as_ref()
        .map(|m| m.name.clone())
        .unwrap_or_else(|| source.id.to_string());

    let plugin_desc = metadata.as_ref().and_then(|m| m.description.clone());
    let author = metadata
        .as_ref()
        .and_then(|m| m.author.as_ref().map(|a| a.name.clone()));

    // Scan skills/
    let skills_dir = base_path.join("skills");
    if skills_dir.exists() {
        if let Ok(skill_entries) = fs::read_dir(&skills_dir) {
            for skill_entry in skill_entries.filter_map(|e| e.ok()) {
                let skill_path = skill_entry.path();
                if skill_path.is_dir() {
                    let skill_md = skill_path.join("SKILL.md");
                    if skill_md.exists() {
                        let name = skill_path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        let content = fs::read_to_string(&skill_md).ok();
                        let (parsed_name, parsed_desc) = content
                            .as_ref()
                            .map(|c| parse_skill_frontmatter(c))
                            .unwrap_or((None, None));

                        components.push(TemplateComponent {
                            name: parsed_name.unwrap_or_else(|| format!("{}:{}", plugin_name, name)),
                            path: skill_md.to_string_lossy().to_string(),
                            category: plugin_name.clone(),
                            component_type: "skill".to_string(),
                            description: parsed_desc.or_else(|| plugin_desc.clone()),
                            downloads: None,
                            content,
                            source_id: Some(source.id.to_string()),
                            source_name: Some(source.name.to_string()),
                            source_icon: Some(source.icon.to_string()),
                            plugin_name: Some(plugin_name.clone()),
                            author: author.clone(),
                        });
                    }
                }
            }
        }
    }

    // Scan commands/
    let commands_dir = base_path.join("commands");
    if commands_dir.exists() {
        if let Ok(cmd_entries) = fs::read_dir(&commands_dir) {
            for cmd_entry in cmd_entries.filter_map(|e| e.ok()) {
                let cmd_path = cmd_entry.path();
                if cmd_path.extension().map_or(false, |e| e == "md") {
                    let name = cmd_path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let content = fs::read_to_string(&cmd_path).ok();

                    components.push(TemplateComponent {
                        name: name.clone(),
                        path: cmd_path.to_string_lossy().to_string(),
                        category: plugin_name.clone(),
                        component_type: "command".to_string(),
                        description: plugin_desc.clone(),
                        downloads: None,
                        content,
                        source_id: Some(source.id.to_string()),
                        source_name: Some(source.name.to_string()),
                        source_icon: Some(source.icon.to_string()),
                        plugin_name: Some(plugin_name.clone()),
                        author: author.clone(),
                    });
                }
            }
        }
    }

    // Scan hooks/ (read hooks.json if exists)
    let hooks_json = base_path.join("hooks/hooks.json");
    if hooks_json.exists() {
        let content = fs::read_to_string(&hooks_json).ok();
        components.push(TemplateComponent {
            name: format!("{}-hooks", plugin_name),
            path: hooks_json.to_string_lossy().to_string(),
            category: plugin_name.clone(),
            component_type: "hook".to_string(),
            description: Some("Automation hooks configuration".to_string()),
            downloads: None,
            content,
            source_id: Some(source.id.to_string()),
            source_name: Some(source.name.to_string()),
            source_icon: Some(source.icon.to_string()),
            plugin_name: Some(plugin_name.clone()),
            author: author.clone(),
        });
    }

    // Scan statuslines/ (.sh files)
    let statuslines_dir = base_path.join("statuslines");
    if statuslines_dir.exists() {
        if let Ok(entries) = fs::read_dir(&statuslines_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.extension().map_or(false, |e| e == "sh") {
                    let name = path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let content = fs::read_to_string(&path).ok();

                    // Parse description from script header comment
                    let description = content.as_ref().and_then(|c| {
                        c.lines()
                            .find(|l| l.starts_with("# Description:"))
                            .map(|l| l.trim_start_matches("# Description:").trim().to_string())
                    });

                    components.push(TemplateComponent {
                        name: name.clone(),
                        path: path.to_string_lossy().to_string(),
                        category: plugin_name.clone(),
                        component_type: "statusline".to_string(),
                        description,
                        downloads: None,
                        content,
                        source_id: Some(source.id.to_string()),
                        source_name: Some(source.name.to_string()),
                        source_icon: Some(source.icon.to_string()),
                        plugin_name: Some(plugin_name.clone()),
                        author: author.clone(),
                    });
                }
            }
        }
    }

    components
}

/// Load personal/installed statuslines from ~/.lovstudio/lovcode/statusline/
fn load_personal_statuslines() -> Vec<TemplateComponent> {
    let statusline_dir = get_lovstudio_dir().join("statusline");
    let mut components = Vec::new();

    if !statusline_dir.exists() {
        return components;
    }

    if let Ok(entries) = fs::read_dir(&statusline_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "sh") {
                let name = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy();

                // Skip backup files (starting with _)
                if name.starts_with('_') {
                    continue;
                }

                let name = name
                    .to_string();
                let content = fs::read_to_string(&path).ok();

                // Parse description from script header comment
                let description = content.as_ref().and_then(|c| {
                    c.lines()
                        .find(|l| l.starts_with("# Description:"))
                        .map(|l| l.trim_start_matches("# Description:").trim().to_string())
                });

                components.push(TemplateComponent {
                    name: name.clone(),
                    path: path.to_string_lossy().to_string(),
                    category: "personal".to_string(),
                    component_type: "statusline".to_string(),
                    description,
                    downloads: None,
                    content,
                    source_id: Some("personal".to_string()),
                    source_name: Some("Installed".to_string()),
                    source_icon: Some("📦".to_string()),
                    plugin_name: None,
                    author: None,
                });
            }
        }
    }

    components
}

#[tauri::command]
fn get_templates_catalog(app_handle: tauri::AppHandle) -> Result<TemplatesCatalog, String> {
    let mut all_components: Vec<TemplateComponent> = Vec::new();
    let mut source_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    // Load from each source
    for source in PLUGIN_SOURCES {
        let components = if source.path.ends_with(".json") {
            // Community catalog (JSON file)
            load_community_catalog(Some(&app_handle), source)
        } else if source.id == "lovstudio" {
            // Single plugin directory
            load_single_plugin(Some(&app_handle), source)
        } else {
            // Multi-plugin directory
            load_plugin_directory(Some(&app_handle), source)
        };

        source_counts.insert(source.id.to_string(), components.len());
        all_components.extend(components);
    }

    // Separate by type
    let mut agents = Vec::new();
    let mut commands = Vec::new();
    let mut mcps = Vec::new();
    let mut hooks = Vec::new();
    let mut settings = Vec::new();
    let mut skills = Vec::new();
    let mut statuslines = Vec::new();

    for comp in all_components {
        match comp.component_type.as_str() {
            "agent" => agents.push(comp),
            "command" => commands.push(comp),
            "mcp" => mcps.push(comp),
            "hook" => hooks.push(comp),
            "setting" => settings.push(comp),
            "skill" => skills.push(comp),
            "statusline" => statuslines.push(comp),
            _ => {} // Ignore unknown types
        }
    }

    // Add personal/installed statuslines
    let personal_statuslines = load_personal_statuslines();
    let personal_count = personal_statuslines.len();
    statuslines.extend(personal_statuslines);

    // Build source info
    let mut sources: Vec<SourceInfo> = PLUGIN_SOURCES
        .iter()
        .map(|s| SourceInfo {
            id: s.id.to_string(),
            name: s.name.to_string(),
            icon: s.icon.to_string(),
            count: *source_counts.get(s.id).unwrap_or(&0),
        })
        .collect();

    // Add personal source if there are installed statuslines
    if personal_count > 0 {
        sources.insert(0, SourceInfo {
            id: "personal".to_string(),
            name: "Installed".to_string(),
            icon: "📦".to_string(),
            count: personal_count,
        });
    }

    Ok(TemplatesCatalog {
        agents,
        commands,
        mcps,
        hooks,
        settings,
        skills,
        statuslines,
        sources,
    })
}

#[tauri::command]
fn install_command_template(name: String, content: String) -> Result<String, String> {
    let commands_dir = get_claude_dir().join("commands");
    fs::create_dir_all(&commands_dir).map_err(|e| e.to_string())?;

    let file_path = commands_dir.join(format!("{}.md", name));
    fs::write(&file_path, content).map_err(|e| e.to_string())?;

    Ok(file_path.to_string_lossy().to_string())
}

/// Install a skill template to ~/.claude/skills/{name}/SKILL.md
#[tauri::command]
fn install_skill_template(
    name: String,
    content: String,
    source_id: Option<String>,
    source_name: Option<String>,
    author: Option<String>,
    downloads: Option<i64>,
    template_path: Option<String>,
) -> Result<String, String> {
    if name.is_empty() {
        return Err("Skill name cannot be empty".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("Skill name contains invalid characters".to_string());
    }

    // Create directory structure: ~/.claude/skills/{name}/
    let skill_dir = get_claude_dir().join("skills").join(&name);
    fs::create_dir_all(&skill_dir).map_err(|e| format!("Failed to create skill directory: {}", e))?;

    // Write SKILL.md file
    let skill_file = skill_dir.join("SKILL.md");
    fs::write(&skill_file, &content).map_err(|e| format!("Failed to write SKILL.md: {}", e))?;

    // Save marketplace metadata if provided
    if source_id.is_some() || source_name.is_some() || author.is_some() {
        let meta = MarketplaceMeta {
            source_id,
            source_name,
            author,
            downloads,
            template_path,
        };
        let meta_path = skill_dir.join(".meta.json");
        if let Ok(meta_json) = serde_json::to_string_pretty(&meta) {
            let _ = fs::write(&meta_path, meta_json);
        }
    }

    Ok(skill_file.to_string_lossy().to_string())
}

/// Uninstall a skill by removing its directory
#[tauri::command]
fn uninstall_skill(name: String) -> Result<String, String> {
    if name.is_empty() {
        return Err("Skill name cannot be empty".to_string());
    }

    let skill_dir = get_claude_dir().join("skills").join(&name);
    if !skill_dir.exists() {
        return Err(format!("Skill '{}' not found", name));
    }

    fs::remove_dir_all(&skill_dir).map_err(|e| format!("Failed to remove skill: {}", e))?;
    Ok(format!("Uninstalled skill: {}", name))
}

/// Check if a skill is already installed
#[tauri::command]
fn check_skill_installed(name: String) -> bool {
    let skill_file = get_claude_dir().join("skills").join(&name).join("SKILL.md");
    skill_file.exists()
}

#[tauri::command]
fn install_mcp_template(name: String, config: String) -> Result<String, String> {
    // MCP servers are stored in ~/.claude.json (not ~/.claude/settings.json)
    let claude_json_path = get_claude_json_path();

    // Parse the MCP config
    let mcp_config: serde_json::Value = serde_json::from_str(&config).map_err(|e| e.to_string())?;

    // Helper to check if a value looks like an actual MCP server config
    // (has type, url, or command field)
    fn is_server_config(v: &serde_json::Value) -> bool {
        v.get("type").is_some() || v.get("url").is_some() || v.get("command").is_some()
    }

    // Recursively extract the actual server config, unwrapping any nesting
    fn extract_server_config(v: serde_json::Value) -> serde_json::Value {
        // If it's already a valid config, return it
        if is_server_config(&v) {
            return v;
        }

        // Try to unwrap {"mcpServers": {...}}
        if let Some(mcp_servers) = v.get("mcpServers").and_then(|x| x.as_object()) {
            if let Some(inner) = mcp_servers.values().next() {
                return extract_server_config(inner.clone());
            }
        }

        // Try to unwrap {"someName": {config}}
        if let Some(obj) = v.as_object() {
            if obj.len() == 1 {
                if let Some(inner) = obj.values().next() {
                    if is_server_config(inner) || inner.is_object() {
                        return extract_server_config(inner.clone());
                    }
                }
            }
        }

        v
    }

    let server_config = extract_server_config(mcp_config);

    // Read existing ~/.claude.json or create new
    let mut claude_json: serde_json::Value = if claude_json_path.exists() {
        let content = fs::read_to_string(&claude_json_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Ensure mcpServers exists
    if !claude_json.get("mcpServers").is_some() {
        claude_json["mcpServers"] = serde_json::json!({});
    }

    // Ensure the server config has a 'type' field (required by Claude Code)
    // Infer type from the config if not present:
    // - If has "url" field -> "http" (or "sse" if url contains /sse)
    // - If has "command" field -> "stdio"
    let mut server_config = server_config;
    if server_config.get("type").is_none() {
        if let Some(url) = server_config.get("url").and_then(|v| v.as_str()) {
            // Check if it's an SSE endpoint
            let transport_type = if url.ends_with("/sse") || url.contains("/sse/") {
                "sse"
            } else {
                "http"
            };
            server_config["type"] = serde_json::json!(transport_type);
        } else if server_config.get("command").is_some() {
            server_config["type"] = serde_json::json!("stdio");
        }
    }

    // Add the MCP server with the extracted config
    claude_json["mcpServers"][&name] = server_config;

    // Write back
    let output = serde_json::to_string_pretty(&claude_json).map_err(|e| e.to_string())?;
    fs::write(&claude_json_path, output).map_err(|e| e.to_string())?;

    Ok(format!("Installed MCP: {}", name))
}

#[tauri::command]
fn uninstall_mcp_template(name: String) -> Result<String, String> {
    let claude_json_path = get_claude_json_path();

    if !claude_json_path.exists() {
        return Err("No MCP configuration found".to_string());
    }

    let content = fs::read_to_string(&claude_json_path).map_err(|e| e.to_string())?;
    let mut claude_json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;

    if let Some(mcp_servers) = claude_json
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
    {
        if mcp_servers.remove(&name).is_none() {
            return Err(format!("MCP '{}' not found", name));
        }
    } else {
        return Err("No mcpServers found".to_string());
    }

    let output = serde_json::to_string_pretty(&claude_json).map_err(|e| e.to_string())?;
    fs::write(&claude_json_path, output).map_err(|e| e.to_string())?;

    Ok(format!("Uninstalled MCP: {}", name))
}

#[tauri::command]
fn check_mcp_installed(name: String) -> bool {
    let claude_json_path = get_claude_json_path();

    if !claude_json_path.exists() {
        return false;
    }

    let Ok(content) = fs::read_to_string(&claude_json_path) else {
        return false;
    };

    let Ok(claude_json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };

    claude_json
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .map(|servers| servers.contains_key(&name))
        .unwrap_or(false)
}

#[tauri::command]
fn install_hook_template(name: String, config: String) -> Result<String, String> {
    let settings_path = get_claude_dir().join("settings.json");

    // Parse the hook config (should be an object with event type as key)
    let hook_config: serde_json::Value =
        serde_json::from_str(&config).map_err(|e| e.to_string())?;

    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Ensure hooks exists
    if !settings.get("hooks").is_some() {
        settings["hooks"] = serde_json::json!({});
    }

    // Merge hook config - hooks are typically structured as {"PreToolUse": [...], "PostToolUse": [...]}
    if let Some(hook_obj) = hook_config.as_object() {
        for (event_type, handlers) in hook_obj {
            if let Some(handlers_arr) = handlers.as_array() {
                // Get existing handlers for this event type
                let existing = settings["hooks"]
                    .get(event_type)
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();

                // Merge (append new handlers)
                let mut merged: Vec<serde_json::Value> = existing;
                merged.extend(handlers_arr.clone());
                settings["hooks"][event_type] = serde_json::Value::Array(merged);
            }
        }
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;

    Ok(format!("Installed hook: {}", name))
}

#[tauri::command]
fn install_setting_template(config: String) -> Result<String, String> {
    let settings_path = get_claude_dir().join("settings.json");

    // Parse the setting config
    let new_settings: serde_json::Value =
        serde_json::from_str(&config).map_err(|e| e.to_string())?;

    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Deep merge the new settings
    if let (Some(existing_obj), Some(new_obj)) =
        (settings.as_object_mut(), new_settings.as_object())
    {
        for (key, value) in new_obj {
            existing_obj.insert(key.clone(), value.clone());
        }
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;

    Ok("Settings updated".to_string())
}

#[tauri::command]
fn update_settings_statusline(statusline: serde_json::Value) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        serde_json::json!({})
    };

    settings["statusLine"] = statusline;

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn remove_settings_statusline() -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    if !settings_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    let mut settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("statusLine");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn write_statusline_script(content: String) -> Result<String, String> {
    let script_path = get_claude_dir().join("statusline.sh");
    fs::write(&script_path, &content).map_err(|e| e.to_string())?;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).map_err(|e| e.to_string())?;
    }

    Ok(script_path.to_string_lossy().to_string())
}

/// Install statusline template to ~/.lovstudio/lovcode/statusline/{name}.sh
#[tauri::command]
fn install_statusline_template(name: String, content: String) -> Result<String, String> {
    let statusline_dir = get_lovstudio_dir().join("statusline");
    fs::create_dir_all(&statusline_dir).map_err(|e| e.to_string())?;

    let script_path = statusline_dir.join(format!("{}.sh", name));
    fs::write(&script_path, &content).map_err(|e| e.to_string())?;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).map_err(|e| e.to_string())?;
    }

    Ok(script_path.to_string_lossy().to_string())
}

/// Apply statusline: copy from ~/.lovstudio/lovcode/statusline/{name}.sh to ~/.claude/statusline.sh
/// If ~/.claude/statusline.sh exists and is not already installed, backup to ~/.lovstudio/lovcode/statusline/_previous.sh
#[tauri::command]
fn apply_statusline(name: String) -> Result<String, String> {
    let source_path = get_lovstudio_dir().join("statusline").join(format!("{}.sh", name));
    if !source_path.exists() {
        return Err(format!("Statusline template not found: {}", name));
    }

    let target_path = get_claude_dir().join("statusline.sh");
    let backup_dir = get_lovstudio_dir().join("statusline");
    fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

    // Backup existing statusline.sh if it exists and differs from source
    if target_path.exists() {
        let existing_content = fs::read_to_string(&target_path).unwrap_or_default();
        let new_content = fs::read_to_string(&source_path).map_err(|e| e.to_string())?;

        if existing_content != new_content {
            let backup_path = backup_dir.join("_previous.sh");
            fs::copy(&target_path, &backup_path).map_err(|e| e.to_string())?;
        }
    }

    let content = fs::read_to_string(&source_path).map_err(|e| e.to_string())?;
    fs::write(&target_path, &content).map_err(|e| e.to_string())?;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&target_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&target_path, perms).map_err(|e| e.to_string())?;
    }

    Ok(target_path.to_string_lossy().to_string())
}

/// Restore previous statusline from backup
#[tauri::command]
fn restore_previous_statusline() -> Result<String, String> {
    let backup_path = get_lovstudio_dir().join("statusline").join("_previous.sh");
    if !backup_path.exists() {
        return Err("No previous statusline to restore".to_string());
    }

    let content = fs::read_to_string(&backup_path).map_err(|e| e.to_string())?;
    let target_path = get_claude_dir().join("statusline.sh");
    fs::write(&target_path, &content).map_err(|e| e.to_string())?;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&target_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&target_path, perms).map_err(|e| e.to_string())?;
    }

    // Remove backup after restore
    fs::remove_file(&backup_path).ok();

    Ok(target_path.to_string_lossy().to_string())
}

/// Check if previous statusline backup exists
#[tauri::command]
fn has_previous_statusline() -> bool {
    get_lovstudio_dir().join("statusline").join("_previous.sh").exists()
}

/// Context passed to Lovcode statusbar script
#[derive(Debug, Serialize, Deserialize)]
pub struct StatusBarContext {
    pub app_name: String,
    pub version: String,
    pub projects_count: usize,
    pub features_count: usize,
    pub today_lines_added: usize,
    pub today_lines_deleted: usize,
    pub timestamp: String,
    pub home_dir: String,
}

/// Execute Lovcode's GUI statusbar script and return output
#[tauri::command]
fn execute_statusbar_script(script_path: String, context: StatusBarContext) -> Result<String, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    // Expand ~ to home dir
    let home = dirs::home_dir().unwrap_or_default();
    let expanded_path = if script_path.starts_with("~") {
        script_path.replacen("~", &home.to_string_lossy(), 1)
    } else {
        script_path
    };

    let path = std::path::Path::new(&expanded_path);
    if !path.exists() {
        return Err(format!("Script not found: {}", expanded_path));
    }

    // Serialize context to JSON
    let context_json = serde_json::to_string(&context).map_err(|e| e.to_string())?;

    // Determine how to execute the script
    #[cfg(unix)]
    let mut child = Command::new(&expanded_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn script: {}", e))?;

    #[cfg(windows)]
    let mut child = Command::new("powershell")
        .args(["-ExecutionPolicy", "Bypass", "-File", &expanded_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn script: {}", e))?;

    // Write context JSON to stdin
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(context_json.as_bytes()).ok();
    }

    // Wait for output with timeout
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Script execution failed: {}", e))?;

    // Get first line of stdout
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next().unwrap_or("").to_string();

    Ok(first_line)
}

/// Get Lovcode statusbar settings from workspace.json
#[tauri::command]
fn get_statusbar_settings() -> Result<Option<serde_json::Value>, String> {
    let settings_path = get_lovstudio_dir().join("statusbar-settings.json");
    if !settings_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    let settings: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(Some(settings))
}

/// Save Lovcode statusbar settings
#[tauri::command]
fn save_statusbar_settings(settings: serde_json::Value) -> Result<(), String> {
    let settings_path = get_lovstudio_dir().join("statusbar-settings.json");
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, content).map_err(|e| e.to_string())
}

/// Write Lovcode statusbar script to ~/.lovstudio/lovcode/statusbar/
#[tauri::command]
fn write_lovcode_statusbar_script(name: String, content: String) -> Result<String, String> {
    let statusbar_dir = get_lovstudio_dir().join("statusbar");
    fs::create_dir_all(&statusbar_dir).map_err(|e| e.to_string())?;

    let script_path = statusbar_dir.join(format!("{}.sh", name));
    fs::write(&script_path, &content).map_err(|e| e.to_string())?;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).map_err(|e| e.to_string())?;
    }

    Ok(script_path.to_string_lossy().to_string())
}

/// Remove installed statusline template
#[tauri::command]
fn remove_statusline_template(name: String) -> Result<(), String> {
    let script_path = get_lovstudio_dir().join("statusline").join(format!("{}.sh", name));
    if script_path.exists() {
        fs::remove_file(&script_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============================================================================
// Context Feature
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct ContextFile {
    pub name: String,
    pub path: String,
    pub scope: String, // "global" or "project"
    pub content: String,
    pub last_modified: u64,
}

#[tauri::command]
fn get_context_files() -> Result<Vec<ContextFile>, String> {
    let mut files = Vec::new();

    // Global CLAUDE.md
    let global_path = get_claude_dir().join("CLAUDE.md");
    if global_path.exists() {
        if let Ok(content) = fs::read_to_string(&global_path) {
            let last_modified = fs::metadata(&global_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            files.push(ContextFile {
                name: "CLAUDE.md".to_string(),
                path: global_path.to_string_lossy().to_string(),
                scope: "global".to_string(),
                content,
                last_modified,
            });
        }
    }

    // Check each project directory for CLAUDE.md
    let projects_dir = get_claude_dir().join("projects");
    if projects_dir.exists() {
        if let Ok(entries) = fs::read_dir(&projects_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let project_path = entry.path();
                if project_path.is_dir() {
                    let project_id = project_path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .to_string();
                    let display_path = decode_project_path(&project_id);

                    // Convert project_id back to real path and check for CLAUDE.md
                    let real_project_path = PathBuf::from(&display_path);
                    let claude_md_path = real_project_path.join("CLAUDE.md");

                    if claude_md_path.exists() {
                        if let Ok(content) = fs::read_to_string(&claude_md_path) {
                            let last_modified = fs::metadata(&claude_md_path)
                                .ok()
                                .and_then(|m| m.modified().ok())
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs())
                                .unwrap_or(0);

                            files.push(ContextFile {
                                name: format!("{}/CLAUDE.md", display_path),
                                path: claude_md_path.to_string_lossy().to_string(),
                                scope: "project".to_string(),
                                content,
                                last_modified,
                            });
                        }
                    }
                }
            }
        }
    }

    files.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(files)
}

#[tauri::command]
fn get_project_context(project_path: String) -> Result<Vec<ContextFile>, String> {
    let mut files = Vec::new();
    let project_dir = PathBuf::from(&project_path);

    // Check for CLAUDE.md in project root
    let claude_md = project_dir.join("CLAUDE.md");
    if claude_md.exists() {
        if let Ok(content) = fs::read_to_string(&claude_md) {
            let last_modified = fs::metadata(&claude_md)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            files.push(ContextFile {
                name: "CLAUDE.md".to_string(),
                path: claude_md.to_string_lossy().to_string(),
                scope: "project".to_string(),
                content,
                last_modified,
            });
        }
    }

    // Check for .claude/CLAUDE.md in project
    let dot_claude_md = project_dir.join(".claude").join("CLAUDE.md");
    if dot_claude_md.exists() {
        if let Ok(content) = fs::read_to_string(&dot_claude_md) {
            let last_modified = fs::metadata(&dot_claude_md)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            files.push(ContextFile {
                name: ".claude/CLAUDE.md".to_string(),
                path: dot_claude_md.to_string_lossy().to_string(),
                scope: "project".to_string(),
                content,
                last_modified,
            });
        }
    }

    // Check for project-local commands in .claude/commands/
    let commands_dir = project_dir.join(".claude").join("commands");
    if commands_dir.exists() && commands_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&commands_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.extension().map_or(false, |e| e == "md") {
                    if let Ok(content) = fs::read_to_string(&path) {
                        let name = path.file_name().unwrap().to_string_lossy().to_string();
                        let last_modified = fs::metadata(&path)
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);

                        files.push(ContextFile {
                            name: format!(".claude/commands/{}", name),
                            path: path.to_string_lossy().to_string(),
                            scope: "command".to_string(),
                            content,
                            last_modified,
                        });
                    }
                }
            }
        }
    }

    files.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(files)
}

// ============================================================================
// Daily Message Stats for Activity Heatmap
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct ActivityStats {
    /// Map of date (YYYY-MM-DD) to count
    pub daily: HashMap<String, usize>,
    /// Map of hour (0-23) to count
    pub hourly: HashMap<u32, usize>,
    /// Map of "date:hour" (YYYY-MM-DD:HH) to count for detailed heatmap
    pub detailed: HashMap<String, usize>,
}

#[tauri::command]
async fn get_activity_stats() -> Result<ActivityStats, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let history_path = get_claude_dir().join("history.jsonl");
        let mut daily: HashMap<String, usize> = HashMap::new();
        let mut hourly: HashMap<u32, usize> = HashMap::new();
        let mut detailed: HashMap<String, usize> = HashMap::new();

        if !history_path.exists() {
            return Ok(ActivityStats { daily, hourly, detailed });
        }

        if let Ok(content) = fs::read_to_string(&history_path) {
            for line in content.lines() {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                    if let Some(ts_ms) = parsed.get("timestamp").and_then(|v| v.as_u64()) {
                        let ts_secs = ts_ms / 1000;
                        if let Some(dt) = chrono::DateTime::from_timestamp(ts_secs as i64, 0) {
                            // Daily count
                            let date = dt.format("%Y-%m-%d").to_string();
                            *daily.entry(date.clone()).or_insert(0) += 1;

                            // Hourly count (0-23)
                            let hour = dt.format("%H").to_string().parse::<u32>().unwrap_or(0);
                            *hourly.entry(hour).or_insert(0) += 1;

                            // Detailed: date + hour
                            let date_hour = format!("{}:{:02}", date, hour);
                            *detailed.entry(date_hour).or_insert(0) += 1;
                        }
                    }
                }
            }
        }

        Ok(ActivityStats { daily, hourly, detailed })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================================
// Annual Report 2025
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct FavoriteProject {
    pub id: String,
    pub path: String,
    pub session_count: usize,
    pub message_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TopCommand {
    pub name: String,
    pub count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AnnualReport2025 {
    pub total_sessions: usize,
    pub total_messages: usize,
    pub total_commands: usize,
    pub active_days: usize,
    pub first_chat_date: Option<String>,
    pub last_chat_date: Option<String>,
    pub peak_hour: u32,
    pub peak_hour_count: usize,
    pub peak_weekday: u32,
    pub total_projects: usize,
    pub favorite_project: Option<FavoriteProject>,
    pub top_commands: Vec<TopCommand>,
    pub longest_streak: usize,
    pub daily_activity: HashMap<String, usize>,
    pub hourly_distribution: HashMap<u32, usize>,
}

#[tauri::command]
async fn get_annual_report_2025() -> Result<AnnualReport2025, String> {
    tauri::async_runtime::spawn_blocking(|| {
        use chrono::{Datelike, Timelike};

        // 2025 year bounds (UTC)
        let start_2025: u64 = 1735689600000; // 2025-01-01 00:00:00 UTC in ms
        let end_2025: u64 = 1767225600000;   // 2026-01-01 00:00:00 UTC in ms

        let history_path = get_claude_dir().join("history.jsonl");
        let projects_dir = get_claude_dir().join("projects");

        let mut daily_activity: HashMap<String, usize> = HashMap::new();
        let mut hourly_distribution: HashMap<u32, usize> = HashMap::new();
        let mut weekday_counts: HashMap<u32, usize> = HashMap::new();
        let mut first_date: Option<String> = None;
        let mut last_date: Option<String> = None;

        // Parse history.jsonl for 2025 data
        if history_path.exists() {
            if let Ok(content) = fs::read_to_string(&history_path) {
                for line in content.lines() {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(ts_ms) = parsed.get("timestamp").and_then(|v| v.as_u64()) {
                            // Filter for 2025 only
                            if ts_ms >= start_2025 && ts_ms < end_2025 {
                                let ts_secs = ts_ms / 1000;
                                if let Some(dt) = chrono::DateTime::from_timestamp(ts_secs as i64, 0) {
                                    let date = dt.format("%Y-%m-%d").to_string();
                                    *daily_activity.entry(date.clone()).or_insert(0) += 1;

                                    let hour = dt.hour();
                                    *hourly_distribution.entry(hour).or_insert(0) += 1;

                                    let weekday = dt.weekday().num_days_from_sunday();
                                    *weekday_counts.entry(weekday).or_insert(0) += 1;

                                    // Track first and last dates
                                    if first_date.is_none() || date < *first_date.as_ref().unwrap() {
                                        first_date = Some(date.clone());
                                    }
                                    if last_date.is_none() || date > *last_date.as_ref().unwrap() {
                                        last_date = Some(date.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Calculate peak hour
        let (peak_hour, peak_hour_count) = hourly_distribution
            .iter()
            .max_by_key(|(_, count)| *count)
            .map(|(h, c)| (*h, *c))
            .unwrap_or((0, 0));

        // Calculate peak weekday
        let peak_weekday = weekday_counts
            .iter()
            .max_by_key(|(_, count)| *count)
            .map(|(d, _)| *d)
            .unwrap_or(0);

        // Calculate longest streak
        let mut dates: Vec<&String> = daily_activity.keys().collect();
        dates.sort();
        let mut longest_streak = 0usize;
        let mut current_streak = 1usize;
        for i in 1..dates.len() {
            if let (Ok(prev), Ok(curr)) = (
                chrono::NaiveDate::parse_from_str(dates[i - 1], "%Y-%m-%d"),
                chrono::NaiveDate::parse_from_str(dates[i], "%Y-%m-%d"),
            ) {
                if curr.signed_duration_since(prev).num_days() == 1 {
                    current_streak += 1;
                } else {
                    longest_streak = longest_streak.max(current_streak);
                    current_streak = 1;
                }
            }
        }
        longest_streak = longest_streak.max(current_streak);

        // Scan projects for session/message counts in 2025
        let mut total_sessions = 0usize;
        let mut total_messages = 0usize;
        let mut project_stats: HashMap<String, (String, usize, usize)> = HashMap::new(); // id -> (path, sessions, messages)
        let mut command_counts: HashMap<String, usize> = HashMap::new(); // command -> count (fallback)
        let command_pattern = regex::Regex::new(r"<command-name>(/[^<]+)</command-name>").ok();

        if projects_dir.exists() {
            if let Ok(entries) = fs::read_dir(&projects_dir) {
                for entry in entries.flatten() {
                    let project_path = entry.path();
                    if !project_path.is_dir() {
                        continue;
                    }

                    let project_id = project_path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();

                    // Read project.json for actual path
                    let project_json_path = project_path.join("project.json");
                    let actual_path = if project_json_path.exists() {
                        fs::read_to_string(&project_json_path)
                            .ok()
                            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                            .and_then(|v| v.get("path").and_then(|p| p.as_str()).map(String::from))
                            .unwrap_or_else(|| project_id.clone())
                    } else {
                        project_id.clone()
                    };

                    let mut proj_sessions = 0usize;
                    let mut proj_messages = 0usize;

                    // Scan session files
                    if let Ok(session_entries) = fs::read_dir(&project_path) {
                        for session_entry in session_entries.flatten() {
                            let session_path = session_entry.path();
                            if session_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                                continue;
                            }

                            // Check if session has 2025 activity by reading first line
                            if let Ok(content) = fs::read_to_string(&session_path) {
                                let mut has_2025_activity = false;
                                let mut msg_count = 0usize;

                                for line in content.lines() {
                                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                                        // Check timestamp if available
                                        if let Some(ts) = parsed.get("timestamp").and_then(|v| v.as_str()) {
                                            if ts.starts_with("2025-") {
                                                has_2025_activity = true;
                                            }
                                        }
                                        // Count non-meta messages
                                        if parsed.get("type").and_then(|t| t.as_str()) != Some("meta") {
                                            msg_count += 1;
                                        }
                                        // Extract commands from assistant messages (for fallback stats)
                                        if let Some(pattern) = &command_pattern {
                                            if let Some(text) = parsed.get("message").and_then(|m| {
                                                m.get("content").and_then(|c| c.as_str())
                                            }) {
                                                for cap in pattern.captures_iter(text) {
                                                    if let Some(cmd_match) = cap.get(1) {
                                                        let cmd = cmd_match.as_str().trim_start_matches('/').to_string();
                                                        *command_counts.entry(cmd).or_insert(0) += 1;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }

                                if has_2025_activity {
                                    proj_sessions += 1;
                                    proj_messages += msg_count;
                                }
                            }
                        }
                    }

                    if proj_sessions > 0 {
                        total_sessions += proj_sessions;
                        total_messages += proj_messages;
                        project_stats.insert(project_id, (actual_path, proj_sessions, proj_messages));
                    }
                }
            }
        }

        // Find favorite project
        let favorite_project = project_stats
            .iter()
            .max_by_key(|(_, (_, sessions, _))| sessions)
            .map(|(id, (path, sessions, messages))| FavoriteProject {
                id: id.clone(),
                path: path.clone(),
                session_count: *sessions,
                message_count: *messages,
            });

        // Get top commands from command-stats index (aggregate weekly data) or fallback to extracted
        let mut top_commands: Vec<TopCommand> = Vec::new();
        let stats_path = get_command_stats_path();
        let mut use_fallback = true;

        if stats_path.exists() {
            if let Ok(content) = fs::read_to_string(&stats_path) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(commands) = parsed.get("commands").and_then(|v| v.as_object()) {
                        let mut aggregated: HashMap<String, usize> = HashMap::new();
                        for (cmd_name, week_data) in commands {
                            if let Some(weeks) = week_data.as_object() {
                                let total: usize = weeks
                                    .values()
                                    .filter_map(|v| v.as_u64())
                                    .map(|n| n as usize)
                                    .sum();
                                aggregated.insert(cmd_name.clone(), total);
                            }
                        }
                        if !aggregated.is_empty() {
                            let mut sorted: Vec<_> = aggregated.into_iter().collect();
                            sorted.sort_by(|a, b| b.1.cmp(&a.1));
                            top_commands = sorted
                                .into_iter()
                                .take(5)
                                .map(|(name, count)| TopCommand { name, count })
                                .collect();
                            use_fallback = false;
                        }
                    }
                }
            }
        }

        // Fallback: use command counts extracted from session files
        if use_fallback && !command_counts.is_empty() {
            let mut sorted: Vec<_> = command_counts.into_iter().collect();
            sorted.sort_by(|a, b| b.1.cmp(&a.1));
            top_commands = sorted
                .into_iter()
                .take(5)
                .map(|(name, count)| TopCommand { name, count })
                .collect();
        }

        // Count local commands
        let total_commands = list_local_commands()
            .map(|cmds| cmds.len())
            .unwrap_or(0);

        Ok(AnnualReport2025 {
            total_sessions,
            total_messages,
            total_commands,
            active_days: daily_activity.len(),
            first_chat_date: first_date,
            last_chat_date: last_date,
            peak_hour,
            peak_hour_count,
            peak_weekday,
            total_projects: project_stats.len(),
            favorite_project,
            top_commands,
            longest_streak,
            daily_activity,
            hourly_distribution,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================================
// Command Usage Stats Feature
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandStats {
    pub name: String,
    pub count: usize,
}

#[tauri::command]
async fn get_command_stats() -> Result<HashMap<String, usize>, String> {
    // Get current cache state
    let (cached_stats, cached_scanned) = {
        let cache = COMMAND_STATS_CACHE.lock().unwrap();
        (cache.stats.clone(), cache.scanned.clone())
    };

    // Incremental update in background
    let (new_stats, new_scanned) = tauri::async_runtime::spawn_blocking(move || {
        let projects_dir = get_claude_dir().join("projects");
        let mut stats = cached_stats;
        let mut scanned = cached_scanned;

        if !projects_dir.exists() {
            return Ok::<_, String>((stats, scanned));
        }

        let command_pattern = regex::Regex::new(r"<command-name>(/[^<]+)</command-name>")
            .map_err(|e| e.to_string())?;

        for project_entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
            let project_entry = project_entry.map_err(|e| e.to_string())?;
            let project_path = project_entry.path();

            if !project_path.is_dir() {
                continue;
            }

            for session_entry in fs::read_dir(&project_path).map_err(|e| e.to_string())? {
                let session_entry = session_entry.map_err(|e| e.to_string())?;
                let session_path = session_entry.path();
                let name = session_path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string();

                if !name.ends_with(".jsonl") || name.starts_with("agent-") {
                    continue;
                }

                let path_str = session_path.to_string_lossy().to_string();
                let file_size = session_path.metadata().map(|m| m.len()).unwrap_or(0);
                let prev_size = scanned.get(&path_str).copied().unwrap_or(0);

                // Skip if no new content
                if file_size <= prev_size {
                    continue;
                }

                // Read only new content (from prev_size offset)
                if let Ok(mut file) = std::fs::File::open(&session_path) {
                    use std::io::{Read, Seek, SeekFrom};
                    if file.seek(SeekFrom::Start(prev_size)).is_ok() {
                        let mut new_content = String::new();
                        if file.read_to_string(&mut new_content).is_ok() {
                            // Process line by line to filter out queue-operation entries
                            for line in new_content.lines() {
                                if line.contains("\"type\":\"queue-operation\"") {
                                    continue;
                                }
                                for cap in command_pattern.captures_iter(line) {
                                    if let Some(cmd_name) = cap.get(1) {
                                        // Remove leading "/" to match cmd.name format
                                        let name =
                                            cmd_name.as_str().trim_start_matches('/').to_string();
                                        *stats.entry(name).or_insert(0) += 1;
                                    }
                                }
                            }
                        }
                    }
                }
                scanned.insert(path_str, file_size);
            }
        }

        Ok((stats, scanned))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Update cache
    {
        let mut cache = COMMAND_STATS_CACHE.lock().unwrap();
        cache.stats = new_stats.clone();
        cache.scanned = new_scanned;
    }

    Ok(new_stats)
}

/// Returns command usage counts grouped by week (from pre-built index)
/// Format: { "command_name": { "2024-W01": count, "2024-W02": count, ... } }
#[tauri::command]
fn get_command_weekly_stats(_weeks: Option<usize>) -> Result<HashMap<String, HashMap<String, usize>>, String> {
    // Read from pre-built index (created by build_search_index)
    let stats_path = get_command_stats_path();

    if !stats_path.exists() {
        return Ok(HashMap::new());
    }

    let content = fs::read_to_string(&stats_path).map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Extract commands map
    let commands = parsed
        .get("commands")
        .and_then(|v| v.as_object())
        .ok_or("Invalid command stats format")?;

    let mut stats: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for (cmd_name, week_data) in commands {
        if let Some(weeks) = week_data.as_object() {
            let mut week_map: HashMap<String, usize> = HashMap::new();
            for (week_key, count) in weeks {
                if let Some(n) = count.as_u64() {
                    week_map.insert(week_key.clone(), n as usize);
                }
            }
            stats.insert(cmd_name.clone(), week_map);
        }
    }

    Ok(stats)
}

// ============================================================================
// Settings Feature
// ============================================================================

#[tauri::command]
fn get_settings() -> Result<ClaudeSettings, String> {
    let settings_path = get_claude_dir().join("settings.json");
    let claude_json_path = get_claude_json_path();

    // Read ~/.claude/settings.json for permissions, hooks, etc.
    let (mut raw, permissions, hooks) = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        let raw: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        let permissions = raw.get("permissions").cloned();
        let hooks = raw.get("hooks").cloned();
        (raw, permissions, hooks)
    } else {
        (Value::Null, None, None)
    };

    // Overlay disabled env from ~/.lovstudio/lovcode (do not persist in settings.json)
    if let Ok(disabled_env) = load_disabled_env() {
        if !disabled_env.is_empty() {
            if let Some(obj) = raw.as_object_mut() {
                obj.insert(
                    "_lovcode_disabled_env".to_string(),
                    Value::Object(disabled_env),
                );
            } else {
                raw = serde_json::json!({
                    "_lovcode_disabled_env": disabled_env
                });
            }
        } else if let Some(obj) = raw.as_object_mut() {
            obj.remove("_lovcode_disabled_env");
        }
    }

    // Read ~/.claude.json for MCP servers
    let mut mcp_servers = Vec::new();
    if claude_json_path.exists() {
        if let Ok(content) = fs::read_to_string(&claude_json_path) {
            if let Ok(claude_json) = serde_json::from_str::<Value>(&content) {
                if let Some(mcp_obj) = claude_json.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, config) in mcp_obj {
                        if let Some(obj) = config.as_object() {
                            // Handle nested mcpServers format (from some installers)
                            let actual_config = if let Some(nested) =
                                obj.get("mcpServers").and_then(|v| v.as_object())
                            {
                                nested.values().next().and_then(|v| v.as_object())
                            } else {
                                Some(obj)
                            };

                            if let Some(cfg) = actual_config {
                                let description = cfg
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                let server_type = cfg
                                    .get("type")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                let url = cfg
                                    .get("url")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                let command = cfg
                                    .get("command")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                let args: Vec<String> = cfg
                                    .get("args")
                                    .and_then(|v| v.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|v| v.as_str().map(String::from))
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let env: HashMap<String, String> = cfg
                                    .get("env")
                                    .and_then(|v| v.as_object())
                                    .map(|m| {
                                        m.iter()
                                            .filter_map(|(k, v)| {
                                                v.as_str().map(|s| (k.clone(), s.to_string()))
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default();

                                mcp_servers.push(McpServer {
                                    name: name.clone(),
                                    description,
                                    server_type,
                                    url,
                                    command,
                                    args,
                                    env,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(ClaudeSettings {
        raw,
        permissions,
        hooks,
        mcp_servers,
    })
}

fn get_session_path(project_id: &str, session_id: &str) -> PathBuf {
    get_claude_dir()
        .join("projects")
        .join(project_id)
        .join(format!("{}.jsonl", session_id))
}

#[tauri::command]
fn open_session_in_editor(project_id: String, session_id: String) -> Result<(), String> {
    let path = get_session_path(&project_id, &session_id);
    if !path.exists() {
        return Err("Session file not found".to_string());
    }
    open_in_editor(path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_session_file_path(project_id: String, session_id: String) -> Result<String, String> {
    let path = get_session_path(&project_id, &session_id);
    if !path.exists() {
        return Err("Session file not found".to_string());
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_session_summary(project_id: String, session_id: String) -> Result<Option<String>, String> {
    let path = get_session_path(&project_id, &session_id);
    if !path.exists() {
        return Err("Session file not found".to_string());
    }
    let head = read_session_head(&path, 20);
    Ok(head.summary)
}

#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_session_file(project_id: String, session_id: String) -> Result<(), String> {
    let session_path = get_session_path(&project_id, &session_id);

    if !session_path.exists() {
        return Err("Session file not found".to_string());
    }

    let path = session_path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(session_path.parent().unwrap_or(&session_path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn reveal_path(path: String, cwd: Option<String>) -> Result<(), String> {
    let expanded = if path.starts_with("~/") || path == "~" {
        let home = dirs::home_dir().ok_or("Cannot get home dir")?;
        if path == "~" { home } else { home.join(&path[2..]) }
    } else if path.starts_with('/') {
        std::path::PathBuf::from(&path)
    } else if let Some(base) = cwd.as_ref().filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(base).join(&path)
    } else {
        std::path::PathBuf::from(&path)
    };

    if !expanded.exists() {
        return Err(format!(
            "Path not found\n  input: {}\n  cwd:   {}\n  tried: {}",
            path,
            cwd.as_deref().unwrap_or("(none)"),
            expanded.display()
        ));
    }

    let path_str = expanded.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path_str])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path_str])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(expanded.parent().unwrap_or(&expanded))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_path(path: String, cwd: Option<String>) -> Result<(), String> {
    let expanded = if path.starts_with("~/") || path == "~" {
        let home = dirs::home_dir().ok_or("Cannot get home dir")?;
        if path == "~" { home } else { home.join(&path[2..]) }
    } else if path.starts_with('/') {
        std::path::PathBuf::from(&path)
    } else if let Some(base) = cwd.as_ref().filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(base).join(&path)
    } else {
        std::path::PathBuf::from(&path)
    };

    if !expanded.exists() {
        return Err(format!(
            "Path not found\n  input: {}\n  cwd:   {}\n  tried: {}",
            path,
            cwd.as_deref().unwrap_or("(none)"),
            expanded.display()
        ));
    }

    let path_str = expanded.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path_str])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
struct PathCheckResult {
    raw: String,
    resolved: String,
    is_dir: bool,
}

#[tauri::command]
fn check_paths_exist(paths: Vec<String>, cwd: Option<String>) -> Vec<PathCheckResult> {
    let home = dirs::home_dir();
    let cwd_path = cwd.as_ref().map(std::path::PathBuf::from);

    paths
        .into_iter()
        .filter_map(|raw| {
            let trimmed = raw.trim().trim_end_matches([',', '.', ';', ':', ')', ']']);
            if trimmed.is_empty() {
                return None;
            }

            let candidate = if trimmed.starts_with("~/") || trimmed == "~" {
                let home = home.as_ref()?;
                if trimmed == "~" {
                    home.clone()
                } else {
                    home.join(&trimmed[2..])
                }
            } else if trimmed.starts_with('/') {
                std::path::PathBuf::from(trimmed)
            } else if let Some(base) = &cwd_path {
                base.join(trimmed)
            } else {
                return None;
            };

            let metadata = std::fs::metadata(&candidate).ok()?;
            let canonical = std::fs::canonicalize(&candidate).unwrap_or(candidate);

            Some(PathCheckResult {
                raw,
                resolved: canonical.to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
            })
        })
        .collect()
}

#[derive(Serialize)]
struct RelocationCandidate {
    /// Full reconstructed path that exists on disk (lost-root replacement + tail rejoin).
    path: String,
    /// Source classification for ranking + UI display.
    source: String, // "spotlight" | "ancestor"
    /// True if the WHOLE original path can be reconstructed at this candidate.
    full_match: bool,
}

#[derive(Serialize)]
struct RelocationResult {
    /// The deepest ancestor of `from` that exists on disk (informational).
    nearest_existing_ancestor: Option<String>,
    /// The first segment whose parent exists but it doesn't — the "lost" leaf to search for.
    lost_root: Option<String>,
    /// Path tail BELOW lost_root (joined with `/`); empty if `lost_root` IS the original path.
    tail: String,
    /// Best-effort candidates, sorted by quality (full_match first, then source priority).
    candidates: Vec<RelocationCandidate>,
}

/// Walk up `from`, returning (nearest_existing_ancestor, lost_root_path).
/// `lost_root_path` is the last segment in the chain whose parent exists on disk.
fn analyze_lost_path(from: &std::path::Path) -> (Option<std::path::PathBuf>, Option<std::path::PathBuf>) {
    let mut lost_root: Option<std::path::PathBuf> = None;
    let mut cur = from.to_path_buf();
    loop {
        if cur.exists() {
            return (Some(cur), lost_root);
        }
        lost_root = Some(cur.clone());
        match cur.parent() {
            Some(p) if !p.as_os_str().is_empty() => cur = p.to_path_buf(),
            _ => return (None, lost_root),
        }
    }
}

#[tauri::command]
async fn find_relocation_candidates(from: String) -> Result<RelocationResult, String> {
    if from.is_empty() {
        return Err("from is required".into());
    }
    let from_path = std::path::PathBuf::from(&from);

    let (nearest, lost_root_opt) = analyze_lost_path(&from_path);
    let lost_root = match lost_root_opt {
        Some(p) => p,
        None => {
            return Ok(RelocationResult {
                nearest_existing_ancestor: nearest.map(|p| p.to_string_lossy().to_string()),
                lost_root: None,
                tail: String::new(),
                candidates: Vec::new(),
            });
        }
    };

    // Tail = path components below lost_root (relative).
    let tail: std::path::PathBuf = from_path
        .strip_prefix(&lost_root)
        .map(|p| p.to_path_buf())
        .unwrap_or_default();

    let leaf_name = lost_root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut candidates: Vec<RelocationCandidate> = Vec::new();

    // Strategy: Spotlight (macOS) global search for the leaf folder name.
    #[cfg(target_os = "macos")]
    if !leaf_name.is_empty() {
        let leaf_owned = leaf_name.clone();
        let mdfind_out = tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new("/usr/bin/mdfind")
                .args([
                    "-onlyin",
                    "/Users",
                    &format!("kMDItemFSName == \"{}\" && kMDItemContentType == \"public.folder\"", leaf_owned.replace('"', "\\\"")),
                ])
                .output()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

        if mdfind_out.status.success() {
            let stdout = String::from_utf8_lossy(&mdfind_out.stdout);
            for line in stdout.lines().take(50) {
                let cand_root = std::path::PathBuf::from(line.trim());
                if !cand_root.is_dir() {
                    continue;
                }
                if cand_root == lost_root {
                    continue;
                }
                let full = cand_root.join(&tail);
                let full_match = full.exists();
                candidates.push(RelocationCandidate {
                    path: if full_match {
                        full.to_string_lossy().to_string()
                    } else {
                        cand_root.to_string_lossy().to_string()
                    },
                    source: "spotlight".into(),
                    full_match,
                });
            }
        }
    }

    // Sort: full matches first, then by path length (shorter = closer to home).
    candidates.sort_by(|a, b| {
        b.full_match
            .cmp(&a.full_match)
            .then_with(|| a.path.len().cmp(&b.path.len()))
    });

    // Dedupe by path
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|c| seen.insert(c.path.clone()));

    Ok(RelocationResult {
        nearest_existing_ancestor: nearest.map(|p| p.to_string_lossy().to_string()),
        lost_root: Some(lost_root.to_string_lossy().to_string()),
        tail: tail.to_string_lossy().to_string(),
        candidates,
    })
}

#[derive(Serialize)]
struct MigrateCwdResult {
    success: bool,
    stdout: String,
    stderr: String,
    /// Parsed `migrated` count from cc-mv `--json` output if available.
    migrated: Option<u64>,
}

/// Find a usable `npx` executable. Tauri-spawned children on macOS GUI apps don't
/// inherit the login shell PATH, so absolute paths must be probed explicitly.
fn find_npx() -> Option<String> {
    if let Ok(p) = std::env::var("PATH") {
        for dir in p.split(':') {
            let candidate = std::path::PathBuf::from(dir).join("npx");
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    for fallback in [
        "/opt/homebrew/bin/npx",
        "/usr/local/bin/npx",
        "/usr/bin/npx",
    ] {
        if std::path::Path::new(fallback).exists() {
            return Some(fallback.to_string());
        }
    }
    None
}

/// Rewrite the `cwd` field in Claude desktop app's per-session local_*.json files
/// for any session whose cwd has `from` as a prefix. Returns count of files updated.
/// cc-mv only knows about ~/.claude/projects/*; this companion store is lovcode-specific.
fn rewrite_app_session_cwds(from: &str, to: &str) -> Result<usize, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let root = home
        .join("Library")
        .join("Application Support")
        .join("Claude")
        .join("claude-code-sessions");
    if !root.exists() {
        return Ok(0);
    }

    let mut updated = 0usize;

    for device in fs::read_dir(&root).into_iter().flatten().flatten() {
        for account in fs::read_dir(device.path()).into_iter().flatten().flatten() {
            for entry in fs::read_dir(account.path()).into_iter().flatten().flatten() {
                let path = entry.path();
                let fname = path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                if !fname.starts_with("local_") || !fname.ends_with(".json") {
                    continue;
                }
                let content = match fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let mut value: serde_json::Value = match serde_json::from_str(&content) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let Some(cwd) = value.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
                    continue;
                };
                if cwd != from && !cwd.starts_with(&format!("{}/", from)) {
                    continue;
                }
                let new_cwd = if cwd == from {
                    to.to_string()
                } else {
                    format!("{}{}", to, &cwd[from.len()..])
                };
                value["cwd"] = serde_json::Value::String(new_cwd);
                if let Ok(serialized) = serde_json::to_string_pretty(&value) {
                    if fs::write(&path, serialized).is_ok() {
                        updated += 1;
                    }
                }
            }
        }
    }

    Ok(updated)
}

#[tauri::command]
async fn migrate_session_cwd(from: String, to: String) -> Result<MigrateCwdResult, String> {
    if from.is_empty() || to.is_empty() {
        return Err("from and to are required".into());
    }
    let npx = find_npx().ok_or_else(|| {
        "找不到 npx — 请确认 Node.js 已安装并在 PATH 中（/opt/homebrew/bin 或 /usr/local/bin）".to_string()
    })?;

    let from_clone = from.clone();
    let to_clone = to.clone();
    let npx_clone = npx.clone();

    let output = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new(&npx_clone)
            .args([
                "-y",
                "@lovstudio/cc-mv",
                &from_clone,
                &to_clone,
                "--no-mv",
                "--yes",
                "--json",
                // Repair scenario: old slug points to a non-existent dir, so keeping
                // it as a safety net only causes duplicate session rows in the UI.
                // We always rewrite — never move files — so this only deletes redundant
                // jsonl copies under ~/.claude/projects/<old-slug>/.
                "--delete-source",
            ])
            .output()
    })
    .await
    .map_err(|e| format!("spawn join error: {}", e))?
    .map_err(|e| format!("spawn cc-mv failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let success = output.status.success();

    // cc-mv with --json prints a JSON object on stdout. Try to extract `migrated`.
    let migrated = serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()
        .and_then(|v| v.get("migrated").and_then(|x| x.as_u64()));

    // After cc-mv succeeds, also rewrite the lovcode-side desktop-app session metadata
    // (~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json) which
    // cc-mv doesn't know about. lovcode reads `cwd` from these files in list_all_sessions,
    // so without this step the UI would still show the old path.
    if success {
        match rewrite_app_session_cwds(&from, &to) {
            Ok(n) if n > 0 => {
                stderr.push_str(&format!("\n[lovcode] rewrote cwd in {} app session metadata files", n));
            }
            Ok(_) => {}
            Err(e) => {
                stderr.push_str(&format!("\n[lovcode] failed to rewrite app session metadata: {}", e));
            }
        }
    }

    Ok(MigrateCwdResult {
        success,
        stdout,
        stderr,
        migrated,
    })
}

#[tauri::command]
fn open_in_editor(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_file_at_line(path: String, line: usize) -> Result<(), String> {
    // 尝试用 cursor，失败则用 code (VSCode)
    let editors = ["cursor", "code", "zed"];

    for editor in editors {
        let result = std::process::Command::new(editor)
            .arg("--goto")
            .arg(format!("{}:{}", path, line))
            .spawn();

        if result.is_ok() {
            return Ok(());
        }
    }

    // 都失败则用系统默认方式打开
    open_in_editor(path)
}

#[tauri::command]
fn get_settings_path() -> String {
    get_claude_dir()
        .join("settings.json")
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn get_mcp_config_path() -> String {
    get_claude_json_path().to_string_lossy().to_string()
}

#[tauri::command]
fn get_home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn get_env_var(name: String) -> Option<String> {
    std::env::var(&name).ok()
}

#[derive(Debug, Serialize)]
pub struct TodayCodingStats {
    pub lines_added: usize,
    pub lines_deleted: usize,
}

#[tauri::command]
fn get_today_coding_stats() -> Result<TodayCodingStats, String> {
    use std::process::Command;

    let workspace_path = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("lovcode")
        .join("workspace.json");

    if !workspace_path.exists() {
        return Ok(TodayCodingStats {
            lines_added: 0,
            lines_deleted: 0,
        });
    }

    let content = fs::read_to_string(&workspace_path).map_err(|e| e.to_string())?;
    let workspace: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let mut total_added: usize = 0;
    let mut total_deleted: usize = 0;

    if let Some(projects) = workspace.get("projects").and_then(|p| p.as_array()) {
        for project in projects {
            if let Some(path) = project.get("path").and_then(|p| p.as_str()) {
                // Run git diff --stat for today
                let output = Command::new("git")
                    .args([
                        "-C",
                        path,
                        "diff",
                        "--shortstat",
                        "--since=midnight",
                        "HEAD",
                    ])
                    .output();

                if let Ok(output) = output {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    // Parse "X files changed, Y insertions(+), Z deletions(-)"
                    for part in stdout.split(',') {
                        let part = part.trim();
                        if part.contains("insertion") {
                            if let Some(num) = part.split_whitespace().next() {
                                total_added += num.parse::<usize>().unwrap_or(0);
                            }
                        } else if part.contains("deletion") {
                            if let Some(num) = part.split_whitespace().next() {
                                total_deleted += num.parse::<usize>().unwrap_or(0);
                            }
                        }
                    }
                }

                // Also check uncommitted changes
                let output = Command::new("git")
                    .args(["-C", path, "diff", "--shortstat"])
                    .output();

                if let Ok(output) = output {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    for part in stdout.split(',') {
                        let part = part.trim();
                        if part.contains("insertion") {
                            if let Some(num) = part.split_whitespace().next() {
                                total_added += num.parse::<usize>().unwrap_or(0);
                            }
                        } else if part.contains("deletion") {
                            if let Some(num) = part.split_whitespace().next() {
                                total_deleted += num.parse::<usize>().unwrap_or(0);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(TodayCodingStats {
        lines_added: total_added,
        lines_deleted: total_deleted,
    })
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_mcp_env(server_name: String, env_key: String, env_value: String) -> Result<(), String> {
    let claude_json_path = get_claude_json_path();

    let mut claude_json: serde_json::Value = if claude_json_path.exists() {
        let content = fs::read_to_string(&claude_json_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        return Err("~/.claude.json not found".to_string());
    };

    let server = claude_json
        .get_mut("mcpServers")
        .and_then(|s| s.get_mut(&server_name))
        .ok_or_else(|| format!("MCP server '{}' not found", server_name))?;

    if !server.get("env").is_some() {
        server["env"] = serde_json::json!({});
    }
    server["env"][&env_key] = serde_json::Value::String(env_value);

    let output = serde_json::to_string_pretty(&claude_json).map_err(|e| e.to_string())?;
    fs::write(&claude_json_path, output).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn update_settings_env(
    env_key: String,
    env_value: String,
    is_new: Option<bool>,
) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        serde_json::json!({})
    };

    if !settings.get("env").and_then(|v| v.as_object()).is_some() {
        settings["env"] = serde_json::json!({});
    }
    settings["env"][&env_key] = serde_json::Value::String(env_value);

    // Track custom env keys when is_new=true
    if is_new == Some(true) {
        let custom_keys = settings
            .get("_lovcode_custom_env_keys")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let key_val = serde_json::Value::String(env_key.clone());
        if !custom_keys.contains(&key_val) {
            let mut new_keys = custom_keys;
            new_keys.push(key_val);
            settings["_lovcode_custom_env_keys"] = serde_json::Value::Array(new_keys);
        }
    }

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn delete_settings_env(env_key: String) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        serde_json::json!({})
    };

    if let Some(env) = settings.get_mut("env").and_then(|v| v.as_object_mut()) {
        env.remove(&env_key);
    }

    // Also remove from custom keys list
    if let Some(custom_keys) = settings
        .get_mut("_lovcode_custom_env_keys")
        .and_then(|v| v.as_array_mut())
    {
        custom_keys.retain(|v| v.as_str() != Some(&env_key));
    }

    // Also remove from disabled env if present
    if let Some(disabled) = settings
        .get_mut("_lovcode_disabled_env")
        .and_then(|v| v.as_object_mut())
    {
        disabled.remove(&env_key);
    }

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;

    let mut disabled_env = load_disabled_env()?;
    disabled_env.remove(&env_key);
    save_disabled_env(&disabled_env)?;

    Ok(())
}

#[tauri::command]
fn disable_settings_env(env_key: String) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    if !settings_path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    let mut settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Get current value before removing
    let current_value = settings
        .get("env")
        .and_then(|v| v.get(&env_key))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Remove from active env
    if let Some(env) = settings.get_mut("env").and_then(|v| v.as_object_mut()) {
        env.remove(&env_key);
    }

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;

    let mut disabled_env = load_disabled_env()?;
    disabled_env.insert(env_key, serde_json::Value::String(current_value));
    save_disabled_env(&disabled_env)?;

    Ok(())
}

#[tauri::command]
fn enable_settings_env(env_key: String) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        serde_json::json!({})
    };

    // Get value from disabled env
    let mut disabled_env = load_disabled_env()?;
    let disabled_value = disabled_env
        .get(&env_key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    disabled_env.remove(&env_key);
    save_disabled_env(&disabled_env)?;

    // Add back to active env
    if !settings.get("env").and_then(|v| v.as_object()).is_some() {
        settings["env"] = serde_json::json!({});
    }
    settings["env"][&env_key] = serde_json::Value::String(disabled_value);

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn update_disabled_settings_env(env_key: String, env_value: String) -> Result<(), String> {
    let mut disabled_env = load_disabled_env()?;
    disabled_env.insert(env_key, serde_json::Value::String(env_value));
    save_disabled_env(&disabled_env)?;

    Ok(())
}

// ============================================================================
// Provider Context Commands (per-provider env persistence)
// ============================================================================

#[tauri::command]
fn get_provider_contexts() -> Result<Value, String> {
    let contexts = load_provider_contexts()?;
    Ok(Value::Object(contexts))
}

#[tauri::command]
fn set_provider_context_env(
    provider_key: String,
    env_key: String,
    env_value: String,
) -> Result<(), String> {
    let mut contexts = load_provider_contexts()?;
    let entry = contexts
        .entry(provider_key)
        .or_insert_with(|| serde_json::json!({ "env": {} }));
    let obj = entry.as_object_mut().ok_or("provider context not object")?;
    if !obj.get("env").and_then(|v| v.as_object()).is_some() {
        obj.insert("env".to_string(), serde_json::json!({}));
    }
    obj["env"][&env_key] = Value::String(env_value);
    save_provider_contexts(&contexts)?;
    Ok(())
}

#[tauri::command]
fn snapshot_provider_context(
    provider_key: String,
    env_keys: Vec<String>,
) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    if !settings_path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    let settings: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let env = settings.get("env").cloned().unwrap_or(serde_json::json!({}));

    let mut snapshot = serde_json::Map::new();
    for key in &env_keys {
        if let Some(v) = env.get(key).and_then(|v| v.as_str()) {
            snapshot.insert(key.clone(), Value::String(v.to_string()));
        }
    }

    let mut contexts = load_provider_contexts()?;
    contexts.insert(
        provider_key,
        serde_json::json!({ "env": Value::Object(snapshot) }),
    );
    save_provider_contexts(&contexts)?;
    Ok(())
}

// ============================================================================
// MaaS Registry Commands
// ============================================================================

#[tauri::command]
fn get_maas_registry() -> Result<Vec<MaasProvider>, String> {
    load_maas_registry()
}

#[tauri::command]
fn save_maas_registry(registry: Vec<MaasProvider>) -> Result<(), String> {
    persist_maas_registry(&registry)
}

#[tauri::command]
fn upsert_maas_provider(provider: MaasProvider) -> Result<Vec<MaasProvider>, String> {
    let mut registry = load_maas_registry()?;
    match registry.iter().position(|p| p.key == provider.key) {
        Some(idx) => registry[idx] = provider,
        None => registry.push(provider),
    }
    persist_maas_registry(&registry)?;
    Ok(registry)
}

#[tauri::command]
fn delete_maas_provider(key: String) -> Result<Vec<MaasProvider>, String> {
    let mut registry = load_maas_registry()?;
    registry.retain(|p| p.key != key);
    persist_maas_registry(&registry)?;
    Ok(registry)
}

// ============================================================================
// Settings Field Update Commands
// ============================================================================

#[tauri::command]
fn update_settings_field(field: String, value: Value) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        serde_json::json!({})
    };

    if let Some(obj) = settings.as_object_mut() {
        obj.insert(field, value);
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_settings_permission_field(field: String, value: Value) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        serde_json::json!({})
    };

    if !settings.get("permissions").and_then(|v| v.as_object()).is_some() {
        settings["permissions"] = serde_json::json!({});
    }
    settings["permissions"][&field] = value;

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn add_permission_directory(path: String) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        serde_json::json!({})
    };

    if !settings.get("permissions").and_then(|v| v.as_object()).is_some() {
        settings["permissions"] = serde_json::json!({});
    }

    let dirs = settings["permissions"]
        .get("additionalDirectories")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let path_val = Value::String(path.clone());
    if !dirs.contains(&path_val) {
        let mut new_dirs = dirs;
        new_dirs.push(path_val);
        settings["permissions"]["additionalDirectories"] = Value::Array(new_dirs);
    }

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn remove_permission_directory(path: String) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        return Ok(());
    };

    if let Some(dirs) = settings["permissions"]
        .get_mut("additionalDirectories")
        .and_then(|v| v.as_array_mut())
    {
        dirs.retain(|v| v.as_str() != Some(&path));
    }

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn toggle_plugin(plugin_id: String, enabled: bool) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        serde_json::json!({})
    };

    if !settings.get("enabledPlugins").and_then(|v| v.as_object()).is_some() {
        settings["enabledPlugins"] = serde_json::json!({});
    }
    settings["enabledPlugins"][&plugin_id] = Value::Bool(enabled);

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// Extensions Management
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtensionMarketplace {
    pub id: String,
    pub name: String,
    pub repo: Option<String>,
    pub path: Option<String>,
    pub is_official: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MarketplacePlugin {
    pub name: String,
    pub description: Option<String>,
    pub path: String,
}

#[tauri::command]
fn list_installed_plugins() -> Result<Vec<InstalledPlugin>, String> {
    let settings_path = get_claude_dir().join("settings.json");

    if !settings_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    let settings: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let mut plugins = vec![];

    if let Some(enabled_plugins) = settings.get("enabledPlugins").and_then(|v| v.as_object()) {
        for (id, enabled) in enabled_plugins {
            let parts: Vec<&str> = id.split('@').collect();
            let (name, marketplace) = if parts.len() >= 2 {
                (parts[0].to_string(), parts[1..].join("@"))
            } else {
                (id.clone(), "unknown".to_string())
            };

            plugins.push(InstalledPlugin {
                id: id.clone(),
                name,
                marketplace,
                enabled: enabled.as_bool().unwrap_or(false),
            });
        }
    }

    Ok(plugins)
}

#[tauri::command]
fn list_extension_marketplaces() -> Result<Vec<ExtensionMarketplace>, String> {
    let settings_path = get_claude_dir().join("settings.json");

    let mut marketplaces = vec![
        ExtensionMarketplace {
            id: "claude-plugins-official".to_string(),
            name: "Claude Plugins Official".to_string(),
            repo: Some("anthropics/claude-code".to_string()),
            path: None,
            is_official: true,
        },
    ];

    if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        let settings: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

        if let Some(extra) = settings.get("extraKnownMarketplaces").and_then(|v| v.as_object()) {
            for (id, config) in extra {
                let repo = config
                    .get("source")
                    .and_then(|s| s.get("repo"))
                    .and_then(|r| r.as_str())
                    .map(|s| s.to_string());
                let path = config
                    .get("source")
                    .and_then(|s| s.get("path"))
                    .and_then(|p| p.as_str())
                    .map(|s| s.to_string());

                marketplaces.push(ExtensionMarketplace {
                    id: id.clone(),
                    name: id.clone(),
                    repo,
                    path,
                    is_official: false,
                });
            }
        }
    }

    Ok(marketplaces)
}

#[tauri::command]
async fn fetch_marketplace_plugins(owner: String, repo: String, plugins_path: Option<String>) -> Result<Vec<MarketplacePlugin>, String> {
    let path = plugins_path.unwrap_or_else(|| "plugins".to_string());
    let url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        owner, repo, path
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "lovcode")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API error: {}", response.status()));
    }

    let items: Vec<Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mut plugins = vec![];

    for item in items {
        if item.get("type").and_then(|t| t.as_str()) == Some("dir") {
            let name = item
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let path = item
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();

            if !name.is_empty() && !name.starts_with('.') {
                plugins.push(MarketplacePlugin {
                    name: name.clone(),
                    description: None,
                    path,
                });
            }
        }
    }

    Ok(plugins)
}

#[tauri::command]
async fn install_extension(plugin_id: String, marketplace: Option<String>) -> Result<String, String> {
    let full_id = if let Some(mkt) = marketplace {
        format!("{}@{}", plugin_id, mkt)
    } else {
        plugin_id
    };

    let command = format!("claude plugin install {}", shell_escape::escape(full_id.into()));
    let home = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string();

    exec_shell_command(command, home).await
}

#[tauri::command]
async fn uninstall_extension(plugin_id: String) -> Result<String, String> {
    let command = format!("claude plugin uninstall {}", shell_escape::escape(plugin_id.into()));
    let home = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string();

    exec_shell_command(command, home).await
}

#[tauri::command]
async fn add_extension_marketplace(source: String) -> Result<String, String> {
    let command = format!("claude plugin marketplace add {}", shell_escape::escape(source.into()));
    let home = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string();

    exec_shell_command(command, home).await
}

#[tauri::command]
async fn remove_extension_marketplace(name: String) -> Result<String, String> {
    let command = format!("claude plugin marketplace remove {}", shell_escape::escape(name.into()));
    let home = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string();

    exec_shell_command(command, home).await
}

// Disabled hooks storage path
fn get_disabled_hooks_path() -> std::path::PathBuf {
    get_lovstudio_dir().join("disabled_hooks.json")
}

fn load_disabled_hooks() -> Result<Value, String> {
    let path = get_disabled_hooks_path();
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())
    } else {
        Ok(serde_json::json!({}))
    }
}

fn save_disabled_hooks(disabled_hooks: &Value) -> Result<(), String> {
    let path = get_disabled_hooks_path();
    let output = serde_json::to_string_pretty(disabled_hooks).map_err(|e| e.to_string())?;
    fs::write(&path, output).map_err(|e| e.to_string())?;
    Ok(())
}

// Generate a unique key for a hook based on its content
fn get_hook_content_key(hook: &Value) -> String {
    // Use command or prompt as the key, with type prefix for uniqueness
    let hook_type = hook.get("type").and_then(|t| t.as_str()).unwrap_or("unknown");
    let content = hook
        .get("command")
        .or_else(|| hook.get("prompt"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    format!("{}:{}", hook_type, content)
}

#[tauri::command]
fn toggle_hook_item(
    event_type: String,
    matcher_index: usize,
    hook_index: usize,
    disabled: bool,
) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        return Err("No settings.json found".to_string());
    };

    let mut disabled_hooks = load_disabled_hooks()?;

    if disabled {
        // Disable: Remove from settings.json and backup to disabled_hooks.json
        // First get matcher info (immutable borrow)
        let matcher = settings
            .get("hooks")
            .and_then(|h| h.get(&event_type))
            .and_then(|arr| arr.get(matcher_index))
            .and_then(|m| m.get("matcher"))
            .cloned()
            .unwrap_or(Value::String("".to_string()));

        // Then get mutable borrow
        let hooks_arr = settings
            .get_mut("hooks")
            .and_then(|h| h.get_mut(&event_type))
            .and_then(|arr| arr.get_mut(matcher_index))
            .and_then(|m| m.get_mut("hooks"))
            .and_then(|hooks| hooks.as_array_mut())
            .ok_or("Hook not found")?;

        if hook_index >= hooks_arr.len() {
            return Err("Hook index out of bounds".to_string());
        }

        // Backup the hook before removing
        let removed_hook = hooks_arr.remove(hook_index);
        let hook_key = get_hook_content_key(&removed_hook);

        // Store in disabled_hooks with context for restoration
        if !disabled_hooks.get(&event_type).is_some() {
            disabled_hooks[&event_type] = serde_json::json!([]);
        }

        // Store as array to preserve order and allow multiple disabled hooks
        if let Some(arr) = disabled_hooks[&event_type].as_array_mut() {
            arr.push(serde_json::json!({
                "matcher": matcher,
                "hook": removed_hook,
                "key": hook_key
            }));
        }

        save_disabled_hooks(&disabled_hooks)?;
    } else {
        // Enable: Restore from disabled_hooks.json to settings.json
        // First, get the hook to restore based on index in disabled list
        let hooks_arr = settings
            .get_mut("hooks")
            .and_then(|h| h.get_mut(&event_type))
            .and_then(|arr| arr.get_mut(matcher_index))
            .and_then(|m| m.get_mut("hooks"))
            .and_then(|hooks| hooks.as_array_mut())
            .ok_or("Hook location not found")?;

        // Get the hook_index-th item from disabled hooks for this event type
        let disabled_arr = disabled_hooks
            .get_mut(&event_type)
            .and_then(|v| v.as_array_mut())
            .ok_or("No disabled hooks for this event type")?;

        if hook_index >= disabled_arr.len() {
            return Err("Disabled hook index out of bounds".to_string());
        }

        let backup = disabled_arr.remove(hook_index);
        let hook_data = backup.get("hook").ok_or("Invalid backup data")?.clone();

        // Insert at the end of the active hooks
        hooks_arr.push(hook_data);

        save_disabled_hooks(&disabled_hooks)?;
    }

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_disabled_hooks() -> Result<Value, String> {
    load_disabled_hooks()
}

#[tauri::command]
fn delete_hook_item(
    event_type: String,
    matcher_index: usize,
    hook_index: usize,
) -> Result<(), String> {
    let settings_path = get_claude_dir().join("settings.json");
    let mut settings: Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        return Err("No settings.json found".to_string());
    };

    let hooks_arr = settings
        .get_mut("hooks")
        .and_then(|h| h.get_mut(&event_type))
        .and_then(|arr| arr.get_mut(matcher_index))
        .and_then(|m| m.get_mut("hooks"))
        .and_then(|hooks| hooks.as_array_mut())
        .ok_or("Hook not found")?;

    if hook_index >= hooks_arr.len() {
        return Err("Hook index out of bounds".to_string());
    }

    // Permanently remove without backup
    hooks_arr.remove(hook_index);

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("_lovcode_disabled_env");
    }

    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, output).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_disabled_hook(event_type: String, index: usize) -> Result<(), String> {
    let mut disabled_hooks = load_disabled_hooks()?;

    let disabled_arr = disabled_hooks
        .get_mut(&event_type)
        .and_then(|v| v.as_array_mut())
        .ok_or("No disabled hooks for this event type")?;

    if index >= disabled_arr.len() {
        return Err("Index out of bounds".to_string());
    }

    // Permanently remove from disabled list
    disabled_arr.remove(index);
    save_disabled_hooks(&disabled_hooks)?;
    Ok(())
}

#[derive(Serialize)]
struct ConnectionTestResult {
    ok: bool,
    status: u16,
    body: String,
}

#[tauri::command]
async fn test_anthropic_connection(
    base_url: String,
    auth_token: String,
    model: String,
) -> Result<ConnectionTestResult, String> {
    if auth_token.trim().is_empty() {
        return Err("ANTHROPIC_AUTH_TOKEN is empty".to_string());
    }

    let base = base_url.trim_end_matches('/');
    let url = format!("{}/v1/messages", base);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let payload = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [
            { "role": "user", "content": "ping" }
        ]
    });

    println!("anthropic test request url={}", url);
    println!("anthropic test request headers x-api-key={} anthropic-version=2023-06-01 content-type=application/json", auth_token);
    println!("anthropic test request body={}", payload);

    let response = client
        .post(&url)
        .header("x-api-key", auth_token)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    println!("anthropic test status={} body={}", status, body);

    Ok(ConnectionTestResult {
        ok: status.is_success(),
        status: status.as_u16(),
        body,
    })
}

#[tauri::command]
async fn test_openai_connection(
    base_url: String,
    api_key: String,
) -> Result<ConnectionTestResult, String> {
    if api_key.trim().is_empty() {
        return Err("API key is empty".to_string());
    }

    let base = base_url.trim_end_matches('/');
    let url = format!("{}/models", base);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    Ok(ConnectionTestResult {
        ok: status.is_success(),
        status: status.as_u16(),
        body,
    })
}

#[derive(Serialize)]
struct ClaudeCliTestResult {
    ok: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

#[tauri::command]
async fn test_claude_cli(
    base_url: String,
    auth_token: String,
) -> Result<ClaudeCliTestResult, String> {
    if auth_token.trim().is_empty() {
        return Err("ANTHROPIC_AUTH_TOKEN is empty".to_string());
    }

    let output = tokio::process::Command::new("claude")
        .arg("--print")
        .arg("reply 1")
        .env("ANTHROPIC_BASE_URL", &base_url)
        .env("ANTHROPIC_AUTH_TOKEN", &auth_token)
        .output()
        .await
        .map_err(|e| format!("Failed to execute claude CLI: {}", e))?;

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    println!("claude cli test code={} stdout={} stderr={}", code, stdout, stderr);

    Ok(ClaudeCliTestResult {
        ok: output.status.success(),
        code,
        stdout,
        stderr,
    })
}

// ============================================================================
// Claude Code Version Management
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ClaudeCodeInstallType {
    Native,
    Npm,
    None,
}

#[derive(Debug, Serialize)]
struct VersionWithDownloads {
    version: String,
    downloads: u64,
}

#[derive(Debug, Serialize)]
struct ClaudeCodeVersionInfo {
    install_type: ClaudeCodeInstallType,
    current_version: Option<String>,
    available_versions: Vec<VersionWithDownloads>,
    autoupdater_disabled: bool,
}

/// Run a command in user's interactive login shell (to get proper PATH with nvm, etc.)
fn run_shell_command(cmd: &str) -> std::io::Result<std::process::Output> {
    #[cfg(windows)]
    {
        // On Windows, use PowerShell to run commands (better PATH handling than cmd.exe)
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", cmd])
            .output()
    }

    #[cfg(not(windows))]
    {
        // Use user's default shell from $SHELL, fallback to /bin/zsh (macOS default)
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        std::process::Command::new(&shell)
            .args(["-ilc", cmd]) // -i for interactive (loads .zshrc), -l for login, -c for command
            .output()
    }
}

/// Detect Claude Code installation type
/// Prioritizes native install (~/.local/bin/claude) over npm when both exist
fn detect_claude_code_install_type() -> (ClaudeCodeInstallType, Option<String>) {
    // Helper to get version from a specific claude binary path
    let get_version = |path: &str| -> Option<String> {
        if let Ok(output) = std::process::Command::new(path).arg("--version").output() {
            if output.status.success() {
                let version_str = String::from_utf8_lossy(&output.stdout);
                return version_str
                    .trim()
                    .split_whitespace()
                    .next()
                    .map(|s| s.to_string());
            }
        }
        None
    };

    // Check native install first (preferred) - ~/.local/bin/claude
    let native_path = dirs::home_dir()
        .map(|h| h.join(".local/bin/claude"))
        .filter(|p| p.exists());

    if let Some(ref path) = native_path {
        if let Some(version) = get_version(path.to_str().unwrap_or("")) {
            return (ClaudeCodeInstallType::Native, Some(version));
        }
    }

    // Check npm install via `which claude` in user's shell
    if let Ok(which_output) = run_shell_command("which claude 2>/dev/null") {
        if which_output.status.success() {
            let claude_path = String::from_utf8_lossy(&which_output.stdout);
            let claude_path = claude_path.trim();

            // Skip if it's the native path we already checked
            if !claude_path.contains(".local/bin/claude") && !claude_path.is_empty() {
                if let Some(version) = get_version(claude_path) {
                    return (ClaudeCodeInstallType::Npm, Some(version));
                }
            }
        }
    }

    (ClaudeCodeInstallType::None, None)
}

#[tauri::command]
async fn get_claude_code_version_info() -> Result<ClaudeCodeVersionInfo, String> {
    // Detect installation type and current version
    let (install_type, current_version) = tauri::async_runtime::spawn_blocking(detect_claude_code_install_type)
        .await
        .map_err(|e| e.to_string())?;

    // Fetch available versions from npm registry API (no local npm needed)
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    // Get versions list from npm registry
    let versions: Vec<String> = match client
        .get("https://registry.npmjs.org/@anthropic-ai/claude-code")
        .send()
        .await
    {
        Ok(resp) => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|json| {
                json.get("versions")?.as_object().map(|obj| {
                    let mut versions: Vec<String> = obj.keys().cloned().collect();
                    // Sort by semver (simple string sort works for most cases)
                    versions.sort_by(|a, b| {
                        let parse = |s: &str| -> Vec<u32> {
                            s.split('.').filter_map(|p| p.parse().ok()).collect()
                        };
                        parse(b).cmp(&parse(a))
                    });
                    versions.into_iter().take(20).collect()
                })
            })
            .unwrap_or_default(),
        Err(_) => vec![],
    };

    // Fetch download counts from npm API
    let downloads_map: std::collections::HashMap<String, u64> = match client
        .get("https://api.npmjs.org/versions/@anthropic-ai%2Fclaude-code/last-week")
        .send()
        .await
    {
        Ok(resp) => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|json| {
                json.get("downloads")?.as_object().map(|obj| {
                    obj.iter()
                        .filter_map(|(k, v)| Some((k.clone(), v.as_u64()?)))
                        .collect()
                })
            })
            .unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    };

    // Combine versions with download counts
    let available_versions: Vec<VersionWithDownloads> = versions
        .into_iter()
        .map(|v| {
            let downloads = downloads_map.get(&v).copied().unwrap_or(0);
            VersionWithDownloads { version: v, downloads }
        })
        .collect();

    // Check autoupdater setting from Claude Code's config (~/.claude.json)
    let config_path = dirs::home_dir().unwrap().join(".claude.json");
    let autoupdater_disabled = fs::read_to_string(&config_path)
        .ok()
        .and_then(|content| {
            let json: serde_json::Value = serde_json::from_str(&content).ok()?;
            // autoUpdates: false means autoupdater is disabled
            json.get("autoUpdates")?.as_bool().map(|v| !v)
        })
        .unwrap_or(false);

    Ok(ClaudeCodeVersionInfo {
        install_type,
        current_version,
        available_versions,
        autoupdater_disabled,
    })
}

#[tauri::command]
async fn install_claude_code_version(
    app: tauri::AppHandle,
    version: String,
    install_type: Option<String>,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let is_specific_version = version != "latest";
    let install_type_str = install_type.unwrap_or_else(|| "native".to_string());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let cmd = if install_type_str == "npm" {
            // Remove native binary if exists (so detection shows npm after install)
            if let Some(home) = dirs::home_dir() {
                let native_bin = home.join(".local/bin/claude");
                if native_bin.exists() {
                    let _ = app.emit("cc-install-progress", "Removing native install...");
                    let _ = std::fs::remove_file(&native_bin);
                }
            }

            let package = if version == "latest" {
                "@anthropic-ai/claude-code@latest".to_string()
            } else {
                format!("@anthropic-ai/claude-code@{}", version)
            };
            format!("npm install -g --force {}", package)
        } else {
            // Clean up stale downloads that may cause "another process installing" error
            if let Some(home) = dirs::home_dir() {
                let downloads_dir = home.join(".claude/downloads");
                if downloads_dir.exists() {
                    let _ = app.emit("cc-install-progress", "Cleaning up stale downloads...");
                    let _ = std::fs::remove_dir_all(&downloads_dir);
                }
            }

            let version_arg = if version == "latest" { "".to_string() } else { version };
            let display_version = if version_arg.is_empty() { "latest" } else { &version_arg };
            let _ = app.emit("cc-install-progress", format!("Installing Claude Code {}...", display_version));

            // Download script, patch to show progress bar for binary download, then run
            // Change 'curl -fsSL -o' to 'curl -fL --progress-bar -o' for visible download progress
            format!(
                r#"echo "Downloading install script..." && curl -fsSL https://claude.ai/install.sh | sed 's/"$binary_path" install/"$binary_path" install --force/' | sed 's/curl -fsSL -o/curl -fL --progress-bar -o/g' > /tmp/cc-install.sh && echo "Downloading Claude Code (~170MB)..." && CI=1 bash /tmp/cc-install.sh {} </dev/null && echo "Done!" || echo "Installation failed"; rm -f /tmp/cc-install.sh"#,
                version_arg
            )
        };

        // Use appropriate shell based on platform
        println!("[DEBUG] cmd={}", cmd);

        #[cfg(windows)]
        let mut child = {
            // On Windows, use PowerShell for npm commands
            // Native install is not supported on Windows (uses Unix-specific tools)
            if install_type_str != "npm" {
                return Err("Native install is only supported on macOS/Linux. Please use npm install on Windows.".to_string());
            }
            Command::new("powershell")
                .args(["-NoProfile", "-Command", &cmd])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to spawn: {}", e))?
        };

        #[cfg(not(windows))]
        let mut child = Command::new("/bin/bash")
            .args(["-c", &cmd])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn: {}", e))?;

        // Store PID for cancellation support
        CC_INSTALL_PID.store(child.id(), std::sync::atomic::Ordering::SeqCst);
        println!("[DEBUG] Child spawned, pid={}", child.id());

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Read stdout in a thread - use byte reading to capture progress bar updates
        let app_clone = app.clone();
        let stdout_handle = std::thread::spawn(move || {
            use std::io::Read;
            let mut output = String::new();
            if let Some(mut out) = stdout {
                let mut buf = [0u8; 1024];
                let mut current_line = String::new();

                while let Ok(n) = out.read(&mut buf) {
                    if n == 0 { break; }

                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    for ch in chunk.chars() {
                        if ch == '\n' {
                            // Complete line - emit if not debug
                            if !current_line.starts_with("[DEBUG]") && !current_line.is_empty() {
                                let _ = app_clone.emit("cc-install-progress", &current_line);
                            }
                            output.push_str(&current_line);
                            output.push('\n');
                            current_line.clear();
                        } else if ch == '\r' {
                            // Carriage return - emit current content as progress update
                            if !current_line.is_empty() {
                                let _ = app_clone.emit("cc-install-progress", format!("\r{}", &current_line));
                            }
                            current_line.clear();
                        } else {
                            current_line.push(ch);
                        }
                    }
                }
                // Emit any remaining content
                if !current_line.is_empty() && !current_line.starts_with("[DEBUG]") {
                    let _ = app_clone.emit("cc-install-progress", &current_line);
                    output.push_str(&current_line);
                }
            }
            output
        });

        // Read stderr in a thread - curl progress bar goes to stderr
        let app_clone2 = app.clone();
        let stderr_handle = std::thread::spawn(move || {
            use std::io::Read;
            let mut output = String::new();
            if let Some(mut err) = stderr {
                let mut buf = [0u8; 1024];
                let mut current_line = String::new();

                while let Ok(n) = err.read(&mut buf) {
                    if n == 0 { break; }

                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    output.push_str(&chunk);

                    for ch in chunk.chars() {
                        if ch == '\n' || ch == '\r' {
                            if !current_line.is_empty() {
                                // Check if this looks like progress (contains % or is mostly # symbols)
                                let is_progress = current_line.contains('%') ||
                                    current_line.chars().filter(|c| *c == '#').count() > 2;

                                if is_progress {
                                    // Progress update - use \r prefix to replace last line
                                    let _ = app_clone2.emit("cc-install-progress", format!("\r{}", &current_line));
                                } else {
                                    // Real error - prefix with [error]
                                    let _ = app_clone2.emit("cc-install-progress", format!("[error] {}", &current_line));
                                }
                            }
                            current_line.clear();
                        } else {
                            current_line.push(ch);
                        }
                    }
                }
                // Emit any remaining content
                if !current_line.is_empty() {
                    let _ = app_clone2.emit("cc-install-progress", format!("[error] {}", &current_line));
                }
            }
            output
        });

        let stdout_output = stdout_handle.join().unwrap_or_default();
        let stderr_output = stderr_handle.join().unwrap_or_default();

        let status = child.wait().map_err(|e| format!("Failed to wait: {}", e))?;

        // Clear PID after process ends
        CC_INSTALL_PID.store(0, std::sync::atomic::Ordering::SeqCst);

        if status.success() {
            Ok(stdout_output)
        } else {
            Err(stderr_output)
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    if is_specific_version {
        let _ = set_claude_code_autoupdater(true);
    }

    Ok(result)
}

#[tauri::command]
fn cancel_claude_code_install() -> Result<(), String> {
    let pid = CC_INSTALL_PID.load(std::sync::atomic::Ordering::SeqCst);
    if pid == 0 {
        return Err("No install process running".to_string());
    }

    #[cfg(unix)]
    {
        // Use pkill to kill child processes first (curl, bash, etc.)
        let _ = std::process::Command::new("pkill")
            .args(["-9", "-P", &pid.to_string()])
            .output();

        // Kill the main process with SIGKILL
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    {
        // On Windows, use taskkill to kill the process tree
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output();
    }

    CC_INSTALL_PID.store(0, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn set_claude_code_autoupdater(disabled: bool) -> Result<(), String> {
    let config_path = dirs::home_dir()
        .ok_or("Could not determine home directory")?
        .join(".claude.json");

    // Read existing config or create empty object
    let mut config: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Set autoUpdates (false = disabled, true = enabled)
    config["autoUpdates"] = serde_json::Value::Bool(!disabled);

    // Write back
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&config_path, content).map_err(|e| e.to_string())?;

    Ok(())
}

// ============================================================================
// PTY Terminal Commands
// ============================================================================

#[tauri::command]
fn pty_create(
    id: String,
    cwd: String,
    shell: Option<String>,
    command: Option<String>,
) -> Result<String, String> {
    pty_manager::create_session(id.clone(), cwd, shell, command)?;
    Ok(id)
}

#[tauri::command]
fn pty_write(id: String, data: Vec<u8>) -> Result<(), String> {
    pty_manager::write_to_session(&id, &data)
}

#[tauri::command]
#[allow(deprecated)]
fn pty_read(id: String) -> Result<Vec<u8>, String> {
    // Legacy - data now comes via pty-data events
    pty_manager::read_from_session(&id)
}

#[tauri::command]
fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    pty_manager::resize_session(&id, cols, rows)
}

#[tauri::command]
fn pty_kill(id: String) -> Result<(), String> {
    pty_manager::kill_session(&id)
}

#[tauri::command]
fn pty_list() -> Vec<String> {
    pty_manager::list_sessions()
}

#[tauri::command]
fn pty_exists(id: String) -> bool {
    pty_manager::session_exists(&id)
}

#[tauri::command]
fn pty_scrollback(id: String) -> Vec<u8> {
    pty_manager::get_scrollback(&id)
}

#[tauri::command]
fn pty_purge_scrollback(id: String) {
    pty_manager::purge_scrollback(&id)
}

#[tauri::command]
fn pty_flush_scrollback() {
    pty_manager::flush_all_scrollback()
}

// ============================================================================
// Workspace Commands
// ============================================================================

#[tauri::command]
fn workspace_load() -> Result<workspace_store::WorkspaceData, String> {
    workspace_store::load_workspace()
}

#[tauri::command]
fn workspace_save(data: workspace_store::WorkspaceData) -> Result<(), String> {
    workspace_store::save_workspace(&data)
}

#[tauri::command]
fn workspace_add_project(path: String) -> Result<workspace_store::WorkspaceProject, String> {
    workspace_store::add_project(path)
}

#[tauri::command]
fn workspace_list_projects() -> Result<Vec<workspace_store::WorkspaceProject>, String> {
    workspace_store::load_workspace().map(|d| d.projects)
}

#[tauri::command]
fn workspace_remove_project(id: String) -> Result<(), String> {
    workspace_store::remove_project(&id)
}

#[tauri::command]
fn workspace_set_active_project(id: String) -> Result<(), String> {
    workspace_store::set_active_project(&id)
}

#[tauri::command]
fn workspace_create_feature(project_id: String, name: String, description: Option<String>) -> Result<workspace_store::Feature, String> {
    workspace_store::create_feature(&project_id, name, description)
}

#[tauri::command]
fn workspace_rename_feature(feature_id: String, name: String) -> Result<(), String> {
    workspace_store::rename_feature(&feature_id, name)
}

#[tauri::command]
fn workspace_update_feature_status(
    project_id: String,
    feature_id: String,
    status: workspace_store::FeatureStatus,
) -> Result<(), String> {
    workspace_store::update_feature_status(&project_id, &feature_id, status)
}

#[tauri::command]
fn workspace_delete_feature(project_id: String, feature_id: String) -> Result<(), String> {
    workspace_store::delete_feature(&project_id, &feature_id)
}

#[tauri::command]
fn workspace_set_active_feature(project_id: String, feature_id: String) -> Result<(), String> {
    workspace_store::set_active_feature(&project_id, &feature_id)
}

#[tauri::command]
fn workspace_add_panel(
    project_id: String,
    feature_id: String,
    panel: workspace_store::PanelState,
) -> Result<(), String> {
    workspace_store::add_panel_to_feature(&project_id, &feature_id, panel)
}

#[tauri::command]
fn workspace_remove_panel(project_id: String, feature_id: String, panel_id: String) -> Result<(), String> {
    workspace_store::remove_panel_from_feature(&project_id, &feature_id, &panel_id)
}

#[tauri::command]
fn workspace_toggle_panel_shared(project_id: String, panel_id: String) -> Result<bool, String> {
    workspace_store::toggle_panel_shared(&project_id, &panel_id)
}

#[tauri::command]
fn workspace_get_pending_reviews() -> Result<Vec<(String, String, String)>, String> {
    workspace_store::get_pending_reviews()
}

// ============================================================================
// Hook Watcher Commands
// ============================================================================

#[tauri::command]
fn hook_start_monitoring(project_id: String, feature_id: String) {
    hook_watcher::start_monitoring(&project_id, &feature_id);
}

#[tauri::command]
fn hook_stop_monitoring(project_id: String, feature_id: String) {
    hook_watcher::stop_monitoring(&project_id, &feature_id);
}

#[tauri::command]
fn hook_is_monitoring(project_id: String, feature_id: String) -> bool {
    hook_watcher::is_monitoring(&project_id, &feature_id)
}

#[tauri::command]
fn hook_get_monitored() -> Vec<String> {
    hook_watcher::get_monitored_features()
}

#[tauri::command]
fn hook_notify_complete(app_handle: tauri::AppHandle, project_id: String, feature_id: String, feature_name: String) {
    hook_watcher::notify_feature_complete(&app_handle, &project_id, &feature_id, &feature_name);
}

// ============================================================================
// Project Logo
// ============================================================================

/// Find project logo from common locations and return as base64 data URL
#[tauri::command]
fn get_project_logo(project_path: String) -> Option<String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let logo_paths = [
        "assets/logo.svg",
        "assets/logo.png",
        "assets/icon.svg",
        "assets/icon.png",
        "public/logo.svg",
        "public/logo.png",
        "logo.svg",
        "logo.png",
        "icon.svg",
        "icon.png",
    ];

    let project = PathBuf::from(&project_path);

    for rel_path in logo_paths {
        let full_path = project.join(rel_path);
        if full_path.exists() {
            if let Ok(data) = fs::read(&full_path) {
                let mime = if rel_path.ends_with(".svg") {
                    "image/svg+xml"
                } else if rel_path.ends_with(".png") {
                    "image/png"
                } else {
                    "application/octet-stream"
                };
                let b64 = STANDARD.encode(&data);
                return Some(format!("data:{};base64,{}", mime, b64));
            }
        }
    }

    None
}

/// List all logo versions in project assets directory
#[tauri::command]
fn list_project_logos(project_path: String) -> Vec<LogoVersion> {
    let project = PathBuf::from(&project_path);
    let assets_dir = project.join("assets");

    let mut versions = Vec::new();

    // Get current logo path for comparison
    let current_logo = get_current_logo_path(&project);

    // Scan assets directory for logo files
    if let Ok(entries) = fs::read_dir(&assets_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                // Match logo-*.png, logo.png, logo.svg patterns
                if (filename.starts_with("logo") || filename.starts_with("icon"))
                   && (filename.ends_with(".png") || filename.ends_with(".svg") || filename.ends_with(".jpg"))
                {
                    let created_at = entry.metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);

                    let path_str = path.to_string_lossy().to_string();
                    let is_current = current_logo.as_ref().map(|c| c == &path_str).unwrap_or(false);

                    versions.push(LogoVersion {
                        path: path_str,
                        filename: filename.to_string(),
                        created_at,
                        is_current,
                    });
                }
            }
        }
    }

    // Sort by created_at descending (newest first)
    versions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    versions
}

#[derive(Debug, Clone, serde::Serialize)]
struct LogoVersion {
    path: String,
    filename: String,
    created_at: u64,
    is_current: bool,
}

/// Helper to get current logo path
fn get_current_logo_path(project: &PathBuf) -> Option<String> {
    let logo_paths = [
        "assets/logo.svg",
        "assets/logo.png",
        "assets/icon.svg",
        "assets/icon.png",
    ];

    for rel_path in logo_paths {
        let full_path = project.join(rel_path);
        if full_path.exists() {
            return Some(full_path.to_string_lossy().to_string());
        }
    }
    None
}

/// Save base64 logo data to project assets
#[tauri::command]
fn save_project_logo(project_path: String, base64_data: String, filename: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let project = PathBuf::from(&project_path);
    let assets_dir = project.join("assets");

    // Ensure assets directory exists
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets directory: {}", e))?;

    // Decode base64
    let data = STANDARD.decode(&base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    // Save versioned file
    let versioned_path = assets_dir.join(&filename);
    fs::write(&versioned_path, &data)
        .map_err(|e| format!("Failed to write logo: {}", e))?;

    // Also save as logo.png (current)
    let ext = filename.rsplit('.').next().unwrap_or("png");
    let current_path = assets_dir.join(format!("logo.{}", ext));
    fs::write(&current_path, &data)
        .map_err(|e| format!("Failed to write current logo: {}", e))?;

    Ok(versioned_path.to_string_lossy().to_string())
}

/// Copy external file to project assets as logo
#[tauri::command]
fn copy_file_to_project_assets(source_path: String, project_path: String, target_filename: String) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    let project = PathBuf::from(&project_path);
    let assets_dir = project.join("assets");

    // Ensure assets directory exists
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets directory: {}", e))?;

    // Copy to target filename
    let target_path = assets_dir.join(&target_filename);
    fs::copy(&source, &target_path)
        .map_err(|e| format!("Failed to copy file: {}", e))?;

    Ok(target_path.to_string_lossy().to_string())
}

/// Set a specific logo version as current
#[tauri::command]
fn set_current_project_logo(project_path: String, logo_path: String) -> Result<(), String> {
    let project = PathBuf::from(&project_path);
    let assets_dir = project.join("assets");
    let source = PathBuf::from(&logo_path);

    if !source.exists() {
        return Err("Logo file does not exist".to_string());
    }

    let ext = source.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");

    // Copy as current logo
    let current_path = assets_dir.join(format!("logo.{}", ext));
    fs::copy(&source, &current_path)
        .map_err(|e| format!("Failed to set current logo: {}", e))?;

    Ok(())
}

/// Delete a logo version
#[tauri::command]
fn delete_project_logo(project_path: String, logo_path: String) -> Result<(), String> {
    let path = PathBuf::from(&logo_path);

    if !path.exists() {
        return Ok(());
    }

    // Don't allow deleting the current logo (logo.png/logo.svg)
    if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
        if filename == "logo.png" || filename == "logo.svg" {
            return Err("Cannot delete current logo. Set another version as current first.".to_string());
        }
    }

    fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete logo: {}", e))?;

    Ok(())
}

/// Read file as base64
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(format!("File does not exist: {}", path));
    }

    let data = fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    Ok(STANDARD.encode(&data))
}

/// Run a shell command in specified directory using login shell (async, non-blocking)
#[tauri::command]
async fn exec_shell_command(command: String, cwd: String) -> Result<String, String> {
    use tokio::process::Command;

    #[cfg(windows)]
    let output = {
        // On Windows, use PowerShell with -WorkingDirectory
        Command::new("powershell")
            .args(["-NoProfile", "-Command", &format!("Set-Location '{}'; {}", cwd, command)])
            .output()
            .await
            .map_err(|e| format!("Failed to run command: {}", e))?
    };

    #[cfg(not(windows))]
    let output = {
        // Use user's default shell with login mode to get proper environment (API keys, etc.)
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        Command::new(&shell)
            .args(["-ilc", &format!("cd '{}' && {}", cwd, command)])
            .output()
            .await
            .map_err(|e| format!("Failed to run command: {}", e))?
    };

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

// ============================================================================
// Directory Listing
// ============================================================================

#[derive(Debug, Clone, serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Get file metadata (size, modified time)
#[tauri::command]
fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(format!("File does not exist: {}", path));
    }

    let metadata = fs::metadata(&file_path)
        .map_err(|e| format!("Failed to get metadata: {}", e))?;

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    Ok(FileMetadata {
        size: metadata.len(),
        modified,
    })
}

#[derive(serde::Serialize)]
struct FileMetadata {
    size: u64,
    modified: Option<u64>,
}

/// Read file contents
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(format!("File does not exist: {}", path));
    }

    if !file_path.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))
}

/// List directory contents (non-recursive, respects .gitignore patterns)
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let dir_path = PathBuf::from(&path);

    if !dir_path.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    // Common patterns to ignore
    let ignore_patterns = [
        ".git", "node_modules", ".DS_Store", "target", "dist", "build",
        ".next", ".nuxt", ".output", "__pycache__", ".pytest_cache",
        ".venv", "venv", ".idea", ".vscode", "*.pyc", ".turbo",
    ];

    let mut entries: Vec<DirEntry> = Vec::new();

    let read_dir = fs::read_dir(&dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip ignored patterns
        if ignore_patterns.iter().any(|p| {
            if p.starts_with("*.") {
                name.ends_with(&p[1..])
            } else {
                name == *p
            }
        }) {
            continue;
        }

        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
        });
    }

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

// ============================================================================
// Git Commands
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub timestamp: i64,
    pub author: String,
    pub feat_name: Option<String>, // Parsed from message: feat(xxx): ...
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommitNote {
    pub feat_id: String,
    pub feat_name: Option<String>,
    #[serde(default)]
    pub override_assoc: bool,
}

/// Parse feat name from conventional commit message
/// e.g., "feat(auth-login): add login" -> Some("auth-login")
fn parse_feat_from_message(message: &str) -> Option<String> {
    // Match patterns like: type(scope): message
    let re = regex::Regex::new(r"^\w+\(([a-z0-9-]+)\):").ok()?;
    re.captures(message).and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
}

/// Get git log for a project
#[tauri::command]
fn git_log(project_path: String, limit: Option<usize>) -> Result<Vec<CommitInfo>, String> {
    use std::process::Command;

    let limit = limit.unwrap_or(100);
    let output = Command::new("git")
        .args([
            "-C", &project_path,
            "log",
            &format!("-{}", limit),
            "--format=%H|%h|%s|%at|%an",
        ])
        .output()
        .map_err(|e| format!("Failed to run git log: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git log failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let commits: Vec<CommitInfo> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(5, '|').collect();
            let message = parts.get(2).unwrap_or(&"").to_string();
            let feat_name = parse_feat_from_message(&message);

            CommitInfo {
                hash: parts.first().unwrap_or(&"").to_string(),
                short_hash: parts.get(1).unwrap_or(&"").to_string(),
                message,
                timestamp: parts.get(3).unwrap_or(&"0").parse().unwrap_or(0),
                author: parts.get(4).unwrap_or(&"").to_string(),
                feat_name,
            }
        })
        .collect();

    Ok(commits)
}

/// Get git note for a commit
#[tauri::command]
fn git_get_note(project_path: String, commit_hash: String) -> Result<Option<CommitNote>, String> {
    use std::process::Command;

    let output = Command::new("git")
        .args([
            "-C", &project_path,
            "notes",
            "--ref=lovcode",
            "show",
            &commit_hash,
        ])
        .output()
        .map_err(|e| format!("Failed to run git notes: {}", e))?;

    if !output.status.success() {
        // Note doesn't exist
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let note: CommitNote = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse note: {}", e))?;

    Ok(Some(note))
}

/// Set git note for a commit
#[tauri::command]
fn git_set_note(project_path: String, commit_hash: String, note: CommitNote) -> Result<(), String> {
    use std::process::Command;

    let note_json = serde_json::to_string(&note)
        .map_err(|e| format!("Failed to serialize note: {}", e))?;

    // Try to add note first, if it exists, use --force to overwrite
    let output = Command::new("git")
        .args([
            "-C", &project_path,
            "notes",
            "--ref=lovcode",
            "add",
            "-f",
            "-m", &note_json,
            &commit_hash,
        ])
        .output()
        .map_err(|e| format!("Failed to run git notes add: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git notes add failed: {}", stderr));
    }

    Ok(())
}

/// Revert a commit
#[tauri::command]
fn git_revert(project_path: String, commit_hash: String) -> Result<String, String> {
    use std::process::Command;

    let output = Command::new("git")
        .args([
            "-C", &project_path,
            "revert",
            "--no-edit",
            &commit_hash,
        ])
        .output()
        .map_err(|e| format!("Failed to run git revert: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git revert failed: {}", stderr));
    }

    // Get the new commit hash
    let new_commit = Command::new("git")
        .args(["-C", &project_path, "rev-parse", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get new commit: {}", e))?;

    let new_hash = String::from_utf8_lossy(&new_commit.stdout).trim().to_string();
    Ok(new_hash)
}

/// Check if there are uncommitted changes
#[tauri::command]
fn git_has_changes(project_path: String) -> Result<bool, String> {
    use std::process::Command;

    let output = Command::new("git")
        .args(["-C", &project_path, "status", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(!stdout.trim().is_empty())
}

/// Auto commit with feat name
#[tauri::command]
fn git_auto_commit(project_path: String, feat_name: String, feat_id: String, message: String) -> Result<Option<String>, String> {
    use std::process::Command;

    // Check if there are changes
    let has_changes = git_has_changes(project_path.clone())?;
    if !has_changes {
        return Ok(None); // No changes, skip
    }

    // Stage all changes
    let add_output = Command::new("git")
        .args(["-C", &project_path, "add", "-A"])
        .output()
        .map_err(|e| format!("Failed to run git add: {}", e))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("git add failed: {}", stderr));
    }

    // Create commit
    let commit_message = format!("feat({}): {}", feat_name, message);
    let commit_output = Command::new("git")
        .args(["-C", &project_path, "commit", "-m", &commit_message])
        .output()
        .map_err(|e| format!("Failed to run git commit: {}", e))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        return Err(format!("git commit failed: {}", stderr));
    }

    // Get commit hash
    let hash_output = Command::new("git")
        .args(["-C", &project_path, "rev-parse", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get commit hash: {}", e))?;

    let hash = String::from_utf8_lossy(&hash_output.stdout).trim().to_string();

    // Add note with feat association
    let note = CommitNote {
        feat_id,
        feat_name: Some(feat_name),
        override_assoc: false,
    };
    git_set_note(project_path, hash.clone(), note)?;

    Ok(Some(hash))
}

/// Generate changelog from commits
#[tauri::command]
fn git_generate_changelog(
    project_path: String,
    feat_names: Vec<String>,
    from_date: Option<i64>,
) -> Result<String, String> {
    let commits = git_log(project_path.clone(), Some(500))?;

    // Filter commits by feat names and date
    let filtered: Vec<&CommitInfo> = commits
        .iter()
        .filter(|c| {
            let feat_match = c.feat_name.as_ref()
                .map(|f| feat_names.contains(f))
                .unwrap_or(false);
            let date_match = from_date.map(|d| c.timestamp >= d).unwrap_or(true);
            feat_match && date_match
        })
        .collect();

    // Group by feat
    let mut grouped: HashMap<String, Vec<&CommitInfo>> = HashMap::new();
    for commit in filtered {
        if let Some(feat) = &commit.feat_name {
            grouped.entry(feat.clone()).or_default().push(commit);
        }
    }

    // Generate markdown
    let mut md = String::from("# Changelog\n\n");

    for feat_name in &feat_names {
        if let Some(commits) = grouped.get(feat_name) {
            md.push_str(&format!("## {}\n\n", feat_name));
            for c in commits {
                let date = chrono::DateTime::from_timestamp(c.timestamp, 0)
                    .map(|dt| dt.format("%Y-%m-%d").to_string())
                    .unwrap_or_default();
                md.push_str(&format!("- {} ({}) - {}\n", c.message, c.short_hash, date));
            }
            md.push('\n');
        }
    }

    Ok(md)
}

// ============================================================================
// Diagnostics Commands
// ============================================================================

#[tauri::command]
async fn diagnostics_detect_stack(project_path: String) -> Result<diagnostics::TechStack, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diagnostics::detect_tech_stack(&project_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn diagnostics_check_env(project_path: String) -> Result<diagnostics::EnvCheckResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diagnostics::check_env_vars(&project_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn diagnostics_add_missing_keys(project_path: String, keys: Vec<String>) -> Result<usize, String> {
    diagnostics::add_missing_keys_to_env(&project_path, keys)
}

#[tauri::command]
async fn diagnostics_scan_file_lines(project_path: String, limit: usize, ignored_paths: Vec<String>) -> Result<Vec<diagnostics::FileLineCount>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diagnostics::scan_file_lines(&project_path, limit, &ignored_paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================================
// macOS Window Configuration
// ============================================================================

/// 激活应用并聚焦指定窗口 (macOS)
/// 使用 dispatch_after 确保在 window.show() 异步操作完成后再激活
#[cfg(target_os = "macos")]
fn activate_and_focus_window(window: &tauri::WebviewWindow) {
    use cocoa::appkit::NSApplicationActivationPolicy;
    use cocoa::base::id;
    use objc::*;

    // 获取 NSWindow 句柄
    let ns_window = match window.ns_window() {
        Ok(w) => w as usize, // 转为 usize 以便跨闭包传递
        Err(_) => return,
    };

    unsafe {
        let app = cocoa::appkit::NSApp();

        // 1. 确保应用是 Regular 类型（可以接收焦点）
        let _: () = msg_send![app, setActivationPolicy: NSApplicationActivationPolicy::NSApplicationActivationPolicyRegular];

        // 2. 激活应用（立即执行）
        let _: () = msg_send![app, activateIgnoringOtherApps: YES];

        // 3. 延迟执行窗口聚焦，等待 window.show() 完成
        // 使用 performSelector:withObject:afterDelay: 在主线程的 run loop 中延迟执行
        // 50ms 足够让 macOS 完成窗口显示动画
        let ns_win: id = ns_window as id;
        let nil_ptr: id = std::ptr::null_mut();

        let sel_make_key = sel!(makeKeyAndOrderFront:);
        let sel_order_front = sel!(orderFrontRegardless);
        let sel_make_main = sel!(makeMainWindow);

        // 延迟 50ms 后执行
        let delay: f64 = 0.05;
        let _: () = msg_send![ns_win, performSelector:sel_make_key withObject:nil_ptr afterDelay:delay];
        let _: () = msg_send![ns_win, performSelector:sel_order_front withObject:nil_ptr afterDelay:delay];
        let _: () = msg_send![ns_win, performSelector:sel_make_main withObject:nil_ptr afterDelay:delay];

        println!("[Lovcode] Window activation scheduled (50ms delay)");
    }
}

// ============================================================================
// Claude.ai Web Data Import
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
struct ImportResult {
    conversation_count: usize,
    project_id: String,
}

#[derive(Debug, Deserialize)]
struct ClaudeWebConversation {
    uuid: String,
    name: String,
    #[allow(dead_code)]
    summary: Option<String>,
    created_at: String,
    updated_at: String,
    chat_messages: Vec<ClaudeWebMessage>,
}

#[derive(Debug, Deserialize)]
struct ClaudeWebMessage {
    uuid: String,
    #[allow(dead_code)]
    text: Option<String>,
    content: Option<Vec<serde_json::Value>>,
    sender: String,
    created_at: String,
    #[allow(dead_code)]
    updated_at: Option<String>,
    #[allow(dead_code)]
    attachments: Option<Vec<serde_json::Value>>,
    #[allow(dead_code)]
    files: Option<Vec<serde_json::Value>>,
}

/// Convert a claude.ai web message content block to Claude Code compatible format.
/// The web format has extra fields (start_timestamp, stop_timestamp, flags, citations)
/// that we strip, keeping only what Claude Code's parser expects.
fn convert_web_content_block(block: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = block.as_object()?;
    let block_type = obj.get("type").and_then(|v| v.as_str())?;

    match block_type {
        "text" => {
            let text = obj.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                return None;
            }
            Some(serde_json::json!({
                "type": "text",
                "text": text
            }))
        }
        "thinking" => {
            let thinking = obj.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
            if thinking.is_empty() {
                return None;
            }
            Some(serde_json::json!({
                "type": "thinking",
                "thinking": thinking
            }))
        }
        "tool_use" => {
            let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let input = obj.get("input").cloned().unwrap_or(serde_json::Value::Null);
            Some(serde_json::json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input
            }))
        }
        "tool_result" => {
            let tool_use_id = obj.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
            // tool_result content can be array of {type, text} or string
            let content = obj.get("content").cloned().unwrap_or(serde_json::Value::Null);
            // Flatten to string if it's an array of text blocks
            let content_str = match &content {
                serde_json::Value::Array(arr) => {
                    arr.iter()
                        .filter_map(|item| {
                            item.as_object()
                                .and_then(|o| o.get("text"))
                                .and_then(|v| v.as_str())
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                }
                serde_json::Value::String(s) => s.clone(),
                _ => String::new(),
            };
            Some(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content_str
            }))
        }
        // Skip token_budget and other unknown types
        _ => None,
    }
}

/// Convert a single claude.ai conversation to Claude Code JSONL format
fn convert_conversation_to_jsonl(conv: &ClaudeWebConversation) -> String {
    let mut lines = Vec::new();

    // Summary line
    let summary_line = serde_json::json!({
        "type": "summary",
        "summary": conv.name
    });
    lines.push(serde_json::to_string(&summary_line).unwrap_or_default());

    // Message lines
    for msg in &conv.chat_messages {
        let role = match msg.sender.as_str() {
            "human" => "user",
            "assistant" => "assistant",
            _ => continue,
        };

        // Convert content blocks. claude.ai's detail API returns messages
        // without a `content` array — just a plain `text` field. Fall back to
        // wrapping `text` as a single text block so live-synced conversations
        // render the same way as zip-imported ones.
        let content_blocks: Vec<serde_json::Value> = match msg.content.as_ref() {
            Some(blocks) if !blocks.is_empty() => blocks
                .iter()
                .filter_map(|b| convert_web_content_block(b))
                .collect(),
            _ => {
                if let Some(text) = msg.text.as_deref() {
                    if !text.is_empty() {
                        vec![serde_json::json!({ "type": "text", "text": text })]
                    } else {
                        vec![]
                    }
                } else {
                    vec![]
                }
            }
        };

        // Skip messages with no content
        if content_blocks.is_empty() {
            continue;
        }

        let line = serde_json::json!({
            "type": role,
            "uuid": msg.uuid,
            "timestamp": msg.created_at,
            "message": {
                "role": role,
                "content": content_blocks
            }
        });
        lines.push(serde_json::to_string(&line).unwrap_or_default());
    }

    lines.join("\n")
}

#[tauri::command]
async fn import_claude_web_data(path: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source_path = Path::new(&path);

        // Determine if it's a zip or directory
        let conversations_json: String = if source_path.is_dir() {
            // Direct directory - read conversations.json
            let conv_path = source_path.join("conversations.json");
            if !conv_path.exists() {
                return Err("conversations.json not found in directory".to_string());
            }
            fs::read_to_string(&conv_path).map_err(|e| format!("Failed to read conversations.json: {}", e))?
        } else if source_path.extension().map_or(false, |e| e == "zip") {
            // ZIP file - extract conversations.json
            let file = fs::File::open(source_path)
                .map_err(|e| format!("Failed to open zip: {}", e))?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|e| format!("Failed to read zip: {}", e))?;

            // Find conversations.json (might be in a subdirectory)
            let mut found = None;
            for i in 0..archive.len() {
                let entry = archive.by_index(i).map_err(|e| e.to_string())?;
                if entry.name().ends_with("conversations.json") {
                    found = Some(i);
                    break;
                }
            }

            let idx = found.ok_or("conversations.json not found in zip")?;
            let mut entry = archive.by_index(idx).map_err(|e| e.to_string())?;
            let mut content = String::new();
            std::io::Read::read_to_string(&mut entry, &mut content)
                .map_err(|e| format!("Failed to read conversations.json from zip: {}", e))?;
            content
        } else {
            return Err("Path must be a directory or .zip file".to_string());
        };

        // Parse conversations
        let conversations: Vec<ClaudeWebConversation> =
            serde_json::from_str(&conversations_json)
                .map_err(|e| format!("Failed to parse conversations.json: {}", e))?;

        // Create target project directory
        let project_id = "-claude-ai".to_string();
        let project_dir = get_claude_dir().join("projects").join(&project_id);
        fs::create_dir_all(&project_dir)
            .map_err(|e| format!("Failed to create project directory: {}", e))?;

        // Save display name from source path
        let display_name = Path::new(&path)
            .file_stem()
            .or_else(|| Path::new(&path).file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "claude.ai".to_string());
        let _ = fs::write(project_dir.join(".display_name"), &display_name);

        let mut count = 0;

        for conv in &conversations {
            // Skip empty conversations
            if conv.chat_messages.is_empty() {
                continue;
            }

            let jsonl_content = convert_conversation_to_jsonl(conv);
            if jsonl_content.is_empty() {
                continue;
            }

            let session_file = project_dir.join(format!("{}.jsonl", conv.uuid));
            fs::write(&session_file, &jsonl_content)
                .map_err(|e| format!("Failed to write session {}: {}", conv.uuid, e))?;

            // Set file modification time to match conversation's updated_at
            if let Ok(updated) = chrono::DateTime::parse_from_rfc3339(&conv.updated_at) {
                let ft = filetime::FileTime::from_unix_time(updated.timestamp(), 0);
                let _ = filetime::set_file_mtime(&session_file, ft);
            }

            count += 1;
        }

        // Save import metadata
        let import_meta = serde_json::json!({
            "source": path,
            "imported_at": chrono::Utc::now().to_rfc3339(),
            "conversation_count": count
        });
        let meta_path = get_lovstudio_dir().join("claude-web-imports.json");
        let mut imports: Vec<serde_json::Value> = if meta_path.exists() {
            serde_json::from_str(&fs::read_to_string(&meta_path).unwrap_or_default())
                .unwrap_or_default()
        } else {
            vec![]
        };
        imports.push(import_meta);
        let _ = fs::write(&meta_path, serde_json::to_string_pretty(&imports).unwrap_or_default());

        Ok(ImportResult {
            conversation_count: count,
            project_id,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
pub struct WebSyncResult {
    pub fetched: usize,
    pub skipped_unchanged: usize,
    pub failed: usize,
    pub project_id: String,
}

/// Live-sync claude.ai conversations using the Claude desktop app's session cookie.
///
/// Stateless incremental: lists all conversations' metadata from the API,
/// compares each conversation's `updated_at` against the local jsonl file's
/// mtime, only re-downloads when newer. Failures on individual conversations
/// are counted but don't abort the run.
#[derive(Debug, Clone, Serialize)]
struct WebSyncProgress {
    total: usize,
    processed: usize,
    fetched: usize,
    skipped: usize,
    failed: usize,
}

#[tauri::command]
async fn sync_claude_web_conversations(app_handle: tauri::AppHandle) -> Result<WebSyncResult, String> {
    eprintln!("[web-sync] step 1: reading & decrypting cookies");
    // 1. Read & decrypt cookies (blocking work)
    let cookies = tauri::async_runtime::spawn_blocking(claude_web_sync::read_claude_app_cookies)
        .await
        .map_err(|e| e.to_string())??;
    eprintln!("[web-sync] step 1 ok, got {} cookies", cookies.len());
    let session_key = cookies.get("sessionKey")
        .ok_or_else(|| "sessionKey cookie not found — log into Claude desktop app first".to_string())?
        .clone();
    eprintln!("[web-sync] sessionKey length = {}", session_key.len());
    let active_org = cookies.get("lastActiveOrg").cloned();
    eprintln!("[web-sync] lastActiveOrg cookie = {:?}", active_org);

    // 2. HTTP client with timeouts so we never hang
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let cookie_header = format!("sessionKey={}", session_key);

    // 3. Resolve org_id — always fetch from API since the cookie value is
    // URL-encoded JSON and unreliable to parse.
    eprintln!("[web-sync] step 3: GET /api/organizations");
    let org_id = {
        let resp = client.get("https://claude.ai/api/organizations")
            .header(reqwest::header::COOKIE, &cookie_header)
            .send().await.map_err(|e| format!("fetch orgs: {}", e))?;
        let status = resp.status();
        eprintln!("[web-sync] orgs status: {}", status);
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("fetch orgs: HTTP {} — {}", status, body.chars().take(200).collect::<String>()));
        }
        let orgs: Vec<serde_json::Value> = resp.json().await.map_err(|e| format!("parse orgs: {}", e))?;
        eprintln!("[web-sync] orgs count: {}", orgs.len());
        let id = orgs.first()
            .and_then(|o| o.get("uuid").and_then(|v| v.as_str()))
            .map(String::from)
            .ok_or_else(|| "no organizations found for this account".to_string())?;
        // Prefer the cookie value if it's a clean uuid; otherwise use API result.
        match active_org {
            Some(o) if o.len() == 36 && o.chars().all(|c| c.is_ascii_hexdigit() || c == '-') => o,
            _ => id,
        }
    };
    eprintln!("[web-sync] org_id = {}", org_id);

    // 4. List conversations (lightweight metadata)
    let list_url = format!("https://claude.ai/api/organizations/{}/chat_conversations", org_id);
    eprintln!("[web-sync] step 4: GET {}", list_url);
    let resp = client.get(&list_url)
        .header(reqwest::header::COOKIE, &cookie_header)
        .send().await.map_err(|e| format!("list conversations: {}", e))?;
    let status = resp.status();
    eprintln!("[web-sync] list status: {}", status);
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("list conversations: HTTP {} — {}", status, body.chars().take(200).collect::<String>()));
    }
    let conv_list: Vec<serde_json::Value> = resp.json().await
        .map_err(|e| format!("parse conversation list: {}", e))?;
    eprintln!("[web-sync] got {} conversations from API", conv_list.len());

    // Cache web starred conversation uuids to disk so the frontend pin sync
    // can pick them up alongside Claude Code starredIds.
    let web_starred: Vec<String> = conv_list.iter()
        .filter(|c| c.get("is_starred").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter_map(|c| c.get("uuid").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let cache_path = get_lovstudio_dir().join("claude-web-starred.json");
    if let Some(parent) = cache_path.parent() { let _ = std::fs::create_dir_all(parent); }
    let _ = std::fs::write(&cache_path, serde_json::to_string(&web_starred).unwrap_or_else(|_| "[]".into()));
    eprintln!("[web-sync] cached {} web-starred conversations", web_starred.len());

    // 5. Prepare project dir
    let project_id = "-claude-ai".to_string();
    let project_dir = get_claude_dir().join("projects").join(&project_id);
    std::fs::create_dir_all(&project_dir).map_err(|e| e.to_string())?;
    if !project_dir.join(".display_name").exists() {
        let _ = std::fs::write(project_dir.join(".display_name"), "claude.ai");
    }

    // 6. Build the list of conversations that need fetching (skip fresh ones)
    let total = conv_list.len();
    let mut to_fetch: Vec<(String, String)> = Vec::new(); // (uuid, updated_at)
    let mut skipped = 0usize;
    for conv in &conv_list {
        let Some(uuid) = conv.get("uuid").and_then(|v| v.as_str()) else { continue };
        let updated_at = conv.get("updated_at").and_then(|v| v.as_str()).unwrap_or("");
        let session_file = project_dir.join(format!("{}.jsonl", uuid));
        if is_local_fresh_for_remote(&session_file, updated_at) {
            skipped += 1;
            continue;
        }
        to_fetch.push((uuid.to_string(), updated_at.to_string()));
    }

    let _ = app_handle.emit("web-sync-progress", WebSyncProgress {
        total, processed: skipped, fetched: 0, skipped, failed: 0,
    });
    eprintln!("[web-sync] {} to fetch ({} skipped fresh)", to_fetch.len(), skipped);

    // 7. Fetch concurrently with bounded parallelism. claude.ai usually tolerates
    // a handful of in-flight detail requests; 6 keeps us well clear of rate limits
    // while finishing 300+ conversations in minutes instead of hours.
    use futures::stream::StreamExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let fetched_counter = std::sync::Arc::new(AtomicUsize::new(0));
    let failed_counter = std::sync::Arc::new(AtomicUsize::new(0));
    let processed_counter = std::sync::Arc::new(AtomicUsize::new(skipped));
    let project_dir = std::sync::Arc::new(project_dir);
    let cookie_header = std::sync::Arc::new(cookie_header);
    let org_id = std::sync::Arc::new(org_id);
    let client = std::sync::Arc::new(client);
    let app_handle = std::sync::Arc::new(app_handle);

    const CONCURRENCY: usize = 6;
    let mut stream = futures::stream::iter(to_fetch.into_iter().map(|(uuid, updated_at)| {
        let client = client.clone();
        let cookie_header = cookie_header.clone();
        let org_id = org_id.clone();
        let project_dir = project_dir.clone();
        let fetched = fetched_counter.clone();
        let failed = failed_counter.clone();
        let processed = processed_counter.clone();
        let app_handle = app_handle.clone();
        async move {
            let session_file = project_dir.join(format!("{}.jsonl", uuid));
            let detail_url = format!(
                "https://claude.ai/api/organizations/{}/chat_conversations/{}?rendering_mode=raw",
                org_id, uuid,
            );
            let result: Result<(), String> = (async {
                let resp = client.get(&detail_url)
                    .header(reqwest::header::COOKIE, cookie_header.as_str())
                    .send().await.map_err(|e| format!("send: {}", e))?;
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status()));
                }
                let detail_value: serde_json::Value = resp.json().await
                    .map_err(|e| format!("parse: {}", e))?;

                // DEBUG: dump the very first response to a temp file so we can
                // inspect the actual schema of the detail endpoint.
                let dump_path = std::env::temp_dir().join("lovcode-web-detail-sample.json");
                if !dump_path.exists() {
                    let _ = std::fs::write(&dump_path, serde_json::to_string_pretty(&detail_value).unwrap_or_default());
                    eprintln!("[web-sync] dumped sample to {}", dump_path.display());
                }

                let conv_struct: ClaudeWebConversation = serde_json::from_value(detail_value.clone())
                    .map_err(|e| format!("struct: {}", e))?;
                if conv_struct.chat_messages.is_empty() {
                    let top_keys: Vec<&str> = detail_value.as_object()
                        .map(|m| m.keys().map(|s| s.as_str()).collect()).unwrap_or_default();
                    eprintln!("[web-sync] {} has empty chat_messages; top keys = {:?}", uuid, top_keys);
                    return Ok(()); // empty — counted as success no-op
                }
                let jsonl = convert_conversation_to_jsonl(&conv_struct);
                if jsonl.is_empty() {
                    return Err("empty jsonl after conversion".to_string());
                }
                std::fs::write(&session_file, &jsonl).map_err(|e| format!("write: {}", e))?;
                if let Ok(t) = chrono::DateTime::parse_from_rfc3339(&updated_at) {
                    let ft = filetime::FileTime::from_unix_time(t.timestamp(), 0);
                    let _ = filetime::set_file_mtime(&session_file, ft);
                }
                Ok(())
            }).await;

            match result {
                Ok(()) => { fetched.fetch_add(1, Ordering::Relaxed); }
                Err(e) => { eprintln!("[web-sync] {} failed: {}", uuid, e); failed.fetch_add(1, Ordering::Relaxed); }
            }
            let p = processed.fetch_add(1, Ordering::Relaxed) + 1;
            if p % 5 == 0 || p == total {
                let _ = app_handle.emit("web-sync-progress", WebSyncProgress {
                    total,
                    processed: p,
                    fetched: fetched.load(Ordering::Relaxed),
                    skipped,
                    failed: failed.load(Ordering::Relaxed),
                });
            }
        }
    })).buffer_unordered(CONCURRENCY);

    while stream.next().await.is_some() {}

    let fetched = fetched_counter.load(Ordering::Relaxed);
    let failed = failed_counter.load(Ordering::Relaxed);
    eprintln!("[web-sync] done: fetched={} skipped={} failed={}", fetched, skipped, failed);
    let _ = app_handle.emit("web-sync-progress", WebSyncProgress {
        total, processed: total, fetched, skipped, failed,
    });

    Ok(WebSyncResult { fetched, skipped_unchanged: skipped, failed, project_id })
}

/// Debug command: fetch the raw API response for a single conversation and
/// dump it to /tmp/lovcode-web-probe.json. Use to inspect the real schema.
#[tauri::command]
async fn debug_probe_claude_web(uuid: String) -> Result<String, String> {
    let cookies = tauri::async_runtime::spawn_blocking(claude_web_sync::read_claude_app_cookies)
        .await
        .map_err(|e| e.to_string())??;
    let session_key = cookies.get("sessionKey")
        .ok_or_else(|| "no sessionKey".to_string())?.clone();
    let active_org = cookies.get("lastActiveOrg").cloned();

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let cookie_header = format!("sessionKey={}", session_key);

    let org_id = active_org.ok_or_else(|| "no lastActiveOrg cookie".to_string())?;

    // Try multiple endpoint variants
    let urls = vec![
        format!("https://claude.ai/api/organizations/{}/chat_conversations/{}", org_id, uuid),
        format!("https://claude.ai/api/organizations/{}/chat_conversations/{}?rendering_mode=raw", org_id, uuid),
        format!("https://claude.ai/api/organizations/{}/chat_conversations/{}?tree=True&rendering_mode=raw", org_id, uuid),
        format!("https://claude.ai/api/organizations/{}/chat_conversations/{}?tree=False&rendering_mode=raw", org_id, uuid),
    ];

    let mut report = String::new();
    for (i, url) in urls.iter().enumerate() {
        report.push_str(&format!("\n=== variant {}: {} ===\n", i, url));
        let resp = match client.get(url).header(reqwest::header::COOKIE, &cookie_header).send().await {
            Ok(r) => r,
            Err(e) => { report.push_str(&format!("send err: {}\n", e)); continue; }
        };
        let status = resp.status();
        report.push_str(&format!("status: {}\n", status));
        let text = resp.text().await.unwrap_or_default();
        report.push_str(&format!("body len: {} bytes\n", text.len()));

        // Save first variant's body fully for schema inspection
        if i == 0 {
            let _ = std::fs::write("/tmp/lovcode-web-probe.json", &text);
        }

        // Try to parse + count chat_messages
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(obj) = v.as_object() {
                let keys: Vec<&str> = obj.keys().map(|s| s.as_str()).collect();
                report.push_str(&format!("top keys: {:?}\n", keys));
                if let Some(cm) = obj.get("chat_messages").and_then(|v| v.as_array()) {
                    report.push_str(&format!("chat_messages.len: {}\n", cm.len()));
                    if let Some(first) = cm.first().and_then(|v| v.as_object()) {
                        let mk: Vec<&str> = first.keys().map(|s| s.as_str()).collect();
                        report.push_str(&format!("first message keys: {:?}\n", mk));
                    }
                }
                // Also look for alternative field names
                for alt in &["messages", "current_leaf_message", "chat_messages_leaf", "tree"] {
                    if obj.contains_key(*alt) {
                        report.push_str(&format!("HAS field [{}]\n", alt));
                    }
                }
            }
        } else {
            report.push_str(&format!("non-JSON body head: {:?}\n", text.chars().take(200).collect::<String>()));
        }
    }

    let _ = std::fs::write("/tmp/lovcode-web-probe-report.txt", &report);
    Ok(report)
}

fn is_local_fresh_for_remote(path: &std::path::Path, remote_updated_at: &str) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    let Ok(local_mtime) = meta.modified() else { return false };
    let Ok(remote_dt) = chrono::DateTime::parse_from_rfc3339(remote_updated_at) else { return false };
    let local_secs = local_mtime
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    local_secs >= remote_dt.timestamp()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder, PredefinedMenuItem};

            // dev 模式：cargo 重启二进制后默认抢焦点。`[NSApp hide:]` 让自己
            // 在 active 之前先隐藏一次 —— macOS 会立刻把焦点交还给上一个
            // frontmost app（通常是触发 cargo 的终端）。窗口随后正常显示，
            // Dock 图标和 cmd-tab 列表都保留。release 构建零影响。
            #[cfg(all(debug_assertions, target_os = "macos"))]
            unsafe {
                use cocoa::appkit::NSApp;
                use cocoa::base::nil;
                use objc::*;
                let ns_app = NSApp();
                let _: () = msg_send![ns_app, hide: nil];
            }

            // Initialize PTY manager with app handle for event emission
            pty_manager::init(app.handle().clone());

            // Start watching distill directory for changes
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let distill_dir = get_distill_dir();
                if !distill_dir.exists() {
                    // Create directory if it doesn't exist so we can watch it
                    let _ = fs::create_dir_all(&distill_dir);
                }

                let (tx, rx) = channel();
                let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                    if let Ok(event) = res {
                        // Only trigger on create/modify/remove events
                        if event.kind.is_create() || event.kind.is_modify() || event.kind.is_remove() {
                            let _ = tx.send(());
                        }
                    }
                }) {
                    Ok(w) => w,
                    Err(_) => return,
                };

                if watcher.watch(&distill_dir, RecursiveMode::NonRecursive).is_err() {
                    return;
                }

                // Debounce: wait for events to settle before emitting
                loop {
                    if rx.recv().is_ok() {
                        // Drain any additional events that came in quickly
                        while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
                        // Only emit if watch is enabled
                        if DISTILL_WATCH_ENABLED.load(std::sync::atomic::Ordering::Relaxed) {
                            let _ = app_handle.emit("distill-changed", ());
                        }
                    }
                }
            });

            // Start watching ~/.claude/projects/ for session changes (new/updated jsonl files)
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let projects_dir = get_claude_dir().join("projects");
                if !projects_dir.exists() {
                    let _ = fs::create_dir_all(&projects_dir);
                }

                let (tx, rx) = channel();
                let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                    if let Ok(event) = res {
                        if event.kind.is_create() || event.kind.is_modify() || event.kind.is_remove() {
                            let _ = tx.send(());
                        }
                    }
                }) {
                    Ok(w) => w,
                    Err(_) => return,
                };

                if watcher.watch(&projects_dir, RecursiveMode::Recursive).is_err() {
                    return;
                }

                loop {
                    if rx.recv().is_ok() {
                        // Debounce burst of writes from jsonl appends
                        while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
                        let _ = app_handle.emit("sessions-changed", ());
                    }
                }
            });

            let settings = MenuItemBuilder::with_id("settings", "Settings...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Lovcode")
                .item(&PredefinedMenuItem::about(app, Some("About Lovcode"), None)?)
                .separator()
                .item(&settings)
                .separator()
                .item(&PredefinedMenuItem::hide(app, Some("Hide Lovcode"))?)
                .item(&PredefinedMenuItem::hide_others(app, Some("Hide Others"))?)
                .item(&PredefinedMenuItem::show_all(app, Some("Show All"))?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, Some("Quit Lovcode"))?)
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            let toggle_main = MenuItemBuilder::with_id("toggle_main", "Toggle Main Window")
                .accelerator("CmdOrCtrl+1")
                .build(app)?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .item(&toggle_main)
                .separator()
                .item(&PredefinedMenuItem::minimize(app, None)?)
                .item(&PredefinedMenuItem::maximize(app, None)?)
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .build()?;

            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            use tauri::WebviewWindowBuilder;
            use tauri::WebviewUrl;

            match event.id().as_ref() {
                "settings" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("menu-settings", ());
                    }
                }
                "toggle_main" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let visible = window.is_visible().unwrap_or(false);
                        let focused = window.is_focused().unwrap_or(false);
                        if visible && focused {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            #[cfg(target_os = "macos")]
                            activate_and_focus_window(&window);
                            #[cfg(not(target_os = "macos"))]
                            let _ = window.set_focus();
                        }
                    } else {
                        // Recreate main window
                        #[cfg(target_os = "macos")]
                        {
                            if let Ok(window) = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                                .title("Lovcode")
                                .inner_size(800.0, 600.0)
                                .title_bar_style(tauri::TitleBarStyle::Overlay)
                                .hidden_title(true)
                                .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(16.0, 28.0)))
                                .build()
                            {
                                let _ = window.show();
                                activate_and_focus_window(&window);
                            }
                        }
                        #[cfg(not(target_os = "macos"))]
                        if let Ok(window) = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                            .title("Lovcode")
                            .inner_size(800.0, 600.0)
                            .build()
                        {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            list_sessions,
            get_sessions_usage,
            list_all_sessions,
            get_app_starred_session_ids,
            list_all_chats,
            get_session_messages,
            build_search_index,
            search_chats,
            list_local_commands,
            list_local_agents,
            list_local_skills,
            list_codex_commands,
            install_skill_template,
            uninstall_skill,
            check_skill_installed,
            get_context_files,
            get_project_context,
            get_settings,
            get_command_stats,
            get_command_weekly_stats,
            get_activity_stats,
            get_annual_report_2025,
            get_templates_catalog,
            install_command_template,
            rename_command,
            deprecate_command,
            archive_command,
            restore_command,
            update_command_aliases,
            install_mcp_template,
            uninstall_mcp_template,
            check_mcp_installed,
            install_hook_template,
            install_setting_template,
            update_settings_statusline,
            remove_settings_statusline,
            write_statusline_script,
            install_statusline_template,
            apply_statusline,
            restore_previous_statusline,
            has_previous_statusline,
            execute_statusbar_script,
            get_statusbar_settings,
            save_statusbar_settings,
            write_lovcode_statusbar_script,
            remove_statusline_template,
            open_in_editor,
            open_file_at_line,
            open_session_in_editor,
            reveal_session_file,
            reveal_path,
            open_path,
            check_paths_exist,
            migrate_session_cwd,
            find_relocation_candidates,
            get_session_file_path,
            get_session_summary,
            copy_to_clipboard,
            get_settings_path,
            get_mcp_config_path,
            get_home_dir,
            get_env_var,
            get_today_coding_stats,
            write_file,
            write_binary_file,
            update_mcp_env,
            update_settings_env,
            delete_settings_env,
            disable_settings_env,
            enable_settings_env,
            update_disabled_settings_env,
            get_provider_contexts,
            set_provider_context_env,
            snapshot_provider_context,
            get_maas_registry,
            save_maas_registry,
            upsert_maas_provider,
            delete_maas_provider,
            update_settings_field,
            update_settings_permission_field,
            add_permission_directory,
            remove_permission_directory,
            toggle_plugin,
            // Extensions management
            list_installed_plugins,
            list_extension_marketplaces,
            fetch_marketplace_plugins,
            install_extension,
            uninstall_extension,
            add_extension_marketplace,
            remove_extension_marketplace,
            toggle_hook_item,
            get_disabled_hooks,
            delete_hook_item,
            delete_disabled_hook,
            test_anthropic_connection,
            test_openai_connection,
            test_claude_cli,
            list_distill_documents,
            find_session_project,
            get_distill_watch_enabled,
            set_distill_watch_enabled,
            list_reference_sources,
            list_reference_docs,
            get_claude_code_version_info,
            install_claude_code_version,
            cancel_claude_code_install,
            set_claude_code_autoupdater,
            // PTY commands
            pty_create,
            pty_write,
            pty_read,
            pty_resize,
            pty_kill,
            pty_list,
            pty_exists,
            pty_scrollback,
            pty_purge_scrollback,
            pty_flush_scrollback,
            // Workspace commands
            workspace_load,
            workspace_save,
            workspace_add_project,
            workspace_list_projects,
            workspace_remove_project,
            workspace_set_active_project,
            workspace_create_feature,
            workspace_rename_feature,
            workspace_update_feature_status,
            workspace_delete_feature,
            workspace_set_active_feature,
            workspace_add_panel,
            workspace_remove_panel,
            workspace_toggle_panel_shared,
            workspace_get_pending_reviews,
            // Hook watcher commands
            hook_start_monitoring,
            hook_stop_monitoring,
            hook_is_monitoring,
            // Project logo
            get_project_logo,
            list_project_logos,
            save_project_logo,
            copy_file_to_project_assets,
            set_current_project_logo,
            delete_project_logo,
            read_file_base64,
            exec_shell_command,
            hook_get_monitored,
            hook_notify_complete,
            // File system
            get_file_metadata,
            read_file,
            list_directory,
            // Git commands
            git_log,
            git_get_note,
            git_set_note,
            git_revert,
            git_has_changes,
            git_auto_commit,
            git_generate_changelog,
            // Diagnostics commands
            diagnostics_detect_stack,
            diagnostics_check_env,
            diagnostics_add_missing_keys,
            diagnostics_scan_file_lines,
            // Claude.ai web import
            import_claude_web_data,
            sync_claude_web_conversations,
            debug_probe_claude_web
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            {
                use tauri::{Manager, RunEvent, WebviewWindowBuilder, WebviewUrl};

                if let RunEvent::Reopen { has_visible_windows, .. } = _event {
                    println!("[Lovcode] Dock clicked! has_visible_windows: {}", has_visible_windows);

                    // 无论是否有"可见窗口"，都尝试打开主窗口
                    // 因为 float 窗口可能被计入 has_visible_windows
                    if let Some(window) = _app.get_webview_window("main") {
                        println!("[Lovcode] Main window exists, showing...");
                        let _ = window.show();
                        activate_and_focus_window(&window);
                    } else {
                        println!("[Lovcode] Main window gone, recreating...");
                        match WebviewWindowBuilder::new(_app, "main", WebviewUrl::default())
                            .title("Lovcode")
                            .inner_size(800.0, 600.0)
                            .title_bar_style(tauri::TitleBarStyle::Overlay)
                            .hidden_title(true)
                            .traffic_light_position(tauri::Position::Logical(tauri::LogicalPosition::new(16.0, 28.0)))
                            .build()
                        {
                            Ok(window) => {
                                println!("[Lovcode] Window created successfully");
                                let _ = window.show();
                                activate_and_focus_window(&window);
                            }
                            Err(e) => {
                                println!("[Lovcode] Failed to create window: {:?}", e);
                            }
                        }
                    }
                }
            }
        });
}
