import { MarkdownRenderer, TFolder } from "obsidian";
import { PreviewProvider } from "./registry";
import { sortChildren } from "../tree";
import { MARKDOWN_PREVIEW_CAP, TEXT_PREVIEW_CAP, prettySize } from "../utils";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp"]);
const TEXT_EXTS = new Set([
	"txt", "json", "yaml", "yml", "js", "ts", "jsx", "tsx", "css", "scss", "html",
	"xml", "csv", "log", "sh", "zsh", "lua", "py", "rb", "toml", "ini",
]);

export const markdownProvider: PreviewProvider = {
	id: "markdown",
	canPreview: (file) => file.extension.toLowerCase() === "md",
	async render({ app, el, file, component }) {
		const raw = await app.vault.cachedRead(file);
		const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").slice(0, MARKDOWN_PREVIEW_CAP);
		const target = el.createDiv({ cls: "markdown-rendered" });
		await MarkdownRenderer.render(app, body.trim() || "*empty file*", target, file.path, component);
	},
};

export const imageProvider: PreviewProvider = {
	id: "image",
	canPreview: (file) => IMAGE_EXTS.has(file.extension.toLowerCase()),
	render({ app, el, file }) {
		el.createEl("img", { attr: { src: app.vault.getResourcePath(file), alt: file.name } });
	},
};

export const textProvider: PreviewProvider = {
	id: "text",
	canPreview: (file) => TEXT_EXTS.has(file.extension.toLowerCase()),
	async render({ app, el, file }) {
		const raw = await app.vault.cachedRead(file);
		el.createEl("pre", { text: raw.slice(0, TEXT_PREVIEW_CAP) });
	},
};

/** Catch-all for binary/unknown files. Must be registered last. */
export const fallbackProvider: PreviewProvider = {
	id: "fallback",
	canPreview: () => true,
	render({ el, file }) {
		el.createDiv({
			cls: "drawer-explorer-preview-empty",
			text: `${file.extension.toUpperCase()} · ${prettySize(file.stat.size)} · no preview`,
		});
	},
};

/** Folders are not TFiles, so their summary lives outside the provider registry. */
export function renderFolderSummary(el: HTMLElement, folder: TFolder): void {
	const folders = folder.children.filter((c) => c instanceof TFolder).length;
	const files = folder.children.length - folders;
	el.createDiv({
		cls: "drawer-explorer-preview-empty",
		text: `${folders} folder${folders === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}`,
	});
	const ul = el.createEl("ul", { cls: "drawer-explorer-preview-children" });
	for (const child of sortChildren(folder.children).slice(0, 40)) {
		ul.createEl("li", { text: child instanceof TFolder ? `${child.name}/` : child.name });
	}
}
