import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useAtom } from "jotai";
import { fileViewModeAtom } from "@/store";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import {
  Cross2Icon,
  ExternalLinkIcon,
  CodeIcon,
  ReaderIcon,
  ColumnsIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DotsHorizontalIcon,
  FileIcon,
} from "@radix-ui/react-icons";
import { Folder } from "lucide-react";
import Editor from "@monaco-editor/react";
import { MarkdownRenderer } from "../MarkdownRenderer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn, getAbsoluteParentPath, isImageFile } from "@/lib/utils";

const EDITOR_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 13,
  lineHeight: 20,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  renderLineHighlight: "none" as const,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  scrollbar: { vertical: "auto" as const, horizontal: "auto" as const, verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
  padding: { top: 12, bottom: 12 },
};

// Map file extension to Monaco language
function getLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    xml: "xml",
    md: "markdown",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    dockerfile: "dockerfile",
    makefile: "makefile",
  };
  return map[ext] || "plaintext";
}

interface FileViewerProps {
  filePath: string;
  onClose: () => void;
  /** Optional line to reveal once content is loaded (1-indexed). */
  revealLine?: number;
  /** Optional column to place the cursor at (1-indexed). */
  revealColumn?: number;
  /** Bumped by parent on every open call so reveal re-runs even if path is unchanged. */
  revealNonce?: number;
}

interface ImageInfo {
  width: number;
  height: number;
  fileSize: number;
  modified?: number;
}

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface BreadcrumbSegment {
  name: string;
  path: string;
}

interface MonacoEditorLike {
  getModel(): {
    getLineCount(): number;
    onDidChangeContent(listener: () => void): { dispose(): void };
  } | null;
  getLayoutInfo?: () => { height: number; width: number };
  revealLineInCenter(lineNumber: number): void;
  setPosition(position: { lineNumber: number; column: number }): void;
  focus(): void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildBreadcrumbs(path: string): BreadcrumbSegment[] | null {
  if (!path.startsWith("/")) return null;
  const parts = path.split("/").filter(Boolean);
  let acc = "";
  return parts.map((name) => {
    acc += "/" + name;
    return { name, path: acc };
  });
}

function PathBreadcrumbs({
  path,
  segments,
  onNavigate,
  currentIsDir,
  className,
}: {
  path: string;
  segments: BreadcrumbSegment[] | null;
  onNavigate: (path: string) => void;
  currentIsDir?: boolean | null;
  className?: string;
}) {
  if (!segments) {
    return (
      <span className={cn("min-w-0 text-ink", className)} title={path}>
        {path}
      </span>
    );
  }

  const isRoot = path === "/";
  const visibleCount = 2;
  const shouldCollapse = segments.length > visibleCount;
  const visibleSegments = shouldCollapse ? segments.slice(-visibleCount) : segments;
  const hiddenSegments = shouldCollapse ? segments.slice(0, -visibleCount) : [];
  const hiddenMenuSegments = shouldCollapse
    ? [{ name: "/", path: "/" }, ...hiddenSegments]
    : [];
  const separator = (
    <ChevronRightIcon className="h-3 w-3 shrink-0 text-muted-foreground/50" />
  );

  return (
    <nav
      className={cn(
        "flex min-w-0 items-center gap-0.5 overflow-hidden whitespace-nowrap text-muted-foreground",
        className,
      )}
      title={path}
      aria-label="File path"
    >
      {!shouldCollapse && (
        <button
          type="button"
          onClick={() => onNavigate("/")}
          disabled={isRoot}
          className={cn(
            "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 transition-colors",
            isRoot
              ? "cursor-default text-ink"
              : "cursor-pointer hover:bg-card-alt hover:text-primary",
          )}
          title="/"
        >
          /
        </button>
      )}
      {hiddenSegments.length > 0 && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex h-5 shrink-0 items-center justify-center rounded-md px-1 text-muted-foreground transition-colors hover:bg-card-alt hover:text-primary",
                )}
                title="Show parent folders"
              >
                <DotsHorizontalIcon className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {hiddenMenuSegments.map((seg) => (
                <DropdownMenuItem
                  key={seg.path}
                  onSelect={() => onNavigate(seg.path)}
                  className="min-w-0"
                >
                  <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate">{seg.name}</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {seg.path}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      {visibleSegments.map((seg) => {
        const isLast = seg.path === path;
        const showFileIcon = isLast && currentIsDir === false;
        return (
          <span key={seg.path} className="inline-flex min-w-0 items-center gap-0.5">
            {separator}
            <button
              type="button"
              onClick={() => onNavigate(seg.path)}
              disabled={isLast}
              className={cn(
                "inline-flex min-w-0 items-center rounded-md px-1.5 transition-colors",
                isLast ? "h-5 max-w-40" : "h-5 max-w-24",
                isLast
                  ? "cursor-default bg-card-alt text-ink"
                  : "cursor-pointer hover:bg-card-alt hover:text-primary",
              )}
              title={seg.path}
            >
              {showFileIcon && (
                <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{seg.name}</span>
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export function FileViewer({ filePath, onClose, revealLine, revealColumn, revealNonce }: FileViewerProps) {
  // Internal navigation: lets users drill into directories without losing the
  // original `filePath` prop. History stack supports the back button.
  const [currentPath, setCurrentPath] = useState(filePath);
  const [history, setHistory] = useState<string[]>([]);
  const [isDir, setIsDir] = useState<boolean | null>(null);
  const [dirEntries, setDirEntries] = useState<DirEntry[]>([]);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useAtom(fileViewModeAtom);
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);

  const editorRef = useRef<MonacoEditorLike | null>(null);
  // Track whether the most recent reveal request has been applied to avoid
  // re-revealing on unrelated re-renders (e.g. user scrolls then resizes).
  const appliedNonceRef = useRef<number | undefined>(undefined);

  // Reset internal state when the parent opens a different path
  useEffect(() => {
    setCurrentPath(filePath);
    setHistory([]);
  }, [filePath]);

  // Reveal target line if pending and conditions are met. Called both reactively
  // (from useEffect when content/path/nonce changes) and imperatively (from Editor
  // onMount, since Monaco's mount happens via ref assignment which doesn't re-render).
  //
  // Subtle race: when a path is opened for the first time, Monaco mounts AFTER
  // content arrives, but the editor's model may not yet contain the text on the
  // very first onMount tick — so revealLineInCenter targets a line that doesn't
  // exist yet and silently no-ops. We retry once the model actually has enough
  // lines via `onDidChangeModelContent`, and also defer to the next frame so
  // layout is finalized before scrolling.
  const tryRevealTarget = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!revealLine || revealLine < 1) return;
    if (loading || isDir) return;
    if (revealNonce !== undefined && appliedNonceRef.current === revealNonce)
      return;

    const column = revealColumn && revealColumn > 0 ? revealColumn : 1;

    const doReveal = () => {
      const e = editorRef.current;
      if (!e) return;
      e.revealLineInCenter(revealLine);
      e.setPosition({ lineNumber: revealLine, column });
      e.focus();
      appliedNonceRef.current = revealNonce;
    };

    const model = ed.getModel();
    if (model && model.getLineCount() >= revealLine) {
      requestAnimationFrame(doReveal);
      return;
    }

    if (!model) return;
    const sub = model.onDidChangeContent(() => {
      const m = editorRef.current?.getModel();
      if (!m || m.getLineCount() < revealLine) return;
      sub.dispose();
      requestAnimationFrame(doReveal);
    });
  }, [revealLine, revealColumn, revealNonce, loading, isDir]);

  useEffect(() => {
    tryRevealTarget();
  }, [tryRevealTarget, content, viewMode]);

  const fileName = useMemo(() => currentPath.split("/").pop() || currentPath, [currentPath]);
  const language = useMemo(() => getLanguage(currentPath), [currentPath]);
  const isMarkdown = language === "markdown";
  const isImage = useMemo(() => !isDir && isImageFile(fileName), [isDir, fileName]);
  const imageSrc = useMemo(() => isImage ? convertFileSrc(currentPath) : null, [isImage, currentPath]);
  const fileExt = useMemo(() => fileName.split('.').pop()?.toUpperCase() || '', [fileName]);
  const markdownCwd = useMemo(() => getAbsoluteParentPath(currentPath), [currentPath]);

  const navigateTo = useCallback((path: string) => {
    if (path === currentPath) return;
    setHistory((h) => [...h, currentPath]);
    setCurrentPath(path);
  }, [currentPath]);

  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath), [currentPath]);

  const goBack = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const next = [...h];
      const prev = next.pop()!;
      setCurrentPath(prev);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIsDir(null);

    async function load() {
      try {
        const meta = await invoke<{ size: number; modified?: number; is_dir: boolean }>(
          "get_file_metadata",
          { path: currentPath },
        );
        if (cancelled) return;
        setIsDir(meta.is_dir);

        if (meta.is_dir) {
          const entries = await invoke<DirEntry[]>("list_directory", { path: currentPath });
          if (!cancelled) {
            // Folders first, then alphabetical
            entries.sort((a, b) => {
              if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
            setDirEntries(entries);
            setLoading(false);
          }
          return;
        }

        if (isImageFile(currentPath.split("/").pop() || "")) {
          setImageInfo((prev) =>
            prev
              ? { ...prev, fileSize: meta.size, modified: meta.modified }
              : { width: 0, height: 0, fileSize: meta.size, modified: meta.modified },
          );
          setLoading(false);
          return;
        }

        const result = await invoke<string>("read_file", { path: currentPath });
        if (!cancelled) {
          setContent(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImageInfo((prev) => ({
      width: img.naturalWidth,
      height: img.naturalHeight,
      fileSize: prev?.fileSize || 0,
      modified: prev?.modified,
    }));
  };

  const handleOpenInEditor = async () => {
    try {
      await invoke("open_in_editor", { path: currentPath });
    } catch (err) {
      console.error("Failed to open in editor:", err);
    }
  };

  const revealInFinder = async () => {
    try {
      await invoke("reveal_path", { path: currentPath });
    } catch (err) {
      console.error("Failed to reveal:", err);
    }
  };

  return (
    <div className="h-full flex flex-col bg-terminal">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-canvas-alt flex-shrink-0">
        {history.length > 0 && (
          <button
            onClick={goBack}
            className="p-1 text-muted-foreground hover:text-ink hover:bg-card-alt rounded transition-colors"
            title="Back"
          >
            <ChevronLeftIcon className="w-4 h-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <PathBreadcrumbs
            path={currentPath}
            segments={breadcrumbs}
            onNavigate={navigateTo}
            currentIsDir={isDir}
            className="text-sm font-medium"
          />
        </div>
        {isMarkdown && !isDir && (
          <div className="flex items-center bg-card-alt rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("source")}
              className={`p-1.5 rounded transition-colors ${
                viewMode === "source"
                  ? "bg-background text-ink shadow-sm"
                  : "text-muted-foreground hover:text-ink"
              }`}
              title="Source"
            >
              <CodeIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("split")}
              className={`p-1.5 rounded transition-colors ${
                viewMode === "split"
                  ? "bg-background text-ink shadow-sm"
                  : "text-muted-foreground hover:text-ink"
              }`}
              title="Side by Side"
            >
              <ColumnsIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("preview")}
              className={`p-1.5 rounded transition-colors ${
                viewMode === "preview"
                  ? "bg-background text-ink shadow-sm"
                  : "text-muted-foreground hover:text-ink"
              }`}
              title="Preview"
            >
              <ReaderIcon className="w-4 h-4" />
            </button>
          </div>
        )}
        <button
          onClick={handleOpenInEditor}
          className="p-1.5 text-muted-foreground hover:text-ink hover:bg-card-alt rounded transition-colors"
          title="Open in editor"
        >
          <ExternalLinkIcon className="w-4 h-4" />
        </button>
        <button
          onClick={onClose}
          className="p-1.5 text-muted-foreground hover:text-ink hover:bg-card-alt rounded transition-colors"
          title="Close"
        >
          <Cross2Icon className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-destructive">{error}</div>
          </div>
        ) : isDir ? (
          <div className="h-full overflow-auto bg-background">
            {dirEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 gap-2">
                <Folder className="w-8 h-8 text-muted-foreground/40" />
                <div className="text-sm text-muted-foreground">Empty directory</div>
                <button
                  onClick={revealInFinder}
                  className="text-xs text-primary hover:underline"
                >
                  Reveal in Finder
                </button>
              </div>
            ) : (
              <ul className="py-1">
                {dirEntries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      onClick={() => navigateTo(entry.path)}
                      onDoubleClick={() => {
                        if (!entry.is_dir) return;
                        invoke("open_path", { path: entry.path }).catch(console.error);
                      }}
                      className="w-full flex items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-card-alt transition-colors"
                      title={entry.path}
                    >
                      {entry.is_dir ? (
                        <Folder className="w-4 h-4 shrink-0 text-primary" />
                      ) : (
                        <FileIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate text-ink">{entry.name}</span>
                      {entry.is_dir && (
                        <span className="ml-auto text-xs text-muted-foreground/60">/</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : isImage && imageSrc ? (
          <div className="h-full flex">
            <div className="flex-1 flex items-center justify-center p-4 bg-foreground">
              <img
                src={imageSrc}
                alt={fileName}
                className="max-w-full max-h-full object-contain"
                onLoad={handleImageLoad}
              />
            </div>
            <div className="w-48 border-l border-border bg-canvas-alt p-3 flex-shrink-0">
              <h3 className="text-xs font-medium text-muted-foreground mb-3">Image Info</h3>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Format</span>
                  <p className="text-ink">{fileExt}</p>
                </div>
                {imageInfo?.width && imageInfo.width > 0 && (
                  <div>
                    <span className="text-muted-foreground">Dimensions</span>
                    <p className="text-ink">{imageInfo.width} × {imageInfo.height}</p>
                  </div>
                )}
                {imageInfo?.fileSize && imageInfo.fileSize > 0 && (
                  <div>
                    <span className="text-muted-foreground">Size</span>
                    <p className="text-ink">{formatFileSize(imageInfo.fileSize)}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : isMarkdown && viewMode === "preview" ? (
          <div className="h-full overflow-auto p-6 bg-background">
            <MarkdownRenderer content={content} cwd={markdownCwd} />
          </div>
        ) : isMarkdown && viewMode === "split" ? (
          <div className="h-full flex">
            <div className="w-1/2 border-r border-border">
              <Editor
                value={content}
                language="markdown"
                theme="vs"
                options={EDITOR_OPTIONS}
                onMount={(ed) => {
                  editorRef.current = ed;
                  tryRevealTarget();
                }}
              />
            </div>
            <div className="w-1/2 overflow-auto p-6 bg-background">
              <MarkdownRenderer content={content} cwd={markdownCwd} className="max-w-none" />
            </div>
          </div>
        ) : (
          <Editor
            value={content}
            language={language}
            theme="vs"
            options={EDITOR_OPTIONS}
            onMount={(ed) => {
              editorRef.current = ed;
              tryRevealTarget();
            }}
          />
        )}
      </div>
    </div>
  );
}
