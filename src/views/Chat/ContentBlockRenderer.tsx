import { useState } from "react";
import { CollapsibleContent } from "./CollapsibleContent";
import { PathAwareText } from "./PathAwareText";
import { usePathHits } from "./usePathHits";
import type { ContentBlock } from "../../types";

interface ContentBlockRendererProps {
  blocks: ContentBlock[];
  markdown: boolean;
  highlight?: string;
  disableTextCollapse?: boolean;
  cwd?: string;
}

const TOOL_COLORS: Record<string, string> = {
  Read: "bg-blue-100 text-blue-800",
  Write: "bg-green-100 text-green-800",
  Edit: "bg-yellow-100 text-yellow-800",
  Bash: "bg-orange-100 text-orange-800",
  Grep: "bg-purple-100 text-purple-800",
  Glob: "bg-purple-100 text-purple-800",
  Task: "bg-indigo-100 text-indigo-800",
  WebFetch: "bg-cyan-100 text-cyan-800",
  WebSearch: "bg-cyan-100 text-cyan-800",
};

function ToolUseBadge({ name, summary }: { name: string; summary: string }) {
  const color = TOOL_COLORS[name] || "bg-muted text-muted-foreground";
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>
        {name}
      </span>
      {summary && (
        <span className="text-xs font-mono text-muted-foreground truncate max-w-[500px]">
          {summary}
        </span>
      )}
    </div>
  );
}

function ToolResultBlock({ content, cwd }: { content: string; cwd?: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > 200;
  const display = !expanded && isLong ? content.slice(0, 200) + "..." : content;
  const hits = usePathHits(display, cwd);

  return (
    <div className="border-l-2 border-border pl-3 py-1 my-1">
      <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words">
        <PathAwareText text={display} hits={hits} />
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-primary hover:text-primary/80 mt-0.5"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
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

export function ContentBlockRenderer({ blocks, markdown, highlight, disableTextCollapse, cwd }: ContentBlockRendererProps) {
  return (
    <div className="space-y-1">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "text":
            return <CollapsibleContent key={i} content={block.text} markdown={markdown} highlight={highlight} disableCollapse={disableTextCollapse} cwd={cwd} />;
          case "tool_use":
            return <ToolUseBadge key={i} name={block.name} summary={block.summary} />;
          case "tool_result":
            return <ToolResultBlock key={i} content={block.content} cwd={cwd} />;
          case "thinking":
            return <ThinkingBlock key={i} thinking={block.thinking} />;
        }
      })}
    </div>
  );
}
