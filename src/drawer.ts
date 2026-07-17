import { App, Component, Notice, TAbstractFile, TFile, TFolder, prepareFuzzySearch, setIcon } from "obsidian";
import type DrawerExplorerPlugin from "./main";
import { Row, buildFilterRows, buildTreeRows, fileIcon } from "./tree";
import { Clip, createEntry, pasteInto, renameWithin, trashPaths } from "./vault-ops";
import { PreviewRegistry } from "./preview/registry";
import { renderFolderSummary } from "./preview/builtins";
import {
	FILTER_RESULT_CAP,
	PREVIEW_DEBOUNCE_MS,
	REFRESH_DEBOUNCE_MS,
	TAG_REFRESH_DEBOUNCE_MS,
} from "./utils";
import { VaultTagSnapshot, buildVaultTagSnapshot } from "./tag-index";
import {
	contextualTagCounts,
	flattenTagNodes,
	matchingDocumentPaths,
	rootTagId,
} from "./tag-model";

type Mode = "normal" | "filter" | "prompt" | "confirm";
type Lens = "files" | "tags";
type TagSection = "tags" | "refine" | "notes";
type TagFocus = { kind: "tag"; id: string } | { kind: "untagged" } | null;

type TagLensRow =
	| {
			kind: "tag";
			section: Exclude<TagSection, "notes">;
			id: string;
			depth: number;
			count: number;
			hasChildren: boolean;
	  }
	| { kind: "untagged"; section: "tags"; count: number }
	| { kind: "file"; section: "notes"; file: TFile };

const FILE_HINTS: Record<Mode, string> = {
	normal:
		"j/k h/l move · space mark · enter/l current tab · o new tab · t tags · a add · r rename · d delete · x/y/p move/copy · i filter · P preview · esc/q close",
	filter: "enter current tab · ↑↓/^j^k move · esc normal",
	prompt: "enter confirm · esc cancel",
	confirm: "y confirm · any other key cancels",
};

const TAG_HINTS: Record<Mode, string> = {
	normal:
		"j/k move · h/l collapse/expand · enter follow/open · space toggle/stay · o new tab · t files · i filter · P preview · esc back · q close",
	filter: "enter follow/open · ↑↓/^j^k move · esc clear search",
	prompt: "enter confirm · esc cancel",
	confirm: "y confirm · any other key cancels",
};

export class Drawer {
	private app: App;
	private plugin: DrawerExplorerPlugin;
	private previews: PreviewRegistry;

	private backdropEl!: HTMLElement;
	private drawerEl!: HTMLElement;
	private modeChipEl!: HTMLElement;
	private filesLensEl!: HTMLButtonElement;
	private tagsLensEl!: HTMLButtonElement;
	private countEl!: HTMLElement;
	private tagContextEl!: HTMLElement;
	private filterInputEl!: HTMLInputElement;
	private listEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private previewTitleEl!: HTMLElement;
	private previewContentEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private opRowEl!: HTMLElement;
	private opLabelEl!: HTMLElement;
	private opInputEl!: HTMLInputElement;
	private confirmRowEl!: HTMLElement;
	private confirmTitleEl!: HTMLElement;
	private confirmDetailEl!: HTMLElement;

	private mode: Mode = "normal";
	private lens: Lens = "files";
	private expanded = new Set<string>();
	private marked = new Set<string>();
	private sel = 0;
	private rows: Row[] = [];
	private tagRows: TagLensRow[] = [];
	private tagSel = 0;
	private tagExpanded = new Set<string>();
	private tagRefineExpanded = new Set<string>();
	private tagFocus: TagFocus = null;
	private tagFilters: string[] = [];
	private tagSnapshot: VaultTagSnapshot | null = null;
	private tagIndexDirty = true;
	private currentTagResultPaths: Set<string> | null = null;
	private currentTagCounts: Map<string, number> | null = null;
	private visibleTagNoteCount = 0;
	private tagTreeTruncated = false;
	private tagNotesTruncated = false;
	private preferFirstTagResult = false;
	private preferActiveTagResult = false;
	private tagRestoreCursorKey: string | null = null;
	private query = "";
	private clip: Clip | null = null;
	private pendingG = false;
	private onPromptSubmit: ((value: string) => void) | null = null;
	private onConfirmYes: (() => void) | null = null;
	private refreshTimer: number | null = null;
	private prevFocus: HTMLElement | null = null;
	private previewComp: Component | null = null;
	private previewTimer: number | null = null;
	private showPreview = true;
	// window-level capture so we run BEFORE Vim Motions' document-level
	// global key handler, which otherwise eats h/j/k/l
	private windowKeyHandler = (e: KeyboardEvent) => this.onKeyDown(e);
	// the window/document hosting the drawer (activeWindow at open time,
	// so the drawer works in popout windows too)
	private hostWin: Window = window;
	private hostDoc: Document = document;

	isOpen = false;

	constructor(plugin: DrawerExplorerPlugin, previews: PreviewRegistry) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.previews = previews;
	}

	// ------------------------------------------------------------- lifecycle

	open() {
		if (this.isOpen) {
			this.setMode("normal");
			if (this.lens === "files") this.revealActiveFile();
			this.render();
			this.drawerEl.focus();
			return;
		}
		this.isOpen = true;
		this.preferActiveTagResult = this.lens === "tags";
		this.hostWin = activeWindow;
		this.hostDoc = activeDocument;
		this.prevFocus = this.hostDoc.activeElement instanceof HTMLElement ? this.hostDoc.activeElement : null;

		this.backdropEl = this.hostDoc.body.createDiv({ cls: "drawer-explorer-backdrop" });
		this.backdropEl.addEventListener("click", () => this.close());

		this.drawerEl = this.hostDoc.body.createDiv({ cls: "drawer-explorer" });
		this.drawerEl.tabIndex = -1;
		this.drawerEl.addEventListener("pointerdown", () => {
			this.pendingG = false;
		}, { capture: true });
		this.hostWin.addEventListener("keydown", this.windowKeyHandler, { capture: true });

		this.buildHeader();
		this.buildBody();
		this.buildFooter();

		if (this.lens === "files") this.revealActiveFile();
		this.setMode("normal");
		this.render();
		this.drawerEl.focus();
	}

	openTagLens() {
		if (this.isOpen) this.setLens("tags");
		else {
			this.lens = "tags";
			this.open();
		}
	}

	close() {
		if (!this.isOpen) return;
		if (!this.tagRestoreCursorKey) {
			const selectedTagRow = this.selectedTagRow();
			if (selectedTagRow) this.tagRestoreCursorKey = this.tagRowKey(selectedTagRow);
		}
		this.isOpen = false;
		this.hostWin.removeEventListener("keydown", this.windowKeyHandler, { capture: true });
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.previewTimer = null;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
		this.previewComp?.unload();
		this.previewComp = null;
		this.drawerEl.remove();
		this.backdropEl.remove();
		this.query = "";
		this.filterInputEl.value = "";
		this.marked.clear();
		this.preferFirstTagResult = false;
		this.preferActiveTagResult = false;
		this.mode = "normal";
		this.pendingG = false;
		const editor = this.app.workspace.activeEditor?.editor;
		if (editor) editor.focus();
		else this.prevFocus?.focus();
	}

	/** Mark the cached tag projection stale even when the drawer is closed. */
	invalidateTags() {
		this.tagIndexDirty = true;
		this.scheduleRefresh(TAG_REFRESH_DEBOUNCE_MS);
	}

	scheduleRefresh(delay = REFRESH_DEBOUNCE_MS) {
		if (!this.isOpen) return;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			if (this.isOpen) this.render();
		}, delay);
	}

	// ------------------------------------------------------------- dom setup

	private buildHeader() {
		const header = this.drawerEl.createDiv({ cls: "drawer-explorer-header" });
		header.createSpan({ cls: "drawer-explorer-title", text: this.app.vault.getName() });
		const lensesEl = header.createDiv({ cls: "drawer-explorer-lenses", attr: { role: "tablist" } });
		this.filesLensEl = lensesEl.createEl("button", {
			cls: "drawer-explorer-lens",
			text: "Files",
			attr: { type: "button", role: "tab" },
		});
		this.tagsLensEl = lensesEl.createEl("button", {
			cls: "drawer-explorer-lens",
			text: "Tags",
			attr: { type: "button", role: "tab" },
		});
		this.filesLensEl.addEventListener("click", () => this.setLens("files"));
		this.tagsLensEl.addEventListener("click", () => this.setLens("tags"));
		this.modeChipEl = header.createSpan({ cls: "drawer-explorer-mode", text: "NORMAL" });
		this.countEl = header.createSpan({ cls: "drawer-explorer-count" });
		this.updateLensControls();

		this.tagContextEl = this.drawerEl.createDiv({ cls: "drawer-explorer-tag-context" });
		this.tagContextEl.hide();

		const filterRow = this.drawerEl.createDiv({ cls: "drawer-explorer-filter" });
		filterRow.createSpan({ cls: "drawer-explorer-prompt-char", text: "❯" });
		this.filterInputEl = filterRow.createEl("input", {
			cls: "drawer-explorer-input",
			attr: {
				type: "text",
				placeholder: this.lens === "tags" ? "Filter tags and notes…" : "Filter (i)",
				spellcheck: "false",
			},
		});
		this.filterInputEl.addEventListener("input", () => {
			this.query = this.filterInputEl.value;
			if (this.lens === "tags") {
				this.cancelTagRestorePreference();
				this.tagSel = 0;
			}
			else this.sel = 0;
			this.render();
		});
		this.filterInputEl.addEventListener("focus", () => {
			if (this.lens === "tags") this.cancelTagRestorePreference();
			if (this.mode === "normal") this.setMode("filter");
		});
	}

	private buildBody() {
		const bodyEl = this.drawerEl.createDiv({ cls: "drawer-explorer-body" });
		this.listEl = bodyEl.createDiv({ cls: "drawer-explorer-list" });
		this.previewEl = bodyEl.createDiv({ cls: "drawer-explorer-preview" });
		this.previewTitleEl = this.previewEl.createDiv({ cls: "drawer-explorer-preview-title" });
		this.previewContentEl = this.previewEl.createDiv({ cls: "drawer-explorer-preview-content" });
		this.drawerEl.toggleClass("no-preview", !this.showPreview);
	}

	private buildFooter() {
		this.opRowEl = this.drawerEl.createDiv({ cls: "drawer-explorer-op" });
		this.opLabelEl = this.opRowEl.createSpan({ cls: "drawer-explorer-op-label" });
		this.opInputEl = this.opRowEl.createEl("input", {
			cls: "drawer-explorer-input",
			attr: { type: "text", spellcheck: "false" },
		});
		this.opRowEl.hide();

		this.confirmRowEl = this.drawerEl.createDiv({ cls: "drawer-explorer-confirm" });
		const confirmTitleRow = this.confirmRowEl.createDiv({ cls: "drawer-explorer-confirm-title" });
		const warnIconEl = confirmTitleRow.createSpan({ cls: "drawer-explorer-confirm-icon" });
		setIcon(warnIconEl, "alert-triangle");
		this.confirmTitleEl = confirmTitleRow.createSpan();
		this.confirmDetailEl = this.confirmRowEl.createDiv({ cls: "drawer-explorer-confirm-detail" });
		this.confirmRowEl.hide();

		this.footerEl = this.drawerEl.createDiv({ cls: "drawer-explorer-footer" });
	}

	// ------------------------------------------------------------- state

	private setMode(mode: Mode) {
		this.mode = mode;
		this.modeChipEl?.setText(mode.toUpperCase());
		this.drawerEl?.toggleClass("is-filter", mode === "filter");
		this.drawerEl?.toggleClass("is-confirm", mode === "confirm");
		if (mode === "normal") {
			this.opRowEl?.hide();
			this.confirmRowEl?.hide();
			// Blur the inputs so keys land on the drawer again.
			const active = this.hostDoc.activeElement;
			if (active instanceof HTMLElement && this.drawerEl.contains(active)) {
				this.drawerEl.focus();
			}
		}
		this.renderFooter();
	}

	private setLens(lens: Lens) {
		this.pendingG = false;
		if (this.lens === lens) {
			this.setMode("normal");
			this.drawerEl.focus();
			return;
		}
		this.lens = lens;
		this.query = "";
		this.filterInputEl.value = "";
		this.filterInputEl.placeholder = lens === "tags" ? "Filter tags and notes…" : "Filter (i)";
		this.setMode("normal");
		this.updateLensControls();
		if (lens === "files") this.revealActiveFile();
		else this.ensureTagSnapshot();
		this.render();
		this.drawerEl.focus();
	}

	private preparePointerAction() {
		this.pendingG = false;
		if (this.lens === "tags") this.cancelTagRestorePreference();
		if (this.mode === "filter") this.setMode("normal");
	}

	private cancelTagRestorePreference() {
		this.preferActiveTagResult = false;
		this.tagRestoreCursorKey = null;
	}

	private updateLensControls() {
		this.drawerEl?.toggleClass("is-tags", this.lens === "tags");
		for (const [lens, el] of [
			["files", this.filesLensEl],
			["tags", this.tagsLensEl],
		] as const) {
			const active = this.lens === lens;
			el?.toggleClass("is-active", active);
			el?.setAttribute("aria-selected", String(active));
			if (el) el.tabIndex = active ? 0 : -1;
		}
	}

	private selectedRow(): Row | null {
		return this.rows[this.sel] ?? null;
	}

	private selectedTagRow(): TagLensRow | null {
		return this.tagRows[this.tagSel] ?? null;
	}

	private ensureTagSnapshot(): VaultTagSnapshot {
		if (!this.tagSnapshot || this.tagIndexDirty) {
			this.tagSnapshot = buildVaultTagSnapshot(this.app);
			this.tagIndexDirty = false;
			if (!this.tagSnapshot.pendingFiles) {
				const nodes = this.tagSnapshot.index.nodes;
				if (this.tagFocus?.kind === "tag" && !nodes.has(this.tagFocus.id)) {
					this.tagFocus = null;
					this.tagFilters = [];
				} else {
					this.tagFilters = this.tagFilters.filter((id) => nodes.has(id));
				}
			}
		}
		return this.tagSnapshot;
	}

	private targetFolder(): TFolder {
		const row = this.selectedRow();
		if (!row) return this.app.vault.getRoot();
		if (row.file instanceof TFolder) return row.file;
		return row.file.parent ?? this.app.vault.getRoot();
	}

	/**
	 * What a file operation should act on: the marked set when non-empty,
	 * otherwise the cursor row. Every bulk-capable op (d/x/y) routes through
	 * this so marks never need special-casing at the call sites.
	 */
	private actionTargets(): TAbstractFile[] {
		if (this.marked.size) {
			return [...this.marked]
				.map((path) => this.app.vault.getAbstractFileByPath(path))
				.filter((file): file is TAbstractFile => file !== null);
		}
		const row = this.selectedRow();
		return row ? [row.file] : [];
	}

	private toggleMark(path: string) {
		if (this.marked.has(path)) this.marked.delete(path);
		else this.marked.add(path);
	}

	/** Drop marks whose files no longer exist (deleted or renamed elsewhere). */
	private pruneMarks() {
		for (const path of this.marked) {
			if (!this.app.vault.getAbstractFileByPath(path)) this.marked.delete(path);
		}
	}

	private revealActiveFile() {
		const active = this.app.workspace.getActiveFile();
		if (!active) return;
		let folder = active.parent;
		while (folder && !folder.isRoot()) {
			this.expanded.add(folder.path);
			folder = folder.parent;
		}
		this.buildRows();
		const idx = this.rows.findIndex((r) => r.file.path === active.path);
		if (idx >= 0) this.sel = idx;
	}

	/** Rebuild rows, move selection to `path` if visible, and re-render. */
	private focusPath(path: string) {
		this.buildRows();
		const idx = this.rows.findIndex((r) => r.file.path === path);
		if (idx >= 0) this.sel = idx;
		this.render();
	}

	private buildRows() {
		this.rows = this.query.trim()
			? buildFilterRows(this.app, this.query.trim())
			: buildTreeRows(this.app.vault.getRoot(), this.expanded);
		this.sel = Math.max(0, Math.min(this.sel, this.rows.length - 1));
	}

	private tagRowKey(row: TagLensRow): string {
		if (row.kind === "tag") return `tag:${row.id}`;
		if (row.kind === "file") return `file:${row.file.path}`;
		return "untagged";
	}

	private activeTagIds(): string[] {
		return this.tagFocus?.kind === "tag" ? [this.tagFocus.id, ...this.tagFilters] : [];
	}

	private activeTagExpansion(): Set<string> {
		return this.tagFocus ? this.tagRefineExpanded : this.tagExpanded;
	}

	private tagResultPaths(snapshot: VaultTagSnapshot): Set<string> | null {
		if (!this.tagFocus) return null;
		if (this.tagFocus.kind === "untagged") return new Set(snapshot.index.untaggedPaths);
		return matchingDocumentPaths(snapshot.index, this.activeTagIds());
	}

	private buildTagRows() {
		const renderedCursorKey = this.tagRows[this.tagSel] ? this.tagRowKey(this.tagRows[this.tagSel]) : null;
		const previousKey = this.tagRestoreCursorKey ?? renderedCursorKey;
		const snapshot = this.ensureTagSnapshot();
		const { index } = snapshot;
		const resultPaths = this.tagResultPaths(snapshot);
		this.currentTagResultPaths = resultPaths;
		const query = this.query.trim();
		const rows: TagLensRow[] = [];
		const section: Exclude<TagSection, "notes"> = this.tagFocus ? "refine" : "tags";
		const counts = resultPaths ? contextualTagCounts(index, resultPaths) : undefined;
		this.currentTagCounts = counts ?? null;
		this.visibleTagNoteCount = 0;
		this.tagTreeTruncated = false;
		this.tagNotesTruncated = false;
		const excludedRoot = this.tagFocus?.kind === "tag" ? rootTagId(this.tagFocus.id) : undefined;
		if (!query && previousKey?.startsWith("tag:")) {
			let parentId = index.nodes.get(previousKey.slice("tag:".length))?.parentId;
			const expanded = this.activeTagExpansion();
			while (parentId) {
				expanded.add(parentId);
				parentId = index.nodes.get(parentId)?.parentId;
			}
		}

		if (query) {
			const search = prepareFuzzySearch(query);
			const tagMatches: { id: string; score: number; count: number }[] = [];
			if (this.tagFocus?.kind !== "untagged") {
				for (const node of index.nodes.values()) {
					if (excludedRoot && rootTagId(node.id) === excludedRoot) continue;
					const count = counts ? (counts.get(node.id) ?? 0) : node.matchingFilePaths.size;
					if (counts && count === 0) continue;
					const match = search(`#${node.displayPath}`);
					if (match) tagMatches.push({ id: node.id, score: match.score, count });
				}
			}
			tagMatches.sort((a, b) => b.score - a.score);
			this.tagTreeTruncated = tagMatches.length > FILTER_RESULT_CAP;
			for (const match of tagMatches.slice(0, FILTER_RESULT_CAP)) {
				rows.push({
					kind: "tag",
					section,
					id: match.id,
					depth: 0,
					count: match.count,
					hasChildren: false,
				});
			}
			if (!this.tagFocus && index.untaggedPaths.size && search("Untagged")) {
				rows.push({ kind: "untagged", section: "tags", count: index.untaggedPaths.size });
			}
		} else if (this.tagFocus?.kind !== "untagged") {
			const visibleTags = flattenTagNodes(index, this.activeTagExpansion(), counts, excludedRoot);
			this.tagTreeTruncated = visibleTags.length > FILTER_RESULT_CAP;
			const visibleTagRows = visibleTags.slice(0, FILTER_RESULT_CAP);
			const preferredTagId = previousKey?.startsWith("tag:") ? previousKey.slice("tag:".length) : undefined;
			if (preferredTagId && !visibleTagRows.some((tag) => tag.id === preferredTagId)) {
				const preferredChain: (typeof visibleTags)[number][] = [];
				let id: string | null | undefined = preferredTagId;
				while (id) {
					const tag = visibleTags.find((candidate) => candidate.id === id);
					if (tag) preferredChain.unshift(tag);
					id = index.nodes.get(id)?.parentId;
				}
				const preferredIndex = visibleTags.findIndex((tag) => tag.id === preferredTagId);
				const preferredTag = visibleTags[preferredIndex];
				const firstChild = visibleTags[preferredIndex + 1];
				if (
					preferredTag &&
					firstChild?.depth === preferredTag.depth + 1 &&
					this.activeTagExpansion().has(preferredTag.id)
				) {
					preferredChain.push(firstChild);
				}
				const requiredRows = preferredChain.slice(-FILTER_RESULT_CAP);
				const requiredIds = new Set(requiredRows.map((tag) => tag.id));
				for (const tag of requiredRows) {
					if (visibleTagRows.some((candidate) => candidate.id === tag.id)) continue;
					let removeIndex = visibleTagRows.length - 1;
					while (removeIndex >= 0 && requiredIds.has(visibleTagRows[removeIndex].id)) {
						removeIndex -= 1;
					}
					if (removeIndex >= 0 && visibleTagRows.length >= FILTER_RESULT_CAP) {
						visibleTagRows.splice(removeIndex, 1);
					}
					visibleTagRows.push(tag);
				}
			}
			for (const tag of visibleTagRows) {
				rows.push({ kind: "tag", section, ...tag });
			}
			if (!this.tagFocus && index.untaggedPaths.size) {
				rows.push({ kind: "untagged", section: "tags", count: index.untaggedPaths.size });
			}
		}

		const fileScope = resultPaths ?? (query ? new Set(index.documents.keys()) : null);
		if (fileScope) {
			const search = query ? prepareFuzzySearch(query) : null;
			const matches: { file: TFile; score: number }[] = [];
			for (const path of fileScope) {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) continue;
				const match = search?.(file.path);
				if (search && !match) continue;
				matches.push({ file, score: match?.score ?? 0 });
			}
			matches.sort((a, b) => {
				if (search && a.score !== b.score) return b.score - a.score;
				return a.file.basename.localeCompare(b.file.basename, undefined, {
					sensitivity: "base",
					numeric: true,
				});
			});
			this.visibleTagNoteCount = matches.length;
			this.tagNotesTruncated = matches.length > FILTER_RESULT_CAP;
			const visibleMatches = matches.slice(0, FILTER_RESULT_CAP);
			const activePath = this.preferActiveTagResult ? this.app.workspace.getActiveFile()?.path : undefined;
			const previousPath = previousKey?.startsWith("file:") ? previousKey.slice("file:".length) : undefined;
			const preferredMatch = [activePath, previousPath]
				.filter((path): path is string => Boolean(path))
				.map((path) => matches.find((match) => match.file.path === path))
				.find((match) => match !== undefined);
			if (
				preferredMatch &&
				!visibleMatches.some((match) => match.file.path === preferredMatch.file.path)
			) {
				visibleMatches[visibleMatches.length - 1] = preferredMatch;
			}
			for (const { file } of visibleMatches) {
				rows.push({ kind: "file", section: "notes", file });
			}
		}

		this.tagRows = rows;
		if (this.preferActiveTagResult) {
			const activeFile = this.app.workspace.getActiveFile();
			const activePath = activeFile?.path;
			const activeIndex = activePath
				? rows.findIndex((row) => row.kind === "file" && row.file.path === activePath)
				: -1;
			if (activeIndex >= 0) {
				this.preferActiveTagResult = false;
				this.tagRestoreCursorKey = null;
				this.tagSel = activeIndex;
				return;
			}
			const activeMetadataPending = Boolean(
				resultPaths &&
				activeFile?.extension.toLowerCase() === "md" &&
				snapshot.pendingFiles &&
				!index.documents.has(activeFile.path),
			);
			if (!activeMetadataPending) this.preferActiveTagResult = false;
		}
		if (this.preferFirstTagResult) {
			const firstResult = rows.findIndex((row) => row.kind === "file");
			this.tagSel = firstResult >= 0 ? firstResult : 0;
			this.preferFirstTagResult = false;
			this.tagRestoreCursorKey = null;
			return;
		}
		const previousIndex = previousKey ? rows.findIndex((row) => this.tagRowKey(row) === previousKey) : -1;
		if (previousIndex >= 0) {
			this.tagSel = previousIndex;
			this.tagRestoreCursorKey = null;
		} else {
			this.tagSel = 0;
			if (!snapshot.pendingFiles) this.tagRestoreCursorKey = null;
		}
	}

	// ------------------------------------------------------------- render

	private render() {
		if (!this.isOpen) return;
		this.updateLensControls();
		if (this.lens === "tags") {
			this.renderTagLens();
			return;
		}
		this.tagContextEl.hide();
		this.buildRows();
		this.pruneMarks();

		const total = this.app.vault.getFiles().length;
		const counts = this.query.trim() ? `${this.rows.length}/${total}` : `${total}`;
		this.countEl.setText(this.marked.size ? `${this.marked.size} marked · ${counts}` : counts);

		this.listEl.empty();
		this.rows.forEach((row, i) => this.renderRow(row, i));

		const selEl = this.listEl.querySelector<HTMLElement>(".drawer-explorer-row.is-selected");
		if (selEl) selEl.scrollIntoView({ block: "nearest" });

		this.renderFooter();
		this.schedulePreview();
	}

	private renderTagLens() {
		this.buildTagRows();
		this.renderTagContext();
		const snapshot = this.ensureTagSnapshot();
		const resultPaths = this.currentTagResultPaths;
		const indexing = snapshot.pendingFiles ? ` · ${snapshot.pendingFiles} indexing` : "";
		if (resultPaths) this.countEl.setText(`${resultPaths.size} notes${indexing}`);
		else this.countEl.setText(`${snapshot.index.nodes.size} tags · ${snapshot.index.documents.size} notes${indexing}`);

		this.listEl.empty();
		let previousSection: TagSection | null = null;
		let renderedTruncation = false;
		this.tagRows.forEach((row, i) => {
			if (row.section === "notes" && this.tagTreeTruncated && !renderedTruncation) {
				this.renderTagTruncation();
				renderedTruncation = true;
			}
			if (row.section !== previousSection) {
				this.renderTagSection(row.section, this.visibleTagNoteCount, resultPaths?.size);
				previousSection = row.section;
			}
			this.renderTagRow(row, i);
		});
		if (this.tagTreeTruncated && !renderedTruncation) this.renderTagTruncation();
		if (this.tagNotesTruncated) this.renderTagNoteTruncation();

		if (!this.tagRows.length) {
			let message = "No indexed tags";
			if (snapshot.pendingFiles) message = `Indexing ${snapshot.pendingFiles} notes…`;
			else if (this.query.trim()) message = "No matching tags or notes";
			else if (this.tagFocus) message = "No notes match these tags";
			this.listEl.createDiv({ cls: "drawer-explorer-tag-empty", text: message });
		}

		const selEl = this.listEl.querySelector<HTMLElement>(".drawer-explorer-row.is-selected");
		if (selEl) selEl.scrollIntoView({ block: "nearest" });
		this.renderFooter();
		this.schedulePreview();
	}

	private renderTagTruncation() {
		this.listEl.createDiv({
			cls: "drawer-explorer-tag-limit",
			text: `Showing the first ${FILTER_RESULT_CAP} tags · filter to narrow`,
		});
	}

	private renderTagNoteTruncation() {
		this.listEl.createDiv({
			cls: "drawer-explorer-tag-limit",
			text: `Showing ${FILTER_RESULT_CAP} of ${this.visibleTagNoteCount} matching notes · filter to narrow`,
		});
	}

	private renderTagSection(section: TagSection, visibleNoteCount: number, resultCount?: number) {
		const headerEl = this.listEl.createDiv({ cls: "drawer-explorer-section-header" });
		headerEl.createSpan({ cls: "drawer-explorer-section-title", text: section.toUpperCase() });
		if (section === "notes") {
			const count = this.tagNotesTruncated
				? `${FILTER_RESULT_CAP}/${visibleNoteCount}`
				: this.query.trim() && resultCount !== undefined
				? `${visibleNoteCount}/${resultCount}`
				: String(visibleNoteCount);
			headerEl.createSpan({ cls: "drawer-explorer-section-count", text: count });
		}
	}

	private renderTagContext() {
		this.tagContextEl.empty();
		if (!this.tagFocus) {
			this.tagContextEl.hide();
			return;
		}
		this.tagContextEl.show();
		const snapshot = this.ensureTagSnapshot();
		const addChip = (text: string, label: string, remove: () => void) => {
			const chipEl = this.tagContextEl.createEl("button", {
				cls: "drawer-explorer-tag-chip",
				text,
				attr: { type: "button", "aria-label": label },
			});
			const closeEl = chipEl.createSpan({ cls: "drawer-explorer-tag-chip-close" });
			setIcon(closeEl, "x");
			chipEl.addEventListener("click", () => {
				this.preparePointerAction();
				remove();
				this.tagSel = 0;
				this.render();
				this.drawerEl.focus();
			});
		};

		if (this.tagFocus.kind === "untagged") {
			addChip("Untagged", "Clear Untagged focus", () => {
				this.tagFocus = null;
			});
			return;
		}
		const focusNode = snapshot.index.nodes.get(this.tagFocus.id);
		const focusDisplayPath = focusNode?.displayPath ?? this.tagFocus.id;
		addChip(`#${focusDisplayPath}`, `Clear #${focusDisplayPath} focus`, () => {
			this.tagFocus = null;
			this.tagFilters = [];
		});
		for (const id of this.tagFilters) {
			const node = snapshot.index.nodes.get(id);
			const displayPath = node?.displayPath ?? id;
			addChip(`+#${displayPath}`, `Remove #${displayPath} refinement`, () => {
				this.tagFilters = this.tagFilters.filter((tagId) => tagId !== id);
			});
		}
	}

	private renderTagRow(row: TagLensRow, i: number) {
		const rowEl = this.listEl.createDiv({ cls: "drawer-explorer-row" });
		rowEl.dataset.rowIndex = String(i);
		rowEl.toggleClass("is-selected", i === this.tagSel);

		if (row.kind === "file") {
			rowEl.addClass("is-result");
			rowEl.createSpan({ cls: "drawer-explorer-chevron is-blank" });
			const iconEl = rowEl.createSpan({ cls: "drawer-explorer-icon" });
			setIcon(iconEl, fileIcon(row.file));
			rowEl.createSpan({ cls: "drawer-explorer-name", text: row.file.basename });
			rowEl.addEventListener("click", () => {
				this.preparePointerAction();
				this.tagSel = i;
				void this.openFile(row.file, false);
			});
			return;
		}

		rowEl.addClass("is-tag");
		if (row.kind === "untagged") {
			rowEl.createSpan({ cls: "drawer-explorer-chevron is-blank" });
			const iconEl = rowEl.createSpan({ cls: "drawer-explorer-icon" });
			setIcon(iconEl, "tags");
			rowEl.createSpan({ cls: "drawer-explorer-name", text: "Untagged" });
			rowEl.createSpan({ cls: "drawer-explorer-tag-count", text: String(row.count) });
			rowEl.addEventListener("click", () => {
				this.preparePointerAction();
				this.tagSel = i;
				this.focusUntagged();
			});
			return;
		}

		const snapshot = this.ensureTagSnapshot();
		const node = snapshot.index.nodes.get(row.id);
		if (!node) return;
		rowEl.style.setProperty("--depth", String(row.depth));
		rowEl.toggleClass("is-active-filter", this.activeTagIds().includes(row.id));
		const chevronEl = rowEl.createSpan({
			cls: row.hasChildren && !this.query.trim() ? "drawer-explorer-chevron" : "drawer-explorer-chevron is-blank",
		});
		if (row.hasChildren && !this.query.trim()) {
			setIcon(chevronEl, "chevron-right");
			chevronEl.toggleClass("is-expanded", this.activeTagExpansion().has(row.id));
			chevronEl.addEventListener("click", (event) => {
				event.stopPropagation();
				this.preparePointerAction();
				this.tagSel = i;
				this.toggleTagExpanded(row.id);
			});
		}
		const iconEl = rowEl.createSpan({ cls: "drawer-explorer-icon" });
		setIcon(iconEl, this.activeTagIds().includes(row.id) ? "circle-check" : "tag");
		const label = this.query.trim() ? `#${node.displayPath}` : node.label;
		rowEl.createSpan({ cls: "drawer-explorer-name", text: label });
		rowEl.createSpan({ cls: "drawer-explorer-tag-count", text: String(row.count) });
		rowEl.addEventListener("click", () => {
			this.preparePointerAction();
			this.tagSel = i;
			if (row.section === "refine") this.toggleTagFilter(row.id);
			else this.focusTag(row.id);
		});
	}

	private renderRow(row: Row, i: number) {
		const isFolder = row.file instanceof TFolder;
		const isMarked = this.marked.has(row.file.path);
		const clipOp = this.clip?.paths.includes(row.file.path) ? this.clip.op : null;
		const rowEl = this.listEl.createDiv({ cls: "drawer-explorer-row" });
		rowEl.toggleClass("is-selected", i === this.sel);
		rowEl.toggleClass("is-folder", isFolder);
		rowEl.toggleClass("is-marked", isMarked);
		rowEl.toggleClass("is-cut", clipOp === "cut");
		rowEl.style.setProperty("--depth", String(row.depth));

		const inTree = !this.query.trim();
		if (isFolder && inTree) {
			const isExpanded = this.expanded.has(row.file.path);
			const chevronEl = rowEl.createSpan({ cls: "drawer-explorer-chevron" });
			setIcon(chevronEl, "chevron-right");
			chevronEl.toggleClass("is-expanded", isExpanded);
			const iconEl = rowEl.createSpan({ cls: "drawer-explorer-icon" });
			setIcon(iconEl, isExpanded ? "folder-open" : "folder-closed");
			iconEl.toggleClass("is-expanded", isExpanded);
		} else {
			rowEl.createSpan({ cls: "drawer-explorer-chevron is-blank" });
			const iconEl = rowEl.createSpan({ cls: "drawer-explorer-icon" });
			setIcon(iconEl, row.file instanceof TFile ? fileIcon(row.file) : "folder-closed");
		}

		const label = !inTree
			? row.file.path
			: row.file instanceof TFile && row.file.extension === "md"
				? row.file.basename
				: row.file.name;
		rowEl.createSpan({ cls: "drawer-explorer-name", text: label });
		if (clipOp) rowEl.createSpan({ cls: `drawer-explorer-clip is-${clipOp}`, text: "●" });

		rowEl.addEventListener("click", (e) => {
			this.preparePointerAction();
			this.sel = i;
			if (e.metaKey || e.ctrlKey) {
				this.toggleMark(row.file.path);
				this.render();
			} else if (row.file instanceof TFolder) {
				this.toggleFolder(row.file);
				this.render();
			} else if (row.file instanceof TFile) {
				void this.openFile(row.file, false);
			}
		});
	}

	private renderFooter() {
		if (!this.footerEl) return;
		this.footerEl.setText((this.lens === "tags" ? TAG_HINTS : FILE_HINTS)[this.mode]);
	}

	// ------------------------------------------------------------- preview

	private schedulePreview() {
		if (!this.showPreview || !this.isOpen) return;
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.previewTimer = window.setTimeout(() => {
			this.previewTimer = null;
			void this.updatePreview();
		}, PREVIEW_DEBOUNCE_MS);
	}

	private async updatePreview() {
		if (!this.isOpen || !this.showPreview) return;
		const row = this.lens === "files" ? this.selectedRow() : null;
		const tagRow = this.lens === "tags" ? this.selectedTagRow() : null;

		// Each render gets a fresh container + component; swapping them out up
		// front means a slow async render that finishes late writes into a
		// detached element instead of clobbering the current preview.
		this.previewComp?.unload();
		const component = new Component();
		component.load();
		this.previewComp = component;
		this.previewContentEl.empty();
		this.previewContentEl.scrollTop = 0;
		const container = this.previewContentEl.createDiv();

		if (this.lens === "tags") {
			if (!tagRow) {
				this.previewTitleEl.setText("");
				container.createDiv({ cls: "drawer-explorer-preview-empty", text: "Nothing selected" });
				return;
			}
			if (tagRow.kind === "file") {
				await this.renderFilePreview(tagRow.file, component, container);
				return;
			}
			if (tagRow.kind === "untagged") {
				this.previewTitleEl.setText("Untagged");
				container.createEl("p", {
					text: `${tagRow.count} indexed ${tagRow.count === 1 ? "note has" : "notes have"} no tags.`,
				});
				container.createDiv({
					cls: "drawer-explorer-preview-empty",
					text: "Enter follows the collection; Space selects it without opening a note.",
				});
				return;
			}

			const snapshot = this.ensureTagSnapshot();
			const node = snapshot.index.nodes.get(tagRow.id);
			if (!node) return;
			this.previewTitleEl.setText(`#${node.displayPath}`);
			container.createEl("p", {
				text: `${tagRow.count} matching ${tagRow.count === 1 ? "note" : "notes"}, including nested tags.`,
			});
			container.createDiv({
				cls: "drawer-explorer-preview-empty",
				text: tagRow.section === "refine"
					? "Space toggles this refinement; Enter applies it and follows the matching notes."
					: "Enter follows this tag's notes; Space selects it and stays in tag navigation.",
			});
			const childIds = tagRow.section === "refine" && this.currentTagCounts
				? node.childIds.filter((id) => (this.currentTagCounts?.get(id) ?? 0) > 0)
				: node.childIds;
			if (childIds.length) {
				container.createDiv({ cls: "drawer-explorer-base-heading", text: "Child tags" });
				const listEl = container.createEl("ul", { cls: "drawer-explorer-preview-children" });
				for (const childId of childIds.slice(0, 12)) {
					const child = snapshot.index.nodes.get(childId);
					if (child) listEl.createEl("li", { text: `#${child.displayPath}` });
				}
			}
			return;
		}

		if (!row) {
			this.previewTitleEl.setText("");
			container.createDiv({ cls: "drawer-explorer-preview-empty", text: "Nothing selected" });
			return;
		}

		if (row.file instanceof TFolder) {
			this.previewTitleEl.setText(row.file.isRoot() ? this.app.vault.getName() : row.file.name);
			renderFolderSummary(container, row.file);
			return;
		}

		if (!(row.file instanceof TFile)) return;
		await this.renderFilePreview(row.file, component, container);
	}

	private async renderFilePreview(file: TFile, component: Component, container: HTMLElement) {
		this.previewTitleEl.setText(file.name);
		const provider = this.previews.resolve(file);
		if (!provider) return;
		try {
			await provider.render({ app: this.app, el: container, file, component });
		} catch (err) {
			container.createDiv({
				cls: "drawer-explorer-preview-empty",
				text: `Preview failed (${provider.id}): ${(err as Error).message}`,
			});
		}
	}

	// ------------------------------------------------------------- keys

	private swallow(e: KeyboardEvent) {
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
	}

	private onKeyDown(e: KeyboardEvent) {
		if (!this.isOpen) return;
		const target = e.target as HTMLElement | null;
		const lensButton = target?.closest<HTMLButtonElement>(".drawer-explorer-lens");
		if (lensButton && this.drawerEl.contains(lensButton) && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
			const lens = e.key === "Home"
				? "files"
				: e.key === "End"
					? "tags"
					: lensButton === this.filesLensEl
						? "tags"
						: "files";
			this.setLens(lens);
			(lens === "files" ? this.filesLensEl : this.tagsLensEl).focus();
			this.swallow(e);
			return;
		}
		if ((e.key === "Enter" || e.key === " ") && target?.closest("button") && this.drawerEl.contains(target)) {
			return;
		}

		if (this.mode === "prompt") {
			if (e.key === "Escape") {
				this.cancelPrompt();
			} else if (e.key === "Enter") {
				const submit = this.onPromptSubmit;
				const value = this.opInputEl.value;
				this.cancelPrompt();
				submit?.(value);
			} else {
				return; // let the op input receive the keystroke
			}
			this.swallow(e);
			return;
		}

		if (this.mode === "confirm") {
			if (e.key === "y" || e.key === "Y") {
				const yes = this.onConfirmYes;
				this.endConfirm();
				yes?.();
			} else {
				this.endConfirm();
			}
			this.swallow(e);
			return;
		}

		if (this.mode === "filter") {
			if (e.key === "Escape") {
				if (this.lens === "tags") {
					this.query = "";
					this.filterInputEl.value = "";
					this.setMode("normal");
					this.render();
				} else {
					this.setMode("normal");
				}
			} else if (e.key === "Enter") {
				if (this.lens === "tags") {
					this.query = "";
					this.filterInputEl.value = "";
					this.setMode("normal");
					this.activateTagSelection(false);
				} else {
					this.openSelected(false);
				}
			} else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) {
				this.moveSel(1);
			} else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) {
				this.moveSel(-1);
			} else {
				return; // typing in the filter input
			}
			this.swallow(e);
			return;
		}

		// normal mode: Ctrl+d/u scroll the preview pane
		if (e.ctrlKey && (e.key === "d" || e.key === "u")) {
			this.previewContentEl.scrollBy({
				top: ((e.key === "d" ? 1 : -1) * this.previewContentEl.clientHeight) / 2,
			});
			this.swallow(e);
			return;
		}
		// let remaining app-level shortcuts (Cmd/Ctrl chords) pass through
		if (e.metaKey || (e.ctrlKey && !["j", "k"].includes(e.key))) return;

		if (this.handleNormalKey(e)) {
			this.swallow(e);
		} else if (e.key.length === 1) {
			// swallow stray printable keys so global handlers don't fire
			this.swallow(e);
		}
	}

	private handleNormalKey(e: KeyboardEvent): boolean {
		if (this.lens === "tags") return this.handleTagKey(e);
		const key = e.key;

		if (this.pendingG) {
			this.pendingG = false;
			if (key === "g") {
				this.sel = 0;
				this.render();
				return true;
			}
			// fall through: treat as a fresh key press
		}

		switch (key) {
			case " ": {
				const row = this.selectedRow();
				if (row) {
					this.toggleMark(row.file.path);
					this.render();
				}
				return true;
			}
			case "j":
			case "ArrowDown":
				this.moveSel(1);
				return true;
			case "k":
			case "ArrowUp":
				this.moveSel(-1);
				return true;
			case "g":
				this.pendingG = true;
				return true;
			case "G":
				this.sel = this.rows.length - 1;
				this.render();
				return true;
			case "h":
			case "ArrowLeft":
				this.collapseOrParent();
				return true;
			case "l":
			case "ArrowRight":
			case "Enter":
				this.expandOrOpen(false);
				return true;
			case "o":
				this.openSelected(true);
				return true;
			case "t":
				this.setLens("tags");
				return true;
			case "i":
			case "/":
				this.enterFilter(key === "/");
				return true;
			case "a":
				this.promptNew();
				return true;
			case "r":
				this.promptRename();
				return true;
			case "d":
				this.confirmDelete();
				return true;
			case "x":
				this.setClip("cut");
				return true;
			case "y":
				this.setClip("copy");
				return true;
			case "X":
				this.removeFromClip("cut");
				return true;
			case "Y":
				this.removeFromClip("copy");
				return true;
			case "p":
				void this.paste();
				return true;
			case "P":
				this.showPreview = !this.showPreview;
				this.drawerEl.toggleClass("no-preview", !this.showPreview);
				if (this.showPreview) this.schedulePreview();
				return true;
			case "R":
				this.render();
				return true;
			case "q":
			case "Escape":
				if (this.marked.size) {
					this.marked.clear();
					this.render();
				} else if (this.query.trim()) {
					this.query = "";
					this.filterInputEl.value = "";
					this.sel = 0;
					this.render();
				} else {
					this.close();
				}
				return true;
			default:
				return false;
		}
	}

	private handleTagKey(e: KeyboardEvent): boolean {
		const key = e.key;
		// Explicit navigation wins over a delayed metadata-cache attempt to
		// restore the active note. Closing or repainting does not.
		if ([
			" ", "j", "ArrowDown", "k", "ArrowUp", "g", "G", "h", "ArrowLeft",
			"l", "ArrowRight", "Enter", "o", "Escape",
		].includes(key)) {
			this.cancelTagRestorePreference();
		}
		if (this.pendingG) {
			this.pendingG = false;
			if (key === "g") {
				this.setTagSelection(0);
				return true;
			}
		}

		switch (key) {
			case " ": {
				const row = this.selectedTagRow();
				if (row?.kind === "tag") {
					if (row.section === "refine") this.toggleTagFilter(row.id);
					else this.focusTag(row.id, false);
				} else if (row?.kind === "untagged") {
					this.focusUntagged(false);
				}
				return true;
			}
			case "j":
			case "ArrowDown":
				this.moveSel(1);
				return true;
			case "k":
			case "ArrowUp":
				this.moveSel(-1);
				return true;
			case "g":
				this.pendingG = true;
				return true;
			case "G":
				this.setTagSelection(this.tagRows.length - 1);
				return true;
			case "h":
			case "ArrowLeft":
				this.collapseTagOrParent();
				return true;
			case "l":
			case "ArrowRight":
				this.expandTagOrOpen();
				return true;
			case "Enter":
				this.activateTagSelection(false);
				return true;
			case "o": {
				const row = this.selectedTagRow();
				if (row?.kind === "file") void this.openFile(row.file, true);
				return true;
			}
			case "i":
			case "/":
				this.enterFilter(key === "/");
				return true;
			case "t":
				this.setLens("files");
				return true;
			case "P":
				this.showPreview = !this.showPreview;
				this.drawerEl.toggleClass("no-preview", !this.showPreview);
				if (this.showPreview) this.schedulePreview();
				return true;
			case "R":
				this.tagIndexDirty = true;
				this.render();
				return true;
			case "q":
				this.close();
				return true;
			case "Escape":
				if (this.query.trim()) {
					this.query = "";
					this.filterInputEl.value = "";
					this.tagSel = 0;
					this.render();
				} else if (this.tagFilters.length) {
					this.tagFilters.pop();
					this.tagSel = 0;
					this.render();
				} else if (this.tagFocus) {
					this.tagFocus = null;
					this.tagSel = 0;
					this.render();
				} else {
					this.close();
				}
				return true;
			default:
				return false;
		}
	}

	private moveSel(delta: number) {
		if (this.lens === "tags") {
			this.setTagSelection(this.tagSel + delta);
			return;
		} else {
			if (!this.rows.length) return;
			this.sel = Math.max(0, Math.min(this.rows.length - 1, this.sel + delta));
		}
		this.render();
	}

	private setTagSelection(index: number) {
		if (!this.tagRows.length) return;
		const rowEls = this.listEl.querySelectorAll<HTMLElement>(".drawer-explorer-row[data-row-index]");
		rowEls[this.tagSel]?.toggleClass("is-selected", false);
		this.tagSel = Math.max(0, Math.min(this.tagRows.length - 1, index));
		const selectedEl = rowEls[this.tagSel];
		selectedEl?.toggleClass("is-selected", true);
		selectedEl?.scrollIntoView({ block: "nearest" });
		this.schedulePreview();
	}

	// ------------------------------------------------------------- navigation

	private toggleTagExpanded(id: string) {
		const expanded = this.activeTagExpansion();
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
		this.render();
	}

	private focusTag(id: string, followNotes = true) {
		const snapshot = this.ensureTagSnapshot();
		if (!snapshot.index.nodes.has(id)) return;
		this.tagFocus = { kind: "tag", id };
		this.tagFilters = [];
		this.tagSel = 0;
		const focusRoot = rootTagId(id);
		this.tagRefineExpanded = new Set();
		for (const rootId of snapshot.index.rootIds) {
			if (rootId !== focusRoot) this.tagRefineExpanded.add(rootId);
		}
		if (followNotes) this.selectFirstTagResultAndRender();
		else this.render();
	}

	private focusUntagged(followNotes = true) {
		if (this.tagFocus?.kind === "untagged") {
			this.tagFocus = null;
		} else {
			this.tagFocus = { kind: "untagged" };
			this.tagFilters = [];
		}
		this.tagSel = 0;
		if (this.tagFocus && followNotes) this.selectFirstTagResultAndRender();
		else this.render();
	}

	private toggleTagFilter(id: string) {
		if (!this.tagFocus) {
			this.focusTag(id, false);
			return;
		}
		if (this.tagFocus.kind === "untagged") {
			this.focusTag(id, false);
			return;
		}
		if (id === this.tagFocus.id) {
			this.tagFocus = null;
			this.tagFilters = [];
		} else if (this.tagFilters.includes(id)) {
			this.tagFilters = this.tagFilters.filter((tagId) => tagId !== id);
		} else {
			this.tagFilters.push(id);
		}
		this.render();
	}

	private commitTagRefinement(id: string) {
		if (!this.tagFocus || this.tagFocus.kind === "untagged") {
			this.focusTag(id, true);
			return;
		}
		if (id !== this.tagFocus.id && !this.tagFilters.includes(id)) this.tagFilters.push(id);
		this.selectFirstTagResultAndRender();
	}

	private selectFirstTagResultAndRender() {
		this.preferFirstTagResult = true;
		this.render();
	}

	private collapseTagOrParent() {
		const row = this.selectedTagRow();
		if (row?.kind !== "tag") return;
		const expanded = this.activeTagExpansion();
		if (expanded.has(row.id)) {
			expanded.delete(row.id);
			this.render();
			return;
		}
		const parentId = this.ensureTagSnapshot().index.nodes.get(row.id)?.parentId;
		if (!parentId) return;
		const parentIndex = this.tagRows.findIndex((candidate) => candidate.kind === "tag" && candidate.id === parentId);
		if (parentIndex >= 0) {
			this.tagSel = parentIndex;
			this.render();
		}
	}

	private expandTagOrOpen() {
		const row = this.selectedTagRow();
		if (!row) return;
		if (row.kind === "file") {
			void this.openFile(row.file, false);
		} else if (row.kind === "tag" && row.hasChildren && !this.query.trim()) {
			const expanded = this.activeTagExpansion();
			if (!expanded.has(row.id)) {
				expanded.add(row.id);
				this.render();
				return;
			}
			const child = this.tagRows[this.tagSel + 1];
			if (child?.kind === "tag" && child.section === row.section && child.depth === row.depth + 1) {
				this.setTagSelection(this.tagSel + 1);
			}
		}
	}

	private activateTagSelection(newTab: boolean) {
		const row = this.selectedTagRow();
		if (!row) return;
		if (row.kind === "file") void this.openFile(row.file, newTab);
		else if (row.kind === "tag") {
			if (row.section === "refine") this.commitTagRefinement(row.id);
			else this.focusTag(row.id, true);
		} else this.focusUntagged(true);
	}

	private toggleFolder(folder: TFolder) {
		if (this.expanded.has(folder.path)) this.expanded.delete(folder.path);
		else this.expanded.add(folder.path);
	}

	private collapseOrParent() {
		const row = this.selectedRow();
		if (!row) return;
		if (row.file instanceof TFolder && this.expanded.has(row.file.path)) {
			this.expanded.delete(row.file.path);
		} else {
			const parent = row.file.parent;
			if (parent && !parent.isRoot()) {
				const idx = this.rows.findIndex((r) => r.file.path === parent.path);
				if (idx >= 0) this.sel = idx;
			}
		}
		this.render();
	}

	private expandOrOpen(newTab: boolean) {
		const row = this.selectedRow();
		if (!row) return;
		if (row.file instanceof TFolder) {
			if (this.query.trim()) return;
			this.toggleFolder(row.file);
			this.render();
		} else if (row.file instanceof TFile) {
			void this.openFile(row.file, newTab);
		}
	}

	private openSelected(newTab: boolean) {
		const row = this.selectedRow();
		if (!row) return;
		if (row.file instanceof TFile) void this.openFile(row.file, newTab);
		else this.expandOrOpen(newTab);
	}

	private async openFile(file: TFile, newTab: boolean) {
		this.close();
		await this.app.workspace.getLeaf(newTab).openFile(file);
	}

	private enterFilter(selectAll: boolean) {
		this.setMode("filter");
		this.filterInputEl.focus();
		if (selectAll) this.filterInputEl.select();
	}

	// ------------------------------------------------------------- prompts

	private prompt(label: string, initial: string, onSubmit: (value: string) => void, placeholder = "") {
		this.setMode("prompt");
		this.opLabelEl.setText(label);
		this.opInputEl.placeholder = placeholder;
		this.opInputEl.value = initial;
		this.opRowEl.show();
		this.onPromptSubmit = onSubmit;
		this.opInputEl.focus();
		const dot = initial.lastIndexOf(".");
		if (dot > 0) this.opInputEl.setSelectionRange(0, dot);
		else this.opInputEl.select();
	}

	private cancelPrompt() {
		this.onPromptSubmit = null;
		this.opInputEl.value = "";
		this.setMode("normal");
	}

	/** Ask a destructive yes/no question in a warning panel; `details` lists the affected items. */
	private confirm(label: string, onYes: () => void, details: string[] = []) {
		this.onConfirmYes = onYes;
		this.confirmTitleEl.setText(label);
		const cap = 6;
		const shown = details.slice(0, cap).join(" · ");
		this.confirmDetailEl.setText(details.length > cap ? `${shown} (+${details.length - cap} more)` : shown);
		this.confirmDetailEl.toggle(details.length > 0);
		this.confirmRowEl.show();
		this.setMode("confirm");
	}

	private endConfirm() {
		this.onConfirmYes = null;
		this.setMode("normal");
	}

	// ------------------------------------------------------------- file ops

	private reportError(err: unknown) {
		new Notice(`Drawer Explorer: ${(err as Error).message}`);
	}

	private reportErrors(errors: Error[]) {
		if (!errors.length) return;
		const extra = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
		new Notice(`Drawer Explorer: ${errors[0].message}${extra}`);
	}

	private promptNew() {
		const base = this.targetFolder();
		const where = base.isRoot() ? "/" : `${base.path}/`;
		this.prompt(`New in ${where}`, "", (value) => {
			const name = value.trim();
			if (!name) return;
			void (async () => {
				try {
					const path = await createEntry(this.app, base, name);
					this.expanded.add(base.path);
					if (name.endsWith("/")) this.expanded.add(path);
					this.focusPath(path);
				} catch (err) {
					this.reportError(err);
				}
			})();
		}, "name, dir/, or a/b/c.md");
	}

	private promptRename() {
		const row = this.selectedRow();
		if (!row) return;
		const file = row.file;
		this.prompt("Rename:", file.name, (value) => {
			const name = value.trim().replace(/\/+$/, "");
			if (!name || name === file.name) return;
			void (async () => {
				try {
					this.focusPath(await renameWithin(this.app, file, name));
				} catch (err) {
					this.reportError(err);
				}
			})();
		});
	}

	private confirmDelete() {
		const targets = this.actionTargets();
		if (!targets.length) return;
		const label = targets.length === 1 ? `Delete ${targets[0].name}?` : `Delete ${targets.length} items?`;
		const names = targets.map((f) => (f instanceof TFolder ? `${f.name}/` : f.name));
		this.confirm(
			label,
			() => {
				void (async () => {
					this.reportErrors(await trashPaths(this.app, targets.map((f) => f.path)));
					this.marked.clear();
					this.render();
				})();
			},
			targets.length > 1 ? names : [],
		);
	}

	private setClip(op: Clip["op"]) {
		const targets = this.actionTargets();
		if (!targets.length) return;
		let files = targets;
		if (op === "copy") {
			files = targets.filter((f) => f instanceof TFile);
			if (files.length < targets.length) new Notice("Copying folders is not supported");
			if (!files.length) return;
		}
		this.clip = { paths: files.map((f) => f.path), op };
		// The clip carries the set now; lingering marks would double-apply on
		// the next bulk op.
		this.marked.clear();
		this.render();
	}

	/** Drop the action targets from the clip: X for a cut clip, Y for a copy clip. */
	private removeFromClip(op: Clip["op"]) {
		if (!this.clip || this.clip.op !== op) return;
		const drop = new Set(this.actionTargets().map((f) => f.path));
		const paths = this.clip.paths.filter((path) => !drop.has(path));
		this.clip = paths.length ? { paths, op } : null;
		this.render();
	}

	private async paste() {
		if (!this.clip) return;
		const dest = this.targetFolder();
		const { created, errors } = await pasteInto(this.app, this.clip, dest);
		this.clip = null;
		this.reportErrors(errors);
		if (created.length) {
			this.expanded.add(dest.path);
			this.focusPath(created[created.length - 1]);
		} else {
			this.render();
		}
	}
}
