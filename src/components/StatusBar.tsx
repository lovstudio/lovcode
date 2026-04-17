/**
 * StatusBar - Bottom status bar with script-based customization support
 *
 * Similar to Claude Code's statusLine, this supports:
 * - Script-based content generation (receives JSON context via stdin)
 * - ANSI color code support
 * - Fallback to built-in status bar if no script configured
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { useAtom, useAtomValue } from "jotai";
import { profileAtom, workspaceDataAtom } from "../store";
import { invoke } from "@tauri-apps/api/core";
import {
  FolderIcon,
  GitBranchIcon,
  CodeIcon,
  GlobeIcon,
  ShieldCheckIcon,
  UserIcon,
  ClockIcon,
  SettingsIcon,
} from "lucide-react";
import { version as VERSION } from "../../package.json";
import { updateStateAtom, type UpdateStage } from "./UpdateChecker";

interface NetworkInfo {
  region: string;
  ip: string;
  isProxy: boolean;
  proxyType?: string;
}

interface TodayStats {
  lines_added: number;
  lines_deleted: number;
}

interface StatusBarSettings {
  enabled: boolean;
  scriptPath?: string;
}

interface StatusBarContext {
  app_name: string;
  version: string;
  projects_count: number;
  features_count: number;
  today_lines_added: number;
  today_lines_deleted: number;
  timestamp: string;
  home_dir: string;
}

// ANSI color code to Tailwind class mapping
const ANSI_COLORS: Record<string, string> = {
  "30": "text-gray-900",
  "31": "text-red-500",
  "32": "text-green-500",
  "33": "text-yellow-500",
  "34": "text-blue-500",
  "35": "text-purple-500",
  "36": "text-cyan-500",
  "37": "text-gray-300",
  "90": "text-gray-500",
  "91": "text-red-400",
  "92": "text-green-400",
  "93": "text-yellow-400",
  "94": "text-blue-400",
  "95": "text-purple-400",
  "96": "text-cyan-400",
  "97": "text-white",
};

interface AnsiSpan {
  text: string;
  className: string;
}

/** Parse ANSI escape codes and return styled spans */
function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const regex = /\x1b\[([0-9;]+)m/g;
  let lastIndex = 0;
  let currentClass = "";
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before this escape code
    if (match.index > lastIndex) {
      spans.push({ text: text.slice(lastIndex, match.index), className: currentClass });
    }

    // Parse the escape code
    const codes = match[1].split(";");
    for (const code of codes) {
      if (code === "0") {
        currentClass = ""; // Reset
      } else if (code === "1") {
        currentClass += " font-bold";
      } else if (ANSI_COLORS[code]) {
        currentClass = ANSI_COLORS[code];
      }
    }

    lastIndex = regex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex), className: currentClass });
  }

  return spans.filter(s => s.text.length > 0);
}

function VersionWithUpdateStatus() {
  const { stage, update, error } = useAtomValue(updateStateAtom);

  const titles: Record<UpdateStage, string> = {
    checking: "Checking for updates...",
    latest: "You're on the latest version",
    available: `v${update?.version} available — click to update`,
    downloading: "Downloading update...",
    done: "Update installed — restart to apply",
    error: error || "Update check failed",
  };

  if (stage === "available") {
    return (
      <span className="text-primary cursor-pointer" title={titles[stage]}>
        v{VERSION} → v{update?.version}
      </span>
    );
  }
  if (stage === "downloading") {
    return <span className="text-primary animate-pulse" title={titles[stage]}>v{VERSION} ↓</span>;
  }
  if (stage === "done") {
    return <span className="text-green-600 cursor-pointer" title={titles[stage]}>v{VERSION} ✓</span>;
  }
  return <span className="text-muted-foreground" title={titles[stage]}>v{VERSION}</span>;
}

interface StatusBarProps {
  onOpenSettings?: () => void;
}

export function StatusBar({ onOpenSettings }: StatusBarProps) {
  const [workspace] = useAtom(workspaceDataAtom);
  const [profile] = useAtom(profileAtom);
  const [time, setTime] = useState(new Date());
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [todayStats, setTodayStats] = useState<TodayStats>({ lines_added: 0, lines_deleted: 0 });
  const [proxyEnv, setProxyEnv] = useState<string | null>(null);
  const [settings, setSettings] = useState<StatusBarSettings | null>(null);
  const [scriptOutput, setScriptOutput] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState("");

  // Load statusbar settings
  useEffect(() => {
    async function loadSettings() {
      try {
        const result = await invoke<StatusBarSettings | null>("get_statusbar_settings");
        setSettings(result);
      } catch {
        setSettings(null);
      }
    }
    loadSettings();
  }, []);

  // Get home dir
  useEffect(() => {
    invoke<string>("get_home_dir").then(setHomeDir).catch(() => {});
  }, []);

  // Clock update
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Calculate stats from workspace
  const projectCount = workspace?.projects?.length ?? 0;
  const featCount = workspace?.projects?.reduce(
    (sum, p) => sum + (p.features?.length ?? 0),
    0
  ) ?? 0;

  // Fetch today's coding stats
  useEffect(() => {
    async function fetchTodayStats() {
      try {
        const stats = await invoke<TodayStats>("get_today_coding_stats");
        setTodayStats(stats);
      } catch {
        // Command might not exist yet
      }
    }
    fetchTodayStats();
    const timer = setInterval(fetchTodayStats, 30000);
    return () => clearInterval(timer);
  }, []);

  // Build context for script
  const context = useMemo<StatusBarContext>(() => ({
    app_name: "Lovcode",
    version: VERSION,
    projects_count: projectCount,
    features_count: featCount,
    today_lines_added: todayStats.lines_added,
    today_lines_deleted: todayStats.lines_deleted,
    timestamp: time.toISOString(),
    home_dir: homeDir,
  }), [projectCount, featCount, todayStats, time, homeDir]);

  // Execute script if enabled
  useEffect(() => {
    if (!settings?.enabled || !settings?.scriptPath) {
      setScriptOutput(null);
      return;
    }

    let cancelled = false;

    async function runScript() {
      try {
        const output = await invoke<string>("execute_statusbar_script", {
          scriptPath: settings!.scriptPath,
          context,
        });
        if (!cancelled) {
          setScriptOutput(output);
        }
      } catch (e) {
        console.error("StatusBar script error:", e);
        if (!cancelled) {
          setScriptOutput(null);
        }
      }
    }

    // Throttle: run at most every 500ms
    const timer = setTimeout(runScript, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [settings, context]);

  // Fetch network info (only for default mode)
  useEffect(() => {
    if (settings?.enabled) return; // Skip if script mode

    async function fetchNetworkInfo() {
      try {
        const res = await fetch("https://ipinfo.io/json");
        if (res.ok) {
          const data = await res.json();
          setNetworkInfo({
            region: data.city ? `${data.city}, ${data.country}` : data.country || "Unknown",
            ip: data.ip || "",
            isProxy: data.privacy?.proxy || data.privacy?.vpn || false,
            proxyType: data.privacy?.vpn ? "VPN" : data.privacy?.proxy ? "Proxy" : undefined,
          });
        }
      } catch {
        // Silently fail
      }
    }
    fetchNetworkInfo();
  }, [settings?.enabled]);

  // Check proxy environment (only for default mode)
  useEffect(() => {
    if (settings?.enabled) return;

    async function checkProxy() {
      try {
        const envProxy = await invoke<string | null>("get_env_var", { name: "HTTP_PROXY" });
        const envHttpsProxy = await invoke<string | null>("get_env_var", { name: "HTTPS_PROXY" });
        const proxy = envProxy || envHttpsProxy;
        if (proxy) {
          try {
            const url = new URL(proxy);
            setProxyEnv(url.hostname);
          } catch {
            setProxyEnv(proxy.slice(0, 20));
          }
        }
      } catch {
        // Silent fail
      }
    }
    checkProxy();
  }, [settings?.enabled]);

  const formatTime = useCallback((d: Date) => {
    return d.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }, []);

  const formatDate = useCallback((d: Date) => {
    return d.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
      weekday: "short",
    });
  }, []);

  // Render script output with ANSI color support
  const renderedScriptOutput = useMemo(() => {
    if (!scriptOutput) return null;
    const spans = parseAnsi(scriptOutput);
    return (
      <div className="flex items-center gap-1">
        {spans.map((span, i) => (
          <span key={i} className={span.className}>{span.text}</span>
        ))}
      </div>
    );
  }, [scriptOutput]);

  // Script mode: show script output + settings gear
  if (settings?.enabled && scriptOutput !== null) {
    return (
      <div className="h-6 bg-card border-t border-border flex items-center justify-between px-3 text-xs text-muted-foreground select-none">
        <div className="flex-1 font-mono truncate">
          {renderedScriptOutput}
        </div>
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="ml-2 p-0.5 rounded hover:bg-muted transition-colors"
            title="StatusBar Settings"
          >
            <SettingsIcon className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  }

  // Default mode: built-in status bar
  return (
    <div className="h-6 bg-card border-t border-border flex items-center justify-between px-3 text-xs text-muted-foreground select-none">
      {/* Left: Product name & version */}
      <div className="flex items-center gap-4">
        <span className="font-medium text-ink">Lovcode</span>
        <VersionWithUpdateStatus />

        {/* Stats */}
        <div className="flex items-center gap-3 ml-2 border-l border-border/50 pl-4">
          <div className="flex items-center gap-1" title="Projects">
            <FolderIcon className="w-3 h-3" />
            <span>{projectCount}</span>
          </div>
          <div className="flex items-center gap-1" title="Features">
            <GitBranchIcon className="w-3 h-3" />
            <span>{featCount}</span>
          </div>
          {(todayStats.lines_added > 0 || todayStats.lines_deleted > 0) && (
            <div className="flex items-center gap-1" title="Today's changes">
              <CodeIcon className="w-3 h-3" />
              <span className="text-green-600">+{todayStats.lines_added}</span>
              <span className="text-red-500">-{todayStats.lines_deleted}</span>
            </div>
          )}
        </div>
      </div>

      {/* Right: Time, Network, Account, Settings */}
      <div className="flex items-center gap-4">
        {/* Proxy indicator */}
        {proxyEnv && (
          <div className="flex items-center gap-1 text-amber-600" title={`Proxy: ${proxyEnv}`}>
            <ShieldCheckIcon className="w-3 h-3" />
            <span>中转</span>
          </div>
        )}

        {/* Network region */}
        {networkInfo && (
          <div className="flex items-center gap-1" title={`IP: ${networkInfo.ip}`}>
            <GlobeIcon className="w-3 h-3" />
            <span>{networkInfo.region}</span>
            {networkInfo.isProxy && (
              <span className="text-amber-600 ml-1">({networkInfo.proxyType || "Proxy"})</span>
            )}
          </div>
        )}

        {/* Date & Time */}
        <div className="flex items-center gap-1 border-l border-border/50 pl-4">
          <ClockIcon className="w-3 h-3" />
          <span>{formatDate(time)}</span>
          <span className="font-mono">{formatTime(time)}</span>
        </div>

        {/* Account */}
        {profile.nickname && (
          <div className="flex items-center gap-1 border-l border-border/50 pl-4">
            <UserIcon className="w-3 h-3" />
            <span>{profile.nickname}</span>
          </div>
        )}

        {/* Settings gear */}
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="ml-1 p-0.5 rounded hover:bg-muted transition-colors"
            title="StatusBar Settings"
          >
            <SettingsIcon className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
