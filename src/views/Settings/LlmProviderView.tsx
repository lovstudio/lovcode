import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FlaskConical } from "lucide-react";
import { useInvokeQuery, useQueryClient } from "../../hooks";
import {
  Cross2Icon,
  EyeOpenIcon,
  EyeClosedIcon,
  RocketIcon,
  ExternalLinkIcon,
} from "@radix-ui/react-icons";
import { Button } from "../../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import {
  LoadingState,
  SearchInput,
  PageHeader,
  ConfigPage,
  type MarketplaceItem,
} from "../../components/config";
import { useAtom } from "jotai";
import { routerTestStatusAtom, routerTestMessageAtom } from "../../store";
import type { ClaudeSettings } from "../../types";
import { trackProviderEvent, isAnalyticsEnabled, setAnalyticsEnabled } from "../../lib/analytics";

export function LlmProviderView() {
  const ResponsiveActions = ({
    variant,
    icon,
    text,
    className = "",
  }: {
    variant: "env" | "router";
    icon: ReactNode;
    text: ReactNode;
    className?: string;
  }) => (
    <div className={`flex flex-nowrap items-center gap-2 whitespace-nowrap justify-end ${className}`}>
      <div className={`${variant}-actions--icon flex flex-nowrap items-center gap-2`}>{icon}</div>
      <div className={`${variant}-actions--text flex flex-nowrap items-center gap-2`}>{text}</div>
    </div>
  );

  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useInvokeQuery<ClaudeSettings>(["settings"], "get_settings");
  const { data: providerContexts } = useInvokeQuery<Record<string, { env?: Record<string, string> }>>(
    ["provider_contexts"],
    "get_provider_contexts",
  );

  const [search, setSearch] = useState("");
  const [applyStatus, setApplyStatus] = useState<Record<string, "idle" | "loading" | "success" | "error">>({});
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyHint, setApplyHint] = useState<Record<string, string>>({});
  const [testStatus, setTestStatus] = useAtom(routerTestStatusAtom);
  const [testMessage, setTestMessage] = useAtom(routerTestMessageAtom);
  const [testMissingKeys, setTestMissingKeys] = useState<Record<string, string[]>>({});
  const [testMissingValues, setTestMissingValues] = useState<Record<string, Record<string, string>>>({});
  const [expandedPresetKey, setExpandedPresetKey] = useState<string | null>(null);
  const [analyticsEnabled, setAnalyticsEnabledState] = useState(isAnalyticsEnabled);

  if (isLoading) return <LoadingState message="Loading settings..." />;

  const getActiveProvider = (value: ClaudeSettings | null | undefined): string | null => {
    const lovcode =
      value?.raw && typeof value.raw === "object"
        ? (value.raw as Record<string, unknown>).lovcode
        : null;
    if (!lovcode || typeof lovcode !== "object") return null;
    const activeProvider = (lovcode as Record<string, unknown>).activeProvider;
    return typeof activeProvider === "string" ? activeProvider : null;
  };

  const activeProvider = getActiveProvider(settings);

  const getRawEnvFromSettings = (value: ClaudeSettings | null | undefined) => {
    const envValue =
      value?.raw && typeof value.raw === "object"
        ? (value.raw as Record<string, unknown>).env
        : null;
    if (!envValue || typeof envValue !== "object" || Array.isArray(envValue)) return {};
    return Object.fromEntries(
      Object.entries(envValue as Record<string, unknown>).map(([key, v]) => [key, String(v ?? "")])
    );
  };

  const rawEnv = getRawEnvFromSettings(settings);

  const proxyPresets = [
    {
      key: "anthropic-subscription",
      label: "Anthropic Subscription",
      description: "Use Claude Pro/Max subscription via OAuth login",
      templateName: "anthropic-subscription",
    },
    {
      key: "modelgate",
      label: "ModelGate",
      description: "ModelGate API gateway for Claude",
      templateName: "modelgate-anthropic-proxy",
      docsUrl: "https://docs.modelgate.net/guide/tools/claude-code.html",
    },
    {
      key: "native",
      label: "Anthropic API",
      description: "Direct Anthropic API with your API key",
      templateName: "anthropic-native-endpoint",
    },
    {
      key: "qiniu",
      label: "Qiniu Cloud",
      description: "Use Qiniu Cloud AI gateway for Anthropic API",
      templateName: "qiniu-anthropic-proxy",
      docsUrl: "https://developer.qiniu.com/aitokenapi/13085/claude-code-configuration-instructions",
    },
    {
      key: "siliconflow",
      label: "SiliconFlow",
      description: "Use SiliconCloud API for Claude Code with various models",
      templateName: "siliconflow-anthropic-proxy",
      docsUrl: "https://docs.siliconflow.com/en/userguide/quickstart",
    },
    {
      key: "univibe",
      label: "UniVibe",
      description: "UniVibe proxy service, supports Claude Code / Codex / Cursor",
      templateName: "univibe-anthropic-proxy",
      docsUrl: "https://www.univibe.cc/console/docs/claudecode",
    },
    {
      key: "zenmux",
      label: "ZenMux",
      description: "Route via ZenMux to unlock more model options",
      templateName: "zenmux-anthropic-proxy",
      docsUrl: "https://docs.zenmux.ai/best-practices/claude-code.html",
    },
  ];

  const presetFallbacks: Record<string, MarketplaceItem> = {
    "anthropic-subscription": {
      name: "anthropic-subscription",
      path: "fallback/anthropic-subscription.json",
      description: "Use Claude Pro/Max subscription via OAuth login.",
      downloads: null,
      content: JSON.stringify({ env: { CLAUDE_CODE_USE_OAUTH: "1" } }, null, 2),
    },
    native: {
      name: "anthropic-native-endpoint",
      path: "fallback/anthropic-native-endpoint.json",
      description: "Direct Anthropic API with your API key.",
      downloads: null,
      content: JSON.stringify({ env: { ANTHROPIC_API_KEY: "your_anthropic_api_key_here" } }, null, 2),
    },
    zenmux: {
      name: "zenmux-anthropic-proxy",
      path: "fallback/zenmux-anthropic-proxy.json",
      description: "Route via ZenMux to unlock more model options.",
      downloads: null,
      content: JSON.stringify({ env: { ZENMUX_API_KEY: "sk-ai-v1-xxxxx" } }, null, 2),
    },
    qiniu: {
      name: "qiniu-anthropic-proxy",
      path: "fallback/qiniu-anthropic-proxy.json",
      description: "Use Qiniu Cloud AI gateway for Anthropic API.",
      downloads: null,
      content: JSON.stringify({ env: { QINIU_API_KEY: "your_qiniu_api_key_here" } }, null, 2),
    },
    univibe: {
      name: "univibe-anthropic-proxy",
      path: "fallback/univibe-anthropic-proxy.json",
      description: "UniVibe proxy service, supports Claude Code / Codex / Cursor.",
      downloads: null,
      content: JSON.stringify({ env: { UNIVIBE_API_KEY: "cr_xxxxxxxxxxxxxxxxxx" } }, null, 2),
    },
    modelgate: {
      name: "modelgate-anthropic-proxy",
      path: "fallback/modelgate-anthropic-proxy.json",
      description: "ModelGate API gateway for Claude.",
      downloads: null,
      content: JSON.stringify({ env: { MODELGATE_API_KEY: "your_modelgate_api_key" } }, null, 2),
    },
    siliconflow: {
      name: "siliconflow-anthropic-proxy",
      path: "fallback/siliconflow-anthropic-proxy.json",
      description: "Use SiliconCloud API for Claude Code.",
      downloads: null,
      content: JSON.stringify({ env: { SILICONFLOW_API_KEY: "sk-xxxxx" } }, null, 2),
    },
  };

  const filteredPresets = proxyPresets.filter(
    (preset) =>
      preset.label.toLowerCase().includes(search.toLowerCase()) ||
      preset.description.toLowerCase().includes(search.toLowerCase())
  );

  const getPresetTemplate = (presetKey: string) => {
    const preset = proxyPresets.find((p) => p.key === presetKey);
    if (!preset) return null;
    const fallbackTemplate = presetFallbacks[presetKey] ?? null;
    return { preset, template: fallbackTemplate };
  };

  const isPlaceholderValue = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return true;
    return /(xxxxx|<.*?>|your[_\s-]?key|replace[_\s-]?me)/i.test(trimmed);
  };

  const handleTogglePresetPreview = (presetKey: string) => {
    setExpandedPresetKey((prev) => (prev === presetKey ? null : presetKey));
  };

  const getPresetPreviewConfig = (presetKey: string) => {
    const resolved = getPresetTemplate(presetKey);
    const templateContent = resolved?.template?.content;
    if (!templateContent) {
      return { env: {}, note: "Template not available locally." };
    }

    try {
      const parsed = JSON.parse(templateContent) as Record<string, unknown>;
      const templateEnv =
        parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)
          ? (parsed.env as Record<string, unknown>)
          : {};
      const previewEnv = Object.fromEntries(
        Object.keys(templateEnv).map((key) => [key, getEnvValueForPreset(presetKey, key)])
      );
      return { env: previewEnv, note: null };
    } catch {
      return { env: {}, note: "Template JSON invalid." };
    }
  };

  const handleTestPreset = async (presetKey: string, envOverride?: Record<string, string>) => {
    const resolved = getPresetTemplate(presetKey);
    if (!resolved?.template?.content) {
      setTestStatus((prev) => ({ ...prev, [presetKey]: "error" }));
      setTestMessage((prev) => ({ ...prev, [presetKey]: "Template not available locally." }));
      setTestMissingKeys((prev) => ({ ...prev, [presetKey]: [] }));
      return;
    }

    setTestStatus((prev) => ({ ...prev, [presetKey]: "loading" }));

    if (presetKey === "anthropic-subscription") {
      setTestStatus((prev) => ({ ...prev, [presetKey]: "success" }));
      setTestMessage((prev) => ({ ...prev, [presetKey]: "Run /login in Claude Code to authenticate" }));
      setTestMissingKeys((prev) => ({ ...prev, [presetKey]: [] }));
      return;
    }

    const envSource = envOverride ?? rawEnv;

    try {
      const parsed = JSON.parse(resolved.template.content) as { env?: Record<string, string> };
      const requiredKeys = parsed.env ? Object.keys(parsed.env) : [];
      const missing = requiredKeys.filter((key) => isPlaceholderValue(envSource[key] || ""));

      if (missing.length > 0) {
        setTestStatus((prev) => ({ ...prev, [presetKey]: "error" }));
        setTestMessage((prev) => ({ ...prev, [presetKey]: `Missing or placeholder: ${missing.join(", ")}` }));
        setTestMissingKeys((prev) => ({ ...prev, [presetKey]: missing }));
        setTestMissingValues((prev) => ({
          ...prev,
          [presetKey]: Object.fromEntries(missing.map((key) => [key, envSource[key] || ""])),
        }));
        return;
      }

      setTestMissingKeys((prev) => ({ ...prev, [presetKey]: [] }));

      if (presetKey === "univibe") {
        const authToken = (envSource.UNIVIBE_API_KEY || envSource.ANTHROPIC_AUTH_TOKEN || "").trim();
        const baseUrl = envSource.ANTHROPIC_BASE_URL || "https://api.univibe.cc/anthropic";

        try {
          const result = await invoke<{ ok: boolean; code: number; stdout: string; stderr: string }>("test_claude_cli", {
            baseUrl,
            authToken,
          });

          if (!result.ok) {
            setTestStatus((prev) => ({ ...prev, [presetKey]: "error" }));
            setTestMessage((prev) => ({
              ...prev,
              [presetKey]: `UniVibe test failed (${result.code}): ${result.stderr || result.stdout || "No output"}`,
            }));
            trackProviderEvent({ action: "test", provider: presetKey, success: false, error_message: `${result.code}` });
            return;
          }
          setTestStatus((prev) => ({ ...prev, [presetKey]: "success" }));
          setTestMessage((prev) => ({ ...prev, [presetKey]: "Connected" }));
          trackProviderEvent({ action: "test", provider: presetKey, success: true });
          return;
        } catch (e) {
          setTestStatus((prev) => ({ ...prev, [presetKey]: "error" }));
          setTestMessage((prev) => ({ ...prev, [presetKey]: `UniVibe test error: ${String(e)}` }));
          trackProviderEvent({ action: "test", provider: presetKey, success: false, error_message: String(e) });
          return;
        }
      }

      if (presetKey === "siliconflow") {
        const apiKey = (envSource.SILICONFLOW_API_KEY || envSource.ANTHROPIC_API_KEY || "").trim();
        const baseUrl = envSource.ANTHROPIC_BASE_URL || "https://api.siliconflow.com/v1";

        try {
          const result = await invoke<{ ok: boolean; status: number; body: string }>("test_openai_connection", {
            baseUrl,
            apiKey,
          });

          if (!result.ok) {
            setTestStatus((prev) => ({ ...prev, [presetKey]: "error" }));
            setTestMessage((prev) => ({
              ...prev,
              [presetKey]: `SiliconFlow test failed (${result.status}): ${result.body || "No response body"}`,
            }));
            trackProviderEvent({ action: "test", provider: presetKey, success: false, error_message: `${result.status}` });
            return;
          }

          let modelCount = 0;
          try {
            const parsed = JSON.parse(result.body);
            modelCount = parsed.data?.length || 0;
          } catch {}

          setTestStatus((prev) => ({ ...prev, [presetKey]: "success" }));
          setTestMessage((prev) => ({ ...prev, [presetKey]: `Connected (${modelCount} models available)` }));
          trackProviderEvent({ action: "test", provider: presetKey, success: true });
          return;
        } catch (e) {
          setTestStatus((prev) => ({ ...prev, [presetKey]: "error" }));
          setTestMessage((prev) => ({ ...prev, [presetKey]: `SiliconFlow test error: ${String(e)}` }));
          trackProviderEvent({ action: "test", provider: presetKey, success: false, error_message: String(e) });
          return;
        }
      }

      if (presetKey === "zenmux" || presetKey === "modelgate") {
        const authToken = (
          envSource.ZENMUX_API_KEY ||
          envSource.MODELGATE_API_KEY ||
          envSource.ANTHROPIC_AUTH_TOKEN ||
          ""
        ).trim();
        const defaultBaseUrl = presetKey === "zenmux"
          ? "https://zenmux.ai/api/anthropic"
          : "https://mg.aid.pub/claude-proxy";
        const baseUrl = envSource.ANTHROPIC_BASE_URL || defaultBaseUrl;
        const model = envSource.ANTHROPIC_MODEL || envSource.ANTHROPIC_DEFAULT_SONNET_MODEL || "anthropic/claude-sonnet-4.5";
        const label = presetKey === "zenmux" ? "ZenMux" : "ModelGate";

        try {
          const result = await invoke<{ ok: boolean; status: number; body: string }>("test_anthropic_connection", {
            baseUrl,
            authToken,
            model,
          });

          if (!result.ok) {
            setTestStatus((prev) => ({ ...prev, [presetKey]: "error" }));
            setTestMessage((prev) => ({
              ...prev,
              [presetKey]: `${label} test failed (${result.status}): ${result.body || "No response body"}`,
            }));
            trackProviderEvent({ action: "test", provider: presetKey, model, success: false, error_message: `${result.status}` });
            return;
          }
          setTestStatus((prev) => ({ ...prev, [presetKey]: "success" }));
          setTestMessage((prev) => ({ ...prev, [presetKey]: "Connected" }));
          trackProviderEvent({ action: "test", provider: presetKey, model, success: true });
          return;
        } catch (e) {
          setTestStatus((prev) => ({ ...prev, [presetKey]: "error" }));
          setTestMessage((prev) => ({ ...prev, [presetKey]: `${label} test error: ${String(e)}` }));
          trackProviderEvent({ action: "test", provider: presetKey, model, success: false, error_message: String(e) });
          return;
        }
      }

      setTestStatus((prev) => ({ ...prev, [presetKey]: "success" }));
      setTestMessage((prev) => ({ ...prev, [presetKey]: "" }));
      if (!["univibe", "siliconflow", "zenmux", "modelgate"].includes(presetKey)) {
        trackProviderEvent({ action: "test", provider: presetKey, success: true });
      }
    } catch (e) {
      setTestStatus((prev) => ({ ...prev, [presetKey]: "error" }));
      setTestMessage((prev) => ({ ...prev, [presetKey]: `Invalid template JSON: ${String(e)}` }));
      setTestMissingKeys((prev) => ({ ...prev, [presetKey]: [] }));
    }
  };

  const presetEnvKeyMappings: Record<string, Record<string, string>> = {
    zenmux: { ZENMUX_API_KEY: "ANTHROPIC_AUTH_TOKEN" },
    qiniu: { QINIU_API_KEY: "ANTHROPIC_AUTH_TOKEN" },
    modelgate: { MODELGATE_API_KEY: "ANTHROPIC_AUTH_TOKEN" },
    univibe: { UNIVIBE_API_KEY: "ANTHROPIC_AUTH_TOKEN" },
    siliconflow: { SILICONFLOW_API_KEY: "ANTHROPIC_API_KEY" },
  };

  const presetExtraEnv: Record<string, Record<string, string>> = {
    zenmux: {
      ANTHROPIC_BASE_URL: "https://zenmux.ai/api/anthropic",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    qiniu: { ANTHROPIC_BASE_URL: "https://api.qnaigc.com" },
    univibe: {
      ANTHROPIC_BASE_URL: "https://api.univibe.cc/anthropic",
      ANTHROPIC_API_KEY: "",
    },
    modelgate: {
      ANTHROPIC_BASE_URL: "https://mg.aid.pub/claude-proxy",
      ANTHROPIC_API_KEY: "",
    },
    siliconflow: {
      ANTHROPIC_BASE_URL: "https://api.siliconflow.com/v1",
    },
  };

  const handleApplyPreset = async (presetKey: string) => {
    const resolved = getPresetTemplate(presetKey);
    if (!resolved?.template || !resolved.template.content) {
      setApplyError("Preset template not available locally.");
      setApplyStatus((prev) => ({ ...prev, [presetKey]: "error" }));
      return;
    }

    setApplyStatus((prev) => ({ ...prev, [presetKey]: "loading" }));
    setApplyError(null);
    setApplyHint((prev) => ({ ...prev, [presetKey]: "" }));

    try {
      if (activeProvider && activeProvider !== presetKey) {
        const prevKeys = getTemplateEnvKeys(activeProvider);
        if (prevKeys.length > 0) {
          await invoke("snapshot_provider_context", {
            providerKey: activeProvider,
            envKeys: prevKeys,
          });
        }
      }

      const parsed = JSON.parse(resolved.template.content);
      const keyMapping = presetEnvKeyMappings[presetKey] || {};
      const extraEnv = presetExtraEnv[presetKey] || {};
      const contextEnv = getProviderContextEnv(presetKey);

      if (presetKey === "anthropic-subscription") {
        parsed.env = { CLAUDE_CODE_USE_OAUTH: "1" };
      } else if (parsed.env) {
        const templateKeys = Object.keys(parsed.env);
        const isReapplyActive = activeProvider === presetKey;
        for (const key of templateKeys) {
          if (contextEnv[key] !== undefined && contextEnv[key] !== "") {
            parsed.env[key] = contextEnv[key];
          } else if (isReapplyActive && rawEnv[key]) {
            parsed.env[key] = rawEnv[key];
          }
        }
        for (const [fromKey, toKey] of Object.entries(keyMapping)) {
          if (fromKey in parsed.env) {
            parsed.env[toKey] = parsed.env[fromKey];
            delete parsed.env[fromKey];
          }
        }
        Object.assign(parsed.env, extraEnv);
      }

      parsed.lovcode = { activeProvider: presetKey };

      await invoke("install_setting_template", { config: JSON.stringify(parsed, null, 2) });
      refreshSettings();
      setApplyStatus((prev) => ({ ...prev, [presetKey]: "success" }));
      trackProviderEvent({ action: "apply", provider: presetKey, success: true });

      if (presetKey === "anthropic-subscription") {
        setApplyHint((prev) => ({
          ...prev,
          [presetKey]: "Run /login in Claude Code and select Subscription to complete setup",
        }));
      }

      setTimeout(() => {
        setApplyStatus((prev) => ({ ...prev, [presetKey]: "idle" }));
      }, 1500);
    } catch (e) {
      setApplyStatus((prev) => ({ ...prev, [presetKey]: "error" }));
      setApplyError(String(e));
      trackProviderEvent({ action: "apply", provider: presetKey, success: false, error_message: String(e) });
    }
  };

  const refreshSettings = () => {
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    queryClient.invalidateQueries({ queryKey: ["provider_contexts"] });
  };

  const getProviderContextEnv = (presetKey: string): Record<string, string> => {
    const env = providerContexts?.[presetKey]?.env;
    return env && typeof env === "object" ? env : {};
  };

  const getEnvValueForPreset = (presetKey: string, key: string): string => {
    const ctx = getProviderContextEnv(presetKey);
    if (ctx[key] !== undefined) return ctx[key];
    if (activeProvider === presetKey) return rawEnv[key] || "";
    return "";
  };

  const getTemplateEnvKeys = (presetKey: string): string[] => {
    const resolved = getPresetTemplate(presetKey);
    if (!resolved?.template?.content) return [];
    try {
      const parsed = JSON.parse(resolved.template.content) as { env?: Record<string, unknown> };
      return parsed.env && typeof parsed.env === "object" ? Object.keys(parsed.env) : [];
    } catch {
      return [];
    }
  };

  const handleMissingValueChange = (presetKey: string, key: string, value: string) => {
    setTestMissingValues((prev) => ({
      ...prev,
      [presetKey]: { ...(prev[presetKey] || {}), [key]: value },
    }));
  };

  const handleSaveMissingAndRetest = async (presetKey: string) => {
    const missingKeys = testMissingKeys[presetKey] || [];
    if (missingKeys.length === 0) return;
    const values = testMissingValues[presetKey] || {};
    await Promise.all(
      missingKeys.map((key) => invoke("update_settings_env", { envKey: key, envValue: values[key] ?? "" }))
    );
    refreshSettings();
    const updated = await invoke<ClaudeSettings>("get_settings");
    const updatedEnv = getRawEnvFromSettings(updated);
    await handleTestPreset(presetKey, updatedEnv);
  };

  const getMissingEnvPlaceholder = (key: string) => {
    if (/proxy/i.test(key)) return "http://localhost:7890";
    return "value";
  };

  const officialProviderKeys = new Set(["anthropic-subscription", "native"]);
  const officialPresets = filteredPresets.filter((preset) => officialProviderKeys.has(preset.key));
  const partnerPresets = filteredPresets.filter((preset) => !officialProviderKeys.has(preset.key));
  const defaultProviderTab = officialPresets.length > 0 ? "official" : "partner";

  const renderPresetCard = (preset: {
    key: string;
    label: string;
    description: string;
    docsUrl?: string;
  }) => {
    const status = applyStatus[preset.key] || "idle";
    const isLoading = status === "loading";
    const isSuccess = status === "success";
    const testState = testStatus[preset.key] || "idle";
    const isTestSuccess = testState === "success";
    const isTestError = testState === "error";
    const missingKeys = testMissingKeys[preset.key] || [];
    const missingValues = testMissingValues[preset.key] || {};
    const isActive = activeProvider === preset.key;

    return (
      <div
        key={preset.key}
        className={`rounded-lg border-2 p-3 flex flex-col gap-2 w-full overflow-hidden ${
          isActive
            ? "border-primary bg-primary/10"
            : isTestSuccess
              ? "border-primary/60 bg-primary/5"
              : isTestError
                ? "border-destructive/60 bg-destructive/5"
                : "border-border bg-card-alt"
        }`}
      >
        <div className="flex w-full flex-nowrap items-start gap-3 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-ink truncate">{preset.label}</p>
              {isActive && (
                <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary text-primary-foreground">
                  Active
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-xs text-muted-foreground truncate">{preset.description}</p>
              {preset.docsUrl && (
                <button
                  className="text-muted-foreground hover:text-primary shrink-0"
                  title="Documentation"
                  onClick={(e) => {
                    e.stopPropagation();
                    openUrl(preset.docsUrl!);
                  }}
                >
                  <ExternalLinkIcon className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
          <ResponsiveActions
            variant="router"
            className="shrink-0"
            icon={
              <>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-9 w-9"
                  onClick={() => handleTogglePresetPreview(preset.key)}
                  title={expandedPresetKey === preset.key ? "Hide config" : "Show current config"}
                >
                  {expandedPresetKey === preset.key ? <EyeClosedIcon /> : <EyeOpenIcon />}
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  className={`h-9 w-9 ${isTestSuccess ? "border-primary text-primary" : isTestError ? "border-destructive text-destructive" : ""}`}
                  onClick={() => handleTestPreset(preset.key)}
                  title="Test"
                >
                  <FlaskConical className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  className="h-9 w-9 bg-primary text-primary-foreground hover:bg-primary/90"
                  disabled={isLoading}
                  onClick={() => handleApplyPreset(preset.key)}
                  title={isLoading ? "Applying..." : isSuccess ? "Applied" : "Apply"}
                >
                  <RocketIcon />
                </Button>
              </>
            }
            text={
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="max-w-[8.5rem]"
                  onClick={() => handleTogglePresetPreview(preset.key)}
                >
                  <span className="block truncate">{expandedPresetKey === preset.key ? "Hide config" : "Show config"}</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className={`max-w-[6rem] ${isTestSuccess ? "border-primary text-primary" : isTestError ? "border-destructive text-destructive" : ""}`}
                  onClick={() => handleTestPreset(preset.key)}
                >
                  <span className="block truncate">Test</span>
                </Button>
                <Button
                  size="sm"
                  className="bg-primary text-primary-foreground hover:bg-primary/90 max-w-[6.5rem]"
                  disabled={isLoading}
                  onClick={() => handleApplyPreset(preset.key)}
                >
                  <span className="block truncate">{isLoading ? "Applying..." : isSuccess ? "Applied" : "Apply"}</span>
                </Button>
              </>
            }
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-right">
          {isSuccess && <span className="text-xs text-green-600">Saved</span>}
          {status === "error" && <span className="text-xs text-red-600">Failed</span>}
          {applyHint[preset.key] && (
            <span className="inline-flex items-center gap-1">
              <span className="text-xs text-amber-600">{applyHint[preset.key]}</span>
              <button
                className="p-0.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-ink"
                onClick={() => setApplyHint((prev) => ({ ...prev, [preset.key]: "" }))}
                title="Dismiss"
              >
                <Cross2Icon className="w-3 h-3" />
              </button>
            </span>
          )}
          {testStatus[preset.key] === "loading" && <span className="text-xs text-muted-foreground">Testing...</span>}
          {(testStatus[preset.key] === "success" || testStatus[preset.key] === "error") && (
            <span className="inline-flex items-center gap-1">
              <span className={`text-xs ${testStatus[preset.key] === "success" ? "text-green-600" : "text-red-600"}`}>
                {testMessage[preset.key] || (testStatus[preset.key] === "error" ? "Failed" : "")}
              </span>
              <button
                className="p-0.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-ink"
                onClick={() => {
                  setTestStatus((prev) => ({ ...prev, [preset.key]: "idle" }));
                  setTestMessage((prev) => ({ ...prev, [preset.key]: "" }));
                  setTestMissingKeys((prev) => ({ ...prev, [preset.key]: [] }));
                }}
                title="Clear test status"
              >
                <Cross2Icon className="w-3 h-3" />
              </button>
            </span>
          )}
        </div>
        {expandedPresetKey === preset.key && (
          <div className="rounded-lg border border-border bg-canvas/70 p-2">
            {(() => {
              const preview = getPresetPreviewConfig(preset.key);
              const envKeys = Object.keys(preview.env);
              return (
                <>
                  {preview.note && <p className="text-xs text-muted-foreground mb-2">{preview.note}</p>}
                  {envKeys.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {envKeys.map((key) => (
                        <div key={key} className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground font-mono min-w-[10rem] shrink-0">{key}</span>
                          <input
                            className="text-xs px-2 py-1 rounded bg-canvas border border-border text-ink flex-1 font-mono"
                            placeholder="Enter value..."
                            value={getEnvValueForPreset(preset.key, key)}
                            onChange={async (e) => {
                              const value = e.target.value;
                              await invoke("set_provider_context_env", {
                                providerKey: preset.key,
                                envKey: key,
                                envValue: value,
                              });
                              if (activeProvider === preset.key) {
                                await invoke("update_settings_env", { envKey: key, envValue: value });
                              }
                              await refreshSettings();
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No configuration required.</p>
                  )}
                </>
              );
            })()}
          </div>
        )}
        {missingKeys.length > 0 && (
          <div className="rounded-lg border border-dashed border-border bg-canvas/60 p-2">
            <p className="text-xs text-muted-foreground mb-2">Fill missing env values to continue testing.</p>
            <p className="text-xs text-muted-foreground mb-2">Press Tab to accept the placeholder.</p>
            <div className="flex flex-col gap-2">
              {missingKeys.map((key) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-mono min-w-[6rem]">{key}</span>
                  <input
                    className="text-xs px-2 py-1 rounded bg-canvas border border-border text-ink flex-1"
                    placeholder={getMissingEnvPlaceholder(key)}
                    value={missingValues[key] ?? ""}
                    onChange={(e) => handleMissingValueChange(preset.key, key, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveMissingAndRetest(preset.key);
                      if (e.key === "Tab" && !(missingValues[key] ?? "").trim()) {
                        const placeholder = getMissingEnvPlaceholder(key);
                        if (placeholder !== "value") {
                          e.preventDefault();
                          handleMissingValueChange(preset.key, key, placeholder);
                        }
                      }
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="outline" onClick={() => handleSaveMissingAndRetest(preset.key)}>
                Save & Retest
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <ConfigPage>
      <PageHeader
        title="LLM Provider"
        subtitle="Switch between Anthropic official or third-party providers"
        action={applyError && <p className="text-xs text-red-600">{applyError}</p>}
      />

      <div className="flex-1 flex flex-col space-y-4">
        <SearchInput placeholder="Search providers..." value={search} onChange={setSearch} />

        <p className="text-xs text-muted-foreground">
          Configure API endpoint for Claude Code. Official options use Anthropic directly; third-party partners provide proxy services with additional models or regional access.
        </p>

        <Tabs defaultValue={defaultProviderTab} className="flex-1">
          <TabsList>
            <TabsTrigger value="official">Anthropic Official</TabsTrigger>
            <TabsTrigger value="partner">Third-Party Partners</TabsTrigger>
          </TabsList>

          <TabsContent value="official" className="mt-3 grid gap-3">
            {officialPresets.length > 0 ? (
              officialPresets.map((preset) => renderPresetCard(preset))
            ) : (
              <p className="text-xs text-muted-foreground">No official providers match the current search.</p>
            )}
          </TabsContent>

          <TabsContent value="partner" className="mt-3 grid gap-3">
            {partnerPresets.length > 0 ? (
              partnerPresets.map((preset) => renderPresetCard(preset))
            ) : (
              <p className="text-xs text-muted-foreground">No partner providers match the current search.</p>
            )}
          </TabsContent>
        </Tabs>

        <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-card">
          <div>
            <p className="text-xs font-medium text-ink">Usage Analytics</p>
            <p className="text-[10px] text-muted-foreground">
              Help improve Lovcode by sending anonymous usage data
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={analyticsEnabled}
              onChange={(e) => {
                setAnalyticsEnabledState(e.target.checked);
                setAnalyticsEnabled(e.target.checked);
              }}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-muted rounded-full peer peer-checked:bg-primary peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all" />
          </label>
        </div>
      </div>
    </ConfigPage>
  );
}
