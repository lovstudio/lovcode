import { useMemo, type HTMLAttributes, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { convertFileSrc } from "@tauri-apps/api/core";
import { PathLink } from "../views/Chat/PathLink";
import { makeRehypePaths } from "../views/Chat/markdownPathPlugins";
import { usePathHits } from "../views/Chat/usePathHits";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  cwd?: string;
  smartPaths?: boolean;
}

function convertImageSrc(src: string | undefined): string {
  if (!src) return "";
  // Local file path (absolute path starting with /)
  if (src.startsWith("/")) {
    return convertFileSrc(src);
  }
  return src;
}

function normalizeLocalHref(href: string): string | null {
  if (href.startsWith("#") || href.startsWith("?")) return null;
  if (href.startsWith("file://")) {
    const path = href.slice(7);
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null;

  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function childrenText(children: ReactNode, fallback: string): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    const text = children.map((child) => childrenText(child, "")).join("");
    return text || fallback;
  }
  return fallback;
}

export function MarkdownRenderer({
  content,
  className = "max-w-4xl",
  cwd,
  smartPaths = true,
}: MarkdownRendererProps) {
  const pathHits = usePathHits(smartPaths ? content : "", cwd, smartPaths, smartPaths);
  const rehypePlugins = useMemo(() => {
    const plugins: unknown[] = [rehypeRaw];
    if (smartPaths && pathHits.size > 0) plugins.push(makeRehypePaths(pathHits));
    return plugins;
  }, [pathHits, smartPaths]);

  return (
    <article
      className={`prose prose-warm mx-auto prose-table:w-full prose-table:border-collapse prose-table:text-sm prose-th:border prose-th:border-border prose-th:bg-card-alt prose-th:px-3 prose-th:py-2 prose-th:text-left prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 prose-tr:even:bg-card-alt/30 ${className}`}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins as never}
        components={{
          span: ({ node: _node, children, ...rest }) => {
            const props = rest as HTMLAttributes<HTMLSpanElement> & { "data-path-link"?: string };
            const raw = props["data-path-link"];
            if (smartPaths && typeof raw === "string") {
              const hit = pathHits.get(raw);
              if (hit) return <PathLink text={raw} hit={hit} cwd={cwd} />;
            }
            return <span {...props}>{children}</span>;
          },
          a: ({ node: _node, href, children, ...props }) => {
            if (smartPaths && href) {
              const raw = normalizeLocalHref(href);
              const hit = raw ? pathHits.get(raw) : undefined;
              if (raw && hit) {
                return <PathLink text={childrenText(children, raw)} hit={hit} cwd={cwd} />;
              }
            }
            return <a href={href} {...props}>{children}</a>;
          },
          img: ({ node: _node, src, alt, ...props }) => (
            <img src={convertImageSrc(src)} alt={alt} {...props} />
          ),
          table: ({ node: _node, ...props }) => (
            <div className="my-4 overflow-x-auto rounded-lg border border-border">
              <table {...props} />
            </div>
          ),
        }}
      >
        {content}
      </Markdown>
    </article>
  );
}
