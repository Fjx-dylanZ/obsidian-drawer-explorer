import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveVisualRange } from "../src/visual-mode";

const rows = ["a.md", "b.md", "c.md", "d.md"].map((path) => ({ file: { path } }));

test("resolves an inclusive visual range in both directions", () => {
	assert.deepEqual(resolveVisualRange(rows, "b.md", 3), { start: 1, end: 3 });
	assert.deepEqual(resolveVisualRange(rows, "d.md", 1), { start: 1, end: 3 });
});

test("falls back to the cursor when the visual anchor is no longer visible", () => {
	assert.deepEqual(resolveVisualRange(rows, "missing.md", 2), { start: 2, end: 2 });
});

test("rejects an absent anchor or cursor outside the visible rows", () => {
	assert.equal(resolveVisualRange(rows, null, 1), null);
	assert.equal(resolveVisualRange(rows, "b.md", -1), null);
	assert.equal(resolveVisualRange(rows, "b.md", rows.length), null);
});
