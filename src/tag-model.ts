export interface TagDocumentInput {
	path: string;
	name: string;
	tags: readonly string[];
}

export interface IndexedTagDocument {
	path: string;
	name: string;
	exactTagIds: ReadonlySet<string>;
	matchingTagIds: ReadonlySet<string>;
}

export interface TagNode {
	id: string;
	label: string;
	displayPath: string;
	parentId: string | null;
	childIds: readonly string[];
	directFilePaths: ReadonlySet<string>;
	matchingFilePaths: ReadonlySet<string>;
}

export interface TagIndex {
	documents: ReadonlyMap<string, IndexedTagDocument>;
	nodes: ReadonlyMap<string, TagNode>;
	rootIds: readonly string[];
	untaggedPaths: ReadonlySet<string>;
}

export interface FlattenedTagNode {
	id: string;
	depth: number;
	count: number;
	hasChildren: boolean;
}

interface MutableTagNode {
	id: string;
	label: string;
	displayPath: string;
	parentId: string | null;
	childIds: Set<string>;
	directFilePaths: Set<string>;
	matchingFilePaths: Set<string>;
}

interface NormalizedTag {
	id: string;
	segments: string[];
}

/** Obsidian tag identity is case-insensitive and does not include the leading #. */
export function normalizeTag(raw: string): NormalizedTag | null {
	const trimmed = raw.trim();
	const value = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
	if (
		!value ||
		value.startsWith("#") ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		/\s/.test(value) ||
		/^\d+$/.test(value)
	) {
		return null;
	}
	const segments = value.split("/");
	if (segments.some((segment) => !segment)) return null;
	return { id: segments.join("/").toLowerCase(), segments };
}

export function rootTagId(id: string): string {
	return id.split("/", 1)[0];
}

/** Build the structural tag tree and unique-note membership for each tag prefix. */
export function buildTagIndex(inputs: readonly TagDocumentInput[]): TagIndex {
	const mutableNodes = new Map<string, MutableTagNode>();
	const documents = new Map<string, IndexedTagDocument>();
	const untaggedPaths = new Set<string>();
	const uniqueInputs = new Map<string, TagDocumentInput>();
	for (const input of inputs) uniqueInputs.set(input.path, input);

	for (const input of uniqueInputs.values()) {
		const normalizedById = new Map<string, NormalizedTag>();
		for (const raw of input.tags) {
			const normalized = normalizeTag(raw);
			if (normalized && !normalizedById.has(normalized.id)) {
				normalizedById.set(normalized.id, normalized);
			}
		}

		const exactTagIds = new Set(normalizedById.keys());
		const matchingTagIds = new Set<string>();
		if (!exactTagIds.size) untaggedPaths.add(input.path);

		for (const tag of normalizedById.values()) {
			let parentId: string | null = null;
			for (let depth = 0; depth < tag.segments.length; depth += 1) {
				const segment = tag.segments[depth];
				const id: string = parentId ? `${parentId}/${segment.toLowerCase()}` : segment.toLowerCase();
				let node = mutableNodes.get(id);
				if (!node) {
					const parent = parentId ? mutableNodes.get(parentId) : null;
					const displayPath = parent ? `${parent.displayPath}/${segment}` : segment;
					node = {
						id,
						label: segment,
						displayPath,
						parentId,
						childIds: new Set(),
						directFilePaths: new Set(),
						matchingFilePaths: new Set(),
					};
					mutableNodes.set(id, node);
				}
				if (parentId) mutableNodes.get(parentId)?.childIds.add(id);
				node.matchingFilePaths.add(input.path);
				matchingTagIds.add(id);
				if (depth === tag.segments.length - 1) node.directFilePaths.add(input.path);
				parentId = id;
			}
		}

		documents.set(input.path, {
			path: input.path,
			name: input.name,
			exactTagIds,
			matchingTagIds,
		});
	}

	const compareNodes = (a: string, b: string) => {
		const aNode = mutableNodes.get(a);
		const bNode = mutableNodes.get(b);
		return (aNode?.label ?? a).localeCompare(bNode?.label ?? b, undefined, {
			sensitivity: "base",
			numeric: true,
		});
	};
	const nodes = new Map<string, TagNode>();
	for (const node of mutableNodes.values()) {
		nodes.set(node.id, {
			...node,
			childIds: [...node.childIds].sort(compareNodes),
		});
	}
	const rootIds = [...mutableNodes.values()]
		.filter((node) => node.parentId === null)
		.map((node) => node.id)
		.sort(compareNodes);

	return { documents, nodes, rootIds, untaggedPaths };
}

/** Match notes that have every selected tag, with parent tags including descendants. */
export function matchingDocumentPaths(index: TagIndex, tagIds: readonly string[]): Set<string> {
	if (!tagIds.length) return new Set(index.documents.keys());
	const memberships = tagIds.map((id) => index.nodes.get(id)?.matchingFilePaths ?? new Set<string>());
	memberships.sort((a, b) => a.size - b.size);
	const [smallest, ...rest] = memberships;
	const matches = new Set<string>();
	for (const path of smallest) {
		if (rest.every((membership) => membership.has(path))) matches.add(path);
	}
	return matches;
}

/** Count each tag once per note inside the current progressive result set. */
export function contextualTagCounts(index: TagIndex, withinPaths: ReadonlySet<string>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const path of withinPaths) {
		const document = index.documents.get(path);
		if (!document) continue;
		for (const id of document.matchingTagIds) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return counts;
}

/** Flatten the visible part of the tag hierarchy, optionally scoped by contextual counts. */
export function flattenTagNodes(
	index: TagIndex,
	expanded: ReadonlySet<string>,
	counts?: ReadonlyMap<string, number>,
	excludedRootId?: string,
): FlattenedTagNode[] {
	const rows: FlattenedTagNode[] = [];
	const walk = (id: string, depth: number) => {
		const node = index.nodes.get(id);
		if (!node) return;
		const count = counts ? (counts.get(id) ?? 0) : node.matchingFilePaths.size;
		if (counts && count === 0) return;
		const visibleChildren = node.childIds.filter((childId) => !counts || (counts.get(childId) ?? 0) > 0);
		rows.push({ id, depth, count, hasChildren: visibleChildren.length > 0 });
		if (expanded.has(id)) {
			for (const childId of visibleChildren) walk(childId, depth + 1);
		}
	};
	for (const rootId of index.rootIds) {
		if (rootId !== excludedRootId) walk(rootId, 0);
	}
	return rows;
}
