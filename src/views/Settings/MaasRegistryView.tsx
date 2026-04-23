import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PlusIcon, TrashIcon } from "@radix-ui/react-icons";
import { useInvokeQuery, useQueryClient } from "../../hooks";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { LoadingState, PageHeader, ConfigPage } from "../../components/config";
import type { MaasProvider, MaasModel } from "../../types";

const emptyProvider = (): MaasProvider => ({
  key: "",
  label: "",
  baseUrl: "",
  authEnvKey: "",
  models: [],
});

export function MaasRegistryView() {
  const queryClient = useQueryClient();
  const { data: registry = [], isLoading } = useInvokeQuery<MaasProvider[]>(
    ["maas_registry"],
    "get_maas_registry",
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<MaasProvider | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleDelete = async () => {
    if (!draft || isNew) return;
    if (!confirm(`Delete provider "${draft.label || draft.key}"? This cannot be undone.`)) return;
    try {
      await invoke("delete_maas_provider", { key: draft.key });
      setSelectedKey(null);
      setDraft(null);
      refresh();
    } catch (e) {
      setError(String(e));
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

  const addModel = () => {
    setDraft((prev) =>
      prev
        ? { ...prev, models: [...prev.models, { id: "", displayName: "", modelName: "" }] }
        : prev,
    );
  };

  const removeModel = (idx: number) => {
    setDraft((prev) =>
      prev ? { ...prev, models: prev.models.filter((_, i) => i !== idx) } : prev,
    );
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
          <Button
            size="sm"
            variant="outline"
            className="justify-start"
            onClick={handleAddProvider}
          >
            <PlusIcon className="w-4 h-4 mr-1.5" />
            Add Provider
          </Button>
          <div className="flex flex-col gap-1 overflow-auto">
            {registry.map((p) => {
              const isActive = !isNew && selectedKey === p.key;
              return (
                <button
                  key={p.key}
                  onClick={() => handleSelectProvider(p.key)}
                  className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                    isActive
                      ? "border-primary bg-primary/10"
                      : "border-border bg-card hover:bg-card-alt"
                  }`}
                >
                  <div className="text-sm font-medium text-foreground truncate">{p.label || p.key}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {p.models.length} model{p.models.length === 1 ? "" : "s"}
                  </div>
                </button>
              );
            })}
            {isNew && (
              <div className="px-3 py-2 rounded-lg border border-primary bg-primary/10">
                <div className="text-sm font-medium text-foreground">New provider</div>
                <div className="text-xs text-muted-foreground">unsaved</div>
              </div>
            )}
          </div>
        </div>

        {/* Right: form */}
        <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-auto">
          {!draft ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Select a provider or add a new one
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="maas-key">Key</Label>
                  <Input
                    id="maas-key"
                    value={draft.key}
                    placeholder="e.g. zenmux"
                    readOnly={!isNew}
                    onChange={(e) => updateDraft({ key: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="maas-label">Label</Label>
                  <Input
                    id="maas-label"
                    value={draft.label}
                    placeholder="e.g. ZenMux"
                    onChange={(e) => updateDraft({ label: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5 col-span-2">
                  <Label htmlFor="maas-baseurl">Base URL</Label>
                  <Input
                    id="maas-baseurl"
                    value={draft.baseUrl}
                    placeholder="e.g. https://zenmux.ai/api/anthropic"
                    onChange={(e) => updateDraft({ baseUrl: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5 col-span-2">
                  <Label htmlFor="maas-authkey">Auth Env Key</Label>
                  <Input
                    id="maas-authkey"
                    value={draft.authEnvKey}
                    placeholder="e.g. ZENMUX_API_KEY"
                    onChange={(e) => updateDraft({ authEnvKey: e.target.value })}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2 mt-2">
                <div className="flex items-center justify-between">
                  <Label>Models</Label>
                  <Button size="sm" variant="outline" onClick={addModel}>
                    <PlusIcon className="w-4 h-4 mr-1.5" />
                    Add Model
                  </Button>
                </div>
                {draft.models.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No models yet.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-[8rem_1fr_1fr_2rem] gap-2 text-xs text-muted-foreground px-1">
                      <span>ID</span>
                      <span>Display Name</span>
                      <span>Model Name (API)</span>
                      <span />
                    </div>
                    {draft.models.map((m, idx) => (
                      <div key={idx} className="grid grid-cols-[8rem_1fr_1fr_2rem] gap-2 items-center">
                        <Input
                          value={m.id}
                          placeholder="sonnet-4-6"
                          onChange={(e) => updateModel(idx, { id: e.target.value })}
                        />
                        <Input
                          value={m.displayName}
                          placeholder="Claude Sonnet 4.6"
                          onChange={(e) => updateModel(idx, { displayName: e.target.value })}
                        />
                        <Input
                          value={m.modelName}
                          placeholder="claude-sonnet-4-6-20251001"
                          onChange={(e) => updateModel(idx, { modelName: e.target.value })}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-red-600"
                          onClick={() => removeModel(idx)}
                          title="Remove model"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-border mt-auto">
                {!isNew && (
                  <Button variant="outline" className="text-red-600 hover:text-red-700" onClick={handleDelete}>
                    Delete
                  </Button>
                )}
                {isNew && (
                  <Button variant="outline" onClick={handleCancel}>
                    Cancel
                  </Button>
                )}
                <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={handleSave}>
                  Save
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </ConfigPage>
  );
}
