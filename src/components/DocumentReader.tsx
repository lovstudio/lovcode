import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAtom } from "jotai";
import { docReaderCollapsedGroupsAtom } from "../store";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { warmAcademicTheme } from "../lib/codeTheme";
// Lucide icons (no Radix equivalent)
import { PanelLeftClose, PanelLeft, PanelRightClose, PanelRight, Maximize2, Minimize2 } from "lucide-react";
// Radix icons
import { ChevronLeftIcon, ChevronDownIcon, CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import { startCase } from "lodash-es";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// ============================================================================
// Types
// ============================================================================

export interface DocumentItem {
  name: string;
  path: string;
  group?: string | null;
}

interface DocumentReaderProps {
  documents: DocumentItem[];
  currentIndex: number;
  content: string;
  loading: boolean;
  sourceName: string;
  onNavigate: (index: number) => void;
  onBack: () => void;
}

interface HeadingItem {
  id: string;
  text: string;
  level: number;
}

// ============================================================================
// Extract Headings from Markdown
// ============================================================================

function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")  // bold
    .replace(/\*(.+?)\*/g, "$1")       // italic
    .replace(/__(.+?)__/g, "$1")       // bold
    .replace(/_(.+?)_/g, "$1")         // italic
    .replace(/~~(.+?)~~/g, "$1")       // strikethrough
    .replace(/`(.+?)`/g, "$1")         // inline code
    .replace(/\[(.+?)\]\(.+?\)/g, "$1") // links
    .trim();
}

function extractHeadings(markdown: string): HeadingItem[] {
  const headings: HeadingItem[] = [];
  const lines = markdown.split("\n");
  let inCodeBlock = false;
  const slugCounts = new Map<string, number>();

  lines.forEach((line) => {
    // Track code blocks
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) return;

    // Match markdown headings
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const rawText = match[2].trim();
      const text = stripMarkdownFormatting(rawText);
      const baseSlug = slugify(text);

      // Handle duplicate slugs
      const count = slugCounts.get(baseSlug) || 0;
      slugCounts.set(baseSlug, count + 1);
      const id = count > 0 ? `${baseSlug}-${count}` : baseSlug;

      headings.push({ id, text, level });
    }
  });

  return headings;
}

// ============================================================================
// Reading Progress Hook
// ============================================================================

function useReadingProgress(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateProgress = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const maxScroll = scrollHeight - clientHeight;
      const currentProgress = maxScroll > 0 ? (scrollTop / maxScroll) * 100 : 0;
      setProgress(Math.min(100, Math.max(0, currentProgress)));
    };

    container.addEventListener("scroll", updateProgress);
    updateProgress();
    return () => container.removeEventListener("scroll", updateProgress);
  }, [containerRef]);

  return progress;
}

// ============================================================================
// Keyboard Navigation Hook
// ============================================================================

function useKeyboardNavigation(
  onPrev: () => void,
  onNext: () => void,
  onBack: () => void,
  onToggleLeftPanel: () => void,
  onToggleRightPanel: () => void
) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case "ArrowLeft":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            onPrev();
          }
          break;
        case "ArrowRight":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            onNext();
          }
          break;
        case "Escape":
          e.preventDefault();
          onBack();
          break;
        case "[":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            onToggleLeftPanel();
          }
          break;
        case "]":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            onToggleRightPanel();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onPrev, onNext, onBack, onToggleLeftPanel, onToggleRightPanel]);
}

// ============================================================================
// Progress Bar Component
// ============================================================================

function ReadingProgressBar({ progress }: { progress: number }) {
  return (
    <div className="absolute top-0 left-0 right-0 h-0.5 bg-border z-10 overflow-hidden">
      <div
        className="h-full w-full bg-primary/60 origin-left"
        style={{ transform: `scaleX(${progress / 100})` }}
      />
    </div>
  );
}


// ============================================================================
// Left Sidebar - Document List
// ============================================================================

function DocumentListSidebar({
  documents,
  currentIndex,
  sourceName,
  onSelect,
  onBack,
  isOpen,
  onToggle,
}: {
  documents: DocumentItem[];
  currentIndex: number;
  sourceName: string;
  onSelect: (index: number) => void;
  onBack: () => void;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const [allCollapsed, setAllCollapsed] = useAtom(docReaderCollapsedGroupsAtom);
  const collapsedGroups = useMemo(() => new Set(allCollapsed[sourceName] ?? []), [allCollapsed, sourceName]);
  const setCollapsedGroups = useCallback((updater: (prev: Set<string>) => Set<string>) => {
    setAllCollapsed(prev => ({
      ...prev,
      [sourceName]: Array.from(updater(new Set(prev[sourceName] ?? [])))
    }));
  }, [sourceName, setAllCollapsed]);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen && activeRef.current) {
      activeRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [isOpen, currentIndex]);

  const grouped = useMemo(() => {
    const groups: { name: string | null; docs: { doc: DocumentItem; index: number }[] }[] = [];
    let currentGroup: string | null = null;
    let currentDocs: { doc: DocumentItem; index: number }[] = [];

    documents.forEach((doc, index) => {
      if (doc.group !== currentGroup) {
        if (currentDocs.length > 0) {
          groups.push({ name: currentGroup, docs: currentDocs });
        }
        currentGroup = doc.group ?? null;
        currentDocs = [];
      }
      currentDocs.push({ doc, index });
    });

    if (currentDocs.length > 0) {
      groups.push({ name: currentGroup, docs: currentDocs });
    }

    return groups;
  }, [documents]);

  const toggleGroup = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  };

  return (
    <aside
      className={`shrink-0 border-r border-border bg-background flex flex-col transition-all duration-200 overflow-hidden ${
        isOpen ? "w-64" : "w-0"
      }`}
    >
      {/* Header */}
      <div className="shrink-0 border-b border-border px-3 py-3 flex items-center gap-2">
        <button
          onClick={onBack}
          className="shrink-0 p-1.5 rounded-lg hover:bg-card-alt transition-colors"
          title="Back (Esc)"
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="font-serif font-semibold text-sm truncate">{startCase(sourceName)}</h3>
          <p className="text-xs text-muted-foreground">{documents.length} docs</p>
        </div>
        <button
          onClick={onToggle}
          className="shrink-0 p-1.5 rounded-lg hover:bg-card-alt transition-colors"
          title="Hide sidebar (⌘[)"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* Document list */}
      <div className="flex-1 min-h-0 overflow-y-auto py-2">
        {grouped.map((group, groupIdx) => (
          <div key={group.name ?? `ungrouped-${groupIdx}`}>
            {group.name && (
              <button
                onClick={() => toggleGroup(group.name!)}
                className="w-full flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground hover:text-ink transition-colors"
              >
                <ChevronDownIcon
                  className={`w-3 h-3 transition-transform ${
                    collapsedGroups.has(group.name) ? "-rotate-90" : ""
                  }`}
                />
                <span className="font-medium truncate">{group.name}</span>
                <span className="text-muted-foreground/60">({group.docs.length})</span>
              </button>
            )}
            {!collapsedGroups.has(group.name ?? "") && (
              <div className={group.name ? "ml-2" : ""}>
                {group.docs.map(({ doc, index }) => {
                  const isActive = index === currentIndex;
                  return (
                    <button
                      key={doc.path}
                      ref={isActive ? activeRef : null}
                      onClick={() => onSelect(index)}
                      className={`w-full flex items-center gap-2 px-4 py-1.5 text-left text-sm transition-colors ${
                        isActive
                          ? "bg-primary/10 text-primary border-l-2 border-primary"
                          : "hover:bg-card-alt text-ink"
                      }`}
                    >
                      <span className="truncate">{startCase(doc.name.replace(/\.[^.]+$/, ""))}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

// ============================================================================
// Right Sidebar - In-Document Headings
// ============================================================================

function HeadingsSidebar({
  headings,
  activeHeading,
  onHeadingClick,
  isOpen,
  onToggle,
}: {
  headings: HeadingItem[];
  activeHeading: string | null;
  onHeadingClick: (id: string) => void;
  isOpen: boolean;
  onToggle: () => void;
}) {
  if (headings.length === 0) {
    return null;
  }

  return (
    <aside
      className={`shrink-0 border-l border-border bg-background flex flex-col transition-all duration-200 overflow-hidden ${
        isOpen ? "w-56" : "w-0"
      }`}
    >
      {/* Header */}
      <div className="shrink-0 border-b border-border px-4 py-3 flex items-center justify-between gap-2">
        <h3 className="font-serif font-semibold text-sm">On This Page</h3>
        <button
          onClick={onToggle}
          className="shrink-0 p-1.5 rounded-lg hover:bg-card-alt transition-colors"
          title="Hide outline (⌘])"
        >
          <PanelRightClose className="w-4 h-4" />
        </button>
      </div>

      {/* Headings list */}
      <nav className="flex-1 min-h-0 overflow-y-auto py-2">
        {headings.map((heading) => (
          <button
            key={heading.id}
            onClick={() => onHeadingClick(heading.id)}
            className={`w-full text-left px-4 py-1 text-sm transition-colors hover:text-primary ${
              activeHeading === heading.id
                ? "text-primary border-l-2 border-primary bg-primary/5"
                : "text-muted-foreground"
            }`}
            style={{ paddingLeft: `${(heading.level - 1) * 12 + 16}px` }}
          >
            <span className="line-clamp-1">{heading.text}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

// ============================================================================
// Code Block Component
// ============================================================================

function CodeBlock({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1] : "";
  const codeString = String(children).replace(/\n$/, "");

  const handleCopy = async () => {
    await navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Inline code
  if (!match) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  // Code block
  return (
    <div className="relative group not-prose my-4 border border-border rounded-xl overflow-hidden bg-[#F0EEE6]">
      {/* Header with language and copy button */}
      <div className="flex items-center justify-between px-4 py-2 bg-card-alt border-b border-border">
        <span className="text-xs text-muted-foreground font-mono">{language || "text"}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-primary rounded transition-colors"
        >
          {copied ? (
            <>
              <CheckIcon className="w-3.5 h-3.5 text-primary" />
              <span className="text-primary">Copied!</span>
            </>
          ) : (
            <>
              <CopyIcon className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      {/* Code content */}
      <SyntaxHighlighter
        style={warmAcademicTheme}
        language={language}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: 0,
          padding: "1rem 1.25rem",
          background: "#F0EEE6",
        }}
      >
        {codeString}
      </SyntaxHighlighter>
    </div>
  );
}

// ============================================================================
// Book Cover Component
// ============================================================================

function BookCover({
  title,
  subtitle,
  documentCount,
}: {
  title: string;
  subtitle?: string;
  documentCount: number;
}) {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center text-center py-16 mb-12">
      {/* Decorative top line */}
      <div className="w-24 h-0.5 bg-primary/40 mb-12" />

      {/* Main title */}
      <h1 className="font-serif text-4xl md:text-5xl font-bold text-ink leading-tight max-w-2xl">
        {title}
      </h1>

      {/* Subtitle */}
      {subtitle && (
        <p className="mt-4 text-lg text-muted-foreground max-w-xl">
          {subtitle}
        </p>
      )}

      {/* Document count badge */}
      <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
        <span className="w-8 h-px bg-border" />
        <span>{documentCount} documents</span>
        <span className="w-8 h-px bg-border" />
      </div>

      {/* Decorative bottom element */}
      <div className="mt-12 w-16 h-16 rounded-full border-2 border-primary/20 flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border border-primary/40 flex items-center justify-center">
          <ChevronDownIcon className="w-4 h-4 text-primary/60 animate-bounce" />
        </div>
      </div>

      {/* Hint text */}
      <p className="mt-6 text-xs text-muted-foreground/60">
        Scroll down to start reading
      </p>
    </div>
  );
}

// ============================================================================
// Document Content Component
// ============================================================================

function DocumentContent({
  content,
  loading,
  headings,
  onHeadingRender,
}: {
  content: string;
  loading: boolean;
  headings: HeadingItem[];
  onHeadingRender: (id: string, element: HTMLElement | null) => void;
}) {
  // Create a map from heading text to ID for matching
  const headingIdMap = useMemo(() => {
    const map = new Map<string, string[]>();
    headings.forEach((h) => {
      const existing = map.get(h.text) || [];
      existing.push(h.id);
      map.set(h.text, existing);
    });
    return map;
  }, [headings]);

  // Track which headings have been used (for duplicates)
  const usedHeadingsRef = useRef(new Map<string, number>());

  // Reset on content change
  useEffect(() => {
    usedHeadingsRef.current.clear();
  }, [content]);

  const getHeadingId = useCallback((text: string): string => {
    const ids = headingIdMap.get(text);
    if (!ids || ids.length === 0) {
      return slugify(text);
    }
    const usedCount = usedHeadingsRef.current.get(text) || 0;
    usedHeadingsRef.current.set(text, usedCount + 1);
    return ids[usedCount] || ids[0];
  }, [headingIdMap]);

  const getTextFromChildren = (children: React.ReactNode): string => {
    if (typeof children === "string") return children;
    if (typeof children === "number") return String(children);
    if (Array.isArray(children)) return children.map(getTextFromChildren).join("");
    if (children && typeof children === "object" && "props" in children) {
      const el = children as React.ReactElement<{ children?: React.ReactNode }>;
      return getTextFromChildren(el.props.children);
    }
    return "";
  };

  const components = useMemo(() => {
    const createHeading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
      return function HeadingComponent({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
        const text = getTextFromChildren(children);
        const idRef = useRef<string | null>(null);

        // Only compute ID once per component instance
        if (idRef.current === null) {
          idRef.current = getHeadingId(text);
        }
        const id = idRef.current;

        return (
          <Tag
            {...props}
            id={id}
            ref={(el) => onHeadingRender(id, el)}
          >
            {children}
          </Tag>
        );
      };
    };

    return {
      h1: createHeading("h1"),
      h2: createHeading("h2"),
      h3: createHeading("h3"),
      h4: createHeading("h4"),
      h5: createHeading("h5"),
      h6: createHeading("h6"),
      code: CodeBlock,
      // Strip default pre styling - CodeBlock handles it
      pre: ({ children }: React.HTMLAttributes<HTMLPreElement>) => <>{children}</>,
    };
  }, [getHeadingId, onHeadingRender]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <article className="max-w-3xl mx-auto animate-fade-in">
      {/* Content */}
      <div
        className="prose prose-lg max-w-none
          prose-headings:font-serif prose-headings:text-ink prose-headings:font-semibold prose-headings:scroll-mt-8
          prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg
          prose-p:text-ink prose-p:leading-relaxed prose-p:my-4
          prose-a:text-primary prose-a:no-underline hover:prose-a:underline
          prose-strong:text-ink prose-strong:font-semibold
          prose-code:text-primary prose-code:bg-card-alt prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:before:content-[''] prose-code:after:content-['']
          prose-blockquote:border-l-primary prose-blockquote:bg-card-alt/50 prose-blockquote:py-1 prose-blockquote:rounded-r-lg prose-blockquote:not-italic
          prose-ul:my-4 prose-ol:my-4 prose-li:my-1
          prose-hr:border-border
          prose-img:rounded-xl prose-img:shadow-md
          prose-table:w-full prose-table:border-collapse prose-table:border prose-table:border-border prose-table:rounded-lg prose-table:overflow-hidden prose-table:text-sm
          prose-thead:bg-card-alt
          prose-th:px-4 prose-th:py-2.5 prose-th:text-left prose-th:font-semibold prose-th:border-b prose-th:border-border
          prose-td:px-4 prose-td:py-2.5 prose-td:border-b prose-td:border-border
          prose-tr:even:bg-card-alt/30"
      >
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </Markdown>
      </div>
    </article>
  );
}

// ============================================================================
// Main DocumentReader Component
// ============================================================================

export function DocumentReader({
  documents,
  currentIndex,
  content,
  loading,
  sourceName,
  onNavigate,
  onBack,
}: DocumentReaderProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const headingRefs = useRef<Map<string, HTMLElement>>(new Map());

  const progress = useReadingProgress(scrollContainerRef);
  const headings = useMemo(() => extractHeadings(content), [content]);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < documents.length - 1;

  // Track if scroll has been restored for current document
  const scrollRestoredRef = useRef(false);

  // Reset restore flag when document changes
  useEffect(() => {
    scrollRestoredRef.current = false;
  }, [sourceName, currentIndex]);

  // Restore scroll position after content loads
  useEffect(() => {
    // Wait for content to be loaded
    if (loading || !content || scrollRestoredRef.current) return;

    const scrollKey = `lovcode:ref-scroll:${sourceName}:${currentIndex}`;
    const savedScroll = localStorage.getItem(scrollKey);
    if (!savedScroll) {
      scrollRestoredRef.current = true;
      return;
    }

    const targetScroll = parseInt(savedScroll, 10);
    scrollRestoredRef.current = true;

    // Wait for Markdown to render, then restore scroll
    const timer = setTimeout(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = targetScroll;
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [loading, content, sourceName, currentIndex]);

  // Save scroll position periodically (only after restore completes)
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const saveScroll = () => {
      // Don't save until restore is complete, to avoid overwriting saved position with 0
      if (!scrollRestoredRef.current) return;
      const scrollKey = `lovcode:ref-scroll:${sourceName}:${currentIndex}`;
      localStorage.setItem(scrollKey, String(container.scrollTop));
    };

    // Save before app reload (Cmd+R)
    const handleBeforeReload = () => saveScroll();
    window.addEventListener("app:before-reload", handleBeforeReload);

    // Save before page unload
    window.addEventListener("beforeunload", handleBeforeReload);

    // Debounced save on scroll
    let timeoutId: ReturnType<typeof setTimeout>;
    const handleScroll = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(saveScroll, 200);
    };

    container.addEventListener("scroll", handleScroll);
    return () => {
      window.removeEventListener("app:before-reload", handleBeforeReload);
      window.removeEventListener("beforeunload", handleBeforeReload);
      container.removeEventListener("scroll", handleScroll);
      clearTimeout(timeoutId);
      saveScroll();
    };
  }, [sourceName, currentIndex]);

  // Track active heading based on scroll position
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || headings.length === 0) return;

    const handleScroll = () => {
      const scrollTop = container.scrollTop;
      let currentHeading: string | null = null;

      headingRefs.current.forEach((element, id) => {
        if (element.offsetTop <= scrollTop + 100) {
          currentHeading = id;
        }
      });

      setActiveHeading(currentHeading);
    };

    container.addEventListener("scroll", handleScroll);
    handleScroll();
    return () => container.removeEventListener("scroll", handleScroll);
  }, [headings]);

  const scrollToTop = useCallback(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  const handleNavigate = useCallback(
    (newIndex: number) => {
      if (newIndex < 0 || newIndex >= documents.length || newIndex === currentIndex) return;
      onNavigate(newIndex);
      scrollToTop();
    },
    [currentIndex, documents.length, onNavigate, scrollToTop]
  );

  const handlePrev = useCallback(() => {
    if (hasPrev) handleNavigate(currentIndex - 1);
  }, [hasPrev, handleNavigate, currentIndex]);

  const handleNext = useCallback(() => {
    if (hasNext) handleNavigate(currentIndex + 1);
  }, [hasNext, handleNavigate, currentIndex]);

  const toggleLeftPanel = useCallback(() => setLeftPanelOpen((v) => !v), []);
  const toggleRightPanel = useCallback(() => setRightPanelOpen((v) => !v), []);
  const toggleFullscreen = useCallback(() => setIsFullscreen((v) => !v), []);

  const handleHeadingClick = useCallback((id: string) => {
    const element = headingRefs.current.get(id);
    const container = scrollContainerRef.current;
    if (element && container) {
      // Calculate offset by walking up the DOM tree
      let offsetTop = 0;
      let current: HTMLElement | null = element;
      while (current && current !== container) {
        offsetTop += current.offsetTop;
        current = current.offsetParent as HTMLElement | null;
      }

      container.scrollTo({ top: Math.max(0, offsetTop - 80), behavior: "smooth" });

      // Highlight the heading
      element.classList.add("heading-highlight");
      setTimeout(() => {
        element.classList.remove("heading-highlight");
      }, 2000);
    }
  }, []);

  const handleHeadingRender = useCallback((id: string, element: HTMLElement | null) => {
    if (element) {
      headingRefs.current.set(id, element);
    } else {
      headingRefs.current.delete(id);
    }
  }, []);

  useKeyboardNavigation(handlePrev, handleNext, onBack, toggleLeftPanel, toggleRightPanel);

  return (
    <div className={`flex flex-col bg-background ${isFullscreen ? "fixed inset-0 z-50" : "h-full"}`}>
      {/* Top bar */}
      <header
        data-tauri-drag-region
        className="shrink-0 h-[52px] border-b border-border bg-background flex items-center px-4 gap-3"
      >
        {/* Fullscreen toggle */}
        <button
          onClick={toggleFullscreen}
          className="p-1.5 rounded-lg hover:bg-card-alt transition-colors"
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>

        {/* Left panel toggle (when closed) */}
        {!leftPanelOpen && (
          <button
            onClick={toggleLeftPanel}
            className="p-1.5 rounded-lg hover:bg-card-alt transition-colors"
            title="Show documents (⌘[)"
          >
            <PanelLeft className="w-4 h-4" />
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Source name - centered */}
        <span className="text-sm text-foreground font-medium truncate max-w-[300px]">
          {startCase(sourceName)}
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Page indicator - right aligned */}
        <span className="text-xs text-muted-foreground">
          {currentIndex + 1} / {documents.length}
        </span>

        {/* Right panel toggle (when closed) */}
        {!rightPanelOpen && headings.length > 0 && (
          <button
            onClick={toggleRightPanel}
            className="p-1.5 rounded-lg hover:bg-card-alt transition-colors"
            title="Show outline (⌘])"
          >
            <PanelRight className="w-4 h-4" />
          </button>
        )}
      </header>

      {/* Main area with sidebars */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Progress bar */}
        <ReadingProgressBar progress={progress} />

        {/* Left sidebar - Documents */}
        <DocumentListSidebar
          documents={documents}
          currentIndex={currentIndex}
          sourceName={sourceName}
          onSelect={handleNavigate}
          onBack={onBack}
          isOpen={leftPanelOpen}
          onToggle={toggleLeftPanel}
        />

        {/* Main content area */}
        <main
          ref={scrollContainerRef}
          data-ref-scroll
          className="flex-1 min-w-0 overflow-y-auto px-8 py-8 md:px-16"
        >
          {/* Book cover - only show on first document */}
          {currentIndex === 0 && !loading && (
            <BookCover
              title={startCase(sourceName)}
              documentCount={documents.length}
            />
          )}

          <DocumentContent
            content={content}
            loading={loading}
            headings={headings}
            onHeadingRender={handleHeadingRender}
          />

          {/* Bottom navigation */}
          {!loading && (
            <nav className="max-w-3xl mx-auto mt-12 pt-6 border-t border-border">
              <div className="flex items-stretch gap-4">
                {/* Previous */}
                <button
                  onClick={handlePrev}
                  disabled={!hasPrev}
                  className={`flex-1 flex flex-col items-start gap-1 p-4 rounded-xl border text-left ${
                    hasPrev
                      ? "border-border hover:border-primary hover:bg-card-alt cursor-pointer group"
                      : "border-transparent opacity-0 pointer-events-none"
                  }`}
                >
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <ChevronLeftIcon className="w-3 h-3" />
                    Previous
                  </span>
                  <span className="text-sm font-medium text-ink group-hover:text-primary transition-colors line-clamp-1">
                    {documents[currentIndex - 1]?.name}
                  </span>
                </button>

                {/* Next */}
                <button
                  onClick={handleNext}
                  disabled={!hasNext}
                  className={`flex-1 flex flex-col items-end gap-1 p-4 rounded-xl border text-right ${
                    hasNext
                      ? "border-border hover:border-primary hover:bg-card-alt cursor-pointer group"
                      : "border-transparent opacity-0 pointer-events-none"
                  }`}
                >
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    Next
                    <ChevronLeftIcon className="w-3 h-3 rotate-180" />
                  </span>
                  <span className="text-sm font-medium text-ink group-hover:text-primary transition-colors line-clamp-1">
                    {documents[currentIndex + 1]?.name}
                  </span>
                </button>
              </div>
            </nav>
          )}

          {/* Bottom padding */}
          <div className="h-16" />
        </main>

        {/* Right sidebar - Headings */}
        <HeadingsSidebar
          headings={headings}
          activeHeading={activeHeading}
          onHeadingClick={handleHeadingClick}
          isOpen={rightPanelOpen && headings.length > 0}
          onToggle={toggleRightPanel}
        />
      </div>
    </div>
  );
}

export default DocumentReader;
