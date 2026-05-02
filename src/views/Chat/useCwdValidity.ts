import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface PathCheckResult {
  raw: string;
  resolved: string;
  is_dir: boolean;
}

const cache = new Map<string, boolean>();
const versionListeners = new Set<() => void>();
let cacheVersion = 0;

/** Clear the cwd-existence cache (e.g. after a migration that may have rewritten cwds). */
export function invalidateCwdValidity(): void {
  cache.clear();
  cacheVersion++;
  for (const fn of versionListeners) fn();
}

// Returns a Set of cwd strings that DO NOT exist on disk. Cached per cwd.
export function useCwdValidity(cwds: (string | null | undefined)[]): Set<string> {
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [, forceVersion] = useState(0);

  useEffect(() => {
    const fn = () => forceVersion(cacheVersion);
    versionListeners.add(fn);
    return () => {
      versionListeners.delete(fn);
    };
  }, []);

  // Stable key for the dependency array
  const key = cwds.filter(Boolean).join("|") + "::" + cacheVersion;

  useEffect(() => {
    const unique = Array.from(new Set(cwds.filter((c): c is string => !!c)));
    if (unique.length === 0) {
      setMissing((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }

    const toQuery = unique.filter((c) => !cache.has(c));
    const buildResult = () => {
      const next = new Set<string>();
      for (const c of unique) {
        if (cache.get(c) === false) next.add(c);
      }
      return next;
    };

    if (toQuery.length === 0) {
      const result = buildResult();
      setMissing((prev) => (sameSet(prev, result) ? prev : result));
      return;
    }

    let cancelled = false;
    invoke<PathCheckResult[]>("check_paths_exist", { paths: toQuery })
      .then((hits) => {
        if (cancelled) return;
        const found = new Set(hits.map((h) => h.raw));
        for (const c of toQuery) cache.set(c, found.has(c));
        const result = buildResult();
        setMissing((prev) => (sameSet(prev, result) ? prev : result));
      })
      .catch(() => {
        // On error, don't mark anything as missing — fail open.
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return missing;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
