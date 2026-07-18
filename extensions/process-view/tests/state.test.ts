import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Check } from "typebox/value";

import {
	PROCESS_ENTRY_TYPE,
	ProcessUpdateParams,
	type ProcessSnapshot,
	type ProcessUpdateInput,
} from "../lib/types.ts";
import {
	ProcessUpdateError,
	buildContextReminder,
	createPersistedState,
	createTombstone,
	interruptSnapshot,
	normalizeProcessUpdate,
	restoreProcessState,
	settleSnapshot,
} from "../lib/state.ts";

const NOW = 1_726_000_000_000;

function runningInput(): ProcessUpdateInput {
	return {
		title: "Update configuration",
		status: "running",
		steps: [
			{ text: "Inspect current state", status: "done" },
			{ text: "Apply changes", status: "active" },
			{ text: "Run checks", status: "pending" },
		],
		update: "Configuration located",
		artifacts: [{ kind: "file", label: "settings.json", ref: "/tmp/settings.json" }],
	};
}

function snapshot(): ProcessSnapshot {
	return normalizeProcessUpdate(runningInput(), undefined, NOW);
}

function entry(data: unknown) {
	return { type: "custom", customType: PROCESS_ENTRY_TYPE, data };
}

describe("ProcessUpdateParams", () => {
	it("accepts one to five steps and rejects schema limits", () => {
		const input = runningInput();
		assert.equal(Check(ProcessUpdateParams, input), true);
		assert.equal(Check(ProcessUpdateParams, { ...input, steps: [] }), false);
		assert.equal(Check(ProcessUpdateParams, {
			...input,
			steps: Array.from({ length: 6 }, (_, index) => ({ text: `Step ${index}`, status: "pending" })),
		}), false);
		assert.equal(Check(ProcessUpdateParams, {
			...input,
			artifacts: Array.from({ length: 6 }, (_, index) => ({ kind: "file", label: `File ${index}` })),
		}), false);
		assert.equal(Check(ProcessUpdateParams, { ...input, title: "x".repeat(121) }), false);
	});
});

describe("normalizeProcessUpdate", () => {
	it("normalizes text and preserves the request start time", () => {
		const first = normalizeProcessUpdate({
			...runningInput(),
			title: "  Update\u001b[31m\r\n\t configuration\u001b[0m  ",
			steps: [
				{ text: "Inspect\u0000 state", status: "done" },
				{ text: "Apply\t changes", status: "active" },
			],
		}, undefined, NOW);
		const second = normalizeProcessUpdate(runningInput(), first, NOW + 500);

		assert.equal(first.title, "Update configuration");
		assert.deepEqual(first.steps.map((step) => step.text), ["Inspect state", "Apply changes"]);
		assert.equal(second.startedAt, NOW);
		assert.equal(second.updatedAt, NOW + 500);
	});

	it("requires exactly one active step while running", () => {
		assert.throws(
			() => normalizeProcessUpdate({
				...runningInput(),
				steps: runningInput().steps.map((step) => ({ ...step, status: "pending" as const })),
			}),
			(error) => error instanceof ProcessUpdateError && /exactly one active/i.test(error.message),
		);
		assert.throws(
			() => normalizeProcessUpdate({
				...runningInput(),
				steps: [
					{ text: "One", status: "active" },
					{ text: "Two", status: "active" },
				],
			}),
			(error) => error instanceof ProcessUpdateError && /exactly one active/i.test(error.message),
		);
	});

	it("requires an update while waiting and allows at most one active step", () => {
		assert.throws(
			() => normalizeProcessUpdate({ ...runningInput(), status: "waiting", update: undefined }),
			/waiting requires update/i,
		);
		assert.throws(
			() => normalizeProcessUpdate({
				...runningInput(),
				status: "waiting",
				steps: [
					{ text: "One", status: "active" },
					{ text: "Two", status: "active" },
				],
			}),
			/at most one active/i,
		);
		assert.equal(normalizeProcessUpdate({ ...runningInput(), status: "waiting" }, undefined, NOW).status, "waiting");
	});

	it("requires a blocker for blocked state", () => {
		assert.throws(
			() => normalizeProcessUpdate({ ...runningInput(), status: "blocked", blocker: " \r\n " }),
			/blocked requires blocker/i,
		);
		assert.equal(normalizeProcessUpdate({
			...runningInput(),
			status: "blocked",
			blocker: "Need user confirmation",
		}, undefined, NOW).blocker, "Need user confirmation");
	});

	it("only completes fully done work with an update or verification", () => {
		assert.throws(
			() => normalizeProcessUpdate({ ...runningInput(), status: "completed" }),
			/completed requires all steps done/i,
		);
		const doneSteps = runningInput().steps.map((step) => ({ ...step, status: "done" as const }));
		assert.throws(
			() => normalizeProcessUpdate({
				...runningInput(),
				status: "completed",
				steps: doneSteps,
				update: undefined,
			}),
			/completed requires update or verification/i,
		);
		assert.equal(normalizeProcessUpdate({
			...runningInput(),
			status: "completed",
			steps: doneSteps,
			update: undefined,
			verification: "All checks passed",
		}, undefined, NOW).status, "completed");
	});

	it("rejects empty normalized text and direct callers exceeding limits", () => {
		assert.throws(() => normalizeProcessUpdate({ ...runningInput(), title: "\u001b[31m" }), /title is required/i);
		assert.throws(() => normalizeProcessUpdate({
			...runningInput(),
			steps: Array.from({ length: 6 }, (_, index) => ({ text: `Step ${index}`, status: "pending" as const })),
		}), /one to five steps/i);
		assert.throws(() => normalizeProcessUpdate({
			...runningInput(),
			artifacts: Array.from({ length: 6 }, (_, index) => ({ kind: "file" as const, label: `File ${index}` })),
		}), /at most five artifacts/i);
	});
});

describe("branch state", () => {
	it("restores the last state from the current branch", () => {
		const first = createPersistedState(snapshot(), "compact");
		const latest = createPersistedState({ ...snapshot(), title: "Latest" }, "full");
		const restored = restoreProcessState([entry(first), { type: "message" }, entry(latest)]);
		assert.equal(restored.corrupted, false);
		assert.equal(restored.state.viewMode, "full");
		assert.equal(restored.state.snapshot?.title, "Latest");
	});

	it("lets a tombstone prevent older state from reviving", () => {
		const restored = restoreProcessState([
			entry(createPersistedState(snapshot(), "compact")),
			entry(createTombstone("off")),
		]);
		assert.equal(restored.corrupted, false);
		assert.deepEqual(restored.state, { version: 1, viewMode: "off", cleared: true });
	});

	it("fails closed when the latest process entry is invalid", () => {
		const restored = restoreProcessState([
			entry(createPersistedState(snapshot(), "full")),
			entry({ version: 2, viewMode: "full", snapshot: snapshot(), cleared: false }),
		]);
		assert.equal(restored.corrupted, true);
		assert.deepEqual(restored.state, { version: 1, viewMode: "compact", cleared: true });
	});

	it("uses only entries supplied by the selected branch", () => {
		const left = restoreProcessState([entry(createPersistedState({ ...snapshot(), title: "Left" }, "compact"))]);
		const right = restoreProcessState([entry(createPersistedState({ ...snapshot(), title: "Right" }, "compact"))]);
		assert.equal(left.state.snapshot?.title, "Left");
		assert.equal(right.state.snapshot?.title, "Right");
	});
});

describe("system transitions", () => {
	it("settles running work as waiting without claiming completion", () => {
		const settled = settleSnapshot({ ...snapshot(), update: undefined }, NOW + 1_000);
		assert.equal(settled.status, "waiting");
		assert.equal(settled.update, "Waiting for continuation");
		assert.equal(settled.updatedAt, NOW + 1_000);
	});

	it("persists a bounded interrupted state without an error stack", () => {
		const interrupted = interruptSnapshot(snapshot(), "error", NOW + 1_000);
		assert.equal(interrupted.status, "interrupted");
		assert.equal(interrupted.update, "Run stopped after an error");
		assert.doesNotMatch(interrupted.update ?? "", /stack|trace/i);
	});

	it("builds a one-shot reminder without artifact refs or verification", () => {
		const value = {
			...snapshot(),
			status: "blocked" as const,
			blocker: "Choose a target",
			verification: "secret verification",
		};
		const reminder = buildContextReminder(value);
		assert.match(reminder, /Update configuration/);
		assert.match(reminder, /Choose a target/);
		assert.doesNotMatch(reminder, /\/tmp\/settings\.json|secret verification/);
		assert.ok(reminder.length < 1_000);
	});
});
