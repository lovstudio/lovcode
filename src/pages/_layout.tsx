/**
 * Root Layout - wraps all pages
 *
 * This is the shared layout for all routes.
 * Contains header, sidebar, and renders child routes via Outlet.
 */
import { useState, useEffect, useCallback } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { PersonIcon } from "@radix-ui/react-icons";
import { GlobalHeader } from "../components/GlobalHeader";
import { GlobalChatSearch } from "../components/GlobalChatSearch";
import { StatusBar } from "../components/StatusBar";
import { setAutoCopyOnSelect, getAutoCopyOnSelect } from "../components/Terminal";
import { Switch } from "../components/ui/switch";
import { Avatar, AvatarImage, AvatarFallback } from "../components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "../hooks";
import { useAtom } from "jotai";
import { shortenPathsAtom, profileAtom, globalChatSearchHotkeyAtom } from "../store";
import { AppConfigContext, useAppConfig, type AppConfig } from "../context";
import type { FeatureType, UserProfile } from "../types";

// ============================================================================
// Route to Feature mapping
// ============================================================================

function getFeatureFromPath(pathname: string): FeatureType | null {
  const path = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const segment = path.split("/")[0];

  const featureMap: Record<string, FeatureType> = {
    "": null as unknown as FeatureType,
    "features": "features",
    "history": "chat",
    "skills": "skills",
    "commands": "commands",
    "mcp": "mcp",
    "hooks": "hooks",
    "agents": "sub-agents",
    "output-styles": "output-styles",
    "statusline": "statusline",
    "settings": "settings",
    "knowledge": "kb-distill",
    "marketplace": "marketplace",
    "events": "events",
  };

  // Handle settings sub-routes
  if (path.startsWith("settings/")) {
    const sub = path.split("/")[1];
    if (sub === "env") return "basic-env";
    if (sub === "maas") return "basic-maas";
    if (sub === "version") return "basic-version";
    if (sub === "context") return "basic-context";
    return "settings";
  }

  // Handle knowledge sub-routes
  if (path.startsWith("knowledge/")) {
    const sub = path.split("/")[1];
    if (sub === "distill") return "kb-distill";
    // sub === "source" → dynamic source, no fixed FeatureType
  }

  return featureMap[segment] ?? null;
}

// ============================================================================
// Layout Component
// ============================================================================

export default function RootLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Derive current feature from URL
  const currentFeature = getFeatureFromPath(location.pathname);

  // App state (non-routing)
  const [homeDir, setHomeDir] = useState("");
  const [shortenPaths, setShortenPaths] = useAtom(shortenPathsAtom);
  const [showSettings, setShowSettings] = useState(false);
  const [profile, setProfile] = useAtom(profileAtom);
  const [showProfileDialog, setShowProfileDialog] = useState(false);

  useEffect(() => {
    invoke<string>("get_home_dir").then(setHomeDir).catch(() => {});
  }, []);

  // Splash dismissal:
  //   - On /history (and "/" which redirects to /history via HomePage),
  //     ProjectList controls the splash — wait until the session list is
  //     actually ready, no jarring "empty shell" gap.
  //   - On every other route, RootLayout dismisses immediately — those
  //     pages don't have a multi-second initial query.
  // The lastPath resume target may be anything, so we also skip dispatch
  // on "/" because HomePage will redirect within a microtask.
  useEffect(() => {
    const p = location.pathname;
    if (p === "/" || p.startsWith("/history")) return;
    window.dispatchEvent(new Event("app:ready"));
  }, [location.pathname]);

  useEffect(() => {
    const path = location.pathname + location.search;
    // Skip transient overlay routes — they shouldn't be the "resume" target
    if (path && path !== "/" && location.pathname !== "/annual-report-2025") {
      try { localStorage.setItem("lovcode:lastPath", path); } catch {}
    }
  }, [location.pathname, location.search]);

  useEffect(() => {
    const unlisten = listen("menu-settings", () => setShowSettings(true));
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Backend (notify) watches ~/.claude/projects/ and emits "sessions-changed"
  // when Claude Code writes / appends a jsonl. Invalidate so the next read
  // picks up the change. The sessions cache (B) makes this re-read cheap —
  // only the changed file's mtime is bumped, everything else hits cache.
  useEffect(() => {
    const unlisten = listen("sessions-changed", () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    });
    return () => { unlisten.then(fn => fn()); };
  }, [queryClient]);

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

  // URL-based navigation
  const handleFeatureClick = (feature: FeatureType) => {
    const routes: Record<FeatureType, string> = {
      "chat": "/history",
      "basic-env": "/settings/env",
      "basic-maas": "/settings/maas",
      "basic-version": "/settings/version",
      "basic-context": "/settings/context",
      "settings": "/settings",
      "commands": "/commands",
      "mcp": "/mcp",
      "skills": "/skills",
      "hooks": "/hooks",
      "sub-agents": "/agents",
      "output-styles": "/output-styles",
      "statusline": "/statusline",
      "kb-distill": "/knowledge/distill",
      "features": "/features",
      "marketplace": "/marketplace",
      "extensions": "/extensions",
      "events": "/events",
    };
    const path = routes[feature];
    if (path) {
      navigate(path);
    }
  };

  return (
    <AppConfigContext.Provider value={appConfig}>
      <div className="h-screen bg-canvas flex flex-col">
        <GlobalHeader
          currentFeature={currentFeature}
          canGoBack={window.history.length > 1}
          canGoForward={false}
          onGoBack={() => navigate(-1)}
          onGoForward={() => navigate(1)}
          onFeatureClick={handleFeatureClick}
          onShowProfileDialog={() => setShowProfileDialog(true)}
          onShowSettings={() => setShowSettings(true)}
        />
        <div className="flex-1 flex overflow-hidden">
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
        </div>
        <StatusBar />
      </div>
      <AppSettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />
      <ProfileDialog open={showProfileDialog} onClose={() => setShowProfileDialog(false)} profile={profile} onSave={setProfile} />
      <GlobalChatSearch />
    </AppConfigContext.Provider>
  );
}

// ============================================================================
// Dialogs
// ============================================================================

interface StatusBarSettings {
  enabled: boolean;
  scriptPath?: string;
}

type SettingsSection = "display" | "terminal" | "statusbar";

const settingsSections: { id: SettingsSection; label: string }[] = [
  { id: "display", label: "Display" },
  { id: "terminal", label: "Terminal" },
  { id: "statusbar", label: "StatusBar" },
];

function AppSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { shortenPaths, setShortenPaths } = useAppConfig();
  const [autoCopy, setAutoCopy] = useState(getAutoCopyOnSelect);
  const [globalChatSearchHotkey, setGlobalChatSearchHotkey] = useAtom(globalChatSearchHotkeyAtom);
  const [statusBarEnabled, setStatusBarEnabled] = useState(false);
  const [statusBarScript, setStatusBarScript] = useState("~/.lovstudio/lovcode/statusbar/default.sh");
  const [activeSection, setActiveSection] = useState<SettingsSection>("display");

  // Load statusbar settings on open
  useEffect(() => {
    if (!open) return;
    invoke<StatusBarSettings | null>("get_statusbar_settings").then((settings) => {
      if (settings) {
        setStatusBarEnabled(settings.enabled);
        setStatusBarScript(settings.scriptPath || "~/.lovstudio/lovcode/statusbar/default.sh");
      }
    }).catch(() => {});
  }, [open]);

  const handleAutoCopyChange = (checked: boolean) => {
    setAutoCopy(checked);
    setAutoCopyOnSelect(checked);
  };

  const handleStatusBarEnabledChange = async (checked: boolean) => {
    setStatusBarEnabled(checked);
    try {
      await invoke("save_statusbar_settings", {
        settings: { enabled: checked, scriptPath: statusBarScript },
      });
    } catch (e) {
      console.error("Failed to save statusbar settings:", e);
    }
  };

  const handleStatusBarScriptChange = async (path: string) => {
    setStatusBarScript(path);
    if (statusBarEnabled) {
      try {
        await invoke("save_statusbar_settings", {
          settings: { enabled: true, scriptPath: path },
        });
      } catch (e) {
        console.error("Failed to save statusbar settings:", e);
      }
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-xl border border-border shadow-xl w-[38rem] max-w-[90vw] h-[28rem] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between shrink-0">
          <h2 className="text-lg font-semibold text-ink">Settings</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-ink text-xl leading-none">&times;</button>
        </div>
        {/* Two-column layout */}
        <div className="flex flex-1 min-h-0">
          {/* Left sidebar */}
          <div className="w-40 shrink-0 border-r border-border bg-muted/30 p-2 space-y-1">
            {settingsSections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  activeSection === section.id
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-ink hover:bg-muted"
                }`}
              >
                {section.label}
              </button>
            ))}
          </div>
          {/* Right content */}
          <div className="flex-1 p-5 overflow-y-auto">
            {activeSection === "display" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-ink">Shorten paths</p>
                    <p className="text-xs text-muted-foreground">Replace home directory with ~</p>
                  </div>
                  <Switch checked={shortenPaths} onCheckedChange={setShortenPaths} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-ink">Global ⌘K hotkey</p>
                    <p className="text-xs text-muted-foreground">Open chat search even when the app is in the background</p>
                  </div>
                  <Switch checked={globalChatSearchHotkey} onCheckedChange={setGlobalChatSearchHotkey} />
                </div>
              </div>
            )}
            {activeSection === "terminal" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-ink">Auto-copy on select</p>
                    <p className="text-xs text-muted-foreground">Copy selected text automatically</p>
                  </div>
                  <Switch checked={autoCopy} onCheckedChange={handleAutoCopyChange} />
                </div>
              </div>
            )}
            {activeSection === "statusbar" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-ink">Custom script mode</p>
                    <p className="text-xs text-muted-foreground">Use a script to generate status bar content</p>
                  </div>
                  <Switch checked={statusBarEnabled} onCheckedChange={handleStatusBarEnabledChange} />
                </div>
                {statusBarEnabled && (
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-ink">Script path</label>
                    <Input
                      className="text-xs font-mono"
                      placeholder="~/.lovstudio/lovcode/statusbar/default.sh"
                      value={statusBarScript}
                      onChange={(e) => handleStatusBarScriptChange(e.target.value)}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Script receives JSON context via stdin. First line of stdout becomes the status bar.
                      <br />
                      <span className="text-muted-foreground/70">Supports ANSI color codes.</span>
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileDialog({ open, onClose, profile, onSave }: { open: boolean; onClose: () => void; profile: UserProfile; onSave: (p: UserProfile) => void }) {
  const [nickname, setNickname] = useState(profile.nickname);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl || "");

  useEffect(() => {
    setNickname(profile.nickname);
    setAvatarUrl(profile.avatarUrl || "");
  }, [profile]);

  const handleSave = () => {
    onSave({ nickname, avatarUrl: avatarUrl || "" });
    onClose();
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              {avatarUrl ? <AvatarImage src={avatarUrl} /> : null}
              <AvatarFallback className="bg-primary/10 text-primary text-xl">
                {nickname ? nickname[0].toUpperCase() : <PersonIcon className="w-8 h-8" />}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 space-y-2">
              <Label htmlFor="nickname">Name</Label>
              <Input id="nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Your name" />
            </div>
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
