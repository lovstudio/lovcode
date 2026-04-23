export * from "./maas";

// ============================================================================
// Feature Types
// ============================================================================

export type FeatureType =
  | "chat"
  | "workspace"
  | "features"
  | "basic-env"
  | "basic-llm"
  | "basic-maas"
  | "basic-version"
  | "basic-context"
  | "settings"
  | "statusline"
  | "commands"
  | "mcp"
  | "skills"
  | "hooks"
  | "sub-agents"
  | "output-styles"
  | "marketplace"
  | "extensions"
  | "kb-distill"
  | "kb-reference"
  | "events";

export interface FeatureConfig {
  type: FeatureType;
  label: string;
  description: string;
  available: boolean;
  group: "history" | "basic" | "config" | "knowledge";
}

// ============================================================================
// Data Types
// ============================================================================

export interface Project {
  id: string;
  path: string;
  session_count: number;
  last_active: number;
}

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export interface Session {
  id: string;
  project_id: string;
  project_path: string | null;
  title: string | null;
  summary: string | null;
  message_count: number;
  created_at: number;
  last_modified: number;
  usage?: SessionUsage;
}

export interface SessionUsageEntry {
  session_id: string;
  usage: SessionUsage;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; summary: string }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "thinking"; thinking: string };

export interface Message {
  uuid: string;
  role: string;
  content: string;
  timestamp: string;
  is_meta: boolean;
  is_tool: boolean;
  line_number: number;
  content_blocks?: ContentBlock[];
}

export interface ChatMessage {
  uuid: string;
  role: string;
  content: string;
  timestamp: string;
  project_id: string;
  project_path: string;
  session_id: string;
  session_summary: string | null;
}

export interface SearchResult {
  uuid: string;
  content: string;
  role: string;
  project_id: string;
  project_path: string;
  session_id: string;
  session_summary: string | null;
  timestamp: string;
  score: number;
}

export interface ChatsResponse {
  items: ChatMessage[];
  total: number;
}

export interface LocalCommand {
  name: string;
  path: string;
  description: string | null;
  allowed_tools: string | null;
  argument_hint: string | null;
  content: string;
  version: string | null;
  status: "active" | "deprecated" | "archived";
  deprecated_by: string | null;
  changelog: string | null;
  aliases: string[];
  frontmatter: string | null;
}

export interface LocalAgent {
  name: string;
  path: string;
  description: string | null;
  model: string | null;
  tools: string | null;
  content: string;
}

export interface CodexCommand {
  name: string;
  path: string | null;
  description: string | null;
  is_builtin: boolean;
}

export interface MarketplaceMeta {
  source_id?: string | null;
  source_name?: string | null;
  author?: string | null;
  downloads?: number | null;
  template_path?: string | null;
}

export interface LocalSkill {
  name: string;
  path: string;
  description: string | null;
  content: string;
  // Marketplace metadata (if installed from marketplace)
  marketplace?: MarketplaceMeta | null;
}

export interface DistillDocument {
  date: string;
  file: string;
  title: string;
  tags: string[];
  session: string | null;
}

export interface McpServer {
  name: string;
  description: string | null;
  type: string | null;        // "http" | "sse" | "stdio"
  url: string | null;         // for http/sse servers
  command: string | null;     // for stdio servers
  args: string[];
  env: Record<string, string>;
}

export interface ClaudeSettings {
  raw: Record<string, unknown> | null;
  permissions: Record<string, unknown> | null;
  hooks: Record<string, unknown[]> | null;
  mcp_servers: McpServer[];
}

export interface ContextFile {
  name: string;
  path: string;
  scope: string;
  content: string;
  last_modified: number;
}

export interface TemplateComponent {
  name: string;
  path: string;
  category: string;
  component_type: string;
  description: string | null;
  downloads: number | null;
  content: string | null;
  source_id?: string | null;
  source_name?: string | null;
  source_icon?: string | null;
  plugin_name?: string | null;
  author?: string | null;
}

export interface SourceInfo {
  id: string;
  name: string;
  icon: string;
  count: number;
}

export interface TemplatesCatalog {
  settings: TemplateComponent[];
  commands: TemplateComponent[];
  mcps: TemplateComponent[];
  skills: TemplateComponent[];
  hooks: TemplateComponent[];
  agents: TemplateComponent[];
  statuslines: TemplateComponent[];
  "output-styles": TemplateComponent[];
  sources?: SourceInfo[];
}

export type TemplateCategory =
  | "settings"
  | "commands"
  | "mcps"
  | "skills"
  | "hooks"
  | "agents"
  | "statuslines"
  | "output-styles";

// ============================================================================
// View State Types
// ============================================================================

export type View =
  | { type: "home" }
  | { type: "workspace"; projectId?: string; featureId?: string; mode?: "terminal" | "dashboard" }
  | { type: "features" }
  | { type: "chat-projects" }
  | { type: "chat-sessions"; projectId: string; projectPath: string }
  | { type: "chat-messages"; projectId: string; projectPath: string; sessionId: string; summary: string | null }
  | { type: "basic-env" }
  | { type: "basic-llm" }
  | { type: "basic-maas" }
  | { type: "basic-version" }
  | { type: "basic-context" }
  | { type: "settings" }
  | { type: "commands" }
  | { type: "command-detail"; command: LocalCommand; scrollToChangelog?: boolean }
  | { type: "mcp" }
  | { type: "skills" }
  | { type: "hooks" }
  | { type: "sub-agents" }
  | { type: "sub-agent-detail"; agent: LocalAgent }
  | { type: "output-styles" }
  | { type: "statusline" }
  | { type: "kb-distill" }
  | { type: "kb-distill-detail"; document: DistillDocument }
  | { type: "kb-reference" }
  | { type: "kb-reference-doc"; source: string; docIndex: number }
  | { type: "marketplace"; category?: TemplateCategory }
  | { type: "template-detail"; template: TemplateComponent; category: TemplateCategory }
  | { type: "feature-template-detail"; template: TemplateComponent; category: TemplateCategory; fromFeature: FeatureType; localPath?: string; isInstalled?: boolean }
  | { type: "feature-todo"; feature: FeatureType }
  | { type: "annual-report-2025" };

// ============================================================================
// Annual Report Types
// ============================================================================

export interface FavoriteProject {
  id: string;
  path: string;
  session_count: number;
  message_count: number;
}

export interface TopCommand {
  name: string;
  count: number;
}

export interface AnnualReport2025 {
  total_sessions: number;
  total_messages: number;
  total_commands: number;
  active_days: number;
  first_chat_date: string | null;
  last_chat_date: string | null;
  peak_hour: number;
  peak_hour_count: number;
  peak_weekday: number;
  total_projects: number;
  favorite_project: FavoriteProject | null;
  top_commands: TopCommand[];
  longest_streak: number;
  daily_activity: Record<string, number>;
  hourly_distribution: Record<string, number>;
}

// ============================================================================
// User Types
// ============================================================================

export interface UserProfile {
  nickname: string;
  avatarUrl: string;
}

// ============================================================================
// Sort & Filter Types
// ============================================================================

export type SortKey = "recent" | "sessions" | "name";
export type SortDirection = "asc" | "desc";
export type CommandSortKey = "usage" | "name";
export type ChatViewMode = "projects" | "sessions" | "chats";
export type ExportFormat = "markdown" | "json";
export type MarkdownStyle = "full" | "bullet" | "qa";

// ============================================================================
// Reference Types
// ============================================================================

export interface ReferenceSource {
  name: string;
  icon: string;
  docs: ReferenceDoc[];
}

export interface ReferenceDoc {
  title: string;
  description: string;
  path: string;
}

// ============================================================================
// Version Types
// ============================================================================

export interface VersionWithDownloads {
  version: string;
  downloads: number;
  date: string;
}

export type ClaudeCodeInstallType = "native" | "npm" | "none";

export interface ClaudeCodeVersionInfo {
  install_type: ClaudeCodeInstallType;
  current_version: string | null;
  available_versions: VersionWithDownloads[];
  autoupdater_disabled: boolean;
}

// ============================================================================
// Extensions Types
// ============================================================================

export interface InstalledPlugin {
  id: string;
  name: string;
  marketplace: string;
  enabled: boolean;
}

export interface ExtensionMarketplace {
  id: string;
  name: string;
  repo: string | null;
  path: string | null;
  is_official: boolean;
}

export interface MarketplacePlugin {
  name: string;
  description: string | null;
  path: string;
}
