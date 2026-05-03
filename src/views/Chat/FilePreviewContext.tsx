import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Cross2Icon, ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import { FileViewer } from "../../components/FileViewer";
import { cn } from "../../lib/utils";

interface FilePreviewOpenOptions {
  line?: number;
  column?: number;
}

export interface ImagePreviewItem {
  src: string;
  title: string;
  mediaType?: string;
  size?: number | null;
  sourcePath?: string;
}

interface ImagePreviewOpenOptions {
  index?: number;
  title?: string;
}

interface FilePreviewContextValue {
  openFilePreview: (path: string, anchor?: HTMLElement | null, opts?: FilePreviewOpenOptions) => void;
  openImagePreview: (images: ImagePreviewItem[], anchor?: HTMLElement | null, opts?: ImagePreviewOpenOptions) => void;
}

const FilePreviewContext = createContext<FilePreviewContextValue | null>(null);
const SIDEBAR_MIN_WIDTH = 1120;
const SIDEBAR_TRANSITION_MS = 220;
const SIDEBAR_WIDTH_KEY = "chat-file-preview-sidebar-width";
const SIDEBAR_MIN_PX = 320;
const SIDEBAR_MAX_RATIO = 0.75;

function clampIndex(index: number, length: number) {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

function formatPreviewByteSize(size?: number | null) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return Math.abs(a);
}

function formatAspectRatio(width?: number, height?: number) {
  if (!width || !height) return "";
  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function ImagePreviewMetaRow({ label, value, mono = false }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null;

  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-[11px] leading-relaxed">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`${mono ? "font-mono" : ""} min-w-0 break-words text-foreground`}>{value}</dd>
    </div>
  );
}

function ImagePreviewPanel({
  images,
  index,
  title,
  onClose,
  onSelectIndex,
}: {
  images: ImagePreviewItem[];
  index: number;
  title?: string;
  onClose: () => void;
  onSelectIndex: (index: number) => void;
}) {
  const [imageSizes, setImageSizes] = useState<Record<string, { width: number; height: number }>>({});
  const image = images[index];
  if (!image) return null;

  const imageSize = imageSizes[image.src];
  const sizeLabel = formatPreviewByteSize(image.size);
  const label = title || image.title || `Image ${index + 1}`;
  const hasMultiple = images.length > 1;
  const dimensions = imageSize ? `${imageSize.width} x ${imageSize.height}` : "";
  const aspectRatio = formatAspectRatio(imageSize?.width, imageSize?.height);

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (!naturalWidth || !naturalHeight) return;
    setImageSizes((prev) => ({
      ...prev,
      [image.src]: {
        width: naturalWidth,
        height: naturalHeight,
      },
    }));
  };

  return (
    <div className="flex h-full flex-col bg-terminal">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-canvas-alt px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={label}>
          {label}
        </span>
        {hasMultiple && (
          <div className="flex items-center gap-0.5 rounded-lg bg-card-alt p-0.5">
            <button
              type="button"
              onClick={() => onSelectIndex(index - 1)}
              disabled={index === 0}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-ink disabled:opacity-40"
              title="Previous image"
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </button>
            <span className="px-2 font-mono text-[11px] text-muted-foreground">
              {index + 1}/{images.length}
            </span>
            <button
              type="button"
              onClick={() => onSelectIndex(index + 1)}
              disabled={index === images.length - 1}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-ink disabled:opacity-40"
              title="Next image"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-card-alt hover:text-ink"
          title="Close"
        >
          <Cross2Icon className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-background">
        <div className="flex min-h-full items-center justify-center p-4">
          <img
            src={image.src}
            alt={label}
            className="max-h-full max-w-full rounded-lg border border-border bg-card object-contain"
            onLoad={handleImageLoad}
          />
        </div>
      </div>

      <div className="shrink-0 space-y-3 border-t border-border bg-canvas-alt px-4 py-3">
        <dl className="space-y-1.5">
          <ImagePreviewMetaRow label="Source" value={image.sourcePath || image.title} mono />
          <ImagePreviewMetaRow label="Dimensions" value={dimensions} mono />
          <ImagePreviewMetaRow label="Ratio" value={aspectRatio} mono />
          <ImagePreviewMetaRow label="Type" value={image.mediaType} mono />
          <ImagePreviewMetaRow label="Size" value={sizeLabel} mono />
        </dl>
        {hasMultiple && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {images.map((item, itemIndex) => (
              <button
                key={`${item.src.slice(0, 48)}-${itemIndex}`}
                type="button"
                onClick={() => onSelectIndex(itemIndex)}
                className={`h-14 w-16 shrink-0 overflow-hidden rounded-lg border bg-card transition-colors ${
                  itemIndex === index ? "border-primary" : "border-border hover:border-primary/60"
                }`}
                title={item.title}
              >
                <img src={item.src} alt={item.title} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function useFilePreview() {
  return useContext(FilePreviewContext);
}

export function ChatFilePreviewProvider({
  children,
  className,
  contentClassName,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lastAnchorRef = useRef<HTMLElement | null>(null);
  const stabilizeFrameRef = useRef<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [openLine, setOpenLine] = useState<number | undefined>(undefined);
  const [openColumn, setOpenColumn] = useState<number | undefined>(undefined);
  const [imagePreview, setImagePreview] = useState<{
    images: ImagePreviewItem[];
    index: number;
    title?: string;
  } | null>(null);
  // Bumped on every open call so FileViewer can re-trigger reveal even if path unchanged.
  const [openNonce, setOpenNonce] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const saved = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const n = saved ? Number(saved) : NaN;
    return Number.isFinite(n) && n >= SIDEBAR_MIN_PX ? n : null;
  });
  const [isDragging, setIsDragging] = useState(false);

  const findScrollContainer = useCallback((anchor: HTMLElement) => {
    const root = rootRef.current;
    let current: HTMLElement | null = anchor.parentElement;

    while (current && current !== root) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const canScroll = overflowY === "auto" || overflowY === "scroll";
      if (canScroll && current.scrollHeight > current.clientHeight) return current;
      current = current.parentElement;
    }

    return null;
  }, []);

  const stabilizeAnchor = useCallback((anchor: HTMLElement | null) => {
    if (!anchor || !document.contains(anchor)) return;
    const scroller = findScrollContainer(anchor);
    if (!scroller) return;

    if (stabilizeFrameRef.current !== null) {
      cancelAnimationFrame(stabilizeFrameRef.current);
      stabilizeFrameRef.current = null;
    }

    const targetTop = anchor.getBoundingClientRect().top;
    const startedAt = performance.now();

    const step = () => {
      if (!document.contains(anchor) || !document.contains(scroller)) {
        stabilizeFrameRef.current = null;
        return;
      }

      const delta = anchor.getBoundingClientRect().top - targetTop;
      if (Math.abs(delta) > 0.5) {
        scroller.scrollTop += delta;
      }

      if (performance.now() - startedAt < SIDEBAR_TRANSITION_MS) {
        stabilizeFrameRef.current = requestAnimationFrame(step);
      } else {
        stabilizeFrameRef.current = null;
      }
    };

    stabilizeFrameRef.current = requestAnimationFrame(step);
  }, [findScrollContainer]);

  const openFilePreview = useCallback(
    (path: string, anchor?: HTMLElement | null, opts?: FilePreviewOpenOptions) => {
      if (anchor) lastAnchorRef.current = anchor;
      setFilePath(path);
      setImagePreview(null);
      setOpenLine(opts?.line);
      setOpenColumn(opts?.column);
      setOpenNonce((n) => n + 1);
      stabilizeAnchor(anchor ?? lastAnchorRef.current);
    },
    [stabilizeAnchor],
  );

  const openImagePreview = useCallback(
    (images: ImagePreviewItem[], anchor?: HTMLElement | null, opts?: ImagePreviewOpenOptions) => {
      if (images.length === 0) return;
      if (anchor) lastAnchorRef.current = anchor;
      setFilePath(null);
      setOpenLine(undefined);
      setOpenColumn(undefined);
      setImagePreview({
        images,
        index: clampIndex(opts?.index ?? 0, images.length),
        title: opts?.title,
      });
      setOpenNonce((n) => n + 1);
      stabilizeAnchor(anchor ?? lastAnchorRef.current);
    },
    [stabilizeAnchor],
  );

  const closeFilePreview = useCallback(() => {
    const anchor = lastAnchorRef.current;
    setFilePath(null);
    setImagePreview(null);
    stabilizeAnchor(anchor);
  }, [stabilizeAnchor]);

  const setImagePreviewIndex = useCallback((index: number) => {
    setImagePreview((prev) =>
      prev
        ? {
            ...prev,
            index: clampIndex(index, prev.images.length),
          }
        : prev,
    );
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const updateWidth = () => setContainerWidth(root.clientWidth);
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!filePath && !imagePreview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFilePreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeFilePreview, filePath, imagePreview]);

  useEffect(() => {
    return () => {
      if (stabilizeFrameRef.current !== null) {
        cancelAnimationFrame(stabilizeFrameRef.current);
      }
    };
  }, []);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;

    setIsDragging(true);
    const rootRect = root.getBoundingClientRect();
    const maxPx = Math.max(SIDEBAR_MIN_PX, rootRect.width * SIDEBAR_MAX_RATIO);

    const onMove = (ev: PointerEvent) => {
      // aside is on the right; sidebar width = root right - pointer x
      const next = Math.min(maxPx, Math.max(SIDEBAR_MIN_PX, rootRect.right - ev.clientX));
      setSidebarWidth(next);
    };
    const onUp = () => {
      setIsDragging(false);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }, []);

  useEffect(() => {
    if (sidebarWidth == null) return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);

  const value = useMemo<FilePreviewContextValue>(() => ({
    openFilePreview,
    openImagePreview,
  }), [openFilePreview, openImagePreview]);

  const hasPreview = !!filePath || !!imagePreview;
  const showSidebar = hasPreview && containerWidth >= SIDEBAR_MIN_WIDTH;
  const previewContent = filePath ? (
    <FileViewer
      filePath={filePath}
      onClose={closeFilePreview}
      revealLine={openLine}
      revealColumn={openColumn}
      revealNonce={openNonce}
    />
  ) : imagePreview ? (
    <ImagePreviewPanel
      images={imagePreview.images}
      index={imagePreview.index}
      title={imagePreview.title}
      onClose={closeFilePreview}
      onSelectIndex={setImagePreviewIndex}
    />
  ) : null;

  return (
    <FilePreviewContext.Provider value={value}>
      <div
        ref={rootRef}
        className={cn("relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden", className)}
      >
        <div className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", contentClassName)}>
          {children}
        </div>

        <aside
          className={`relative min-h-0 shrink-0 overflow-hidden bg-card ${
            isDragging ? "" : "transition-[width,border-color] duration-200 ease-out"
          } ${showSidebar ? "border-l border-border" : "border-l border-transparent"}`}
          style={{
            width: showSidebar
              ? sidebarWidth != null
                ? Math.min(
                    Math.max(SIDEBAR_MIN_PX, sidebarWidth),
                    Math.max(SIDEBAR_MIN_PX, containerWidth * SIDEBAR_MAX_RATIO),
                  )
                : "clamp(380px, 42%, 720px)"
              : 0,
          }}
          aria-hidden={!showSidebar}
        >
          {showSidebar && (
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={handleResizeStart}
              className={`absolute left-0 top-0 z-10 h-full w-1 -translate-x-1/2 cursor-col-resize select-none transition-colors ${
                isDragging ? "bg-primary" : "bg-transparent hover:bg-primary/50"
              }`}
            />
          )}
          <div className="h-full min-h-0 w-full">
            {showSidebar && previewContent}
          </div>
        </aside>

        {hasPreview && !showSidebar && (
          <div
            className="absolute inset-0 z-40 flex min-h-0 min-w-0 bg-background/80 backdrop-blur-sm"
            onClick={closeFilePreview}
          >
            <div
              className="m-3 min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              {previewContent}
            </div>
          </div>
        )}
      </div>
    </FilePreviewContext.Provider>
  );
}
