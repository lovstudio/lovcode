import { useState, useRef, useCallback, useMemo } from "react";
import { useAtom } from "jotai";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  DotsVerticalIcon,
  MixIcon,
  ListBulletIcon,
  GroupIcon,
} from "@radix-ui/react-icons";
import {
  workspaceDataAtom,
  collapsedProjectGroupsAtom,
  verticalTabsSidebarWidthAtom,
  dashboardSessionsVisibleAtom,
  sidebarSessionSortByAtom,
  sidebarViewModeAtom,
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
    return allSessions
      .filter((s) => s.message_count > 0)
      .sort((a, b) => {
        if (sortBy === "created") return b.created_at - a.created_at;
        if (sortBy === "path") return (a.project_path ?? "").localeCompare(b.project_path ?? "");
        return b.last_modified - a.last_modified;
      })
      .slice(0, 100);
  }, [allSessions, sortBy, viewMode]);

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
      className="flex flex-col border-r border-border bg-card shrink-0 relative"
      style={{ width: sidebarWidth }}
    >
      {/* Sessions Content */}
      <div className="flex-1 overflow-y-auto py-2">
        {isLoading ? (
          <div className="text-xs text-muted-foreground px-4 py-2">Loading...</div>
        ) : viewMode === "grouped" ? (
          <GroupedView
            projects={sortedProjects}
            allSessions={allSessions}
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

      {/* Footer Actions */}
      <div className="shrink-0 border-t border-border p-2 flex gap-1">
        <button
          onClick={() => setViewMode(viewMode === "grouped" ? "flat" : "grouped")}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-ink hover:bg-muted rounded-lg transition-colors"
          title={viewMode === "grouped" ? "Switch to flat view" : "Switch to grouped view"}
        >
          {viewMode === "grouped" ? (
            <ListBulletIcon className="w-3.5 h-3.5" />
          ) : (
            <GroupIcon className="w-3.5 h-3.5" />
          )}
          <span>{viewMode === "grouped" ? "Flat" : "Grouped"}</span>
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
          <MixIcon className="w-3.5 h-3.5" />
          <span>{sortBy === "modified" ? "Modified" : sortBy === "created" ? "Created" : "Path"}</span>
        </button>
        <button
          onClick={() => setSidebarVisible(false)}
          className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-ink hover:bg-muted rounded-lg transition-colors"
          title="Hide sidebar"
        >
          <ChevronLeftIcon className="w-3.5 h-3.5" />
        </button>
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
// Grouped View (by project path)
// ============================================================================

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
  if (projects.length === 0) {
    return <div className="text-xs text-muted-foreground px-4 py-2">No CC sessions found</div>;
  }

  return (
    <div className="space-y-1">
      {projects.map((project) => (
        <CCProjectGroup
          key={project.id}
          project={project}
          allSessions={allSessions}
          sortBy={sortBy}
          isCollapsed={collapsedGroups.includes(project.id)}
          onToggleCollapse={() => onToggleCollapse(project.id)}
        />
      ))}
    </div>
  );
}

// ============================================================================
// Flat View (all sessions, no grouping)
// ============================================================================

function FlatView({ sessions }: { sessions: Session[] }) {
  if (sessions.length === 0) {
    return <div className="text-xs text-muted-foreground px-4 py-2">No CC sessions found</div>;
  }

  return (
    <div className="space-y-0.5 px-2">
      {sessions.map((session) => (
        <FlatSessionItem key={session.id} session={session} />
      ))}
    </div>
  );
}

function FlatSessionItem({ session }: { session: Session }) {
  const projectPath = session.project_path ?? "";
  const { handleResumeSession } = useSessionActions(projectPath);

  const projectName = projectPath.split("/").pop() || projectPath;

  return (
    <SessionItem
      session={session}
      projectLabel={projectName}
      onResume={() => handleResumeSession(session)}
    />
  );
}

// ============================================================================
// CC Project Group (auto-discovered from ~/.claude/projects/)
// ============================================================================

interface CCProjectGroupProps {
  project: Project;
  allSessions: Session[];
  sortBy: SessionSortBy;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

function CCProjectGroup({
  project,
  allSessions,
  sortBy,
  isCollapsed,
  onToggleCollapse,
}: CCProjectGroupProps) {
  const { handleResumeSession, handleNewTerminal, handleSelectProject } =
    useSessionActions(project.path);

  // Filter sessions for this project
  const filteredSessions = useMemo(() => {
    const normalizePath = (p: string) => p.replace(/\/+$/, "");
    const projectPathNorm = normalizePath(project.path);

    return allSessions
      .filter((s) => {
        if (!s.project_path) return false;
        return normalizePath(s.project_path) === projectPathNorm && s.message_count > 0;
      })
      .sort((a, b) => {
        if (sortBy === "created") return b.created_at - a.created_at;
        if (sortBy === "path") return (a.summary ?? "").localeCompare(b.summary ?? "");
        return b.last_modified - a.last_modified;
      })
      .slice(0, 20);
  }, [allSessions, project.path, sortBy]);

  const projectName = project.path.split("/").pop() || project.path;
  const projectDisplayName = projectName
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return (
    <div className="px-2">
      {/* Project Header */}
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

        <span className="text-xs text-muted-foreground">
          {filteredSessions.length}
        </span>

        <NewTerminalSplitButton
          variant="icon"
          onSelect={handleNewTerminal}
          className="opacity-0 group-hover:opacity-100"
        />
      </div>

      {/* Sessions List */}
      {!isCollapsed && (
        <div className="ml-4 mt-1 space-y-0.5">
          {filteredSessions.length === 0 ? (
            <div className="text-xs text-muted-foreground px-2 py-1">No sessions</div>
          ) : (
            filteredSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                onResume={() => handleResumeSession(session)}
              />
            ))
          )}
        </div>
      )}
    </div>
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
}

function SessionItem({ session, onResume, projectLabel }: SessionItemProps) {
  const [userPrompts, setUserPrompts] = useState<string[] | null>(null);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
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
    <div className="flex items-center gap-0.5 group">
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
        <TooltipContent side="right" className="max-w-[300px] p-2 bg-card text-ink border border-border">
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
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
