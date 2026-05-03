import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo, listen } from "@tauri-apps/api/event";
import { FileText, Hash, Layers3, Loader2, Search, Tags, type LucideIcon } from "lucide-react";
import type { Session } from "../types";
import { formatDate } from "../views/Chat/utils";
import { HighlightText } from "../views/Chat/HighlightText";

type SearchMode = "all" | "fullText" | "sessionId" | "metadata";

interface SearchModeOption {
  id: SearchMode;
  label: string;
  placeholder: string;
  emptyLabel: string;
  shortcut: string;
  icon: LucideIcon;
}

interface SearchChatHit {
  session_id: string;
}

const SEARCH_MODES: SearchModeOption[] = [
  {
    id: "all",
    label: "All",
    placeholder: "Search conversations, content, or session id...",
    emptyLabel: "Search all conversations",
    shortcut: "1",
    icon: Layers3,
  },
  {
    id: "fullText",
    label: "Full text",
    placeholder: "Search transcript text...",
    emptyLabel: "Search transcript text",
    shortcut: "2",
    icon: FileText,
  },
  {
    id: "sessionId",
    label: "Session ID",
    placeholder: "Paste or type a session id...",
    emptyLabel: "Search by session id",
    shortcut: "3",
    icon: Hash,
  },
  {
    id: "metadata",
    label: "Details",
    placeholder: "Search titles, summaries, and projects...",
    emptyLabel: "Search session details",
    shortcut: "4",
    icon: Tags,
  },
];

function getProjectName(session: Session) {
  return session.project_path?.split("/").filter(Boolean).pop() ?? "";
}

function normalizeSearchValue(value: string | null | undefined) {
  return (value ?? "").toLowerCase();
}

function compactSearchValue(value: string) {
  return value.replace(/[-_\s]/g, "");
}

function matchesSessionId(session: Session, normalizedQuery: string) {
  const sessionId = normalizeSearchValue(session.id);
  const compactQuery = compactSearchValue(normalizedQuery);
  return sessionId.includes(normalizedQuery) || (
    compactQuery.length > 0 && compactSearchValue(sessionId).includes(compactQuery)
  );
}

function matchesMetadata(session: Session, normalizedQuery: string) {
  const haystack = [
    session.title,
    session.summary,
    session.last_prompt,
    session.project_path,
    getProjectName(session),
    session.source,
  ].map(normalizeSearchValue).join("\n");

  return haystack.includes(normalizedQuery);
}

function uniqueSessions(groups: Session[][]) {
  const seen = new Set<string>();
  const ordered: Session[] = [];

  for (const group of groups) {
    for (const session of group) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      ordered.push(session);
    }
  }

  return ordered;
}

function getModeLabel(mode: SearchMode) {
  return SEARCH_MODES.find((item) => item.id === mode)?.label ?? "All";
}

function getMatchLabel(
  session: Session,
  query: string,
  mode: SearchMode,
  contentMatchIds: Set<string>
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (mode === "fullText") return "Text";
  if (mode === "sessionId") return "ID";
  if (matchesSessionId(session, normalizedQuery)) return "ID";
  if (matchesMetadata(session, normalizedQuery)) return "Details";
  if (contentMatchIds.has(session.id)) return "Text";
  return "Match";
}

export default function SearchOverlay() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Session[]>([]);
  const [searching, setSearching] = useState(false);
  const [indexReady, setIndexReady] = useState(false);
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [searchMode, setSearchMode] = useState<SearchMode>("all");
  const [contentMatchIds, setContentMatchIds] = useState<Set<string>>(new Set());
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sessionsById = useMemo(() => {
    return new Map(allSessions.map((session) => [session.id, session]));
  }, [allSessions]);
  const selectedMode = SEARCH_MODES.find((mode) => mode.id === searchMode) ?? SEARCH_MODES[0];
  const SelectedModeIcon = selectedMode.icon;
  const fullTextIndexing = !indexReady && (searchMode === "all" || searchMode === "fullText");
  const fullTextModePending = !indexReady && searchMode === "fullText";

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
    const unlisten = listen("search-overlay:show", () => {
      setQuery("");
      setActiveIdx(0);
      setSearchMode("all");
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    // Also try to focus immediately on first mount.
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
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
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setResults([]);
      setContentMatchIds(new Set());
      setSearching(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const normalizedQuery = trimmedQuery.toLowerCase();
        const wantsSessionId = searchMode === "all" || searchMode === "sessionId";
        const wantsMetadata = searchMode === "all" || searchMode === "metadata";
        const wantsFullText = searchMode === "all" || searchMode === "fullText";

        const sessionIdMatches = wantsSessionId
          ? allSessions.filter((session) => matchesSessionId(session, normalizedQuery))
          : [];
        const metadataMatches = wantsMetadata
          ? allSessions.filter((session) => matchesMetadata(session, normalizedQuery))
          : [];

        let nextContentMatchIds = new Set<string>();
        let contentMatches: Session[] = [];

        if (wantsFullText && indexReady) {
          const contentResults = await invoke<SearchChatHit[]>(
            "search_chats",
            { query: trimmedQuery, limit: searchMode === "fullText" ? 150 : 100 }
          ).catch(() => []);

          const orderedContentIds: string[] = [];
          nextContentMatchIds = new Set();

          for (const result of contentResults) {
            if (nextContentMatchIds.has(result.session_id)) continue;
            nextContentMatchIds.add(result.session_id);
            orderedContentIds.push(result.session_id);
          }

          contentMatches = orderedContentIds
            .map((id) => sessionsById.get(id))
            .filter((session): session is Session => session !== undefined);
        }

        if (cancelled) return;

        const nextResults = searchMode === "fullText"
          ? contentMatches
          : searchMode === "sessionId"
            ? sessionIdMatches
            : searchMode === "metadata"
              ? metadataMatches
              : uniqueSessions([sessionIdMatches, metadataMatches, contentMatches]);

        setContentMatchIds(nextContentMatchIds);
        setResults(nextResults);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, allSessions, sessionsById, indexReady, searchMode]);

  useEffect(() => { setActiveIdx(0); }, [query, searchMode, results.length]);

  const hide = () => {
    getCurrentWindow().hide().catch(() => {});
  };

  const onSelect = (s: Session) => {
    emitTo("main", "open-chat", {
      projectId: s.project_id,
      projectPath: s.project_path || "",
      sessionId: s.id,
      summary: s.summary,
    }).catch(() => {});
    hide();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); hide(); return; }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      const nextMode = SEARCH_MODES.find((mode) => mode.shortcut === e.key);
      if (nextMode) {
        e.preventDefault();
        setSearchMode(nextMode.id);
        return;
      }
    }
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
      className="fixed inset-0 flex items-start justify-center px-3 pb-6 pt-4 sm:px-6 sm:pt-6"
      onKeyDown={onKeyDown}
    >
      <div
        className="w-full max-w-3xl overflow-hidden rounded-2xl border border-border bg-card/95 shadow-2xl backdrop-blur-md"
      >
        <div className="border-b border-border bg-card/90">
          <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3" data-tauri-drag-region>
            <div className="flex min-w-0 items-center gap-2" data-tauri-drag-region>
              <Search className="h-4 w-4 shrink-0 text-primary" />
              <h1 className="truncate font-serif text-base font-semibold text-foreground">Search</h1>
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                {allSessions.length} sessions
              </span>
            </div>
            <kbd className="rounded-lg border border-border bg-card-alt px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              ESC
            </kbd>
          </div>

          <div className="px-4 pb-3">
            <div className="flex items-center gap-2 rounded-xl border border-input bg-background px-3 py-2 transition-colors focus-within:border-primary">
              <SelectedModeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={`${selectedMode.label} search`}
                placeholder={fullTextModePending ? "Building full-text index..." : selectedMode.placeholder}
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              {(searching || fullTextIndexing) && (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              )}
            </div>

            <div className="mt-2 grid grid-cols-4 gap-1 rounded-xl border border-border bg-card-alt p-1">
              {SEARCH_MODES.map((mode) => {
                const Icon = mode.icon;
                const isSelected = searchMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => setSearchMode(mode.id)}
                    aria-pressed={isSelected}
                    title={`⌘${mode.shortcut}`}
                    className={`flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] font-medium transition-colors sm:text-xs ${
                      isSelected
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-card/70 hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{mode.label}</span>
                    <span className={`hidden rounded border px-1 font-mono text-[10px] sm:inline ${
                      isSelected ? "border-border text-muted-foreground" : "border-transparent text-muted-foreground/70"
                    }`}>
                      {mode.shortcut}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {!query.trim() ? (
            <div className="px-4 py-8 text-center">
              <div className="font-serif text-base font-semibold text-foreground">{selectedMode.emptyLabel}</div>
              <div className="mt-1 text-xs text-muted-foreground">{getModeLabel(searchMode)}</div>
            </div>
          ) : fullTextModePending ? (
            <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Building full-text index</span>
            </div>
          ) : results.length === 0 && !searching ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No results in {getModeLabel(searchMode)}
            </div>
          ) : (
            <div className="py-1" aria-label="Search results">
              <div className="flex items-center justify-between gap-3 px-4 py-1.5 text-[11px] text-muted-foreground">
                <span>{searching ? "Searching" : `${results.length} result${results.length === 1 ? "" : "s"}`}</span>
                <span>{getModeLabel(searchMode)}</span>
              </div>
              {results.map((s, i) => {
                const title = s.title || s.summary || s.last_prompt || "Untitled";
                const projectName = getProjectName(s);
                const isActive = i === activeIdx;
                const matchLabel = getMatchLabel(s, query, searchMode, contentMatchIds);
                return (
                  <button
                    key={s.id}
                    onClick={() => onSelect(s)}
                    onMouseEnter={() => setActiveIdx(i)}
                    aria-current={isActive ? "true" : undefined}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                      isActive ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-card-alt hover:text-foreground"
                    }`}
                  >
                    <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full border border-current opacity-50" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        <HighlightText text={title} query={query} />
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground/75">
                        {projectName && (
                          <span className="truncate">
                            <HighlightText text={projectName} query={query} />
                          </span>
                        )}
                        <span className="min-w-0 truncate font-mono">
                          <HighlightText text={s.id} query={query} />
                        </span>
                      </div>
                    </div>
                    <span className={`hidden shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-medium sm:inline ${
                      isActive ? "bg-card text-primary" : "bg-card-alt text-muted-foreground"
                    }`}>
                      {matchLabel}
                    </span>
                    <div className="flex shrink-0 flex-col items-end gap-0.5 text-[10px] text-muted-foreground tabular-nums">
                      <span>{formatDate(s.last_modified)}</span>
                      <span title={`${s.message_count} messages total`}>{s.rounds} rounds</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-[10px] text-muted-foreground/80">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-card-alt px-1 font-mono">↑</kbd>
              <kbd className="rounded border border-border bg-card-alt px-1 font-mono">↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-card-alt px-1 font-mono">↵</kbd>
              open
            </span>
          </div>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-card-alt px-1 font-mono">⌘</kbd>
            <kbd className="rounded border border-border bg-card-alt px-1 font-mono">1-4</kbd>
            modes
          </span>
        </div>
      </div>
    </div>
  );
}
