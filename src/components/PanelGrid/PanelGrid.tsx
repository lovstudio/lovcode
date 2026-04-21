import { useCallback, useEffect, useRef, useState } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { ChevronLeftIcon, ChevronRightIcon, DrawingPinFilledIcon, ChevronDownIcon, FileIcon, DesktopIcon, RocketIcon, CodeIcon, GitHubLogoIcon } from "@radix-ui/react-icons";
import { SessionPanel } from "./SessionPanel";
import type { LayoutNode } from "../../views/Workspace/types";
import { TERMINAL_OPTIONS, type ProjectOption } from "../ui/new-terminal-button";
import { SlashCommandMenu, type CommandItem } from "../ui/slash-command-menu";
import { useInvokeQuery } from "../../hooks";
import type { LocalCommand, CodexCommand } from "../../types";
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
}: PanelGridProps) {
  // Selected project for empty state (default to active project)
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(activeProjectId);
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
    const selectedProject = projects?.find((p) => p.id === selectedProjectId) || projects?.[0];

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

      if (selectedProject && onSelectProject) {
        onSelectProject(selectedProject, command, initialInput);
      } else if (onInitialPanelCreate) {
        onInitialPanelCreate(command, initialInput);
      }
    };

    // Quick action cards data
    const quickActions = [
      { icon: RocketIcon, title: "Start dev server", code: "pnpm dev" },
      { icon: GitHubLogoIcon, title: "Check git status", code: "git status" },
      { icon: CodeIcon, title: "Run tests", code: "pnpm test" },
    ];

    // Common dropdown button style
    const dropdownButtonClass = "inline-flex items-center justify-between gap-3 px-4 py-2.5 text-sm border border-border bg-card hover:bg-card-alt rounded-xl transition-colors";

    return (
      <div className="h-full w-full flex items-start justify-center pt-[20vh] bg-canvas bg-[radial-gradient(#e5e5e5_1px,transparent_1px)] dark:bg-[radial-gradient(#333_1px,transparent_1px)] [background-size:20px_20px]">
        <div className="flex flex-col items-center gap-5 w-full max-w-xl px-6">
          {/* App logo */}
          <div className="mb-2">
            <img src="/logo.svg" alt="Lovcode" className="w-12 h-12" />
          </div>

          {/* Project selector */}
          {hasProjects && onSelectProject ? (
            <div className="flex items-center gap-3 w-full max-w-md">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className={`${dropdownButtonClass} flex-1 min-w-0`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <span className="truncate">{selectedProject?.name || "Select folder"}</span>
                    </div>
                    <ChevronDownIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[200px]">
                  {projects.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      onClick={() => setSelectedProjectId(project.id)}
                    >
                      <span className={`truncate ${project.id === selectedProjectId ? "font-medium" : ""}`}>
                        {project.name}
                      </span>
                    </DropdownMenuItem>
                  ))}
                  {onAddFolder && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={onAddFolder}>
                        <FileIcon className="w-4 h-4 mr-2" />
                        Add folder...
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}

          {/* Super prompt box */}
          <div className="w-full max-w-md">
            <div className="border border-border rounded-2xl bg-card overflow-hidden shadow-sm">
              <textarea
                ref={textareaRef}
                value={inputCommand}
                onChange={(e) => {
                  const value = e.target.value;
                  setInputCommand(value);

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
                className="w-full p-4 bg-transparent resize-none outline-none text-sm min-h-[80px] placeholder:text-muted-foreground/60"
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
              {/* Bottom area: command menu or start button */}
              {showSlashMenu ? (
                selectedTerminalType.type === "terminal" ? (
                  <div className="px-3 py-2.5 border-t border-border bg-muted/30 text-sm text-muted-foreground">
                    Slash commands are only available in Claude Code or Codex mode
                  </div>
                ) : (
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
                )
              ) : (
                <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-t border-border bg-muted/30">
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
                  <button
                    onClick={() => handleCreate(inputCommand || undefined)}
                    className="px-4 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium"
                  >
                    Start
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Quick action cards */}
          <div className="flex gap-2.5 w-full max-w-md">
            {quickActions.map((action, i) => (
              <button
                key={i}
                onClick={() => {
                  if (selectedTerminalType.type === 'terminal') {
                    handleCreate(action.code);
                  } else {
                    handleCreate(action.title);
                  }
                }}
                className="flex-1 p-3 border border-border rounded-xl bg-card hover:bg-card-alt hover:border-primary/30 transition-all text-left group"
              >
                <action.icon className="w-4 h-4 text-muted-foreground mb-2 group-hover:text-primary transition-colors" />
                <p className="text-xs text-foreground font-medium mb-1">{action.title}</p>
                <code className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground font-mono">
                  {action.code}
                </code>
              </button>
            ))}
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
