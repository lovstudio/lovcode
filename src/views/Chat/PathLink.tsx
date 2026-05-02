import { invoke } from "@tauri-apps/api/core";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../components/ui/context-menu";
import { toast } from "../../components/ui/toast";
import type { PathHit } from "./pathDetection";

interface PathLinkProps {
  text: string;
  hit: PathHit;
}

function handleErr(action: string, path: string) {
  return (e: unknown) => {
    const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    toast.error(`${action} 失败: ${msg}`);
    console.error(action, path, e);
  };
}

export function PathLink({ text, hit }: PathLinkProps) {
  const open = () => {
    invoke("open_path", { path: hit.resolved }).catch(handleErr("打开", hit.resolved));
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
        onClick={(e) => {
          e.stopPropagation();
          open();
        }}
        className="text-primary underline decoration-dotted underline-offset-2 cursor-pointer hover:bg-primary/10 rounded px-0.5"
        title={hit.resolved}
      >
        {text}
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuItem onSelect={open}>
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
