import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useQueryClient } from "../../hooks";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../../components/ui/dialog";
import { toast } from "../../components/ui/toast";
import { invalidateCwdValidity } from "./useCwdValidity";
import { Loader2, FolderSearch, FolderOpen, Check } from "lucide-react";

interface RelocationCandidate {
  path: string;
  source: string; // "spotlight" | "ancestor"
  full_match: boolean;
}

interface RelocationResult {
  nearest_existing_ancestor: string | null;
  lost_root: string | null;
  tail: string;
  candidates: RelocationCandidate[];
}

interface Props {
  from: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RelocateSessionDialog({ from, open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<RelocationResult | null>(null);
  const [migrating, setMigrating] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setAnalysis(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    invoke<RelocationResult>("find_relocation_candidates", { from })
      .then((r) => {
        if (!cancelled) setAnalysis(r);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
        toast.error(`分析失败: ${msg}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, from]);

  const runMigration = async (to: string) => {
    setMigrating(to);
    try {
      const result = await invoke<{
        success: boolean;
        stdout: string;
        stderr: string;
        migrated: number | null;
      }>("migrate_session_cwd", { from, to });

      if (result.success) {
        toast.success(
          result.migrated != null
            ? `已迁移 ${result.migrated} 个会话历史到新路径`
            : "迁移完成",
        );
        invalidateCwdValidity();
        // Force refetch (the global staleTime: Infinity makes plain invalidate a no-op for refetch).
        await queryClient.refetchQueries({ queryKey: ["sessions"] });
        await queryClient.refetchQueries({ queryKey: ["projects"] });
        onOpenChange(false);
      } else {
        toast.error(`cc-mv 失败:\n${result.stderr || result.stdout || "(no output)"}`);
      }
    } catch (err) {
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
      toast.error(`迁移失败: ${msg}`);
    } finally {
      setMigrating(null);
    }
  };

  const handlePickManually = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "选择项目的新位置",
    });
    if (!picked || typeof picked !== "string") return;
    runMigration(picked);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>重定位会话</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground mb-1">原路径</div>
            <div className="font-mono text-xs break-all bg-card-alt rounded px-2 py-1.5">{from}</div>
          </div>

          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground py-3">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>正在分析路径并搜索候选位置…</span>
            </div>
          )}

          {analysis && !loading && (
            <>
              {analysis.nearest_existing_ancestor && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">最近存在的祖先目录</div>
                  <div className="font-mono text-xs break-all opacity-70">{analysis.nearest_existing_ancestor}</div>
                </div>
              )}

              {analysis.lost_root && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">丢失的目录段</div>
                  <div className="font-mono text-xs break-all">
                    <span className="text-red-700">{lastSegment(analysis.lost_root)}</span>
                    {analysis.tail && <span className="opacity-50">/{analysis.tail}</span>}
                  </div>
                </div>
              )}

              <div>
                <div className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                  <FolderSearch className="w-3.5 h-3.5" />
                  Spotlight 搜索结果
                  {analysis.candidates.length > 0 && (
                    <span className="opacity-70">({analysis.candidates.length})</span>
                  )}
                </div>
                {analysis.candidates.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">没有找到匹配项</div>
                ) : (
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {analysis.candidates.map((c) => (
                      <button
                        key={c.path}
                        onClick={() => runMigration(c.path)}
                        disabled={!!migrating}
                        className={`w-full text-left px-2.5 py-1.5 rounded border transition-colors disabled:opacity-50 ${
                          c.full_match
                            ? "border-green-300 bg-green-50 hover:bg-green-100"
                            : "border-border bg-card hover:bg-card-alt"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          {c.full_match ? (
                            <Check className="w-3.5 h-3.5 mt-0.5 text-green-700 shrink-0" />
                          ) : (
                            <FolderOpen className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-xs break-all">{c.path}</div>
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              {c.full_match ? "完整路径存在" : "仅根目录存在（tail 不匹配）"}
                              {migrating === c.path && " · 迁移中…"}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <button
            onClick={handlePickManually}
            disabled={!!migrating}
            className="px-3 py-1.5 text-sm rounded border border-border bg-card hover:bg-card-alt disabled:opacity-50"
          >
            手动选择目录…
          </button>
          <button
            onClick={() => onOpenChange(false)}
            className="px-3 py-1.5 text-sm rounded text-muted-foreground hover:text-ink"
          >
            取消
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function lastSegment(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
