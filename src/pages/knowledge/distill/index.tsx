import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { DistillView, KnowledgeLayout } from "../../../views/Knowledge";
import type { FeatureType } from "../../../types";

export default function KnowledgeDistillPage() {
  const navigate = useNavigate();
  const [watchEnabled, setWatchEnabled] = useState(true);

  useEffect(() => {
    invoke<boolean>("get_distill_watch_enabled").then(setWatchEnabled).catch(() => {});
  }, []);

  const handleFeatureClick = (feature: FeatureType) => {
    if (feature === "kb-distill") navigate("/knowledge/distill");
  };

  return (
    <KnowledgeLayout
      currentFeature="kb-distill"
      onFeatureClick={handleFeatureClick}
      onSourceClick={(sourceId) => navigate(`/knowledge/source/${encodeURIComponent(sourceId)}`)}
    >
      <DistillView
        onSelect={(doc) => navigate(`/knowledge/distill/${encodeURIComponent(doc.file)}`)}
        watchEnabled={watchEnabled}
        onWatchToggle={(enabled) => {
          setWatchEnabled(enabled);
          invoke("set_distill_watch_enabled", { enabled });
        }}
      />
    </KnowledgeLayout>
  );
}
