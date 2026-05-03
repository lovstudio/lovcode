import { invoke } from "@tauri-apps/api/core";

// Match POSIX-style paths embedded in text. Three strategies:
// 1. Wrapped paths: opener + path-with-spaces + matching closer (backticks, quotes, CJK 「」 etc.)
//    Explicit paths (`/`, `~/`, `./`, `../`) remain permissive so filenames with spaces work.
// 2. Bare relative files: `output/foo.md`, `src/views/App.tsx`, etc. These must contain
//    a slash and a file extension, keeping prose and URLs out of the candidate set.
// 3. Bare explicit paths: NO spaces allowed (whitespace terminates) to avoid greedy matches in prose.
// Combined into one regex with two capture branches so `extractPathCandidates` and `segmentText`
// both walk a single match list. The first non-empty capture group is the raw path.
// The broad-looking bare branch is still cheap: it requires slash + extension, then the
// de-duped Rust-side existence check decides whether the candidate is actually interactive.
// We intentionally skip Windows-style paths for now (KISS — codebase is darwin-only).
const EXPLICIT_PATH_PREFIX = String.raw`(?:~\/|\/|\.{1,2}\/)`;
const URL_OR_FRAGMENT_PREFIX = String.raw`(?:[a-zA-Z][a-zA-Z0-9+.-]*:|#|\?)`;
const FILE_EXTENSION = String.raw`\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}`;

function explicitPath(stopChars: string, allowSpaces: boolean) {
  const whitespace = allowSpaces ? "" : String.raw`\s`;
  return String.raw`${EXPLICIT_PATH_PREFIX}[^${whitespace}${stopChars}\n]+`;
}

function bareRelativeFile(stopChars: string) {
  return String.raw`(?!${URL_OR_FRAGMENT_PREFIX})(?=[^\s${stopChars}\n]*\/)[^\s${stopChars}\n]+${FILE_EXTENSION}`;
}

function pathLike(stopChars: string) {
  return String.raw`(?:${explicitPath(stopChars, true)}|${bareRelativeFile(stopChars)})`;
}

const BARE_STOP_CHARS = String.raw`\`'"<>)\]」』`;
const barePathLike = String.raw`(?:${explicitPath(BARE_STOP_CHARS, false)}|${bareRelativeFile(BARE_STOP_CHARS)})`;
// IDE-style location suffix: `:line`, `:line:col`, optional `(any-selector)` afterwards.
// The selector is consumed so wrapped paths still parse, but it is not rendered as
// part of the clickable path segment.
const LOCATION_SUFFIX = String.raw`(?::\d+(?::\d+)?(?:\([^)\n]*\))?)?`;
const WRAPPED_PREFIX = String.raw`@?\s*`;
const WRAPPED_SUFFIX = String.raw`\s*`;
const PATH_RE = new RegExp([
  String.raw`\`${WRAPPED_PREFIX}(${pathLike("`")}${LOCATION_SUFFIX})${WRAPPED_SUFFIX}\``,
  `「${WRAPPED_PREFIX}(${pathLike("」")}${LOCATION_SUFFIX})${WRAPPED_SUFFIX}」`,
  `『${WRAPPED_PREFIX}(${pathLike("』")}${LOCATION_SUFFIX})${WRAPPED_SUFFIX}』`,
  `"${WRAPPED_PREFIX}(${pathLike('"')}${LOCATION_SUFFIX})${WRAPPED_SUFFIX}"`,
  `'${WRAPPED_PREFIX}(${pathLike("'")}${LOCATION_SUFFIX})${WRAPPED_SUFFIX}'`,
  // Bare branch - `@` is treated as a leading sigil (IDE-style mention) and consumed before the path.
  String.raw`(?:^|[\s(\[<])@?(${barePathLike}${LOCATION_SUFFIX})`,
].join("|"), "g");

// Strip IDE-style location decorations from a captured token to get the pure filesystem path.
// Examples:
//   foo.tsx              -> foo.tsx
//   foo.tsx:217          -> foo.tsx
//   foo.tsx:217:7        -> foo.tsx
//   foo.tsx:217:7(div>a) -> foo.tsx
const LOCATION_SUFFIX_RE = /:(\d+)(?::(\d+))?(?:\([^)\n]*\))?$/;
export function stripPathDecorations(raw: string): string {
  return raw.replace(LOCATION_SUFFIX_RE, "");
}

export function parseLocationSuffix(raw: string): { line?: number; column?: number } {
  const m = raw.match(LOCATION_SUFFIX_RE);
  if (!m || (!m[1] && !m[2])) return {};
  return {
    line: m[1] ? Number(m[1]) : undefined,
    column: m[2] ? Number(m[2]) : undefined,
  };
}

function stripSelectorDecoration(raw: string): string {
  return raw.replace(/(:\d+(?::\d+)?)\([^)\n]*\)$/, "$1");
}

export interface PathHit {
  raw: string;
  resolved: string;
  isDir: boolean;
  exists?: boolean;
  warning?: string | null;
  candidates?: PathCandidate[];
}

export interface PathCandidate {
  path: string;
  source: string;
  isDir: boolean;
  fullMatch: boolean;
  exists?: boolean;
}

type RawPathCandidate = {
  path: string;
  source: string;
  is_dir?: boolean;
  isDir?: boolean;
  full_match?: boolean;
  fullMatch?: boolean;
  exists?: boolean;
};

type RawPathHit = {
  raw: string;
  resolved: string;
  is_dir?: boolean;
  isDir?: boolean;
  exists?: boolean;
  warning?: string | null;
  candidates?: RawPathCandidate[];
};

function pickGroup(m: RegExpExecArray): string | null {
  for (let i = 1; i < m.length; i++) {
    if (m[i] !== undefined) return m[i];
  }
  return null;
}

// Strip both prose punctuation tail and IDE location suffix to derive the filesystem path.
function normalizeCaptured(raw: string): string {
  // First drop any IDE-style ":line[:col](selector)" suffix; then prose punctuation.
  return stripPathDecorations(raw.trim()).replace(/[,.;:!?)\]]+$/, "");
}

export function extractPathCandidates(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    const raw = pickGroup(m);
    if (!raw) continue;
    const candidate = normalizeCaptured(raw);
    if (candidate.length >= 2) out.add(candidate);
  }
  return Array.from(out);
}

// Extract hrefs from markdown link syntax `[text](href)` or `[text](<href>)` that look like local
// filesystem paths. Used so smart-path resolution covers explicit markdown links — not just bare
// path strings in prose. Skips URL schemes (http://, mailto:, etc.) and fragments/queries.
const MD_LINK_RE = /\[(?:[^\]\\]|\\.)*\]\(\s*<?([^\s<>)]+)>?\s*(?:"[^"]*"|'[^']*'|\([^)]*\))?\s*\)/g;

export function extractMarkdownLinkHrefs(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    let href = m[1];
    if (!href) continue;
    if (href.startsWith("#") || href.startsWith("?")) continue;
    if (href.startsWith("file://")) {
      href = href.slice(7);
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
      continue;
    }
    try { href = decodeURIComponent(href); } catch { /* keep raw on bad encoding */ }
    if (href.length >= 1) out.add(href);
  }
  return Array.from(out);
}

const cache = new Map<string, PathHit | null>();
const resolveCache = new Map<string, PathHit | null>();

function cacheKey(raw: string, cwd: string | undefined): string {
  return `${cwd ?? ""}::${raw}`;
}

function normalizePathCandidate(candidate: RawPathCandidate): PathCandidate {
  return {
    path: candidate.path,
    source: candidate.source,
    isDir: candidate.isDir ?? candidate.is_dir ?? false,
    fullMatch: candidate.fullMatch ?? candidate.full_match ?? false,
    exists: candidate.exists,
  };
}

function normalizePathHit(hit: RawPathHit): PathHit {
  return {
    raw: hit.raw,
    resolved: hit.resolved,
    isDir: hit.isDir ?? hit.is_dir ?? false,
    exists: hit.exists,
    warning: hit.warning,
    candidates: hit.candidates?.map(normalizePathCandidate),
  };
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
      const hits = await invoke<RawPathHit[]>("check_paths_exist", { paths: toQuery, cwd });
      const normalizedHits = hits.map(normalizePathHit);
      const hitMap = new Map(normalizedHits.map((h) => [h.raw, h]));
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

export async function resolvePathCandidates(paths: string[], cwd?: string): Promise<Map<string, PathHit>> {
  const result = new Map<string, PathHit>();
  const toQuery: string[] = [];

  for (const path of paths) {
    const key = cacheKey(path, cwd);
    if (resolveCache.has(key)) {
      const hit = resolveCache.get(key);
      if (hit) result.set(path, hit);
    } else {
      toQuery.push(path);
    }
  }

  if (toQuery.length > 0) {
    try {
      const hits = await invoke<RawPathHit[]>("resolve_path_candidates", { paths: toQuery, cwd });
      const normalizedHits = hits.map(normalizePathHit);
      const hitMap = new Map(normalizedHits.map((hit) => [hit.raw, hit]));
      for (const path of toQuery) {
        const hit = hitMap.get(path) ?? null;
        resolveCache.set(cacheKey(path, cwd), hit);
        if (hit) result.set(path, hit);
      }
    } catch (err) {
      console.error("resolve_path_candidates failed", err);
    }
  }

  return result;
}

// Split a string into [text|hit] segments, preserving order. Hit ranges come from a
// non-overlapping list of {start, end, hit} sorted ascending by start. Line/column
// are per-occurrence and parsed from the captured token's IDE-style suffix.
export interface Segment {
  text: string;
  hit?: PathHit;
  line?: number;
  column?: number;
}

export function segmentText(text: string, hits: Map<string, PathHit>): Segment[] {
  if (hits.size === 0) return [{ text }];

  type Range = { start: number; end: number; hit: PathHit; line?: number; column?: number };
  const ranges: Range[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text)) !== null) {
    const rawCap = pickGroup(m);
    if (!rawCap) continue;
    // Look up by normalized (stripped) path, but render only through `:line:col`.
    // Keep a trailing DOM selector as plain text, not part of the clickable link.
    const normalized = normalizeCaptured(rawCap);
    const hit = hits.get(normalized);
    if (!hit) continue;
    const { line, column } = parseLocationSuffix(rawCap);
    // Locate the captured token's start within the full match. We search for `rawCap`
    // inside m[0] because the leading delimiter (if any) varies between branches.
    const innerOffset = m[0].indexOf(rawCap);
    const start = m.index + (innerOffset >= 0 ? innerOffset : 0);
    const linkText = stripSelectorDecoration(rawCap);
    // Trim trailing prose punctuation only (e.g., comma after the suffix), keep IDE line/column.
    let end = start + linkText.length;
    while (end > start && /[,.;!?]/.test(text[end - 1])) end--;
    if (ranges.length && ranges[ranges.length - 1].end > start) continue;
    ranges.push({ start, end, hit, line, column });
  }

  if (ranges.length === 0) return [{ text }];

  const segments: Segment[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) segments.push({ text: text.slice(cursor, r.start) });
    segments.push({ text: text.slice(r.start, r.end), hit: r.hit, line: r.line, column: r.column });
    cursor = r.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
