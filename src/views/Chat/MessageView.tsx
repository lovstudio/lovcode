import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DotsHorizontalIcon } from "@radix-ui/react-icons";
import { FileCode, Copy } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "../../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
  SessionContextMenuItems,
  SessionDropdownMenuItems,
} from "../../components/shared/SessionMenuItems";
import { useAtom } from "jotai";
import { originalChatAtom, markdownPreviewAtom } from "../../store";
import { CollapsibleContent } from "./CollapsibleContent";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import { ExportDialog } from "./ExportDialog";
import { useReadableText } from "./utils";
import { useAppConfig } from "../../context";
import type { Message } from "../../types";

interface MessageViewProps {
  projectId: string;
  projectPath: string;
  sessionId: string;
  summary: string | null;
  onBack: () => void;
}

export function MessageView({ projectId, projectPath, sessionId, summary: initialSummary, onBack }: MessageViewProps) {
  const { formatPath } = useAppConfig();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [freshSummary, setFreshSummary] = useState<string | null>(initialSummary);
  const [originalChat, setOriginalChat] = useAtom(originalChatAtom);
  const [markdownPreview, setMarkdownPreview] = useAtom(markdownPreviewAtom);
  const toReadable = useReadableText();
  const displaySummary = toReadable(freshSummary) || "Session";
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [sessionFilePath, setSessionFilePath] = useState("");

  useEffect(() => {
    invoke<Message[]>("get_session_messages", { projectId, sessionId })
      .then(setMessages)
      .finally(() => setLoading(false));
    invoke<string>("get_session_file_path", { projectId, sessionId })
      .then(setSessionFilePath)
      .catch(() => {});
    // Fetch fresh summary to avoid stale cache from navigation state
    invoke<string | null>("get_session_summary", { projectId, sessionId })
      .then((s) => s && setFreshSummary(s))
      .catch(() => {});
  }, [projectId, sessionId]);

  const processContent = (content: string) => toReadable(content);

  const handleCopyContent = (content: string) => {
    invoke("copy_to_clipboard", { text: content });
  };

  const handleCopyFileLine = (lineNumber: number) => {
    if (sessionFilePath) {
      invoke("copy_to_clipboard", { text: `${sessionFilePath}:${lineNumber}` });
    }
  };

  const filteredMessages = useMemo(
    () => (originalChat ? messages.filter((m) => !m.is_meta && !m.is_tool) : messages),
    [messages, originalChat]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Loading messages...</p>
      </div>
    );
  }

  return (
    <div className="px-6 py-8">
      <header className="mb-8">
        <nav className="flex items-center gap-1.5 text-sm mb-4">
          <button
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground transition-colors truncate max-w-[200px]"
          >
            {projectPath ? formatPath(projectPath) : projectId}
          </button>
          <span className="text-muted-foreground/50">/</span>
          <span className="text-foreground truncate max-w-[300px]">
            {displaySummary}
          </span>
        </nav>
        <div className="flex items-start justify-between gap-4">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="cursor-context-menu flex-1 min-w-0">
                <h1 className="font-serif text-2xl font-semibold text-ink leading-tight mb-1">
                  {displaySummary}
                </h1>
                <p className="text-primary text-xs font-mono truncate">{sessionId}</p>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <SessionContextMenuItems
                projectId={projectId}
                sessionId={sessionId}
                projectPath={projectPath}
                originalChat={originalChat}
                setOriginalChat={setOriginalChat}
                markdownPreview={markdownPreview}
                setMarkdownPreview={setMarkdownPreview}
                onExport={() => setExportDialogOpen(true)}
              />
            </ContextMenuContent>
          </ContextMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="text-muted-foreground-foreground p-1 rounded hover:bg-card-alt shrink-0">
                <DotsHorizontalIcon width={18} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <SessionDropdownMenuItems
                projectId={projectId}
                sessionId={sessionId}
                projectPath={projectPath}
                originalChat={originalChat}
                setOriginalChat={setOriginalChat}
                markdownPreview={markdownPreview}
                setMarkdownPreview={setMarkdownPreview}
                onExport={() => setExportDialogOpen(true)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="space-y-4">
        {filteredMessages.map((msg) => {
          const displayContent = processContent(msg.content);
          return (
            <div
              key={msg.uuid}
              className={`group relative rounded-xl p-4 ${
                msg.role === "user" ? "bg-card-alt" : "bg-card border border-border"
              }`}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="absolute top-3 right-3 p-1.5 rounded-md bg-card-alt/80 hover:bg-card-alt text-muted-foreground hover:text-ink transition-opacity opacity-0 group-hover:opacity-100">
                    <DotsHorizontalIcon width={16} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleCopyContent(displayContent)}>
                    <Copy size={14} />
                    Copy Content
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleCopyFileLine(msg.line_number)}>
                    <FileCode size={14} />
                    Copy file:line
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <p className="text-xs text-muted-foreground-foreground mb-2 uppercase tracking-wide">{msg.role}</p>
              {msg.content_blocks && !originalChat ? (
                <ContentBlockRenderer blocks={msg.content_blocks} markdown={markdownPreview} />
              ) : (
                <CollapsibleContent content={displayContent} markdown={markdownPreview} />
              )}
            </div>
          );
        })}
      </div>

      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        allMessages={filteredMessages}
        selectedIds={selectedIds}
        onSelectedIdsChange={setSelectedIds}
        defaultName={initialSummary?.slice(0, 50).replace(/[/\\?%*:|"<>]/g, "-") || "session"}
      />
    </div>
  );
}
