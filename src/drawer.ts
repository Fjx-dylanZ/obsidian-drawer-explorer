import { App, Component, Notice, TFile, TFolder, setIcon } from "obsidian";
import type DrawerExplorerPlugin from "./main";
import { Row, buildFilterRows, buildTreeRows, fileIcon } from "./tree";
import { Clip, createEntry, pasteInto, renameWithin } from "./vault-ops";
import { PreviewRegistry } from "./preview/registry";
import { renderFolderSummary } from "./preview/builtins";
import { PREVIEW_DEBOUNCE_MS, REFRESH_DEBOUNCE_MS } from "./utils";

type Mode = "normal" | "filter" | "prompt" | "confirm";

const HINTS: Record<Mode, string> = {
	normal:
		"j/k h/l move · enter/o open · a add · r rename · d delete · x/y/p move/copy · i filter · P preview · ^d/^u scroll · esc/q close",
	filter: "enter open · ↑↓/^j^k move · esc normal",
	prompt: "enter confirm · esc cancel",
	confirm: "", // replaced by the confirm question
};

export class Drawer {
	private app: App;
	private plugin: DrawerExplorerPlugin;
	private previews: PreviewRegistry;

	private backdropEl!: HTMLElement;
	private drawerEl!: HTMLElement;
	private modeChipEl!: HTMLElement;
	private countEl!: HTMLElement;
	private filterInputEl!: HTMLInputElement;
	private listEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private previewTitleEl!: HTMLElement;
	private previewContentEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private opRowEl!: HTMLElement;
	private opLabelEl!: HTMLElement;
	private opInputEl!: HTMLInputElement;

	private mode: Mode = "normal";
	private expanded = new Set<string>();
	private sel = 0;
	private rows: Row[] = [];
	private query = "";
	private clip: Clip | null = null;
	private pendingG = false;
	private confirmLabel = "";
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
			this.revealActiveFile();
			this.render();
			this.drawerEl.focus();
			return;
		}
		this.isOpen = true;
		this.hostWin = activeWindow;
		this.hostDoc = activeDocument;
		this.prevFocus = this.hostDoc.activeElement instanceof HTMLElement ? this.hostDoc.activeElement : null;

		this.backdropEl = this.hostDoc.body.createDiv({ cls: "drawer-explorer-backdrop" });
		this.backdropEl.addEventListener("click", () => this.close());

		this.drawerEl = this.hostDoc.body.createDiv({ cls: "drawer-explorer" });
		this.drawerEl.tabIndex = -1;
		this.hostWin.addEventListener("keydown", this.windowKeyHandler, { capture: true });

		this.buildHeader();
		this.buildBody();
		this.buildFooter();

		this.revealActiveFile();
		this.setMode("normal");
		this.render();
		this.drawerEl.focus();
	}

	close() {
		if (!this.isOpen) return;
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
		this.mode = "normal";
		const editor = this.app.workspace.activeEditor?.editor;
		if (editor) editor.focus();
		else this.prevFocus?.focus();
	}

	scheduleRefresh() {
		if (!this.isOpen) return;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			if (this.isOpen) this.render();
		}, REFRESH_DEBOUNCE_MS);
	}

	// ------------------------------------------------------------- dom setup

	private buildHeader() {
		const header = this.drawerEl.createDiv({ cls: "drawer-explorer-header" });
		header.createSpan({ cls: "drawer-explorer-title", text: this.app.vault.getName() });
		this.modeChipEl = header.createSpan({ cls: "drawer-explorer-mode", text: "NORMAL" });
		this.countEl = header.createSpan({ cls: "drawer-explorer-count" });

		const filterRow = this.drawerEl.createDiv({ cls: "drawer-explorer-filter" });
		filterRow.createSpan({ cls: "drawer-explorer-prompt-char", text: "❯" });
		this.filterInputEl = filterRow.createEl("input", {
			cls: "drawer-explorer-input",
			attr: { type: "text", placeholder: "Filter (i)", spellcheck: "false" },
		});
		this.filterInputEl.addEventListener("input", () => {
			this.query = this.filterInputEl.value;
			this.sel = 0;
			this.render();
		});
		this.filterInputEl.addEventListener("focus", () => {
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
		this.footerEl = this.drawerEl.createDiv({ cls: "drawer-explorer-footer" });
	}

	// ------------------------------------------------------------- state

	private setMode(mode: Mode) {
		this.mode = mode;
		this.modeChipEl?.setText(mode.toUpperCase());
		this.drawerEl?.toggleClass("is-filter", mode === "filter");
		if (mode === "normal") {
			this.opRowEl?.hide();
			// Blur the inputs so keys land on the drawer again.
			const active = this.hostDoc.activeElement;
			if (active instanceof HTMLElement && this.drawerEl.contains(active)) {
				this.drawerEl.focus();
			}
		}
		this.renderFooter();
	}

	private selectedRow(): Row | null {
		return this.rows[this.sel] ?? null;
	}

	private targetFolder(): TFolder {
		const row = this.selectedRow();
		if (!row) return this.app.vault.getRoot();
		if (row.file instanceof TFolder) return row.file;
		return row.file.parent ?? this.app.vault.getRoot();
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

	// ------------------------------------------------------------- render

	private render() {
		if (!this.isOpen) return;
		this.buildRows();

		const total = this.app.vault.getFiles().length;
		this.countEl.setText(this.query.trim() ? `${this.rows.length}/${total}` : `${total}`);

		this.listEl.empty();
		this.rows.forEach((row, i) => this.renderRow(row, i));

		const selEl = this.listEl.children[this.sel];
		if (selEl) selEl.scrollIntoView({ block: "nearest" });

		this.renderFooter();
		this.schedulePreview();
	}

	private renderRow(row: Row, i: number) {
		const isFolder = row.file instanceof TFolder;
		const rowEl = this.listEl.createDiv({ cls: "drawer-explorer-row" });
		rowEl.toggleClass("is-selected", i === this.sel);
		rowEl.toggleClass("is-folder", isFolder);
		rowEl.toggleClass("is-cut", this.clip?.op === "cut" && this.clip.path === row.file.path);
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

		rowEl.addEventListener("click", () => {
			this.sel = i;
			if (row.file instanceof TFolder) {
				this.toggleFolder(row.file);
				this.render();
			} else if (row.file instanceof TFile) {
				void this.openFile(row.file, false);
			}
		});
	}

	private renderFooter() {
		if (!this.footerEl) return;
		this.footerEl.setText(this.mode === "confirm" ? `${this.confirmLabel} (y/N)` : HINTS[this.mode]);
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
		const row = this.selectedRow();

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
		const file = row.file;
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
				this.setMode("normal");
			} else if (e.key === "Enter") {
				this.openSelected(false);
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
				if (this.query.trim()) {
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

	private moveSel(delta: number) {
		if (!this.rows.length) return;
		this.sel = Math.max(0, Math.min(this.rows.length - 1, this.sel + delta));
		this.render();
	}

	// ------------------------------------------------------------- navigation

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

	private confirm(label: string, onYes: () => void) {
		this.confirmLabel = label;
		this.onConfirmYes = onYes;
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
		const row = this.selectedRow();
		if (!row) return;
		const file = row.file;
		this.confirm(`Delete ${file.name}?`, () => {
			void (async () => {
				try {
					await this.app.fileManager.trashFile(file);
					this.render();
				} catch (err) {
					this.reportError(err);
				}
			})();
		});
	}

	private setClip(op: Clip["op"]) {
		const row = this.selectedRow();
		if (!row) return;
		if (op === "copy" && row.file instanceof TFolder) {
			new Notice("Copying folders is not supported");
			return;
		}
		this.clip = { path: row.file.path, op };
		this.render();
	}

	private async paste() {
		if (!this.clip) return;
		const dest = this.targetFolder();
		try {
			const newPath = await pasteInto(this.app, this.clip, dest);
			this.clip = null;
			if (newPath) {
				this.expanded.add(dest.path);
				this.focusPath(newPath);
			}
		} catch (err) {
			this.reportError(err);
		}
	}
}
