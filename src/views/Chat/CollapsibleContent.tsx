import { useState, useLayoutEffect, useRef, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "../../components/ui/toast";
import { warmAcademicTheme } from "../../lib/codeTheme";
import { PathLink } from "./PathLink";
import { PathAwareText } from "./PathAwareText";
import { usePathHits } from "./usePathHits";
import type { PathHit } from "./pathDetection";

interface CollapsibleContentProps {
  content: string;
  markdown: boolean;
  defaultCollapsed?: boolean;
  highlight?: string;
  disableCollapse?: boolean;
  cwd?: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

// Rehype plugin factory: replaces detected path strings inside text nodes with a custom
// `path-link` element. The element carries the raw match in data-path; rendering goes through
// react-markdown's `components` map so the resolved hit is looked up at render time.
function makeRehypePaths(hits: Map<string, PathHit>) {
  return function rehypePathsPlugin() {
    return (tree: HastNode) => {
      if (hits.size === 0) return;
      // Build a sorted list of unique raw strings, longest first to avoid prefix collisions.
      const rawList = Array.from(hits.keys()).sort((a, b) => b.length - a.length);
      const escaped = rawList.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const re = new RegExp(`(?:^|(?<=[\\s\`'"(\\[<「『“‘《]))(${escaped.join("|")})(?=$|[\\s\`'"<>)\\]」』”’》,.;:!?]|$)`, "g");

      const walk = (parent: HastNode) => {
        if (!parent.children) return;
        if (parent.type === "element" && parent.tagName && ["script", "style", "pre", "a"].includes(parent.tagName)) return;
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
              const raw = m[1];
              if (m.index > last) next.push({ type: "text", value: value.slice(last, m.index) });
              next.push({
                type: "element",
                tagName: "span",
                properties: { "data-path-link": raw },
                children: [{ type: "text", value: raw }],
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

export function CollapsibleContent({ content, markdown, defaultCollapsed = false, highlight, disableCollapse = false, cwd }: CollapsibleContentProps) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [isOverflow, setIsOverflow] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const pathHits = usePathHits(content, cwd, markdown);

  const rehypePlugins = useMemo(() => {
    const plugins: unknown[] = [];
    if (pathHits.size > 0) plugins.push(makeRehypePaths(pathHits));
    const q = highlight?.trim();
    if (q) plugins.push(makeRehypeHighlight(q));
    return plugins;
  }, [highlight, pathHits]);

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
          <div className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-pre:my-0 prose-pre:bg-transparent prose-pre:p-0 prose-pre:text-ink prose-ul:my-1 prose-ol:my-1 prose-table:my-0 prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-th:border prose-td:border prose-th:border-border prose-td:border-border prose-table:border-collapse prose-code:before:hidden prose-code:after:hidden">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={rehypePlugins as never}
              components={{
                span: ({ node: _node, children, ...rest }) => {
                  const props = rest as React.HTMLAttributes<HTMLSpanElement> & { "data-path-link"?: string };
                  const raw = props["data-path-link"];
                  if (typeof raw === "string") {
                    const hit = pathHits.get(raw);
                    if (hit) return <PathLink text={raw} hit={hit} />;
                  }
                  return <span {...props}>{children}</span>;
                },
                a: ({ node: _node, href, children, ...props }) => {
                  // Local path link → route through smart PathLink (existence-checked, context menu).
                  if (href) {
                    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
                    const isFragment = href.startsWith("#") || href.startsWith("?");
                    const isFileUrl = href.startsWith("file://");
                    if (isFileUrl || (!hasScheme && !isFragment)) {
                      let key = isFileUrl ? href.slice(7) : href;
                      try { key = decodeURIComponent(key); } catch { /* keep raw */ }
                      const hit = pathHits.get(key);
                      if (hit) {
                        return <PathLink text={typeof children === "string" ? children : (Array.isArray(children) ? children.join("") : key)} hit={hit} />;
                      }
                    }
                  }
                  // Fallback: external URL (or unresolved local path) → open via system.
                  return (
                    <a
                      {...props}
                      href={href}
                      onClick={(e) => {
                        e.preventDefault();
                        if (!href) return;
                        const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
                        const isFragment = href.startsWith("#") || href.startsWith("?");
                        const isFileUrl = href.startsWith("file://");
                        const isLocalPath = isFileUrl || (!hasScheme && !isFragment);
                        if (isLocalPath) {
                          let path = isFileUrl ? href.slice(7) : href;
                          try { path = decodeURIComponent(path); } catch { /* keep raw */ }
                          invoke("open_path", { path, cwd }).catch((err) => {
                            const msg = typeof err === "string" ? err : err instanceof Error ? err.message : JSON.stringify(err);
                            toast.error(`打开失败: ${msg}`);
                          });
                        } else {
                          openUrl(href).catch((err) => {
                            const msg = typeof err === "string" ? err : err instanceof Error ? err.message : JSON.stringify(err);
                            toast.error(`打开链接失败: ${msg}`);
                          });
                        }
                      }}
                      className="text-primary underline underline-offset-2 hover:text-primary/80 cursor-pointer"
                    >
                      {children}
                    </a>
                  );
                },
                table: ({ node: _node, ...props }) => (
                  <div className="my-2 overflow-x-auto">
                    <table {...props} />
                  </div>
                ),
                code: ({ node: _node, inline, className, children, ...props }: { node?: unknown; inline?: boolean; className?: string; children?: React.ReactNode }) => {
                  const match = /language-(\w+)/.exec(className || "");
                  if (!inline && match) {
                    return (
                      <div className="my-2 rounded-md overflow-hidden">
                        <SyntaxHighlighter
                          style={warmAcademicTheme}
                          language={match[1]}
                          PreTag="div"
                          customStyle={{ margin: 0, borderRadius: "0.375rem", padding: "0.75rem 1rem", background: "#F0EEE6" }}
                        >
                          {String(children).replace(/\n$/, "")}
                        </SyntaxHighlighter>
                      </div>
                    );
                  }
                  return (
                    <code className={`${className || ""} px-1 py-0.5 rounded bg-card-alt text-ink/90 font-mono text-[0.85em]`} {...props}>
                      {children}
                    </code>
                  );
                },
              }}
            >
              {content}
            </Markdown>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words">
            <PathAwareText text={content} hits={pathHits} highlight={highlight} />
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
