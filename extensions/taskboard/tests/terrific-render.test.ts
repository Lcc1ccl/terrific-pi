import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { formatTaskboardLines, formatToolResultLines, type ProcessTheme } from "../lib/render.ts";
import type { ProcessSnapshot, TaskboardRenderState } from "../lib/types.ts";

const plainTheme: ProcessTheme = { fg: (_color, text) => text, bold: (text) => text };
const toneTheme: ProcessTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => text,
};
const NOW = 1_726_000_000_000;
const usage = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0) =>
	({ input, output, cacheRead, cacheWrite, cost });

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

function state(overrides: Partial<TaskboardRenderState> = {}): TaskboardRenderState {
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
	} as TaskboardRenderState;
}

function assertFits(lines: string[], width: number): void {
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("Terrific Taskboard renderer", () => {
	it("keeps the inactive renderer byte-for-byte at the explicit baseline", () => {
		assert.deepEqual(formatTaskboardLines(state(), 120, plainTheme), [
			"● Update reward configuration · 1/4 · Now: Apply changes · 1m05s",
			"  ↳ Running 3 tools",
			"  Update: Located the conflicting configuration",
		]);
		assert.deepEqual(formatTaskboardLines(state({ expanded: true }), 120, plainTheme), [
			"╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮",
			"│ Taskboard · Running · 1/4 · Update reward configuration                                                              │",
			"│ Time: total 1m17s · current 1m05s                                                                                    │",
			"│ Current: Apply changes                                                                                               │",
			"├─ Tasks ──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤",
			"│ ✓ Inspect naming                                                       openai/gpt-5.6-sol · 1 turns · ↑12k ↓600 · 12s│",
			"│ ● Apply changes                                                     openai/gpt-5.6-sol · 2 turns · ↑31k ↓1.8k · 1m05s│",
			"│ ○ Validate workbook                                                                                                 —│",
			"│ ○ Summarize results                                                                                                 —│",
			"├─ Runtime ────────────────────────────────────────────────────────────────────────────────────────────────────────────┤",
			"│ Runtime: openai/gpt-5.6-sol · 3 turns · ↑43k ↓2.4k · R31k W500 · $0.420                                              │",
			"│ Active: edit Bonus_Config.xlsx 4s · bash 2s · +1 tool                                                                │",
			"│ Update: Located the conflicting configuration                                                                        │",
			"╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯",
		]);
	});

	it("renders all active statuses with a glyph, literal text, and distinct tone", () => {
		const cases = [
			["running", "● Running", "accent"],
			["waiting", "◷ Waiting", "muted"],
			["blocked", "! Blocked", "error"],
			["completed", "✓ Completed", "success"],
			["interrupted", "× Interrupted", "warning"],
		] as const;
		for (const [status, marker, tone] of cases) {
			const process = snapshot({
				status,
				...(status === "blocked" ? { blocker: "Choose the target sheet" } : {}),
				...(status === "completed" ? {
					steps: snapshot().steps.map((step) => ({ ...step, status: "done" as const })),
					verification: "Workbook checks passed",
				} : {}),
			});
			const output = formatTaskboardLines(state({ snapshot: process }), 120, toneTheme, {
				variant: "terrific",
				terminalRows: 24,
			}).join("\n");
			assert.match(output, new RegExp(`<${tone}>${escapeRegExp(marker)}`));
		}
	});

	it("uses preferred and TERM=dumb step glyphs without changing tool receipts", () => {
		const preferred = formatTaskboardLines(state({ expanded: true }), 120, plainTheme, {
			variant: "terrific",
			terminalRows: 24,
		}).join("\n");
		for (const marker of ["✓ Inspect naming", "▶ Apply changes", "□ Validate workbook"]) {
			assert.match(preferred, new RegExp(escapeRegExp(marker)));
		}
		assert.match(preferred, /Update: Located the conflicting configuration/);
		assert.match(preferred, /Artifacts: Bonus_Config\.xlsx · revision\.md/);
		const failedState = state({
			expanded: true,
			snapshot: snapshot({
				status: "waiting",
				steps: snapshot().steps.map((step, index) => index === 1 ? { ...step, status: "failed" } : step),
			}),
		});
		const ascii = formatTaskboardLines(failedState, 120, plainTheme, {
			variant: "terrific",
			ascii: true,
			terminalRows: 24,
		}).join("\n");
		for (const marker of ["+ Inspect naming", "x Apply changes", "[ ] Validate workbook"]) {
			assert.match(ascii, new RegExp(escapeRegExp(marker)));
		}
		assert.deepEqual(formatToolResultLines({ content: [], details: snapshot() }, false, false), [
			"Taskboard 1/4 · Apply changes",
		]);
	});

	it("bounds every active state across the width-height matrix and remains ANSI/CJK safe", () => {
		const caps = new Map([[16, 10], [20, 12], [24, 15]]);
		for (const status of ["running", "waiting", "blocked", "completed", "interrupted"] as const) {
			for (const width of [40, 80, 120, 160]) {
				for (const terminalRows of [16, 20, 24]) {
					const process = snapshot({
						title: "修复\u001b[31m奖励配置\u001b[0m é",
						status,
						...(status === "blocked" ? { blocker: "需要选择工作表" } : {}),
						...(status === "completed" ? {
							steps: snapshot().steps.map((step) => ({ ...step, status: "done" as const })),
							verification: "验证通过",
						} : {}),
					});
					for (const telemetryValue of [telemetry(), undefined]) {
						const lines = formatTaskboardLines(
							state({ snapshot: process, telemetry: telemetryValue, expanded: true }),
							width,
							plainTheme,
							{ variant: "terrific", terminalRows },
						);
						assertFits(lines, width);
						assert.ok(lines.length <= caps.get(terminalRows)!, `${width}x${terminalRows}: ${lines.length}`);
						assert.match(lines[0] ?? "", /^╭/);
						assert.match(lines.at(-1) ?? "", /╯$/);
						assert.match(lines.join("\n"), /Tasks/);
						assert.match(lines.join("\n"), /Runtime/);

						const compact = formatTaskboardLines(
							state({ snapshot: process, telemetry: telemetryValue, expanded: false }),
							width,
							plainTheme,
							{ variant: "terrific", terminalRows },
						);
						assertFits(compact, width);
						assert.ok(compact.length <= (width < 72 ? 2 : 3));
						assert.match(compact.join("\n"), new RegExp(status === "completed" ? "Completed" : `${status[0]!.toUpperCase()}${status.slice(1)}`));
						assert.match(compact.join("\n"), /1\/4|4\/4/);
						assert.match(compact.join("\n"), /Apply|Summarize/);
					}
				}
			}
		}
	});

	it("prioritizes current, blocker, and failed steps under the lowest height budget", () => {
		const process = snapshot({
			status: "blocked",
			steps: [
				{ text: "Ordinary completed", status: "done" },
				{ text: "Failed validation", status: "failed" },
				{ text: "Current decision", status: "active" },
				{ text: "Ordinary pending one", status: "pending" },
				{ text: "Ordinary pending two", status: "pending" },
			],
			blocker: "Choose the target sheet",
		});
		const output = formatTaskboardLines(state({ snapshot: process, expanded: true }), 80, plainTheme, {
			variant: "terrific",
			terminalRows: 16,
		}).join("\n");
		assert.match(output, /Current decision/);
		assert.match(output, /Failed validation/);
		assert.match(output, /Need: Choose the target sheet/);
		assert.doesNotMatch(output, /Ordinary pending two/);
	});
});
