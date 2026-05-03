import { invoke } from "@tauri-apps/api/core";
import { useRef } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../components/ui/context-menu";
import { toast } from "../../components/ui/toast";
import type { PathHit } from "./pathDetection";
import { useFilePreview } from "./FilePreviewContext";

interface PathLinkProps {
  text: string;
  hit: PathHit;
  line?: number;
  column?: number;
}

function handleErr(action: string, path: string) {
  return (e: unknown) => {
    const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    toast.error(`${action} 失败: ${msg}`);
    console.error(action, path, e);
  };
}

export function PathLink({ text, hit, line, column }: PathLinkProps) {
  const filePreview = useFilePreview();
  const triggerRef = useRef<HTMLSpanElement>(null);

  const openExternal = () => {
    invoke("open_path", { path: hit.resolved }).catch(handleErr("打开", hit.resolved));
  };

  const openDefault = (anchor?: HTMLElement | null) => {
    if (!hit.isDir && filePreview) {
      filePreview.openFilePreview(hit.resolved, anchor, { line, column });
      return;
    }
    openExternal();
  };

  const openInternal = (anchor?: HTMLElement | null) => {
    filePreview?.openFilePreview(hit.resolved, anchor, { line, column });
  };

  const open = (anchor?: HTMLElement | null) => {
    openDefault(anchor);
  };

  const reveal = () => {
    invoke("reveal_path", { path: hit.resolved }).catch(handleErr("在 Finder 中显示", hit.resolved));
  };
  const openInEditor = () => {
    invoke("open_in_editor", { path: hit.resolved }).catch(handleErr("在编辑器中打开", hit.resolved));
  };
  const copy = () => {
    navigator.clipboard
      .writeText(hit.resolved)
      .then(() => toast.success("已复制路径"))
      .catch(handleErr("复制", hit.resolved));
  };

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger
        ref={triggerRef}
        onClick={(e) => {
          e.stopPropagation();
          open(e.currentTarget);
        }}
        className="text-primary underline decoration-dotted underline-offset-2 cursor-pointer hover:bg-primary/10 rounded px-0.5"
        title={hit.resolved}
      >
        {text}
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        {!hit.isDir && filePreview && (
          <ContextMenuItem onSelect={() => openInternal(triggerRef.current)}>
            Open in lovcode
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={openExternal}>
          {hit.isDir ? "Open folder" : "Open with default app"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={reveal}>Reveal in Finder</ContextMenuItem>
        {!hit.isDir && (
          <ContextMenuItem onSelect={openInEditor}>Open in editor</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={copy}>Copy resolved path</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
