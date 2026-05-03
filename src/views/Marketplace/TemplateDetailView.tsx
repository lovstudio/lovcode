import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pencil1Icon, TrashIcon, ExternalLinkIcon, DotsHorizontalIcon, FileIcon, CopyIcon } from "@radix-ui/react-icons";
import type { TemplateComponent, TemplateCategory } from "../../types";
import { TEMPLATE_CATEGORIES } from "../../constants";
import { DetailCard, ConfigPage } from "../../components/config";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import { CodePreview } from "../../components/shared";
import { getAbsoluteParentPath } from "../../lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../components/ui/dropdown-menu";

function getLanguageForCategory(category: TemplateCategory): string {
  switch (category) {
    case "mcps":
    case "hooks":
    case "settings":
      return "json";
    case "statuslines":
      return "shell";
    default:
      return "markdown";
  }
}

/** Parse YAML frontmatter from markdown content */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\s*([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  match[1].split(/\r?\n/).forEach(line => {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && val) meta[key] = val;
    }
  });
  return { meta, body: match[2] };
}

interface TemplateDetailViewProps {
  template: TemplateComponent;
  category: TemplateCategory;
  onBack: () => void;
  onNavigateToInstalled?: () => void;
  localPath?: string;
  isInstalled?: boolean;
}

export function TemplateDetailView({
  template,
  category,
  onBack,
  onNavigateToInstalled,
  localPath,
  isInstalled: initiallyInstalled,
}: TemplateDetailViewProps) {

  const [installing, setInstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [installed, setInstalled] = useState(initiallyInstalled ?? false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Skip check if we already know it's installed
    if (initiallyInstalled !== undefined) return;

    if (category === "mcps") {
      invoke<boolean>("check_mcp_installed", { name: template.name }).then(setInstalled);
    } else if (category === "skills") {
      invoke<boolean>("check_skill_installed", { name: template.name }).then(setInstalled);
    }
  }, [category, template.name, initiallyInstalled]);

  const handleUninstall = async () => {
    setUninstalling(true);
    setError(null);

    try {
      if (category === "mcps") {
        await invoke("uninstall_mcp_template", { name: template.name });
      } else if (category === "skills") {
        await invoke("uninstall_skill", { name: template.name });
      }
      setInstalled(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setUninstalling(false);
    }
  };

  const handleInstall = async () => {
    if (!template.content) {
      setError("No content available for this template");
      return;
    }

    setInstalling(true);
    setError(null);

    try {
      switch (category) {
        case "commands":
        case "agents":
          await invoke("install_command_template", {
            name: template.name,
            content: template.content,
          });
          break;
        case "skills":
          await invoke("install_skill_template", {
            name: template.name,
            content: template.content,
            source_id: template.source_id,
            source_name: template.source_name,
            author: template.author,
            downloads: template.downloads,
            template_path: template.path,
          });
          break;
        case "mcps":
          await invoke("install_mcp_template", { name: template.name, config: template.content });
          break;
        case "hooks":
          await invoke("install_hook_template", { name: template.name, config: template.content });
          break;
        case "settings":
        case "output-styles":
          await invoke("install_setting_template", { config: template.content });
          break;
        case "statuslines":
          // Install to ~/.lovstudio/lovcode/statusline/{name}.sh
          await invoke("install_statusline_template", { name: template.name, content: template.content });
          break;
      }
      setInstalled(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  const categoryInfo = TEMPLATE_CATEGORIES.find((c) => c.key === category);
  const filePath = localPath || template.path;
  const contentCwd = getAbsoluteParentPath(filePath);

  const handleReveal = () => invoke("reveal_path", { path: filePath });
  const handleOpenFile = () => invoke("open_path", { path: filePath });
  const handleCopyPath = () => invoke("copy_to_clipboard", { text: filePath });

  return (
    <ConfigPage>
      <header className="mb-6">
        <button
          onClick={onBack}
          className="text-muted-foreground hover:text-ink mb-2 flex items-center gap-1 text-sm"
        >
          <span>←</span> {categoryInfo?.label}
        </button>
        {/* Title row: title + badges + actions */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <h1 className="font-serif text-2xl font-semibold text-ink truncate">{template.name}</h1>
            {installed && (
              <span className="text-xs px-2 py-0.5 rounded-full border border-primary/30 text-primary shrink-0">
                Installed
              </span>
            )}
          </div>
          {/* Action buttons */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Primary Install button when not installed */}
            {!installed && (
              <button
                onClick={handleInstall}
                disabled={installing}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {installing ? "Installing..." : "Install"}
              </button>
            )}
            {/* Three-dot menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="p-2 rounded-xl hover:bg-card-alt text-muted-foreground hover:text-ink">
                  <DotsHorizontalIcon className="w-5 h-5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
              {localPath && (
                <DropdownMenuItem onClick={() => invoke("open_in_editor", { path: localPath })}>
                  <Pencil1Icon className="w-4 h-4 mr-2" />
                  Open in Editor
                </DropdownMenuItem>
              )}
              {installed && onNavigateToInstalled && (
                <DropdownMenuItem onClick={onNavigateToInstalled}>
                  <ExternalLinkIcon className="w-4 h-4 mr-2" />
                  View Installed
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleReveal}>
                <ExternalLinkIcon className="w-4 h-4 mr-2" />
                Reveal in Finder
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleOpenFile}>
                <FileIcon className="w-4 h-4 mr-2" />
                Open File
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyPath}>
                <CopyIcon className="w-4 h-4 mr-2" />
                Copy Path
              </DropdownMenuItem>
              {installed && (category === "mcps" || category === "skills") && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleUninstall}
                    disabled={uninstalling}
                    className="text-destructive focus:text-destructive"
                  >
                    <TrashIcon className="w-4 h-4 mr-2" />
                    {uninstalling ? "Uninstalling..." : "Uninstall"}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </div>
        {/* Description */}
        {template.description && (
          <p className="text-muted-foreground mt-3">{template.description}</p>
        )}
        {/* Metadata row */}
        <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1.5">
            {categoryInfo?.label}
          </span>
          {template.author && (
            <>
              <span>•</span>
              <span>by {template.author}</span>
            </>
          )}
          {template.downloads != null && (
            <>
              <span>•</span>
              <span>↓ {template.downloads}</span>
            </>
          )}
        </div>
        {error && (
          <div className="mt-4 p-3 bg-primary/10 text-primary rounded-xl text-sm">{error}</div>
        )}
      </header>

      {template.content && (
        <DetailCard label="Content Preview">
          {category === "mcps" || category === "hooks" || category === "settings" || category === "statuslines" ? (
            <CodePreview value={template.content} language={getLanguageForCategory(category)} height={400} />
          ) : (() => {
              const { meta, body } = parseFrontmatter(template.content);
              const metaKeys = Object.keys(meta);
              return (
                <>
                  {metaKeys.length > 0 && (
                    <div className="mb-4 p-3 bg-card-alt rounded-lg border border-border">
                      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                        {metaKeys.map(key => (
                          <div key={key} className="contents">
                            <span className="text-muted-foreground">{key}</span>
                            <span className="text-ink">{meta[key]}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <MarkdownRenderer
                    content={body}
                    cwd={contentCwd}
                    className="max-w-none prose-sm prose-neutral prose-pre:bg-card-alt prose-pre:text-ink prose-code:text-ink"
                  />
                </>
              );
            })()}
        </DetailCard>
      )}
    </ConfigPage>
  );
}
