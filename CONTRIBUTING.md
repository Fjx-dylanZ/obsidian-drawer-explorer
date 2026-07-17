# Contributing

Thanks for your interest! This plugin is small on purpose — the easiest way to
extend it is usually a **preview provider** (see below) rather than new UI.

## Dev setup

```sh
npm install
npm run build     # type-check + bundle to main.js
npm test          # pure tag-model tests
npm run lint
npm run dev       # watch mode
```

To test in a vault, copy `manifest.json`, `main.js`, and `styles.css` into
`<vault>/.obsidian/plugins/drawer-explorer/` and reload Obsidian:

```sh
OBSIDIAN_PLUGIN_DIR="<vault>/.obsidian/plugins/drawer-explorer" npm run install:vault
```

## Code map

| Module | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin entry, commands, public provider API |
| `src/drawer.ts` | The popup: modes (normal/filter/prompt/confirm), keys, rendering |
| `src/tree.ts` | Row building — tree walk and fuzzy filter |
| `src/tag-model.ts` | Obsidian-free nested-tag index, counts, intersections, and tree flattening |
| `src/tag-index.ts` | Adapter from Obsidian's metadata cache into the pure tag model |
| `src/vault-ops.ts` | Create/rename/move/copy/trash over the vault API (UI-free, bulk-aware) |
| `src/preview/registry.ts` | `PreviewProvider` interface and resolution |
| `src/preview/*.ts` | One provider per file type |

## Adding a preview provider

Create `src/preview/<type>.ts` exporting a `PreviewProvider`, register it in
`src/main.ts` (order matters — first `canPreview` match wins), and style it
with `drawer-explorer-*` classes in `styles.css`. Providers get a `component`
for renderer lifecycles and render into a throwaway `el`, so cleanup is
automatic. Read files with `app.vault.cachedRead` and cap what you render —
the preview must never make `j`/`k` feel slow.

## Conventions

- TypeScript strict-null, tabs, no default exports except the plugin class.
- No new runtime dependencies — the plugin bundles to a single small `main.js`.
- Anything user-visible goes through CSS variables so themes keep working.
