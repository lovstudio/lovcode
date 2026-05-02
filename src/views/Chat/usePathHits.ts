import { useEffect, useState } from "react";
import { checkPaths, extractMarkdownLinkHrefs, extractPathCandidates, type PathHit } from "./pathDetection";

function sameMap(a: Map<string, PathHit>, b: Map<string, PathHit>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.resolved !== v.resolved || w.isDir !== v.isDir) return false;
  }
  return true;
}

export function usePathHits(text: string, cwd?: string, includeMarkdownHrefs = false): Map<string, PathHit> {
  const [hits, setHits] = useState<Map<string, PathHit>>(new Map());

  useEffect(() => {
    const seen = new Set<string>(extractPathCandidates(text));
    if (includeMarkdownHrefs) {
      for (const h of extractMarkdownLinkHrefs(text)) seen.add(h);
    }
    const candidates = Array.from(seen);
    if (candidates.length === 0) {
      setHits((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    checkPaths(candidates, cwd).then((result) => {
      if (cancelled) return;
      setHits((prev) => (sameMap(prev, result) ? prev : result));
    });
    return () => {
      cancelled = true;
    };
  }, [text, cwd, includeMarkdownHrefs]);

  return hits;
}
