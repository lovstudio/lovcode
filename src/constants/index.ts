import type { FeatureConfig, TemplateCategory } from "../types";

// ============================================================================
// Features Configuration
// ============================================================================

export const FEATURES: FeatureConfig[] = [
  // Workspace (parallel vibe coding)
  {
    type: "workspace",
    label: "Workspace",
    description: "Parallel vibe coding workspace",
    available: true,
    group: "history",
  },
  // Knowledge (collapsible submenu)
  {
    type: "kb-reference",
    label: "Reference",
    description: "Platform docs",
    available: true,
    group: "knowledge",
  },
  {
    type: "kb-distill",
    label: "Distill (CC)",
    description: "Experience summaries",
    available: true,
    group: "knowledge",
  },
  // Basic settings (no marketplace) - grouped under "Basic"
  {
    type: "basic-env",
    label: "Environment",
    description: "Environment variables",
    available: true,
    group: "basic",
  },
  {
    type: "basic-llm",
    label: "LLM Provider",
    description: "LLM proxy configuration",
    available: true,
    group: "basic",
  },
  {
    type: "basic-version",
    label: "CC Version",
    description: "Claude Code version management",
    available: true,
    group: "basic",
  },
  {
    type: "basic-context",
    label: "Context",
    description: "CLAUDE.md context files",
    available: true,
    group: "basic",
  },
  // Features (with marketplace)
  {
    type: "settings",
    label: "Settings",
    description: "settings.json templates",
    available: true,
    group: "config",
  },
  {
    type: "commands",
    label: "Commands",
    description: "Slash commands",
    available: true,
    group: "config",
  },
  {
    type: "mcp",
    label: "MCPs",
    description: "MCP servers",
    available: true,
    group: "config",
  },
  {
    type: "skills",
    label: "Skills",
    description: "Reusable skill templates",
    available: true,
    group: "config",
  },
  {
    type: "hooks",
    label: "Hooks",
    description: "Automation triggers",
    available: true,
    group: "config",
  },
  {
    type: "sub-agents",
    label: "Sub Agents",
    description: "AI agents with models",
    available: true,
    group: "config",
  },
  {
    type: "output-styles",
    label: "Output Styles",
    description: "Response formatting styles",
    available: true,
    group: "config",
  },
  {
    type: "statusline",
    label: "Status Line",
    description: "Custom CLI status line",
    available: true,
    group: "config",
  },
  {
    type: "extensions",
    label: "Extensions",
    description: "Claude Code plugins",
    available: true,
    group: "config",
  },
];

// ============================================================================
// Source Filters
// ============================================================================

export const SOURCE_FILTERS = [
  { id: "all", label: "All", tooltip: "All sources" },
  { id: "anthropic", label: "Anthropic", tooltip: "github.com/anthropics/claude-plugins-official" },
  { id: "lovstudio", label: "Lovstudio", tooltip: "github.com/markshawn2020/lovstudio-plugins-official" },
  { id: "community", label: "CCT", tooltip: "github.com/davila7/claude-code-templates" },
] as const;

export type SourceFilterId = (typeof SOURCE_FILTERS)[number]["id"];

// ============================================================================
// Template Categories
// ============================================================================

export const TEMPLATE_CATEGORIES: {
  key: TemplateCategory;
  label: string;
}[] = [
  { key: "settings", label: "Settings" },
  { key: "commands", label: "Commands" },
  { key: "mcps", label: "MCPs" },
  { key: "skills", label: "Skills" },
  { key: "hooks", label: "Hooks" },
  { key: "agents", label: "Sub Agents" },
  { key: "output-styles", label: "Output Styles" },
  { key: "statuslines", label: "Status Line" },
];

// ============================================================================
// LLM Provider Presets (MaaS proxies / Anthropic endpoints)
// ============================================================================

export interface LlmProviderPreset {
  key: string;
  label: string;
  description: string;
  templateName: string;
  docsUrl?: string;
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    key: "anthropic-subscription",
    label: "Anthropic Subscription",
    description: "Use Claude Pro/Max subscription via OAuth login",
    templateName: "anthropic-subscription",
  },
  {
    key: "modelgate",
    label: "ModelGate",
    description: "ModelGate API gateway for Claude",
    templateName: "modelgate-anthropic-proxy",
    docsUrl: "https://docs.modelgate.net/guide/tools/claude-code.html",
  },
  {
    key: "native",
    label: "Anthropic API",
    description: "Direct Anthropic API with your API key",
    templateName: "anthropic-native-endpoint",
  },
  {
    key: "qiniu",
    label: "Qiniu Cloud",
    description: "Use Qiniu Cloud AI gateway for Anthropic API",
    templateName: "qiniu-anthropic-proxy",
    docsUrl: "https://developer.qiniu.com/aitokenapi/13085/claude-code-configuration-instructions",
  },
  {
    key: "siliconflow",
    label: "SiliconFlow",
    description: "Use SiliconCloud API for Claude Code with various models",
    templateName: "siliconflow-anthropic-proxy",
    docsUrl: "https://docs.siliconflow.com/en/userguide/quickstart",
  },
  {
    key: "univibe",
    label: "UniVibe",
    description: "UniVibe proxy service, supports Claude Code / Codex / Cursor",
    templateName: "univibe-anthropic-proxy",
    docsUrl: "https://www.univibe.cc/console/docs/claudecode",
  },
  {
    key: "zenmux",
    label: "ZenMux",
    description: "Route via ZenMux to unlock more model options",
    templateName: "zenmux-anthropic-proxy",
    docsUrl: "https://docs.zenmux.ai/best-practices/claude-code.html",
  },
];
