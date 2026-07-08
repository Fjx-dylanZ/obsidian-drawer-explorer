import { App, TAbstractFile, TFile, TFolder, prepareFuzzySearch } from "obsidian";
import { FILTER_RESULT_CAP } from "./utils";

export interface Row {
	file: TAbstractFile;
	depth: number;
}

const FILE_ICONS: Record<string, string> = {
	md: "file-text",
	canvas: "layout-dashboard",
	base: "layout-list",
	pdf: "file-type",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	svg: "image",
	webp: "image",
};

export function fileIcon(file: TFile): string {
	return FILE_ICONS[file.extension.toLowerCase()] ?? "file";
}

export function sortChildren(children: TAbstractFile[]): TAbstractFile[] {
	return [...children].sort((a, b) => {
		const aDir = a instanceof TFolder ? 0 : 1;
		const bDir = b instanceof TFolder ? 0 : 1;
		if (aDir !== bDir) return aDir - bDir;
		return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
	});
}

/** Flatten the vault tree into visible rows, descending only into expanded folders. */
export function buildTreeRows(root: TFolder, expanded: ReadonlySet<string>): Row[] {
	const rows: Row[] = [];
	const walk = (folder: TFolder, depth: number) => {
		for (const child of sortChildren(folder.children)) {
			rows.push({ file: child, depth });
			if (child instanceof TFolder && expanded.has(child.path)) {
				walk(child, depth + 1);
			}
		}
	};
	walk(root, 0);
	return rows;
}

/** Fuzzy-match all vault files against a query, best matches first. */
export function buildFilterRows(app: App, query: string, cap = FILTER_RESULT_CAP): Row[] {
	const search = prepareFuzzySearch(query);
	const scored: { file: TFile; score: number }[] = [];
	for (const file of app.vault.getFiles()) {
		const match = search(file.path);
		if (match) scored.push({ file, score: match.score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, cap).map(({ file }) => ({ file, depth: 0 }));
}
