import { App, SearchResult, TAbstractFile, TFile, TFolder, prepareFuzzySearch } from "obsidian";
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

export interface NameOrPathMatch {
	/** Number of separate matched fragments; 1 means the query appears contiguously. */
	ranges: number;
	nameMatch: boolean;
	/** Score of the name match when there is one, otherwise of the path match. */
	score: number;
	/** Breaks ties between equal names in different places (`index`, `#type/review` vs `#status/review`). */
	pathScore: number;
}

/**
 * Fuzzy-match an item by its name, falling back to its full path. `name` must be
 * part of `path`, so an item whose path does not match cannot match by name.
 */
export function matchNameOrPath(
	search: (text: string) => SearchResult | null,
	name: string,
	path: string,
): NameOrPathMatch | null {
	const pathMatch = search(path);
	if (!pathMatch) return null;
	const nameMatch = search(name);
	const best = nameMatch ?? pathMatch;
	return { ranges: best.matches.length, nameMatch: nameMatch !== null, score: best.score, pathScore: pathMatch.score };
}

/** Tighter matches first; at equal tightness name matches beat path-only matches, then score, then path score. */
export function compareNameOrPathMatches(a: NameOrPathMatch, b: NameOrPathMatch): number {
	return (
		a.ranges - b.ranges ||
		Number(b.nameMatch) - Number(a.nameMatch) ||
		b.score - a.score ||
		b.pathScore - a.pathScore
	);
}

/** Fuzzy-match all vault files against a query, ranked by `compareNameOrPathMatches`. */
export function buildFilterRows(app: App, query: string, cap = FILTER_RESULT_CAP): Row[] {
	const search = prepareFuzzySearch(query);
	const scored: { file: TFile; match: NameOrPathMatch }[] = [];
	for (const file of app.vault.getFiles()) {
		const match = matchNameOrPath(search, file.basename, file.path);
		if (match) scored.push({ file, match });
	}
	scored.sort((a, b) => compareNameOrPathMatches(a.match, b.match));
	return scored.slice(0, cap).map(({ file }) => ({ file, depth: 0 }));
}
