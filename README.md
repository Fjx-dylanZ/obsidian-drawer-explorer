# Drawer Explorer

A pop-up file and tag explorer for [Obsidian](https://obsidian.md) with modal,
vim-style navigation and a live preview pane — inspired by the snacks.nvim /
neo-tree explorer experience. Focus defaults to the tree, not a search bar.

- **Modal navigation**: `hjkl` through the tree, `a`/`r`/`d` file operations,
  `x`/`y`/`p` move & copy, `Space` to mark files for bulk operations — no
  mouse required.
- **Filter like a picker**: `i` focuses the fuzzy filter. In Files, `Esc` keeps
  the results for `j`/`k` navigation; in Tags, it returns to the hierarchy.
- **Tags as a lens**: press `t` to browse nested tags, focus one as a virtual
  collection, then progressively refine it with co-occurring tags.
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
Use `Drawer Explorer: Open tag lens` when you want a dedicated hotkey that
opens directly into tags.

## Keys

### Normal mode (default)

| Key | Action |
| --- | --- |
| `j` / `k` | Move selection down / up |
| `h` | Collapse folder, or jump to parent |
| `l` / `Enter` | Toggle folder / open file in the active tab (replacing its current file) |
| `o` | Open file in a new tab in the current pane |
| `t` | Switch to the tag lens |
| `gg` / `G` | First / last row |
| `Space` | Mark/unmark item (bulk select; `Ctrl`/`Cmd`-click too) |
| `a` | New file (`name`), folder (`name/`), or nested path (`a/b/c.md`) |
| `r` | Rename (link-aware, updates wikilinks) |
| `d` | Delete (confirm with `y`) |
| `x` / `y` | Cut / copy |
| `X` / `Y` | Remove item from the cut / copy clipboard |
| `p` | Paste into selected folder |
| `i` / `/` | Focus the filter bar |
| `P` | Toggle the preview pane |
| `Ctrl+d` / `Ctrl+u` | Scroll the preview half a page |
| `R` | Refresh |
| `Esc` / `q` | Clear marks → clear filter → close |

### Tag lens

Press `t` in normal mode (or click **Tags**) to switch from physical folders to
a metadata-backed tag tree. Parent tags include notes from nested descendants,
matching Obsidian's own tag-search semantics. A note matching several active
tags appears only once in the **Notes** results.

| Key | Action |
| --- | --- |
| `j` / `k` | Move selection down / up |
| `h` / `l` | Collapse/parent or expand/first child (`l` opens a selected note) |
| `Enter` | Follow a tag into its notes, commit a refinement, or open a note in the active tab |
| `Space` | Establish a scope or toggle an AND refinement without opening a note |
| `o` | Open a selected note in a new tab |
| `i` / `/` | Fuzzy-filter visible tags and matching note paths |
| `t` | Return to the file lens |
| `Esc` | Clear query → remove newest refinement → leave tag scope → close from the root |
| `q` | In normal mode, close immediately while preserving the current tag browsing context |

Focused tags are shown as chips above the filter. Counts update against the
current result set, and tag edits made elsewhere in Obsidian refresh the lens
from the metadata cache. Files whose metadata is still indexing are not
incorrectly shown as untagged.

Tag navigation is resumable for the current Obsidian session. Reopening the
drawer restores its scope, refinements, and expansion state. When the active
note is visible in that scope, the cursor follows it; otherwise the previous
logical row is restored. Text entered in the fuzzy filter is transient and is
cleared on close.

Within the **Tags** section, `Enter` establishes a scope and follows its first
note, while `Space` establishes the scope without opening one and keeps the
cursor among refinements when any are available. Within **Refine**, `Enter`
adds the highlighted constraint and follows the resulting notes; `Space`
toggles it and stays. `l` only moves deeper—it expands a collapsed branch or
moves to its first child—while `h` owns collapse and parent navigation.

The first tag-lens version is intentionally read-only: file creation,
rename/delete, and cut/copy/paste remain in the file lens. Tag mutation needs a
separate workflow because renaming or merging a tag can rewrite many notes.

### Bulk actions

Mark items with `Space` (highlighted rows), then `d`/`x`/`y` act on **all
marked items** instead of the cursor row (`p` pastes the whole set). Marks
survive filtering, so you can `i`-filter, mark a few results, filter again,
and mark more — then cut and paste them into one folder. `Esc` clears the
marks.

Clipped items show a dot on the right edge — accent for copy, red (plus
strikethrough) for cut — until pasted. `X`/`Y` takes items back out of the
cut/copy clipboard.

### Filter mode

Type to fuzzy-match file paths, or tag and note paths in the tag lens.
`Ctrl+j`/`Ctrl+k` or arrows move the selection and `Enter` activates it. In the
file lens, `Esc` pops back to normal mode **keeping the filtered results** so
you can navigate them with `j`/`k`; in the tag lens it clears the transient
search and returns to the restored hierarchy.

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
