import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  PlusIcon,
  TrashIcon,
  DownloadIcon,
  ReloadIcon,
  EyeOpenIcon,
  EyeClosedIcon,
  CheckIcon,
  Cross2Icon,
  LightningBoltIcon,
  ExclamationTriangleIcon,
  RocketIcon,
  CubeIcon,
} from "@radix-ui/react-icons";
import { useInvokeQuery, useQueryClient } from "../../hooks";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";
import { LoadingState, PageHeader, ConfigPage } from "../../components/config";
import type { MaasProvider, MaasModel, Vendor, ClaudeSettings } from "../../types";

interface FetchParseResult {
  models: MaasModel[];
  vendors: Vendor[];
  rawPreview: string;
  notes?: string | null;
}

/** Provider keys that are integrated but not yet open for use. Shown in the
 *  list with a "Coming soon" badge and disabled in the form. */
const COMING_SOON_PROVIDERS: ReadonlySet<string> = new Set([
  "modelgate",
  "univibe",
  "siliconflow",
  "qiniu",
]);

/** Built-in provider keys. Mirrors `is_builtin_maas_key` in the Rust backend.
 *  These cannot be deleted — the backend resurrects them on next load. */
const BUILTIN_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "anthropic-subscription",
  "native",
  "zenmux",
  "modelgate",
  "qiniu",
  "siliconflow",
  "univibe",
]);

/** Optional URL where users can grab the API key for a given provider. */
const PROVIDER_API_KEY_URLS: Record<string, string> = {
  zenmux: "https://zenmux.ai/platform/subscription",
};

/** Lightweight, deterministic, non-reversible fingerprint of a token. Used
 *  only to detect whether the saved token still matches the one that was last
 *  verified. Not a security primitive — the token itself is already plaintext
 *  on disk in maas_registry.json. */
/** Pick a model name to probe the provider with. Preference order:
 *  1. an Anthropic Claude Sonnet model (most stable across MaaS resellers)
 *  2. any Anthropic Claude model
 *  3. the first model whose modelName looks Anthropic-shaped
 *  4. a hardcoded last resort */
function pickVerifyModel(p: MaasProvider): string {
  const models = p.models.filter((m) => m.modelName.trim());
  const isAnthropic = (m: MaasModel) =>
    m.vendor === "anthropic" || /(?:^|\/)claude-/i.test(m.modelName);
  const anthropic = models.filter(isAnthropic);
  const sonnet = anthropic.find((m) => /sonnet/i.test(m.modelName));
  if (sonnet) return sonnet.modelName.trim();
  if (anthropic[0]) return anthropic[0].modelName.trim();
  // No Anthropic model in the catalog — fall back to a known-good slug.
  // ZenMux-style providers expect the "anthropic/" prefix; native does not.
  return p.baseUrl.includes("zenmux") || p.models.some((m) => m.modelName.includes("/"))
    ? "anthropic/claude-sonnet-4.6"
    : "claude-sonnet-4-5";
}

/** Classify a /v1/messages probe response into a verify outcome.
 *
 *  Anthropic returns "Credit balance is too low" / `credit_balance_too_low`
 *  with HTTP 400 even when the API key is perfectly valid — the account simply
 *  has no credits, or the requested model needs a higher usage tier. Treating
 *  that as "verify failed" would block users who *could* use the key once they
 *  top up. So we classify those as `warning` (key still considered verified).
 *
 *  - 2xx → success
 *  - 401 / authentication_error → error (key is actually bad)
 *  - 400 + credit_balance_too_low → warning (key valid, no credits / wrong tier)
 *  - 429 rate_limit → warning (key valid, just throttled)
 *  - 5xx → warning ("inconclusive" — upstream issue, don't punish the key)
 *  - other 4xx → error
 */
function classifyAnthropicProbe(
  status: number,
  body: string,
): { kind: "success"; detail: string } | { kind: "warning"; detail: string } | { kind: "error"; detail: string } {
  const lower = body.toLowerCase();
  if (status >= 200 && status < 300) {
    return { kind: "success", detail: "" };
  }
  if (status === 401 || lower.includes("authentication_error") || lower.includes("invalid x-api-key")) {
    return { kind: "error", detail: extractErrorMessage(body) || `HTTP ${status}` };
  }
  if (status === 400 && (lower.includes("credit_balance_too_low") || lower.includes("credit balance is too low"))) {
    return {
      kind: "warning",
      detail: "Key valid, but the account has no credits (or the model needs a higher usage tier).",
    };
  }
  if (status === 429 || lower.includes("rate_limit")) {
    return { kind: "warning", detail: "Key valid — currently rate-limited. Try again in a moment." };
  }
  if (status >= 500) {
    return { kind: "warning", detail: `Upstream ${status} — could not confirm key. Try again later.` };
  }
  return { kind: "error", detail: extractErrorMessage(body) || `HTTP ${status}` };
}

/** Try to pull the human "message" out of an Anthropic-style error body. */
function extractErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const msg = j?.error?.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  } catch {
    /* not JSON */
  }
  return body.slice(0, 160).trim();
}

function tokenFingerprint(token: string): string {
  const t = token.trim();
  if (!t) return "";
  let h = 5381;
  for (let i = 0; i < t.length; i++) {
    h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  }
  return `${t.length}:${(h >>> 0).toString(16)}`;
}

/** "verified" only when both timestamp and fingerprint match the current token.
 *  For the OAuth subscription provider the hash is the literal "oauth" sentinel
 *  and there is no token to compare. */
function getProviderVerifyStatus(
  p: MaasProvider,
): { verified: false } | { verified: true; at: string } {
  if (!p.lastVerifiedAt || !p.lastVerifiedTokenHash) return { verified: false };
  if (p.lastVerifiedTokenHash === "oauth") {
    return { verified: true, at: p.lastVerifiedAt };
  }
  if (!p.authToken.trim()) return { verified: false };
  if (tokenFingerprint(p.authToken) !== p.lastVerifiedTokenHash) return { verified: false };
  return { verified: true, at: p.lastVerifiedAt };
}

const emptyProvider = (): MaasProvider => ({
  key: "",
  label: "",
  baseUrl: "",
  authToken: "",
  models: [],
});

export function MaasRegistryView() {
  const queryClient = useQueryClient();
  const { data: registry = [], isLoading } = useInvokeQuery<MaasProvider[]>(
    ["maas_registry"],
    "get_maas_registry",
  );
  const { data: settings } = useInvokeQuery<ClaudeSettings>(["settings"], "get_settings");

  const activeProviderKey: string | null = (() => {
    const raw = settings?.raw;
    if (!raw || typeof raw !== "object") return null;
    const lovcode = (raw as Record<string, unknown>).lovcode;
    if (!lovcode || typeof lovcode !== "object") return null;
    const v = (lovcode as Record<string, unknown>).activeProvider;
    return typeof v === "string" ? v : null;
  })();

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<MaasProvider | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchResult, setFetchResult] = useState<FetchParseResult | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [isEditingToken, setIsEditingToken] = useState(false);
  const [verifyState, setVerifyState] = useState<
    "idle" | "testing" | "success" | "warning" | "error"
  >("idle");
  const [verifyMessage, setVerifyMessage] = useState<string>("");
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [manualModel, setManualModel] = useState<MaasModel>({ id: "", displayName: "", modelName: "" });
  const [selectedFetchedIds, setSelectedFetchedIds] = useState<Set<string>>(new Set());

  const maskToken = (token: string): string => {
    if (!token) return "";
    if (token.length <= 8) return "•".repeat(token.length);
    const head = token.slice(0, 4);
    const tail = token.slice(-4);
    const mid = "•".repeat(Math.min(token.length - 8, 16));
    return `${head}${mid}${tail}`;
  };

  useEffect(() => {
    if (!selectedKey && registry.length > 0) {
      setSelectedKey(registry[0].key);
    }
  }, [registry, selectedKey]);

  useEffect(() => {
    if (isNew) return;
    const current = registry.find((p) => p.key === selectedKey) ?? null;
    setDraft(current ? { ...current, models: current.models.map((m) => ({ ...m })) } : null);
    setError(null);
    setFetchError(null);
    setFetchResult(null);
    setVerifyState("idle");
    setVerifyMessage("");
  }, [selectedKey, registry, isNew]);

  if (isLoading) return <LoadingState message="Loading MaaS registry..." />;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["maas_registry"] });

  const handleSelectProvider = (key: string) => {
    setIsNew(false);
    setSelectedKey(key);
  };

  const handleAddProvider = () => {
    setIsNew(true);
    setSelectedKey(null);
    setDraft(emptyProvider());
    setError(null);
  };

  const handleSave = async () => {
    if (!draft) return;
    const key = draft.key.trim();
    if (!key) {
      setError("Provider key is required");
      return;
    }
    if (isNew && registry.some((p) => p.key === key)) {
      setError(`Provider key "${key}" already exists`);
      return;
    }
    for (const m of draft.models) {
      if (!m.id.trim() || !m.displayName.trim() || !m.modelName.trim()) {
        setError("All model fields (id, display name, model name) are required");
        return;
      }
    }
    try {
      await invoke("upsert_maas_provider", { provider: { ...draft, key } });
      setIsNew(false);
      setSelectedKey(key);
      setError(null);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = () => {
    if (!draft || isNew) return;
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = async () => {
    if (!draft || isNew) return;
    try {
      await invoke("delete_maas_provider", { key: draft.key });
      setSelectedKey(null);
      setDraft(null);
      setDeleteConfirmOpen(false);
      refresh();
    } catch (e) {
      setError(String(e));
      setDeleteConfirmOpen(false);
    }
  };

  const handleCancel = () => {
    setIsNew(false);
    if (registry.length > 0) {
      setSelectedKey(registry[0].key);
    } else {
      setDraft(null);
    }
  };

  const updateDraft = (patch: Partial<MaasProvider>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateModel = (idx: number, patch: Partial<MaasModel>) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            models: prev.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
          }
        : prev,
    );
  };

  const removeModel = (idx: number) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, models: prev.models.filter((_, i) => i !== idx) };
      void persistDraft(next);
      return next;
    });
  };

  // Persist a provider snapshot. Only valid for already-saved providers
  // (key must exist + not in `new` mode). Returns true if persisted.
  const persistDraft = async (snapshot: MaasProvider): Promise<boolean> => {
    const key = snapshot.key.trim();
    if (!key || isNew) return false;
    try {
      await invoke("upsert_maas_provider", { provider: { ...snapshot, key } });
      refresh();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  };

  // Auto-save on blur: write the current draft if it differs from what's saved.
  // Skips new (unsaved) providers — those still need the explicit Save button.
  const handleFieldBlur = () => {
    if (isNew || !draft) return;
    const saved = registry.find((p) => p.key === draft.key);
    if (!saved) return;
    if (JSON.stringify(saved) !== JSON.stringify(draft)) {
      void persistDraft(draft);
    }
  };

  const handleFetchAndParse = async () => {
    if (!draft) return;
    const cmd = (draft.fetchCommand ?? "").trim();
    if (!cmd) {
      setFetchError("Paste a curl command first");
      return;
    }
    setIsFetching(true);
    setFetchError(null);
    setFetchResult(null);
    try {
      const result = await invoke<FetchParseResult>("fetch_and_parse_maas_models", {
        fetchCommand: cmd,
        providerKey: draft.key || "unknown",
      });
      setFetchResult(result);
      // Pre-select only models not yet present (common case: user wants the new ones).
      const existingIds = new Set(draft.models.map((m) => m.id));
      setSelectedFetchedIds(new Set(result.models.filter((m) => !existingIds.has(m.id)).map((m) => m.id)));
      // Persist the fetchCommand itself so a successful curl doesn't get lost.
      await persistDraft({ ...draft, fetchCommand: cmd });
    } catch (e) {
      setFetchError(String(e));
    } finally {
      setIsFetching(false);
    }
  };

  const mergeFetchedModels = async (mode: "append" | "replace" | "selected") => {
    if (!fetchResult || !draft) return;
    let next: MaasProvider;
    if (mode === "replace") {
      next = {
        ...draft,
        models: fetchResult.models.map((m) => ({ ...m })),
        vendors: fetchResult.vendors.map((v) => ({ ...v })),
      };
    } else {
      const candidates =
        mode === "selected"
          ? fetchResult.models.filter((m) => selectedFetchedIds.has(m.id))
          : fetchResult.models;
      const existingModelIds = new Set(draft.models.map((m) => m.id));
      const freshModels = candidates.filter((m) => !existingModelIds.has(m.id));
      const referencedVendorIds = new Set(freshModels.map((m) => m.vendor).filter(Boolean) as string[]);
      const existingVendors = draft.vendors ?? [];
      const existingVendorIds = new Set(existingVendors.map((v) => v.id));
      const freshVendors = fetchResult.vendors.filter(
        (v) => referencedVendorIds.has(v.id) && !existingVendorIds.has(v.id),
      );
      next = {
        ...draft,
        models: [...draft.models, ...freshModels.map((m) => ({ ...m }))],
        vendors: [...existingVendors, ...freshVendors.map((v) => ({ ...v }))],
      };
    }
    setDraft(next);
    setFetchResult(null);
    setSelectedFetchedIds(new Set());
    setAddModelOpen(false);
    await persistDraft(next);
  };

  const handleVerifyToken = async () => {
    if (!draft) return;

    // Anthropic Subscription: OAuth — probe `claude --print` and check it's logged in.
    if (draft.key === "anthropic-subscription") {
      setVerifyState("testing");
      setVerifyMessage("");
      try {
        const result = await invoke<{ ok: boolean; code: number; stdout: string; stderr: string }>(
          "test_claude_cli_oauth",
        );
        if (result.ok) {
          setVerifyState("success");
          setVerifyMessage("Verified · claude CLI is logged in");
          // Use a synthetic fingerprint so getProviderVerifyStatus stays consistent
          // even though there's no token. "oauth:<timestamp>" survives token-change checks
          // because authToken stays empty for this provider.
          const verified: MaasProvider = {
            ...draft,
            lastVerifiedAt: new Date().toISOString(),
            lastVerifiedTokenHash: "oauth",
          };
          setDraft(verified);
          await persistDraft(verified);
        } else {
          setVerifyState("error");
          const hint = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
          setVerifyMessage(`claude CLI not authenticated — ${hint.slice(0, 200)}`);
        }
      } catch (e) {
        setVerifyState("error");
        setVerifyMessage(String(e));
      }
      return;
    }

    const token = draft.authToken.trim();
    if (!token) {
      setVerifyState("error");
      setVerifyMessage("Token is empty");
      return;
    }
    const baseUrl = (draft.baseUrl || "https://api.anthropic.com").trim();
    // Pick a stable, well-supported Anthropic model for the connectivity probe.
    // Falling back to draft.models[0] is unreliable: many MaaS catalogs sort by
    // recency, putting low-quota free models first that frequently 429.
    const model = pickVerifyModel(draft);
    setVerifyState("testing");
    setVerifyMessage("");
    try {
      const result = await invoke<{ ok: boolean; status: number; body: string }>(
        "test_anthropic_connection",
        { baseUrl, authToken: token, model },
      );
      const verdict = classifyAnthropicProbe(result.status, result.body);
      if (verdict.kind === "success" || verdict.kind === "warning") {
        // Both outcomes mean the key is real — stamp it as verified.
        setVerifyState(verdict.kind);
        setVerifyMessage(
          verdict.kind === "success"
            ? `Verified · model "${model}"`
            : `Verified, but: ${verdict.detail}`,
        );
        const verified: MaasProvider = {
          ...draft,
          lastVerifiedAt: new Date().toISOString(),
          lastVerifiedTokenHash: tokenFingerprint(token),
        };
        setDraft(verified);
        await persistDraft(verified);
      } else {
        setVerifyState("error");
        setVerifyMessage(verdict.detail);
      }
    } catch (e) {
      setVerifyState("error");
      setVerifyMessage(String(e));
    }
  };

  const handleEnableProvider = async () => {
    if (!draft) return;
    if (COMING_SOON_PROVIDERS.has(draft.key)) {
      setError("This provider is not yet available");
      return;
    }
    const verifyOk = getProviderVerifyStatus(draft).verified;
    if (!verifyOk) {
      setError("Verify the token before enabling this provider");
      return;
    }
    try {
      // Snapshot the current active provider's env so a future re-enable can restore it
      const prevActive = activeProviderKey;
      if (prevActive && prevActive !== draft.key) {
        await invoke("snapshot_provider_context", {
          providerKey: prevActive,
          envKeys: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
        }).catch(() => {
          /* best-effort */
        });
      }

      if (draft.key === "anthropic-subscription") {
        // OAuth flow: clear token + base url, set the OAuth flag
        await invoke("update_settings_env", { envKey: "CLAUDE_CODE_USE_OAUTH", envValue: "1" });
        await invoke("delete_settings_env", { envKey: "ANTHROPIC_AUTH_TOKEN" }).catch(() => {});
        await invoke("delete_settings_env", { envKey: "ANTHROPIC_BASE_URL" }).catch(() => {});
        await invoke("delete_settings_env", { envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL" }).catch(() => {});
      } else {
        await invoke("update_settings_env", {
          envKey: "ANTHROPIC_BASE_URL",
          envValue: draft.baseUrl.trim(),
        });
        await invoke("update_settings_env", {
          envKey: "ANTHROPIC_AUTH_TOKEN",
          envValue: draft.authToken.trim(),
        });
        await invoke("update_settings_env", {
          envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
          envValue: pickVerifyModel(draft),
        });
        await invoke("delete_settings_env", { envKey: "CLAUDE_CODE_USE_OAUTH" }).catch(() => {});
      }

      await invoke("update_settings_field", {
        field: "lovcode",
        value: { activeProvider: draft.key },
      });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setError(null);
    } catch (e) {
      setError(`Failed to enable: ${e}`);
    }
  };

  const addManualModel = async () => {
    if (!draft) return;
    const id = manualModel.id.trim();
    const displayName = manualModel.displayName.trim();
    const modelName = manualModel.modelName.trim();
    if (!id || !displayName || !modelName) {
      setError("Manual model requires id, display name, and model name");
      return;
    }
    if (draft.models.some((m) => m.id === id)) {
      setError(`Model id "${id}" already exists`);
      return;
    }
    const next: MaasProvider = {
      ...draft,
      models: [...draft.models, { ...manualModel, id, displayName, modelName }],
    };
    setDraft(next);
    setManualModel({ id: "", displayName: "", modelName: "" });
    setAddModelOpen(false);
    setError(null);
    await persistDraft(next);
  };

  return (
    <ConfigPage>
      <PageHeader
        title="MaaS Registry"
        subtitle="Manage providers and their display-name to API-model-name mappings"
        action={error && <p className="text-xs text-red-600">{error}</p>}
      />

      <div className="flex-1 flex gap-4 min-h-0">
        {/* Left: provider list */}
        <div className="w-64 flex flex-col gap-2 flex-shrink-0">
          <div className="flex flex-col gap-1 overflow-auto">
            {(() => {
              const officialKeys = new Set(["anthropic-subscription", "native"]);
              const official = registry.filter((p) => officialKeys.has(p.key));
              // Third-party = built-in non-Anthropic providers (zenmux, modelgate, ...).
              // Custom = user-created providers (anything not in BUILTIN_PROVIDER_KEYS).
              // Coming-soon providers sink to the bottom of the third-party group.
              const thirdParty = registry
                .filter((p) => BUILTIN_PROVIDER_KEYS.has(p.key) && !officialKeys.has(p.key))
                .slice()
                .sort((a, b) => {
                  const aSoon = COMING_SOON_PROVIDERS.has(a.key) ? 1 : 0;
                  const bSoon = COMING_SOON_PROVIDERS.has(b.key) ? 1 : 0;
                  return aSoon - bSoon;
                });
              const custom = registry.filter((p) => !BUILTIN_PROVIDER_KEYS.has(p.key));
              const renderItem = (p: MaasProvider) => {
                const isSelected = !isNew && selectedKey === p.key;
                const isActive = activeProviderKey === p.key;
                const isComingSoon = COMING_SOON_PROVIDERS.has(p.key);
                const verifyStatus = getProviderVerifyStatus(p);
                const isOAuth = p.key === "anthropic-subscription";
                const hasToken = p.authToken.trim().length > 0 || isOAuth;
                const tooltipParts: string[] = [];
                if (isComingSoon) tooltipParts.push("Integration coming soon");
                if (isActive) tooltipParts.push("Active — currently used by Claude Code");
                if (verifyStatus.verified) {
                  tooltipParts.push(
                    `Verified at ${new Date(verifyStatus.at).toLocaleString()}`,
                  );
                } else if (hasToken && !isComingSoon) {
                  tooltipParts.push("Token not verified — open this provider and click Verify");
                }
                const tooltip = tooltipParts.join("\n") || undefined;
                return (
                  <button
                    key={p.key}
                    onClick={() => handleSelectProvider(p.key)}
                    className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:bg-card-alt"
                    } ${isComingSoon ? "opacity-60" : ""}`}
                    title={tooltip}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate flex-1">
                        {p.label || p.key}
                      </div>
                      {isComingSoon ? (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 flex-shrink-0">
                          Soon
                        </span>
                      ) : (
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {/* Active is the dominant signal — full pill in primary terracotta */}
                          {isActive && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary text-primary-foreground">
                              Active
                            </span>
                          )}
                          {/* Subtle verify status: small icon only, no badge */}
                          {verifyStatus.verified ? (
                            <CheckIcon className="w-3.5 h-3.5 text-muted-foreground" />
                          ) : hasToken ? (
                            <ExclamationTriangleIcon className="w-3.5 h-3.5 text-amber-600" />
                          ) : null}
                        </div>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {isComingSoon
                        ? "Coming soon"
                        : `${p.models.length} model${p.models.length === 1 ? "" : "s"}`}
                    </div>
                  </button>
                );
              };
              const sectionHeader = (text: string) => (
                <div className="px-1 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {text}
                </div>
              );
              return (
                <>
                  {official.length > 0 && sectionHeader("Anthropic Official")}
                  {official.map(renderItem)}
                  {thirdParty.length > 0 && sectionHeader("Third-Party MaaS")}
                  {thirdParty.map(renderItem)}
                  {sectionHeader("Custom")}
                  {custom.map(renderItem)}
                  {isNew && (
                    <div className="mt-1 px-3 py-2 rounded-lg border border-primary bg-primary/10">
                      <div className="text-sm font-medium text-foreground">New provider</div>
                      <div className="text-xs text-muted-foreground">unsaved</div>
                    </div>
                  )}
                  {!isNew && (
                    <button
                      onClick={handleAddProvider}
                      className="mt-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors"
                    >
                      <PlusIcon className="w-3.5 h-3.5" />
                      自定义 Provider
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        {/* Right: form */}
        <div className="flex-1 min-w-0 flex flex-col gap-4 overflow-auto rounded-xl border border-border bg-card p-5">
          {!draft ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Select a provider or add a new one
            </div>
          ) : (
            <>
              {COMING_SOON_PROVIDERS.has(draft.key) && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span className="font-semibold">Coming soon.</span>{" "}
                  Integration with this provider is in progress and not yet available for configuration.
                </div>
              )}
              <fieldset
                disabled={COMING_SOON_PROVIDERS.has(draft.key)}
                className="flex flex-col gap-6 disabled:opacity-60 disabled:pointer-events-none"
              >
              <section className="flex flex-col gap-3">
                <header className="flex items-baseline justify-between gap-2 border-b border-border pb-1.5">
                  <h3 className="font-serif text-base font-semibold text-foreground">Configuration</h3>
                  <span className="text-xs text-muted-foreground">
                    Connection details &amp; activation
                  </span>
                </header>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="maas-key">Key</Label>
                  <Input
                    id="maas-key"
                    value={draft.key}
                    placeholder="e.g. zenmux"
                    readOnly={!isNew}
                    onChange={(e) => updateDraft({ key: e.target.value })}
                    onBlur={handleFieldBlur}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="maas-label">Label</Label>
                  <Input
                    id="maas-label"
                    value={draft.label}
                    placeholder="e.g. ZenMux"
                    onChange={(e) => updateDraft({ label: e.target.value })}
                    onBlur={handleFieldBlur}
                  />
                </div>
                <div className="flex flex-col gap-1.5 col-span-2">
                  <Label htmlFor="maas-baseurl">Base URL</Label>
                  <Input
                    id="maas-baseurl"
                    value={draft.baseUrl}
                    placeholder={
                      draft.key === "anthropic-subscription"
                        ? "Not used — OAuth login uses Anthropic's default endpoint"
                        : "e.g. https://zenmux.ai/api/anthropic"
                    }
                    disabled={draft.key === "anthropic-subscription"}
                    onChange={(e) => updateDraft({ baseUrl: e.target.value })}
                    onBlur={handleFieldBlur}
                  />
                </div>
                <div className="flex flex-col gap-1.5 col-span-2">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <Label htmlFor="maas-authtoken">API Key / Token</Label>
                    <div className="flex items-center gap-3">
                      {PROVIDER_API_KEY_URLS[draft.key] && (
                        <a
                          href={PROVIDER_API_KEY_URLS[draft.key]}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline"
                          onClick={(e) => {
                            e.preventDefault();
                            void openUrl(PROVIDER_API_KEY_URLS[draft.key]);
                          }}
                        >
                          Get API key →
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="relative">
                    <Input
                      id="maas-authtoken"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={
                        showToken || isEditingToken
                          ? draft.authToken
                          : maskToken(draft.authToken)
                      }
                      placeholder="sk-... / sb_secret_... / Bearer token"
                      className="pr-20 font-mono"
                      onFocus={() => setIsEditingToken(true)}
                      onChange={(e) => {
                        updateDraft({ authToken: e.target.value });
                        if (verifyState !== "idle") {
                          setVerifyState("idle");
                          setVerifyMessage("");
                        }
                      }}
                      onBlur={() => {
                        setIsEditingToken(false);
                        handleFieldBlur();
                      }}
                    />
                    <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setShowToken((v) => !v)}
                        className="p-1.5 text-muted-foreground hover:text-foreground"
                        title={showToken ? "Hide" : "Show full token"}
                      >
                        {showToken ? (
                          <EyeClosedIcon className="w-4 h-4" />
                        ) : (
                          <EyeOpenIcon className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={
                          verifyState === "testing" ||
                          (draft.key !== "anthropic-subscription" && !draft.authToken.trim())
                        }
                        onClick={handleVerifyToken}
                        title={
                          verifyState === "success"
                            ? `Verified — ${verifyMessage}`
                            : verifyState === "warning"
                              ? `Verified with warning — ${verifyMessage} (click to retry)`
                              : verifyState === "error"
                                ? `Failed — ${verifyMessage} (click to retry)`
                                : verifyState === "testing"
                                  ? "Verifying..."
                                  : "Verify token by calling the provider's API"
                        }
                        className={`p-1.5 rounded-md disabled:opacity-50 disabled:pointer-events-none ${
                          verifyState === "success"
                            ? "text-primary hover:bg-primary/10"
                            : verifyState === "warning"
                              ? "text-amber-600 hover:bg-amber-50"
                              : verifyState === "error"
                                ? "text-red-600 hover:bg-red-50"
                                : "text-muted-foreground hover:text-foreground hover:bg-card-alt"
                        }`}
                      >
                        {verifyState === "testing" ? (
                          <ReloadIcon className="w-4 h-4 animate-spin" />
                        ) : verifyState === "success" ? (
                          <CheckIcon className="w-4 h-4" />
                        ) : verifyState === "warning" ? (
                          <ExclamationTriangleIcon className="w-4 h-4" />
                        ) : verifyState === "error" ? (
                          <Cross2Icon className="w-4 h-4" />
                        ) : (
                          <LightningBoltIcon className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                  {(verifyState === "error" || verifyState === "warning") && verifyMessage && (
                    <p
                      className={`text-xs break-all ${
                        verifyState === "warning" ? "text-amber-700" : "text-red-600"
                      }`}
                      title={verifyMessage}
                    >
                      {verifyMessage}
                    </p>
                  )}
                </div>
              </div>

              {(() => {
                const isActive = activeProviderKey === draft.key;
                const verifyOk = getProviderVerifyStatus(draft).verified;
                const reason = !verifyOk
                  ? "Verify the token first"
                  : isActive
                    ? "This provider is currently active"
                    : "";
                return (
                  <div
                    className={`flex flex-col gap-3 rounded-xl border px-4 py-3 transition-colors ${
                      isActive
                        ? "border-primary/40 bg-primary/5"
                        : verifyOk
                          ? "border-border bg-card-alt/60"
                          : "border-dashed border-border bg-card-alt/30"
                    }`}
                  >
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {isActive ? "Active provider" : "Enable this provider"}
                        </span>
                        {isActive && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary text-primary-foreground">
                            Live
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {isActive
                          ? "Claude Code is using this provider for all requests."
                          : verifyOk
                            ? "Set as Claude Code's active LLM provider."
                            : "Verify the token first to unlock activation."}
                      </span>
                    </div>
                    <Button
                      className="w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
                      disabled={isActive || !verifyOk}
                      onClick={handleEnableProvider}
                      title={reason || undefined}
                    >
                      {isActive ? (
                        <>
                          <CheckIcon className="w-4 h-4 mr-1.5" />
                          Active
                        </>
                      ) : (
                        <>
                          <RocketIcon className="w-4 h-4 mr-1.5" />
                          Enable
                        </>
                      )}
                    </Button>
                  </div>
                );
              })()}
              </section>

              <section className="flex flex-col gap-3">
                <header className="flex items-baseline justify-between gap-2 border-b border-border pb-1.5">
                  <h3 className="font-serif text-base font-semibold text-foreground">
                    Supported Models
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {draft.models.length} model{draft.models.length === 1 ? "" : "s"}
                    {(draft.vendors?.length ?? 0) > 0 && ` · ${draft.vendors!.length} vendors`}
                  </span>
                </header>

              {(draft.vendors?.length ?? 0) > 0 && (
                <div className="flex flex-col gap-2">
                  <Label className="text-xs text-muted-foreground">Vendors</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {draft.vendors!.map((v) => (
                      <span
                        key={v.id}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-card-alt text-xs"
                        title={v.description ?? v.name}
                      >
                        {v.iconUrl && (
                          <img
                            src={v.iconUrl}
                            alt=""
                            className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = "none";
                            }}
                          />
                        )}
                        <span className="font-mono">{v.id}</span>
                        {v.name !== v.id && <span className="text-muted-foreground">— {v.name}</span>}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {(() => {
                const openAdd = () => {
                  setManualModel({ id: "", displayName: "", modelName: "" });
                  setSelectedFetchedIds(new Set());
                  setFetchError(null);
                  setAddModelOpen(true);
                };
                if (draft.models.length === 0) {
                  return (
                    <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border bg-card-alt/30 px-6 py-10 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <CubeIcon className="w-6 h-6" />
                      </div>
                      <div className="flex flex-col gap-1">
                        <p className="text-sm font-medium text-foreground">No models yet</p>
                        <p className="text-xs text-muted-foreground max-w-xs">
                          Add models manually or auto-fetch the platform's catalog with a curl command.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                        onClick={openAdd}
                      >
                        <PlusIcon className="w-4 h-4 mr-1.5" />
                        Add your first model
                      </Button>
                    </div>
                  );
                }
                return null;
              })()}

              {draft.models.length > 0 && (
              <div className="flex flex-col gap-3">
                <div className="rounded-lg border border-border overflow-hidden">
                  <div className="max-h-80 overflow-auto">
                    <div className="grid grid-cols-[8rem_6rem_1fr_1fr_2rem] gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-card-alt px-2 py-1.5 border-b border-border sticky top-0 z-10">
                      <span>ID</span>
                      <span>Vendor</span>
                      <span>Display Name</span>
                      <span>Model Name (API)</span>
                      <span />
                    </div>
                    {draft.models.map((m, idx) => (
                      <div
                        key={idx}
                        className="group grid grid-cols-[8rem_6rem_1fr_1fr_2rem] gap-2 items-center px-2 py-1 border-b border-border last:border-b-0 hover:bg-card-alt/50 transition-colors"
                      >
                        <Input
                          value={m.id}
                          placeholder="sonnet-4-6"
                          className="h-8 border-transparent bg-transparent hover:bg-background focus-visible:bg-background"
                          onChange={(e) => updateModel(idx, { id: e.target.value })}
                          onBlur={handleFieldBlur}
                        />
                        <Input
                          value={m.vendor ?? ""}
                          placeholder="anthropic"
                          className="h-8 border-transparent bg-transparent hover:bg-background focus-visible:bg-background"
                          onChange={(e) => updateModel(idx, { vendor: e.target.value || undefined })}
                          onBlur={handleFieldBlur}
                        />
                        <Input
                          value={m.displayName}
                          placeholder="Claude Sonnet 4.6"
                          className="h-8 border-transparent bg-transparent hover:bg-background focus-visible:bg-background"
                          onChange={(e) => updateModel(idx, { displayName: e.target.value })}
                          onBlur={handleFieldBlur}
                        />
                        <Input
                          value={m.modelName}
                          placeholder="claude-sonnet-4-6-20251001"
                          className="h-8 border-transparent bg-transparent hover:bg-background focus-visible:bg-background font-mono text-xs"
                          onChange={(e) => updateModel(idx, { modelName: e.target.value })}
                          onBlur={handleFieldBlur}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-red-600 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                          onClick={() => removeModel(idx)}
                          title="Remove model"
                        >
                          <TrashIcon className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setManualModel({ id: "", displayName: "", modelName: "" });
                    setSelectedFetchedIds(new Set());
                    setFetchError(null);
                    setAddModelOpen(true);
                  }}
                >
                  <PlusIcon className="w-4 h-4 mr-1.5" />
                  Add Model
                </Button>
              </div>
              )}
              </section>
              </fieldset>

              {(isNew || !BUILTIN_PROVIDER_KEYS.has(draft.key)) && (
                <div className="flex items-center justify-between gap-2 pt-3 border-t border-border mt-auto">
                  {!isNew && !BUILTIN_PROVIDER_KEYS.has(draft.key) ? (
                    <Button
                      variant="outline"
                      className="text-red-600 hover:text-red-700"
                      onClick={handleDelete}
                    >
                      <TrashIcon className="w-4 h-4 mr-1.5" />
                      Delete provider
                    </Button>
                  ) : (
                    <span />
                  )}
                  {isNew && (
                    <div className="flex items-center gap-2 ml-auto">
                      <Button variant="outline" onClick={handleCancel}>
                        Cancel
                      </Button>
                      <Button
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                        onClick={handleSave}
                      >
                        <PlusIcon className="w-4 h-4 mr-1.5" />
                        Create provider
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete provider?</DialogTitle>
                    <DialogDescription>
                      Permanently delete{" "}
                      <span className="font-mono text-foreground">
                        {draft.label || draft.key}
                      </span>
                      ? Its models, vendors, fetch command and verification status will be lost.
                      This cannot be undone.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="outline"
                      className="bg-red-600 text-white hover:bg-red-700 border-red-600"
                      onClick={confirmDelete}
                    >
                      <TrashIcon className="w-4 h-4 mr-1.5" />
                      Delete
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Dialog
                open={addModelOpen}
                onOpenChange={(o) => {
                  setAddModelOpen(o);
                  if (!o) {
                    setFetchError(null);
                    setFetchResult(null);
                  }
                }}
              >
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Add Model</DialogTitle>
                    <DialogDescription>
                      Manually enter a model, or auto-fetch the platform's catalog and pick from it.
                    </DialogDescription>
                  </DialogHeader>

                  <Tabs defaultValue="manual" className="w-full">
                    <TabsList className="grid grid-cols-2 w-full bg-card-alt">
                      <TabsTrigger value="manual">Manual</TabsTrigger>
                      <TabsTrigger value="auto">Auto-fetch</TabsTrigger>
                    </TabsList>

                    <TabsContent value="manual" className="pt-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="manual-id">ID</Label>
                          <Input
                            id="manual-id"
                            value={manualModel.id}
                            placeholder="sonnet-4-6"
                            onChange={(e) => setManualModel((m) => ({ ...m, id: e.target.value }))}
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="manual-vendor">Vendor (optional)</Label>
                          <Input
                            id="manual-vendor"
                            value={manualModel.vendor ?? ""}
                            placeholder="anthropic"
                            onChange={(e) =>
                              setManualModel((m) => ({ ...m, vendor: e.target.value || undefined }))
                            }
                          />
                        </div>
                        <div className="flex flex-col gap-1.5 col-span-2">
                          <Label htmlFor="manual-display">Display Name</Label>
                          <Input
                            id="manual-display"
                            value={manualModel.displayName}
                            placeholder="Claude Sonnet 4.6"
                            onChange={(e) =>
                              setManualModel((m) => ({ ...m, displayName: e.target.value }))
                            }
                          />
                        </div>
                        <div className="flex flex-col gap-1.5 col-span-2">
                          <Label htmlFor="manual-modelname">Model Name (API)</Label>
                          <Input
                            id="manual-modelname"
                            value={manualModel.modelName}
                            placeholder="claude-sonnet-4-6-20251001"
                            onChange={(e) =>
                              setManualModel((m) => ({ ...m, modelName: e.target.value }))
                            }
                          />
                        </div>
                      </div>
                    </TabsContent>

                    <TabsContent value="auto" className="pt-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                          Paste the platform's models-listing curl command.
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleFetchAndParse}
                          disabled={isFetching || !(draft.fetchCommand ?? "").trim()}
                        >
                          {isFetching ? (
                            <ReloadIcon className="w-4 h-4 mr-1.5 animate-spin" />
                          ) : (
                            <DownloadIcon className="w-4 h-4 mr-1.5" />
                          )}
                          {isFetching ? "Fetching..." : "Fetch & Parse"}
                        </Button>
                      </div>
                      <textarea
                        value={draft.fetchCommand ?? ""}
                        onChange={(e) => updateDraft({ fetchCommand: e.target.value })}
                        onBlur={() => {
                          if (isNew || !draft) return;
                          const saved = registry.find((p) => p.key === draft.key)?.fetchCommand ?? "";
                          if ((draft.fetchCommand ?? "") !== saved) {
                            void persistDraft(draft);
                          }
                        }}
                        placeholder={`curl 'https://example.com/api/models' -H 'authorization: Bearer ...' -b 'session=...'`}
                        rows={4}
                        spellCheck={false}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      />
                      {fetchError && (
                        <pre className="text-xs text-red-600 whitespace-pre-wrap break-all max-h-32 overflow-auto">
                          {fetchError}
                        </pre>
                      )}
                      {fetchResult && fetchResult.models.length > 0 && (() => {
                        const existingIds = new Set(draft.models.map((m) => m.id));
                        const allFetchedIds = fetchResult.models.map((m) => m.id);
                        const allSelected =
                          allFetchedIds.length > 0 && allFetchedIds.every((id) => selectedFetchedIds.has(id));
                        return (
                          <div className="flex flex-col gap-2 rounded-md border border-border bg-background">
                            <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border">
                              <p className="text-xs text-muted-foreground">
                                {fetchResult.models.length} models · {fetchResult.vendors.length} vendors ·{" "}
                                {selectedFetchedIds.size} selected
                              </p>
                              <button
                                type="button"
                                className="text-xs text-primary hover:underline"
                                onClick={() =>
                                  setSelectedFetchedIds(allSelected ? new Set() : new Set(allFetchedIds))
                                }
                              >
                                {allSelected ? "Deselect all" : "Select all"}
                              </button>
                            </div>
                            <div className="max-h-64 overflow-auto">
                              {fetchResult.models.map((m) => {
                                const isExisting = existingIds.has(m.id);
                                const isSelected = selectedFetchedIds.has(m.id);
                                return (
                                  <label
                                    key={m.id}
                                    className={`grid grid-cols-[auto_8rem_6rem_1fr_1.5fr] gap-2 items-center text-xs px-2 py-1 border-t border-border first:border-t-0 cursor-pointer ${
                                      isExisting ? "opacity-50" : "hover:bg-card-alt"
                                    }`}
                                    title={isExisting ? "Already in this provider" : ""}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      disabled={isExisting}
                                      onChange={(e) => {
                                        setSelectedFetchedIds((prev) => {
                                          const next = new Set(prev);
                                          if (e.target.checked) next.add(m.id);
                                          else next.delete(m.id);
                                          return next;
                                        });
                                      }}
                                    />
                                    <span className="font-mono truncate" title={m.id}>
                                      {m.id}
                                    </span>
                                    <span className="truncate text-muted-foreground" title={m.vendor ?? ""}>
                                      {m.vendor ?? "—"}
                                    </span>
                                    <span className="truncate" title={m.displayName}>
                                      {m.displayName}
                                    </span>
                                    <span
                                      className="font-mono truncate text-muted-foreground"
                                      title={m.modelName}
                                    >
                                      {m.modelName}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </TabsContent>
                  </Tabs>

                  <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => setAddModelOpen(false)}>
                      Cancel
                    </Button>
                    {fetchResult && fetchResult.models.length > 0 ? (
                      <>
                        <Button
                          variant="outline"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => mergeFetchedModels("replace")}
                        >
                          Replace all ({fetchResult.models.length})
                        </Button>
                        <Button
                          className="bg-primary text-primary-foreground hover:bg-primary/90"
                          disabled={selectedFetchedIds.size === 0}
                          onClick={() => mergeFetchedModels("selected")}
                        >
                          Add selected ({selectedFetchedIds.size})
                        </Button>
                      </>
                    ) : (
                      <Button
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                        onClick={addManualModel}
                      >
                        Add
                      </Button>
                    )}
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>
      </div>
    </ConfigPage>
  );
}
