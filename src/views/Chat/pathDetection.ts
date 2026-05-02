import { invoke } from "@tauri-apps/api/core";

// Match POSIX-style paths embedded in text. Two strategies:
// 1. Wrapped paths: opener + path-with-spaces + matching closer (backticks, quotes, CJK 「」 etc.)
//    Permissive — anything goes between the matching delimiters.
// 2. Bare paths: NO spaces allowed (whitespace terminates) to avoid greedy matches in prose.
// Combined into one regex with two capture branches so `extractPathCandidates` and `segmentText`
// both walk a single match list. Group 1 = wrapped capture, Group 2 = bare capture.
// We intentionally skip Windows-style paths for now (KISS — codebase is darwin-only).
const PATH_RE =
  /(?:`((?:~\/|\/|\.{1,2}\/)[^`\n]+)`|「((?:~\/|\/|\.{1,2}\/)[^」\n]+)」|『((?:~\/|\/|\.{1,2}\/)[^』\n]+)』|"((?:~\/|\/|\.{1,2}\/)[^"\n]+)"|'((?:~\/|\/|\.{1,2}\/)[^'\n]+)'|(?:^|[\s(\[<])((?:~\/|\/|\.{1,2}\/)[^\s`'"<>)\]」』]+))/g;

export interface PathHit {
  raw: string;
  resolved: string;
  isDir: boolean;
}

function pickGroup(m: RegExpExecArray): string | null {
  // First non-undefined of groups 1..6
  for (let i = 1; i <= 6; i++) {
    if (m[i] !== undefined) return m[i];
  }
  return null;
}

export function extractPathCandidates(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    const raw = pickGroup(m);
    if (!raw) continue;
    const candidate = raw.replace(/[,.;:!?)\]]+$/, "");
    if (candidate.length >= 2) out.add(candidate);
  }
  return Array.from(out);
}

const cache = new Map<string, PathHit | null>();

function cacheKey(raw: string, cwd: string | undefined): string {
  return `${cwd ?? ""}::${raw}`;
}

export async function checkPaths(paths: string[], cwd?: string): Promise<Map<string, PathHit>> {
  const result = new Map<string, PathHit>();
  const toQuery: string[] = [];

  for (const p of paths) {
    const key = cacheKey(p, cwd);
    if (cache.has(key)) {
      const hit = cache.get(key);
      if (hit) result.set(p, hit);
    } else {
      toQuery.push(p);
    }
  }

  if (toQuery.length > 0) {
    try {
      const hits = await invoke<PathHit[]>("check_paths_exist", { paths: toQuery, cwd });
      const hitMap = new Map(hits.map((h) => [h.raw, h]));
      for (const p of toQuery) {
        const hit = hitMap.get(p) ?? null;
        cache.set(cacheKey(p, cwd), hit);
        if (hit) result.set(p, hit);
      }
    } catch (err) {
      console.error("check_paths_exist failed", err);
    }
  }

  return result;
}

// Split a string into [text|hit] segments, preserving order. Hit ranges come from a
// non-overlapping list of {start, end, hit} sorted ascending by start.
export interface Segment {
  text: string;
  hit?: PathHit;
}

export function segmentText(text: string, hits: Map<string, PathHit>): Segment[] {
  if (hits.size === 0) return [{ text }];

  type Range = { start: number; end: number; hit: PathHit };
  const ranges: Range[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text)) !== null) {
    const rawCap = pickGroup(m);
    if (!rawCap) continue;
    const raw = rawCap.replace(/[,.;:!?)\]]+$/, "");
    const hit = hits.get(raw);
    if (!hit) continue;
    // Locate the captured path's start within the full match. We search for `raw` inside m[0]
    // because the leading delimiter (if any) varies between branches.
    const innerOffset = m[0].indexOf(raw);
    const start = m.index + (innerOffset >= 0 ? innerOffset : 0);
    const end = start + raw.length;
    if (ranges.length && ranges[ranges.length - 1].end > start) continue;
    ranges.push({ start, end, hit });
  }

  if (ranges.length === 0) return [{ text }];

  const segments: Segment[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) segments.push({ text: text.slice(cursor, r.start) });
    segments.push({ text: text.slice(r.start, r.end), hit: r.hit });
    cursor = r.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
