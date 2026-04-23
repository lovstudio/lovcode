---
"lovcode": patch
---

Fix TS build errors blocking v0.25.0 release

- Export `MaasRegistryView` from `src/views/index.ts`
- Add `basic-maas` route in `_layout.tsx` and `features.tsx` `Record<FeatureType, string>`
- Bump tsconfig `target`/`lib` to ES2022 (needed for `Array.at()`)
- Remove dead `isShortViewport`/`quickActions` + unused icon imports in `PanelGrid`
