import { useCallback, useEffect, useRef, useState } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { ChevronLeftIcon, ChevronRightIcon, DrawingPinFilledIcon, ChevronDownIcon, FileIcon, DesktopIcon, MixerHorizontalIcon } from "@radix-ui/react-icons";
import { CornerDownLeft, FolderOpenIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { SessionPanel } from "./SessionPanel";
import type { LayoutNode } from "../../views/Workspace/types";
import { TERMINAL_OPTIONS, type ProjectOption } from "../ui/new-terminal-button";
import { SlashCommandMenu, type CommandItem } from "../ui/slash-command-menu";
import { useInvokeQuery, useQueryClient } from "../../hooks";
import { ActivityHeatmap } from "../home";
import { LLM_PROVIDER_PRESETS } from "../../constants";
import type { LocalCommand, CodexCommand, Project, Session, ClaudeSettings, MaasProvider } from "../../types";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";

export interface SessionState {
  id: string;
  ptyId: string;
  title: string;
  command?: string;
  /** Text to send to terminal after it's ready (for interactive input) */
  initialInput?: string;
}

export interface PanelState {
  id: string;
  sessions: SessionState[];
  activeSessionId: string;
  isShared: boolean;
  cwd: string;
}

export interface PanelGridProps {
  panels: PanelState[];
  layout?: LayoutNode;
  activePanelId?: string;
  onPanelFocus?: (id: string) => void;
  onPanelClose: (id: string) => void;
  /** Split a panel in the given direction (tmux-style) */
  onPanelSplit: (panelId: string, direction: "horizontal" | "vertical") => void;
  onPanelToggleShared: (id: string) => void;
  onPanelReload: (id: string) => void;
  onSessionAdd: (panelId: string) => void;
  onSessionClose: (panelId: string, sessionId: string) => void;
  onSessionSelect: (panelId: string, sessionId: string) => void;
  onSessionTitleChange: (panelId: string, sessionId: string, title: string) => void;
  /** @deprecated Use layout prop instead */
  direction?: "horizontal" | "vertical";
  /** Called when no panels exist and one should be created (uses current active project) */
  onInitialPanelCreate?: (command?: string, initialInput?: string) => void;
  /** Available projects for selection in empty state */
  projects?: ProjectOption[];
  /** Current active project id (for default selection) */
  activeProjectId?: string;
  /** Called when user selects a project to create terminal in */
  onSelectProject?: (project: ProjectOption, command?: string, initialInput?: string) => void;
  /** Called when user wants to add a new folder */
  onAddFolder?: () => void;
  /** Called when user picks a folder via native dialog to start a terminal in */
  onBrowseFolder?: (path: string, command?: string, initialInput?: string) => void;
}

/** Recursively render layout tree */
function LayoutRenderer({
  node,
  panels,
  activePanelId,
  onPanelFocus,
  onPanelClose,
  onPanelSplit,
  onPanelToggleShared,
  onPanelReload,
  onSessionAdd,
  onSessionClose,
  onSessionSelect,
  onSessionTitleChange,
}: {
  node: LayoutNode;
  panels: PanelState[];
  activePanelId?: string;
  onPanelFocus?: (id: string) => void;
  onPanelClose: (id: string) => void;
  onPanelSplit: (panelId: string, direction: "horizontal" | "vertical") => void;
  onPanelToggleShared: (id: string) => void;
  onPanelReload: (id: string) => void;
  onSessionAdd: (panelId: string) => void;
  onSessionClose: (panelId: string, sessionId: string) => void;
  onSessionSelect: (panelId: string, sessionId: string) => void;
  onSessionTitleChange: (panelId: string, sessionId: string, title: string) => void;
}) {
  if (node.type === "panel") {
    const panel = panels.find((p) => p.id === node.panelId);
    if (!panel) return null;
    const isActive = activePanelId === panel.id;

    return (
      <div
        className="h-full w-full flex flex-col bg-terminal border border-border overflow-hidden"
        onMouseDown={() => onPanelFocus?.(panel.id)}
      >
        <SessionPanel
          isActive={isActive}
          panel={panel}
          showSplitActions
          onPanelSplit={(dir) => onPanelSplit(panel.id, dir)}
          onPanelClose={() => onPanelClose(panel.id)}
          onPanelToggleShared={() => onPanelToggleShared(panel.id)}
          onPanelReload={() => onPanelReload(panel.id)}
          onSessionAdd={() => onSessionAdd(panel.id)}
          onSessionClose={(sessionId) => onSessionClose(panel.id, sessionId)}
          onSessionSelect={(sessionId) => onSessionSelect(panel.id, sessionId)}
          onSessionTitleChange={(sessionId, title) => onSessionTitleChange(panel.id, sessionId, title)}
        />
      </div>
    );
  }

  // Split node - render children in Allotment
  return (
    <Allotment vertical={node.direction === "vertical"} className="h-full">
      <Allotment.Pane minSize={100}>
        <LayoutRenderer
          node={node.first}
          panels={panels}
          activePanelId={activePanelId}
          onPanelFocus={onPanelFocus}
          onPanelClose={onPanelClose}
          onPanelSplit={onPanelSplit}
          onPanelToggleShared={onPanelToggleShared}
          onPanelReload={onPanelReload}
          onSessionAdd={onSessionAdd}
          onSessionClose={onSessionClose}
          onSessionSelect={onSessionSelect}
          onSessionTitleChange={onSessionTitleChange}
        />
      </Allotment.Pane>
      <Allotment.Pane minSize={100}>
        <LayoutRenderer
          node={node.second}
          panels={panels}
          activePanelId={activePanelId}
          onPanelFocus={onPanelFocus}
          onPanelClose={onPanelClose}
          onPanelSplit={onPanelSplit}
          onPanelToggleShared={onPanelToggleShared}
          onPanelReload={onPanelReload}
          onSessionAdd={onSessionAdd}
          onSessionClose={onSessionClose}
          onSessionSelect={onSessionSelect}
          onSessionTitleChange={onSessionTitleChange}
        />
      </Allotment.Pane>
    </Allotment>
  );
}

export function PanelGrid({
  panels,
  layout,
  activePanelId: controlledActivePanelId,
  onPanelFocus: controlledOnPanelFocus,
  onPanelClose,
  onPanelSplit,
  onPanelToggleShared,
  onPanelReload,
  onSessionAdd,
  onSessionClose,
  onSessionSelect,
  onSessionTitleChange,
  direction = "horizontal",
  onInitialPanelCreate,
  projects,
  activeProjectId,
  onSelectProject,
  onAddFolder,
  onBrowseFolder,
}: PanelGridProps) {
  // Selected project for empty state (default to active project)
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(activeProjectId);
  // Last folder browsed via native picker (persisted); displayed in folder chip even if not registered
  const [lastBrowsedPath, setLastBrowsedPath] = useState<string | null>(() =>
    localStorage.getItem("lovcode:customCwd")
  );
  // Selected terminal type for empty state (persisted)
  const [selectedTerminalType, setSelectedTerminalType] = useState(() => {
    const saved = localStorage.getItem("lovcode:terminalType");
    return TERMINAL_OPTIONS.find(o => o.type === saved) || TERMINAL_OPTIONS[0];
  });
  // Input command for empty state
  const [inputCommand, setInputCommand] = useState("");
  // Track IME composing state
  const composingRef = useRef(false);
  // Textarea ref for positioning slash command menu
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Slash command menu state
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);

  // Fetch commands for autocomplete
  const { data: localCommands = [] } = useInvokeQuery<LocalCommand[]>(
    ["commands"],
    "list_local_commands"
  );
  const { data: codexCommands = [] } = useInvokeQuery<CodexCommand[]>(
    ["codexCommands"],
    "list_codex_commands"
  );

  // Fetch activity data for the heatmap shown in the empty state
  const { data: activityProjects = [] } = useInvokeQuery<Project[]>(["projects"], "list_projects");
  const { data: activitySessions = [] } = useInvokeQuery<Session[]>(["sessions"], "list_all_sessions");
  const { data: activityStats } = useInvokeQuery<{
    daily: Record<string, number>;
    hourly: Record<string, number>;
    detailed: Record<string, number>;
  }>(["activityStats"], "get_activity_stats");
  const totalMessages = activitySessions.reduce((sum, s) => sum + s.message_count, 0);

  // Claude settings -> active provider + model (for the prompt-box dropdown)
  const { data: claudeSettings } = useInvokeQuery<ClaudeSettings>(["settings"], "get_settings");
  const { data: maasRegistry = [] } = useInvokeQuery<MaasProvider[]>(
    ["maas_registry"],
    "get_maas_registry",
  );
  const queryClient = useQueryClient();

  const activeProviderKey = (() => {
    const raw = claudeSettings?.raw;
    if (!raw || typeof raw !== "object") return null;
    const lovcode = (raw as Record<string, unknown>).lovcode;
    if (!lovcode || typeof lovcode !== "object") return null;
    const key = (lovcode as Record<string, unknown>).activeProvider;
    return typeof key === "string" ? key : null;
  })();
  const activeProvider = LLM_PROVIDER_PRESETS.find(p => p.key === activeProviderKey) ?? null;

  const savedModel = (() => {
    const raw = claudeSettings?.raw;
    if (!raw || typeof raw !== "object") return "";
    const env = (raw as Record<string, unknown>).env;
    if (!env || typeof env !== "object" || Array.isArray(env)) return "";
    const m = (env as Record<string, unknown>).ANTHROPIC_MODEL;
    return typeof m === "string" ? m : "";
  })();

  // Models offered for the current provider (from MaaS registry, keyed on activeProviderKey)
  const maasProvider = maasRegistry.find((p) => p.key === activeProviderKey) ?? null;
  const currentMaasModel =
    maasProvider?.models.find((m) => m.modelName === savedModel) ?? null;

  const handleProviderSelect = async (key: string) => {
    if (key === activeProviderKey) return;
    try {
      // Preserve any other lovcode.* keys, only override activeProvider
      const raw = claudeSettings?.raw;
      const prevLovcode =
        raw && typeof raw === "object" && (raw as Record<string, unknown>).lovcode &&
        typeof (raw as Record<string, unknown>).lovcode === "object"
          ? ((raw as Record<string, unknown>).lovcode as Record<string, unknown>)
          : {};
      await invoke("update_settings_field", {
        field: "lovcode",
        value: { ...prevLovcode, activeProvider: key },
      });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      console.error("Failed to switch provider:", e);
    }
  };

  const handleModelSelect = async (modelName: string) => {
    if (modelName === savedModel) return;
    try {
      await invoke("update_settings_env", { envKey: "ANTHROPIC_MODEL", envValue: modelName, isNew: !savedModel });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      console.error("Failed to update model:", e);
    }
  };

  const handleBrowseFolder = async () => {
    try {
      let defaultPath = lastBrowsedPath ?? undefined;
      if (!defaultPath) {
        try {
          defaultPath = await invoke<string>("get_home_dir");
        } catch {
          defaultPath = undefined;
        }
      }
      const selected = await openDialog({ directory: true, multiple: false, defaultPath });
      if (selected && typeof selected === "string") {
        setLastBrowsedPath(selected);
        localStorage.setItem("lovcode:customCwd", selected);
        setSelectedProjectId(undefined);
      }
    } catch (e) {
      console.error("Failed to browse folder:", e);
    }
  };

  // Get commands based on terminal type (both use / trigger)
  const commandItems: CommandItem[] = selectedTerminalType.type === "codex"
    ? codexCommands.map(c => ({ name: c.name, description: c.description, path: c.path || c.name }))
    : localCommands.filter(c => c.status === "active").map(c => ({ name: c.name, description: c.description, path: c.path }));

  // Sync with activeProjectId when it changes
  useEffect(() => {
    if (activeProjectId) {
      setSelectedProjectId(activeProjectId);
    }
  }, [activeProjectId]);
  // Internal state for active panel (uncontrolled mode)
  const [internalActivePanelId, setInternalActivePanelId] = useState<string | undefined>(
    () => panels[0]?.id
  );

  // Use controlled or internal state
  const activePanelId = controlledActivePanelId ?? internalActivePanelId;
  const handlePanelFocus = useCallback((id: string) => {
    controlledOnPanelFocus?.(id);
    if (controlledActivePanelId === undefined) {
      setInternalActivePanelId(id);
    }
  }, [controlledOnPanelFocus, controlledActivePanelId]);


  // Auto-select first panel if current active is gone
  useEffect(() => {
    if (panels.length > 0 && !panels.find(p => p.id === activePanelId)) {
      setInternalActivePanelId(panels[0].id);
    }
  }, [panels, activePanelId]);

  if (panels.length === 0) {
    const hasProjects = projects && projects.length > 0;
    const registeredSelected = projects?.find((p) => p.id === selectedProjectId);
    // When selectedProjectId is explicitly undefined (after Browse), don't fall back to projects[0]
    const usingBrowsedPath = selectedProjectId === undefined && !!lastBrowsedPath;
    const selectedProject = usingBrowsedPath ? undefined : (registeredSelected || projects?.[0]);
    const browsedFolderName = lastBrowsedPath ? lastBrowsedPath.split("/").filter(Boolean).at(-1) ?? lastBrowsedPath : null;

    const handleCreate = (userInput?: string) => {
      // For claude/codex, append user input as argument to command
      // For plain terminal, use initialInput to send after PTY is ready (interactive)
      let command = selectedTerminalType.command;
      let initialInput: string | undefined;

      if (userInput) {
        if (command) {
          // Claude/Codex: pass user input as argument
          command = `${command} "${userInput}"`;
        } else {
          // Plain terminal: send as interactive input after PTY ready
          initialInput = userInput;
        }
      }

      if (usingBrowsedPath && lastBrowsedPath && onBrowseFolder) {
        onBrowseFolder(lastBrowsedPath, command, initialInput);
      } else if (selectedProject && onSelectProject) {
        onSelectProject(selectedProject, command, initialInput);
      } else if (onInitialPanelCreate) {
        onInitialPanelCreate(command, initialInput);
      }
    };

    // Common dropdown button style
    const dropdownButtonClass = "inline-flex items-center justify-between gap-3 px-4 py-2.5 text-sm border border-border bg-card hover:bg-card-alt rounded-xl transition-colors";

    return (
      <div className="h-full w-full overflow-auto flex justify-center pt-8 pb-3 bg-canvas bg-[radial-gradient(#e5e5e5_1px,transparent_1px)] dark:bg-[radial-gradient(#333_1px,transparent_1px)] [background-size:20px_20px]">
        <div className="flex flex-col items-center gap-5 w-full max-w-3xl px-6 min-h-full">
          {/* Project / folder selector */}
          {(hasProjects && onSelectProject) || onBrowseFolder ? (
            <div className="flex items-center gap-3 w-full">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className={`${dropdownButtonClass} flex-1 min-w-0`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <span className="truncate">
                        {usingBrowsedPath
                          ? browsedFolderName ?? "Browsed folder"
                          : selectedProject?.name || "Select folder"}
                      </span>
                    </div>
                    <ChevronDownIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[200px]">
                  {projects?.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      onClick={() => setSelectedProjectId(project.id)}
                    >
                      <span className={`truncate ${!usingBrowsedPath && project.id === selectedProjectId ? "font-medium" : ""}`}>
                        {project.name}
                      </span>
                    </DropdownMenuItem>
                  ))}
                  {lastBrowsedPath && (
                    <DropdownMenuItem onClick={() => setSelectedProjectId(undefined)}>
                      <FolderOpenIcon className="w-4 h-4 mr-2" />
                      <span className={`truncate ${usingBrowsedPath ? "font-medium" : ""}`}>
                        {browsedFolderName ?? lastBrowsedPath}
                      </span>
                    </DropdownMenuItem>
                  )}
                  {(onBrowseFolder || onAddFolder) && <DropdownMenuSeparator />}
                  {onBrowseFolder && (
                    <DropdownMenuItem onClick={handleBrowseFolder}>
                      <FolderOpenIcon className="w-4 h-4 mr-2" />
                      Browse folder...
                    </DropdownMenuItem>
                  )}
                  {onAddFolder && (
                    <DropdownMenuItem onClick={onAddFolder}>
                      <FileIcon className="w-4 h-4 mr-2" />
                      Add folder...
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}

          {/* Activity heatmap + stats */}
          {activityStats && (
            <div className="w-full shrink-0 bg-card/50 rounded-2xl p-3 border border-border/40 overflow-hidden">
              <ActivityHeatmap
                daily={activityStats.daily}
                detailed={activityStats.detailed}
              />
              <div className="flex items-center gap-6 mt-2 pt-2 border-t border-border/40 text-xs text-muted-foreground">
                <span>
                  <strong className="text-foreground font-serif">{activityProjects.length}</strong> workspaces
                </span>
                <span>
                  <strong className="text-foreground font-serif">{activitySessions.length}</strong> sessions
                </span>
                <span>
                  <strong className="text-foreground font-serif">{totalMessages}</strong> messages
                </span>
              </div>
            </div>
          )}


          {/* Super prompt box - separated terminal-style input + controls */}
          <div className="w-full shrink-0 mt-auto flex flex-col gap-2">
            <div className="flex items-start gap-2 px-4 py-2.5 border border-border/60 rounded-xl bg-terminal shadow-sm overflow-hidden">
              <span className="shrink-0 text-sm leading-6 font-mono text-primary/80 select-none">$</span>
              <textarea
                ref={textareaRef}
                rows={1}
                value={inputCommand}
                onChange={(e) => {
                  const value = e.target.value;
                  setInputCommand(value);
                  // Auto-grow height
                  const ta = e.target;
                  ta.style.height = "auto";
                  ta.style.height = `${ta.scrollHeight}px`;

                  // Show command menu when typing / without space (still selecting command)
                  // Once there's a space, user is typing arguments - hide menu
                  if (value.startsWith("/") && !value.includes(" ")) {
                    const filter = value.slice(1); // Remove leading /
                    setSlashFilter(filter);
                    setSlashSelectedIndex(0); // Reset selection on filter change
                    setShowSlashMenu(true);
                  } else {
                    setShowSlashMenu(false);
                  }
                }}
                placeholder={
                  selectedTerminalType.type === "claude" || selectedTerminalType.type === "codex"
                    ? "Type / for commands, or describe what you want to do..."
                    : "Enter a command or describe what you want to do..."
                }
                className="flex-1 min-w-0 px-0 py-0 bg-transparent resize-none outline-none text-sm leading-6 font-mono text-neutral-100 caret-primary placeholder:text-neutral-500 overflow-hidden"
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => {
                  // Delay to next frame - some browsers fire compositionend BEFORE keydown
                  requestAnimationFrame(() => { composingRef.current = false; });
                }}
                onKeyDown={(e) => {
                  // 'Process' key indicates IME is handling the input
                  if (e.key === 'Process' || composingRef.current) return;

                  // Handle command menu navigation
                  if (showSlashMenu) {
                    const filteredCommands = commandItems
                      .filter(cmd => {
                        const search = slashFilter.toLowerCase();
                        return cmd.name.toLowerCase().includes(search) ||
                          (cmd.description?.toLowerCase().includes(search) ?? false);
                      })
                      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                    const maxIndex = filteredCommands.length - 1;

                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSlashSelectedIndex(i => Math.min(i + 1, maxIndex));
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSlashSelectedIndex(i => Math.max(i - 1, 0));
                      return;
                    }
                    if (e.key === 'Enter' || e.key === 'Tab') {
                      e.preventDefault();
                      const selected = filteredCommands[slashSelectedIndex];
                      if (selected) {
                        setInputCommand(selected.name + " ");
                        setShowSlashMenu(false);
                      }
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setShowSlashMenu(false);
                      return;
                    }
                  }

                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleCreate(inputCommand || undefined);
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
            {/* Detached controls row: slash menu or selector + start */}
            {showSlashMenu ? (
              selectedTerminalType.type === "terminal" ? (
                <div className="px-3 py-2.5 border border-border rounded-lg bg-card text-sm text-muted-foreground">
                  Slash commands are only available in Claude Code or Codex mode
                </div>
              ) : (
                <div className="border border-border rounded-lg bg-card overflow-hidden">
                  <SlashCommandMenu
                    commands={commandItems}
                    filter={slashFilter}
                    selectedIndex={slashSelectedIndex}
                    onSelect={(cmd) => {
                      setInputCommand(cmd.name + " ");
                      setShowSlashMenu(false);
                      textareaRef.current?.focus();
                    }}
                  />
                </div>
              )
            ) : (
              <div className="flex items-center justify-between gap-2 px-1">
                {/* Agent runtime selector */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-card rounded-md transition-colors">
                      <DesktopIcon className="w-3.5 h-3.5" />
                      <span>{selectedTerminalType.label}</span>
                      <ChevronDownIcon className="w-3 h-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[140px]">
                    {TERMINAL_OPTIONS.map((opt) => (
                      <DropdownMenuItem
                        key={opt.type}
                        onClick={() => {
                          setSelectedTerminalType(opt);
                          localStorage.setItem("lovcode:terminalType", opt.type);
                          if (inputCommand.startsWith("/")) {
                            setShowSlashMenu(true);
                            setSlashSelectedIndex(0);
                          }
                        }}
                      >
                        <span className={opt.type === selectedTerminalType.type ? "font-medium" : ""}>
                          {opt.label}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {/* Right: provider + model (only relevant for LLM modes) */}
                {(selectedTerminalType.type === "claude" || selectedTerminalType.type === "codex") && (
                  <div className="flex items-center gap-1.5">
                    {/* Provider dropdown */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-card rounded-md transition-colors"
                          title="Active LLM provider"
                        >
                          <MixerHorizontalIcon className="w-3.5 h-3.5" />
                          <span>{activeProvider?.label ?? "No provider"}</span>
                          <ChevronDownIcon className="w-3 h-3" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[200px]">
                        {LLM_PROVIDER_PRESETS.map((preset) => (
                          <DropdownMenuItem
                            key={preset.key}
                            onClick={() => handleProviderSelect(preset.key)}
                          >
                            <span className={preset.key === activeProviderKey ? "font-medium" : ""}>
                              {preset.label}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {/* Model dropdown (MaaS registry) */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-card rounded-md transition-colors max-w-[14rem]"
                          title={savedModel || "Select model"}
                        >
                          <span className="truncate">
                            {currentMaasModel?.displayName ?? savedModel ?? "No model"}
                          </span>
                          <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[220px]">
                        {maasProvider && maasProvider.models.length > 0 ? (
                          maasProvider.models.map((m) => (
                            <DropdownMenuItem
                              key={m.id}
                              onClick={() => handleModelSelect(m.modelName)}
                            >
                              <div className="flex flex-col min-w-0">
                                <span className={`truncate ${m.modelName === savedModel ? "font-medium" : ""}`}>
                                  {m.displayName}
                                </span>
                                <span className="text-[10px] font-mono text-muted-foreground truncate">
                                  {m.modelName}
                                </span>
                              </div>
                            </DropdownMenuItem>
                          ))
                        ) : (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            No models — configure in Settings → MaaS Registry
                          </div>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Use tree layout if available
  if (layout) {
    return (
      <div className="h-full w-full">
        <LayoutRenderer
          node={layout}
          panels={panels}
          activePanelId={activePanelId}
          onPanelFocus={handlePanelFocus}
          onPanelClose={onPanelClose}
          onPanelSplit={onPanelSplit}
          onPanelToggleShared={onPanelToggleShared}
          onPanelReload={onPanelReload}
          onSessionAdd={onSessionAdd}
          onSessionClose={onSessionClose}
          onSessionSelect={onSessionSelect}
          onSessionTitleChange={onSessionTitleChange}
        />
      </div>
    );
  }

  // Legacy flat layout (backwards compatibility)
  return (
    <Allotment vertical={direction === "vertical"} className="h-full">
      {panels.map((panel) => {
        const isActive = activePanelId === panel.id;
        return (
          <Allotment.Pane key={panel.id} minSize={150}>
            <div
              className="h-full flex flex-col bg-terminal border border-border overflow-hidden"
              onMouseDown={() => handlePanelFocus(panel.id)}
            >
              <SessionPanel
                isActive={isActive}
                panel={panel}
                showSplitActions
                onPanelSplit={(dir) => onPanelSplit(panel.id, dir)}
                onPanelClose={() => onPanelClose(panel.id)}
                onPanelToggleShared={() => onPanelToggleShared(panel.id)}
                onPanelReload={() => onPanelReload(panel.id)}
                onSessionAdd={() => onSessionAdd(panel.id)}
                onSessionClose={(sessionId) => onSessionClose(panel.id, sessionId)}
                onSessionSelect={(sessionId) => onSessionSelect(panel.id, sessionId)}
                onSessionTitleChange={(sessionId, title) => onSessionTitleChange(panel.id, sessionId, title)}
              />
            </div>
          </Allotment.Pane>
        );
      })}
    </Allotment>
  );
}

/** Shared panels zone - fixed left area */
export interface SharedPanelZoneProps {
  panels: PanelState[];
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onPanelClose: (id: string) => void;
  onPanelToggleShared: (id: string) => void;
  onPanelReload: (id: string) => void;
  onSessionAdd: (panelId: string) => void;
  onSessionClose: (panelId: string, sessionId: string) => void;
  onSessionSelect: (panelId: string, sessionId: string) => void;
  onSessionTitleChange: (panelId: string, sessionId: string, title: string) => void;
}

export function SharedPanelZone({
  panels,
  collapsed,
  onCollapsedChange,
  onPanelClose,
  onPanelToggleShared,
  onPanelReload,
  onSessionAdd,
  onSessionClose,
  onSessionSelect,
  onSessionTitleChange,
}: SharedPanelZoneProps) {
  // Track which panels are expanded (by id)
  const [expandedPanels, setExpandedPanels] = useState<Set<string>>(() => new Set(panels.map(p => p.id)));

  // Auto-expand newly pinned panels
  useEffect(() => {
    const newIds = panels.filter(p => !expandedPanels.has(p.id)).map(p => p.id);
    if (newIds.length > 0) {
      setExpandedPanels(prev => new Set([...prev, ...newIds]));
    }
  }, [panels]);

  const togglePanelExpanded = useCallback((panelId: string) => {
    setExpandedPanels(prev => {
      const next = new Set(prev);
      if (next.has(panelId)) {
        next.delete(panelId);
      } else {
        next.add(panelId);
      }
      return next;
    });
  }, []);

  if (panels.length === 0) {
    return null;
  }

  // Collapsed state - show narrow bar with expand button
  if (collapsed) {
    return (
      <div className="h-full flex flex-col bg-canvas-alt border-r border-border">
        <button
          onClick={() => onCollapsedChange(false)}
          className="p-2 text-muted-foreground hover:text-ink hover:bg-card-alt transition-colors"
          title="Expand shared panels"
        >
          <ChevronRightIcon className="w-4 h-4" />
        </button>
        <div className="flex-1 flex flex-col items-center pt-2 gap-1">
          {panels.map((panel) => (
            <div
              key={panel.id}
              className="w-1.5 h-1.5 rounded-full bg-primary"
              title={panel.sessions.find(s => s.id === panel.activeSessionId)?.title || "Shared"}
            />
          ))}
        </div>
      </div>
    );
  }

  // Count expanded panels for flex distribution
  const expandedCount = panels.filter(p => expandedPanels.has(p.id)).length;

  return (
    <div className="h-full w-full min-w-0 flex flex-col overflow-hidden">
      {/* Header - aligned with FeatureTabs height */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border bg-card flex-shrink-0">
        <button
          onClick={() => onCollapsedChange(true)}
          className="p-1 text-muted-foreground hover:text-ink hover:bg-card-alt transition-colors rounded"
          title="Collapse pinned panels"
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </button>
        <DrawingPinFilledIcon className="w-3.5 h-3.5 text-primary/70" />
        <span className="text-sm text-muted-foreground">
          Pinned
          {panels.length > 1 && <span className="ml-1 text-xs">({panels.length})</span>}
        </span>
      </div>

      {/* Panels */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {panels.map((panel) => {
          const isExpanded = expandedPanels.has(panel.id);
          return (
            <div
              key={panel.id}
              className={`flex flex-col bg-terminal border border-border overflow-hidden ${
                isExpanded ? (expandedCount > 0 ? "flex-1 min-h-0" : "flex-1") : "flex-shrink-0"
              }`}
            >
              <SessionPanel
                panel={panel}
                collapsible
                isExpanded={isExpanded}
                onToggleExpand={() => togglePanelExpanded(panel.id)}
                onPanelClose={() => onPanelClose(panel.id)}
                onPanelToggleShared={() => onPanelToggleShared(panel.id)}
                onPanelReload={() => onPanelReload(panel.id)}
                onSessionAdd={() => onSessionAdd(panel.id)}
                onSessionClose={(sessionId) => onSessionClose(panel.id, sessionId)}
                onSessionSelect={(sessionId) => onSessionSelect(panel.id, sessionId)}
                onSessionTitleChange={(sessionId, title) => onSessionTitleChange(panel.id, sessionId, title)}
                headerBg="bg-canvas-alt"
                titleFallback="Shared"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
