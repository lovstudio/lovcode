import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, Copy, ExternalLink } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";

/** Strip Claude worktree suffix (`.../.claude/worktrees/<slug>`) from a path.
 *  Returns {origin, worktreeName} when detected, otherwise {origin: path, worktreeName: null}. */
export function parseWorktreePath(path: string): { origin: string; worktreeName: string | null } {
  const m = path.match(/^(.*?)\/\.claude\/worktrees\/([^/]+)\/?$/);
  if (!m) return { origin: path, worktreeName: null };
  return { origin: m[1], worktreeName: m[2] };
}

/** Display label for a project path: just the origin `basename` (worktree suffix stripped). */
export function formatProjectPathLabel(path: string): { text: string; tooltip: string } {
  const { origin } = parseWorktreePath(path);
  const parts = origin.split("/").filter(Boolean);
  const text = parts[parts.length - 1] ?? origin;
  return { text, tooltip: path };
}

interface ProjectPathLabelProps {
  path: string;
  className?: string;
}

/** Single-line project-path label with a right-click menu aligned for folder paths.
 *  Reuses backend commands `reveal_path`, `open_path`, `copy_to_clipboard`. */
export function ProjectPathLabel({ path, className = "" }: ProjectPathLabelProps) {
  const { text, tooltip } = formatProjectPathLabel(path);

  const reveal = () => invoke("reveal_path", { path }).catch((e) => console.error("reveal", e));
  const openFolder = () => invoke("open_path", { path }).catch((e) => console.error("open", e));
  const copy = () => invoke("copy_to_clipboard", { text: path }).catch((e) => console.error("copy", e));

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <span
          className={`inline-flex items-center gap-1 min-w-0 max-w-full cursor-default ${className}`}
          title={tooltip}
        >
          <FolderOpen className="w-3 h-3 opacity-60 shrink-0" />
          <span className="truncate min-w-0">{text}</span>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuItem onSelect={reveal} className="gap-2">
          <FolderOpen className="w-3.5 h-3.5" />
          Reveal in Finder
        </ContextMenuItem>
        <ContextMenuItem onSelect={openFolder} className="gap-2">
          <ExternalLink className="w-3.5 h-3.5" />
          Open Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={copy} className="gap-2">
          <Copy className="w-3.5 h-3.5" />
          Copy Path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
