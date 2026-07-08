import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";

export interface Clip {
	path: string;
	op: "cut" | "copy";
}

export function joinPath(parent: TFolder, name: string): string {
	return normalizePath(parent.isRoot() ? name : `${parent.path}/${name}`);
}

export async function ensureFolder(app: App, path: string): Promise<void> {
	const parts = normalizePath(path).split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			await app.vault.createFolder(current);
		}
	}
}

/**
 * Create a file or folder under `base` from user input.
 * Trailing `/` creates a folder; nested paths create intermediate folders;
 * files without an extension default to `.md`. Returns the created path.
 */
export async function createEntry(app: App, base: TFolder, rawName: string): Promise<string> {
	if (rawName.endsWith("/")) {
		const path = joinPath(base, rawName.replace(/\/+$/, ""));
		await ensureFolder(app, path);
		return path;
	}
	const withExt = /\.[A-Za-z0-9]+$/.test(rawName) ? rawName : `${rawName}.md`;
	const path = joinPath(base, withExt);
	const dir = path.split("/").slice(0, -1).join("/");
	if (dir) await ensureFolder(app, dir);
	const file = await app.vault.create(path, "");
	return file.path;
}

/** Rename a file/folder in place (link-aware). Returns the new path. */
export async function renameWithin(app: App, file: TAbstractFile, newName: string): Promise<string> {
	const parent = file.parent ?? app.vault.getRoot();
	const newPath = joinPath(parent, newName);
	await app.fileManager.renameFile(file, newPath);
	return newPath;
}

/** Move (cut) or copy the clipped item into `dest`. Returns the new path, or null if a no-op. */
export async function pasteInto(app: App, clip: Clip, dest: TFolder): Promise<string | null> {
	const source = app.vault.getAbstractFileByPath(clip.path);
	if (!source) return null;
	const newPath = joinPath(dest, source.name);
	if (newPath === source.path) return null;
	if (clip.op === "cut") {
		await app.fileManager.renameFile(source, newPath);
	} else if (source instanceof TFile) {
		await app.vault.copy(source, newPath);
	} else {
		throw new Error("copying folders is not supported");
	}
	return newPath;
}
