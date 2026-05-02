import { useEffect, useState } from "react";
import { checkPaths, extractPathCandidates, type PathHit } from "./pathDetection";

function sameMap(a: Map<string, PathHit>, b: Map<string, PathHit>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.resolved !== v.resolved || w.isDir !== v.isDir) return false;
  }
  return true;
}

export function usePathHits(text: string, cwd?: string): Map<string, PathHit> {
  const [hits, setHits] = useState<Map<string, PathHit>>(new Map());

  useEffect(() => {
    const candidates = extractPathCandidates(text);
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
  }, [text, cwd]);

  return hits;
}
