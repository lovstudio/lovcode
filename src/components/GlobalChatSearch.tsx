import { useEffect, useRef, useState } from "react";
import { atom, useAtom, useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { Window } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { register, unregister, isRegistered } from "@tauri-apps/plugin-global-shortcut";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { useInvokeQuery } from "../hooks";
import { viewAtom, globalChatSearchHotkeyAtom } from "../store";
import type { Session } from "../types";
import { useReadableText, formatDate } from "../views/Chat/utils";
import { HighlightText } from "../views/Chat/HighlightText";

export const chatSearchOpenAtom = atom(false);

const SYSTEM_HOTKEY = "CmdOrCtrl+K";
const SEARCH_WINDOW_LABEL = "search";

async function toggleSearchWindow() {
  try {
    const win = await Window.getByLabel(SEARCH_WINDOW_LABEL);
    if (!win) return;
    if (await win.isVisible()) {
      await win.hide();
      return;
    }
    await win.center();
    await win.show();
    await win.setFocus();
    // Tell the overlay to clear its query and re-focus the input.
    emit("search-overlay:show").catch(() => {});
  } catch (err) {
    console.warn("[search-window] toggle failed:", err);
  }
}

export function GlobalChatSearch() {
  const [open, setOpen] = useAtom(chatSearchOpenAtom);
  const [, setView] = useAtom(viewAtom);
  const systemHotkey = useAtomValue(globalChatSearchHotkeyAtom);
  const toReadable = useReadableText();

  const { data: allSessions = [] } = useInvokeQuery<Session[]>(["sessions"], "list_all_sessions");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Session[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [indexReady, setIndexReady] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Listen for navigation requests emitted by the overlay window. Only the
  // main window has a viewAtom, so this handler stays here.
  useEffect(() => {
    const unlisten = listen<{
      projectId: string;
      projectPath: string;
      sessionId: string;
      summary: string | null;
    }>("open-chat", (e) => {
      setView({
        type: "chat-messages",
        projectId: e.payload.projectId,
        projectPath: e.payload.projectPath,
        sessionId: e.payload.sessionId,
        summary: e.payload.summary,
      });
    });
    return () => { unlisten.then((fn) => fn()).catch(() => {}); };
  }, [setView]);

  // Window-level ⌘K. When the system hotkey is on, we still keep this so that
  // pressing ⌘K while the main window is focused brings up the overlay
  // window — same behavior as a system trigger, just no double-fire risk
  // because the system shortcut takes precedence when the app is foreground.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (systemHotkey) {
          toggleSearchWindow();
        } else {
          setOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen, systemHotkey]);

  // System-level ⌘K — fires even when the app is in the background. Just
  // shows the floating search window; the main window stays where it was.
  useEffect(() => {
    if (!systemHotkey) return;
    let cancelled = false;
    (async () => {
      try {
        if (await isRegistered(SYSTEM_HOTKEY)) {
          await unregister(SYSTEM_HOTKEY);
        }
        if (cancelled) return;
        await register(SYSTEM_HOTKEY, (e) => {
          if (e.state === "Pressed") toggleSearchWindow();
        });
      } catch (err) {
        console.warn("[global-shortcut] register failed:", err);
      }
    })();
    return () => {
      cancelled = true;
      unregister(SYSTEM_HOTKEY).catch(() => {});
    };
  }, [systemHotkey]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery("");
    }
  }, [open]);

  // Build search index lazily on first open.
  useEffect(() => {
    if (!open || indexReady) return;
    invoke<number>("build_search_index")
      .then(() => setIndexReady(true))
      .catch(() => {});
  }, [open, indexReady]);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const q = query.toLowerCase();
        const localMatches = allSessions.filter((s) => {
          const summary = (s.summary || "").toLowerCase();
          const title = (s.title || "").toLowerCase();
          return summary.includes(q) || title.includes(q);
        });

        if (indexReady) {
          const contentResults = await invoke<{ session_id: string }[]>(
            "search_chats", { query, limit: 100 }
          );
          const localIds = new Set(localMatches.map((m) => m.id));
          const contentSessionIds = new Set(
            contentResults.map((r) => r.session_id).filter((id) => !localIds.has(id))
          );
          const contentMatches = allSessions.filter((s) => contentSessionIds.has(s.id));
          setResults([...localMatches, ...contentMatches]);
        } else {
          setResults(localMatches);
        }
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, allSessions, indexReady]);

  if (!open) return null;

  return (
    <SearchModal
      query={query}
      onQueryChange={setQuery}
      results={results ?? []}
      searching={searching}
      indexReady={indexReady}
      inputRef={inputRef}
      toReadable={toReadable}
      onSelect={(s) => {
        setView({
          type: "chat-messages",
          projectId: s.project_id,
          projectPath: s.project_path || "",
          sessionId: s.id,
          summary: s.summary,
        });
        setOpen(false);
      }}
      onClose={() => setOpen(false)}
    />
  );
}

function SearchModal({
  query,
  onQueryChange,
  results,
  searching,
  indexReady,
  inputRef,
  toReadable,
  onSelect,
  onClose,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  results: Session[];
  searching: boolean;
  indexReady: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  toReadable: (s: string | null) => string;
  onSelect: (s: Session) => void;
  onClose: () => void;
}) {
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => { setActiveIdx(0); }, [query, results.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = results[activeIdx];
      if (s) onSelect(s);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <MagnifyingGlassIcon className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={indexReady ? "Search conversations..." : "Building search index..."}
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-muted-foreground focus:outline-none"
          />
          {searching && <span className="text-xs text-muted-foreground">...</span>}
          <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-border bg-card-alt text-muted-foreground">ESC</kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {!query.trim() ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Type to search across all conversations
            </div>
          ) : results.length === 0 && !searching ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">No results</div>
          ) : (
            <div className="py-1">
              {results.map((s, i) => {
                const title = s.title || toReadable(s.summary) || "Untitled";
                const projectName = s.project_path?.split("/").pop() ?? "";
                const isActive = i === activeIdx;
                return (
                  <button
                    key={s.id}
                    onClick={() => onSelect(s)}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={`w-full text-left flex items-center gap-2 px-4 py-2 text-sm transition-colors ${
                      isActive ? "bg-primary/10 text-ink" : "text-muted-foreground hover:bg-card-alt"
                    }`}
                  >
                    <span className="shrink-0 inline-block w-1.5 h-1.5 rounded-full border border-current opacity-50" />
                    <div className="truncate flex-1 min-w-0">
                      <div className="truncate">
                        <HighlightText text={title} query={query} />
                      </div>
                      {projectName && (
                        <div className="text-[11px] text-muted-foreground/70 truncate">
                          <HighlightText text={projectName} query={query} />
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-0.5 text-[10px] text-muted-foreground tabular-nums">
                      <span>{formatDate(s.last_modified)}</span>
                      <span title={`${s.message_count} messages total`}>{s.rounds} rounds</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-border text-[10px] text-muted-foreground/80">
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1 rounded border border-border bg-card-alt">↑</kbd>
            <kbd className="font-mono px-1 rounded border border-border bg-card-alt">↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1 rounded border border-border bg-card-alt">↵</kbd>
            open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1 rounded border border-border bg-card-alt">esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
