import type { ReactNode } from "react";
import { KnowledgeSidebar } from "./KnowledgeSidebar";
import type { FeatureType } from "@/types";

interface KnowledgeLayoutProps {
  children: ReactNode;
  currentFeature: FeatureType | null;
  currentSourceId?: string | null;
  onFeatureClick: (feature: FeatureType) => void;
  onSourceClick?: (sourceId: string) => void;
}

export function KnowledgeLayout({
  children,
  currentFeature,
  currentSourceId,
  onFeatureClick,
  onSourceClick,
}: KnowledgeLayoutProps) {
  return (
    <div className="flex h-full">
      <KnowledgeSidebar
        currentFeature={currentFeature}
        currentSourceId={currentSourceId}
        onFeatureClick={onFeatureClick}
        onSourceClick={onSourceClick}
      />
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
