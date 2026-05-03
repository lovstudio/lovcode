import { useMemo, useState, type MouseEvent } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FilePenLine,
  FileText,
  Globe,
  ListChecks,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { CollapsibleContent } from "./CollapsibleContent";
import { useFilePreview, type ImagePreviewItem } from "./FilePreviewContext";
import { PathAwareText } from "./PathAwareText";
import { usePathHits } from "./usePathHits";
import type { ContentBlock, ToolResultImage } from "../../types";

interface ContentBlockRendererProps {
  blocks: ContentBlock[];
  markdown: boolean;
  highlight?: string;
  disableTextCollapse?: boolean;
  cwd?: string;
  transformText?: (text: string) => string;
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
const OUTPUT_PREVIEW_LIMIT = 1200;

type ToolUseContentBlock = Extract<ContentBlock, { type: "tool_use" }>;
type ToolResultContentBlock = Extract<ContentBlock, { type: "tool_result" }>;
type PathHits = ReturnType<typeof usePathHits>;

type RenderItem =
  | { kind: "tool_invocation"; key: string; use: ToolUseContentBlock; results: ToolResultContentBlock[] }
  | { kind: "block"; key: string; block: ContentBlock };

function fileNameFromSummary(summary: string) {
  const path = summary.match(/^(.+?)(?:\s+\(|$)/)?.[1] ?? summary;
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || path;
}

function firstToken(summary: string) {
  return summary.trim().split(/\s+/)[0] || "";
}

function formatToolName(name: string) {
  if (name.startsWith("mcp__")) {
    return name.replace(/^mcp__/, "").replace(/__/g, " / ").replace(/_/g, " ");
  }
  return name;
}

function toolMeta(name: string): { action: string; Icon: LucideIcon } {
  if (name.startsWith("mcp__")) return { action: "Called MCP", Icon: Wrench };
  switch (name) {
    case "Read":
      return { action: "Read", Icon: FileText };
    case "Write":
      return { action: "Wrote", Icon: FileText };
    case "Edit":
    case "MultiEdit":
      return { action: "Edited", Icon: FilePenLine };
    case "Bash":
      return { action: "Ran", Icon: Terminal };
    case "Grep":
    case "Glob":
    case "ToolSearch":
      return { action: "Searched", Icon: Search };
    case "WebFetch":
      return { action: "Fetched", Icon: Globe };
    case "WebSearch":
      return { action: "Searched web", Icon: Globe };
    case "Skill":
      return { action: "Used skill", Icon: Sparkles };
    case "Agent":
      return { action: "Started agent", Icon: Bot };
    case "TaskCreate":
      return { action: "Created task", Icon: ListChecks };
    case "TaskUpdate":
      return { action: "Updated task", Icon: ListChecks };
    case "TaskList":
      return { action: "Listed tasks", Icon: ListChecks };
    case "TaskStop":
      return { action: "Stopped task", Icon: ListChecks };
    case "Task":
    case "TaskRead":
    case "TodoWrite":
      return { action: "Updated tasks", Icon: ListChecks };
    case "AskUserQuestion":
      return { action: "Asked user", Icon: Wrench };
    case "EnterPlanMode":
      return { action: "Entered plan mode", Icon: ListChecks };
    case "ExitPlanMode":
      return { action: "Exited plan mode", Icon: ListChecks };
    case "ScheduleWakeup":
      return { action: "Scheduled wakeup", Icon: Wrench };
    case "Monitor":
      return { action: "Started monitor", Icon: Wrench };
    default:
      return { action: "Called", Icon: Wrench };
  }
}

function toolTarget(name: string, summary: string) {
  const trimmed = summary.trim();
  if (!trimmed) return formatToolName(name);
  if (FILE_TOOLS.has(name)) return fileNameFromSummary(trimmed);
  if (name === "Skill") return firstToken(trimmed);
  return trimmed;
}

function textPreview(text: string, expanded: boolean, limit: number) {
  const trimmed = text.trim();
  if (expanded || trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}...`;
}

function collectToolResultText(results: ToolResultContentBlock[], field: "content" | "raw") {
  return results
    .map((result) => result[field]?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function collectToolResultImages(results: ToolResultContentBlock[]) {
  return results.flatMap((result) => result.images ?? []);
}

function stripImageResultPlaceholders(text: string) {
  return text
    .split("\n")
    .filter((line) => !/^\s*\[image result(?::[^\]]*)?\]\s*$/.test(line))
    .join("\n")
    .trim();
}

function toolImageSrc(image: ToolResultImage) {
  if (image.data.startsWith("data:")) return image.data;
  return `data:${image.media_type || "image/png"};base64,${image.data}`;
}

function formatByteSize(size?: number | null) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function sourcePathFromTool(summary: string, parameters: string) {
  const trimmedSummary = summary.trim();
  if (parameters.trim()) {
    try {
      const parsed = JSON.parse(parameters) as { file_path?: unknown; path?: unknown };
      const path = typeof parsed.file_path === "string" ? parsed.file_path : parsed.path;
      if (typeof path === "string" && path.trim()) return path;
    } catch {
      // Fall back to the human summary below.
    }
  }
  return trimmedSummary.match(/^(.+?)(?:\s+\(|$)/)?.[1] ?? trimmedSummary;
}

function ToolImagePreviews({
  images,
  sourcePath,
}: {
  images: ToolResultImage[];
  sourcePath?: string;
}) {
  const filePreview = useFilePreview();
  if (images.length === 0) return null;

  const previewItems: ImagePreviewItem[] = images.map((image, index) => ({
    src: toolImageSrc(image),
    title: sourcePath || `Tool result image ${index + 1}`,
    mediaType: image.media_type,
    size: image.original_size,
    sourcePath,
  }));
  const openPreview = (index: number, anchor: HTMLElement) => {
    filePreview?.openImagePreview(previewItems, anchor, {
      index,
      title: "Tool result images",
    });
  };
  const handlePreviewClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof HTMLElement ? event.target : null;
    const imageButton = target?.closest<HTMLElement>("[data-tool-image-index]");
    const nextIndex =
      imageButton && event.currentTarget.contains(imageButton)
        ? Number(imageButton.dataset.toolImageIndex)
        : 0;
    openPreview(Number.isFinite(nextIndex) ? nextIndex : 0, event.currentTarget);
  };

  return (
    <div
      className="flex flex-wrap gap-2"
      onClickCapture={handlePreviewClick}
      onPointerDownCapture={(event) => event.stopPropagation()}
      title="Open image preview"
    >
      {images.map((image, index) => {
        const sizeLabel = formatByteSize(image.original_size);
        return (
          <button
            key={`${image.media_type}-${index}`}
            type="button"
            data-tool-image-index={index}
            className="group w-28 overflow-hidden rounded-lg border border-border bg-card p-1 text-left transition-colors hover:border-primary/60 hover:bg-card-alt"
            title="Open image preview"
          >
            <img
              src={toolImageSrc(image)}
              alt={`Tool result image ${index + 1}`}
              className="h-20 w-full rounded-md bg-card object-cover"
              loading="lazy"
            />
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground group-hover:text-foreground">
              {[image.media_type?.replace(/^image\//, ""), sizeLabel].filter(Boolean).join(" · ") || `Image ${index + 1}`}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function buildRenderItems(blocks: ContentBlock[]) {
  const items: RenderItem[] = [];
  const invocationsById = new Map<string, Extract<RenderItem, { kind: "tool_invocation" }>>();

  blocks.forEach((block, index) => {
    if (block.type === "tool_use") {
      const item: Extract<RenderItem, { kind: "tool_invocation" }> = {
        kind: "tool_invocation",
        key: `tool-${block.id || index}`,
        use: block,
        results: [],
      };
      items.push(item);
      if (block.id) invocationsById.set(block.id, item);
      return;
    }

    if (block.type === "tool_result") {
      const invocation = invocationsById.get(block.tool_use_id);
      if (invocation) {
        invocation.results.push(block);
        return;
      }
    }

    items.push({ kind: "block", key: `block-${index}`, block });
  });

  return items;
}

function DetailSection({
  title,
  text,
  hits,
  highlight,
  maxHeight = "max-h-80",
}: {
  title: string;
  text: string;
  hits: PathHits;
  highlight?: string;
  maxHeight?: string;
}) {
  if (!text.trim()) return null;

  return (
    <section className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">{title}</div>
      <pre className={`${maxHeight} overflow-auto rounded-lg border border-border bg-card px-2.5 py-2 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground`}>
        <PathAwareText text={text} hits={hits} highlight={highlight} />
      </pre>
    </section>
  );
}

function ToolInvocationCard({
  use,
  results,
  highlight,
  cwd,
}: {
  use: ToolUseContentBlock;
  results: ToolResultContentBlock[];
  highlight?: string;
  cwd?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);
  const { action, Icon } = toolMeta(use.name);
  const target = toolTarget(use.name, use.summary);
  const summary = use.summary.trim();
  const parameters = use.input?.trim() ?? "";
  const imageSourcePath = sourcePathFromTool(summary, parameters);
  const output = collectToolResultText(results, "content");
  const raw = collectToolResultText(results, "raw");
  const images = collectToolResultImages(results);
  const outputText = images.length > 0 ? stripImageResultPlaceholders(output || raw) : output || raw;
  const hasOutput = outputText.length > 0 || images.length > 0;
  const showSummary = !!summary && summary !== target && summary !== parameters;
  const showRaw = !!raw && raw !== outputText;
  const outputIsLong = outputText.length > OUTPUT_PREVIEW_LIMIT;
  const outputDisplay = textPreview(outputText, outputExpanded, OUTPUT_PREVIEW_LIMIT);
  const summaryHits = usePathHits(expanded && showSummary ? summary : "", cwd);
  const parameterHits = usePathHits(expanded ? parameters : "", cwd);
  const outputHits = usePathHits(expanded ? outputDisplay : "", cwd);
  const rawHits = usePathHits(expanded && rawExpanded ? raw : "", cwd);
  const containerClass = expanded
    ? "my-1 overflow-hidden rounded-lg border border-border bg-card-alt/70"
    : "my-0.5 overflow-hidden rounded-lg border border-transparent bg-transparent transition-colors hover:border-border/60 hover:bg-card-alt/40";

  return (
    <div className={containerClass}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`flex w-full min-w-0 items-center gap-1.5 text-left hover:bg-card-alt/60 ${
          expanded ? "px-3 py-2" : "px-1.5 py-1"
        }`}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-[11px] font-medium leading-5 text-muted-foreground">{action}</span>
          <span className="min-w-0 flex-1">
            {target && (
              <span className="block truncate font-mono text-[13px] leading-5 text-foreground" title={summary || target}>
                {target}
              </span>
            )}
          </span>
        </div>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2">
          {showSummary && (
            <DetailSection title="Description" text={summary} hits={summaryHits} highlight={highlight} />
          )}
          {parameters && (
            <DetailSection title="Parameters" text={parameters} hits={parameterHits} highlight={highlight} />
          )}
          {hasOutput && (
            <section className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-medium text-muted-foreground">Output</div>
                {outputIsLong && (
                  <button
                    type="button"
                    onClick={() => setOutputExpanded(!outputExpanded)}
                    className="text-[11px] text-primary hover:text-primary/80"
                  >
                    {outputExpanded ? "Collapse" : "Expand"}
                  </button>
                )}
              </div>
              <ToolImagePreviews images={images} sourcePath={imageSourcePath} />
              {outputText && (
                <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-card px-2.5 py-2 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                  <PathAwareText text={outputDisplay} hits={outputHits} highlight={highlight} />
                </pre>
              )}
            </section>
          )}
          {showRaw && (
            <section className="space-y-1">
              <button
                type="button"
                onClick={() => setRawExpanded(!rawExpanded)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:text-primary/80"
              >
                {rawExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Raw details
              </button>
              {rawExpanded && (
                <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-card px-2.5 py-2 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                  <PathAwareText text={raw} hits={rawHits} highlight={highlight} />
                </pre>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ToolResultCard({
  result,
  highlight,
  cwd,
}: {
  result: ToolResultContentBlock;
  highlight?: string;
  cwd?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);
  const output = result.content.trim();
  const raw = result.raw?.trim() ?? "";
  const images = result.images ?? [];
  const outputText = images.length > 0 ? stripImageResultPlaceholders(output || raw) : output || raw;
  const hasOutput = outputText.length > 0 || images.length > 0;
  const showRaw = !!raw && raw !== outputText;
  const outputIsLong = outputText.length > OUTPUT_PREVIEW_LIMIT;
  const outputDisplay = textPreview(outputText, outputExpanded, OUTPUT_PREVIEW_LIMIT);
  const outputHits = usePathHits(expanded ? outputDisplay : "", cwd);
  const rawHits = usePathHits(expanded && rawExpanded ? raw : "", cwd);
  const containerClass = expanded
    ? "my-1 overflow-hidden rounded-lg border border-border bg-card-alt/70"
    : "my-0.5 overflow-hidden rounded-lg border border-transparent bg-transparent transition-colors hover:border-border/60 hover:bg-card-alt/40";

  if (!hasOutput) return null;

  return (
    <div className={containerClass}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`flex w-full min-w-0 items-center gap-1.5 text-left hover:bg-card-alt/60 ${
          expanded ? "px-3 py-2" : "px-1.5 py-1"
        }`}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Wrench className="h-3.5 w-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-[11px] font-medium leading-5 text-muted-foreground">Tool output</span>
          <span className="block min-w-0 flex-1 truncate font-mono text-[13px] leading-5 text-foreground">
            {result.tool_use_id}
          </span>
        </div>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2">
          <section className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-medium text-muted-foreground">Output</div>
              {outputIsLong && (
                <button
                  type="button"
                  onClick={() => setOutputExpanded(!outputExpanded)}
                  className="text-[11px] text-primary hover:text-primary/80"
                >
                  {outputExpanded ? "Collapse" : "Expand"}
                </button>
              )}
            </div>
            <ToolImagePreviews images={images} />
            {outputText && (
              <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-card px-2.5 py-2 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                <PathAwareText text={outputDisplay} hits={outputHits} highlight={highlight} />
              </pre>
            )}
          </section>
          {showRaw && (
            <section className="space-y-1">
              <button
                type="button"
                onClick={() => setRawExpanded(!rawExpanded)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:text-primary/80"
              >
                {rawExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Raw details
              </button>
              {rawExpanded && (
                <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-card px-2.5 py-2 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                  <PathAwareText text={raw} hits={rawHits} highlight={highlight} />
                </pre>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-muted-foreground hover:text-foreground italic"
      >
        {expanded ? "Hide thinking..." : "Thinking..."}
      </button>
      {expanded && (
        <div className="border-l-2 border-border/50 pl-3 mt-1">
          <p className="text-xs text-muted-foreground italic whitespace-pre-wrap break-words">
            {thinking}
          </p>
        </div>
      )}
    </div>
  );
}

export function ContentBlockRenderer({ blocks, markdown, highlight, disableTextCollapse, cwd, transformText }: ContentBlockRendererProps) {
  const items = useMemo(() => buildRenderItems(blocks), [blocks]);

  return (
    <div className="space-y-1">
      {items.map((item) => {
        if (item.kind === "tool_invocation") {
          return (
            <ToolInvocationCard
              key={item.key}
              use={item.use}
              results={item.results}
              highlight={highlight}
              cwd={cwd}
            />
          );
        }

        const { block } = item;
        switch (block.type) {
          case "text":
            return <CollapsibleContent key={item.key} content={transformText ? transformText(block.text) : block.text} markdown={markdown} highlight={highlight} disableCollapse={disableTextCollapse} cwd={cwd} />;
          case "tool_use":
            return (
              <ToolInvocationCard
                key={item.key}
                use={block}
                results={[]}
                highlight={highlight}
                cwd={cwd}
              />
            );
          case "tool_result":
            return <ToolResultCard key={item.key} result={block} highlight={highlight} cwd={cwd} />;
          case "thinking":
            return <ThinkingBlock key={item.key} thinking={block.thinking} />;
        }
      })}
    </div>
  );
}
