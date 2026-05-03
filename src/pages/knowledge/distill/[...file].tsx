import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { DistillDetailView, KnowledgeLayout } from "../../../views/Knowledge";
import { LoadingState } from "../../../components/config";
import type { DistillDocument, FeatureType } from "../../../types";

export default function DistillDetailPage() {
  const navigate = useNavigate();
  const params = useParams();
  const file = params["*"] ? decodeURIComponent(params["*"]) : "";

  const [document, setDocument] = useState<DistillDocument | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!file) {
      navigate("/knowledge/distill");
      return;
    }

    invoke<DistillDocument[]>("list_distill_documents")
      .then((docs) => {
        const doc = docs.find((d) => d.file === file);
        if (doc) {
          setDocument(doc);
        } else {
          navigate("/knowledge/distill");
        }
      })
      .catch(() => navigate("/knowledge/distill"))
      .finally(() => setLoading(false));
  }, [file, navigate]);

  const handleFeatureClick = (feature: FeatureType) => {
    if (feature === "kb-distill") navigate("/knowledge/distill");
  };
  const handleSourceClick = (sourceId: string) =>
    navigate(`/knowledge/source/${encodeURIComponent(sourceId)}`);

  const handleNavigateSession = (projectId: string, projectPath: string, sessionId: string, summary: string | null) => {
    const params = new URLSearchParams();
    params.set("projectId", projectId);
    params.set("projectPath", projectPath);
    params.set("sessionId", sessionId);
    if (summary) params.set("summary", summary);
    navigate(`/sessions?${params.toString()}`);
  };

  if (loading) {
    return (
      <KnowledgeLayout currentFeature="kb-distill" onFeatureClick={handleFeatureClick} onSourceClick={handleSourceClick}>
        <LoadingState message="Loading document..." />
      </KnowledgeLayout>
    );
  }

  if (!document) return null;

  return (
    <KnowledgeLayout currentFeature="kb-distill" onFeatureClick={handleFeatureClick} onSourceClick={handleSourceClick}>
      <DistillDetailView
        document={document}
        onBack={() => navigate("/knowledge/distill")}
        onNavigateSession={handleNavigateSession}
      />
    </KnowledgeLayout>
  );
}
