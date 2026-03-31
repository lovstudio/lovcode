import { useState, useLayoutEffect, useRef } from "react";
import Markdown from "react-markdown";

interface CollapsibleContentProps {
  content: string;
  markdown: boolean;
}

export function CollapsibleContent({ content, markdown }: CollapsibleContentProps) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflow, setIsOverflow] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (el) {
      setIsOverflow(el.scrollHeight > 40);
    }
  }, [content, markdown]);

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className={`text-ink text-sm leading-relaxed overflow-hidden ${
          !expanded ? "max-h-10" : ""
        }`}
      >
        {markdown ? (
          <div className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1">
            <Markdown>{content}</Markdown>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words">{content}</p>
        )}
      </div>
      {isOverflow && (
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
