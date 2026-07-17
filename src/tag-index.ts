import { App, getAllTags } from "obsidian";
import { TagIndex, buildTagIndex } from "./tag-model";

export interface VaultTagSnapshot {
	index: TagIndex;
	pendingFiles: number;
	totalMarkdownFiles: number;
}

/**
 * Adapt Obsidian's metadata cache into the pure tag model. Files whose cache
 * is not ready are deliberately omitted instead of being mislabeled untagged.
 */
export function buildVaultTagSnapshot(app: App): VaultTagSnapshot {
	const files = app.vault.getMarkdownFiles();
	let pendingFiles = 0;
	const documents = [];
	for (const file of files) {
		const cache = app.metadataCache.getFileCache(file);
		if (!cache) {
			pendingFiles += 1;
			continue;
		}
		documents.push({
			path: file.path,
			name: file.basename,
			tags: getAllTags(cache) ?? [],
		});
	}
	return {
		index: buildTagIndex(documents),
		pendingFiles,
		totalMarkdownFiles: files.length,
	};
}
