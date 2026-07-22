import assert from "node:assert/strict";
import test from "node:test";

import {
	formatArtifactReceipt,
	formatSystemEntry,
	renderArtifactReceipt,
	renderSystemEntry,
	renderToolEntry,
} from "../lib/render.ts";
import type { ArtifactReceipt, PresentationSystemEntry, PresentationToolEntry } from "../lib/types.ts";

const systemEntry: PresentationSystemEntry = {
	version: 1,
	kind: "workspace",
	tone: "info",
	label: "WORKSPACE",
	message: "terrific-pi · main · rules 2",
	detail: "2026-07-21T00:00:00.000Z",
	timestamp: 1,
	dedupeKey: "workspace:/repo",
};

test("system entries remain one line when collapsed and reveal only metadata when expanded", () => {
	assert.deepEqual(formatSystemEntry(systemEntry, false), ["● WORKSPACE · terrific-pi · main · rules 2"]);
	assert.match(formatSystemEntry(systemEntry, true).join("\n"), /WORKSPACE[\s\S]*2026-07-21/);
});

test("artifact receipts compact paths and bound expanded rows", () => {
	const receipt: ArtifactReceipt = {
		version: 1,
		turnIndex: 3,
		files: [
			{ path: "src/a.ts", operation: "modified", additions: 12, deletions: 3, sources: ["edit"] },
			{ path: "b.ts", operation: "added", additions: 4, sources: ["write"] },
			{ path: "old.ts", operation: "deleted", sources: ["git"] },
			{ path: "more.ts", operation: "modified", sources: ["git"] },
		],
		successfulWrites: 2,
		failedWrites: 0,
		gitReconciled: true,
		startedAt: 1,
		flushedAt: 2,
	};
	assert.equal(formatArtifactReceipt(receipt, false, 2)[0], "Files 4 changed · +16/-3 · M src/a.ts +12/-3 · A b.ts +4 · +2 more");
	assert.deepEqual(formatArtifactReceipt(receipt, true, 2), [
		"Files 4 · git reconciled",
		"M src/a.ts +12/-3 · edit",
		"A b.ts +4 · write",
		"+2 more",
	]);
});

test("artifact renderers remove terminal control sequences from persisted paths", () => {
	const output = formatArtifactReceipt({
		version: 1,
		turnIndex: 1,
		files: [{ path: "src/evil\n\u001b[31mred\u001b[0m.ts", operation: "modified", sources: ["git"] }],
		successfulWrites: 0,
		failedWrites: 0,
		gitReconciled: true,
		startedAt: 1,
		flushedAt: 2,
	}, false, 8).join("\n");
	assert.doesNotMatch(output, /[\x00-\x1f\x7f-\x9f]/);
	assert.doesNotMatch(output, /\u001b/);
});

test("tool summaries stay compact without a per-row expansion hint", () => {
	const theme = {
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	const entry: PresentationToolEntry = {
		version: 1,
		kind: "exploration",
		tone: "muted",
		label: "Explored",
		message: "read src/a.ts · 300ms",
		detail: "read src/a.ts",
		expandable: true,
		timestamp: 1,
	};
	const line = renderToolEntry(entry, false, theme).render(160)[0] ?? "";
	assert.match(line, /read src\/a\.ts/);
	assert.doesNotMatch(line, /to expand/);
	assert.match(line, /300ms/);
	const expandedLine = renderToolEntry(entry, true, theme).render(160)[0] ?? "";
	assert.doesNotMatch(expandedLine, /to expand/);
	const narrowLine = renderToolEntry({
		...entry,
		message: "read 2 files · searched 1 pattern · listed 1 directory · 300ms",
	}, false, theme).render(80)[0] ?? "";
	assert.match(narrowLine, /Explored/);
	assert.doesNotMatch(narrowLine, /to expand/);
});

test("collapsed system and artifact entries occupy one rendered row at narrow widths", () => {
	const theme = {
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	const longSystem = {
		...systemEntry,
		label: "MODEL SELECTION WITH A LONG LABEL",
		message: "x".repeat(180),
	};
	const receipt: ArtifactReceipt = {
		version: 1,
		turnIndex: 3,
		files: Array.from({ length: 32 }, (_, index) => ({
			path: `very/long/workspace/path/for/a/file-${index}.typescript`,
			operation: "modified" as const,
			additions: 12,
			deletions: 3,
			sources: ["git"],
		})),
		successfulWrites: 0,
		failedWrites: 0,
		gitReconciled: true,
		startedAt: 1,
		flushedAt: 2,
	};

	assert.equal(renderSystemEntry(longSystem, false, theme).render(80).length, 1);
	assert.equal(renderArtifactReceipt(receipt, false, 32, theme).render(80).length, 1);
	assert.match(formatArtifactReceipt(receipt, false, 32)[0]!, /\+30 more$/);
});
