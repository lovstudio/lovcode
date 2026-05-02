import { useAtomValue } from "jotai";
import { originalChatAtom } from "../../store";

export function restoreSlashCommand(content: string): string {
  // Use [\s\S]*? to match any chars including newlines between tags
  const pattern = /<command-message>[\s\S]*?<\/command-message>[\s\S]*?<command-name>(\/[^\n<]+)<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/g;
  return content.replace(pattern, (_match, cmd, args) => {
    const trimmedArgs = (args || "").trim();
    return trimmedArgs ? `${cmd} ${trimmedArgs}` : cmd;
  });
}

export function formatRelativeTime(ts: number): string {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

// Best-effort provider/family/window inference from a raw model id seen in session usage.
// Only covers the model families this app cares about today (Anthropic Claude + OpenAI/Codex).
// Returns null fields when unknown rather than guessing.
export interface ModelInfo {
  provider: string | null;
  name: string;
  contextWindow: number | null;
}

export function inferModelInfo(model: string | undefined | null): ModelInfo | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("claude")) {
    return { provider: "Anthropic", name: model, contextWindow: 200_000 };
  }
  if (m.startsWith("gpt-5") || m.startsWith("o3") || m.startsWith("o1") || m.includes("codex")) {
    return { provider: "OpenAI", name: model, contextWindow: 128_000 };
  }
  if (m.startsWith("gpt-4")) {
    return { provider: "OpenAI", name: model, contextWindow: 128_000 };
  }
  if (m.includes("gemini")) {
    return { provider: "Google", name: model, contextWindow: 1_000_000 };
  }
  return { provider: null, name: model, contextWindow: null };
}

/** Hook that returns a function to convert text based on global readable setting */
export function useReadableText(): (text: string | null | undefined) => string {
  const readable = useAtomValue(originalChatAtom);
  return (text) => {
    if (!text) return "";
    return readable ? restoreSlashCommand(text) : text;
  };
}
