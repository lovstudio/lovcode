import { useNavigate } from "react-router-dom";
import { FeaturesView } from "../views/Features";
import type { FeatureType } from "../types";

export default function FeaturesPage() {
  const navigate = useNavigate();

  const handleFeatureClick = (feature: FeatureType) => {
    const routes: Record<FeatureType, string> = {
      "chat": "/chat",
      "basic-env": "/settings/env",
      "basic-llm": "/settings/llm",
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
      "kb-reference": "/knowledge/reference",
      "workspace": "/workspace",
      "features": "/features",
      "marketplace": "/marketplace",
      "extensions": "/extensions",
      "events": "/events",
    };
    const path = routes[feature];
    if (path) navigate(path);
  };

  return <FeaturesView onFeatureClick={handleFeatureClick} currentFeature="features" />;
}
