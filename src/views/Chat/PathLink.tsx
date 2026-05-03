import { invoke } from "@tauri-apps/api/core";
import { useRef } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../components/ui/context-menu";
import { toast } from "../../components/ui/toast";
import type { PathCandidate, PathHit } from "./pathDetection";
import { useFilePreview } from "./FilePreviewContext";

interface PathLinkProps {
  text: string;
  hit: PathHit;
  cwd?: string;
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

export function PathLink({ text, hit, cwd, line, column }: PathLinkProps) {
  const filePreview = useFilePreview();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const exists = hit.exists !== false;
  const pathArg = exists ? hit.resolved : hit.raw;
  const alternateCandidates = hit.candidates?.filter((candidate) => candidate.source !== "exact") ?? [];
  const hasCandidates = alternateCandidates.length > 0;
  const isResolvedCandidate = exists && hit.candidates?.[0]?.path === hit.resolved && hit.candidates[0].source !== "exact";

  const openExternal = () => {
    invoke("open_path", { path: pathArg, cwd }).catch(handleErr("打开", pathArg));
  };

  const openCandidate = (candidate: PathCandidate, anchor?: HTMLElement | null) => {
    if (candidate.exists === false) {
      toast.info(`路径不存在: ${candidate.path}`);
      return;
    }

    if (!candidate.isDir && filePreview) {
      filePreview.openFilePreview(candidate.path, anchor, { line, column });
      return;
    }

    invoke("open_path", { path: candidate.path }).catch(handleErr("打开", candidate.path));
  };

  const openDefault = (anchor?: HTMLElement | null) => {
    if (exists && !hit.isDir && filePreview) {
      filePreview.openFilePreview(hit.resolved, anchor, { line, column });
      return;
    }
    openExternal();
  };

  const openInternal = (anchor?: HTMLElement | null) => {
    if (exists) filePreview?.openFilePreview(hit.resolved, anchor, { line, column });
  };

  const open = (anchor?: HTMLElement | null) => {
    if (!exists) {
      toast.info(`路径不存在: ${hit.raw}`);
      return;
    }
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
        className={`underline decoration-dotted underline-offset-2 cursor-pointer rounded px-0.5 ${
          exists
            ? "text-primary hover:bg-primary/10"
            : "text-destructive hover:bg-destructive/10"
        }`}
        title={exists ? hit.resolved : `${hit.raw} (not found)`}
      >
        {text}
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        {!exists && (
          <>
            <ContextMenuLabel className="max-w-72 text-xs text-destructive">
              Path not found
            </ContextMenuLabel>
            <ContextMenuItem disabled className="max-w-72 font-mono text-xs">
              {hit.resolved}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {isResolvedCandidate && (
          <>
            <ContextMenuLabel className="max-w-72 text-xs text-muted-foreground">
              Original path not found. Best match:
            </ContextMenuLabel>
            <ContextMenuItem disabled className="max-w-72 font-mono text-xs">
              {hit.resolved}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {exists && !hit.isDir && filePreview && (
          <ContextMenuItem onSelect={() => openInternal(triggerRef.current)}>
            Open in lovcode
          </ContextMenuItem>
        )}
        {exists ? (
          <ContextMenuItem onSelect={openExternal}>
            {hit.isDir ? "Open folder" : "Open with default app"}
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={openExternal}>Try original path</ContextMenuItem>
        )}
        {exists && <ContextMenuItem onSelect={reveal}>Reveal in Finder</ContextMenuItem>}
        {exists && !hit.isDir && (
          <ContextMenuItem onSelect={openInEditor}>Open in editor</ContextMenuItem>
        )}
        {hasCandidates && (
          <>
            <ContextMenuSeparator />
            <ContextMenuLabel className="text-xs text-muted-foreground">
              Candidate paths
            </ContextMenuLabel>
            {alternateCandidates.map((candidate) => (
              <ContextMenuItem
                key={candidate.path}
                onSelect={() => openCandidate(candidate, triggerRef.current)}
                className="max-w-96 items-start"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs">{candidate.path}</span>
                  <span className="block text-xs text-muted-foreground">
                    {candidate.source}
                    {candidate.fullMatch ? " · suffix match" : ""}
                    {candidate.exists === false ? " · not found" : ""}
                  </span>
                </span>
              </ContextMenuItem>
            ))}
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={copy}>Copy resolved path</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
