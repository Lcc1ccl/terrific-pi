import assert from "node:assert/strict";
import test from "node:test";

import {
	ANSWER_CONTRACT,
	EntryDeduper,
	appendAnswerContract,
	isPresentationEvent,
	makeSystemEntry,
	makeWorkspaceEntry,
} from "../lib/system-events.ts";

test("answer contract is appended once per chained prompt", () => {
	const once = appendAnswerContract("base prompt");
	assert.match(once, /Presentation contract:/);
	assert.match(once, /Start the final response with the result/);
	assert.equal(appendAnswerContract(once), once);
	assert.match(ANSWER_CONTRACT, /tool calls/);
});

test("system entries are deduplicated by durable key", () => {
	const deduper = new EntryDeduper();
	const workspace = makeWorkspaceEntry({
		cwd: "/workspace/terrific-pi",
		branch: "main",
		ruleCount: 2,
		timestamp: 10,
	});
	assert.ok(workspace);
	assert.equal(deduper.accept(workspace!), true);
	assert.equal(deduper.accept(workspace!), false);
	assert.equal(deduper.accept({ ...workspace!, dedupeKey: "workspace:/other" }), true);
});

test("mode and fast entries are deduplicated only within 500ms", () => {
	const deduper = new EntryDeduper();
	const mode = {
		version: 1 as const,
		kind: "mode" as const,
		tone: "info" as const,
		label: "Mode",
		message: "PLAN · read-only",
		dedupeKey: "mode:plan",
	};
	assert.equal(deduper.accept({ ...mode, timestamp: 100 }), true);
	assert.equal(deduper.accept({ ...mode, timestamp: 599 }), false);
	assert.equal(deduper.accept({ ...mode, timestamp: 600 }), true);
});

test("model and thinking selections retain a return to an earlier state", () => {
	const deduper = new EntryDeduper();
	const model = (message: string, timestamp: number) => makeSystemEntry({
		kind: "model",
		label: "Model",
		message,
		dedupeKey: `model:${message}`,
		timestamp,
	});
	assert.equal(deduper.accept(model("A", 100)!), true);
	assert.equal(deduper.accept(model("B", 200)!), true);
	assert.equal(deduper.accept(model("A", 300)!), true);
});

test("system entries remove C1 terminal control sequences", () => {
	const entry = makeSystemEntry({
		kind: "mode",
		label: "\u009b31mMode",
		message: "PLAN · read-only",
		dedupeKey: "mode:plan",
	});
	assert.ok(entry);
	assert.doesNotMatch(entry!.label, /[\x80-\x9f]/);
});

test("only well-formed mode and fast events are accepted", () => {
	assert.equal(isPresentationEvent({
		version: 1,
		kind: "mode",
		source: "user",
		tone: "info",
		label: "Mode",
		message: "PLAN · read-only",
		dedupeKey: "mode:plan",
	}), true);
	assert.equal(isPresentationEvent({ version: 1, kind: "mode" }), false);
});
