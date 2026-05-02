import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { View, TemplateCategory, FeatureType } from "@/types";

// 当前选中的文件路径
export const selectedFileAtom = atomWithStorage<string | null>("lovcode:selectedFile", null);

// FileViewer 的查看模式
export const fileViewModeAtom = atomWithStorage<"source" | "preview" | "split">("lovcode:fileViewer:viewMode", "preview");

// 当前激活的面板 ID
export const activePanelIdAtom = atomWithStorage<string | undefined>("lovcode:activePanelId", undefined);

// ============================================================================
// Navigation State - URL is the source of truth
// ============================================================================

interface NavigationState {
  history: View[];
  index: number;
}

/** Route pattern to feature type mapping */
function routeToFeature(route: string): FeatureType | null {
  const map: Record<string, FeatureType> = {
    mcp: "mcp", skills: "skills", hooks: "hooks", agents: "sub-agents",
    "output-styles": "output-styles", statusline: "statusline",
    commands: "commands", settings: "settings",
  };
  return map[route] ?? null;
}

/**
 * Parse URL hash to View SYNCHRONOUSLY at module load time.
 * This runs BEFORE React renders, ensuring correct initial state.
 */
function parseUrlToView(hash: string): View {
  const path = hash.startsWith("/") ? hash.slice(1) : hash;
  const segments = path.split("/").filter(Boolean);

  if (segments.length === 0) return { type: "chat-projects" };

  const [first, second] = segments;

  switch (first) {
    case "workspace": return { type: "workspace" };
    case "features": return { type: "features" };
    case "annual-report-2025": return { type: "annual-report-2025" };
    case "mcp": return { type: "mcp" };
    case "skills": return { type: "skills" }; // Detail handled async later
    case "hooks": return { type: "hooks" };
    case "agents": return { type: "sub-agents" };
    case "output-styles": return { type: "output-styles" };
    case "statusline": return { type: "statusline" };
    case "commands": return { type: "commands" }; // Detail handled async later
    case "settings": {
      if (!second) return { type: "settings" };
      switch (second) {
        case "env": return { type: "basic-env" };
        case "llm": return { type: "basic-llm" };
        case "maas": return { type: "basic-maas" };
        case "version": return { type: "basic-version" };
        case "context": return { type: "basic-context" };
        default: return { type: "settings" };
      }
    }
    case "chat": {
      if (!second) return { type: "chat-projects" };
      return { type: "chat-sessions", projectId: decodeURIComponent(second), projectPath: "" };
    }
    case "knowledge": {
      if (second === "distill") return { type: "kb-distill" };
      if (second === "reference") return { type: "kb-reference" };
      return { type: "home" };
    }
    case "marketplace": {
      if (!second) return { type: "marketplace" };
      return { type: "marketplace", category: second as TemplateCategory };
    }
    case "todo": {
      if (second) {
        const feature = routeToFeature(second);
        if (feature) return { type: "feature-todo", feature };
      }
      return { type: "home" };
    }
    default:
      return { type: "home" };
  }
}

// ============================================================================
// Initialize from URL at MODULE LOAD TIME (before React renders!)
// ============================================================================
const urlHash = typeof window !== "undefined" ? window.location.hash.slice(1) : "/";
const initialViewFromUrl = parseUrlToView(urlHash || "/");
const initialNavState: NavigationState = { history: [initialViewFromUrl], index: 0 };

// Plain atom - URL determines initial state, not localStorage
export const navigationStateAtom = atom<NavigationState>(initialNavState);

// 派生 atoms（保持兼容性）
// 使用 get/set 格式确保是 writable atom，避免 "not writable atom" 错误
export const viewAtom = atom(
  (get) => {
    const state = get(navigationStateAtom);
    return state.history[state.index] ?? { type: "home" };
  },
  (get, set, newView: View) => {
    const state = get(navigationStateAtom);
    const newHistory = state.history.slice(0, state.index + 1);
    newHistory.push(newView);
    let newIndex = state.index + 1;
    if (newHistory.length > 50) {
      newHistory.shift();
      newIndex = 49;
    }
    set(navigationStateAtom, { history: newHistory, index: newIndex });
  }
);

export const viewHistoryAtom = atom(
  (get) => get(navigationStateAtom).history,
  (_get, _set, _newHistory: View[]) => {
    // Read-only in practice, but provides setter to avoid "not writable atom" error
  }
);

export const historyIndexAtom = atom(
  (get) => get(navigationStateAtom).index,
  (get, set, newIndex: number) => {
    const state = get(navigationStateAtom);
    if (newIndex >= 0 && newIndex < state.history.length) {
      set(navigationStateAtom, { ...state, index: newIndex });
    }
  }
);
