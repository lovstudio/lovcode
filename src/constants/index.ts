import type { FeatureConfig, TemplateCategory } from "../types";

// ============================================================================
// Features Configuration
// ============================================================================

export const FEATURES: FeatureConfig[] = [
  // Knowledge (Distill is the only fixed feature; doc sources are dynamic)
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
    type: "basic-maas",
    label: "MaaS Registry",
    description: "Model-as-a-Service providers",
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

