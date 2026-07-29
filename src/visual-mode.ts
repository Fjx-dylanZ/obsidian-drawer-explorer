export interface VisualRange {
	start: number;
	end: number;
}

/** Resolve the inclusive range between a visual anchor and the current visible row. */
export function resolveVisualRange(
	rows: readonly { file: { path: string } }[],
	anchorPath: string | null,
	cursorIndex: number,
): VisualRange | null {
	if (!anchorPath || cursorIndex < 0 || cursorIndex >= rows.length) return null;
	const anchorIndex = rows.findIndex((row) => row.file.path === anchorPath);
	const visibleAnchor = anchorIndex >= 0 ? anchorIndex : cursorIndex;
	return {
		start: Math.min(visibleAnchor, cursorIndex),
		end: Math.max(visibleAnchor, cursorIndex),
	};
}
