import { useCallback } from "react";
import { useAtomValue } from "jotai";
import { originalChatAtom } from "../../store";

export function restoreSlashCommand(content: string): string {
  // Match a <command-name> block plus optional sibling <command-message> / <command-args>
  // blocks in any order. Claude Code emits user-defined commands as
  // <command-message>…</command-message><command-name>…</command-name>… while built-in
  // commands like /clear emit <command-name>…</command-name><command-message>…</command-message>.
  const pattern = /(?:<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>\s*){1,4}/g;
  let out = content.replace(pattern, (block) => {
    const nameMatch = block.match(/<command-name>(\/[^\n<]+)<\/command-name>/);
    if (!nameMatch) return block;
    const argsMatch = block.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const trimmedArgs = (argsMatch?.[1] ?? "").trim();
    return trimmedArgs ? `${nameMatch[1]} ${trimmedArgs}` : nameMatch[1];
  });
  // Drop Claude Code internal caveat blocks injected at session start / on resume.
  out = out.replace(/<local-command-(?:caveat|stdout|stderr)>[\s\S]*?<\/local-command-(?:caveat|stdout|stderr)>\s*/g, "");
  return out.trim();
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
  return useCallback((text) => {
    if (!text) return "";
    return readable ? restoreSlashCommand(text) : text;
  }, [readable]);
}

import type { Session, TitleSource } from "../../types";

export interface SessionLabel {
  text: string;
  source: TitleSource;
}

/**
 * Resolve a session's display label and tag where it came from.
 *
 * Priority chain mirrors Claude Code's own `readLiteMetadata` plus a
 * `lastPrompt` fallback for the ~70% of CLI sessions that have no title at
 * all. The UI badges each source so users can tell a hand-set title from a
 * Haiku-generated one from a "we just used your last message".
 */
export function resolveSessionLabel(
  session: Session,
  toReadable: (s: string | null) => string,
): SessionLabel {
  const title = toReadable(session.title);
  if (title) {
    // Backend already labeled how it picked title (custom/ai/slug). Trust it.
    const src = (session.title_source ?? "custom") as TitleSource;
    return { text: title, source: src };
  }
  const summary = toReadable(session.summary);
  if (summary) return { text: summary, source: "summary" };
  const prompt = toReadable(session.last_prompt ?? null);
  if (prompt) {
    // Truncate aggressively — lastPrompt can be the entire pasted message.
    const oneLine = prompt.replace(/\s+/g, " ").trim();
    const text = oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
    return { text, source: "prompt" };
  }
  return { text: `Session ${session.id.slice(0, 8)}`, source: "none" };
}

/** Short human label for a title source — used as a small badge in the UI. */
export function titleSourceBadge(source: TitleSource): string | null {
  switch (source) {
    case "custom": return "已命名";
    case "ai":     return "AI 标题";
    case "slug":   return "Slug";
    case "summary":return "Compact 摘要";
    case "prompt": return "最近 prompt";
    case "none":   return "未命名";
    default:       return null;
  }
}
