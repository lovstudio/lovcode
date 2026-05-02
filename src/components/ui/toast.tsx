import { useEffect, useState } from "react";
import { X, Copy, Check } from "lucide-react";

type Variant = "error" | "success" | "info";
interface ToastItem {
  id: number;
  message: string;
  variant: Variant;
}

type Listener = (items: ToastItem[]) => void;

let counter = 0;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

function push(message: string, variant: Variant, ttl: number | null) {
  const id = ++counter;
  items = [...items, { id, message, variant }];
  emit();
  if (ttl !== null) {
    setTimeout(() => dismiss(id), ttl);
  }
}

export const toast = {
  // Errors are sticky — user dismisses (often after copying).
  error: (message: string) => push(message, "error", null),
  success: (message: string) => push(message, "success", 3000),
  info: (message: string) => push(message, "info", 3000),
};

const variantClasses: Record<Variant, string> = {
  error: "bg-red-50 border-red-300 text-red-900",
  success: "bg-green-50 border-green-300 text-green-900",
  info: "bg-card border-border text-ink",
};

function ToastRow({ item }: { item: ToastItem }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(item.message).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(console.error);
  };
  return (
    <div
      className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 shadow-md max-w-[480px] text-sm ${variantClasses[item.variant]}`}
    >
      <span className="flex-1 break-words whitespace-pre-wrap">{item.message}</span>
      <div className="flex items-center gap-1 shrink-0">
        <button
          className="opacity-60 hover:opacity-100 p-0.5 rounded hover:bg-black/5"
          onClick={copy}
          title="复制错误信息"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          className="opacity-60 hover:opacity-100 p-0.5 rounded hover:bg-black/5"
          onClick={() => dismiss(item.id)}
          title="关闭"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);

  useEffect(() => {
    const fn: Listener = (next) => setList(next);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  if (list.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {list.map((t) => (
        <ToastRow key={t.id} item={t} />
      ))}
    </div>
  );
}
