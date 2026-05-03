import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";
import type { Session } from "../types";
import { formatDate } from "../views/Chat/utils";
import { HighlightText } from "../views/Chat/HighlightText";

const SEARCH_HIDE_EVENT = "search-overlay:hide";

export default function SearchOverlay() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Session[]>([]);
  const [searching, setSearching] = useState(false);
  const [indexReady, setIndexReady] = useState(false);
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Make html/body transparent so only the floating card paints. This window
  // has `transparent: true` in tauri.conf.json — without this the canvas
  // background bleeds through as a solid block.
  useEffect(() => {
    document.documentElement.classList.add("transparent-window");
    return () => { document.documentElement.classList.remove("transparent-window"); };
  }, []);

  // Convert this window into a nonactivating NSPanel on macOS so showing it
  // doesn't bring the lovcode app to the foreground. Idempotent — safe to
  // call once on mount.
  useEffect(() => {
    invoke("make_window_nonactivating_panel").catch((err) => {
      console.warn("[search-overlay] panel conversion failed:", err);
    });
  }, []);

  // Hide on blur — Spotlight-style dismiss when user clicks elsewhere.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) hide();
    });
    return () => { unlisten.then((fn) => fn()).catch(() => {}); };
  }, []);

  // Re-focus input every time the overlay becomes visible / focused.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = listen("search-overlay:show", () => {
      setQuery("");
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    // Also try to focus immediately on first mount.
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
      void win;
    };
  }, []);

  // Load sessions + build index lazily on first mount.
  useEffect(() => {
    invoke<Session[]>("list_all_sessions").then(setAllSessions).catch(() => {});
    invoke<number>("build_search_index")
      .then(() => setIndexReady(true))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
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

  useEffect(() => { setActiveIdx(0); }, [query, results.length]);

  const hide = () => {
    getCurrentWindow().hide().catch(() => {});
  };

  const onSelect = (s: Session) => {
    emit("open-chat", {
      projectId: s.project_id,
      projectPath: s.project_path || "",
      sessionId: s.id,
      summary: s.summary,
    }).catch(() => {});
    hide();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); hide(); return; }
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
      className="fixed inset-0 flex items-start justify-center pt-6 px-6 pb-6"
      onKeyDown={onKeyDown}
    >
      <div
        className="w-full max-w-2xl bg-card/95 backdrop-blur-md border border-border rounded-2xl shadow-2xl overflow-hidden"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border" data-tauri-drag-region>
          <MagnifyingGlassIcon className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
                const title = s.title || s.summary || "Untitled";
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

void SEARCH_HIDE_EVENT;
