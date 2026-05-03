import { atomWithStorage } from "jotai/utils";

// SourceView (per source-id, dir paths that are collapsed)
export const sourceCollapsedDirsAtom = atomWithStorage<Record<string, string[]>>(
  "lovcode:source:collapsedDirs",
  {}
);
