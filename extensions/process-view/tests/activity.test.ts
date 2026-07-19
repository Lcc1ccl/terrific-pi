import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { ActivityTracker, safeActivityLabel } from "../lib/activity.ts";

const CWD = "/workspace/project";
const NOW = 1_726_000_000_000;

describe("ActivityTracker", () => {
	it("tracks parallel tools by call id and finishes them in any order", () => {
		const tracker = new ActivityTracker();
		tracker.beginRequest();
		tracker.startTool("read-1", "read", { path: "src/a.ts" }, CWD, NOW);
		tracker.startTool("edit-1", "edit", { path: "src/b.ts" }, CWD, NOW + 1);
		tracker.startTool("bash-1", "bash", { command: "echo secret" }, CWD, NOW + 2);

		assert.equal(tracker.getSnapshot().stage, "running_tools");
		assert.deepEqual(tracker.getSnapshot().activeTools.map((tool) => tool.callId), ["read-1", "edit-1", "bash-1"]);

		tracker.endTool("edit-1", "edit", false, NOW + 10);
		assert.equal(tracker.getSnapshot().activeTools.length, 2);
		tracker.endTool("read-1", "read", false, NOW + 11);
		tracker.endTool("bash-1", "bash", true, NOW + 12);

		const finished = tracker.getSnapshot();
		assert.equal(finished.stage, "analyzing_results");
		assert.deepEqual(finished.activeTools, []);
		assert.deepEqual(finished.recentOutcome, {
			toolName: "bash",
			label: "bash",
			isError: true,
			finishedAt: NOW + 12,
		});
	});

	it("overwrites duplicate starts and ignores unknown or duplicate ends", () => {
		const tracker = new ActivityTracker();
		tracker.startTool("same", "read", { path: "old.ts" }, CWD, NOW);
		tracker.startTool("same", "read", { path: "new.ts" }, CWD, NOW + 1);
		assert.equal(tracker.getSnapshot().activeTools.length, 1);
		assert.equal(tracker.getSnapshot().activeTools[0]?.label, "new.ts");

		tracker.endTool("unknown", "bash", true, NOW + 2);
		assert.equal(tracker.getSnapshot().recentOutcome, undefined);
		tracker.endTool("same", "read", false, NOW + 3);
		const outcome = tracker.getSnapshot().recentOutcome;
		tracker.endTool("same", "read", true, NOW + 4);
		assert.deepEqual(tracker.getSnapshot().recentOutcome, outcome);
	});

	it("excludes process_update while still advancing after its result", () => {
		const tracker = new ActivityTracker();
		tracker.beginRequest();
		tracker.startTool("meta", "process_update", { title: "secret" }, CWD, NOW);
		assert.deepEqual(tracker.getSnapshot().activeTools, []);
		assert.equal(tracker.getSnapshot().stage, "starting");

		tracker.endTool("meta", "process_update", false, NOW + 1);
		assert.equal(tracker.getSnapshot().stage, "analyzing_results");
		assert.equal(tracker.getSnapshot().recentOutcome, undefined);
	});

	it("maps assistant stream event types without inspecting delta text", () => {
		const tracker = new ActivityTracker();
		tracker.handleAssistantEvent("thinking_delta");
		assert.equal(tracker.getSnapshot().stage, "analyzing");
		tracker.handleAssistantEvent("toolcall_delta");
		assert.equal(tracker.getSnapshot().stage, "preparing_tools");
		tracker.handleAssistantEvent("text_delta");
		assert.equal(tracker.getSnapshot().stage, "drafting");
		tracker.handleAssistantEvent("unknown_secret_delta");
		assert.equal(tracker.getSnapshot().stage, "drafting");
	});

	it("keeps active tools authoritative over assistant stream events", () => {
		const tracker = new ActivityTracker();
		tracker.startTool("read-1", "read", { path: "a.ts" }, CWD, NOW);
		tracker.handleAssistantEvent("text_delta");
		assert.equal(tracker.getSnapshot().stage, "running_tools");
	});

	it("promotes aux tool labels with model from streaming details", () => {
		const tracker = new ActivityTracker();
		tracker.startTool("research-1", "web_research", { question: "q" }, CWD, NOW);
		assert.equal(tracker.updateTool("research-1", "web_research", {
			details: { status: "running", model: "grok/grok-4.5" },
		}), true);
		assert.equal(tracker.getSnapshot().activeTools[0]?.label, "web_research · grok/grok-4.5");
		assert.equal(tracker.updateTool("research-1", "web_research", {
			details: { status: "running", model: "grok/grok-4.5" },
		}), false);
		assert.equal(tracker.updateTool("research-1", "web_research", {
			details: { status: "running" },
		}), false);
	});

	it("clears runtime activity at request/tree boundaries and can preserve a settled outcome", () => {
		const tracker = new ActivityTracker();
		tracker.startTool("read-1", "read", { path: "a.ts" }, CWD, NOW);
		tracker.endTool("read-1", "read", false, NOW + 1);
		tracker.settle(true);
		assert.equal(tracker.getSnapshot().stage, "settled");
		assert.equal(tracker.getSnapshot().recentOutcome?.toolName, "read");
		tracker.beginRequest();
		assert.deepEqual(tracker.getSnapshot(), { stage: "starting", activeTools: [] });
		tracker.reset();
		assert.deepEqual(tracker.getSnapshot(), { stage: "settled", activeTools: [] });
	});
});

describe("safeActivityLabel", () => {
	it("shows workspace-relative paths and only basenames outside the workspace", () => {
		assert.equal(safeActivityLabel("read", { path: "/workspace/project/src/config.ts" }, CWD), "src/config.ts");
		assert.equal(safeActivityLabel("edit", { path: "/workspace/private/token.env" }, CWD), "token.env");
		assert.equal(safeActivityLabel("write", { path: "notes/report.md" }, CWD), "notes/report.md");
	});

	it("never exposes bash commands or unknown tool arguments", () => {
		const command = "curl https://example.test/?token=secret";
		assert.equal(safeActivityLabel("bash", { command }, CWD), "bash");
		assert.equal(safeActivityLabel("deploy", { token: "secret", command }, CWD), "deploy");
		assert.doesNotMatch(safeActivityLabel("deploy", { token: "secret", command }, CWD), /secret|token|curl/);
	});

	it("sanitizes control sequences and caps labels at 80 visible columns", () => {
		const label = safeActivityLabel("read", { path: `src/\u001b[31m${"x".repeat(100)}\r\n.ts` }, CWD);
		assert.doesNotMatch(label, /\u001b|\r|\n/);
		assert.ok(visibleWidth(label) <= 80);
	});
});
