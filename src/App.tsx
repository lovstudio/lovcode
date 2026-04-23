import { useState, useEffect, useCallback, useRef } from "react";
// Radix icons
import { PersonIcon } from "@radix-ui/react-icons";
import { GlobalHeader, VerticalFeatureTabs } from "./components/GlobalHeader";
import { UpdateChecker } from "./components/UpdateChecker";
import { setAutoCopyOnSelect, getAutoCopyOnSelect } from "./components/Terminal";
import { Switch } from "./components/ui/switch";
import { Avatar, AvatarImage, AvatarFallback } from "./components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Button } from "./components/ui/button";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Modular imports
import type { FeatureType, View, LocalCommand, UserProfile } from "./types";
import { useAtom } from "jotai";
import { marketplaceCategoryAtom, shortenPathsAtom, profileAtom, navigationStateAtom, viewAtom, viewHistoryAtom, historyIndexAtom, featureTabsLayoutAtom, workspaceDataAtom } from "./store";
import { AppConfigContext, useAppConfig, type AppConfig } from "./context";
import { useUrlInit } from "./hooks";
// Modular views
import {
  WorkspaceView,
  FeaturesView,
  FeaturesLayout,
  OutputStylesView,
  StatuslineView,
  SubAgentsView,
  SubAgentDetailView,
  SkillsView,
  HooksView,
  McpView,
  FeatureTodo,
  CommandsView,
  CommandDetailView,
  MarketplaceView,
  MarketplaceLayout,
  TemplateDetailView,
  DistillView,
  DistillDetailView,
  ReferenceView,
  KnowledgeLayout,
  SettingsView,
  EnvSettingsView,
  LlmProviderView,
  MaasRegistryView,
  ClaudeVersionView,
  ContextFilesView,
  ProjectList,
  SessionList,
  MessageView,
  AnnualReport2025,
} from "./views";

// ============================================================================
// App Component
// ============================================================================

function App() {
  // Initialize navigation state from URL on page load (no loading state)
  useUrlInit();

  const [view] = useAtom(viewAtom);
  const [viewHistory] = useAtom(viewHistoryAtom);
  const [historyIndex] = useAtom(historyIndexAtom);
  const [, setNavigationState] = useAtom(navigationStateAtom);

  const navigate = useCallback((newView: View) => {
    setNavigationState(prev => {
      const newHistory = prev.history.slice(0, prev.index + 1);
      newHistory.push(newView);
      let newIndex = prev.index + 1;
      if (newHistory.length > 50) {
        newHistory.shift();
        newIndex = 49;
      }
      return { history: newHistory, index: newIndex };
    });
  }, [setNavigationState]);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < viewHistory.length - 1;

  const goBack = useCallback(() => {
    setNavigationState(prev => {
      if (prev.index > 0) {
        return { ...prev, index: prev.index - 1 };
      }
      return prev;
    });
  }, [setNavigationState]);

  const goForward = useCallback(() => {
    setNavigationState(prev => {
      if (prev.index < prev.history.length - 1) {
        return { ...prev, index: prev.index + 1 };
      }
      return prev;
    });
  }, [setNavigationState]);

  const [featureTabsLayout] = useAtom(featureTabsLayoutAtom);
  const [workspace] = useAtom(workspaceDataAtom);
  const [marketplaceCategory, setMarketplaceCategory] = useAtom(marketplaceCategoryAtom);
  const [homeDir, setHomeDir] = useState("");
  const [shortenPaths, setShortenPaths] = useAtom(shortenPathsAtom);
  const [showSettings, setShowSettings] = useState(false);
  const [profile, setProfile] = useAtom(profileAtom);
  const [showProfileDialog, setShowProfileDialog] = useState(false);
  const [distillWatchEnabled, setDistillWatchEnabled] = useState(true);

  useEffect(() => {
    invoke<string>("get_home_dir").then(setHomeDir).catch(() => {});
    invoke<boolean>("get_distill_watch_enabled").then(setDistillWatchEnabled).catch(() => {});
  }, []);


  useEffect(() => {
    const unlisten = listen("menu-settings", () => setShowSettings(true));
    return () => { unlisten.then(fn => fn()); };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        window.dispatchEvent(new Event("app:before-reload"));
        setTimeout(() => window.location.reload(), 50);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const formatPath = useCallback((path: string) => {
    if (shortenPaths && homeDir && path.startsWith(homeDir)) {
      return "~" + path.slice(homeDir.length);
    }
    return path;
  }, [shortenPaths, homeDir]);

  const appConfig: AppConfig = { homeDir, shortenPaths, setShortenPaths, formatPath };

  const currentFeature: FeatureType | null =
    view.type === "chat-projects" || view.type === "chat-sessions" || view.type === "chat-messages"
      ? "chat"
      : view.type === "workspace"
        ? "workspace"
        : view.type === "features"
        ? "features"
        : view.type === "basic-env"
        ? "basic-env"
        : view.type === "basic-llm"
        ? "basic-llm"
        : view.type === "basic-maas"
        ? "basic-maas"
        : view.type === "basic-version"
        ? "basic-version"
        : view.type === "basic-context"
        ? "basic-context"
        : view.type === "settings"
        ? "settings"
        : view.type === "commands" || view.type === "command-detail"
          ? "commands"
          : view.type === "mcp"
            ? "mcp"
            : view.type === "skills"
              ? "skills"
              : view.type === "hooks"
                ? "hooks"
                : view.type === "sub-agents" || view.type === "sub-agent-detail"
                  ? "sub-agents"
                  : view.type === "output-styles"
                    ? "output-styles"
                    : view.type === "statusline"
                      ? "statusline"
                      : view.type === "kb-distill" || view.type === "kb-distill-detail"
                      ? "kb-distill"
                      : view.type === "kb-reference" || view.type === "kb-reference-doc"
                        ? "kb-reference"
                        : view.type === "feature-template-detail"
                        ? view.fromFeature
                        : view.type === "marketplace" || view.type === "template-detail"
                        ? "marketplace"
                        : view.type === "feature-todo"
                          ? view.feature
                          : null;

  const handleFeatureClick = (feature: FeatureType) => {
    switch (feature) {
      case "chat":
        navigate({ type: "chat-projects" });
        break;
      case "basic-env":
        navigate({ type: "basic-env" });
        break;
      case "basic-llm":
        navigate({ type: "basic-llm" });
        break;
      case "basic-maas":
        navigate({ type: "basic-maas" });
        break;
      case "basic-version":
        navigate({ type: "basic-version" });
        break;
      case "basic-context":
        navigate({ type: "basic-context" });
        break;
      case "settings":
        navigate({ type: "settings" });
        break;
      case "commands":
        navigate({ type: "commands" });
        break;
      case "mcp":
        navigate({ type: "mcp" });
        break;
      case "skills":
        navigate({ type: "skills" });
        break;
      case "hooks":
        navigate({ type: "hooks" });
        break;
      case "sub-agents":
        navigate({ type: "sub-agents" });
        break;
      case "output-styles":
        navigate({ type: "output-styles" });
        break;
      case "statusline":
        navigate({ type: "statusline" });
        break;
      case "kb-distill":
        navigate({ type: "kb-distill" });
        break;
      case "kb-reference":
        navigate({ type: "kb-reference" });
        break;
      case "workspace":
        navigate({ type: "workspace" });
        break;
      case "features":
        navigate({ type: "features" });
        break;
      default:
        navigate({ type: "feature-todo", feature });
    }
  };

  return (
    <AppConfigContext.Provider value={appConfig}>
      <div className="h-screen bg-canvas flex flex-col">
        <GlobalHeader
          currentFeature={currentFeature}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={goBack}
          onGoForward={goForward}
          onFeatureClick={handleFeatureClick}
          onShowProfileDialog={() => setShowProfileDialog(true)}
          onShowSettings={() => setShowSettings(true)}
        />
        <div className="flex-1 flex overflow-hidden">
        {/* Vertical Feature Tabs Sidebar */}
        {featureTabsLayout === "vertical" && workspace && <VerticalFeatureTabs />}
        <main className="flex-1 overflow-auto">
        {view.type === "annual-report-2025" && (
          <AnnualReport2025 onClose={() => navigate({ type: "home" })} />
        )}
        {view.type === "workspace" && <WorkspaceView />}
        {view.type === "features" && <FeaturesView onFeatureClick={handleFeatureClick} currentFeature={currentFeature} />}
        {view.type === "chat-projects" && (
          <ProjectList
            onSelectProject={(p) => navigate({ type: "chat-sessions", projectId: p.id, projectPath: p.path })}
            onSelectSession={(s) => navigate({ type: "chat-messages", projectId: s.project_id, projectPath: s.project_path || '', sessionId: s.id, summary: s.summary })}
            onSelectChat={(c) => navigate({ type: "chat-messages", projectId: c.project_id, projectPath: c.project_path, sessionId: c.session_id, summary: c.session_summary })}
          />
        )}
        {view.type === "chat-sessions" && (
          <SessionList
            projectId={view.projectId}
            projectPath={view.projectPath}
            onBack={() => navigate({ type: "chat-projects" })}
            onSelect={(s) => navigate({ type: "chat-messages", projectId: s.project_id, projectPath: s.project_path || '', sessionId: s.id, summary: s.summary })}
          />
        )}
        {view.type === "chat-messages" && (
          <MessageView
            projectId={view.projectId}
            projectPath={view.projectPath}
            sessionId={view.sessionId}
            summary={view.summary}
            onBack={() => navigate({ type: "chat-sessions", projectId: view.projectId, projectPath: view.projectPath })}
          />
        )}
        {(view.type === "basic-env" || view.type === "basic-llm" || view.type === "basic-maas" || view.type === "basic-version" || view.type === "basic-context" ||
          view.type === "settings" || view.type === "commands" || view.type === "command-detail" || view.type === "mcp" ||
          view.type === "skills" || view.type === "hooks" ||
          view.type === "sub-agents" || view.type === "sub-agent-detail" || view.type === "output-styles" ||
          view.type === "statusline" || view.type === "feature-template-detail") && (
          <FeaturesLayout currentFeature={currentFeature} onFeatureClick={handleFeatureClick}>
            {view.type === "basic-env" && <EnvSettingsView />}
            {view.type === "basic-llm" && <LlmProviderView />}
            {view.type === "basic-maas" && <MaasRegistryView />}
            {view.type === "basic-version" && <ClaudeVersionView />}
            {view.type === "basic-context" && <ContextFilesView />}
            {view.type === "settings" && (
              <SettingsView
                onMarketplaceSelect={(template) => navigate({ type: "feature-template-detail", template, category: "settings", fromFeature: "settings" })}
              />
            )}
            {view.type === "commands" && (
              <CommandsView
                onSelect={(cmd, scrollToChangelog) => navigate({ type: "command-detail", command: cmd, scrollToChangelog })}
                onMarketplaceSelect={(template) => navigate({ type: "feature-template-detail", template, category: "commands", fromFeature: "commands" })}
              />
            )}
            {view.type === "command-detail" && (
              <CommandDetailView
                command={view.command}
                onBack={() => navigate({ type: "commands" })}
                onCommandUpdated={() => {}}
                onRenamed={async (newPath: string) => {
                  const commands = await invoke<LocalCommand[]>("list_local_commands");
                  const cmd = commands.find(c => c.path === newPath);
                  if (cmd) navigate({ type: "command-detail", command: cmd });
                }}
                scrollToChangelog={view.scrollToChangelog}
              />
            )}
            {view.type === "mcp" && (
              <McpView
                onMarketplaceSelect={(template) => navigate({ type: "feature-template-detail", template, category: "mcps", fromFeature: "mcp" })}
              />
            )}
            {view.type === "skills" && (
              <SkillsView
                onSelectTemplate={(template, localPath) => navigate({ type: "feature-template-detail", template, category: "skills", fromFeature: "skills", localPath, isInstalled: true })}
                onMarketplaceSelect={(template) => navigate({ type: "feature-template-detail", template, category: "skills", fromFeature: "skills" })}
              />
            )}
            {view.type === "hooks" && (
              <HooksView
                onMarketplaceSelect={(template) => navigate({ type: "feature-template-detail", template, category: "hooks", fromFeature: "hooks" })}
              />
            )}
            {view.type === "sub-agents" && (
              <SubAgentsView
                onSelect={(agent) => navigate({ type: "sub-agent-detail", agent })}
                onMarketplaceSelect={(template) => navigate({ type: "feature-template-detail", template, category: "agents", fromFeature: "sub-agents" })}
              />
            )}
            {view.type === "sub-agent-detail" && <SubAgentDetailView agent={view.agent} onBack={() => navigate({ type: "sub-agents" })} />}
            {view.type === "output-styles" && (
              <OutputStylesView
                onMarketplaceSelect={(template) => navigate({ type: "feature-template-detail", template, category: "output-styles", fromFeature: "output-styles" })}
              />
            )}
            {view.type === "statusline" && (
              <StatuslineView
                onMarketplaceSelect={(template) => navigate({ type: "feature-template-detail", template, category: "statuslines", fromFeature: "statusline" })}
              />
            )}
            {view.type === "feature-template-detail" && (
              <TemplateDetailView
                template={view.template}
                category={view.category}
                onBack={() => handleFeatureClick(view.fromFeature)}
                localPath={view.localPath}
                isInstalled={view.isInstalled}
              />
            )}
          </FeaturesLayout>
        )}
        {(view.type === "kb-distill" || view.type === "kb-distill-detail" || view.type === "kb-reference" || view.type === "kb-reference-doc") && (
          <KnowledgeLayout currentFeature={currentFeature} onFeatureClick={handleFeatureClick}>
            {view.type === "kb-distill" && (
              <DistillView
                onSelect={(doc) => navigate({ type: "kb-distill-detail", document: doc })}
                watchEnabled={distillWatchEnabled}
                onWatchToggle={(enabled) => {
                  setDistillWatchEnabled(enabled);
                  invoke("set_distill_watch_enabled", { enabled });
                }}
              />
            )}
            {view.type === "kb-distill-detail" && (
              <DistillDetailView
                document={view.document}
                onBack={() => navigate({ type: "kb-distill" })}
                onNavigateSession={(projectId, projectPath, sessionId, summary) => navigate({ type: "chat-messages", projectId, projectPath, sessionId, summary })}
              />
            )}
            {(view.type === "kb-reference" || view.type === "kb-reference-doc") && (
              <ReferenceView
                initialSource={view.type === "kb-reference-doc" ? view.source : undefined}
                initialDocIndex={view.type === "kb-reference-doc" ? view.docIndex : undefined}
                onDocOpen={(source, docIndex) => navigate({ type: "kb-reference-doc", source, docIndex })}
                onDocClose={() => navigate({ type: "kb-reference" })}
              />
            )}
          </KnowledgeLayout>
        )}
        {(view.type === "marketplace" || view.type === "template-detail") && (
          <MarketplaceLayout
            currentCategory={view.type === "marketplace" ? (view.category ?? marketplaceCategory) : view.category}
            onCategoryClick={(category) => navigate({ type: "marketplace", category })}
          >
            {view.type === "marketplace" && (
              <MarketplaceView
                initialCategory={view.category ?? marketplaceCategory}
                onSelectTemplate={(template, category) => {
                  setMarketplaceCategory(category);
                  navigate({ type: "template-detail", template, category });
                }}
              />
            )}
            {view.type === "template-detail" && (
              <TemplateDetailView
                template={view.template}
                category={view.category}
                onBack={() => navigate({ type: "marketplace", category: marketplaceCategory })}
                onNavigateToInstalled={view.category === "mcps" ? () => navigate({ type: "mcp" }) : undefined}
              />
            )}
          </MarketplaceLayout>
        )}
        {view.type === "feature-todo" && <FeatureTodo feature={view.feature} />}
        </main>
        </div>
      </div>
    <AppSettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />
    <ProfileDialog open={showProfileDialog} onClose={() => setShowProfileDialog(false)} profile={profile} onSave={setProfile} />
    <UpdateChecker />
    </AppConfigContext.Provider>
  );
}

// ============================================================================
// App Settings Dialog
// ============================================================================

function AppSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { shortenPaths, setShortenPaths } = useAppConfig();
  const [autoCopy, setAutoCopy] = useState(getAutoCopyOnSelect);
  const [featureTabsLayout, setFeatureTabsLayout] = useAtom(featureTabsLayoutAtom);

  const handleAutoCopyChange = (checked: boolean) => {
    setAutoCopy(checked);
    setAutoCopyOnSelect(checked);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-xl border border-border shadow-xl w-96 max-w-[90vw]">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Settings</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-ink text-xl leading-none">&times;</button>
        </div>
        <div className="p-5 space-y-5">
          {/* Display */}
          <div className="space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Display</h3>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink">Shorten paths</p>
                <p className="text-xs text-muted-foreground">Replace home directory with ~</p>
              </div>
              <Switch checked={shortenPaths} onCheckedChange={setShortenPaths} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink">Project tabs layout</p>
                <p className="text-xs text-muted-foreground">Position of project/feature tabs</p>
              </div>
              <div className="flex gap-0.5 p-0.5 bg-muted rounded-lg">
                <button
                  onClick={() => setFeatureTabsLayout("horizontal")}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    featureTabsLayout === "horizontal"
                      ? "bg-background text-ink shadow-sm"
                      : "text-muted-foreground hover:text-ink"
                  }`}
                >
                  Horizontal
                </button>
                <button
                  onClick={() => setFeatureTabsLayout("vertical")}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    featureTabsLayout === "vertical"
                      ? "bg-background text-ink shadow-sm"
                      : "text-muted-foreground hover:text-ink"
                  }`}
                >
                  Vertical
                </button>
              </div>
            </div>
          </div>
          {/* Terminal */}
          <div className="space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Terminal</h3>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink">Auto copy on select</p>
                <p className="text-xs text-muted-foreground">Copy terminal selection to clipboard</p>
              </div>
              <Switch checked={autoCopy} onCheckedChange={handleAutoCopyChange} />
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Profile Dialog
// ============================================================================

function ProfileDialog({
  open,
  onClose,
  profile,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  profile: UserProfile;
  onSave: (profile: UserProfile) => void;
}) {
  const [nickname, setNickname] = useState(profile.nickname);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setNickname(profile.nickname);
      setAvatarUrl(profile.avatarUrl);
    }
  }, [open, profile]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => setAvatarUrl(event.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleSave = () => {
    onSave({ nickname, avatarUrl });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="flex flex-col items-center gap-3">
            <div className="relative cursor-pointer group" onClick={() => fileInputRef.current?.click()}>
              <Avatar className="h-20 w-20">
                {avatarUrl ? <AvatarImage src={avatarUrl} alt={nickname || "User"} /> : null}
                <AvatarFallback className="bg-primary/10 text-primary text-2xl">
                  {nickname ? nickname.charAt(0).toUpperCase() : <PersonIcon className="w-8 h-8" />}
                </AvatarFallback>
              </Avatar>
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="text-white text-xs">Upload</span>
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
            <p className="text-xs text-muted-foreground">Click avatar to upload</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="nickname">Nickname</Label>
            <Input id="nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Enter your nickname" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default App;
