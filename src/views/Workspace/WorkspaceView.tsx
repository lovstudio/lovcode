import { useEffect, useCallback, useMemo, useRef } from "react";
import { useAtom } from "jotai";
import { activePanelIdAtom, workspaceDataAtom, workspaceLoadingAtom, viewAtom } from "@/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import { ProjectDashboard } from "./ProjectDashboard";
import { PanelGrid } from "../../components/PanelGrid";
import { disposeTerminal } from "../../components/Terminal";
import type { ProjectOption } from "@/components/ui/new-terminal-button";
import type { WorkspaceData, WorkspaceProject, PanelState as StoredPanelState, SessionState as StoredSessionState, LayoutNode } from "./types";

export function WorkspaceView() {
  const [workspace, setWorkspace] = useAtom(workspaceDataAtom);
  const [loading, setLoading] = useAtom(workspaceLoadingAtom);
  const [activePanelId, setActivePanelId] = useAtom(activePanelIdAtom);
  const [view] = useAtom(viewAtom);

  // Sync workspace state from View params (for back/forward navigation)
  // Use functional update to avoid race conditions with other workspace updates
  useEffect(() => {
    if (view.type !== "workspace") return;

    const { projectId, featureId, mode } = view;
    if (!projectId && !featureId && !mode) return;

    setWorkspace((currentWorkspace) => {
      if (!currentWorkspace) return currentWorkspace;

      // Check if we need to update using the CURRENT workspace state
      const currentProject = currentWorkspace.projects.find(p => p.id === currentWorkspace.active_project_id);
      const needsUpdate =
        (projectId && currentWorkspace.active_project_id !== projectId) ||
        (featureId && currentProject?.active_feature_id !== featureId) ||
        (mode && currentProject?.view_mode !== mode);

      if (!needsUpdate) return currentWorkspace;

      const newProjects = currentWorkspace.projects.map(p => {
        if (projectId && p.id === projectId) {
          return {
            ...p,
            ...(featureId && { active_feature_id: featureId }),
            ...(mode && { view_mode: mode }),
          };
        }
        return p;
      });

      const newWorkspace = {
        ...currentWorkspace,
        projects: newProjects,
        ...(projectId && { active_project_id: projectId }),
      };

      // Save asynchronously
      invoke("workspace_save", { data: newWorkspace }).catch(console.error);
      return newWorkspace;
    });
  }, [view]);

  // Load workspace data and reset running features (PTY sessions don't survive restarts)
  useEffect(() => {
    invoke<WorkspaceData>("workspace_load")
      .then((data) => {
        // Reset any "running" features to "pending" since PTY processes are lost on restart
        const hasRunningFeatures = data.projects.some((p) =>
          p.features.some((f) => f.status === "running")
        );

        if (hasRunningFeatures) {
          const resetData: WorkspaceData = {
            ...data,
            projects: data.projects.map((p) => ({
              ...p,
              features: p.features.map((f) =>
                f.status === "running" ? { ...f, status: "pending" as const } : f
              ),
            })),
          };
          setWorkspace(resetData);
          // Auto-save the reset state
          invoke("workspace_save", { data: resetData }).catch(console.error);
        } else {
          setWorkspace(data);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Listen for feature-complete events
  useEffect(() => {
    const unlisten = listen<{ project_id: string; feature_id: string; feature_name: string }>(
      "feature-complete",
      (event) => {
        const { project_id, feature_id } = event.payload;
        // Update feature status to needs-review
        setWorkspace((prev) => {
          if (!prev) return prev;
          const newProjects = prev.projects.map((p) => {
            if (p.id !== project_id) return p;
            return {
              ...p,
              features: p.features.map((f) =>
                f.id === feature_id ? { ...f, status: "needs-review" as const } : f
              ),
            };
          });
          return { ...prev, projects: newProjects };
        });
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Save workspace using functional update to avoid race conditions with stale closures
  const saveWorkspace = useCallback(async (
    updater: (current: WorkspaceData) => WorkspaceData
  ) => {
    let savedData: WorkspaceData | null = null;
    setWorkspace((current) => {
      if (!current) return current;
      savedData = updater(current);
      return savedData;
    });
    if (savedData) {
      try {
        await invoke("workspace_save", { data: savedData });
      } catch (err) {
        console.error("Failed to save workspace:", err);
      }
    }
  }, []);

  // Get active project
  const activeProject = workspace?.projects.find(
    (p) => p.id === workspace.active_project_id
  );

  // Add project handler
  const handleAddProject = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });

      if (selected && typeof selected === "string") {
        const project = await invoke<WorkspaceProject>("workspace_add_project", {
          path: selected,
        });

        saveWorkspace((current) => ({
          ...current,
          projects: [...current.projects, project],
          active_project_id: project.id,
        }));
      }
    } catch (err) {
      console.error("Failed to add project:", err);
    }
  }, [workspace, saveWorkspace]);

  // Layout tree utilities
  const splitLayoutNode = useCallback(
    (node: LayoutNode, targetPanelId: string, direction: "horizontal" | "vertical", newPanelId: string): LayoutNode => {
      if (node.type === "panel") {
        if (node.panelId === targetPanelId) {
          // Found the target - replace with split node
          return {
            type: "split",
            direction,
            first: node,
            second: { type: "panel", panelId: newPanelId },
          };
        }
        return node;
      }
      // Recurse into split node
      return {
        ...node,
        first: splitLayoutNode(node.first, targetPanelId, direction, newPanelId),
        second: splitLayoutNode(node.second, targetPanelId, direction, newPanelId),
      };
    },
    []
  );

  const removeFromLayout = useCallback(
    (node: LayoutNode, targetPanelId: string): LayoutNode | null => {
      if (node.type === "panel") {
        return node.panelId === targetPanelId ? null : node;
      }
      const first = removeFromLayout(node.first, targetPanelId);
      const second = removeFromLayout(node.second, targetPanelId);
      if (!first && !second) return null;
      if (!first) return second;
      if (!second) return first;
      return { ...node, first, second };
    },
    []
  );

  // Split panel handler (tmux-style)
  const handlePanelSplit = useCallback(
    (targetPanelId: string, direction: "horizontal" | "vertical") => {
      if (!activeProject) return;

      const panelId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const ptyId = crypto.randomUUID();
      const projectId = activeProject.id;

      const newPanel: StoredPanelState = {
        id: panelId,
        sessions: [{ id: sessionId, pty_id: ptyId, title: "Untitled" }],
        active_session_id: sessionId,
        is_shared: false,
        cwd: activeProject.path,
      };

      saveWorkspace((current) => {
        const newProjects = current.projects.map((p) => {
          if (p.id !== projectId) return p;

          const panels = p.panels || [];
          let currentLayout = p.layout;
          if (!currentLayout) {
            if (panels.length === 0) {
              currentLayout = { type: "panel", panelId: targetPanelId };
            } else if (panels.length === 1) {
              currentLayout = { type: "panel", panelId: panels[0].id };
            } else {
              currentLayout = panels.slice(1).reduce<LayoutNode>(
                (acc, panel) => ({
                  type: "split",
                  direction: "horizontal",
                  first: acc,
                  second: { type: "panel", panelId: panel.id },
                }),
                { type: "panel", panelId: panels[0].id }
              );
            }
          }

          const newLayout = splitLayoutNode(currentLayout, targetPanelId, direction, panelId);

          return {
            ...p,
            panels: [...panels, newPanel],
            layout: newLayout,
          };
        });
        return { ...current, projects: newProjects };
      });

      setActivePanelId(panelId);
    },
    [activeProject, saveWorkspace, splitLayoutNode, setActivePanelId]
  );

  // Create initial panel (when project has no panels)
  const handleInitialPanelCreate = useCallback((command?: string, initialInput?: string) => {
    if (!activeProject) return;

    const panelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const ptyId = crypto.randomUUID();
    const projectId = activeProject.id;
    const title = command?.startsWith("claude") ? "Claude Code" : command?.startsWith("codex") ? "Codex" : "Terminal";

    const newPanel: StoredPanelState = {
      id: panelId,
      sessions: [{ id: sessionId, pty_id: ptyId, title, command, initial_input: initialInput }],
      active_session_id: sessionId,
      is_shared: false,
      cwd: activeProject.path,
    };

    saveWorkspace((current) => {
      const newProjects = current.projects.map((p) =>
        p.id === projectId
          ? { ...p, panels: [newPanel], layout: { type: "panel" as const, panelId } }
          : p
      );
      return { ...current, projects: newProjects };
    });

    setActivePanelId(panelId);
  }, [activeProject, saveWorkspace, setActivePanelId]);

  // Browse-and-start: register an arbitrary folder then start a terminal in it
  const handleBrowseFolder = useCallback(async (path: string, command?: string, initialInput?: string) => {
    try {
      // Reuse existing project if the path matches one already registered
      const existing = workspace?.projects.find((p) => p.path === path);
      const project = existing
        ? existing
        : await invoke<WorkspaceProject>("workspace_add_project", { path });

      const panelId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const ptyId = crypto.randomUUID();
      const title = command?.startsWith("claude") ? "Claude Code" : command?.startsWith("codex") ? "Codex" : "Terminal";

      const newPanel: StoredPanelState = {
        id: panelId,
        sessions: [{ id: sessionId, pty_id: ptyId, title, command, initial_input: initialInput }],
        active_session_id: sessionId,
        is_shared: false,
        cwd: project.path,
      };

      saveWorkspace((current) => {
        const projects = existing
          ? current.projects
          : [...current.projects, project];
        const newProjects = projects.map((p) =>
          p.id === project.id
            ? { ...p, panels: [newPanel], layout: { type: "panel" as const, panelId } }
            : p
        );
        return { ...current, projects: newProjects, active_project_id: project.id };
      });

      setActivePanelId(panelId);
    } catch (err) {
      console.error("Failed to browse folder:", err);
    }
  }, [workspace, saveWorkspace, setActivePanelId]);

  // Create panel in a specific project (for project selection in empty state)
  const handleSelectProject = useCallback((project: ProjectOption, command?: string, initialInput?: string) => {
    const panelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const ptyId = crypto.randomUUID();
    const title = command?.startsWith("claude") ? "Claude Code" : command?.startsWith("codex") ? "Codex" : "Terminal";

    const newPanel: StoredPanelState = {
      id: panelId,
      sessions: [{ id: sessionId, pty_id: ptyId, title, command, initial_input: initialInput }],
      active_session_id: sessionId,
      is_shared: false,
      cwd: project.path,
    };

    saveWorkspace((current) => {
      const newProjects = current.projects.map((p) =>
        p.id === project.id
          ? { ...p, panels: [newPanel], layout: { type: "panel" as const, panelId } }
          : p
      );
      return { ...current, projects: newProjects, active_project_id: project.id };
    });

    setActivePanelId(panelId);
  }, [saveWorkspace, setActivePanelId]);

  // Prepare project options for selection (all workspace projects)
  const projectOptions: ProjectOption[] = useMemo(() => {
    if (!workspace) return [];
    return workspace.projects
      .filter((p) => !p.archived)
      .map((p) => ({ id: p.id, name: p.name, path: p.path }));
  }, [workspace?.projects]);

  // Close panel handler
  const handlePanelClose = useCallback(
    (panelId: string) => {
      if (!activeProject) return;

      const panels = activeProject.panels || [];
      const panel = panels.find((p) => p.id === panelId);
      const ptyIdsToKill = panel ? panel.sessions.map((s) => s.pty_id) : [];

      for (const ptyId of ptyIdsToKill) {
        disposeTerminal(ptyId);
        invoke("pty_kill", { id: ptyId }).catch(console.error);
        invoke("pty_purge_scrollback", { id: ptyId }).catch(console.error);
      }

      const projectId = activeProject.id;
      saveWorkspace((current) => {
        const newProjects = current.projects.map((p) => {
          if (p.id !== projectId) return p;
          const newPanels = (p.panels || []).filter((panel) => panel.id !== panelId);
          const newLayout = p.layout ? removeFromLayout(p.layout, panelId) : undefined;
          return { ...p, panels: newPanels, layout: newLayout ?? undefined };
        });
        return { ...current, projects: newProjects };
      });
    },
    [activeProject, saveWorkspace, removeFromLayout]
  );

  // Toggle panel shared handler (no-op, feature removed)
  const handlePanelToggleShared = useCallback(
    (_panelId: string) => {
      // No-op: shared panels feature removed with feature layer
    },
    []
  );

  // Reload panel handler (kills active session's PTY and creates new one)
  const handlePanelReload = useCallback(
    (panelId: string) => {
      if (!activeProject) return;

      const panels = activeProject.panels || [];
      const panel = panels.find((p) => p.id === panelId);
      if (!panel) return;

      const activeSessionId = panel.active_session_id;
      const activeSession = panel.sessions.find((s) => s.id === activeSessionId);
      const oldPtyId = activeSession?.pty_id;

      if (oldPtyId) {
        disposeTerminal(oldPtyId);
        invoke("pty_kill", { id: oldPtyId }).catch(console.error);
        invoke("pty_purge_scrollback", { id: oldPtyId }).catch(console.error);
      }

      const newPtyId = crypto.randomUUID();
      const projectId = activeProject.id;

      saveWorkspace((current) => {
        const newProjects = current.projects.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            panels: (p.panels || []).map((panel) =>
              panel.id === panelId
                ? { ...panel, sessions: panel.sessions.map((s) => s.id === activeSessionId ? { ...s, pty_id: newPtyId } : s) }
                : panel
            ),
          };
        });
        return { ...current, projects: newProjects };
      });
    },
    [activeProject, saveWorkspace]
  );

  // Add session to panel handler
  const handleSessionAdd = useCallback(
    (panelId: string) => {
      if (!activeProject) return;

      const sessionId = crypto.randomUUID();
      const ptyId = crypto.randomUUID();
      const newSession: StoredSessionState = { id: sessionId, pty_id: ptyId, title: "Untitled" };
      const projectId = activeProject.id;

      saveWorkspace((current) => {
        const newProjects = current.projects.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            panels: (p.panels || []).map((panel) =>
              panel.id === panelId
                ? { ...panel, sessions: [...panel.sessions, newSession], active_session_id: sessionId }
                : panel
            ),
          };
        });
        return { ...current, projects: newProjects };
      });

      setActivePanelId(panelId);
    },
    [activeProject, saveWorkspace, setActivePanelId]
  );

  // Close session handler
  const handleSessionClose = useCallback(
    (panelId: string, sessionId: string) => {
      if (!activeProject) return;

      const panels = activeProject.panels || [];
      const panel = panels.find((p) => p.id === panelId);
      if (!panel) return;

      const session = panel.sessions.find((s) => s.id === sessionId);
      const ptyIdToPurge = session?.pty_id;

      // If this is the last session, close the entire panel
      if (panel.sessions.length <= 1) {
        handlePanelClose(panelId);
        return;
      }

      if (ptyIdToPurge) {
        disposeTerminal(ptyIdToPurge);
        invoke("pty_kill", { id: ptyIdToPurge }).catch(console.error);
        invoke("pty_purge_scrollback", { id: ptyIdToPurge }).catch(console.error);
      }

      const projectId = activeProject.id;

      saveWorkspace((current) => {
        const newProjects = current.projects.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            panels: (p.panels || []).map((panel) => {
              if (panel.id !== panelId) return panel;
              const newSessions = panel.sessions.filter((s) => s.id !== sessionId);
              const newActiveId = panel.active_session_id === sessionId ? newSessions[0]?.id || "" : panel.active_session_id;
              return { ...panel, sessions: newSessions, active_session_id: newActiveId };
            }),
          };
        });
        return { ...current, projects: newProjects };
      });

      setActivePanelId(panelId);
    },
    [activeProject, saveWorkspace, setActivePanelId, handlePanelClose]
  );

  // Select session handler
  const handleSessionSelect = useCallback(
    (panelId: string, sessionId: string) => {
      if (!activeProject) return;
      const projectId = activeProject.id;

      saveWorkspace((current) => {
        const newProjects = current.projects.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            panels: (p.panels || []).map((panel) =>
              panel.id === panelId ? { ...panel, active_session_id: sessionId } : panel
            ),
          };
        });
        return { ...current, projects: newProjects };
      });
    },
    [activeProject, saveWorkspace]
  );

  // Session title change handler
  const handleSessionTitleChange = useCallback(
    (panelId: string, sessionId: string, title: string) => {
      if (!activeProject) return;
      const projectId = activeProject.id;

      saveWorkspace((current) => {
        const newProjects = current.projects.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            panels: (p.panels || []).map((panel) =>
              panel.id === panelId
                ? { ...panel, sessions: panel.sessions.map((s) => s.id === sessionId ? { ...s, title } : s) }
                : panel
            ),
          };
        });
        return { ...current, projects: newProjects };
      });
    },
    [activeProject, saveWorkspace]
  );

  // Convert project panels to PanelGrid format
  const sessionCacheRef = useRef(new Map<string, { id: string; ptyId: string; title: string; command?: string; initialInput?: string }>());

  const projectPanels = useMemo(() => {
    const cache = sessionCacheRef.current;
    const usedSessionIds = new Set<string>();
    const panels = (activeProject?.panels || []).map((p) => ({
      id: p.id,
      sessions: p.sessions.map((s) => {
        usedSessionIds.add(s.id);
        const cached = cache.get(s.id);
        if (cached && cached.ptyId === s.pty_id) {
          cached.title = s.title;
          cached.command = s.command;
          cached.initialInput = s.initial_input;
          return cached;
        }
        const session = { id: s.id, ptyId: s.pty_id, title: s.title, command: s.command, initialInput: s.initial_input };
        cache.set(s.id, session);
        return session;
      }),
      activeSessionId: p.active_session_id,
      isShared: p.is_shared,
      cwd: activeProject?.path || "",
    }));

    // Clean up stale cache entries
    for (const id of cache.keys()) {
      if (!usedSessionIds.has(id)) cache.delete(id);
    }

    return panels;
  }, [activeProject?.panels, activeProject?.path]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-canvas">
        <p className="text-muted-foreground">Loading workspace...</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-canvas">
      {activeProject && activeProject.view_mode === "dashboard" ? (
        <ProjectDashboard project={activeProject} />
      ) : (
        <div className="flex-1 min-h-0">
          <PanelGrid
            panels={projectPanels}
            layout={activeProject?.layout}
            activePanelId={activePanelId}
            onPanelFocus={setActivePanelId}
            onPanelClose={handlePanelClose}
            onPanelSplit={handlePanelSplit}
            onPanelToggleShared={handlePanelToggleShared}
            onPanelReload={handlePanelReload}
            onSessionAdd={handleSessionAdd}
            onSessionClose={handleSessionClose}
            onSessionSelect={handleSessionSelect}
            onSessionTitleChange={handleSessionTitleChange}
            onInitialPanelCreate={handleInitialPanelCreate}
            projects={projectOptions}
            activeProjectId={activeProject?.id}
            onSelectProject={handleSelectProject}
            onAddFolder={handleAddProject}
            onBrowseFolder={handleBrowseFolder}
            direction="horizontal"
          />
        </div>
      )}
    </div>
  );
}
