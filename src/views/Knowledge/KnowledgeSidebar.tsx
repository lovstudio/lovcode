import { useState } from "react";
import { LightningBoltIcon, PlusIcon, FileTextIcon, GitHubLogoIcon, EyeNoneIcon, EyeOpenIcon, Pencil1Icon, TrashIcon, DotsHorizontalIcon } from "@radix-ui/react-icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useInvokeQuery, useQueryClient } from "../../hooks";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "../../components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator } from "../../components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import type { FeatureType, DocSource } from "@/types";

interface KnowledgeSidebarProps {
  currentFeature: FeatureType | null;
  currentSourceId?: string | null;
  onFeatureClick: (feature: FeatureType) => void;
  onSourceClick?: (sourceId: string) => void;
}

export function KnowledgeSidebar({
  currentFeature,
  currentSourceId,
  onFeatureClick,
  onSourceClick,
}: KnowledgeSidebarProps) {
  const queryClient = useQueryClient();
  const { data: sources = [] } = useInvokeQuery<DocSource[]>(["docSources"], "list_doc_sources");
  const [renameTarget, setRenameTarget] = useState<DocSource | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [githubDialog, setGithubDialog] = useState(false);
  const [githubRepo, setGithubRepo] = useState("");
  const [githubSubPath, setGithubSubPath] = useState("");
  const [githubSubmitting, setGithubSubmitting] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["docSources"] });

  const visibleSources = showHidden ? sources : sources.filter((s) => !s.hidden);

  const handleAddVault = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: "Choose Obsidian vault folder" });
    if (!picked || typeof picked !== "string") return;
    try {
      await invoke<DocSource>("add_vault_source", { path: picked });
      refresh();
    } catch (e) {
      alert(`Failed to add vault: ${e}`);
    }
  };

  const handleAddGithub = async () => {
    if (!githubRepo.trim()) return;
    setGithubSubmitting(true);
    try {
      await invoke<DocSource>("add_github_doc_source", {
        repo: githubRepo.trim(),
        subPath: githubSubPath.trim() || null,
      });
      setGithubRepo("");
      setGithubSubPath("");
      setGithubDialog(false);
      refresh();
    } catch (e) {
      alert(`Failed to add GitHub source: ${e}`);
    } finally {
      setGithubSubmitting(false);
    }
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    try {
      await invoke<DocSource>("update_doc_source", { update: { id: renameTarget.id, name: trimmed } });
      refresh();
    } catch (e) {
      alert(`Rename failed: ${e}`);
    }
    setRenameTarget(null);
  };

  const handleToggleHidden = async (src: DocSource) => {
    try {
      await invoke<DocSource>("update_doc_source", { update: { id: src.id, hidden: !src.hidden } });
      refresh();
    } catch (e) {
      alert(`Failed: ${e}`);
    }
  };

  const handleRemove = async (src: DocSource, deleteFiles: boolean) => {
    const label = deleteFiles ? `Remove "${src.name}" AND delete files on disk?` : `Remove "${src.name}" from sidebar?`;
    if (!confirm(label)) return;
    try {
      await invoke("remove_doc_source", { id: src.id, deleteFiles });
      refresh();
    } catch (e) {
      alert(`Failed: ${e}`);
    }
  };

  const handleRefresh = async (src: DocSource) => {
    try {
      await invoke<DocSource>("refresh_doc_source", { id: src.id });
      refresh();
      queryClient.invalidateQueries({ queryKey: ["docTree", src.id] });
    } catch (e) {
      alert(`Refresh failed: ${e}`);
    }
  };

  const isSourceActive = (id: string) => currentSourceId === id;
  const isDistillActive = currentFeature === "kb-distill";

  return (
    <aside className="w-56 shrink-0 border-r border-border bg-card overflow-y-auto flex flex-col">
      <div className="p-3 flex-1">
        <div className="flex items-center justify-between px-2 mb-2">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Knowledge
          </h2>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="p-1 rounded hover:bg-card-alt text-muted-foreground hover:text-foreground transition-colors"
                title="Add knowledge source"
              >
                <PlusIcon className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={handleAddVault}>
                <FileTextIcon className="w-4 h-4 mr-2" />
                Add Obsidian vault…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setGithubDialog(true)}>
                <GitHubLogoIcon className="w-4 h-4 mr-2" />
                Add from GitHub repo…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setShowHidden((v) => !v)}>
                {showHidden ? <EyeNoneIcon className="w-4 h-4 mr-2" /> : <EyeOpenIcon className="w-4 h-4 mr-2" />}
                {showHidden ? "Hide hidden sources" : "Show hidden sources"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <nav className="flex flex-col gap-0.5">
          <button
            onClick={() => onFeatureClick("kb-distill")}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm transition-colors ${
              isDistillActive
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-card-alt"
            }`}
          >
            <LightningBoltIcon className="w-4 h-4 shrink-0" />
            <span className="truncate">Distill</span>
          </button>

          {visibleSources.length > 0 && (
            <div className="pt-2 mt-1 border-t border-border" />
          )}

          {visibleSources.map((src) => {
            const active = isSourceActive(src.id);
            return (
              <ContextMenu key={src.id}>
                <ContextMenuTrigger asChild>
                  <div
                    className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${
                      active
                        ? "bg-primary/10 text-primary"
                        : src.hidden
                          ? "text-muted-foreground/50 hover:text-muted-foreground hover:bg-card-alt"
                          : "text-muted-foreground hover:text-foreground hover:bg-card-alt"
                    }`}
                  >
                    <button
                      onClick={() => onSourceClick?.(src.id)}
                      onDoubleClick={() => {
                        setRenameTarget(src);
                        setRenameValue(src.name);
                      }}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                      title={`${src.path}${src.hidden ? " (hidden)" : ""}`}
                    >
                      {src.kind === "github" ? (
                        <GitHubLogoIcon className="w-4 h-4 shrink-0" />
                      ) : (
                        <FileTextIcon className="w-4 h-4 shrink-0" />
                      )}
                      <span className="truncate">{src.name}</span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-card transition-opacity"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <DotsHorizontalIcon className="w-3.5 h-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onSelect={() => { setRenameTarget(src); setRenameValue(src.name); }}>
                          <Pencil1Icon className="w-3.5 h-3.5 mr-2" /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => handleToggleHidden(src)}>
                          {src.hidden ? <EyeOpenIcon className="w-3.5 h-3.5 mr-2" /> : <EyeNoneIcon className="w-3.5 h-3.5 mr-2" />}
                          {src.hidden ? "Unhide" : "Hide"}
                        </DropdownMenuItem>
                        {src.kind === "github" && (
                          <DropdownMenuItem onSelect={() => handleRefresh(src)}>
                            Refresh from GitHub
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        {src.kind !== "bundled" && (
                          <DropdownMenuItem onSelect={() => handleRemove(src, false)}>
                            <TrashIcon className="w-3.5 h-3.5 mr-2" /> Remove from sidebar
                          </DropdownMenuItem>
                        )}
                        {(src.kind === "github" || src.kind === "symlink") && (
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => handleRemove(src, true)}
                          >
                            <TrashIcon className="w-3.5 h-3.5 mr-2" /> Remove and delete files
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => { setRenameTarget(src); setRenameValue(src.name); }}>
                    Rename
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => handleToggleHidden(src)}>
                    {src.hidden ? "Unhide" : "Hide"}
                  </ContextMenuItem>
                  {src.kind === "github" && (
                    <ContextMenuItem onSelect={() => handleRefresh(src)}>Refresh from GitHub</ContextMenuItem>
                  )}
                  {src.kind !== "bundled" && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => handleRemove(src, false)}>Remove</ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </nav>
      </div>

      {renameTarget && (
        <Dialog open onOpenChange={(o) => !o && setRenameTarget(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader><DialogTitle>Rename source</DialogTitle></DialogHeader>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setRenameTarget(null); }}
              autoFocus
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
              <Button onClick={handleRename}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {githubDialog && (
        <Dialog open onOpenChange={(o) => !o && setGithubDialog(false)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader><DialogTitle>Add docs from GitHub</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">Repo (owner/name or URL)</label>
                <Input
                  value={githubRepo}
                  onChange={(e) => setGithubRepo(e.target.value)}
                  placeholder="anthropics/claude-code"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Sub-path (optional)</label>
                <Input
                  value={githubSubPath}
                  onChange={(e) => setGithubSubPath(e.target.value)}
                  placeholder="docs"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setGithubDialog(false)}>Cancel</Button>
              <Button onClick={handleAddGithub} disabled={githubSubmitting || !githubRepo.trim()}>
                {githubSubmitting ? "Fetching..." : "Add"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </aside>
  );
}
