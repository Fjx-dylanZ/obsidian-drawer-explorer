import { Plugin, TFile, TFolder } from "obsidian";
import { Drawer } from "./drawer";
import { PreviewProvider, PreviewRegistry } from "./preview/registry";
import { fallbackProvider, imageProvider, markdownProvider, textProvider } from "./preview/builtins";
import { canvasProvider } from "./preview/canvas";
import { baseProvider } from "./preview/base";

export type { PreviewContext, PreviewProvider } from "./preview/registry";

export default class DrawerExplorerPlugin extends Plugin {
	drawer!: Drawer;
	previews!: PreviewRegistry;

	async onload() {
		this.previews = new PreviewRegistry();
		// order matters: first canPreview() match wins, fallback goes last
		this.previews.register(markdownProvider);
		this.previews.register(imageProvider);
		this.previews.register(canvasProvider);
		this.previews.register(baseProvider);
		this.previews.register(textProvider);
		this.previews.register(fallbackProvider);

		this.drawer = new Drawer(this, this.previews);

		this.addCommand({
			id: "open",
			name: "Open drawer",
			callback: () => this.drawer.open(),
		});
		this.addCommand({
			id: "open-tags",
			name: "Open tag lens",
			callback: () => this.drawer.openTagLens(),
		});

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile && file.extension.toLowerCase() === "md") this.drawer.invalidateTags();
				else this.drawer.scheduleRefresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFolder || (file instanceof TFile && file.extension.toLowerCase() === "md")) {
					this.drawer.invalidateTags();
				} else this.drawer.scheduleRefresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (
					file instanceof TFolder ||
					(file instanceof TFile && file.extension.toLowerCase() === "md") ||
					oldPath.toLowerCase().endsWith(".md")
				) {
					this.drawer.invalidateTags();
				} else this.drawer.scheduleRefresh();
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.extension.toLowerCase() === "md") this.drawer.invalidateTags();
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on("deleted", () => this.drawer.invalidateTags()),
		);
		this.app.workspace.onLayoutReady(() => this.drawer.invalidateTags());
	}

	onunload() {
		this.drawer.close();
	}

	/**
	 * Public API: other plugins can add preview renderers for custom file
	 * types. First matching provider wins; pass `before` to outrank one of
	 * the built-ins ("markdown", "image", "canvas", "base", "text", "fallback").
	 *
	 * ```ts
	 * const drawerExplorer = this.app.plugins.plugins["drawer-explorer"];
	 * drawerExplorer?.registerPreviewProvider({
	 *   id: "my-type",
	 *   canPreview: (f) => f.extension === "mytype",
	 *   render: async ({ el, file }) => { ... },
	 * }, { before: "text" });
	 * ```
	 */
	registerPreviewProvider(provider: PreviewProvider, opts?: { before?: string }): void {
		this.previews.register(provider, opts);
	}
}
