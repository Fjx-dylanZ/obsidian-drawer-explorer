# Drawer Explorer

A pop-up file tree for [Obsidian](https://obsidian.md) with modal, vim-style
navigation and a live preview pane — inspired by the snacks.nvim / neo-tree
explorer experience. Focus defaults to the tree, not a search bar.

- **Modal navigation**: `hjkl` through the tree, `a`/`r`/`d` file operations,
  `x`/`y`/`p` move & copy, `Space` to mark files for bulk operations — no
  mouse required.
- **Filter like a picker**: `i` focuses the fuzzy filter, `Esc` pops back to
  normal mode *keeping the results* so you can `j`/`k` through them.
- **Preview pane**: rendered markdown, images, `.canvas` minimaps, `.base`
  summaries — and a small provider API so plugins can add more types.
- Theme-aware, keyboard-first, works alongside vim plugins such as
  [Vim Motions](https://github.com/saberzero1/motions).

> Status: young but daily-driven. Expect sharp edges; issues and PRs welcome.

## Installation

Not yet in the community plugin store. Until then:

- **[BRAT](https://github.com/TfTHacker/obsidian42-brat)**: add
  `Fjx-dylanZ/obsidian-drawer-explorer` as a beta plugin.
- **Manual**: grab `manifest.json`, `main.js`, and `styles.css` from the
  [latest release](https://github.com/Fjx-dylanZ/obsidian-drawer-explorer/releases)
  into `<vault>/.obsidian/plugins/drawer-explorer/`, then enable it in
  Settings → Community plugins.
- **From source**: `npm install && npm run build`, then copy the same three
  files (or use `OBSIDIAN_PLUGIN_DIR=... npm run install:vault`).

Open it with the `Drawer Explorer: Open drawer` command.

## Keys

### Normal mode (default)

| Key | Action |
| --- | --- |
| `j` / `k` | Move selection down / up |
| `h` | Collapse folder, or jump to parent |
| `l` / `Enter` | Toggle folder / open file |
| `o` | Open file in new tab |
| `gg` / `G` | First / last row |
| `Space` | Mark/unmark item (bulk select; `Ctrl`/`Cmd`-click too) |
| `a` | New file (`name`), folder (`name/`), or nested path (`a/b/c.md`) |
| `r` | Rename (link-aware, updates wikilinks) |
| `d` | Delete (confirm with `y`) |
| `x` / `y` | Cut / copy |
| `p` | Paste into selected folder |
| `i` / `/` | Focus the filter bar |
| `P` | Toggle the preview pane |
| `Ctrl+d` / `Ctrl+u` | Scroll the preview half a page |
| `R` | Refresh |
| `Esc` / `q` | Clear marks → clear filter → close |

### Bulk actions

Mark items with `Space`, then `d`/`x`/`y` act on **all marked items** instead
of the cursor row (`p` pastes the whole set). Marks survive filtering, so you
can `i`-filter, mark a few results, filter again, and mark more — then cut and
paste them into one folder. `Esc` clears the marks.

### Filter mode

Type to fuzzy-match file paths (like a picker). `Ctrl+j`/`Ctrl+k` or arrows move
the selection, `Enter` opens, `Esc` pops back to normal mode **keeping the
filtered results** so you can navigate them with `j`/`k`.

## Previews

The right pane previews the selected item. Built-in providers:

| Provider | Handles | Renders |
| --- | --- | --- |
| `markdown` | `.md` | Rendered markdown (theme-styled, frontmatter stripped) |
| `image` | png/jpg/svg/webp/… | Inline image |
| `canvas` | `.canvas` | SVG minimap of nodes/edges with colors and labels |
| `base` | `.base` | Views, filters, formulas, and properties summary |
| `text` | json/yaml/ts/lua/… | Raw text (capped) |
| `fallback` | everything else | Type + size placeholder |

### Adding a preview provider (for plugin devs)

Providers are resolved first-match-wins. From another plugin:

```ts
const drawerExplorer = this.app.plugins.plugins["drawer-explorer"];
drawerExplorer?.registerPreviewProvider(
	{
		id: "csv-table",
		canPreview: (file) => file.extension === "csv",
		render: async ({ app, el, file, component }) => {
			const raw = await app.vault.cachedRead(file);
			// render into `el`; use `component` for MarkdownRenderer lifecycles
		},
	},
	{ before: "text" }, // outrank the generic text provider
);
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code map and provider guide.

## Vim Motions integration

```lua
vim.keymap.set("n", "<leader>e", function()
	vim.cmd("obcommand drawer-explorer:open")
end, { desc = "Explorer drawer" })

-- global (works when focus is outside the editor):
vim.obsidian.keymap.set("<leader>e", ":obcommand drawer-explorer:open", { desc = "Explorer drawer" })
```

## License

[MIT](LICENSE)
