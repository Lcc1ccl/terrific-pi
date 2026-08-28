import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Check } from "typebox/value";

import {
	TASKBOARD_ENTRY_TYPE,
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
	recordAssistantUsage,
	restoreProcessState,
	semanticProcessEqual,
	settleSnapshot,
	stepElapsedMs,
	syncProcessTelemetry,
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
	return { type: "custom", customType: TASKBOARD_ENTRY_TYPE, data };
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
		const ready = snapshot();
		ready.steps = [
			{ text: "Inspect current state", status: "done" },
			{ text: "Apply changes", status: "done" },
			{ text: "Run checks", status: "active" },
		];
		assert.equal(normalizeProcessUpdate({
			...runningInput(),
			status: "completed",
			steps: doneSteps,
			update: undefined,
			verification: "All checks passed",
		}, ready, NOW + 1).status, "completed");
	});

	it("matches done steps by text and accepts truthful batch completion", () => {
		const doneSteps = runningInput().steps.map((step) => ({ ...step, status: "done" as const }));
		assert.equal(normalizeProcessUpdate({
			...runningInput(),
			status: "completed",
			steps: doneSteps,
			verification: "All checks passed",
		}, undefined, NOW).status, "completed");

		const previous = snapshot();
		const batch = normalizeProcessUpdate({
			...runningInput(),
			status: "waiting",
			steps: [
				{ text: "Inspect current state", status: "done" },
				{ text: "Apply changes", status: "active" },
				{ text: "Run checks", status: "done" },
			],
			update: "Later step completed in the same milestone",
		}, previous, NOW + 1);
		assert.deepEqual(batch.steps.map((step) => step.status), ["done", "active", "done"]);

		const reordered = normalizeProcessUpdate({
			...runningInput(),
			steps: [
				{ text: "Apply changes", status: "active" },
				{ text: "Inspect current state", status: "done" },
				{ text: "Run checks", status: "pending" },
			],
		}, previous, NOW + 1);
		assert.deepEqual(reordered.steps.map((step) => step.status), ["active", "done", "pending"]);
	});

	it("assigns stable internal IDs across rename, reorder, insert, and delete", () => {
		const first = snapshot();
		assert.equal(new Set(first.steps.map((step) => step.id)).size, first.steps.length);
		assert.ok(first.steps.every((step) => typeof step.id === "string" && step.id.length > 0));

		const renamed = normalizeProcessUpdate({
			...runningInput(),
			steps: runningInput().steps.map((step, index) => index === 1 ? { ...step, text: "Apply safe changes" } : step),
		}, first, NOW + 1);
		assert.equal(renamed.steps[1]?.id, first.steps[1]?.id);

		const reordered = normalizeProcessUpdate({
			...runningInput(),
			steps: [runningInput().steps[1]!, runningInput().steps[0]!, runningInput().steps[2]!],
		}, first, NOW + 2);
		assert.deepEqual(reordered.steps.map((step) => step.id), [first.steps[1]?.id, first.steps[0]?.id, first.steps[2]?.id]);

		const inserted = normalizeProcessUpdate({
			...runningInput(),
			steps: [
				runningInput().steps[0]!,
				{ text: "Review changes", status: "pending" },
				runningInput().steps[1]!,
				runningInput().steps[2]!,
			],
		}, first, NOW + 3);
		assert.notEqual(inserted.steps[1]?.id, first.steps[1]?.id);
		assert.equal(inserted.steps[2]?.id, first.steps[1]?.id);

		const deleted = normalizeProcessUpdate({
			...runningInput(),
			steps: [runningInput().steps[0]!, runningInput().steps[1]!],
		}, first, NOW + 4);
		assert.deepEqual(deleted.steps.map((step) => step.id), [first.steps[0]?.id, first.steps[1]?.id]);
	});

	it("starts ambiguous duplicate and rename-plus-reorder steps with new identities", () => {
		const duplicate = normalizeProcessUpdate({
			...runningInput(),
			steps: [
				{ text: "Duplicate", status: "done" },
				{ text: "Duplicate", status: "pending" },
				{ text: "Work", status: "active" },
			],
		}, undefined, NOW);
		const ambiguous = normalizeProcessUpdate({
			...runningInput(),
			steps: [
				{ text: "Duplicate", status: "pending" },
				{ text: "Duplicate", status: "done" },
				{ text: "Work", status: "active" },
			],
		}, duplicate, NOW + 1);
		assert.notEqual(ambiguous.steps[0]?.id, duplicate.steps[0]?.id);
		assert.notEqual(ambiguous.steps[1]?.id, duplicate.steps[1]?.id);
		assert.equal(ambiguous.steps[2]?.id, duplicate.steps[2]?.id);

		const previous = snapshot();
		const changed = normalizeProcessUpdate({
			...runningInput(),
			steps: [
				{ text: "Apply safely", status: "active" },
				{ text: "Run checks", status: "pending" },
				{ text: "Inspect safely", status: "done" },
			],
		}, previous, NOW + 2);
		assert.notEqual(changed.steps[0]?.id, previous.steps[1]?.id);
		assert.equal(changed.steps[1]?.id, previous.steps[2]?.id);
		assert.notEqual(changed.steps[2]?.id, previous.steps[0]?.id);
	});

	it("rejects regressions for stable done steps and terminal completed tasks", () => {
		const previous = snapshot();
		assert.throws(() => normalizeProcessUpdate({
			...runningInput(),
			steps: [
				{ text: "Inspect current state", status: "active" },
				{ text: "Apply changes", status: "pending" },
				{ text: "Run checks", status: "pending" },
			],
		}, previous, NOW + 1), /done.*active/i);

		const completed = normalizeProcessUpdate({
			...runningInput(),
			status: "completed",
			steps: runningInput().steps.map((step) => ({ ...step, status: "done" as const })),
			verification: "All checks passed",
		}, previous, NOW + 2);
		assert.throws(() => normalizeProcessUpdate(runningInput(), completed, NOW + 3), /completed.*terminal/i);
	});

	it("allows failed steps to retry and then complete", () => {
		const failed = normalizeProcessUpdate({
			...runningInput(),
			status: "waiting",
			steps: runningInput().steps.map((step, index) => index === 1 ? { ...step, status: "failed" as const } : step),
			update: "Fix required",
		}, undefined, NOW);
		const retried = normalizeProcessUpdate(runningInput(), failed, NOW + 1);
		const completed = normalizeProcessUpdate({
			...runningInput(),
			status: "completed",
			steps: runningInput().steps.map((step) => ({ ...step, status: "done" as const })),
			verification: "All checks passed",
		}, retried, NOW + 2);
		assert.equal(retried.steps[1]?.id, failed.steps[1]?.id);
		assert.equal(completed.steps[1]?.id, failed.steps[1]?.id);
	});

	it("compares normalized facts without timestamps or internal IDs", () => {
		const first = snapshot();
		const same = normalizeProcessUpdate(runningInput(), first, NOW + 1);
		assert.equal(semanticProcessEqual(first, same), true);
		assert.equal(semanticProcessEqual(first, { ...same, update: "A real milestone" }), false);
		assert.equal(semanticProcessEqual(first, {
			...same,
			artifacts: [...same.artifacts, { kind: "test", label: "Checks" }],
		}), false);
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

describe("process telemetry", () => {
	it("preserves telemetry by stable identity and resets ambiguous steps", () => {
		const firstSnapshot = snapshot();
		let first = syncProcessTelemetry(undefined, undefined, firstSnapshot, NOW);
		first = recordAssistantUsage(first, firstSnapshot, {
			provider: "openai",
			model: "gpt-5.6-sol",
			usage: { input: 10, output: 5 },
		});
		const renamed = normalizeProcessUpdate({
			...runningInput(),
			steps: runningInput().steps.map((step, index) => index === 1 ? { ...step, text: "Apply safe changes" } : step),
		}, firstSnapshot, NOW + 1);
		const carried = syncProcessTelemetry(firstSnapshot, first, renamed, NOW + 1);
		assert.equal(carried.steps[1]?.turns, 1);
		assert.equal(carried.steps[1]?.id, renamed.steps[1]?.id);

		const reordered = normalizeProcessUpdate({
			...runningInput(),
			steps: [runningInput().steps[1]!, runningInput().steps[0]!, runningInput().steps[2]!],
		}, firstSnapshot, NOW + 2);
		const reorderedTelemetry = syncProcessTelemetry(firstSnapshot, first, reordered, NOW + 2);
		assert.equal(reorderedTelemetry.steps[0]?.turns, 1);
		assert.equal(reorderedTelemetry.steps[1]?.turns, 0);

		const inserted = normalizeProcessUpdate({
			...runningInput(),
			steps: [
				runningInput().steps[0]!,
				{ text: "Review changes", status: "pending" },
				runningInput().steps[1]!,
				runningInput().steps[2]!,
			],
		}, firstSnapshot, NOW + 3);
		const insertedTelemetry = syncProcessTelemetry(firstSnapshot, first, inserted, NOW + 3);
		assert.equal(insertedTelemetry.steps[1]?.turns, 0);
		assert.equal(insertedTelemetry.steps[2]?.turns, 1);

		const deleted = normalizeProcessUpdate({
			...runningInput(),
			steps: [runningInput().steps[0]!, runningInput().steps[1]!],
		}, firstSnapshot, NOW + 4);
		const deletedTelemetry = syncProcessTelemetry(firstSnapshot, first, deleted, NOW + 4);
		assert.equal(deletedTelemetry.steps[1]?.turns, 1);

		const ambiguousSnapshot = normalizeProcessUpdate({
			...runningInput(),
			steps: [
				{ text: "Apply safely", status: "active" },
				{ text: "Run checks", status: "pending" },
				{ text: "Inspect safely", status: "done" },
			],
		}, firstSnapshot, NOW + 2);
		const reset = syncProcessTelemetry(firstSnapshot, first, ambiguousSnapshot, NOW + 2);
		assert.equal(reset.steps[0]?.turns, 0);
		assert.equal(reset.steps[0]?.usage.input, 0);
	});

	it("tracks active step time across continuation, transitions, waiting, and resume", () => {
		const firstSnapshot = snapshot();
		const first = syncProcessTelemetry(undefined, undefined, firstSnapshot, NOW);
		assert.equal(first.steps[1].activeSince, NOW);

		const continued = syncProcessTelemetry(firstSnapshot, first, firstSnapshot, NOW + 5_000);
		assert.equal(continued.steps[1].activeSince, NOW);

		const nextSnapshot: ProcessSnapshot = {
			...firstSnapshot,
			steps: [
				{ text: "Inspect current state", status: "done" },
				{ text: "Apply changes", status: "done" },
				{ text: "Run checks", status: "active" },
			],
			updatedAt: NOW + 10_000,
		};
		const advanced = syncProcessTelemetry(firstSnapshot, continued, nextSnapshot, NOW + 10_000);
		assert.equal(advanced.steps[1].activeMs, 10_000);
		assert.equal(advanced.steps[1].activeSince, undefined);
		assert.equal(advanced.steps[2].activeSince, NOW + 10_000);

		const waitingSnapshot: ProcessSnapshot = { ...nextSnapshot, status: "waiting", updatedAt: NOW + 15_000 };
		const waiting = syncProcessTelemetry(nextSnapshot, advanced, waitingSnapshot, NOW + 15_000);
		assert.equal(waiting.steps[2].activeMs, 5_000);
		assert.equal(waiting.steps[2].activeSince, undefined);

		const resumedSnapshot = { ...nextSnapshot, updatedAt: NOW + 20_000 };
		const resumed = syncProcessTelemetry(waitingSnapshot, waiting, resumedSnapshot, NOW + 20_000);
		assert.equal(resumed.steps[2].activeMs, 5_000);
		assert.equal(resumed.steps[2].activeSince, NOW + 20_000);
		assert.equal(stepElapsedMs(resumed.steps[2], NOW + 23_000), 8_000);
	});

	it("attributes real assistant usage and models to the active step", () => {
		const currentSnapshot = snapshot();
		const initial = syncProcessTelemetry(undefined, undefined, currentSnapshot, NOW);
		const recorded = recordAssistantUsage(initial, currentSnapshot, {
			provider: "openai",
			model: "gpt-5.6-sol",
			usage: {
				input: 30_000,
				output: 1_500,
				cacheRead: 22_000,
				cacheWrite: 400,
				cost: { total: 0.25 },
			},
		});

		assert.equal(recorded.turns, 1);
		assert.deepEqual(recorded.models, ["openai/gpt-5.6-sol"]);
		assert.deepEqual(recorded.usage, {
			input: 30_000,
			output: 1_500,
			cacheRead: 22_000,
			cacheWrite: 400,
			cost: 0.25,
		});
		assert.equal(recorded.steps[1].turns, 1);
		assert.deepEqual(recorded.steps[1].models, ["openai/gpt-5.6-sol"]);
		assert.equal(recorded.steps[1].usage.output, 1_500);
	});

	it("carries pre-snapshot assistant usage into the first active task", () => {
		const pending = recordAssistantUsage(undefined, undefined, {
			provider: "openai",
			model: "gpt-5.6-sol",
			usage: {
				input: 8_000,
				output: 500,
				cacheRead: 6_000,
				cacheWrite: 0,
				cost: { total: 0.08 },
			},
		});
		const first = syncProcessTelemetry(undefined, pending, snapshot(), NOW);

		assert.equal(first.turns, 1);
		assert.equal(first.usage.input, 8_000);
		assert.equal(first.steps[1].turns, 1);
		assert.equal(first.steps[1].usage.output, 500);
		assert.deepEqual(first.steps[1].models, ["openai/gpt-5.6-sol"]);
	});
});

describe("branch state", () => {
	it("restores the last state from the current branch", () => {
		const first = createPersistedState(snapshot(), "compact");
		const latestSnapshot = { ...snapshot(), title: "Latest" };
		const telemetry = syncProcessTelemetry(undefined, undefined, latestSnapshot, NOW);
		const latest = createPersistedState(latestSnapshot, "full", telemetry);
		const restored = restoreProcessState([entry(first), { type: "message" }, entry(latest)]);
		assert.equal(restored.corrupted, false);
		assert.equal(restored.state.viewMode, "full");
		assert.equal(restored.state.snapshot?.title, "Latest");
		assert.equal(restored.state.telemetry?.steps[1]?.activeSince, NOW);
	});

	it("migrates legacy snapshots and telemetry without IDs", () => {
		const legacySnapshot = snapshot();
		const legacyTelemetry = syncProcessTelemetry(undefined, undefined, legacySnapshot, NOW);
		for (const step of legacySnapshot.steps) delete step.id;
		for (const step of legacyTelemetry.steps) delete step.id;
		const restored = restoreProcessState([entry({
			version: 1,
			viewMode: "compact",
			snapshot: legacySnapshot,
			telemetry: legacyTelemetry,
			cleared: false,
		})]);
		const ids = restored.state.snapshot?.steps.map((step) => step.id) ?? [];
		assert.equal(restored.corrupted, false);
		assert.equal(restored.migrated, true);
		assert.equal(new Set(ids).size, legacySnapshot.steps.length);
		assert.deepEqual(restored.state.telemetry?.steps.map((step) => step.id), ids);
	});

	it("uses the configured global default when the branch has no saved state", () => {
		const restored = restoreProcessState([], "off");
		assert.equal(restored.corrupted, false);
		assert.equal(restored.state.viewMode, "off");
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
