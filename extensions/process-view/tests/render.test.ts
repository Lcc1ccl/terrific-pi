import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	formatProcessLines,
	formatToolResultLines,
	type ProcessTheme,
} from "../lib/render.ts";
import type { ProcessRenderState, ProcessSnapshot } from "../lib/types.ts";

const plainTheme: ProcessTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};
const NOW = 1_726_000_000_000;

function usage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0) {
	return { input, output, cacheRead, cacheWrite, cost };
}

function telemetry() {
	return {
		turns: 3,
		usage: usage(43_000, 2_400, 31_000, 500, 0.42),
		models: ["openai/gpt-5.6-sol"],
		steps: [
			{ text: "Inspect naming", activeMs: 12_000, turns: 1, usage: usage(12_000, 600, 9_000), models: ["openai/gpt-5.6-sol"] },
			{ text: "Apply changes", activeMs: 0, activeSince: NOW, turns: 2, usage: usage(31_000, 1_800, 22_000, 500, 0.42), models: ["openai/gpt-5.6-sol"] },
			{ text: "Validate workbook", activeMs: 0, turns: 0, usage: usage(), models: [] },
			{ text: "Summarize results", activeMs: 0, turns: 0, usage: usage(), models: [] },
		],
	};
}

function snapshot(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
	return {
		version: 1,
		title: "Update reward configuration",
		status: "running",
		steps: [
			{ text: "Inspect naming", status: "done" },
			{ text: "Apply changes", status: "active" },
			{ text: "Validate workbook", status: "pending" },
			{ text: "Summarize results", status: "pending" },
		],
		update: "Located the conflicting configuration",
		artifacts: [
			{ kind: "file", label: "Bonus_Config.xlsx", ref: "/secret/Bonus_Config.xlsx" },
			{ kind: "report", label: "revision.md" },
		],
		startedAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

function state(overrides: Partial<ProcessRenderState> = {}): ProcessRenderState {
	return {
		viewMode: "compact",
		activityMode: "full",
		snapshot: snapshot(),
		telemetry: telemetry(),
		expanded: false,
		now: NOW + 65_000,
		activity: {
			stage: "running_tools",
			activeTools: [
				{ callId: "1", toolName: "edit", label: "Bonus_Config.xlsx", startedAt: NOW + 61_000 },
				{ callId: "2", toolName: "bash", label: "bash", startedAt: NOW + 63_000 },
				{ callId: "3", toolName: "read", label: "revision.md", startedAt: NOW + 64_000 },
			],
		},
		...overrides,
	} as ProcessRenderState;
}

function assertFits(lines: string[], width: number): void {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
	}
}

describe("formatProcessLines", () => {
	it("never exceeds target widths or compact line limits", () => {
		for (const width of [40, 60, 72, 80, 100, 120]) {
			const lines = formatProcessLines(state(), width, plainTheme);
			assertFits(lines, width);
			assert.ok(lines.length <= 4, `${width} columns produced ${lines.length} lines`);
		}
	});

	it("renders a passive stage without inventing a structured plan", () => {
		const lines = formatProcessLines({
			viewMode: "compact",
			activityMode: "full",
			activity: { stage: "analyzing", activeTools: [] },
			expanded: false,
			now: NOW,
		}, 80, plainTheme);
		assert.deepEqual(lines, ["● Analyzing request"]);
		assert.deepEqual(formatProcessLines({
			viewMode: "compact",
			activityMode: "full",
			activity: { stage: "settled", activeTools: [] },
			expanded: false,
			now: NOW,
		}, 80, plainTheme), []);
	});

	it("suppresses duplicate activity according to activity mode", () => {
		const activity = {
			stage: "running_tools" as const,
			activeTools: [{ callId: "bash-1", toolName: "bash", label: "bash private command", startedAt: NOW }],
		};
		assert.deepEqual(formatProcessLines({
			viewMode: "compact",
			activityMode: "task",
			activity: { stage: "analyzing", activeTools: [] },
			expanded: false,
			now: NOW,
		}, 80, plainTheme), []);

		const taskCollapsed = formatProcessLines(state({ activityMode: "task", activity }), 100, plainTheme).join("\n");
		assert.doesNotMatch(taskCollapsed, /bash private command/);
		const taskExpanded = formatProcessLines(state({ activityMode: "task", activity, expanded: true }), 100, plainTheme).join("\n");
		assert.match(taskExpanded, /Active: bash private command/);

		const offExpanded = formatProcessLines(state({ activityMode: "off", activity, expanded: true }), 100, plainTheme).join("\n");
		assert.doesNotMatch(offExpanded, /bash private command/);
	});

	it("puts the goal, task progress, current task, and elapsed time on the first compact line", () => {
		const lines = formatProcessLines(state(), 120, plainTheme);
		assert.match(lines[0] ?? "", /Update reward configuration.*1\/4.*Apply changes.*1m05s/);
		assert.doesNotMatch(lines.join("\n"), /✓ Inspect naming.*○ Validate workbook/);
		assert.match(lines[1] ?? "", /Running 3 tools/);
		assert.doesNotMatch(lines[1] ?? "", /Bonus_Config\.xlsx|\bbash\b/);
		assert.match(lines[2] ?? "", /Update: Located the conflicting configuration/);
	});

	it("keeps progress and elapsed time visible in narrow compact layouts", () => {
		const lines = formatProcessLines(state({
			activity: {
				stage: "running_tools",
				activeTools: [{ callId: "1", toolName: "edit", label: "a.ts", startedAt: NOW + 64_000 }],
			},
		}), 60, plainTheme);
		assert.ok(lines.length <= 2);
		assert.match(lines[0] ?? "", /1\/4/);
		assert.match(lines[0] ?? "", /1m05s/);
		assertFits(lines, 60);
	});

	it("uses native tool expansion for a responsive live task and runtime panel", () => {
		for (const width of [1, 2, 3, 8, 20, 40, 60, 72, 80, 100, 120]) {
			const responsive = formatProcessLines(state({ expanded: true } as Partial<ProcessRenderState>), width, plainTheme);
			assertFits(responsive, width);
			assert.ok(responsive.length <= 15);
		}
		const lines = formatProcessLines(state({ expanded: true } as Partial<ProcessRenderState>), 110, plainTheme);
		assertFits(lines, 110);
		assert.ok(lines.length <= 15);
		assert.match(lines.join("\n"), /Process View.*Running.*1\/4/);
		assert.doesNotMatch(lines.join("\n"), /\d+%/);
		assert.match(lines.join("\n"), /Time: total 1m17s · current 1m05s/);
		assert.match(lines.join("\n"), /Current: Apply changes/);
		assert.doesNotMatch(lines.join("\n"), /Current: Apply changes ·/);
		assert.match(lines.join("\n"), /Tasks/);
		assert.match(lines.join("\n"), /Runtime/);
		assert.match(lines.join("\n"), /openai\/gpt-5\.6-sol/);
		assert.match(lines.join("\n"), /↑43k.*↓2\.4k.*R31k/);
		assert.match(lines.join("\n"), /Inspect naming.*12s/);
		assert.match(lines.join("\n"), /Apply changes.*1m05s/);
		assert.doesNotMatch(lines.join("\n"), /\btok\b|\d+t\b|LLM turns/);
	});

	it("keeps step elapsed time visible with a long model identifier", () => {
		const model = `provider/${"model-".repeat(30)}`;
		const base = telemetry();
		const longModelTelemetry = {
			...base,
			models: [model],
			steps: base.steps.map((step) => ({ ...step, models: step.models.length > 0 ? [model] : [] })),
		};
		const lines = formatProcessLines(state({ expanded: true, telemetry: longModelTelemetry }), 100, plainTheme);
		const joined = lines.join("\n");
		assert.match(joined, /Time: total .* · current 1m05s/);
		assert.match(joined, /● Apply changes[\s\S]*1m05s/);
	});

	it("prioritizes blocked and interrupted reasons", () => {
		const blocked = formatProcessLines(state({
			snapshot: snapshot({ status: "blocked", blocker: "Choose the target sheet" }),
			activity: { stage: "settled", activeTools: [] },
		}), 80, plainTheme);
		assert.match(blocked.join("\n"), /! Blocked/);
		assert.match(blocked.join("\n"), /Need: Choose the target sheet/);
		const narrowBlocked = formatProcessLines(state({
			snapshot: snapshot({ status: "blocked", blocker: "Choose the target sheet" }),
			activity: { stage: "settled", activeTools: [] },
		}), 60, plainTheme);
		assert.match(narrowBlocked.join("\n"), /Choose the target sheet/);

		const interrupted = formatProcessLines(state({
			snapshot: snapshot({ status: "interrupted", update: "Run stopped after an error" }),
			activity: { stage: "settled", activeTools: [] },
		}), 80, plainTheme);
		assert.match(interrupted.join("\n"), /! Interrupted/);
		assert.match(interrupted.join("\n"), /Update: Run stopped after an error/);
	});

	it("shows recent success or failure when no tool remains active", () => {
		const success = formatProcessLines(state({
			activity: {
				stage: "analyzing_results",
				activeTools: [],
				recentOutcome: { toolName: "edit", label: "a.ts", isError: false, finishedAt: 1 },
			},
		}), 100, plainTheme).join("\n");
		assert.match(success, /Latest tool finished/);

		const failure = formatProcessLines(state({
			activity: {
				stage: "analyzing_results",
				activeTools: [],
				recentOutcome: { toolName: "bash", label: "bash", isError: true, finishedAt: 1 },
			},
		}), 72, plainTheme).join("\n");
		assert.match(failure, /Latest tool failed/);
	});

	it("pins the detail panel in full mode", () => {
		const lines = formatProcessLines(state({
			viewMode: "full",
			snapshot: snapshot({
				status: "completed",
				steps: snapshot().steps.map((step) => ({ ...step, status: "done" })),
				verification: "Workbook checks passed",
			}),
			activity: { stage: "settled", activeTools: [] },
		}), 100, plainTheme);
		assertFits(lines, 100);
		assert.ok(lines.length <= 15);
		for (const text of ["Inspect naming", "Apply changes", "Validate workbook", "Summarize results"]) {
			assert.match(lines.join("\n"), new RegExp(text));
		}
		assert.match(lines.join("\n"), /Process View/);
		assert.match(lines.join("\n"), /Verification: Workbook checks passed/);
	});

	it("hides all output in off mode", () => {
		assert.deepEqual(formatProcessLines(state({ viewMode: "off" }), 100, plainTheme), []);
	});
});

describe("formatToolResultLines", () => {
	it("renders a one-line running or completed receipt", () => {
		assert.deepEqual(formatToolResultLines({ content: [], details: snapshot() }, false, false), [
			"Process 1/4 · Apply changes",
		]);
		const completed = snapshot({
			status: "completed",
			steps: snapshot().steps.map((step) => ({ ...step, status: "done" })),
			update: "Workbook updated and verified",
		});
		assert.deepEqual(formatToolResultLines({ content: [], details: completed }, false, false), [
			"Process done 4/4 · Workbook updated and verified · 2 artifacts",
		]);
	});

	it("expands normalized details without exposing artifact refs", () => {
		const completed = snapshot({
			status: "completed",
			steps: snapshot().steps.map((step) => ({ ...step, status: "done" })),
			verification: "Workbook checks passed",
		});
		const archivedTelemetry = telemetry();
		archivedTelemetry.steps[1]!.activeMs = 65_000;
		delete archivedTelemetry.steps[1]!.activeSince;
		const lines = formatToolResultLines({
			content: [],
			details: { ...completed, telemetry: archivedTelemetry },
		}, true, false);
		assert.equal(lines.slice(1).filter((line) => line.startsWith("✓ ")).length, 4);
		assert.match(lines.join("\n"), /Apply changes.*1m05s/);
		assert.match(lines.join("\n"), /Runtime: openai\/gpt-5\.6-sol.*3 turns.*↑43k.*↓2\.4k/);
		assert.match(lines.join("\n"), /Verification: Workbook checks passed/);
		assert.match(lines.join("\n"), /Artifacts: Bonus_Config\.xlsx · revision\.md/);
		assert.doesNotMatch(lines.join("\n"), /\/secret\//);
	});

	it("falls back to sanitized result content for errors or missing details", () => {
		assert.deepEqual(formatToolResultLines({
			content: [{ type: "text", text: "\u001b[31mInvalid update\r\nretry\u001b[0m" }],
		}, false, true), ["Invalid update retry"]);
		assert.deepEqual(formatToolResultLines({
			content: [{ type: "text", text: "\u001b[0m" }],
		}, false, true), ["Process update failed"]);
		assert.deepEqual(formatToolResultLines({ content: [] }, false, false), ["Process update finished"]);
	});
});
