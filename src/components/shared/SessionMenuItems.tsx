import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, Copy, Download, Terminal, Archive, ArchiveRestore } from "lucide-react";
import { ExternalLinkIcon, ChatBubbleIcon } from "@radix-ui/react-icons";
import {
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { archivedSessionIdsAtom } from "@/store";

export interface SessionMenuConfig {
  projectId: string;
  sessionId: string;
  projectPath?: string;
  originalChat?: boolean;
  setOriginalChat?: (v: boolean) => void;
  markdownPreview?: boolean;
  setMarkdownPreview?: (v: boolean) => void;
  onExport?: () => void;
  onResume?: () => void;
  onCopySessionId?: () => void;
  /** Archive this session and every session after it in the visible list. Count is used for the label. */
  onArchiveAllAfter?: () => void;
  archiveAfterCount?: number;
}

// Shared handlers
export function useSessionMenuHandlers(projectId: string, sessionId: string) {
  const handleReveal = () => invoke("reveal_session_file", { projectId, sessionId });
  const handleOpenInEditor = () => invoke("open_session_in_editor", { projectId, sessionId });
  const handleCopyPath = async () => {
    const homeDir = await invoke<string>("get_home_dir");
    const path = `${homeDir}/.claude/projects/${projectId}/${sessionId}.jsonl`;
    await invoke("copy_to_clipboard", { text: path });
  };
  const handleCopySessionId = () => invoke("copy_to_clipboard", { text: sessionId });
  const handleCopyResumeCommand = (projectPath: string) => {
    const cmd = `cd ${projectPath} && claude --resume ${sessionId}`;
    return invoke("copy_to_clipboard", { text: cmd });
  };

  return { handleReveal, handleOpenInEditor, handleCopyPath, handleCopySessionId, handleCopyResumeCommand };
}

// Archive state for a session (client-side hidden-in-sidebar flag)
export function useSessionArchive(sessionId: string) {
  const [archivedIds, setArchivedIds] = useAtom(archivedSessionIdsAtom);
  const isArchived = archivedIds.includes(sessionId);
  const toggleArchived = () => {
    setArchivedIds((prev) =>
      prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : [...prev, sessionId]
    );
  };
  return { isArchived, toggleArchived };
}

// DropdownMenu items
export function SessionDropdownMenuItems({
  projectId,
  sessionId,
  projectPath,
  originalChat,
  setOriginalChat,
  markdownPreview,
  setMarkdownPreview,
  onExport,
  onResume,
  onArchiveAllAfter,
  archiveAfterCount,
}: SessionMenuConfig) {
  const { handleReveal, handleOpenInEditor, handleCopyPath, handleCopySessionId, handleCopyResumeCommand } =
    useSessionMenuHandlers(projectId, sessionId);
  const { isArchived, toggleArchived } = useSessionArchive(sessionId);

  return (
    <>
      <DropdownMenuItem onClick={handleCopySessionId} className="gap-2">
        <Copy size={14} />
        Copy Session ID
      </DropdownMenuItem>
      {projectPath && (
        <DropdownMenuItem onClick={() => handleCopyResumeCommand(projectPath)} className="gap-2">
          <Terminal size={14} />
          Copy Resume Command
        </DropdownMenuItem>
      )}
      {onResume && (
        <DropdownMenuItem onClick={onResume} className="gap-2">
          <ChatBubbleIcon className="w-3.5 h-3.5" />
          Resume Session
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={toggleArchived} className="gap-2">
        {isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        {isArchived ? "Unarchive" : "Archive"}
      </DropdownMenuItem>
      {onArchiveAllAfter && archiveAfterCount !== undefined && archiveAfterCount > 0 && (
        <DropdownMenuItem onClick={onArchiveAllAfter} className="gap-2">
          <Archive size={14} />
          Archive This and {archiveAfterCount} After
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={handleReveal} className="gap-2">
        <FolderOpen size={14} />
        Reveal in Finder
      </DropdownMenuItem>
      <DropdownMenuItem onClick={handleOpenInEditor} className="gap-2">
        <ExternalLinkIcon width={14} />
        Open in Editor
      </DropdownMenuItem>
      <DropdownMenuItem onClick={handleCopyPath} className="gap-2">
        <Copy size={14} />
        Copy Path
      </DropdownMenuItem>
      {(setOriginalChat || setMarkdownPreview) && (
        <>
          <DropdownMenuSeparator />
          {setOriginalChat && (
            <DropdownMenuCheckboxItem checked={originalChat} onCheckedChange={setOriginalChat}>
              Readable Slash Command
            </DropdownMenuCheckboxItem>
          )}
          {setMarkdownPreview && (
            <DropdownMenuCheckboxItem checked={markdownPreview} onCheckedChange={setMarkdownPreview}>
              Markdown Preview
            </DropdownMenuCheckboxItem>
          )}
        </>
      )}
      {onExport && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onExport} className="gap-2">
            <Download size={14} />
            Export
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

// ContextMenu items
export function SessionContextMenuItems({
  projectId,
  sessionId,
  projectPath,
  originalChat,
  setOriginalChat,
  markdownPreview,
  setMarkdownPreview,
  onExport,
  onResume,
  onArchiveAllAfter,
  archiveAfterCount,
}: SessionMenuConfig) {
  const { handleReveal, handleOpenInEditor, handleCopyPath, handleCopySessionId, handleCopyResumeCommand } =
    useSessionMenuHandlers(projectId, sessionId);
  const { isArchived, toggleArchived } = useSessionArchive(sessionId);

  return (
    <>
      <ContextMenuItem onClick={handleCopySessionId} className="gap-2">
        <Copy size={14} />
        Copy Session ID
      </ContextMenuItem>
      {projectPath && (
        <ContextMenuItem onClick={() => handleCopyResumeCommand(projectPath)} className="gap-2">
          <Terminal size={14} />
          Copy Resume Command
        </ContextMenuItem>
      )}
      {onResume && (
        <ContextMenuItem onClick={onResume} className="gap-2">
          <ChatBubbleIcon className="w-3.5 h-3.5" />
          Resume Session
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={toggleArchived} className="gap-2">
        {isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        {isArchived ? "Unarchive" : "Archive"}
      </ContextMenuItem>
      {onArchiveAllAfter && archiveAfterCount !== undefined && archiveAfterCount > 0 && (
        <ContextMenuItem onClick={onArchiveAllAfter} className="gap-2">
          <Archive size={14} />
          Archive This and {archiveAfterCount} After
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={handleReveal} className="gap-2">
        <FolderOpen size={14} />
        Reveal in Finder
      </ContextMenuItem>
      <ContextMenuItem onClick={handleOpenInEditor} className="gap-2">
        <ExternalLinkIcon width={14} />
        Open in Editor
      </ContextMenuItem>
      <ContextMenuItem onClick={handleCopyPath} className="gap-2">
        <Copy size={14} />
        Copy Path
      </ContextMenuItem>
      {(setOriginalChat || setMarkdownPreview) && (
        <>
          <ContextMenuSeparator />
          {setOriginalChat && (
            <ContextMenuCheckboxItem checked={originalChat} onCheckedChange={setOriginalChat}>
              Readable Slash Command
            </ContextMenuCheckboxItem>
          )}
          {setMarkdownPreview && (
            <ContextMenuCheckboxItem checked={markdownPreview} onCheckedChange={setMarkdownPreview}>
              Markdown Preview
            </ContextMenuCheckboxItem>
          )}
        </>
      )}
      {onExport && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onExport} className="gap-2">
            <Download size={14} />
            Export
          </ContextMenuItem>
        </>
      )}
    </>
  );
}
