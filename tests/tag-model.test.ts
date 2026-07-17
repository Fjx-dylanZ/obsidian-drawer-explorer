import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	buildTagIndex,
	contextualTagCounts,
	flattenTagNodes,
	matchingDocumentPaths,
	normalizeTag,
	rootTagId,
} from "../src/tag-model";

test("normalizes tag identity while preserving display segments", () => {
	assert.deepEqual(normalizeTag(" #Project/Drawer-Explorer "), {
		id: "project/drawer-explorer",
		segments: ["Project", "Drawer-Explorer"],
	});
	assert.equal(normalizeTag("#not valid"), null);
	assert.equal(normalizeTag("##nested"), null);
	assert.equal(normalizeTag("nested//tag"), null);
	assert.equal(normalizeTag("nested/"), null);
	assert.equal(normalizeTag("#1984"), null);
	assert.equal(normalizeTag("#2026/07/16")?.id, "2026/07/16");
	assert.equal(rootTagId("project/drawer/ui"), "project");
});

test("builds structural parents and counts each note once", () => {
	const index = buildTagIndex([
		{
			path: "one.md",
			name: "one",
			tags: ["#Project/Foo", "#project/foo/Bar", "#PROJECT/FOO"],
		},
		{ path: "two.md", name: "two", tags: ["#project/foo/baz"] },
		{ path: "near-miss.md", name: "near-miss", tags: ["#project/foobar"] },
	]);

	assert.equal(index.nodes.get("project")?.matchingFilePaths.size, 3);
	assert.equal(index.nodes.get("project/foo")?.matchingFilePaths.size, 2);
	assert.equal(index.nodes.get("project/foo")?.directFilePaths.size, 1);
	assert.equal(index.nodes.get("project/foo/bar")?.matchingFilePaths.size, 1);
	assert.equal(index.nodes.get("project/foo/bar")?.displayPath, "Project/Foo/Bar");
	assert.equal(index.nodes.get("project/foobar")?.matchingFilePaths.size, 1);
	assert.equal(index.nodes.get("project/foo")?.label, "Foo");
});

test("intersects parent-inclusive tag memberships for progressive AND filters", () => {
	const index = buildTagIndex([
		{ path: "active.md", name: "active", tags: ["#project/foo/child", "#status/active"] },
		{ path: "done.md", name: "done", tags: ["#project/foo", "#status/done"] },
		{ path: "other.md", name: "other", tags: ["#project/bar", "#status/active"] },
	]);

	assert.deepEqual([...matchingDocumentPaths(index, ["project/foo", "status/active"])], ["active.md"]);
	assert.deepEqual(
		[...matchingDocumentPaths(index, ["project/foo"])].sort(),
		["active.md", "done.md"],
	);

	const withinProject = matchingDocumentPaths(index, ["project/foo"]);
	const counts = contextualTagCounts(index, withinProject);
	assert.equal(counts.get("status"), 2);
	assert.equal(counts.get("status/active"), 1);
	assert.equal(counts.get("status/done"), 1);
});

test("tracks indexed untagged notes separately", () => {
	const index = buildTagIndex([
		{ path: "untagged.md", name: "untagged", tags: [] },
		{ path: "tagged.md", name: "tagged", tags: ["#topic/test"] },
	]);
	assert.deepEqual([...index.untaggedPaths], ["untagged.md"]);
});

test("uses the last input when a path is indexed more than once", () => {
	const index = buildTagIndex([
		{ path: "same.md", name: "old", tags: ["#old"] },
		{ path: "same.md", name: "new", tags: ["#new"] },
	]);
	assert.equal(index.documents.get("same.md")?.name, "new");
	assert.equal(index.nodes.has("old"), false);
	assert.deepEqual([...matchingDocumentPaths(index, [])], ["same.md"]);
	assert.deepEqual([...matchingDocumentPaths(index, ["missing"])], []);
});

test("links and naturally sorts structural tag nodes", () => {
	const index = buildTagIndex([
		{ path: "ten.md", name: "ten", tags: ["#topic/10"] },
		{ path: "two.md", name: "two", tags: ["#topic/2"] },
	]);
	assert.deepEqual(index.rootIds, ["topic"]);
	assert.equal(index.nodes.get("topic/2")?.parentId, "topic");
	assert.deepEqual(index.nodes.get("topic")?.childIds, ["topic/2", "topic/10"]);
});

test("flattens only expanded branches with contextual counts", () => {
	const index = buildTagIndex([
		{ path: "one.md", name: "one", tags: ["#project/foo", "#status/active"] },
		{ path: "two.md", name: "two", tags: ["#project/bar", "#status/done"] },
	]);
	const within = matchingDocumentPaths(index, ["status/active"]);
	const rows = flattenTagNodes(index, new Set(["project"]), contextualTagCounts(index, within), "status");
	assert.deepEqual(
		rows.map(({ id, depth, count }) => ({ id, depth, count })),
		[
			{ id: "project", depth: 0, count: 1 },
			{ id: "project/foo", depth: 1, count: 1 },
		],
	);
	assert.deepEqual(flattenTagNodes(index, new Set(), new Map()), []);
});
