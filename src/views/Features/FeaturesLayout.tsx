import type { ReactNode } from "react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { SidebarLayout, NavSidebar } from "@/components/shared";
import { TEMPLATE_CATEGORIES } from "@/constants";
import type { FeatureType, TemplateCategory } from "@/types";

type SidebarKey = TemplateCategory | "introduction" | "basic-env" | "basic-maas" | "basic-version" | "basic-context" | "extensions";

// Map sidebar key to route path
const KEY_TO_ROUTE: Record<SidebarKey, string> = {
  introduction: "/features",
  "basic-env": "/settings/env",
  "basic-maas": "/settings/maas",
  "basic-version": "/settings/version",
  "basic-context": "/settings/context",
  settings: "/settings",
  commands: "/commands",
  mcps: "/mcp",
  skills: "/skills",
  hooks: "/hooks",
  agents: "/agents",
  "output-styles": "/output-styles",
  statuslines: "/statusline",
  extensions: "/extensions",
};

// Map feature type to sidebar key
const FEATURE_TO_KEY: Partial<Record<FeatureType, SidebarKey>> = {
  features: "introduction",
  "basic-env": "basic-env",
  "basic-maas": "basic-maas",
  "basic-version": "basic-version",
  "basic-context": "basic-context",
  settings: "settings",
  commands: "commands",
  mcp: "mcps",
  skills: "skills",
  hooks: "hooks",
  "sub-agents": "agents",
  "output-styles": "output-styles",
  statusline: "statuslines",
  extensions: "extensions",
};

interface FeaturesLayoutProps {
  children: ReactNode;
  feature?: FeatureType;
  // Legacy props for gradual migration
  currentFeature?: FeatureType | null;
  onFeatureClick?: (feature: FeatureType) => void;
}

export function FeaturesLayout({ children, feature, currentFeature, onFeatureClick }: FeaturesLayoutProps) {
  const navigate = useNavigate();

  const groups = useMemo(() => [
    {
      title: "Quick Start",
      items: [
        { key: "introduction", label: "Introduction" },
        { key: "basic-maas", label: "MaaS Registry" },
      ],
    },
    {
      title: "Basic",
      items: [
        { key: "basic-env", label: "Environment" },
        { key: "basic-version", label: "CC Version" },
        { key: "basic-context", label: "Context" },
      ],
    },
    {
      title: "Features",
      items: [
        ...TEMPLATE_CATEGORIES.map(c => ({ key: c.key, label: c.label })),
        { key: "extensions", label: "Extensions" },
      ],
    },
  ], []);

  const activeFeature = feature ?? currentFeature;
  const activeKey = activeFeature ? FEATURE_TO_KEY[activeFeature] ?? null : null;

  const handleItemClick = (key: string) => {
    if (onFeatureClick) {
      // Legacy mode
      const keyToFeature: Record<SidebarKey, FeatureType> = {
        introduction: "features",
        "basic-env": "basic-env",
        "basic-maas": "basic-maas",
        "basic-version": "basic-version",
        "basic-context": "basic-context",
        settings: "settings",
        commands: "commands",
        mcps: "mcp",
        skills: "skills",
        hooks: "hooks",
        agents: "sub-agents",
        "output-styles": "output-styles",
        statuslines: "statusline",
        extensions: "extensions",
      };
      onFeatureClick(keyToFeature[key as SidebarKey]);
    } else {
      // Router mode
      navigate(KEY_TO_ROUTE[key as SidebarKey]);
    }
  };

  return (
    <SidebarLayout
      sidebar={
        <NavSidebar
          groups={groups}
          activeKey={activeKey}
          onItemClick={handleItemClick}
        />
      }
    >
      {children}
    </SidebarLayout>
  );
}
