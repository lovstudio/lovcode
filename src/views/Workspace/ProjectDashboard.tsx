import { useMemo } from "react";
import { useAtom } from "jotai";
import { ChatBubbleIcon, DotsVerticalIcon } from "@radix-ui/react-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useInvokeQuery } from "@/hooks";
import { workspaceDataAtom } from "@/store";
import { invoke } from "@tauri-apps/api/core";
import { ProjectLogo } from "./ProjectLogo";
import { GitHistory } from "./GitHistory";
import { ProjectDiagnostics } from "./ProjectDiagnostics";
import { LogoManager } from "./LogoManager";
import { SessionDropdownMenuItems } from "@/components/shared/SessionMenuItems";
import { NewTerminalSplitButton } from "@/components/ui/new-terminal-button";
import type { WorkspaceProject } from "./types";
import type { Session } from "@/types";
import { useReadableText } from "@/views/Chat/utils";
import type { WorkspaceData } from "./types";

interface ProjectDashboardProps {
  project: WorkspaceProject;
}

function BentoCard({
  title,
  children,
  className = "",
  action,
  subtitle,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
  subtitle?: React.ReactNode;
}) {
  return (
    <div className={`bg-card border border-border rounded-2xl overflow-hidden flex flex-col ${className}`}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</h3>
          {subtitle}
        </div>
        {action}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

export function ProjectDashboard({ project }: ProjectDashboardProps) {
  const [, setWorkspace] = useAtom(workspaceDataAtom);
  const toReadable = useReadableText();

  // Fetch all CC sessions
  const { data: allSessions = [], isLoading } = useInvokeQuery<Session[]>(
    ["sessions"],
    "list_all_sessions"
  );

  // Filter to sessions matching this project's path
  const filteredSessions = useMemo(() => {
    const normalizePath = (p: string) => p.replace(/\/+$/, "");
    const projectPathNorm = normalizePath(project.path);

    return allSessions
      .filter((s) => {
        if (!s.project_path) return false;
        return normalizePath(s.project_path) === projectPathNorm && s.message_count > 0;
      })
      .sort((a, b) => b.last_modified - a.last_modified);
  }, [allSessions, project.path]);

  const recentSessions = filteredSessions.slice(0, 5);

  const handleResumeSession = async (session: Session) => {
    let savedWorkspace: WorkspaceData | null = null;

    setWorkspace((currentWorkspace) => {
      if (!currentWorkspace) return currentWorkspace;

      const currentProject = currentWorkspace.projects.find((p) => p.id === project.id);
      if (!currentProject) return currentWorkspace;

      const panels = currentProject.panels || [];
      const panelId = panels[0]?.id;
      const title = toReadable(session.summary) || "Untitled";
      const command = `claude --resume "${session.id}"`;

      if (!panelId) {
        const newPanelId = crypto.randomUUID();
        const ptySessionId = crypto.randomUUID();
        const ptyId = crypto.randomUUID();

        const newPanel = {
          id: newPanelId,
          sessions: [{ id: ptySessionId, pty_id: ptyId, title, command }],
          active_session_id: ptySessionId,
          is_shared: false,
          cwd: project.path,
        };

        savedWorkspace = {
          ...currentWorkspace,
          projects: currentWorkspace.projects.map((p) =>
            p.id === project.id
              ? { ...p, panels: [newPanel], layout: { type: "panel" as const, panelId: newPanelId }, view_mode: "terminal" as const }
              : p
          ),
          active_project_id: project.id,
        };
        return savedWorkspace;
      } else {
        const ptySessionId = crypto.randomUUID();
        const ptyId = crypto.randomUUID();

        savedWorkspace = {
          ...currentWorkspace,
          projects: currentWorkspace.projects.map((p) =>
            p.id === project.id
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
          active_project_id: project.id,
        };
        return savedWorkspace;
      }
    });

    if (savedWorkspace) {
      await invoke("workspace_save", { data: savedWorkspace });
    }
  };

  const handleNewTerminal = async (command?: string) => {
    let savedWorkspace: WorkspaceData | null = null;

    setWorkspace((currentWorkspace) => {
      if (!currentWorkspace) return currentWorkspace;

      const currentProject = currentWorkspace.projects.find((p) => p.id === project.id);
      if (!currentProject) return currentWorkspace;

      const panels = currentProject.panels || [];
      const panelId = panels[0]?.id;
      const title = command === "claude" ? "Claude Code" : command === "codex" ? "Codex" : "Terminal";

      if (!panelId) {
        const newPanelId = crypto.randomUUID();
        const ptySessionId = crypto.randomUUID();
        const ptyId = crypto.randomUUID();

        const newPanel = {
          id: newPanelId,
          sessions: [{ id: ptySessionId, pty_id: ptyId, title, command }],
          active_session_id: ptySessionId,
          is_shared: false,
          cwd: project.path,
        };

        savedWorkspace = {
          ...currentWorkspace,
          projects: currentWorkspace.projects.map((p) =>
            p.id === project.id
              ? { ...p, panels: [newPanel], layout: { type: "panel" as const, panelId: newPanelId }, view_mode: "terminal" as const }
              : p
          ),
          active_project_id: project.id,
        };
        return savedWorkspace;
      } else {
        const ptySessionId = crypto.randomUUID();
        const ptyId = crypto.randomUUID();

        savedWorkspace = {
          ...currentWorkspace,
          projects: currentWorkspace.projects.map((p) =>
            p.id === project.id
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
          active_project_id: project.id,
        };
        return savedWorkspace;
      }
    });

    if (savedWorkspace) {
      await invoke("workspace_save", { data: savedWorkspace });
    }
  };

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

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden bg-muted/30">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 bg-card border-b border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ProjectLogo projectPath={project.path} size="lg" />
            <div>
              <h1 className="font-serif text-xl font-bold text-ink">
                {project.name.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")}
              </h1>
              <p className="text-xs text-muted-foreground truncate max-w-md">
                {project.path}
              </p>
            </div>
          </div>
          <NewTerminalSplitButton onSelect={handleNewTerminal} />
        </div>
      </div>

      {/* Bento Grid */}
      <div className="flex-1 min-h-0 p-4 overflow-y-auto">
        <div className="grid grid-cols-12 gap-4 h-full" style={{ minHeight: '600px' }}>
          {/* Recent Sessions - spans full width */}
          {recentSessions.length > 0 && (
            <div className="col-span-12 bg-card border border-border rounded-2xl px-4 py-3">
              <h3 className="text-xs font-medium text-muted-foreground mb-2">Recent Sessions</h3>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {recentSessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => handleResumeSession(session)}
                    className="flex-shrink-0 px-3 py-1.5 text-sm bg-muted hover:bg-muted/80 rounded-lg transition-colors flex items-center gap-1.5"
                  >
                    <ChatBubbleIcon className="w-3 h-3 text-muted-foreground" />
                    <span className="truncate max-w-[200px]">{toReadable(session.summary) || "Untitled"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Main content area - Sessions list on left, sidebar on right */}
          <div className="col-span-8 row-span-2">
            <BentoCard
              title="Sessions"
              className="h-full"
              subtitle={
                <span className="text-[10px] text-muted-foreground">
                  {isLoading ? "..." : `${filteredSessions.length} sessions`}
                </span>
              }
            >
              {isLoading ? (
                <div className="h-full flex items-center justify-center">
                  <p className="text-muted-foreground text-sm">Loading sessions...</p>
                </div>
              ) : filteredSessions.length > 0 ? (
                <div className="overflow-y-auto h-full p-2 space-y-1">
                  {filteredSessions.map((session) => (
                    <div
                      key={session.id}
                      className="flex items-center gap-2 group"
                    >
                      <button
                        onClick={() => handleResumeSession(session)}
                        className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors hover:bg-muted min-w-0"
                      >
                        <ChatBubbleIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">
                            {toReadable(session.summary) || "Untitled"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {session.message_count} messages · {formatDate(session.last_modified)}
                          </p>
                        </div>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className="p-1.5 rounded text-muted-foreground hover:text-ink hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <DotsVerticalIcon className="w-4 h-4" />
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
                            onResume={() => handleResumeSession(session)}
                          />
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="h-full flex items-center justify-center">
                  <p className="text-muted-foreground text-sm">No sessions yet</p>
                </div>
              )}
            </BentoCard>
          </div>

          {/* Right sidebar - stacked cards */}
          <div className="col-span-4 row-span-2 flex flex-col gap-4">
            {/* Logo Manager */}
            <BentoCard title="Logo" className="flex-shrink-0">
              <LogoManager projectPath={project.path} embedded />
            </BentoCard>

            {/* Diagnostics */}
            <BentoCard title="Diagnostics" className="flex-1 min-h-0 max-h-[200px]">
              <div className="overflow-y-auto h-full">
                <ProjectDiagnostics projectPath={project.path} embedded />
              </div>
            </BentoCard>

            {/* Git History */}
            <BentoCard title="Git History" className="flex-1 min-h-0 max-h-[200px]">
              <div className="overflow-y-auto h-full">
                <GitHistory
                  projectPath={project.path}
                  embedded
                />
              </div>
            </BentoCard>
          </div>
        </div>
      </div>
    </div>
  );
}
