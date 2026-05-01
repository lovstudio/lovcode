import { useState, useMemo, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDownIcon, ChevronRightIcon, DotsHorizontalIcon, ListBulletIcon, GroupIcon, MagnifyingGlassIcon, Cross2Icon } from "@radix-ui/react-icons";
import { Copy, Upload, ChevronUp, ChevronDown, Pin, RefreshCw } from "lucide-react";
import { useAtom } from "jotai";
import {
  allProjectsSortByAtom,
  hideEmptySessionsAllAtom,
  originalChatAtom,
  markdownPreviewAtom,
  userPromptsOnlyAtom,
  pinnedSessionIdsAtom,
  unpinnedAppIdsAtom,
  pinnedCollapsedAtom,
  recentCollapsedAtom,
  importCollapsedAtom,
} from "../../store";
import { useAppConfig } from "../../context";
import { useReadableText } from "./utils";
import { useInvokeQuery, useQueryClient } from "../../hooks";
import { CollapsibleContent } from "./CollapsibleContent";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import { HighlightText } from "./HighlightText";
import { ProjectLogo } from "../Workspace/ProjectLogo";
import { ActivityCard } from "../../components/home";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
} from "../../components/ui/dropdown-menu";
import {
  SessionDropdownMenuItems,
} from "../../components/shared/SessionMenuItems";
import { ExportDialog } from "./ExportDialog";
import type { Project, Session, ChatMessage, Message } from "../../types";

interface ProjectListProps {
  onSelectProject: (p: Project) => void;
  onSelectSession: (s: Session) => void;
  onSelectChat?: (c: ChatMessage) => void;
}

export function ProjectList({ onSelectProject, onSelectSession }: ProjectListProps) {
  const toReadable = useReadableText();
  const queryClient = useQueryClient();

  const { data: projects = [], isLoading: loadingProjects } = useInvokeQuery<Project[]>(["projects"], "list_projects");
  const { data: allSessions = [], isLoading: loadingSessions } = useInvokeQuery<Session[]>(["sessions"], "list_all_sessions");

  const [importing, setImporting] = useState(false);
  const [dataSource, setDataSource] = useState<"all" | "local" | "web" | "app">("all");

  const [sortBy, setSortBy] = useAtom(allProjectsSortByAtom);
  const [hideEmptySessions, setHideEmptySessions] = useAtom(hideEmptySessionsAllAtom);
  const [pinnedIds, setPinnedIds] = useAtom(pinnedSessionIdsAtom);
  const [unpinnedAppIds, setUnpinnedAppIds] = useAtom(unpinnedAppIdsAtom);
  const [pinnedCollapsed, setPinnedCollapsed] = useAtom(pinnedCollapsedAtom);
  const [recentCollapsed, setRecentCollapsed] = useAtom(recentCollapsedAtom);
  const [importCollapsed, setImportCollapsed] = useAtom(importCollapsedAtom);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string> | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [grouped, setGrouped] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchResults, setSearchResults] = useState<Session[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [indexReady, setIndexReady] = useState(false);
  const detailScrollRef = useRef<HTMLDivElement>(null);

  // Default all projects to collapsed on first load
  useEffect(() => {
    if (collapsedGroups === null && projects.length > 0) {
      setCollapsedGroups(new Set(projects.map((p) => p.id)));
    }
  }, [projects, collapsedGroups]);

  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    } else {
      setSearchQuery("");
    }
  }, [searchOpen]);

  // Global ⌘K / Ctrl+K to open search modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Build search index on mount
  useEffect(() => {
    invoke<number>("build_search_index")
      .then(() => setIndexReady(true))
      .catch(() => {});
  }, []);

  // Auto-sync claude.ai web conversations on mount.
  // Reads the Claude desktop app's session cookie (decrypted via macOS Keychain),
  // calls claude.ai API, and writes new/changed conversations into
  // ~/.claude/projects/-claude-ai/. Failures are silent (Claude app may not be
  // installed/logged-in).
  const [webSyncing, setWebSyncing] = useState(false);
  const [webSyncError, setWebSyncError] = useState<string | null>(null);
  const [webSyncProgress, setWebSyncProgress] = useState<{ processed: number; total: number; fetched: number; failed: number } | null>(null);

  // Trigger a list refresh every ~20 newly-fetched conversations so the user
  // sees results streaming in instead of waiting for the whole batch.
  const lastInvalidatedAtRef = useRef(0);
  useEffect(() => {
    const unlistenP = listen<{ processed: number; total: number; fetched: number; skipped: number; failed: number }>(
      "web-sync-progress",
      (e) => {
        setWebSyncProgress({
          processed: e.payload.processed,
          total: e.payload.total,
          fetched: e.payload.fetched,
          failed: e.payload.failed,
        });
        if (e.payload.fetched - lastInvalidatedAtRef.current >= 20) {
          lastInvalidatedAtRef.current = e.payload.fetched;
          queryClient.invalidateQueries({ queryKey: ["projects"] });
          queryClient.invalidateQueries({ queryKey: ["sessions"] });
        }
      }
    );
    return () => { unlistenP.then((fn) => fn()).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const syncWebFromApp = async () => {
    if (webSyncing) return;
    setWebSyncing(true);
    setWebSyncError(null);
    lastInvalidatedAtRef.current = 0;
    try {
      const result = await invoke<{ fetched: number; skipped_unchanged: number; failed: number }>(
        "sync_claude_web_conversations"
      );
      // Always invalidate — even if 0 fetched, the project dir may have been
      // created with .display_name, which affects hasWebData / project list.
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      console.log("[web-sync]", result);
      // Re-pull starred ids now that the web-starred cache file is fresh
      syncPinsFromApp();
    } catch (e) {
      console.warn("[web-sync] failed:", e);
      setWebSyncError(String(e));
    } finally {
      setWebSyncing(false);
      setWebSyncProgress(null);
    }
  };
  // Lazy sync: only fire when the user actually opens the Web tab. This avoids
  // triggering a macOS Keychain prompt for users who never look at web data.
  // Sync runs at most once per app launch; user can re-trigger via the
  // dropdown menu's "Sync from claude.ai (live)" item.
  const webSyncedRef = useRef(false);
  useEffect(() => {
    if (webSyncedRef.current) return;
    if (dataSource !== "web") return;
    webSyncedRef.current = true;
    syncWebFromApp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource]);

  // Sync pinned state from Claude desktop app's "starredIds".
  //
  // Storage model:
  //   - pinnedIds (atomWithStorage)  = user's manual pins ONLY (source-agnostic)
  //   - appStarredIds (in-memory)    = pins coming from Claude app (source=app)
  //   - effectivePinnedSet           = union, used for display
  //
  // This way the user's local pin set is never polluted by app starredIds. If
  // the user un-stars something in the app, it disappears here on next sync
  // automatically. If the user clicks pin on a CLI/web session, it persists
  // even when the app un-stars sessions. Code tab will only show user pins
  // because app sessions are filtered out by dataSource.
  const [appStarredIds, setAppStarredIds] = useState<string[]>([]);
  const syncPinsFromApp = async () => {
    try {
      const appStarred = await invoke<string[]>("get_app_starred_session_ids");
      setAppStarredIds(appStarred);
    } catch {
      // Claude app may not be installed or starredIds not yet written
    }
  };

  // Auto-sync once when the sessions list becomes available.
  // Also cleans up legacy state: previous versions of this code merged app
  // starredIds INTO pinnedIds, so users may have stale app-session ids in
  // their localStorage. Strip them on first run so the new dual-store model
  // is consistent.
  const syncedRef = useRef(false);
  useEffect(() => {
    if (syncedRef.current) return;
    if (allSessions.length === 0) return;
    syncedRef.current = true;
    const appSessionIdSet = new Set(allSessions.filter((s) => s.source === "app").map((s) => s.id));
    setPinnedIds((prev) => {
      const cleaned = prev.filter((id) => !appSessionIdSet.has(id));
      return cleaned.length === prev.length ? prev : cleaned;
    });
    syncPinsFromApp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSessions]);

  // Effective pin set for display = (user pins ∪ app starred) − local-overrides.
  // appStarredIds is in-memory mirror from Claude app/web sync.
  // unpinnedAppIds is the user's local "I don't want this app-starred session
  // pinned in lovcode" override — lets togglePin work on Claude-starred items
  // without writing back to the upstream app.
  const appStarredSet = useMemo(() => new Set(appStarredIds), [appStarredIds]);
  const unpinnedAppSet = useMemo(() => new Set(unpinnedAppIds), [unpinnedAppIds]);
  const effectivePinnedSet = useMemo(() => {
    const s = new Set<string>(pinnedIds);
    for (const id of appStarredIds) {
      if (!unpinnedAppSet.has(id)) s.add(id);
    }
    return s;
  }, [pinnedIds, appStarredIds, unpinnedAppSet]);

  // Toggle handles three cases:
  //  1) user-pinned (in pinnedIds)         -> remove from pinnedIds
  //  2) app-starred & not overridden       -> add to unpinnedAppIds (local hide)
  //  3) app-starred & already overridden   -> remove from unpinnedAppIds (re-show)
  //  4) neither                            -> add to pinnedIds
  const togglePin = (id: string) => {
    if (pinnedIds.includes(id)) {
      setPinnedIds((prev) => prev.filter((x) => x !== id));
    } else if (appStarredSet.has(id) && !unpinnedAppSet.has(id)) {
      setUnpinnedAppIds((prev) => prev.includes(id) ? prev : [...prev, id]);
    } else if (unpinnedAppSet.has(id)) {
      setUnpinnedAppIds((prev) => prev.filter((x) => x !== id));
    } else {
      setPinnedIds((prev) => [...prev, id]);
    }
  };

  // Garbage-collect unpinnedAppIds: if Claude app no longer stars an id,
  // we don't need to keep an override for it.
  useEffect(() => {
    if (appStarredIds.length === 0) return;
    setUnpinnedAppIds((prev) => {
      const next = prev.filter((id) => appStarredSet.has(id));
      return next.length === prev.length ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appStarredIds]);

  // Full-text search across session summaries/titles + content via search_chats
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const q = searchQuery.toLowerCase();
        // Local matches by summary/title
        const localMatches = allSessions.filter((s) => {
          const summary = (s.summary || "").toLowerCase();
          const title = (s.title || "").toLowerCase();
          return summary.includes(q) || title.includes(q);
        });

        if (indexReady) {
          // Full-text search for conversation content matches
          const contentResults = await invoke<{ session_id: string }[]>(
            "search_chats", { query: searchQuery, limit: 100 }
          );
          const localIds = new Set(localMatches.map((m) => m.id));
          const contentSessionIds = new Set(
            contentResults.map((r) => r.session_id).filter((id) => !localIds.has(id))
          );
          const contentMatches = allSessions.filter((s) => contentSessionIds.has(s.id));
          setSearchResults([...localMatches, ...contentMatches]);
        } else {
          setSearchResults(localMatches);
        }
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, allSessions, indexReady]);

  const loading = loadingProjects || loadingSessions;

  // Web and App tabs are always shown — they represent first-class data
  // sources (claude.ai web conversations, Claude desktop app Code sessions),
  // independent of whether any data has been synced yet.
  const hasWebData = true;
  const hasAppData = true;

  // Sessions visible under the current data source — used for the header counter
  // so it matches what the user actually sees in the list.
  const visibleSessions = useMemo(() => {
    return allSessions.filter((s) => {
      if (dataSource === "local") return s.project_id !== "-claude-ai" && s.source !== "app";
      if (dataSource === "web") return s.project_id === "-claude-ai";
      if (dataSource === "app") return s.source === "app";
      return true;
    });
  }, [allSessions, dataSource]);

  const sortedProjects = useMemo(() => {
    const filtered = projects.filter((p) => {
      if (p.session_count === 0) return false;
      if (dataSource === "local") return p.id !== "-claude-ai";
      if (dataSource === "web") return p.id === "-claude-ai";
      if (dataSource === "app") {
        // Only show projects that have at least one app session
        return allSessions.some((s) => s.source === "app" && s.project_id === p.id);
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "recent": return b.last_active - a.last_active;
        case "sessions": return b.session_count - a.session_count;
        case "name": return a.path.localeCompare(b.path);
      }
    });
  }, [projects, allSessions, sortBy, dataSource]);

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, Session[]>();
    const normalizePath = (p: string) => p.replace(/\/+$/, "");

    for (const project of sortedProjects) {
      const projectPathNorm = normalizePath(project.path);
      const sessions = allSessions
        .filter((s) => {
          if (!s.project_path) return false;
          if (hideEmptySessions && s.message_count === 0) return false;
          if (dataSource === "app" && s.source !== "app") return false;
          if (effectivePinnedSet.has(s.id)) return false; // surfaced in the top Pinned section
          return normalizePath(s.project_path) === projectPathNorm;
        })
        .sort((a, b) => {
          switch (sortBy) {
            case "recent": return b.last_modified - a.last_modified;
            case "sessions": return b.message_count - a.message_count;
            case "name": return (a.summary || "").localeCompare(b.summary || "");
          }
        });
      map.set(project.id, sessions);
    }
    return map;
  }, [sortedProjects, allSessions, sortBy, hideEmptySessions, dataSource, effectivePinnedSet]);

  // Pinned sessions surface as a dedicated top group (independent of grouped/flat mode).
  // Filtered the same way as the main list so the active data source / hide-empty toggles still apply.
  const pinnedSessions = useMemo(() => {
    if (effectivePinnedSet.size === 0) return [];
    const seen = new Set<string>();
    return allSessions
      .filter((s) => effectivePinnedSet.has(s.id))
      .filter((s) => {
        if (seen.has(s.id)) return false; // defensive dedupe — backend may emit dupes for same cliSessionId
        seen.add(s.id);
        if (hideEmptySessions && s.message_count === 0) return false;
        if (dataSource === "local") return s.project_id !== "-claude-ai" && s.source !== "app";
        if (dataSource === "web") return s.project_id === "-claude-ai";
        if (dataSource === "app") return s.source === "app";
        return true;
      })
      .sort((a, b) => b.last_modified - a.last_modified);
  }, [allSessions, effectivePinnedSet, hideEmptySessions, dataSource]);

  const flatSessions = useMemo(() => {
    if (grouped) return [];
    return allSessions
      .filter((s) => {
        if (s.message_count === 0 && hideEmptySessions) return false;
        if (effectivePinnedSet.has(s.id)) return false; // surfaced in the top Pinned section
        if (dataSource === "local") return s.project_id !== "-claude-ai" && s.source !== "app";
        if (dataSource === "web") return s.project_id === "-claude-ai";
        if (dataSource === "app") return s.source === "app";
        return true;
      })
      .sort((a, b) => {
        switch (sortBy) {
          case "recent": return b.last_modified - a.last_modified;
          case "sessions": return b.message_count - a.message_count;
          case "name": return (a.summary || "").localeCompare(b.summary || "");
        }
      });
  }, [allSessions, sortBy, hideEmptySessions, grouped, dataSource, effectivePinnedSet]);

  const doImport = async (path: string) => {
    setImporting(true);
    try {
      const result = await invoke<{ conversation_count: number }>("import_claude_web_data", { path });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      alert(`Imported ${result.conversation_count} conversations from claude.ai`);
    } catch (e) {
      alert(`Import failed: ${e}`);
    } finally {
      setImporting(false);
    }
  };

  const handleImportZip = async () => {
    const selected = await open({
      multiple: false,
      title: "Select claude.ai data export (.zip)",
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (selected) doImport(selected);
  };

  const toggleCollapse = (id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left Panel: Project Tree */}
      <div className="w-80 shrink-0 border-r border-border overflow-y-auto">
        <div className="px-4 py-4">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-serif text-lg font-semibold text-ink">Chat History</h2>
            <button
              onClick={() => setSearchOpen(true)}
              className="flex items-center gap-1.5 p-1.5 rounded-md text-muted-foreground hover:text-ink hover:bg-card-alt transition-colors"
              title="Search conversations (⌘K)"
            >
              <MagnifyingGlassIcon className="w-3.5 h-3.5" />
              <kbd className="text-[10px] font-mono px-1 rounded border border-border bg-card-alt/60 text-muted-foreground/80">⌘K</kbd>
            </button>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            {sortedProjects.length} projects · {visibleSessions.length} sessions
          </p>

          {/* Data source tabs */}
          {(hasWebData || hasAppData) && (
            <div className="flex gap-0.5 mb-2 p-0.5 rounded-lg bg-card-alt">
              {([
                { key: "all", label: "All" },
                { key: "local", label: "Code" },
                ...(hasAppData ? [{ key: "app", label: "App" }] : []),
                ...(hasWebData ? [{ key: "web", label: "Web" }] : []),
              ] as { key: typeof dataSource; label: string }[]).map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setDataSource(key)}
                  className={`flex-1 px-2 py-1 rounded-md text-xs transition-colors ${
                    dataSource === key
                      ? "bg-card text-ink shadow-sm"
                      : "text-muted-foreground hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Web tab status (only visible when Web tab is active) */}
          {dataSource === "web" && (webSyncing || webSyncError) && (
            <div className="mb-2 px-2 py-1.5 rounded-md bg-card-alt text-[11px]">
              {webSyncing && (
                <div className="flex items-center gap-1.5 text-primary/90">
                  <RefreshCw className="w-3 h-3 animate-spin shrink-0" />
                  <span className="truncate">
                    Syncing claude.ai
                    {webSyncProgress && ` · ${webSyncProgress.processed}/${webSyncProgress.total} (+${webSyncProgress.fetched}${webSyncProgress.failed ? ` ✗${webSyncProgress.failed}` : ""})`}
                  </span>
                </div>
              )}
              {!webSyncing && webSyncError && (
                <div className="text-destructive truncate" title={webSyncError}>
                  Web sync failed: {webSyncError}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Session List */}
        <div className="px-2 pb-4 space-y-0.5">
          {/* Pinned section — independent of grouped/flat, hidden during search */}
          {searchResults === null && pinnedSessions.length > 0 && (
            <div className="mb-1">
              <SectionHeader
                icon={<Pin className="w-3 h-3 fill-current text-primary/60" />}
                label="Pinned"
                count={pinnedSessions.length}
                collapsed={pinnedCollapsed}
                onToggle={() => setPinnedCollapsed(!pinnedCollapsed)}
              />
              {!pinnedCollapsed && (
                <div className="space-y-0.5">
                  {pinnedSessions.map((session) => (
                    <SessionItemButton
                      key={`pinned-${session.id}`}
                      session={session}
                      isSelected={selectedSession?.id === session.id}
                      onClick={() => setSelectedSession(prev => prev?.id === session.id ? null : session)}
                      onDoubleClick={() => onSelectSession(session)}
                      toReadable={toReadable}
                      showProject
                      isPinned
                      onTogglePin={() => togglePin(session.id)}
                    />
                  ))}
                </div>
              )}
              <div className="mx-2 my-1.5 border-t border-border/60" />
            </div>
          )}

          {searchResults !== null ? (
            // Search results (flat) — Pinned/Recent grouping suppressed during search
            searchResults.length === 0 ? (
              <div className="text-xs text-muted-foreground px-2 py-4 text-center">No results</div>
            ) : (
              searchResults.map((session) => (
                <SessionItemButton
                  key={session.id}
                  session={session}
                  isSelected={selectedSession?.id === session.id}
                  onClick={() => setSelectedSession(prev => prev?.id === session.id ? null : session)}
                  onDoubleClick={() => onSelectSession(session)}
                  toReadable={toReadable}
                  showProject
                  highlight={searchQuery}
                  isPinned={effectivePinnedSet.has(session.id)}
                  onTogglePin={() => togglePin(session.id)}
                />
              ))
            )
          ) : (
            // Recent section header (wraps grouped or flat list)
            <>
              <SectionHeader
                icon={<ListBulletIcon className="w-3 h-3" />}
                label="Recent"
                count={grouped ? sortedProjects.length : flatSessions.length}
                collapsed={recentCollapsed}
                onToggle={() => setRecentCollapsed(!recentCollapsed)}
                rightSlot={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="p-0.5 rounded hover:text-ink hover:bg-card-alt transition-colors opacity-0 group-hover:opacity-100"
                        title="Recent options"
                      >
                        <DotsHorizontalIcon className="w-3 h-3" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[200px]">
                      <DropdownMenuLabel className="text-xs">Sort by</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                        <DropdownMenuRadioItem value="recent">Recent</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setGrouped(!grouped)} className="gap-2">
                        {grouped ? <ListBulletIcon className="w-3.5 h-3.5" /> : <GroupIcon className="w-3.5 h-3.5" />}
                        {grouped ? "Flat view" : "Grouped view"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setHideEmptySessions(!hideEmptySessions)} className="gap-2">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          {hideEmptySessions ? (
                            <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><path d="m2 2 20 20"/></>
                          ) : (
                            <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></>
                          )}
                        </svg>
                        {hideEmptySessions ? "Show empty sessions" : "Hide empty sessions"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={syncPinsFromApp} className="gap-2">
                        <Pin className="w-3.5 h-3.5" />
                        Sync pins from Claude app
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
              {!recentCollapsed && (grouped ? (
            // Grouped by project
            sortedProjects.length === 0 ? (
              <div className="text-xs text-muted-foreground px-2 py-6 text-center">
                No {dataSource === "all" ? "" : dataSource === "local" ? "code " : dataSource === "app" ? "app " : "web "}sessions
              </div>
            ) : sortedProjects.map((project) => {
              const sessions = sessionsByProject.get(project.id) || [];
              const isCollapsed = collapsedGroups?.has(project.id) ?? true;
              const cleanPath = project.path.replace(/\/+$/, "");
              const projectName = cleanPath.split("/").filter(Boolean).pop() || cleanPath;

              return (
                <div key={project.id}>
                  <div
                    className="group flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer transition-colors hover:bg-card-alt"
                    onDoubleClick={() => onSelectProject(project)}
                    onClick={() => toggleCollapse(project.id)}
                  >
                    <ProjectLogo projectPath={project.path} size="sm" />
                    <span className="text-sm font-medium text-ink truncate flex-1" title={project.path}>
                      {projectName}
                    </span>
                    <span className="text-xs text-muted-foreground">{sessions.length}</span>
                    <span className="p-0.5 text-muted-foreground">
                      {isCollapsed ? (
                        <ChevronRightIcon className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDownIcon className="w-3.5 h-3.5" />
                      )}
                    </span>
                  </div>
                  {!isCollapsed && (
                    <div className="mt-0.5 space-y-0.5">
                      {sessions.length === 0 ? (
                        <div className="text-xs text-muted-foreground px-2 py-1">No sessions</div>
                      ) : (
                        sessions.map((session) => (
                          <SessionItemButton
                            key={session.id}
                            session={session}
                            isSelected={selectedSession?.id === session.id}
                            onClick={() => setSelectedSession(prev => prev?.id === session.id ? null : session)}
                            onDoubleClick={() => onSelectSession(session)}
                            toReadable={toReadable}
                            isPinned={effectivePinnedSet.has(session.id)}
                            onTogglePin={() => togglePin(session.id)}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            // Flat list
            flatSessions.length === 0 ? (
              <div className="text-xs text-muted-foreground px-2 py-6 text-center">
                No {dataSource === "all" ? "" : dataSource === "local" ? "code " : dataSource === "app" ? "app " : "web "}sessions
              </div>
            ) : flatSessions.map((session) => (
              <SessionItemButton
                key={session.id}
                session={session}
                isSelected={selectedSession?.id === session.id}
                onClick={() => setSelectedSession(prev => prev?.id === session.id ? null : session)}
                onDoubleClick={() => onSelectSession(session)}
                toReadable={toReadable}
                showProject
                isPinned={effectivePinnedSet.has(session.id)}
                onTogglePin={() => togglePin(session.id)}
              />
            ))
          ))}
            </>
          )}

          {/* Web tab — Import group at the end */}
          {searchResults === null && dataSource === "web" && (
            <div className="mb-1">
              <SectionHeader
                icon={<Upload className="w-3 h-3" />}
                label="Import"
                count={2}
                collapsed={importCollapsed}
                onToggle={() => setImportCollapsed(!importCollapsed)}
              />
              {!importCollapsed && (
                <div className="space-y-0.5">
                  <button
                    type="button"
                    onClick={syncWebFromApp}
                    disabled={webSyncing}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-muted-foreground hover:text-ink hover:bg-card-alt transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Decrypt local Claude desktop app cookies and pull conversations from claude.ai API"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${webSyncing ? "animate-spin" : ""}`} />
                    <span className="truncate flex-1 text-left">
                      {webSyncing ? "Syncing from local cookies..." : "Sync from local database"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={handleImportZip}
                    disabled={importing}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-muted-foreground hover:text-ink hover:bg-card-alt transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Import a claude.ai data export .zip"
                  >
                    <Upload className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate flex-1 text-left">Import from .zip</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel: Session Detail */}
      <div className="flex-1 overflow-y-auto" ref={detailScrollRef}>
        {selectedSession ? (
          <SessionDetail
            session={selectedSession}
            onClose={() => setSelectedSession(null)}
            highlight={searchResults !== null ? searchQuery : undefined}
            scrollRef={detailScrollRef}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full px-8 gap-4 text-muted-foreground text-sm">
            <span>Select a session to preview</span>
            <div className="w-full max-w-2xl">
              <ActivityCard />
            </div>
          </div>
        )}
      </div>

      {/* Algolia-style search modal */}
      {searchOpen && (
        <SearchModal
          query={searchQuery}
          onQueryChange={setSearchQuery}
          results={searchResults ?? []}
          searching={searching}
          indexReady={indexReady}
          inputRef={searchInputRef}
          toReadable={toReadable}
          onSelect={(s) => {
            setSelectedSession(s);
            setSearchOpen(false);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Algolia-style search modal
// ============================================================================

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
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                      {s.message_count}
                    </span>
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

// ============================================================================
// Section Header (Pinned / Recent / Import — DRY)
// ============================================================================

function SectionHeader({
  icon,
  label,
  count,
  collapsed,
  onToggle,
  rightSlot,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  rightSlot?: React.ReactNode;
}) {
  const collapsible = onToggle !== undefined && collapsed !== undefined;
  return (
    <div className="group flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground/80">
      <button
        type="button"
        onClick={onToggle}
        disabled={!collapsible}
        className="flex items-center gap-1.5 flex-1 hover:text-ink transition-colors min-w-0 disabled:cursor-default disabled:hover:text-muted-foreground/80"
      >
        {icon}
        <span>{label}</span>
        {count !== undefined && (
          <span className="text-muted-foreground/60 font-normal">{count}</span>
        )}
        {collapsible && (collapsed ? (
          <ChevronRightIcon className="w-3 h-3" />
        ) : (
          <ChevronDownIcon className="w-3 h-3" />
        ))}
        <span className="ml-auto" />
      </button>
      {rightSlot}
    </div>
  );
}

// ============================================================================
// Session Item Button (shared between grouped & flat)
// ============================================================================

function SessionItemButton({
  session,
  isSelected,
  onClick,
  onDoubleClick,
  toReadable,
  showProject,
  highlight,
  isPinned,
  onTogglePin,
}: {
  session: Session;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  toReadable: (s: string | null) => string;
  showProject?: boolean;
  highlight?: string;
  isPinned?: boolean;
  onTogglePin?: () => void;
}) {
  const titleText = session.title || toReadable(session.summary) || "Untitled";
  const projectName = session.project_path?.split("/").pop() ?? "";
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`group relative w-full text-left flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors min-w-0 cursor-pointer ${
        isSelected
          ? "bg-primary/10 text-ink"
          : "text-muted-foreground hover:text-ink hover:bg-card-alt"
      }`}
    >
      <span
        className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full border ${
          isPinned
            ? "bg-primary border-primary"
            : "border-current opacity-50"
        }`}
        aria-hidden
      />
      <div className="truncate flex-1 min-w-0">
        <span className="truncate block">
          <HighlightText text={titleText} query={highlight} />
        </span>
        {showProject && session.project_path && (
          <span className="text-[10px] text-muted-foreground/60 truncate block">
            <HighlightText text={projectName} query={highlight} />
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <span className="text-[10px] text-muted-foreground tabular-nums group-hover:hidden">
          {session.message_count}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <button
              className="p-0.5 rounded text-muted-foreground/60 hover:text-ink hover:bg-card-alt opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              title="Actions"
              onClick={(e) => e.stopPropagation()}
            >
              <DotsHorizontalIcon className="w-3.5 h-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
            <SessionDropdownMenuItems
              projectId={session.project_id}
              sessionId={session.id}
              projectPath={session.project_path ?? undefined}
              isPinnedOverride={isPinned}
              onTogglePinOverride={onTogglePin}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ============================================================================
// Session Detail (right panel)
// ============================================================================

function SessionDetail({ session, onClose, highlight, scrollRef }: { session: Session; onClose: () => void; highlight?: string; scrollRef?: React.RefObject<HTMLDivElement | null> }) {
  const { formatPath } = useAppConfig();
  const toReadable = useReadableText();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [originalChat] = useAtom(originalChatAtom);
  const [markdownPreview] = useAtom(markdownPreviewAtom);
  const [userPromptsOnly, setUserPromptsOnly] = useAtom(userPromptsOnlyAtom);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const displaySummary = session.title || toReadable(session.summary) || "Untitled";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    invoke<Message[]>("get_session_messages", {
      projectId: session.project_id,
      sessionId: session.id,
    })
      .then((m) => { if (!cancelled) setMessages(m); })
      .catch(() => { if (!cancelled) setMessages([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session.project_id, session.id]);

  const filteredMessages = useMemo(() => {
    let result = originalChat ? messages.filter((m) => !m.is_meta && !m.is_tool) : messages;
    if (userPromptsOnly) result = result.filter((m) => m.role === "user");
    return result;
  }, [messages, originalChat, userPromptsOnly]);

  const handleCopyContent = (content: string) => {
    invoke("copy_to_clipboard", { text: content });
  };

  const contentRef = useRef<HTMLDivElement>(null);
  const [activeMatch, setActiveMatch] = useState(0);
  const [matchCount, setMatchCount] = useState(0);

  // Count matches from the actual rendered DOM (source of truth) after every render
  useEffect(() => {
    const root = contentRef.current;
    if (!highlight?.trim() || !root || loading) {
      setMatchCount(0);
      return;
    }
    const raf = requestAnimationFrame(() => {
      const root2 = contentRef.current;
      if (!root2) return;
      const hits = root2.querySelectorAll("[data-search-hit]");
      setMatchCount(hits.length);
    });
    return () => cancelAnimationFrame(raf);
  }, [highlight, filteredMessages, loading, originalChat]);

  useEffect(() => {
    setActiveMatch(0);
  }, [highlight, filteredMessages]);

  useEffect(() => {
    if (!contentRef.current || matchCount === 0 || loading) return;
    const raf = requestAnimationFrame(() => {
      const root = contentRef.current;
      const scroller = scrollRef?.current;
      if (!root) return;
      const hits = root.querySelectorAll<HTMLElement>("[data-search-hit]");
      if (hits.length === 0) return;
      const idx = Math.min(activeMatch, hits.length - 1);
      hits.forEach((el, i) => {
        if (i === idx) {
          el.style.backgroundColor = "#CC785C";
          el.style.color = "#fff";
          el.style.outline = "2px solid #CC785C";
        } else {
          el.style.backgroundColor = "";
          el.style.color = "";
          el.style.outline = "";
        }
      });
      const target = hits[idx];
      if (scroller) {
        const targetRect = target.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const delta = targetRect.top - scrollerRect.top - scrollerRect.height / 2 + targetRect.height / 2;
        scroller.scrollTo({
          top: scroller.scrollTop + delta,
          behavior: "smooth",
        });
      } else {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [activeMatch, matchCount, loading, scrollRef]);

  const gotoMatch = (delta: number) => {
    if (matchCount === 0) return;
    setActiveMatch((prev) => (prev + delta + matchCount) % matchCount);
  };

  return (
    <div className="pb-6">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-4 mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            className="font-serif text-xl font-semibold text-ink leading-tight mb-1 truncate"
            title={displaySummary}
          >
            {displaySummary}
          </h2>
          <p className="text-xs text-muted-foreground truncate">
            {session.project_path ? formatPath(session.project_path) : session.project_id}
            {" · "}
            {userPromptsOnly
              ? `${filteredMessages.length} prompts`
              : `${session.message_count} messages`}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {highlight?.trim() && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {matchCount === 0 ? "0/0" : `${activeMatch + 1}/${matchCount}`}
              </span>
              <button
                onClick={() => gotoMatch(-1)}
                disabled={matchCount === 0}
                className="p-1 rounded hover:bg-card-alt hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
                title="Previous match"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => gotoMatch(1)}
                disabled={matchCount === 0}
                className="p-1 rounded hover:bg-card-alt hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
                title="Next match"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={userPromptsOnly}
              onChange={(e) => setUserPromptsOnly(e.target.checked)}
              className="w-3 h-3 accent-primary cursor-pointer"
            />
            <span>Prompts only</span>
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1.5 rounded-lg text-muted-foreground hover:bg-card-alt">
                <DotsHorizontalIcon width={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <SessionDropdownMenuItems
                projectId={session.project_id}
                sessionId={session.id}
                projectPath={session.project_path ?? undefined}
                onExport={() => setExportDialogOpen(true)}
              />
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onClose} className="gap-2">
                <Cross2Icon width={14} />
                Close
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="px-6" ref={contentRef}>


      {loading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-muted-foreground text-sm">Loading messages...</p>
        </div>
      ) : filteredMessages.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-1 text-muted-foreground text-sm">
          <span>No messages in this session</span>
          <span className="text-xs opacity-60">{session.id}</span>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredMessages.map((msg) => {
            const displayContent = toReadable(msg.content);
            return (
              <div
                key={msg.uuid}
                className={`group relative rounded-xl p-4 ${
                  msg.role === "user" ? "bg-card-alt" : "bg-card border border-border"
                }`}
              >
                <button
                  onClick={() => handleCopyContent(displayContent)}
                  className="absolute top-3 right-3 p-1.5 rounded-md bg-card-alt/80 hover:bg-card-alt text-muted-foreground hover:text-ink transition-opacity opacity-0 group-hover:opacity-100"
                >
                  <Copy size={14} />
                </button>
                <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wide flex items-center gap-2">
                  <span>{msg.role}</span>
                  {msg.timestamp && (
                    <span
                      className="normal-case tracking-normal opacity-0 group-hover:opacity-100 transition-opacity"
                      title={new Date(msg.timestamp).toLocaleString()}
                    >
                      {new Date(msg.timestamp).toLocaleString()}
                    </span>
                  )}
                </p>
                {msg.content_blocks && !originalChat ? (
                  <ContentBlockRenderer blocks={msg.content_blocks} markdown={markdownPreview} highlight={highlight} />
                ) : (
                  <CollapsibleContent content={displayContent} markdown={markdownPreview} highlight={highlight} />
                )}
              </div>
            );
          })}
        </div>
      )}

      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        allMessages={filteredMessages}
        selectedIds={new Set()}
        onSelectedIdsChange={() => {}}
        defaultName={session.summary?.slice(0, 50).replace(/[/\\?%*:|"<>]/g, "-") || "session"}
      />
      </div>
    </div>
  );
}
