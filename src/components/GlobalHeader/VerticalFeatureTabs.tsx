import { useState, useRef, useCallback, useMemo, type CSSProperties } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  DotsVerticalIcon,
  MixIcon,
  ListBulletIcon,
  GroupIcon,
  ArchiveIcon,
} from "@radix-ui/react-icons";
import {
  workspaceDataAtom,
  collapsedProjectGroupsAtom,
  verticalTabsSidebarWidthAtom,
  dashboardSessionsVisibleAtom,
  sidebarSessionSortByAtom,
  sidebarViewModeAtom,
  archivedSessionIdsAtom,
  showArchivedSessionsAtom,
  type SessionSortBy,
} from "@/store";
import { useNavigate, useInvokeQuery } from "@/hooks";
import { invoke } from "@tauri-apps/api/core";
import type { Project, Session, Message } from "@/types";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectLogo } from "@/views/Workspace/ProjectLogo";
import { SessionDropdownMenuItems } from "@/components/shared/SessionMenuItems";
import { NewTerminalSplitButton } from "@/components/ui/new-terminal-button";
import type { WorkspaceData, WorkspaceProject } from "@/views/Workspace/types";
import { useReadableText, restoreSlashCommand } from "@/views/Chat/utils";

const MIN_WIDTH = 180;
const MAX_WIDTH = 400;

// ============================================================================
// Shared: ensure workspace project exists for a given path
// ============================================================================

function useEnsureWorkspaceProject() {
  const [workspace, setWorkspace] = useAtom(workspaceDataAtom);

  return useCallback(async (projectPath: string): Promise<WorkspaceProject> => {
    if (workspace) {
      const existing = workspace.projects.find((p) => p.path === projectPath);
      if (existing) return existing;
    }

    const wp = await invoke<WorkspaceProject>("workspace_add_project", { path: projectPath });
    setWorkspace((prev) => {
      if (!prev) return prev;
      if (prev.projects.some((p) => p.path === projectPath)) return prev;
      return { ...prev, projects: [...prev.projects, wp] };
    });
    return wp;
  }, [workspace, setWorkspace]);
}

// ============================================================================
// Shared: resume session / new terminal handlers
// ============================================================================

function useSessionActions(projectPath: string) {
  const [, setWorkspace] = useAtom(workspaceDataAtom);
  const navigate = useNavigate();
  const toReadable = useReadableText();
  const ensureWorkspaceProject = useEnsureWorkspaceProject();

  const openInTerminal = useCallback(async (
    wp: WorkspaceProject,
    title: string,
    command?: string,
    cwd?: string,
  ) => {
    setWorkspace((currentWorkspace) => {
      if (!currentWorkspace) return currentWorkspace;
      const currentProject = currentWorkspace.projects.find((p) => p.id === wp.id);
      if (!currentProject) return currentWorkspace;

      const panels = currentProject.panels || [];
      const panelId = panels[0]?.id;
      const ptySessionId = crypto.randomUUID();
      const ptyId = crypto.randomUUID();

      let savedWorkspace: WorkspaceData;

      if (!panelId) {
        const newPanelId = crypto.randomUUID();
        savedWorkspace = {
          ...currentWorkspace,
          projects: currentWorkspace.projects.map((p) =>
            p.id === wp.id
              ? {
                  ...p,
                  panels: [{
                    id: newPanelId,
                    sessions: [{ id: ptySessionId, pty_id: ptyId, title, command }],
                    active_session_id: ptySessionId,
                    is_shared: false,
                    cwd: cwd || p.path,
                  }],
                  layout: { type: "panel" as const, panelId: newPanelId },
                  view_mode: "terminal" as const,
                }
              : p
          ),
          active_project_id: wp.id,
        };
      } else {
        savedWorkspace = {
          ...currentWorkspace,
          projects: currentWorkspace.projects.map((p) =>
            p.id === wp.id
              ? {
                  ...p,
                  panels: p.panels.map((panel) =>
                    panel.id === panelId
                      ? { ...panel, sessions: [...panel.sessions, { id: ptySessionId, pty_id: ptyId, title, command }], active_session_id: ptySessionId }
                      : panel
                  ),
                  view_mode: "terminal" as const,
                }
              : p
          ),
          active_project_id: wp.id,
        };
      }

      invoke("workspace_save", { data: savedWorkspace });
      navigate({ type: "workspace", projectId: wp.id, mode: "terminal" });
      return savedWorkspace;
    });
  }, [setWorkspace, navigate]);

  const handleResumeSession = useCallback(async (session: Session) => {
    const wp = await ensureWorkspaceProject(projectPath);
    const title = session.title || toReadable(session.summary) || "Untitled";
    const command = `claude --resume "${session.id}"`;
    await openInTerminal(wp, title, command, projectPath);
  }, [ensureWorkspaceProject, projectPath, toReadable, openInTerminal]);

  const handleNewTerminal = useCallback(async (command?: string) => {
    const wp = await ensureWorkspaceProject(projectPath);
    const title = command === "claude" ? "Claude Code" : command === "codex" ? "Codex" : "Terminal";
    await openInTerminal(wp, title, command, projectPath);
  }, [ensureWorkspaceProject, projectPath, openInTerminal]);

  const handleSelectProject = useCallback(async () => {
    const wp = await ensureWorkspaceProject(projectPath);
    navigate({ type: "workspace", projectId: wp.id, mode: "dashboard" });

    setWorkspace((prev) => {
      if (!prev) return prev;
      const newWorkspace: WorkspaceData = {
        ...prev,
        active_project_id: wp.id,
        projects: prev.projects.map((p) =>
          p.id === wp.id ? { ...p, view_mode: "dashboard" as const } : p
        ),
      };
      invoke("workspace_save", { data: newWorkspace });
      return newWorkspace;
    });
  }, [ensureWorkspaceProject, projectPath, navigate, setWorkspace]);

  return { handleResumeSession, handleNewTerminal, handleSelectProject };
}

// ============================================================================
// Main Component
// ============================================================================

export function VerticalFeatureTabs() {
  const [collapsedGroups, setCollapsedGroups] = useAtom(collapsedProjectGroupsAtom);
  const [sidebarWidth, setSidebarWidth] = useAtom(verticalTabsSidebarWidthAtom);
  const [, setSidebarVisible] = useAtom(dashboardSessionsVisibleAtom);
  const [sortBy, setSortBy] = useAtom(sidebarSessionSortByAtom);
  const [viewMode, setViewMode] = useAtom(sidebarViewModeAtom);
  const [archivedIds] = useAtom(archivedSessionIdsAtom);
  const [showArchived, setShowArchived] = useAtom(showArchivedSessionsAtom);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);

  // Auto-discover CC projects from ~/.claude/projects/
  const { data: ccProjects = [], isLoading: projectsLoading } = useInvokeQuery<Project[]>(
    ["cc-projects"],
    "list_projects"
  );

  // Fetch all sessions once, shared across views
  const { data: allSessions = [], isLoading: sessionsLoading } = useInvokeQuery<Session[]>(
    ["sessions"],
    "list_all_sessions"
  );

  // Filter out archived unless showArchived is on
  const visibleSessions = useMemo(() => {
    if (showArchived) return allSessions;
    const archivedSet = new Set(archivedIds);
    return allSessions.filter((s) => !archivedSet.has(s.id));
  }, [allSessions, archivedIds, showArchived]);

  // Sort projects
  const sortedProjects = useMemo(() => {
    const filtered = ccProjects.filter((p) => p.session_count > 0);
    return filtered.sort((a, b) => {
      if (sortBy === "path") return a.path.localeCompare(b.path);
      return b.last_active - a.last_active;
    });
  }, [ccProjects, sortBy]);

  // Flat sorted sessions (for flat view)
  const flatSessions = useMemo(() => {
    if (viewMode !== "flat") return [];
    return visibleSessions
      .filter((s) => s.message_count > 0)
      .sort((a, b) => {
        if (sortBy === "created") return b.created_at - a.created_at;
        if (sortBy === "path") return (a.project_path ?? "").localeCompare(b.project_path ?? "");
        return b.last_modified - a.last_modified;
      });
  }, [visibleSessions, sortBy, viewMode]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [sidebarWidth, setSidebarWidth]);

  const isLoading = projectsLoading || sessionsLoading;

  return (
    <aside
      className="@container flex flex-col border-r border-border bg-card shrink-0 relative"
      style={{ width: sidebarWidth }}
    >
      {/* Header Actions */}
      <div className="shrink-0 border-b border-border p-2 flex gap-1">
        <button
          onClick={() => setViewMode(viewMode === "grouped" ? "flat" : "grouped")}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-ink hover:bg-muted rounded-lg transition-colors"
          title={viewMode === "grouped" ? "Switch to flat view" : "Switch to grouped view"}
        >
          {viewMode === "grouped" ? (
            <ListBulletIcon className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <GroupIcon className="w-3.5 h-3.5 shrink-0" />
          )}
          <span className="hidden @[320px]:inline">{viewMode === "grouped" ? "Flat" : "Grouped"}</span>
        </button>
        <button
          onClick={() => {
            const order: SessionSortBy[] = ["modified", "created", "path"];
            const idx = order.indexOf(sortBy);
            setSortBy(order[(idx + 1) % order.length]);
          }}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-ink hover:bg-muted rounded-lg transition-colors"
          title={`Sort: ${sortBy === "modified" ? "Modified" : sortBy === "created" ? "Created" : "Path"}`}
        >
          <MixIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden @[320px]:inline">{sortBy === "modified" ? "Modified" : sortBy === "created" ? "Created" : "Path"}</span>
        </button>
        <button
          onClick={() => setShowArchived(!showArchived)}
          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs hover:bg-muted rounded-lg transition-colors ${
            showArchived ? "text-primary" : "text-muted-foreground hover:text-ink"
          }`}
          title={showArchived ? "Hide archived sessions" : "Show archived sessions"}
        >
          <ArchiveIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden @[320px]:inline">Archive</span>
        </button>
        <button
          onClick={() => setSidebarVisible(false)}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-ink hover:bg-muted rounded-lg transition-colors"
          title="Hide sidebar"
        >
          <ChevronLeftIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden @[320px]:inline">Hide</span>
        </button>
      </div>

      {/* Sessions Content (each view owns its own scroll container for virtualization) */}
      <div className="flex-1 min-h-0">
        {isLoading ? (
          <div className="text-xs text-muted-foreground px-4 py-2">Loading...</div>
        ) : viewMode === "grouped" ? (
          <GroupedView
            projects={sortedProjects}
            allSessions={visibleSessions}
            sortBy={sortBy}
            collapsedGroups={collapsedGroups}
            onToggleCollapse={(id) => {
              if (collapsedGroups.includes(id)) {
                setCollapsedGroups(collapsedGroups.filter((g) => g !== id));
              } else {
                setCollapsedGroups([...collapsedGroups, id]);
              }
            }}
          />
        ) : (
          <FlatView sessions={flatSessions} />
        )}
      </div>

      {/* Resize Handle */}
      <div
        ref={resizeRef}
        onMouseDown={handleMouseDown}
        className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/30 transition-colors ${
          isResizing ? "bg-primary/50" : ""
        }`}
      />
    </aside>
  );
}

// ============================================================================
// Grouped View (by project path) — virtualized flat list of header/session rows
// ============================================================================

type GroupedRow =
  | { kind: "header"; project: Project; projectSessions: Session[]; isCollapsed: boolean }
  | { kind: "session"; project: Project; session: Session; index: number; projectSessions: Session[] }
  | { kind: "empty"; project: Project }
  | { kind: "spacer" };

const HEADER_ROW_HEIGHT = 40;
const SESSION_ROW_HEIGHT = 28;
const SPACER_ROW_HEIGHT = 4;
const EMPTY_ROW_HEIGHT = 24;

function GroupedView({
  projects,
  allSessions,
  sortBy,
  collapsedGroups,
  onToggleCollapse,
}: {
  projects: Project[];
  allSessions: Session[];
  sortBy: SessionSortBy;
  collapsedGroups: string[];
  onToggleCollapse: (id: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Build flat row list: [header, ...sessions, spacer, header, ...sessions, ...]
  const { rows, sessionsByProjectId } = useMemo(() => {
    const normalizePath = (p: string) => p.replace(/\/+$/, "");
    const byId = new Map<string, Session[]>();

    const rowList: GroupedRow[] = [];
    projects.forEach((project, projectIdx) => {
      const projectPathNorm = normalizePath(project.path);
      const projectSessions = allSessions
        .filter((s) => {
          if (!s.project_path) return false;
          return normalizePath(s.project_path) === projectPathNorm && s.message_count > 0;
        })
        .sort((a, b) => {
          if (sortBy === "created") return b.created_at - a.created_at;
          if (sortBy === "path") return (a.summary ?? "").localeCompare(b.summary ?? "");
          return b.last_modified - a.last_modified;
        });
      byId.set(project.id, projectSessions);

      const isCollapsed = collapsedGroups.includes(project.id);
      if (projectIdx > 0) rowList.push({ kind: "spacer" });
      rowList.push({ kind: "header", project, projectSessions, isCollapsed });
      if (!isCollapsed) {
        if (projectSessions.length === 0) {
          rowList.push({ kind: "empty", project });
        } else {
          projectSessions.forEach((session, index) => {
            rowList.push({ kind: "session", project, session, index, projectSessions });
          });
        }
      }
    });

    return { rows: rowList, sessionsByProjectId: byId };
  }, [projects, allSessions, sortBy, collapsedGroups]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (r.kind === "header") return HEADER_ROW_HEIGHT;
      if (r.kind === "spacer") return SPACER_ROW_HEIGHT;
      if (r.kind === "empty") return EMPTY_ROW_HEIGHT;
      return SESSION_ROW_HEIGHT;
    },
    overscan: 8,
  });

  if (projects.length === 0) {
    return <div className="text-xs text-muted-foreground px-4 py-2">No sessions found</div>;
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto py-2">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          const style: CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${vi.start}px)`,
          };

          if (row.kind === "spacer") {
            return <div key={vi.key} style={style} />;
          }

          if (row.kind === "header") {
            return (
              <div key={vi.key} style={style} className="px-2">
                <GroupedHeaderRow
                  project={row.project}
                  sessionCount={row.projectSessions.length}
                  isCollapsed={row.isCollapsed}
                  onToggleCollapse={() => onToggleCollapse(row.project.id)}
                />
              </div>
            );
          }

          if (row.kind === "empty") {
            return (
              <div key={vi.key} style={style} className="px-2">
                <div className="ml-4 text-xs text-muted-foreground px-2 py-1">No sessions</div>
              </div>
            );
          }

          // row.kind === "session"
          const projectSessions = sessionsByProjectId.get(row.project.id) ?? [];
          return (
            <div key={vi.key} style={style} className="px-2">
              <div className="ml-4">
                <GroupedSessionRow
                  project={row.project}
                  session={row.session}
                  index={row.index}
                  projectSessions={projectSessions}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GroupedHeaderRow({
  project,
  sessionCount,
  isCollapsed,
  onToggleCollapse,
}: {
  project: Project;
  sessionCount: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { handleNewTerminal, handleSelectProject } = useSessionActions(project.path);

  const projectName = project.path.split("/").pop() || project.path;
  const projectDisplayName = projectName
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return (
    <div
      className="group flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-ink hover:bg-card-alt"
      onClick={handleSelectProject}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleCollapse();
        }}
        className="p-0.5 text-muted-foreground hover:text-ink"
      >
        {isCollapsed ? (
          <ChevronRightIcon className="w-3.5 h-3.5" />
        ) : (
          <ChevronDownIcon className="w-3.5 h-3.5" />
        )}
      </button>

      <ProjectLogo projectPath={project.path} size="sm" />

      <span className="text-sm font-medium truncate flex-1" title={project.path}>
        {projectDisplayName}
      </span>

      <span className="text-xs text-muted-foreground">{sessionCount}</span>

      <NewTerminalSplitButton
        variant="icon"
        onSelect={handleNewTerminal}
        className="opacity-0 group-hover:opacity-100"
      />
    </div>
  );
}

function GroupedSessionRow({
  project,
  session,
  index,
  projectSessions,
}: {
  project: Project;
  session: Session;
  index: number;
  projectSessions: Session[];
}) {
  const { handleResumeSession } = useSessionActions(project.path);
  const setArchivedIds = useSetAtom(archivedSessionIdsAtom);

  const onArchiveAllAfter = useCallback(() => {
    const idsToArchive = projectSessions.slice(index).map((s) => s.id);
    setArchivedIds((prev) => Array.from(new Set([...prev, ...idsToArchive])));
  }, [projectSessions, index, setArchivedIds]);

  return (
    <SessionItem
      session={session}
      onResume={() => handleResumeSession(session)}
      afterCount={projectSessions.length - index - 1}
      onArchiveAllAfter={onArchiveAllAfter}
    />
  );
}

// ============================================================================
// Flat View (all sessions, no grouping) — virtualized
// ============================================================================

const FLAT_SESSION_ROW_HEIGHT = 44; // larger: includes project label line

function FlatView({ sessions }: { sessions: Session[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const setArchivedIds = useSetAtom(archivedSessionIdsAtom);

  const archiveFromIndex = useCallback((index: number) => {
    const idsToArchive = sessions.slice(index).map((s) => s.id);
    setArchivedIds((prev) => Array.from(new Set([...prev, ...idsToArchive])));
  }, [sessions, setArchivedIds]);

  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => FLAT_SESSION_ROW_HEIGHT,
    overscan: 8,
  });

  if (sessions.length === 0) {
    return <div className="text-xs text-muted-foreground px-4 py-2">No sessions found</div>;
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto py-2">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const session = sessions[vi.index];
          return (
            <div
              key={vi.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
              }}
              className="px-2"
            >
              <FlatSessionItem
                session={session}
                afterCount={sessions.length - vi.index - 1}
                onArchiveAllAfter={() => archiveFromIndex(vi.index)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FlatSessionItem({
  session,
  afterCount,
  onArchiveAllAfter,
}: {
  session: Session;
  afterCount: number;
  onArchiveAllAfter: () => void;
}) {
  const projectPath = session.project_path ?? "";
  const { handleResumeSession } = useSessionActions(projectPath);

  const projectName = projectPath.split("/").pop() || projectPath;

  return (
    <SessionItem
      session={session}
      projectLabel={projectName}
      onResume={() => handleResumeSession(session)}
      afterCount={afterCount}
      onArchiveAllAfter={onArchiveAllAfter}
    />
  );
}

// ============================================================================
// Session Item
// ============================================================================

interface SessionItemProps {
  session: Session;
  onResume: () => void;
  /** Show project label (used in flat view) */
  projectLabel?: string;
  /** Number of sessions after this one in the visible list (for "Archive this and N after") */
  afterCount?: number;
  onArchiveAllAfter?: () => void;
}

function SessionItem({ session, onResume, projectLabel, afterCount, onArchiveAllAfter }: SessionItemProps) {
  const [userPrompts, setUserPrompts] = useState<string[] | null>(null);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const [archivedIds] = useAtom(archivedSessionIdsAtom);
  const isArchived = archivedIds.includes(session.id);
  const toReadable = useReadableText();

  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } else if (diffDays === 1) {
      return "Yesterday";
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    }
  };

  const handleTooltipOpen = async (open: boolean) => {
    setIsTooltipOpen(open);
    if (open && userPrompts === null) {
      try {
        const messages = await invoke<Message[]>("get_session_messages", {
          projectId: session.project_id,
          sessionId: session.id,
        });
        const prompts = messages
          .filter((m) => m.role === "user")
          .map((m) => {
            const text = restoreSlashCommand(m.content.trim());
            return text.length > 100 ? text.slice(0, 100) + "..." : text;
          });
        setUserPrompts(prompts);
      } catch {
        setUserPrompts([]);
      }
    }
  };

  return (
    <div className={`flex items-center gap-0.5 group ${isArchived ? "opacity-50" : ""}`}>
      <Tooltip open={isTooltipOpen} onOpenChange={handleTooltipOpen}>
        <TooltipTrigger asChild>
          <button
            onClick={onResume}
            className="flex-1 flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors text-muted-foreground hover:text-ink hover:bg-card-alt min-w-0"
          >
            <div className="flex-1 min-w-0">
              <span className="text-xs truncate block">
                {session.title || toReadable(session.summary) || "Untitled"}
              </span>
              {projectLabel && (
                <span className="text-[10px] text-muted-foreground/60 truncate block">
                  {projectLabel}
                </span>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              {formatDate(session.last_modified)}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={24} className="max-w-[300px] p-2 bg-card text-ink border border-border">
          <div className="space-y-1.5">
            <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
              User Prompts ({userPrompts?.length ?? "..."})
            </div>
            {userPrompts === null ? (
              <div className="text-xs text-muted-foreground">Loading...</div>
            ) : userPrompts.length === 0 ? (
              <div className="text-xs text-muted-foreground">No prompts</div>
            ) : (
              <div className="space-y-1 max-h-[200px] overflow-y-auto">
                {userPrompts.map((prompt, i) => (
                  <div
                    key={i}
                    className="text-xs text-ink/80 bg-muted/50 rounded px-1.5 py-1 truncate"
                  >
                    {prompt}
                  </div>
                ))}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="p-0.5 rounded text-muted-foreground hover:text-ink hover:bg-card-alt opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <DotsVerticalIcon className="w-3 h-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          <div className="px-2 py-1.5 text-[10px] text-muted-foreground font-mono border-b border-border mb-1">
            #{session.id.slice(0, 8)}
          </div>
          <SessionDropdownMenuItems
            projectId={session.project_id}
            sessionId={session.id}
            projectPath={session.project_path ?? undefined}
            onResume={onResume}
            onArchiveAllAfter={onArchiveAllAfter}
            archiveAfterCount={afterCount}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
