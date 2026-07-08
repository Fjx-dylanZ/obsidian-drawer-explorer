import { parseYaml } from "obsidian";
import { PreviewProvider } from "./registry";

/**
 * Loose shape of an Obsidian Bases (`.base`) file. Parsed defensively — any
 * unexpected structure falls back to raw YAML.
 */
interface BaseFileData {
	filters?: unknown;
	formulas?: Record<string, unknown>;
	properties?: Record<string, unknown>;
	views?: { type?: string; name?: string; filters?: unknown; [key: string]: unknown }[];
}

function stringifyFilter(filter: unknown, indent = 0): string[] {
	const pad = "  ".repeat(indent);
	if (typeof filter === "string") return [`${pad}${filter}`];
	if (Array.isArray(filter)) return filter.flatMap((f) => stringifyFilter(f, indent));
	if (filter && typeof filter === "object") {
		const lines: string[] = [];
		for (const [op, value] of Object.entries(filter as Record<string, unknown>)) {
			lines.push(`${pad}${op}:`);
			lines.push(...stringifyFilter(value, indent + 1));
		}
		return lines;
	}
	return [`${pad}${String(filter)}`];
}

function section(el: HTMLElement, title: string): HTMLElement {
	el.createDiv({ cls: "drawer-explorer-base-heading", text: title });
	return el.createDiv({ cls: "drawer-explorer-base-section" });
}

export const baseProvider: PreviewProvider = {
	id: "base",
	canPreview: (file) => file.extension.toLowerCase() === "base",
	async render({ app, el, file }) {
		const raw = await app.vault.cachedRead(file);
		let data: BaseFileData | null = null;
		try {
			data = parseYaml(raw) as BaseFileData;
		} catch {
			// fall through to raw view
		}
		if (!data || typeof data !== "object") {
			el.createEl("pre", { text: raw.slice(0, 10_000) });
			return;
		}

		const views = data.views ?? [];
		el.createDiv({
			cls: "drawer-explorer-preview-empty",
			text: `Base · ${views.length} view${views.length === 1 ? "" : "s"}`,
		});

		if (views.length) {
			const viewsEl = section(el, "Views");
			for (const view of views) {
				const rowEl = viewsEl.createDiv({ cls: "drawer-explorer-base-view" });
				rowEl.createSpan({ cls: "drawer-explorer-base-badge", text: view.type ?? "table" });
				rowEl.createSpan({ text: view.name ?? "(unnamed)" });
				if (view.filters) {
					viewsEl.createEl("pre", {
						cls: "drawer-explorer-base-filter",
						text: stringifyFilter(view.filters).join("\n"),
					});
				}
			}
		}

		if (data.filters) {
			section(el, "Filters").createEl("pre", {
				cls: "drawer-explorer-base-filter",
				text: stringifyFilter(data.filters).join("\n"),
			});
		}

		const formulas = Object.entries(data.formulas ?? {});
		if (formulas.length) {
			const formulasEl = section(el, "Formulas");
			for (const [name, expr] of formulas) {
				formulasEl.createEl("pre", {
					cls: "drawer-explorer-base-filter",
					text: `${name} = ${String(expr)}`,
				});
			}
		}

		const properties = Object.keys(data.properties ?? {});
		if (properties.length) {
			section(el, "Properties").createDiv({
				cls: "drawer-explorer-preview-empty",
				text: properties.join(" · "),
			});
		}
	},
};
