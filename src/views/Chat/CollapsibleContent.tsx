import { useState, useLayoutEffect, useRef, useMemo } from "react";
import Markdown from "react-markdown";
import { HighlightText } from "./HighlightText";

interface CollapsibleContentProps {
  content: string;
  markdown: boolean;
  defaultCollapsed?: boolean;
  highlight?: string;
  disableCollapse?: boolean;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

// Rehype plugin factory: returns a unified-style plugin that highlights `query` in text nodes
function makeRehypeHighlight(query: string) {
  // The plugin itself: returns a transformer
  return function rehypeHighlightPlugin() {
    return (tree: HastNode) => {
      const re = new RegExp(escapeRegExp(query), "gi");
      const walk = (parent: HastNode) => {
      if (!parent.children) return;
      if (parent.type === "element" && parent.tagName && ["script", "style"].includes(parent.tagName)) return;
      const next: HastNode[] = [];
      for (const child of parent.children) {
        if (child.type === "text" && typeof child.value === "string" && child.value.length > 0) {
          const value = child.value;
          re.lastIndex = 0;
          let last = 0;
          let m: RegExpExecArray | null;
          let matched = false;
          while ((m = re.exec(value)) !== null) {
            matched = true;
            if (m.index > last) next.push({ type: "text", value: value.slice(last, m.index) });
            next.push({
              type: "element",
              tagName: "mark",
              properties: { "data-search-hit": "", className: ["bg-primary/25", "text-ink", "rounded", "px-0.5"] },
              children: [{ type: "text", value: m[0] }],
            });
            last = m.index + m[0].length;
            if (m[0].length === 0) re.lastIndex++;
          }
          if (!matched) {
            next.push(child);
          } else if (last < value.length) {
            next.push({ type: "text", value: value.slice(last) });
          }
        } else {
          walk(child);
          next.push(child);
        }
      }
      parent.children = next;
      };
      walk(tree);
    };
  };
}

export function CollapsibleContent({ content, markdown, defaultCollapsed = false, highlight, disableCollapse = false }: CollapsibleContentProps) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [isOverflow, setIsOverflow] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const rehypePlugins = useMemo(() => {
    const q = highlight?.trim();
    return q ? [makeRehypeHighlight(q)] : [];
  }, [highlight]);

  useLayoutEffect(() => {
    if (disableCollapse) return;
    const el = contentRef.current;
    if (el) {
      setIsOverflow(el.scrollHeight > 40);
    }
  }, [content, markdown, disableCollapse]);

  const collapsed = !disableCollapse && !expanded;

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className={`text-ink text-sm leading-relaxed ${collapsed ? "overflow-hidden max-h-10" : ""}`}
      >
        {markdown ? (
          <div className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1">
            <Markdown rehypePlugins={rehypePlugins as never}>{content}</Markdown>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words">
            <HighlightText text={content} query={highlight} />
          </p>
        )}
      </div>
      {!disableCollapse && isOverflow && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs text-primary hover:text-primary/80"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      )}
    </div>
  );
}
