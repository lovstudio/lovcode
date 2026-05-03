import { useState, useMemo, useEffect, useRef, useLayoutEffect, useCallback, memo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDownIcon, ChevronRightIcon, DotsHorizontalIcon, ListBulletIcon, MagnifyingGlassIcon, Cross2Icon, DesktopIcon, RocketIcon, CheckIcon } from "@radix-ui/react-icons";
import { Copy, Upload, ChevronUp, ChevronDown, Pin, RefreshCw, CornerDownLeft, AlertTriangle, Folder, Pencil, ExternalLink, SlidersHorizontal } from "lucide-react";
import { TerminalPane, disposeTerminal } from "../../components/Terminal";
import { TERMINAL_OPTIONS, type TerminalOption } from "../../components/ui/new-terminal-button";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  allProjectsSortByAtom,
  hideEmptySessionsAllAtom,
  originalChatAtom,
  markdownPreviewAtom,
  userPromptsOnlyAtom,
  expandMessagesAtom,
  pinnedSessionIdsAtom,
  unpinnedAppIdsAtom,
  pinnedCollapsedAtom,
  recentCollapsedAtom,
  importCollapsedAtom,
  allProjectsGroupedAtom,
  allProjectsDataSourceAtom,
  allProjectsCollapsedGroupsAtom,
  type ProjectListDataSource,
} from "../../store";
import { useAppConfig } from "../../context";
import { useReadableText, formatTokens, inferModelInfo, resolveSessionLabel, titleSourceBadge } from "./utils";
import { useInvokeQuery, useQueryClient, useStreamedSessions } from "../../hooks";
import { CollapsibleContent } from "./CollapsibleContent";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import { ChatFilePreviewProvider } from "./FilePreviewContext";
import { HighlightText } from "./HighlightText";
import { PathAwareText } from "./PathAwareText";
import { usePathHits } from "./usePathHits";
import { useCwdValidity } from "./useCwdValidity";
import { RelocateSessionDialog } from "./RelocateSessionDialog";
import { ProjectLogo } from "../../components/shared/ProjectLogo";
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
  DropdownMenuCheckboxItem,
} from "../../components/ui/dropdown-menu";
import {
  SessionDropdownMenuItems,
} from "../../components/shared/SessionMenuItems";
import { ProjectPathLabel } from "../../components/shared/ProjectPathLabel";
import { ExportDialog } from "./ExportDialog";
import { chatSearchOpenAtom } from "../../components/GlobalChatSearch";
import type { ContentBlock, Project, Session, ChatMessage, Message } from "../../types";

interface ProjectListProps {
  onSelectProject: (p: Project) => void;
  onSelectSession: (s: Session) => void;
  onSelectChat?: (c: ChatMessage) => void;
}

/** Mirrors MaasRegistryView's COMING_SOON_PROVIDERS — providers you can see
 *  but not activate yet. Kept in sync by hand; grows rarely. */
const COMING_SOON_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "modelgate",
  "univibe",
  "siliconflow",
  "qiniu",
]);

/** MRU list of `{providerKey}:{modelName}` pairs the user has picked from the
 *  dropdown. Most-recent first; capped at MAX_RECENT. Persists across sessions. */
interface RecentModelEntry {
  providerKey: string;
  modelName: string;
  at: number;
}
const MAX_RECENT_MODELS = 5;
const recentModelsAtom = atomWithStorage<RecentModelEntry[]>(
  "lovcode:recentModels",
  [],
);

/** MRU of cwds the user has launched a new session from. Used to populate the
 *  new-session project picker. Separate from the Project list (which is derived
 *  from on-disk claude/codex history) so users can seed it with folders that
 *  have no prior history. */
interface RecentProjectEntry {
  path: string;
  at: number;
}
const MAX_RECENT_PROJECTS = 8;
const recentProjectsAtom = atomWithStorage<RecentProjectEntry[]>(
  "lovcode:recentProjects",
  [],
);

const PTY_HEIGHT_DEFAULT = 288;
const PTY_HEIGHT_MIN = 160;
const composerPtyHeightAtom = atomWithStorage<number>(
  "lovcode:composerPtyHeight",
  PTY_HEIGHT_DEFAULT,
);

export function ProjectList({ onSelectProject, onSelectSession: _onSelectSession }: ProjectListProps) {
  const toReadable = useReadableText();
  const queryClient = useQueryClient();

  const { data: projects = [], isLoading: loadingProjects } = useInvokeQuery<Project[]>(["projects"], "list_projects");
  // Streamed: first batch (~200 sessions) lands within a few hundred ms so the
  // splash can fade and the list paints, instead of waiting for the full 1500-row
  // IPC roundtrip + JSON.parse. The hook also writes the final set into
  // react-query's ["sessions"] cache so other consumers (search, etc.) get it.
  const { sessions: allSessions, initialLoading: loadingSessions } = useStreamedSessions();

  const [importing, setImporting] = useState(false);
  // Two-level tab model:
  //   top: "all" | "local" | "app"
  //   sub (only when top==="app"): "code" | "web" | "cowork"
  // Flattened into one DataSource value so filters key off a single variable.
  type DataSource = ProjectListDataSource;
  const [dataSource, setDataSource] = useAtom(allProjectsDataSourceAtom);
  const topTab: "all" | "local" | "app" =
    dataSource === "all" ? "all" : dataSource === "local" ? "local" : "app";

  const [sortBy, setSortBy] = useAtom(allProjectsSortByAtom);
  const [hideEmptySessions, setHideEmptySessions] = useAtom(hideEmptySessionsAllAtom);
  const [pinnedIds, setPinnedIds] = useAtom(pinnedSessionIdsAtom);
  const [unpinnedAppIds, setUnpinnedAppIds] = useAtom(unpinnedAppIdsAtom);
  const [pinnedCollapsed, setPinnedCollapsed] = useAtom(pinnedCollapsedAtom);
  const [recentCollapsed, setRecentCollapsed] = useAtom(recentCollapsedAtom);
  const [importCollapsed, setImportCollapsed] = useAtom(importCollapsedAtom);
  const [collapsedGroupsArr, setCollapsedGroupsArr] = useAtom(allProjectsCollapsedGroupsAtom);
  const collapsedGroups = useMemo<Set<string> | null>(
    () => (collapsedGroupsArr === null ? null : new Set(collapsedGroupsArr)),
    [collapsedGroupsArr],
  );
  const [selectedSessionRaw, setSelectedSessionRaw] = useState<Session | null>(null);

  // Auto-select a session when navigated here with a hint (e.g. from global search).
  // Source: location.state.selectSessionId. Cleared after consumption so a
  // back→forward navigation doesn't re-trigger selection.
  const location = useLocation();
  const navigate = useNavigate();
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const hintId = (location.state as { selectSessionId?: string } | null)?.selectSessionId;
    if (!hintId || allSessions.length === 0) return;
    const s = allSessions.find((x) => x.id === hintId);
    if (!s) return;
    setSelectedSessionRaw(s);
    // Expand sections / project group so the target row is in the DOM.
    setRecentCollapsed(false);
    setPinnedCollapsed(false);
    setCollapsedGroupsArr((prev) => {
      if (prev === null) return prev;
      if (!prev.includes(s.project_id)) return prev;
      return prev.filter((id) => id !== s.project_id);
    });
    pendingScrollToSessionRef.current = hintId;
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, allSessions, navigate, setRecentCollapsed, setPinnedCollapsed, setCollapsedGroupsArr]);

  // After sidebar re-renders with the target row visible, scroll it into view.
  // Re-runs on every sidebar shape change until the row exists, then clears.
  useEffect(() => {
    const id = pendingScrollToSessionRef.current;
    if (!id) return;
    const scroller = sidebarScrollRef.current;
    if (!scroller) return;
    const row = scroller.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const delta = rowRect.top - scrollerRect.top - scrollerRect.height / 2 + rowRect.height / 2;
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: "smooth" });
    pendingScrollToSessionRef.current = null;
  });

  // Always re-derive the selected session from the live `allSessions` array so that
  // when cwd repair / migration moves a session to a new project slug, the right panel
  // picks up the new object (with updated project_path / project_id) automatically.
  const selectedSession: Session | null = useMemo(() => {
    if (!selectedSessionRaw) return null;
    return allSessions.find((s) => s.id === selectedSessionRaw.id) ?? selectedSessionRaw;
  }, [selectedSessionRaw, allSessions]);
  const setSelectedSession: typeof setSelectedSessionRaw = setSelectedSessionRaw;
  const [recentProjects, setRecentProjects] = useAtom(recentProjectsAtom);
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  // Seed activeCwd once we know something. Prefer most-recent MRU entry; else
  // the most-recently-active project on disk.
  useEffect(() => {
    if (activeCwd !== null) return;
    if (recentProjects.length > 0) {
      setActiveCwd(recentProjects[0].path);
      return;
    }
    if (projects.length > 0) {
      const top = projects
        .slice()
        .sort((a, b) => b.last_active - a.last_active)[0];
      setActiveCwd(top.path);
    }
  }, [activeCwd, recentProjects, projects]);
  const bumpRecentProject = (path: string) => {
    setRecentProjects((prev) => {
      const next: RecentProjectEntry[] = [
        { path, at: Date.now() },
        ...prev.filter((r) => r.path !== path),
      ];
      return next.slice(0, MAX_RECENT_PROJECTS);
    });
  };
  const [grouped, setGrouped] = useAtom(allProjectsGroupedAtom);
  const [, setSearchOpen] = useAtom(chatSearchOpenAtom);
  // Default all projects to collapsed on first load
  useEffect(() => {
    if (collapsedGroupsArr === null && projects.length > 0) {
      setCollapsedGroupsArr(projects.map((p) => p.id));
    }
  }, [projects, collapsedGroupsArr, setCollapsedGroupsArr]);

  // Single source-of-truth predicate for "does this session belong in the
  // currently-selected data source tab". Used by every list-shaping memo below.
  const matchesDataSource = (s: Session): boolean => {
    switch (dataSource) {
      case "all":        return true;
      case "local":      return s.source === "cli";
      case "app-code":   return s.source === "app-code";
      case "app-web":    return s.source === "app-web";
      case "app-cowork": return s.source === "app-cowork";
    }
  };

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
    if (dataSource !== "app-web") return;
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

  // Pull Claude desktop app's starredIds once after sessions load.
  // (Removed: legacy cleanup that stripped app-source ids from pinnedIds —
  // it kept silently wiping user pins whenever Claude desktop reclassified
  // a CLI session as app-code. Pins are user data; never auto-delete them.)
  const syncedRef = useRef(false);
  useEffect(() => {
    if (syncedRef.current) return;
    if (allSessions.length === 0) return;
    syncedRef.current = true;
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

  const loading = loadingProjects || loadingSessions;

  // Hold the index.html splash up until the initial session list is ready,
  // then fade. Only the first transition matters — re-fetches don't replay.
  const splashDismissedRef = useRef(false);
  useEffect(() => {
    if (loading || splashDismissedRef.current) return;
    splashDismissedRef.current = true;
    window.dispatchEvent(new Event("app:ready"));
  }, [loading, allSessions.length, projects.length]);

  // Sessions visible under the current data source — used for the header counter
  // so it matches what the user actually sees in the list.
  const visibleSessions = useMemo(
    () => allSessions.filter(matchesDataSource),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSessions, dataSource]
  );

  const sortedProjects = useMemo(() => {
    // Pre-build "project_id has any session of current dataSource" in O(n)
    // so the project filter below is O(projects) instead of O(n*p).
    const projectHasMatch = new Set<string>();
    if (dataSource !== "all") {
      for (const s of allSessions) {
        if (matchesDataSource(s)) projectHasMatch.add(s.project_id);
      }
    }

    const filtered = projects.filter((p) => {
      if (p.session_count === 0) return false;
      if (dataSource === "all") return true;
      return projectHasMatch.has(p.id);
    });
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "recent": return b.last_active - a.last_active;
        case "sessions": return b.session_count - a.session_count;
        case "name": return a.path.localeCompare(b.path);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, allSessions, sortBy, dataSource]);

  const sessionsByProject = useMemo(() => {
    const normalizePath = (p: string) => p.replace(/\/+$/, "");

    // O(n) bucket pass: group filtered sessions by their normalized
    // project_path. Avoids the previous O(projects × sessions) double loop
    // that would freeze the UI thread for ~1s with 1000+ sessions.
    const buckets = new Map<string, Session[]>();
    for (const s of allSessions) {
      if (!s.project_path) continue;
      if (hideEmptySessions && s.rounds === 0) continue;
      if (!matchesDataSource(s)) continue;
      if (effectivePinnedSet.has(s.id)) continue; // shown in pinned section
      const key = normalizePath(s.project_path);
      const list = buckets.get(key);
      if (list) list.push(s);
      else buckets.set(key, [s]);
    }

    const sortFn = (a: Session, b: Session) => {
      switch (sortBy) {
        case "recent": return b.last_modified - a.last_modified;
        case "sessions": return b.rounds - a.rounds;
        case "name": return (a.summary || "").localeCompare(b.summary || "");
      }
    };

    const map = new Map<string, Session[]>();
    for (const project of sortedProjects) {
      const list = buckets.get(normalizePath(project.path)) ?? [];
      list.sort(sortFn);
      map.set(project.id, list);
    }
    return map;
  }, [sortedProjects, allSessions, sortBy, hideEmptySessions, dataSource, effectivePinnedSet]);

  // Pinned sessions surface as a dedicated top group, independent of the
  // active data-source tab — a pin is a pin, switching tabs shouldn't hide it.
  // Still respects `hideEmptySessions` because that's an explicit user toggle.
  const pinnedSessions = useMemo(() => {
    if (effectivePinnedSet.size === 0) return [];
    const seen = new Set<string>();
    return allSessions
      .filter((s) => effectivePinnedSet.has(s.id))
      .filter((s) => {
        if (seen.has(s.id)) return false; // defensive dedupe — backend may emit dupes for same cliSessionId
        seen.add(s.id);
        if (hideEmptySessions && s.rounds === 0) return false;
        return true;
      })
      .sort((a, b) => b.last_modified - a.last_modified);
  }, [allSessions, effectivePinnedSet, hideEmptySessions]);

  const flatSessions = useMemo(() => {
    if (grouped) return [];
    return allSessions
      .filter((s) => {
        if (s.rounds === 0 && hideEmptySessions) return false;
        if (effectivePinnedSet.has(s.id)) return false; // surfaced in the top Pinned section
        return matchesDataSource(s);
      })
      .sort((a, b) => {
        switch (sortBy) {
          case "recent": return b.last_modified - a.last_modified;
          case "sessions": return b.rounds - a.rounds;
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
    setCollapsedGroupsArr((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return Array.from(next);
    });
  };

  if (loading) {
    const what = loadingSessions && loadingProjects
      ? "sessions and projects"
      : loadingSessions
        ? "sessions"
        : "projects";
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-muted-foreground">Reading {what}…</p>
        <p className="text-xs text-muted-foreground/60">~/.claude/projects</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left Panel: Project Tree */}
      <div ref={sidebarScrollRef} className="w-80 shrink-0 border-r border-border overflow-y-auto overscroll-contain">
        <div className="px-4 py-4">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-serif text-lg font-semibold text-ink">History</h2>
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

          {/* Top-level source tabs: All / Local / App.
              When App is active, a sub-tab row appears below for Code / Web / Cowork. */}
          <div className="flex gap-0.5 mb-2 p-0.5 rounded-lg bg-card-alt">
            {([
              { key: "all", label: "All" },
              { key: "local", label: "Local" },
              { key: "app", label: "App" },
            ] as { key: "all" | "local" | "app"; label: string }[]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => {
                  if (key === "all") setDataSource("all");
                  else if (key === "local") setDataSource("local");
                  else setDataSource("app-code"); // entering App defaults to Code sub-tab
                }}
                className={`flex-1 px-2 py-1 rounded-md text-xs transition-colors ${
                  topTab === key
                    ? "bg-card text-ink shadow-sm"
                    : "text-muted-foreground hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {topTab === "app" && (
            <div className="flex gap-0.5 mb-2 p-0.5 rounded-lg bg-card-alt/60">
              {([
                { key: "app-code", label: "Code", disabled: false },
                { key: "app-web", label: "Web", disabled: false },
                { key: "app-cowork", label: "Cowork", disabled: true },
              ] as { key: DataSource; label: string; disabled: boolean }[]).map(({ key, label, disabled }) => (
                <button
                  key={key}
                  onClick={() => !disabled && setDataSource(key)}
                  disabled={disabled}
                  title={disabled ? "Coming soon" : undefined}
                  className={`flex-1 px-2 py-1 rounded-md text-xs transition-colors ${
                    dataSource === key
                      ? "bg-card text-ink shadow-sm"
                      : disabled
                      ? "text-muted-foreground/40 cursor-not-allowed"
                      : "text-muted-foreground hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Web tab status (only visible when App › Web is active) */}
          {dataSource === "app-web" && (webSyncing || webSyncError) && (
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
          {/* Pinned section — independent of grouped/flat */}
          {pinnedSessions.length > 0 && (
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
                      onClick={() => setSelectedSession(session)}
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

          {/* Recent section header (wraps grouped or flat list) */}
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
                        className="p-0.5 rounded text-muted-foreground hover:text-ink hover:bg-card-alt transition-colors"
                        title="Recent options"
                        aria-label="Recent options"
                      >
                        <SlidersHorizontal className="w-3 h-3" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[200px]">
                      <DropdownMenuLabel className="text-xs">Group by</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={grouped ? "project" : "none"} onValueChange={(v) => setGrouped(v === "project")}>
                        <DropdownMenuRadioItem value="project">Project</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="none">None (flat)</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-xs">Sort by</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                        <DropdownMenuRadioItem value="recent">Recent</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuCheckboxItem
                        checked={hideEmptySessions}
                        onCheckedChange={(c) => setHideEmptySessions(!!c)}
                      >
                        Hide empty sessions
                      </DropdownMenuCheckboxItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
              {!recentCollapsed && (grouped ? (
            // Grouped by project
            sortedProjects.length === 0 ? (
              <div className="text-xs text-muted-foreground px-2 py-6 text-center">
                No {emptyStateLabel(dataSource)}sessions
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
                            onClick={() => setSelectedSession(session)}
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
                No {emptyStateLabel(dataSource)}sessions
              </div>
            ) : flatSessions.map((session) => (
              <SessionItemButton
                key={session.id}
                session={session}
                isSelected={selectedSession?.id === session.id}
                onClick={() => setSelectedSession(session)}
                toReadable={toReadable}
                showProject
                isPinned={effectivePinnedSet.has(session.id)}
                onTogglePin={() => togglePin(session.id)}
              />
            ))
          ))}
            </>

          {/* Web tab — Import group at the end */}
          {dataSource === "app-web" && (
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
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {selectedSession ? (
          <ChatFilePreviewProvider>
            <SessionDetail
              session={selectedSession}
              onClose={() => setSelectedSession(null)}
            />
          </ChatFilePreviewProvider>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center px-8 pt-8 gap-4 text-muted-foreground text-sm">
              <span>Start a new conversation, or select one from the left</span>
              <div className="w-full max-w-2xl">
                <ActivityCard />
              </div>
            </div>
            <NewSessionComposer
              cwd={activeCwd}
              onCwdChange={(p) => {
                setActiveCwd(p);
                bumpRecentProject(p);
              }}
              projects={projects}
              recentProjects={recentProjects}
              onSpawn={bumpRecentProject}
            />
          </div>
        )}
      </div>

    </div>
  );
}

// Friendly label fragment for "No __ sessions" in empty states.
function emptyStateLabel(ds: "all" | "local" | "app-code" | "app-web" | "app-cowork"): string {
  switch (ds) {
    case "all":        return "";
    case "local":      return "local ";
    case "app-code":   return "app code ";
    case "app-web":    return "app web ";
    case "app-cowork": return "cowork ";
  }
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
  toReadable,
  showProject,
  highlight,
  isPinned,
  onTogglePin,
}: {
  session: Session;
  isSelected: boolean;
  onClick: () => void;
  toReadable: (s: string | null) => string;
  showProject?: boolean;
  highlight?: string;
  isPinned?: boolean;
  onTogglePin?: () => void;
}) {
  const label = resolveSessionLabel(session, toReadable);
  const titleText = label.text;
  const labelBadge = titleSourceBadge(label.source);
  const projectName = session.project_path?.split("/").pop() ?? "";
  const missingCwds = useCwdValidity([session.project_path]);
  const cwdMissing = !!session.project_path && missingCwds.has(session.project_path);
  return (
    <div
      onClick={onClick}
      data-session-id={session.id}
      className={`group relative w-full text-left flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors min-w-0 cursor-pointer ${
        isSelected
          ? "bg-primary/10 text-ink"
          : "text-muted-foreground hover:text-ink hover:bg-card-alt"
      } ${cwdMissing ? "opacity-60" : ""}`}
    >
      <span
        className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${
          isPinned ? "ring-1 ring-primary ring-offset-1 ring-offset-background " : ""
        }${
          label.source === "custom"  ? "bg-foreground" :
          label.source === "ai"      ? "bg-primary" :
          label.source === "summary" ? "bg-blue-500" :
          label.source === "slug"    ? "bg-emerald-500" :
          label.source === "prompt"  ? "bg-muted-foreground/40" :
                                        "bg-muted-foreground/20"
        }`}
        title={
          (isPinned ? "置顶 · " : "") +
          `标题来源：${labelBadge ?? "未知"}`
        }
        aria-hidden
      />
      <div className="truncate flex-1 min-w-0">
        <span
          className={`truncate block ${
            label.source === "prompt" || label.source === "none"
              ? "text-muted-foreground/80 italic"
              : ""
          }`}
        >
          <HighlightText text={titleText} query={highlight} />
        </span>
        {showProject && session.project_path && (
          <span className="text-[10px] text-muted-foreground/60 truncate block">
            <HighlightText text={projectName} query={highlight} />
          </span>
        )}
      </div>
      {cwdMissing && (
        <span className="shrink-0" title={`cwd 已不存在: ${session.project_path}`}>
          <AlertTriangle className="w-3 h-3 text-amber-600" />
        </span>
      )}
      <div className="flex items-center gap-1 shrink-0">
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

function isUserPromptMessage(msg: Message) {
  return msg.role === "user" && !msg.is_tool;
}

function isUserPromptGroup(group: Message[]) {
  return group.length > 0 && group.every(isUserPromptMessage);
}

function messageGroupKind(msg: Message) {
  if (isUserPromptMessage(msg)) return "user";
  if (msg.is_tool) return "tool";
  return msg.role;
}

function groupHasToolBlocks(group: Message[]) {
  return group.some((msg) =>
    msg.is_tool ||
    msg.content_blocks?.some((block) => block.type === "tool_use" || block.type === "tool_result"),
  );
}

function flattenGroupContentBlocks(group: Message[]) {
  const blocks: ContentBlock[] = [];
  for (const msg of group) {
    if (msg.content_blocks?.length) {
      blocks.push(...msg.content_blocks);
    } else if (msg.content.trim()) {
      blocks.push({ type: "text", text: msg.content });
    }
  }
  return blocks;
}

function groupConsecutiveByRole(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  for (const msg of messages) {
    const last = groups[groups.length - 1];
    const kind = messageGroupKind(msg);
    if (last && messageGroupKind(last[0]) === kind && kind !== "user") last.push(msg);
    else groups.push([msg]);
  }
  return groups;
}

function useGroupCollapse(deps: unknown[], initialExpanded = false) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [isOverflow, setIsOverflow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(initialExpanded);
  }, [initialExpanded]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setIsOverflow(el.scrollHeight > 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { expanded, setExpanded, isOverflow, ref };
}

function StickyPromptList({
  groupedMessages,
  userPromptsOnly,
  originalChat,
  markdownPreview,
  expandMessages,
  highlight,
  toReadable,
  onCopy,
  cwd,
}: {
  groupedMessages: Message[][];
  userPromptsOnly: boolean;
  originalChat: boolean;
  markdownPreview: boolean;
  expandMessages: boolean;
  highlight?: string;
  toReadable: (s: string | null) => string;
  onCopy: (content: string) => void;
  cwd?: string;
}) {
  // Slice grouped messages into "sections": each section starts with a user prompt
  // and includes all subsequent assistant groups until the next user prompt.
  // The user prompt is `sticky top-0` within its section, so when the section
  // scrolls out, the next section's prompt naturally pushes it away — exactly
  // the "relay" behavior. No JS scroll tracking needed.
  type Section = { groups: Message[][]; startIdx: number };
  const sections = useMemo<Section[]>(() => {
    const result: Section[] = [];
    let current: Section | null = null;
    groupedMessages.forEach((g, i) => {
      const isPrompt = isUserPromptGroup(g);
      if (isPrompt || current === null) {
        current = { groups: [g], startIdx: i };
        result.push(current);
      } else {
        current.groups.push(g);
      }
    });
    return result;
  }, [groupedMessages]);

  let userCounter = 0;
  return (
    <>
      {sections.map((section) => {
        const head = section.groups[0];
        const headIsUser = isUserPromptGroup(head);
        return (
          <div key={`${head[0].uuid}-${head[0].line_number}`}>
            {section.groups.map((group) => {
              const isUserGroup = isUserPromptGroup(group);
              const promptIndex = isUserGroup ? ++userCounter : undefined;
              const sticky = isUserGroup && headIsUser && !userPromptsOnly;
              return (
                <MessageGroupCard
                  key={`${group[0].uuid}-${group[0].line_number}`}
                  group={group}
                  originalChat={originalChat}
                  markdownPreview={markdownPreview}
                  expandMessages={expandMessages}
                  highlight={highlight}
                  toReadable={toReadable}
                  onCopy={onCopy}
                  cwd={cwd}
                  promptIndex={promptIndex}
                  sticky={sticky}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
}

const PROMPT_HEAD_LINES = 3;
const PROMPT_TAIL_LINES = 2;
const PROMPT_COMPRESS_THRESHOLD = PROMPT_HEAD_LINES + PROMPT_TAIL_LINES + 1;

function compressPromptText(text: string): { head: string; tail: string; omittedLines: number } | null {
  const lines = text.split("\n");
  if (lines.length < PROMPT_COMPRESS_THRESHOLD) return null;
  const omitted = lines.length - PROMPT_HEAD_LINES - PROMPT_TAIL_LINES;
  return {
    head: lines.slice(0, PROMPT_HEAD_LINES).join("\n"),
    tail: lines.slice(-PROMPT_TAIL_LINES).join("\n"),
    omittedLines: omitted,
  };
}

async function openPromptDetailWindow(content: string, title: string) {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = `prompt-detail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const url = `index.html#/prompt-detail?content=${encodeURIComponent(content)}&title=${encodeURIComponent(title)}`;
  try {
    const win = new WebviewWindow(label, {
      url,
      title: title || "Prompt",
      width: 720,
      height: 600,
      minWidth: 360,
      minHeight: 240,
      titleBarStyle: "overlay",
      hiddenTitle: true,
    });
    win.once("tauri://error", (e) => console.warn("[prompt-detail] window error:", e));
  } catch (err) {
    console.warn("[prompt-detail] open failed:", err);
  }
}

const MessageGroupCard = memo(function MessageGroupCard({
  group,
  originalChat,
  markdownPreview,
  expandMessages,
  highlight,
  toReadable,
  onCopy,
  cwd,
  promptIndex,
  sticky,
}: {
  group: Message[];
  originalChat: boolean;
  markdownPreview: boolean;
  expandMessages: boolean;
  highlight?: string;
  toReadable: (s: string | null) => string;
  onCopy: (content: string) => void;
  cwd?: string;
  promptIndex?: number;
  sticky?: boolean;
}) {
  const groupContent = group.map((m) => toReadable(m.content)).join("\n\n");
  const firstTs = group[0].timestamp;
  const { expanded, setExpanded, isOverflow, ref } = useGroupCollapse(
    [group, markdownPreview, originalChat],
    expandMessages,
  );
  const isUser = isUserPromptGroup(group);
  const userPromptText = isUser ? groupContent : "";
  const userPromptCompressed = isUser ? compressPromptText(userPromptText) : null;
  const userPathHits = usePathHits(userPromptText, cwd, true);
  const toolBlocks = useMemo(
    () => (!isUser && groupHasToolBlocks(group) ? flattenGroupContentBlocks(group) : null),
    [group, isUser],
  );

  return (
    <div
      onDoubleClick={
        isUser
          ? () => {
              const titleSrc = userPromptText.split("\n").find((l) => l.trim()) ?? "Prompt";
              openPromptDetailWindow(
                userPromptText,
                promptIndex !== undefined
                  ? `#${promptIndex} ${titleSrc.slice(0, 60)}`
                  : titleSrc.slice(0, 60),
              );
            }
          : undefined
      }
      className={`group/msg relative py-1.5 pl-4 pr-10 border-b ${
        isUser
          ? "border-border bg-card before:absolute before:inset-0 before:bg-primary/[0.07] before:pointer-events-none"
          : "bg-card border-border/40"
      } ${sticky ? "sticky top-0 z-10" : ""} ${isUser ? "select-none cursor-pointer" : ""}`}
      title={isUser ? "Double-click to open in window" : undefined}
    >
      <div className="relative min-w-0">
        {promptIndex !== undefined && (
          <div className="text-[10px] font-mono text-muted-foreground/70 mb-0.5 select-none">
            #{promptIndex}
          </div>
        )}
        {isUser ? (
          userPromptCompressed ? (
            <div className="text-sm leading-relaxed text-ink select-text cursor-text">
              <div className="whitespace-pre-wrap break-words">
                <PathAwareText text={userPromptCompressed.head} hits={userPathHits} highlight={highlight} />
              </div>
              <div
                className="my-1 flex items-center gap-2 text-[10px] text-muted-foreground/60 select-none"
                aria-label={`${userPromptCompressed.omittedLines} 行省略，双击展开`}
              >
                <span className="flex-1 border-t border-dashed border-border/60" />
                <span className="font-mono">··· {userPromptCompressed.omittedLines} 行省略 · 双击展开 ···</span>
                <span className="flex-1 border-t border-dashed border-border/60" />
              </div>
              <div className="whitespace-pre-wrap break-words">
                <PathAwareText text={userPromptCompressed.tail} hits={userPathHits} highlight={highlight} />
              </div>
            </div>
          ) : (
            <div className="text-sm leading-relaxed text-ink whitespace-pre-wrap break-words select-text cursor-text">
              <PathAwareText text={userPromptText} hits={userPathHits} highlight={highlight} />
            </div>
          )
        ) : (
          <div
            ref={ref}
            onClick={() => {
              if (!expanded && isOverflow) setExpanded(true);
            }}
            className={`text-sm leading-relaxed text-ink ${
              expanded ? "" : `max-h-20 overflow-hidden ${isOverflow ? "cursor-pointer" : ""}`
            }`}
          >
            <div className="space-y-1.5">
              {toolBlocks ? (
                <ContentBlockRenderer blocks={toolBlocks} markdown={markdownPreview} highlight={highlight} disableTextCollapse cwd={cwd} transformText={toReadable} />
              ) : (
                group.map((msg, idx) => (
                  <div
                    key={`${msg.uuid}-${msg.line_number}`}
                    className={idx > 0 ? "pt-1.5 border-t border-border/30" : ""}
                  >
                    {msg.content_blocks ? (
                      <ContentBlockRenderer blocks={msg.content_blocks} markdown={markdownPreview} highlight={highlight} disableTextCollapse cwd={cwd} transformText={toReadable} />
                    ) : (
                      <CollapsibleContent content={toReadable(msg.content)} markdown={markdownPreview} highlight={highlight} disableCollapse cwd={cwd} />
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
      <div className="absolute top-2 right-3 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-1 rounded text-muted-foreground hover:bg-card-alt hover:text-ink"
              title="More"
            >
              <DotsHorizontalIcon width={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {firstTs && (
              <>
                <DropdownMenuLabel className="text-[10px] text-muted-foreground font-normal normal-case tracking-normal">
                  {new Date(firstTs).toLocaleString()}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            )}
            {!isUser && isOverflow && (
              <DropdownMenuItem onClick={() => setExpanded(!expanded)} className="gap-2 text-xs">
                {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                {expanded ? "Collapse" : "Expand"}
              </DropdownMenuItem>
            )}
            {isUser && (
              <DropdownMenuItem
                onClick={() => {
                  const titleSrc = userPromptText.split("\n").find((l) => l.trim()) ?? "Prompt";
                  openPromptDetailWindow(
                    userPromptText,
                    promptIndex !== undefined
                      ? `#${promptIndex} ${titleSrc.slice(0, 60)}`
                      : titleSrc.slice(0, 60),
                  );
                }}
                className="gap-2 text-xs"
              >
                <ExternalLink size={13} />
                Open in window
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onCopy(groupContent)} className="gap-2 text-xs">
              <Copy size={13} />
              Copy
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});

function CwdMissingBanner({ from }: { from: string }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <div className="shrink-0 border-b border-amber-300/60 bg-amber-50 text-amber-900 px-4 py-2 text-xs">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">原工作目录已不存在</div>
            <div className="opacity-80 break-all font-mono">{from}</div>
            <div className="opacity-70 mt-0.5">历史可正常查看，但其中的相对路径无法解析、resume 也会失败。可能是项目被移动或重命名。</div>
          </div>
        </div>
        <div className="mt-2 pl-[22px]">
          <button
            onClick={() => setDialogOpen(true)}
            className="px-2 py-1 rounded border border-amber-400 bg-white/60 hover:bg-white text-amber-900"
          >
            重定位…
          </button>
        </div>
      </div>
      <RelocateSessionDialog from={from} open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}

/** Inline-editable session title. Editing writes back to the Claude desktop-app
 *  meta file via `set_session_title` — only app-code sessions are writable. */
function EditableSessionTitle({
  sessionId,
  value,
  canEdit,
  className = "",
}: {
  sessionId: string;
  value: string;
  canEdit: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === value) {
      setEditing(false);
      setDraft(value);
      return;
    }
    try {
      await invoke("set_session_title", { sessionId, title: next });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (e) {
      console.error("set_session_title", e);
      setDraft(value);
    }
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(value);
  };

  if (!canEdit) {
    return (
      <span className={`truncate ${className}`} title={value}>
        {value}
      </span>
    );
  }

  if (editing) {
    return (
      <span className={`inline-flex items-center gap-1 min-w-0 ${className}`}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          className="min-w-0 flex-1 bg-card border border-border rounded px-1.5 py-0.5 text-base font-serif font-semibold text-ink outline-none focus:border-primary"
        />
      </span>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      title="Click to rename"
      className={`inline-flex items-center gap-1 min-w-0 truncate text-left hover:text-primary group ${className}`}
    >
      <span className="truncate">{value}</span>
      <Pencil className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60" />
    </button>
  );
}

function SessionDetail({ session, onClose, highlight }: { session: Session; onClose: () => void; highlight?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const toReadable = useReadableText();
  const missingCwds = useCwdValidity([session.project_path]);
  const cwdMissing = !!session.project_path && missingCwds.has(session.project_path);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [originalChat, setOriginalChat] = useAtom(originalChatAtom);
  const [markdownPreview, setMarkdownPreview] = useAtom(markdownPreviewAtom);
  const [userPromptsOnly, setUserPromptsOnly] = useAtom(userPromptsOnlyAtom);
  const [expandMessages, setExpandMessages] = useAtom(expandMessagesAtom);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const headerLabel = resolveSessionLabel(session, toReadable);
  const displaySummary = headerLabel.text;
  const headerBadge = titleSourceBadge(headerLabel.source);

  const { data: liveUsage } = useInvokeQuery<import("../../types").SessionUsage>(
    ["session-usage", session.project_id, session.id],
    "get_session_usage",
    { projectId: session.project_id, sessionId: session.id },
  );
  const usage = liveUsage ?? session.usage;

  const selection = useMaasActiveSelection();

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
    let result = originalChat ? messages.filter((m) => !m.is_meta) : messages;
    if (userPromptsOnly) result = result.filter((m) => isUserPromptMessage(m));
    return result;
  }, [messages, originalChat, userPromptsOnly]);

  const groupedMessages = useMemo(() => {
    return userPromptsOnly
      ? filteredMessages.map((m) => [m] as Message[])
      : groupConsecutiveByRole(filteredMessages);
  }, [filteredMessages, userPromptsOnly]);

  // A round = one user prompt (plus its following assistant turn). Count user messages from the
  // chat-only view so meta/tool entries don't inflate the number.
  const roundCount = useMemo(
    () => messages.filter((m) => !m.is_meta && !m.is_tool && m.role === "user").length,
    [messages],
  );

  const handleCopyContent = useCallback((content: string) => {
    invoke("copy_to_clipboard", { text: content });
  }, []);

  const contentRef = useRef<HTMLDivElement>(null);
  const [activeMatch, setActiveMatch] = useState(0);
  const [matchCount, setMatchCount] = useState(0);

  // Resume-conversation state: prompt-box + spawned terminal
  // Only local CLI sessions can be resumed via `claude --resume`/`codex resume`.
  // app-code sessions point to the same .jsonl on disk, so they're also resumable.
  const canResume = (session.source === "cli" || session.source === "app-code") && !!session.project_path;

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
      const scroller = scrollRef.current;
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
  }, [activeMatch, matchCount, loading]);

  const gotoMatch = (delta: number) => {
    if (matchCount === 0) return;
    setActiveMatch((prev) => (prev + delta + matchCount) % matchCount);
  };


  return (
    <div className="h-full flex flex-col min-h-0 min-w-0 overflow-hidden">
      <header className="shrink-0 z-10 bg-background border-b border-border px-4 py-2.5 flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2 text-sm">
          {session.project_path ? (
            <ProjectPathLabel
              path={session.project_path}
              className="text-muted-foreground max-w-[40%]"
            />
          ) : (
            <span className="truncate text-muted-foreground">{session.project_id}</span>
          )}
          <span className="text-muted-foreground/50 shrink-0">/</span>
          <EditableSessionTitle
            sessionId={session.id}
            canEdit={session.source === "app-code"}
            value={displaySummary}
            className="font-serif text-base font-semibold text-ink min-w-0 flex-1"
          />
          {headerBadge && (
            <span
              className={`shrink-0 inline-block w-2 h-2 rounded-full ${
                headerLabel.source === "custom"  ? "bg-foreground" :
                headerLabel.source === "ai"      ? "bg-primary" :
                headerLabel.source === "summary" ? "bg-blue-500" :
                headerLabel.source === "slug"    ? "bg-emerald-500" :
                headerLabel.source === "prompt"  ? "bg-muted-foreground/40" :
                                                    "bg-muted-foreground/20"
              }`}
              title={`标题来源：${headerBadge}`}
              aria-label={`标题来源：${headerBadge}`}
            />
          )}
          <span className="text-xs text-muted-foreground/70 shrink-0">· {roundCount} rounds</span>
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
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button className="p-1.5 rounded-lg text-muted-foreground hover:bg-card-alt">
                <DotsHorizontalIcon width={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-xs text-muted-foreground">View</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={userPromptsOnly} onCheckedChange={setUserPromptsOnly}>
                Prompts only
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={expandMessages} onCheckedChange={setExpandMessages}>
                Expand messages
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={markdownPreview} onCheckedChange={setMarkdownPreview}>
                Markdown preview
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={originalChat} onCheckedChange={setOriginalChat}>
                Readable slash command
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">Session</DropdownMenuLabel>
              <SessionDropdownMenuItems
                projectId={session.project_id}
                sessionId={session.id}
                projectPath={session.project_path ?? undefined}
                onExport={() => setExportDialogOpen(true)}
              />
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onClose} className="gap-2">
                <Cross2Icon width={14} />
                Close panel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {cwdMissing && session.project_path && (
        <CwdMissingBanner from={session.project_path} />
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain">
      <div ref={contentRef}>


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
        <div className="border-t border-border/40">
          <StickyPromptList
            groupedMessages={groupedMessages}
            userPromptsOnly={userPromptsOnly}
            originalChat={originalChat}
            markdownPreview={markdownPreview}
            expandMessages={expandMessages}
            highlight={highlight}
            toReadable={toReadable}
            onCopy={handleCopyContent}
            cwd={session.project_path ?? undefined}
          />
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

      {/* Continue conversation: terminal-style prompt box pinned to the right pane bottom */}
      <Composer
        cwd={canResume ? session.project_path ?? null : null}
        resetKey={session.id}
        emptyMessage={
          canResume
            ? undefined
            : session.source === "app-web"
              ? "This conversation was synced from claude.ai (web). Resume is only available for local CLI sessions."
              : session.source === "app-cowork"
                ? "Cowork sessions cannot be resumed locally."
                : "This session has no project path on disk and cannot be resumed."
        }
        placeholder={(t) =>
          t.type === "terminal"
            ? "Open a shell in this project (Enter to start)"
            : `Continue this conversation with ${t.label}...`
        }
        buildCommand={(t, prompt) => {
          if (t.type === "terminal") return { initialInput: prompt || undefined };
          const extra = t.type === "claude" ? `--resume ${session.id}` : `resume ${session.id}`;
          return { command: buildAgentCommand(t.type, prompt, extra) };
        }}
        trailing={<PlatformModelPicker selection={selection} usage={usage} />}
      />
    </div>
  );
}

// ============================================================================
// Composer infrastructure
// ----------------------------------------------------------------------------
// Two call sites use the same terminal-style prompt box: `SessionDetail` (for
// `claude --resume <id>`) and the right-panel empty state (for fresh
// `claude` / `codex` / shell). They share the same input + Terminal selector
// + inline PTY pattern; only the command builder and the toolbar trailing
// slot differ. Everything below is the shared kit.
// ============================================================================

type ActivePty = { ptyId: string; cwd: string; command?: string; initialInput?: string };

/** Build a `claude`/`codex` command from agent + prompt + optional argv passed
 *  through verbatim (e.g. `--resume <id>`). */
function buildAgentCommand(
  agent: "claude" | "codex",
  prompt: string,
  extraArgs?: string,
): string {
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const head = extraArgs ? `${agent} ${extraArgs}` : agent;
  return prompt ? `${head} "${escape(prompt)}"` : head;
}

/** Owns the global Platform/Model selection. Reads from MaaS Registry +
 *  ~/.claude/settings.json; writes flow back through Tauri. Hook so both
 *  composers can drop in the picker without duplicating state. */
function useMaasActiveSelection() {
  const queryClient = useQueryClient();
  const [recentModels, setRecentModels] = useAtom(recentModelsAtom);
  const { data: maasRegistry = [] } = useInvokeQuery<import("../../types").MaasProvider[]>(
    ["maas_registry"],
    "get_maas_registry",
  );
  const { data: claudeSettings } = useInvokeQuery<import("../../types").ClaudeSettings>(
    ["settings"],
    "get_settings",
  );

  const activeProviderKey: string | null = (() => {
    const raw = claudeSettings?.raw;
    if (!raw || typeof raw !== "object") return null;
    const lovcode = (raw as Record<string, unknown>).lovcode;
    if (!lovcode || typeof lovcode !== "object") return null;
    const v = (lovcode as Record<string, unknown>).activeProvider;
    return typeof v === "string" ? v : null;
  })();
  const activeModelName: string | null = (() => {
    const raw = claudeSettings?.raw;
    if (!raw || typeof raw !== "object") return null;
    const env = (raw as Record<string, unknown>).env;
    if (!env || typeof env !== "object") return null;
    const v = (env as Record<string, unknown>).ANTHROPIC_DEFAULT_SONNET_MODEL;
    return typeof v === "string" && v ? v : null;
  })();
  const activeProvider = activeProviderKey
    ? maasRegistry.find((p) => p.key === activeProviderKey) ?? null
    : null;
  const activeModel =
    activeProvider && activeModelName
      ? activeProvider.models.find((m) => m.modelName === activeModelName) ?? null
      : null;
  const activeVendor =
    activeProvider && activeModel?.vendor
      ? activeProvider.vendors?.find((v) => v.id === activeModel.vendor) ?? null
      : null;

  const switchActiveModel = async (
    provider: import("../../types").MaasProvider,
    modelName: string,
  ) => {
    try {
      if (provider.key === "anthropic-subscription") {
        await invoke("update_settings_env", { envKey: "CLAUDE_CODE_USE_OAUTH", envValue: "1" });
        await invoke("update_settings_env", {
          envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
          envValue: modelName,
        });
        await invoke("delete_settings_env", { envKey: "ANTHROPIC_AUTH_TOKEN" }).catch(() => {});
        await invoke("delete_settings_env", { envKey: "ANTHROPIC_BASE_URL" }).catch(() => {});
      } else {
        await invoke("update_settings_env", {
          envKey: "ANTHROPIC_BASE_URL",
          envValue: provider.baseUrl.trim(),
        });
        await invoke("update_settings_env", {
          envKey: "ANTHROPIC_AUTH_TOKEN",
          envValue: provider.authToken.trim(),
        });
        await invoke("update_settings_env", {
          envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
          envValue: modelName,
        });
        await invoke("delete_settings_env", { envKey: "CLAUDE_CODE_USE_OAUTH" }).catch(() => {});
      }
      await invoke("update_settings_field", {
        field: "lovcode",
        value: { activeProvider: provider.key },
      });
      queryClient.invalidateQueries({ queryKey: ["settings"] });

      setRecentModels((prev) => {
        const next: RecentModelEntry[] = [
          { providerKey: provider.key, modelName, at: Date.now() },
          ...prev.filter(
            (r) => !(r.providerKey === provider.key && r.modelName === modelName),
          ),
        ];
        return next.slice(0, MAX_RECENT_MODELS);
      });
    } catch (e) {
      console.error("switchActiveModel failed", e);
    }
  };

  const switchActiveProvider = async (provider: import("../../types").MaasProvider) => {
    if (provider.models.length === 0) {
      console.warn("provider has no models:", provider.key);
      return;
    }
    const keepCurrent =
      activeModelName && provider.models.some((m) => m.modelName === activeModelName)
        ? activeModelName
        : provider.models[0].modelName;
    await switchActiveModel(provider, keepCurrent);
  };

  return {
    maasRegistry,
    activeProviderKey,
    activeModelName,
    activeProvider,
    activeModel,
    activeVendor,
    recentModels,
    switchActiveProvider,
    switchActiveModel,
  };
}

/** Platform + Model + optional context-window pill. Shared by both composers. */
function PlatformModelPicker({
  selection,
  usage,
}: {
  selection: ReturnType<typeof useMaasActiveSelection>;
  usage?: import("../../types").SessionUsage;
}) {
  const {
    maasRegistry,
    activeProviderKey,
    activeModelName,
    activeProvider,
    activeModel,
    activeVendor,
    recentModels,
    switchActiveProvider,
    switchActiveModel,
  } = selection;
  const [modelSearch, setModelSearch] = useState("");

  const histInfo = inferModelInfo(usage?.model);
  const ctx = usage?.context_tokens ?? 0;
  const pct =
    histInfo?.contextWindow && ctx > 0
      ? Math.min(100, Math.round((ctx / histInfo.contextWindow) * 100))
      : null;
  const ctxPart =
    ctx > 0 ? `ctx ${formatTokens(ctx)}${pct !== null ? ` (${pct}%)` : ""}` : null;

  const usableProviders = maasRegistry.filter((p) => {
    if (COMING_SOON_PROVIDER_KEYS.has(p.key)) return false;
    const hasAuth = p.key === "anthropic-subscription" || p.authToken.trim().length > 0;
    return hasAuth && p.models.length > 0;
  });

  const providerLabel = activeProvider
    ? activeProvider.label || activeProvider.key
    : "Select platform";
  const modelLabel = activeModel
    ? activeModel.displayName
    : activeProvider
      ? "Select model"
      : "—";

  return (
    <div className="flex items-center gap-1.5 min-w-0 flex-1">
      <div className="flex flex-row-reverse items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-card rounded-md transition-colors min-w-0"
              title={
                activeProvider
                  ? `Platform: ${activeProvider.label || activeProvider.key}`
                  : "No platform selected. Click to pick one."
              }
            >
              <RocketIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate">{providerLabel}</span>
              <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px] max-w-[320px] p-0">
            <div className="max-h-[360px] overflow-y-auto p-1">
              {usableProviders.length === 0 ? (
                <DropdownMenuItem disabled>
                  <span className="text-xs text-muted-foreground">
                    No providers ready. Open Settings → MaaS Registry.
                  </span>
                </DropdownMenuItem>
              ) : (
                usableProviders.map((p) => {
                  const isCurrent = p.key === activeProviderKey;
                  return (
                    <DropdownMenuItem
                      key={p.key}
                      onClick={() => switchActiveProvider(p)}
                      className={isCurrent ? "bg-primary/10" : ""}
                    >
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        {isCurrent ? (
                          <CheckIcon className="w-3 h-3 text-primary flex-shrink-0" />
                        ) : (
                          <span className="w-3 flex-shrink-0" />
                        )}
                        <span className="text-xs font-medium truncate flex-1">
                          {p.label || p.key}
                        </span>
                        <span className="text-[10px] text-muted-foreground flex-shrink-0">
                          {p.models.length} model{p.models.length === 1 ? "" : "s"}
                        </span>
                      </div>
                    </DropdownMenuItem>
                  );
                })
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="text-xs text-muted-foreground/60 flex-shrink-0">/</span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={!activeProvider}
              className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-card rounded-md transition-colors min-w-0 disabled:opacity-50 disabled:cursor-not-allowed"
              title={
                activeModel
                  ? `Model: ${activeModel.modelName}${
                      activeVendor ? `\nVendor: ${activeVendor.name}` : ""
                    }`
                  : activeProvider
                    ? "Pick a model for this platform"
                    : "Select a platform first"
              }
            >
              <span className="truncate">{modelLabel}</span>
              <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-[260px] max-w-[380px] p-0"
            onCloseAutoFocus={() => setModelSearch("")}
          >
            {activeProvider && activeProvider.models.length > 0 && (
              <div className="p-1.5 border-b border-border">
                <input
                  type="text"
                  autoFocus
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="Search id, name, vendor..."
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key !== "Escape" && e.key !== "Enter" && e.key !== "Tab") {
                      e.stopPropagation();
                    }
                  }}
                  className="w-full h-7 px-2 text-xs rounded bg-background border border-input focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            )}
            <div className="max-h-[360px] overflow-y-auto p-1">
              {!activeProvider ? (
                <DropdownMenuItem disabled>
                  <span className="text-xs text-muted-foreground">Pick a platform first</span>
                </DropdownMenuItem>
              ) : activeProvider.models.length === 0 ? (
                <DropdownMenuItem disabled>
                  <span className="text-xs text-muted-foreground">
                    This platform has no models. Open Settings → MaaS Registry.
                  </span>
                </DropdownMenuItem>
              ) : (() => {
                const q = modelSearch.trim().toLowerCase();
                const sorted = activeProvider.models
                  .slice()
                  .sort((a, b) => a.modelName.localeCompare(b.modelName));

                const renderItem = (m: import("../../types").MaasModel, keyPrefix = "") => {
                  const vendor = m.vendor
                    ? activeProvider.vendors?.find((v) => v.id === m.vendor) ?? null
                    : null;
                  const isCurrent = m.modelName === activeModelName;
                  return (
                    <DropdownMenuItem
                      key={`${keyPrefix}${m.id}`}
                      onClick={() => switchActiveModel(activeProvider, m.modelName)}
                      className={isCurrent ? "bg-primary/10" : ""}
                    >
                      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {isCurrent ? (
                            <CheckIcon className="w-3 h-3 text-primary flex-shrink-0" />
                          ) : (
                            <span className="w-3 flex-shrink-0" />
                          )}
                          <span className="text-xs font-medium truncate">{m.displayName}</span>
                          {vendor && (
                            <span className="text-[10px] text-muted-foreground truncate">
                              {vendor.name}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground font-mono truncate pl-4">
                          {m.modelName}
                        </span>
                      </div>
                    </DropdownMenuItem>
                  );
                };

                if (q) {
                  const filtered = sorted.filter((m) => {
                    const vendorName = m.vendor
                      ? activeProvider.vendors?.find((v) => v.id === m.vendor)?.name ?? m.vendor
                      : "";
                    return (
                      m.id.toLowerCase().includes(q) ||
                      m.displayName.toLowerCase().includes(q) ||
                      m.modelName.toLowerCase().includes(q) ||
                      vendorName.toLowerCase().includes(q)
                    );
                  });
                  if (filtered.length === 0) {
                    return (
                      <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                        No models match "{modelSearch}"
                      </div>
                    );
                  }
                  return filtered.map((m) => renderItem(m));
                }

                const recentForProvider = recentModels
                  .filter((r) => r.providerKey === activeProvider.key)
                  .map((r) => activeProvider.models.find((m) => m.modelName === r.modelName))
                  .filter((m): m is import("../../types").MaasModel => !!m);

                return (
                  <>
                    {recentForProvider.length > 0 && (
                      <>
                        <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Recent
                        </div>
                        {recentForProvider.map((m) => renderItem(m, "recent:"))}
                        <div className="my-1 border-t border-border" />
                        <div className="px-2 pt-0.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          All Models
                        </div>
                      </>
                    )}
                    {sorted.map((m) => renderItem(m, "all:"))}
                  </>
                );
              })()}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {ctxPart && (
        <span
          className="text-[10px] text-muted-foreground font-mono truncate ml-auto"
          title={
            ctx > 0
              ? `Peak context: ${ctx.toLocaleString()} tokens${
                  histInfo?.contextWindow
                    ? ` / ${histInfo.contextWindow.toLocaleString()} (${pct}%)`
                    : ""
                }`
              : undefined
          }
        >
          {ctxPart}
        </span>
      )}
    </div>
  );
}

/** Project picker shown above the input in `NewSessionComposer`. Recent + All
 *  Projects + native folder dialog. */
function ProjectPicker({
  cwd,
  onCwdChange,
  projects,
  recentProjects,
}: {
  cwd: string | null;
  onCwdChange: (path: string) => void;
  projects: Project[];
  recentProjects: RecentProjectEntry[];
}) {
  const { formatPath } = useAppConfig();
  const recentPaths = new Set(recentProjects.map((r) => r.path));
  const otherProjects = projects
    .filter((p) => !recentPaths.has(p.path))
    .slice()
    .sort((a, b) => b.last_active - a.last_active)
    .slice(0, 10);

  const pickFolder = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string" && picked.length > 0) onCwdChange(picked);
  };

  const cwdLabel = cwd ? formatPath(cwd) : "Pick a project folder…";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-card rounded-md transition-colors min-w-0 max-w-full"
          title={cwd ?? "Pick a project folder"}
        >
          <Folder className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate font-mono">{cwdLabel}</span>
          <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[280px] max-w-[420px] p-0">
        <div className="max-h-[360px] overflow-y-auto p-1">
          {recentProjects.length > 0 && (
            <>
              <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent
              </div>
              {recentProjects.map((r) => {
                const isCurrent = r.path === cwd;
                return (
                  <DropdownMenuItem
                    key={`recent:${r.path}`}
                    onClick={() => onCwdChange(r.path)}
                    className={isCurrent ? "bg-primary/10" : ""}
                  >
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      {isCurrent ? (
                        <CheckIcon className="w-3 h-3 text-primary flex-shrink-0" />
                      ) : (
                        <span className="w-3 flex-shrink-0" />
                      )}
                      <ProjectLogo projectPath={r.path} size="sm" />
                      <span className="text-xs truncate flex-1 font-mono" title={r.path}>
                        {formatPath(r.path)}
                      </span>
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </>
          )}
          {otherProjects.length > 0 && (
            <>
              {recentProjects.length > 0 && <div className="my-1 border-t border-border" />}
              <div className="px-2 pt-0.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                All projects
              </div>
              {otherProjects.map((p) => {
                const isCurrent = p.path === cwd;
                return (
                  <DropdownMenuItem
                    key={`all:${p.id}`}
                    onClick={() => onCwdChange(p.path)}
                    className={isCurrent ? "bg-primary/10" : ""}
                  >
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      {isCurrent ? (
                        <CheckIcon className="w-3 h-3 text-primary flex-shrink-0" />
                      ) : (
                        <span className="w-3 flex-shrink-0" />
                      )}
                      <ProjectLogo projectPath={p.path} size="sm" />
                      <span className="text-xs truncate flex-1 font-mono" title={p.path}>
                        {formatPath(p.path)}
                      </span>
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </>
          )}
          {recentProjects.length === 0 && otherProjects.length === 0 && (
            <DropdownMenuItem disabled>
              <span className="text-xs text-muted-foreground">No projects yet</span>
            </DropdownMenuItem>
          )}
        </div>
        <DropdownMenuSeparator className="m-0" />
        <div className="p-1">
          <DropdownMenuItem onClick={pickFolder} className="gap-2">
            <Folder className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs">Pick folder…</span>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shared terminal-style composer used by both `SessionDetail` (resume) and
 *  the right-panel empty state (new session). The two call sites differ only
 *  in: (1) the command they build on submit, (2) optional `leading` content
 *  (project picker for new sessions), and (3) the placeholder text. */
function Composer({
  cwd,
  buildCommand,
  placeholder,
  leading,
  trailing,
  disabled,
  emptyMessage,
  onSpawn,
  resetKey,
}: {
  cwd: string | null;
  buildCommand: (
    terminalOpt: TerminalOption,
    prompt: string,
  ) => { command?: string; initialInput?: string };
  placeholder: (terminalOpt: TerminalOption) => string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  disabled?: boolean;
  /** When set, the composer is replaced by this dashed-border message and no
   *  input is rendered. Used by `SessionDetail` for non-resumable sessions. */
  emptyMessage?: React.ReactNode;
  onSpawn?: (cwd: string) => void;
  /** Identity that should reset the input + tear down the PTY when it
   *  changes (e.g. switching between sessions). */
  resetKey?: string;
}) {
  const defaultTerminal = TERMINAL_OPTIONS.find((o) => o.type === "claude") ?? TERMINAL_OPTIONS[0];
  const [terminalOpt, setTerminalOpt] = useState<TerminalOption>(defaultTerminal);
  const [input, setInput] = useState("");
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activePty, setActivePty] = useState<ActivePty | null>(null);
  const [ptyHeight, setPtyHeight] = useAtom(composerPtyHeightAtom);
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null);

  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragStateRef.current = { startY: e.clientY, startH: ptyHeight };
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = dragStateRef.current;
    if (!s) return;
    const maxH = Math.max(PTY_HEIGHT_MIN, Math.floor(window.innerHeight * 0.8));
    const next = Math.min(maxH, Math.max(PTY_HEIGHT_MIN, s.startH + (s.startY - e.clientY)));
    setPtyHeight(next);
  };
  const onResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current) {
      try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch {}
      dragStateRef.current = null;
    }
  };

  useEffect(() => {
    setInput("");
    setActivePty((prev) => {
      if (prev) {
        disposeTerminal(prev.ptyId);
        invoke("pty_kill", { id: prev.ptyId }).catch(() => {});
        invoke("pty_purge_scrollback", { id: prev.ptyId }).catch(() => {});
      }
      return null;
    });
  }, [resetKey]);

  const submit = () => {
    if (disabled || !cwd) return;
    const prompt = input.trim();
    const { command, initialInput } = buildCommand(terminalOpt, prompt);
    setActivePty({ ptyId: crypto.randomUUID(), cwd, command, initialInput });
    setInput("");
    onSpawn?.(cwd);
  };

  const closeActivePty = () => {
    setActivePty((prev) => {
      if (prev) {
        disposeTerminal(prev.ptyId);
        invoke("pty_kill", { id: prev.ptyId }).catch(() => {});
        invoke("pty_purge_scrollback", { id: prev.ptyId }).catch(() => {});
      }
      return null;
    });
  };

  if (emptyMessage) {
    return (
      <div className="shrink-0 min-w-0 px-6 pb-1 pt-3 border-t border-border bg-background overflow-hidden">
        <div className="px-4 py-2.5 border border-dashed border-border rounded-xl bg-card/60 text-xs text-muted-foreground">
          {emptyMessage}
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 min-w-0 px-6 pb-3 pt-3 border-t border-border bg-background overflow-hidden">
      {activePty ? (
        <div className="relative border border-border rounded-xl overflow-hidden bg-terminal shadow-sm">
          <div
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            className="absolute inset-x-0 top-0 h-1.5 cursor-ns-resize z-10 hover:bg-primary/40 active:bg-primary/60 transition-colors"
            title="Drag to resize"
          />
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-card-alt/40">
            <span className="text-xs text-muted-foreground font-mono truncate">
              {activePty.command ?? "shell"}
            </span>
            <button
              onClick={closeActivePty}
              className="p-1 rounded text-muted-foreground hover:bg-card-alt hover:text-ink transition-colors"
              title="Close terminal"
            >
              <Cross2Icon className="w-3.5 h-3.5" />
            </button>
          </div>
          <div style={{ height: ptyHeight }}>
            <TerminalPane
              ptyId={activePty.ptyId}
              cwd={activePty.cwd}
              command={activePty.command}
              initialInput={activePty.initialInput}
              visible
              autoFocus
              onExit={closeActivePty}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {leading && <div className="flex items-center gap-2 px-1">{leading}</div>}
          <div className="flex items-start gap-2 px-4 py-2.5 border border-border/60 rounded-xl bg-terminal shadow-sm overflow-hidden">
            <span className="shrink-0 text-sm leading-6 font-mono text-primary/80 select-none">$</span>
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const ta = e.target;
                ta.style.height = "auto";
                ta.style.height = `${ta.scrollHeight}px`;
              }}
              placeholder={placeholder(terminalOpt)}
              disabled={disabled || !cwd}
              className="flex-1 min-w-0 px-0 py-0 bg-transparent resize-none outline-none text-sm leading-6 font-mono text-neutral-100 caret-primary placeholder:text-neutral-500 overflow-hidden disabled:opacity-50"
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => {
                requestAnimationFrame(() => { composingRef.current = false; });
              }}
              onKeyDown={(e) => {
                if (e.key === "Process" || composingRef.current) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <span
              className="pointer-events-none shrink-0 inline-flex items-center h-6 text-neutral-500 select-none"
              title="Press Enter to send"
            >
              <CornerDownLeft className="w-4 h-4" />
            </span>
          </div>
          <div className="flex items-center gap-2 px-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-card rounded-md transition-colors">
                  <DesktopIcon className="w-3.5 h-3.5" />
                  <span>{terminalOpt.label}</span>
                  <ChevronDownIcon className="w-3 h-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[140px]">
                {TERMINAL_OPTIONS.map((opt) => (
                  <DropdownMenuItem key={opt.type} onClick={() => setTerminalOpt(opt)}>
                    <span className={opt.type === terminalOpt.type ? "font-medium" : ""}>
                      {opt.label}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {trailing}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// New-session composer: thin wrapper around <Composer> for the empty state
// ============================================================================

function NewSessionComposer({
  cwd,
  onCwdChange,
  projects,
  recentProjects,
  onSpawn,
}: {
  cwd: string | null;
  onCwdChange: (path: string) => void;
  projects: Project[];
  recentProjects: RecentProjectEntry[];
  onSpawn: (path: string) => void;
}) {
  const { formatPath } = useAppConfig();
  const selection = useMaasActiveSelection();

  return (
    <Composer
      cwd={cwd}
      resetKey={cwd ?? "no-cwd"}
      onSpawn={onSpawn}
      placeholder={(t) =>
        !cwd
          ? "Pick a project folder to start"
          : t.type === "terminal"
            ? `Open a shell in ${formatPath(cwd)} (Enter to start)`
            : `Start a new ${t.label} session in ${formatPath(cwd)}...`
      }
      buildCommand={(t, prompt) => {
        if (t.type === "terminal") return { initialInput: prompt || undefined };
        return { command: buildAgentCommand(t.type, prompt) };
      }}
      leading={
        <ProjectPicker
          cwd={cwd}
          onCwdChange={onCwdChange}
          projects={projects}
          recentProjects={recentProjects}
        />
      }
      trailing={<PlatformModelPicker selection={selection} />}
    />
  );
}
