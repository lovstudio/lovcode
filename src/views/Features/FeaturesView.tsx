import { FEATURES } from "@/constants";
import type { FeatureType, FeatureConfig } from "@/types";
import { FeaturesLayout } from "./FeaturesLayout";
import {
  Terminal,
  GitBranch,
  FileText,
  Settings2,
  SquareSlash,
  Network,
  Sparkles,
  Webhook,
  Bot,
  Palette,
  SquareStack,
  Puzzle,
  Layers3,
  ArrowUpRight,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";

interface FeaturesViewProps {
  onFeatureClick: (feature: FeatureType) => void;
  currentFeature: FeatureType | null;
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const ICONS: Partial<Record<FeatureType, Icon>> = {
  "basic-env": Terminal,
  "basic-maas": Network,
  "basic-version": GitBranch,
  "basic-context": FileText,
  settings: Settings2,
  commands: SquareSlash,
  mcp: Network,
  skills: Sparkles,
  hooks: Webhook,
  "sub-agents": Bot,
  "output-styles": Palette,
  statusline: SquareStack,
  extensions: Puzzle,
};

// Curated entry points — what a fresh user should touch first.
const QUICK_START: FeatureType[] = ["basic-env", "basic-maas"];

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

function QuickStartCard({
  index,
  feature,
  onClick,
}: {
  index: number;
  feature: FeatureConfig;
  onClick: () => void;
}) {
  const Icon = ICONS[feature.type] ?? Layers3;
  return (
    <button
      onClick={onClick}
      className="group relative flex flex-col justify-between h-full p-6 text-left rounded-2xl border border-border bg-card hover:border-primary/40 hover:bg-card-alt transition-[border-color,background-color] duration-300 overflow-hidden"
    >
      {/* Decorative corner mark — subtle terracotta */}
      <span
        aria-hidden
        className="absolute top-0 right-0 w-24 h-24 rounded-full -translate-y-12 translate-x-12 bg-primary/[0.06] group-hover:bg-primary/[0.12] transition-colors duration-500"
      />
      <div className="relative flex items-start justify-between">
        <span className="font-serif text-xs tracking-[0.2em] text-muted-foreground">
          {pad(index)}
        </span>
        <Icon className="w-5 h-5 text-primary/80 group-hover:text-primary transition-colors" />
      </div>
      <div className="relative mt-10">
        <div className="font-serif text-xl text-foreground leading-tight">
          {feature.label}
        </div>
        <div className="mt-2 text-sm text-muted-foreground leading-relaxed">
          {feature.description}
        </div>
        <div className="mt-5 flex items-center gap-1.5 text-xs font-medium text-primary/80 group-hover:text-primary">
          <span>Open</span>
          <ArrowUpRight className="w-3.5 h-3.5 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </div>
      </div>
    </button>
  );
}

function IndexRow({
  number,
  feature,
  onClick,
}: {
  number: number;
  feature: FeatureConfig;
  onClick: () => void;
}) {
  const Icon = ICONS[feature.type] ?? Layers3;
  return (
    <button
      onClick={onClick}
      className="group grid grid-cols-[2.5rem_1.5rem_1fr_auto] items-center gap-4 py-4 px-2 -mx-2 rounded-lg text-left hover:bg-card-alt transition-colors"
    >
      <span className="font-serif text-xs tracking-[0.2em] text-muted-foreground tabular-nums">
        {pad(number)}
      </span>
      <Icon className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
      <div className="min-w-0">
        <div className="font-medium text-foreground truncate">{feature.label}</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {feature.description}
        </div>
      </div>
      <ArrowUpRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
    </button>
  );
}

export function FeaturesView({ onFeatureClick, currentFeature }: FeaturesViewProps) {
  const byType = new Map(FEATURES.map((f) => [f.type, f]));
  const quickStartFeatures = QUICK_START.map((t) => byType.get(t)).filter(
    (f): f is FeatureConfig => Boolean(f),
  );
  const quickStartSet = new Set(QUICK_START);

  const basicLibrary = FEATURES.filter(
    (f) => f.group === "basic" && !quickStartSet.has(f.type),
  );
  const configLibrary = FEATURES.filter(
    (f) => f.group === "config" && !quickStartSet.has(f.type),
  );

  const today = new Date().toISOString().slice(0, 10);

  return (
    <FeaturesLayout currentFeature={currentFeature} onFeatureClick={onFeatureClick}>
      <div className="max-w-5xl mx-auto px-8 py-12">
        {/* ── Masthead ────────────────────────────────────────────────── */}
        <header className="mb-14">
          <div className="flex items-center gap-3 mb-6 text-[11px] tracking-[0.22em] uppercase text-muted-foreground">
            <span className="w-8 h-px bg-border" />
            <span>Lovcode · Workbench</span>
            <span className="w-1 h-1 rounded-full bg-primary/60" />
            <span className="tabular-nums">{today}</span>
          </div>
          <h1 className="font-serif text-5xl leading-[1.05] text-foreground tracking-tight">
            A quiet workbench
            <br />
            for <em className="text-primary not-italic font-serif">vibe&nbsp;coding</em>.
          </h1>
          <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            Curate the Claude Code ecosystem from one place — environments, models, prompts,
            hooks, agents. Pick up where you left off, or start something new below.
          </p>
        </header>

        {/* ── Quick Start ────────────────────────────────────────────── */}
        <section className="mb-16">
          <div className="flex items-baseline justify-between mb-6 pb-3 border-b border-border">
            <h2 className="font-serif text-sm tracking-[0.18em] uppercase text-foreground">
              Begin here
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {pad(quickStartFeatures.length)} / {pad(FEATURES.filter(f => f.group === "basic" || f.group === "config").length)}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {quickStartFeatures.map((feature, i) => (
              <QuickStartCard
                key={feature.type}
                index={i + 1}
                feature={feature}
                onClick={() => onFeatureClick(feature.type)}
              />
            ))}
          </div>
        </section>

        {/* ── The Library — dense index ──────────────────────────────── */}
        <section>
          <div className="flex items-baseline justify-between mb-6 pb-3 border-b border-border">
            <h2 className="font-serif text-sm tracking-[0.18em] uppercase text-foreground">
              The library
            </h2>
            <span className="text-xs text-muted-foreground">
              Every configurable surface, at a glance
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-0">
            {/* Left column — Basic */}
            <div>
              <div className="flex items-center gap-3 mb-2 mt-1">
                <span className="font-serif italic text-muted-foreground text-sm">
                  Basic
                </span>
                <span className="flex-1 h-px bg-border/70" />
              </div>
              <div className="divide-y divide-border/60">
                {basicLibrary.map((feature, i) => (
                  <IndexRow
                    key={feature.type}
                    number={quickStartFeatures.length + i + 1}
                    feature={feature}
                    onClick={() => onFeatureClick(feature.type)}
                  />
                ))}
              </div>
            </div>

            {/* Right column — Features */}
            <div>
              <div className="flex items-center gap-3 mb-2 mt-1">
                <span className="font-serif italic text-muted-foreground text-sm">
                  Features
                </span>
                <span className="flex-1 h-px bg-border/70" />
              </div>
              <div className="divide-y divide-border/60">
                {configLibrary.map((feature, i) => (
                  <IndexRow
                    key={feature.type}
                    number={
                      quickStartFeatures.length + basicLibrary.length + i + 1
                    }
                    feature={feature}
                    onClick={() => onFeatureClick(feature.type)}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Colophon ────────────────────────────────────────────────── */}
        <footer className="mt-20 pt-6 border-t border-border flex items-center justify-between text-[11px] tracking-[0.15em] uppercase text-muted-foreground">
          <span>Warm · Academic · Tactile</span>
          <span className="font-serif italic normal-case tracking-normal text-[13px]">
            — select a section from the sidebar to continue.
          </span>
        </footer>
      </div>
    </FeaturesLayout>
  );
}
