import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Copy, X } from "lucide-react";
import { CollapsibleContent } from "../views/Chat/CollapsibleContent";
import { ChatFilePreviewProvider } from "../views/Chat/FilePreviewContext";
import { toast } from "../components/ui/toast";

export default function PromptDetail() {
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("Prompt");
  const [markdown, setMarkdown] = useState(true);

  useEffect(() => {
    const hash = window.location.hash;
    const queryStr = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
    const params = new URLSearchParams(queryStr);
    const c = params.get("content") ?? "";
    const t = params.get("title") ?? "Prompt";
    setContent(c);
    setTitle(t);
    getCurrentWindow().setTitle(t).catch(() => {});
  }, []);

  const lineCount = useMemo(() => content.split("\n").length, [content]);
  const charCount = content.length;

  const handleCopy = () => {
    invoke("copy_to_clipboard", { text: content })
      .then(() => toast.success("Copied"))
      .catch(() => {});
  };

  const handleClose = () => {
    getCurrentWindow().close().catch(() => {});
  };

  return (
    <div className="fixed inset-0 bg-background text-ink">
      <ChatFilePreviewProvider>
        <div className="flex h-full min-h-0 flex-col">
          <header
            data-tauri-drag-region
            className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2 border-b border-border bg-card/60 backdrop-blur"
            style={{ paddingLeft: 80 }}
          >
            <div className="flex-1 min-w-0 truncate text-sm font-medium" data-tauri-drag-region>
              {title}
            </div>
            <div className="shrink-0 flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
              <span>{lineCount} lines</span>
              <span>{charCount} chars</span>
            </div>
            <button
              onClick={() => setMarkdown((v) => !v)}
              className="px-2 py-1 rounded text-[11px] hover:bg-card-alt text-muted-foreground hover:text-ink"
              title="Toggle markdown rendering"
            >
              {markdown ? "Raw" : "Markdown"}
            </button>
            <button
              onClick={handleCopy}
              className="p-1.5 rounded hover:bg-card-alt text-muted-foreground hover:text-ink"
              title="Copy"
            >
              <Copy size={14} />
            </button>
            <button
              onClick={handleClose}
              className="p-1.5 rounded hover:bg-card-alt text-muted-foreground hover:text-ink"
              title="Close"
            >
              <X size={14} />
            </button>
          </header>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
            <div className="max-w-4xl mx-auto text-sm leading-relaxed">
              <CollapsibleContent
                content={content}
                markdown={markdown}
                disableCollapse
              />
            </div>
          </div>
        </div>
      </ChatFilePreviewProvider>
    </div>
  );
}
