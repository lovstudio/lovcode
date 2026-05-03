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
} from "react";
import { FileViewer } from "../../components/FileViewer";

interface FilePreviewOpenOptions {
  line?: number;
  column?: number;
}

interface FilePreviewContextValue {
  openFilePreview: (path: string, anchor?: HTMLElement | null, opts?: FilePreviewOpenOptions) => void;
}

const FilePreviewContext = createContext<FilePreviewContextValue | null>(null);
const SIDEBAR_MIN_WIDTH = 1120;
const SIDEBAR_TRANSITION_MS = 220;
const SIDEBAR_WIDTH_KEY = "chat-file-preview-sidebar-width";
const SIDEBAR_MIN_PX = 320;
const SIDEBAR_MAX_RATIO = 0.75;

export function useFilePreview() {
  return useContext(FilePreviewContext);
}

export function ChatFilePreviewProvider({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lastAnchorRef = useRef<HTMLElement | null>(null);
  const stabilizeFrameRef = useRef<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [openLine, setOpenLine] = useState<number | undefined>(undefined);
  const [openColumn, setOpenColumn] = useState<number | undefined>(undefined);
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
      setOpenLine(opts?.line);
      setOpenColumn(opts?.column);
      setOpenNonce((n) => n + 1);
      stabilizeAnchor(anchor ?? lastAnchorRef.current);
    },
    [stabilizeAnchor],
  );

  const closeFilePreview = useCallback(() => {
    const anchor = lastAnchorRef.current;
    setFilePath(null);
    stabilizeAnchor(anchor);
  }, [stabilizeAnchor]);

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
    if (!filePath) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFilePreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeFilePreview, filePath]);

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
  }), [openFilePreview]);

  const showSidebar = !!filePath && containerWidth >= SIDEBAR_MIN_WIDTH;

  return (
    <FilePreviewContext.Provider value={value}>
      <div ref={rootRef} className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
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
            {showSidebar && filePath && (
              <FileViewer
                filePath={filePath}
                onClose={closeFilePreview}
                revealLine={openLine}
                revealColumn={openColumn}
                revealNonce={openNonce}
              />
            )}
          </div>
        </aside>

        {filePath && !showSidebar && (
          <div
            className="absolute inset-0 z-40 flex min-h-0 min-w-0 bg-background/80 backdrop-blur-sm"
            onClick={closeFilePreview}
          >
            <div
              className="m-3 min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <FileViewer
                filePath={filePath}
                onClose={closeFilePreview}
                revealLine={openLine}
                revealColumn={openColumn}
                revealNonce={openNonce}
              />
            </div>
          </div>
        )}
      </div>
    </FilePreviewContext.Provider>
  );
}
