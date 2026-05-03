import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useInvokeQuery } from "../../hooks";
import { ChevronRightIcon, FileTextIcon } from "@radix-ui/react-icons";
import { useAtom } from "jotai";
import { sourceCollapsedDirsAtom } from "../../store";
import { LoadingState, EmptyState, ConfigPage } from "../../components/config";
import { DocumentReader, type DocumentItem } from "../../components/DocumentReader";
import type { DocNode, DocSource } from "../../types";

interface SourceViewProps {
  sourceId: string;
  initialDocPath?: string;
  onDocOpen: (docPath: string) => void;
  onDocClose: () => void;
}

interface FlatDoc extends DocumentItem {
  /** Forward-slash path relative to source root, used as stable key. */
  relPath: string;
}

/**
 * Depth-first flatten the tree. `group` is the parent dir path (relative to root)
 * so DocumentReader's existing grouped-list rendering still works.
 */
function flattenTree(nodes: DocNode[], rootPath: string, parentDir = ""): FlatDoc[] {
  const out: FlatDoc[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      const rel = node.path.startsWith(rootPath)
        ? node.path.slice(rootPath.length).replace(/^[/\\]+/, "")
        : node.name;
      out.push({
        name: node.name,
        path: node.path,
        group: parentDir || null,
        relPath: rel.replace(/\\/g, "/"),
      });
    } else {
      const nextDir = parentDir ? `${parentDir}/${node.name}` : node.name;
      out.push(...flattenTree(node.children, rootPath, nextDir));
    }
  }
  return out;
}

/** Recursive folder tree for the source landing page. */
function FolderTree({
  nodes,
  sourceId,
  depth = 0,
  onFileClick,
}: {
  nodes: DocNode[];
  sourceId: string;
  depth?: number;
  onFileClick: (path: string) => void;
}) {
  const [allCollapsed, setAllCollapsed] = useAtom(sourceCollapsedDirsAtom);
  const collapsed = useMemo(
    () => new Set(allCollapsed[sourceId] ?? []),
    [allCollapsed, sourceId]
  );
  const toggle = useCallback(
    (dirPath: string) => {
      setAllCollapsed((prev) => {
        const cur = new Set(prev[sourceId] ?? []);
        if (cur.has(dirPath)) cur.delete(dirPath);
        else cur.add(dirPath);
        return { ...prev, [sourceId]: Array.from(cur) };
      });
    },
    [sourceId, setAllCollapsed]
  );

  return (
    <div>
      {nodes.map((node) => {
        if (node.type === "dir") {
          const isCollapsed = collapsed.has(node.path);
          return (
            <div key={node.path}>
              <button
                onClick={() => toggle(node.path)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left text-sm hover:bg-card-alt transition-colors text-foreground"
                style={{ paddingLeft: `${depth * 14 + 8}px` }}
              >
                <ChevronRightIcon
                  className={`w-3.5 h-3.5 shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                />
                <span className="font-medium truncate">{node.name}</span>
                <span className="text-xs text-muted-foreground/60 ml-auto">{node.children.length}</span>
              </button>
              {!isCollapsed && (
                <FolderTree
                  nodes={node.children}
                  sourceId={sourceId}
                  depth={depth + 1}
                  onFileClick={onFileClick}
                />
              )}
            </div>
          );
        }
        return (
          <button
            key={node.path}
            onClick={() => onFileClick(node.path)}
            className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left text-sm hover:bg-card-alt transition-colors text-muted-foreground hover:text-foreground"
            style={{ paddingLeft: `${depth * 14 + 24}px` }}
          >
            <FileTextIcon className="w-3.5 h-3.5 shrink-0 opacity-60" />
            <span className="truncate">{node.name}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SourceView({ sourceId, initialDocPath, onDocOpen, onDocClose }: SourceViewProps) {
  const { data: sources = [] } = useInvokeQuery<DocSource[]>(["docSources"], "list_doc_sources");
  const source = sources.find((s) => s.id === sourceId);

  const { data: tree = [], isLoading: treeLoading } = useInvokeQuery<DocNode[]>(
    ["docTree", sourceId],
    "list_doc_tree",
    { sourceId }
  );

  const flat = useMemo<FlatDoc[]>(
    () => (source ? flattenTree(tree, source.path) : []),
    [tree, source]
  );

  const isDocView = !!initialDocPath;
  const currentIndex = isDocView ? flat.findIndex((d) => d.path === initialDocPath) : -1;

  const [docContent, setDocContent] = useState("");
  const [docLoading, setDocLoading] = useState(false);

  useEffect(() => {
    if (!isDocView || !initialDocPath) return;
    setDocLoading(true);
    invoke<string>("read_file", { path: initialDocPath })
      .then(setDocContent)
      .finally(() => setDocLoading(false));
  }, [isDocView, initialDocPath]);

  if (treeLoading) return <LoadingState message="Loading source..." />;

  if (!source) {
    return <EmptyState icon={FileTextIcon} message="Source not found" hint="It may have been removed." />;
  }

  if (isDocView && currentIndex >= 0) {
    return (
      <DocumentReader
        documents={flat}
        currentIndex={currentIndex}
        content={docContent}
        loading={docLoading}
        sourceName={source.name}
        onNavigate={(idx) => {
          const next = flat[idx];
          if (next) onDocOpen(next.path);
        }}
        onBack={onDocClose}
      />
    );
  }

  return (
    <ConfigPage>
      <div className="space-y-1">
        <div className="px-2 pb-2">
          <h2 className="font-serif text-2xl text-foreground">{source.name}</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {flat.length} docs · <span className="font-mono">{source.path}</span>
          </p>
        </div>
        {tree.length === 0 ? (
          <EmptyState
            icon={FileTextIcon}
            message="No markdown files"
            hint={`Add .md files under ${source.path}`}
          />
        ) : (
          <FolderTree nodes={tree} sourceId={sourceId} onFileClick={onDocOpen} />
        )}
      </div>
    </ConfigPage>
  );
}
