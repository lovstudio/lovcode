import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { FileIcon, GlobeIcon, ChatBubbleIcon } from "@radix-ui/react-icons";
import { Switch } from "../../components/ui/switch";
import { ContextFileItem } from "../../components/ContextFileItem";
import { useAtom } from "jotai";
import { sessionContextTabAtom, sessionSelectModeAtom, hideEmptySessionsAtom, userPromptsOnlyAtom } from "../../store";
import { useAppConfig } from "../../context";
import { formatDate, useReadableText } from "./utils";
import { useInvokeQuery } from "../../hooks";
import type { Session, ContextFile, Message, SearchResult, SessionUsageEntry, SessionUsage } from "../../types";

interface SessionListProps {
  projectId: string;
  projectPath: string;
  onBack: () => void;
  onSelect: (s: Session) => void;
}

// Format token count (e.g., 1234567 -> "1.23M")
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

// Format cost (e.g., 0.1234 -> "$0.12")
function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function SessionList({ projectId, projectPath, onBack, onSelect }: SessionListProps) {
  const { formatPath } = useAppConfig();
  const toReadable = useReadableText();

  // Use react-query for cached data
  const { data: sessions = [], isLoading: loadingSessions } = useInvokeQuery<Session[]>(
    ["sessions", projectId],
    "list_sessions",
    { projectId }
  );
  const { data: allContextFiles = [], isLoading: loadingContext } = useInvokeQuery<ContextFile[]>(
    ["contextFiles"],
    "get_context_files"
  );
  const { data: projectContext = [] } = useInvokeQuery<ContextFile[]>(
    ["projectContext", projectPath],
    "get_project_context",
    { projectPath },
  );

  // Load usage data separately (lazy loading for performance)
  const { data: usageData = [] } = useInvokeQuery<SessionUsageEntry[]>(
    ["sessionsUsage", projectId],
    "get_sessions_usage",
    { projectId }
  );

  // Create usage map for quick lookup
  const usageMap = useMemo(() => {
    const map = new Map<string, SessionUsage>();
    usageData.forEach((entry) => map.set(entry.session_id, entry.usage));
    return map;
  }, [usageData]);

  // Calculate total usage for all sessions
  const totalUsage = useMemo(() => {
    let total = { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0 };
    usageData.forEach((entry) => {
      total.input_tokens += entry.usage.input_tokens;
      total.output_tokens += entry.usage.output_tokens;
      total.cache_creation_tokens += entry.usage.cache_creation_tokens;
      total.cache_read_tokens += entry.usage.cache_read_tokens;
      total.cost_usd += entry.usage.cost_usd;
    });
    return total;
  }, [usageData]);

  const globalContext = useMemo(() => allContextFiles.filter((f) => f.scope === "global"), [allContextFiles]);
  const loading = loadingSessions || loadingContext;

  const [contextTab, setContextTab] = useAtom(sessionContextTabAtom);
  const [selectMode, setSelectMode] = useAtom(sessionSelectModeAtom);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [hideEmptySessions, setHideEmptySessions] = useAtom(hideEmptySessionsAtom);
  const [userPromptsOnly, setUserPromptsOnly] = useAtom(userPromptsOnlyAtom);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const filteredSessions = hideEmptySessions ? sessions.filter((s) => s.rounds > 0) : sessions;

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await invoke<SearchResult[]>("search_chats", { query: searchQuery, limit: 50, projectId });
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, projectId]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(filteredSessions.map((s) => s.id)));
  const deselectAll = () => setSelectedIds(new Set());

  const exportSessions = async () => {
    setExporting(true);
    try {
      const selected = sessions.filter((s) => selectedIds.has(s.id));
      const projectName = projectPath ? formatPath(projectPath) : projectId;
      const totalMessages = selected.reduce((sum, s) => sum + s.message_count, 0);
      const exportDate = new Date().toISOString();

      const frontmatter = `---
title: "${projectName} - Sessions Export"
description: "Claude Code conversation history exported from Lovcode"
project: "${projectPath || projectId}"
exported_at: ${exportDate}
sessions: ${selected.length}
total_messages: ${totalMessages}
generator: "Lovcode"
---`;

      const toAnchor = (s: string) =>
        s
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-");
      const toc = selected
        .map((s, i) => {
          const title = `Session ${i + 1}: ${toReadable(s.summary) || "Untitled"}`;
          return `- [${title}](#${toAnchor(title)})`;
        })
        .join("\n");

      const parts: string[] = [];
      for (let i = 0; i < selected.length; i++) {
        const session = selected[i];
        const allMessages = await invoke<Message[]>("get_session_messages", { projectId, sessionId: session.id });
        const messages = userPromptsOnly ? allMessages.filter((m) => m.role === "user") : allMessages;
        const sessionMd = messages
          .map((m) => {
            const role = m.role.charAt(0).toUpperCase() + m.role.slice(1);
            return `### ${role}\n\n${m.content}`;
          })
          .join("\n\n---\n\n");
        const msgCountLabel = userPromptsOnly ? `${messages.length} prompts` : `${session.message_count} messages`;
        const meta = `_${msgCountLabel} · ${formatDate(session.last_modified)}_`;
        parts.push(`## Session ${i + 1}: ${toReadable(session.summary) || "Untitled"}\n\n${meta}\n\n${sessionMd}`);
      }
      const body = parts.join("\n\n<br>\n\n---\n\n<br>\n\n");
      const header = `# ${projectName}

> This file contains exported Claude Code conversation sessions.
> ${selected.length} sessions · ${totalMessages} messages`;
      const footer = `\n\n---\n\n_Powered by [Lovcode](https://github.com/MarkShawn2020/lovcode) · Exported at ${new Date().toLocaleString()}_`;
      const content = `${frontmatter}\n\n${header}\n\n### Table of Contents\n\n${toc}\n\n---\n\n${body}${footer}`;
      const defaultName = (projectPath ? formatPath(projectPath) : projectId).replace(/[/\\?%*:|"<>]/g, "-");
      const path = await save({
        defaultPath: `${defaultName}-sessions.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (path) {
        await invoke("write_file", { path, content });
      }
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Loading project...</p>
      </div>
    );
  }

  return (
    <div className="px-6 py-8">
      <header className="mb-6">
        <button onClick={onBack} className="text-muted-foreground hover:text-ink mb-2 flex items-center gap-1 text-sm">
          <span>←</span> Projects
        </button>
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-serif text-2xl font-semibold text-ink truncate">
            {projectPath ? formatPath(projectPath) : projectId}
          </h1>
          {totalUsage.cost_usd > 0 && (
            <div className="flex items-center gap-3 text-sm text-muted-foreground shrink-0">
              <span title="Total tokens (input + output)">
                {formatTokens(totalUsage.input_tokens + totalUsage.output_tokens)} tokens
              </span>
              <span className="font-medium text-primary" title="Estimated cost">
                {formatCost(totalUsage.cost_usd)}
              </span>
            </div>
          )}
        </div>
      </header>

      <div className="relative mb-6">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search chats..."
          className="w-full max-w-md px-4 py-2 pr-8 bg-card border border-border rounded-lg text-ink placeholder:text-muted-foreground focus:outline-none focus:border-primary"
        />
        {searching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">...</span>
        )}
      </div>

      {(globalContext.length > 0 || projectContext.length > 0) && (
        <div className="mb-4 bg-card rounded-xl border border-border overflow-hidden">
          <div className="flex border-b border-border">
            <button
              onClick={() => setContextTab("project")}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                contextTab === "project"
                  ? "text-primary border-b-2 border-primary -mb-px"
                  : "text-muted-foreground hover:text-ink"
              }`}
            >
              <FileIcon className="w-4 h-4 inline mr-1.5" />
              Project ({projectContext.length})
            </button>
            <button
              onClick={() => setContextTab("global")}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                contextTab === "global"
                  ? "text-primary border-b-2 border-primary -mb-px"
                  : "text-muted-foreground hover:text-ink"
              }`}
            >
              <GlobeIcon className="w-4 h-4 inline mr-1.5" />
              Global ({globalContext.length})
            </button>
          </div>
          <div className="p-3 space-y-1">
            {(contextTab === "global" ? globalContext : projectContext).map((file) => (
              <ContextFileItem key={file.path} file={file} showIcon />
            ))}
            {(contextTab === "global" ? globalContext : projectContext).length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No context files</p>
            )}
          </div>
        </div>
      )}

      {searchQuery.trim() && searchResults !== null && (
        <>
          <p className="mb-4 text-xs text-muted-foreground uppercase tracking-wide">
            Search Results ({searchResults.length})
          </p>
          <div className="space-y-3 mb-6">
            {searchResults.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No results found</p>
            ) : (
              searchResults.map((result) => (
                <div
                  key={result.uuid}
                  className="w-full text-left bg-card rounded-xl p-4 border border-border hover:border-primary transition-colors cursor-pointer"
                  onClick={() => {
                    const session = sessions.find((s) => s.id === result.session_id);
                    if (session) onSelect(session);
                  }}
                >
                  <p className="text-xs text-muted-foreground mb-1">{result.session_summary || "Untitled session"}</p>
                  <p className="text-sm text-ink line-clamp-3">{result.content}</p>
                  <p className="text-xs text-muted-foreground mt-2">
                    {result.role} · {result.timestamp}
                  </p>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {!(searchQuery.trim() && searchResults !== null) && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <ChatBubbleIcon className="w-3.5 h-3.5" />
              Sessions ({hideEmptySessions ? `${filteredSessions.length}/${sessions.length}` : sessions.length})
            </p>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Switch checked={hideEmptySessions} onCheckedChange={setHideEmptySessions} />
                <span>Hide empty</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Switch
                  checked={selectMode}
                  onCheckedChange={(v) => {
                    setSelectMode(v);
                    if (!v) deselectAll();
                  }}
                />
                <span>Select</span>
              </label>
              {selectMode && (
                <>
                  <button
                    onClick={selectedIds.size === filteredSessions.length ? deselectAll : selectAll}
                    className="text-xs px-2 py-1 rounded bg-card-alt hover:bg-border text-muted-foreground hover:text-ink transition-colors"
                  >
                    {selectedIds.size === filteredSessions.length ? "Deselect All" : "Select All"}
                  </button>
                  {selectedIds.size > 0 && (
                    <>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={userPromptsOnly}
                          onChange={(e) => setUserPromptsOnly(e.target.checked)}
                          className="w-3 h-3 accent-primary cursor-pointer"
                        />
                        <span>Prompts only</span>
                      </label>
                      <button
                        onClick={exportSessions}
                        disabled={exporting}
                        className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                      >
                        {exporting ? "Exporting..." : `Export ${selectedIds.size}`}
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="space-y-3">
            {filteredSessions.map((session) => {
              const isSelected = selectedIds.has(session.id);
              const usage = usageMap.get(session.id);
              return (
                <div
                  key={session.id}
                  onClick={selectMode ? () => toggleSelect(session.id) : () => onSelect(session)}
                  className={`w-full text-left bg-card rounded-xl p-4 border transition-colors cursor-pointer ${
                    selectMode && isSelected ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-ink line-clamp-2">{toReadable(session.summary) || "Untitled session"}</p>
                      <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                        <span title={`${session.message_count} messages total`}>{session.rounds} rounds</span>
                        <span>·</span>
                        <span>{formatDate(session.last_modified)}</span>
                        {usage && usage.cost_usd > 0 && (
                          <>
                            <span>·</span>
                            <span title={`Input: ${formatTokens(usage.input_tokens)}, Output: ${formatTokens(usage.output_tokens)}`}>
                              {formatTokens(usage.input_tokens + usage.output_tokens)} tokens
                            </span>
                            <span className="text-primary font-medium">{formatCost(usage.cost_usd)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {selectMode && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(session.id)}
                        className="w-4 h-4 accent-primary cursor-pointer mt-1"
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
