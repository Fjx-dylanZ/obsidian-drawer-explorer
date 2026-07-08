import { PreviewProvider } from "./registry";

interface CanvasNode {
	id: string;
	type?: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
	text?: string;
	file?: string;
	label?: string;
	url?: string;
}

interface CanvasEdge {
	fromNode: string;
	toNode: string;
}

interface CanvasData {
	nodes?: CanvasNode[];
	edges?: CanvasEdge[];
}

/** Obsidian's default canvas palette ("1".."6"); raw hex values pass through. */
const CANVAS_COLORS: Record<string, string> = {
	"1": "#fb464c",
	"2": "#e9973f",
	"3": "#e0de71",
	"4": "#44cf6e",
	"5": "#53dfdd",
	"6": "#a882ff",
};

const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_NODE_LIMIT = 60;

function svg<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
	const el = activeDocument.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attrs)) {
		el.setAttribute(key, String(value));
	}
	return el;
}

// "currentColor" resolves to the svg root's CSS `color` (a theme variable),
// since presentation attributes can't reference var() directly
function nodeColor(node: CanvasNode): string {
	if (!node.color) return "currentColor";
	return CANVAS_COLORS[node.color] ?? node.color;
}

function nodeLabel(node: CanvasNode): string {
	const raw =
		node.label ??
		node.text?.split("\n")[0] ??
		node.file?.split("/").pop() ??
		node.url ??
		"";
	return raw.length > 28 ? `${raw.slice(0, 27)}…` : raw;
}

export const canvasProvider: PreviewProvider = {
	id: "canvas",
	canPreview: (file) => file.extension.toLowerCase() === "canvas",
	async render({ app, el, file }) {
		const raw = await app.vault.cachedRead(file);
		let data: CanvasData;
		try {
			data = JSON.parse(raw) as CanvasData;
		} catch {
			el.createEl("pre", { text: raw.slice(0, 10_000) });
			return;
		}

		const nodes = data.nodes ?? [];
		const edges = data.edges ?? [];

		el.createDiv({
			cls: "drawer-explorer-preview-empty",
			text: `${nodes.length} node${nodes.length === 1 ? "" : "s"} · ${edges.length} edge${edges.length === 1 ? "" : "s"}`,
		});
		if (!nodes.length) return;

		const pad = 24;
		const minX = Math.min(...nodes.map((n) => n.x)) - pad;
		const minY = Math.min(...nodes.map((n) => n.y)) - pad;
		const maxX = Math.max(...nodes.map((n) => n.x + n.width)) + pad;
		const maxY = Math.max(...nodes.map((n) => n.y + n.height)) + pad;
		const width = maxX - minX;
		const height = maxY - minY;

		const svgEl = svg("svg", {
			viewBox: `${minX} ${minY} ${width} ${height}`,
			preserveAspectRatio: "xMidYMid meet",
		});
		svgEl.addClass("drawer-explorer-canvas-svg");

		const byId = new Map(nodes.map((n) => [n.id, n]));
		for (const edge of edges) {
			const from = byId.get(edge.fromNode);
			const to = byId.get(edge.toNode);
			if (!from || !to) continue;
			// stroke color comes from the .drawer-explorer-canvas-svg line CSS rule
			const line = svg("line", {
				x1: from.x + from.width / 2,
				y1: from.y + from.height / 2,
				x2: to.x + to.width / 2,
				y2: to.y + to.height / 2,
				"stroke-width": Math.max(2, width / 300),
			});
			svgEl.appendChild(line);
		}

		// draw groups first so regular nodes sit on top of them
		const ordered = [...nodes].sort((a, b) => (a.type === "group" ? -1 : 0) - (b.type === "group" ? -1 : 0));
		const fontSize = Math.max(10, Math.min(48, width / 34));
		const showLabels = nodes.length <= LABEL_NODE_LIMIT;

		for (const node of ordered) {
			const color = nodeColor(node);
			const rect = svg("rect", {
				x: node.x,
				y: node.y,
				width: node.width,
				height: node.height,
				rx: Math.min(12, node.width / 8),
				fill: color,
				stroke: color,
				"fill-opacity": node.type === "group" ? 0.06 : 0.14,
				"stroke-width": Math.max(2, width / 400),
			});
			svgEl.appendChild(rect);

			if (!showLabels) continue;
			const label = nodeLabel(node);
			if (!label) continue;
			// fill color comes from the .drawer-explorer-canvas-svg text CSS rule
			const text = svg("text", {
				x: node.x + node.width / 2,
				y: node.type === "group" ? node.y + fontSize * 1.2 : node.y + node.height / 2,
				"text-anchor": "middle",
				"dominant-baseline": node.type === "group" ? "auto" : "middle",
				"font-size": fontSize,
			});
			text.textContent = label;
			svgEl.appendChild(text);
		}

		el.appendChild(svgEl);
	},
};
