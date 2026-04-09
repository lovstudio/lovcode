import { useState, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDownIcon, ChevronRightIcon, DotsHorizontalIcon, ListBulletIcon, GroupIcon, MixIcon, MagnifyingGlassIcon, Cross2Icon } from "@radix-ui/react-icons";
import { Copy, Upload } from "lucide-react";
import { useAtom } from "jotai";
import {
  allProjectsSortByAtom,
  hideEmptySessionsAllAtom,
  originalChatAtom,
  markdownPreviewAtom,
} from "../../store";
import { useAppConfig } from "../../context";
import { useReadableText } from "./utils";
import { useInvokeQuery, useQueryClient } from "../../hooks";
import { CollapsibleContent } from "./CollapsibleContent";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import { ProjectLogo } from "../Workspace/ProjectLogo";
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
  const [dataSource, setDataSource] = useState<"all" | "local" | "web">("all");

  const [sortBy, setSortBy] = useAtom(allProjectsSortByAtom);
  const [hideEmptySessions, setHideEmptySessions] = useAtom(hideEmptySessionsAllAtom);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string> | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [grouped, setGrouped] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Session[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [indexReady, setIndexReady] = useState(false);

  // Default all projects to collapsed on first load
  useEffect(() => {
    if (collapsedGroups === null && projects.length > 0) {
      setCollapsedGroups(new Set(projects.map((p) => p.id)));
    }
  }, [projects, collapsedGroups]);

  // Build search index on mount
  useEffect(() => {
    invoke<number>("build_search_index")
      .then(() => setIndexReady(true))
      .catch(() => {});
  }, []);

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

  const hasWebData = useMemo(() => projects.some((p) => p.id === "-claude-ai"), [projects]);

  const sortedProjects = useMemo(() => {
    const filtered = projects.filter((p) => {
      if (p.session_count === 0) return false;
      if (dataSource === "local") return p.id !== "-claude-ai";
      if (dataSource === "web") return p.id === "-claude-ai";
      return true;
    });
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "recent": return b.last_active - a.last_active;
        case "sessions": return b.session_count - a.session_count;
        case "name": return a.path.localeCompare(b.path);
      }
    });
  }, [projects, sortBy, dataSource]);

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, Session[]>();
    const normalizePath = (p: string) => p.replace(/\/+$/, "");

    for (const project of sortedProjects) {
      const projectPathNorm = normalizePath(project.path);
      const sessions = allSessions
        .filter((s) => {
          if (!s.project_path) return false;
          if (hideEmptySessions && s.message_count === 0) return false;
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
  }, [sortedProjects, allSessions, sortBy, hideEmptySessions]);

  const flatSessions = useMemo(() => {
    if (grouped) return [];
    return allSessions
      .filter((s) => {
        if (s.message_count === 0 && hideEmptySessions) return false;
        if (dataSource === "local") return s.project_id !== "-claude-ai";
        if (dataSource === "web") return s.project_id === "-claude-ai";
        return true;
      })
      .sort((a, b) => {
        switch (sortBy) {
          case "recent": return b.last_modified - a.last_modified;
          case "sessions": return b.message_count - a.message_count;
          case "name": return (a.summary || "").localeCompare(b.summary || "");
        }
      });
  }, [allSessions, sortBy, hideEmptySessions, grouped, dataSource]);

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

  const handleImportDir = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select claude.ai data export folder",
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
          <h2 className="font-serif text-lg font-semibold text-ink mb-1">Chat History</h2>
          <p className="text-xs text-muted-foreground mb-3">
            {sortedProjects.length} projects · {allSessions.length} sessions
          </p>

          {/* Data source tabs */}
          {hasWebData && (
            <div className="flex gap-0.5 mb-2 p-0.5 rounded-lg bg-card-alt">
              {(["all", "local", "web"] as const).map((src) => (
                <button
                  key={src}
                  onClick={() => setDataSource(src)}
                  className={`flex-1 px-2 py-1 rounded-md text-xs transition-colors ${
                    dataSource === src
                      ? "bg-card text-ink shadow-sm"
                      : "text-muted-foreground hover:text-ink"
                  }`}
                >
                  {src === "all" ? "All" : src === "local" ? "Code" : "Web"}
                </button>
              ))}
            </div>
          )}

          {/* Search */}
          <div className="relative mb-2">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={indexReady ? "Search conversations..." : "Building search index..."}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-card border border-border text-ink placeholder:text-muted-foreground focus:outline-none focus:border-primary"
            />
            {searching && (
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">...</span>
            )}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1">
            {/* Sort dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-ink hover:bg-card-alt transition-colors">
                  <MixIcon className="w-3.5 h-3.5" />
                  {sortBy === "name" ? "Name" : "Recent"}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[120px]">
                <DropdownMenuLabel className="text-xs">Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                  <DropdownMenuRadioItem value="recent">Recent</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex-1" />

            {/* Grouped/Flat toggle */}
            <button
              onClick={() => setGrouped(!grouped)}
              className={`p-1.5 rounded-md transition-colors ${grouped ? "bg-card-alt text-ink" : "text-muted-foreground hover:text-ink"}`}
              title={grouped ? "Flat view" : "Grouped view"}
            >
              {grouped ? <GroupIcon className="w-3.5 h-3.5" /> : <ListBulletIcon className="w-3.5 h-3.5" />}
            </button>

            {/* Hide empty toggle */}
            <button
              onClick={() => setHideEmptySessions(!hideEmptySessions)}
              className={`p-1.5 rounded-md transition-colors ${hideEmptySessions ? "bg-card-alt text-ink" : "text-muted-foreground hover:text-ink"}`}
              title={hideEmptySessions ? "Show all sessions" : "Hide empty sessions"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {hideEmptySessions ? (
                  <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><path d="m2 2 20 20"/></>
                ) : (
                  <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></>
                )}
              </svg>
            </button>

            {/* Import claude.ai data */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  disabled={importing}
                  className="p-1.5 rounded-md transition-colors text-muted-foreground hover:text-ink hover:bg-card-alt disabled:opacity-50"
                  title="Import claude.ai data export"
                >
                  <Upload className="w-3.5 h-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[160px]">
                <DropdownMenuItem onClick={handleImportZip}>Import .zip</DropdownMenuItem>
                <DropdownMenuItem onClick={handleImportDir}>Import folder</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Session List */}
        <div className="px-2 pb-4 space-y-0.5">
          {searchResults !== null ? (
            // Search results (flat)
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
                />
              ))
            )
          ) : grouped ? (
            // Grouped by project
            sortedProjects.map((project) => {
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
                    <button className="p-0.5 text-muted-foreground">
                      {isCollapsed ? (
                        <ChevronRightIcon className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDownIcon className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <ProjectLogo projectPath={project.path} size="sm" />
                    <span className="text-sm font-medium text-ink truncate flex-1" title={project.path}>
                      {projectName}
                    </span>
                    <span className="text-xs text-muted-foreground">{sessions.length}</span>
                  </div>
                  {!isCollapsed && (
                    <div className="ml-5 mt-0.5 space-y-0.5">
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
            flatSessions.map((session) => (
              <SessionItemButton
                key={session.id}
                session={session}
                isSelected={selectedSession?.id === session.id}
                onClick={() => setSelectedSession(prev => prev?.id === session.id ? null : session)}
                onDoubleClick={() => onSelectSession(session)}
                toReadable={toReadable}
                showProject
              />
            ))
          )}
        </div>
      </div>

      {/* Right Panel: Session Detail */}
      <div className="flex-1 overflow-y-auto">
        {selectedSession ? (
          <SessionDetail
            session={selectedSession}
            onClose={() => setSelectedSession(null)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground text-sm">
            <span>Select a session to preview</span>
            <button
              onClick={handleImportZip}
              disabled={importing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-border hover:bg-card-alt transition-colors disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              {importing ? "Importing..." : "Import claude.ai data (.zip)"}
            </button>
          </div>
        )}
      </div>
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
}: {
  session: Session;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  toReadable: (s: string | null) => string;
  showProject?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`w-full text-left flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors min-w-0 ${
        isSelected
          ? "bg-primary/10 text-ink"
          : "text-muted-foreground hover:text-ink hover:bg-card-alt"
      }`}
    >
      <div className="truncate flex-1 min-w-0">
        <span className="truncate block">
          {session.title || toReadable(session.summary) || "Untitled"}
        </span>
        {showProject && session.project_path && (
          <span className="text-[10px] text-muted-foreground/60 truncate block">
            {session.project_path.split("/").pop()}
          </span>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground shrink-0">
        {session.message_count}
      </span>
    </button>
  );
}

// ============================================================================
// Session Detail (right panel)
// ============================================================================

function SessionDetail({ session, onClose }: { session: Session; onClose: () => void }) {
  const { formatPath } = useAppConfig();
  const toReadable = useReadableText();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [originalChat] = useAtom(originalChatAtom);
  const [markdownPreview] = useAtom(markdownPreviewAtom);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const displaySummary = session.title || toReadable(session.summary) || "Untitled";

  useEffect(() => {
    setLoading(true);
    invoke<Message[]>("get_session_messages", {
      projectId: session.project_id,
      sessionId: session.id,
    })
      .then(setMessages)
      .finally(() => setLoading(false));
  }, [session.project_id, session.id]);

  const filteredMessages = useMemo(
    () => (originalChat ? messages.filter((m) => !m.is_meta && !m.is_tool) : messages),
    [messages, originalChat]
  );

  const handleCopyContent = (content: string) => {
    invoke("copy_to_clipboard", { text: content });
  };

  return (
    <div className="px-6 py-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-serif text-xl font-semibold text-ink leading-tight mb-1 line-clamp-2">
            {displaySummary}
          </h2>
          <p className="text-xs text-muted-foreground truncate">
            {session.project_path ? formatPath(session.project_path) : session.project_id}
            {" · "}
            {session.message_count} messages
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="p-1.5 rounded-lg text-muted-foreground hover:bg-card-alt shrink-0">
              <DotsHorizontalIcon width={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <SessionDropdownMenuItems
              projectId={session.project_id}
              sessionId={session.id}
              onExport={() => setExportDialogOpen(true)}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onClose} className="gap-2">
              <Cross2Icon width={14} />
              Close
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-muted-foreground text-sm">Loading messages...</p>
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
                <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">{msg.role}</p>
                {msg.content_blocks && !originalChat ? (
                  <ContentBlockRenderer blocks={msg.content_blocks} markdown={markdownPreview} />
                ) : (
                  <CollapsibleContent content={displayContent} markdown={markdownPreview} />
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
  );
}
