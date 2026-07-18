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
		snapshot: snapshot(),
		activity: {
			stage: "running_tools",
			activeTools: [
				{ callId: "1", toolName: "edit", label: "Bonus_Config.xlsx", startedAt: 1 },
				{ callId: "2", toolName: "bash", label: "bash", startedAt: 2 },
				{ callId: "3", toolName: "read", label: "revision.md", startedAt: 3 },
			],
		},
		...overrides,
	};
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
			activity: { stage: "analyzing", activeTools: [] },
		}, 80, plainTheme);
		assert.deepEqual(lines, ["● Analyzing request"]);
		assert.deepEqual(formatProcessLines({
			viewMode: "compact",
			activity: { stage: "settled", activeTools: [] },
		}, 80, plainTheme), []);
	});

	it("uses a wide rail, activity aggregation, and update", () => {
		const lines = formatProcessLines(state(), 120, plainTheme);
		assert.match(lines[0] ?? "", /Running.*1\/4.*Update reward configuration/);
		assert.match(lines[1] ?? "", /✓ Inspect naming.*● Apply changes.*○ Validate workbook/);
		assert.match(lines[2] ?? "", /edit Bonus_Config\.xlsx.*bash.*\+1 tool/);
		assert.match(lines[3] ?? "", /Update: Located the conflicting configuration/);
	});

	it("uses Current and Next in medium layouts", () => {
		const lines = formatProcessLines(state(), 80, plainTheme);
		assert.match(lines[1] ?? "", /Current: Apply changes.*Next: Validate workbook/);
		assert.match(lines[2] ?? "", /edit Bonus_Config\.xlsx/);
	});

	it("uses one stable line in narrow layouts", () => {
		const lines = formatProcessLines(state({
			activity: {
				stage: "running_tools",
				activeTools: [{ callId: "1", toolName: "edit", label: "a.ts", startedAt: 1 }],
			},
		}), 60, plainTheme);
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", /^● 1\/4 Apply changes/);
		assert.match(lines[0] ?? "", /edit a\.ts/);
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
		assert.match(narrowBlocked[0] ?? "", /Choose the target sheet/);

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
		assert.match(success, /✓ edit a\.ts/);

		const failure = formatProcessLines(state({
			activity: {
				stage: "analyzing_results",
				activeTools: [],
				recentOutcome: { toolName: "bash", label: "bash", isError: true, finishedAt: 1 },
			},
		}), 72, plainTheme).join("\n");
		assert.match(failure, /! bash/);
	});

	it("renders full mode with all steps and no more than nine lines", () => {
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
		assert.ok(lines.length <= 9);
		assert.equal(lines.filter((line) => /Inspect naming|Apply changes|Validate workbook|Summarize results/.test(line)).length, 4);
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
		const lines = formatToolResultLines({ content: [], details: completed }, true, false);
		assert.equal(lines.slice(1).filter((line) => line.startsWith("✓ ")).length, 4);
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
