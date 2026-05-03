import { useNavigate, useParams } from "react-router-dom";
import { SourceView, KnowledgeLayout } from "../../../../views/Knowledge";
import type { FeatureType } from "../../../../types";

export default function KnowledgeSourceDocPage() {
  const navigate = useNavigate();
  const params = useParams();
  const id = params.id ? decodeURIComponent(params.id) : "";
  const docPath = params["*"] ? decodeURIComponent(params["*"]) : "";

  if (!id || !docPath) {
    navigate("/knowledge/distill", { replace: true });
    return null;
  }

  const handleFeatureClick = (feature: FeatureType) => {
    if (feature === "kb-distill") navigate("/knowledge/distill");
  };

  return (
    <KnowledgeLayout
      currentFeature={null}
      currentSourceId={id}
      onFeatureClick={handleFeatureClick}
      onSourceClick={(sourceId) => navigate(`/knowledge/source/${encodeURIComponent(sourceId)}`)}
    >
      <SourceView
        sourceId={id}
        initialDocPath={docPath}
        onDocOpen={(nextPath) =>
          navigate(`/knowledge/source/${encodeURIComponent(id)}/${encodeURIComponent(nextPath)}`, { replace: true })
        }
        onDocClose={() => navigate(`/knowledge/source/${encodeURIComponent(id)}`)}
      />
    </KnowledgeLayout>
  );
}
