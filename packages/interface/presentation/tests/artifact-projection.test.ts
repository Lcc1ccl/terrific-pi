import assert from "node:assert/strict";
import test from "node:test";

import { createToolRenderController } from "../lib/compat/tool-render.ts";

const theme = {
	fg(_color: string, text: string) { return text; },
	bold(text: string) { return text; },
};

function tool(id: string, requestId = "request-1") {
	return historyTool(id, "edit", { path: "src/app.ts" }, requestId);
}

function historyTool(id: string, name: string, args: Record<string, unknown>, requestId = "request-1") {
	return {
		toolCallId: id,
		toolName: name,
		args,
		cwd: "/workspace/project",
		executionStarted: true,
		isPartial: false,
		result: { content: [{ type: "text", text: "done" }], isError: false },
		expanded: false,
		ui: { requestRender() {} },
		requestId,
	};
}

function hydrate(controller: ReturnType<typeof createToolRenderController>, branch: unknown[]): void {
	controller.hydrate(branch, "/workspace/project");
}

test("branch hydration restores one exploration episode without starting live timers", () => {
	const controller = createToolRenderController({ isEnabled: () => true, getTheme: () => theme, now: () => 1_000 });
	try {
		hydrate(controller, [{
			type: "message",
			timestamp: "2026-07-22T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/app.ts" } },
					{ type: "toolCall", id: "grep-1", name: "grep", arguments: { path: "src", pattern: "render" } },
				],
			},
		}, {
			type: "message",
			message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [], isError: false },
		}, {
			type: "message",
			message: { role: "toolResult", toolCallId: "grep-1", toolName: "grep", content: [], isError: false },
		}]);
		const read = historyTool("read-1", "read", { path: "src/app.ts" });
		const grep = historyTool("grep-1", "grep", { path: "src", pattern: "render" });
		assert.deepEqual(controller.render(read, 120, () => ["native read"]), []);
		assert.match(controller.render(grep, 120, () => ["native grep"]).join("\n"), /Explored · read 1 file · searched 1 pattern/);
	} finally {
		controller.dispose();
	}
});

test("branch hydration suppresses superseded artifact anchors after resume", () => {
	const controller = createToolRenderController({ isEnabled: () => true, getTheme: () => theme, now: () => 1_000 });
	const firstState = {
		version: 2 as const,
		receiptId: "receipt-1",
		requestId: "request-1",
		revision: 1,
		anchorToolCallId: "edit-1",
		files: [{ path: "src/app.ts", operation: "modified" as const, sources: ["edit"] }],
		successfulWrites: 1,
		failedWrites: 0,
		gitReconciled: true,
		startedAt: 1,
		revisedAt: 2,
	};
	const secondState = {
		...firstState,
		receiptId: "receipt-2",
		revision: 2,
		supersedes: "receipt-1",
		anchorToolCallId: "edit-2",
		revisedAt: 3,
	};
	try {
		hydrate(controller, [
			{ type: "custom", customType: "presentation-artifact-state-v2", data: firstState },
			{ type: "custom", customType: "presentation-artifact-state-v2", data: secondState },
		]);
		assert.deepEqual(controller.render(tool("edit-1"), 120, () => ["native first"]), []);
		assert.match(controller.render(tool("edit-2"), 120, () => ["native second"]).join("\n"), /Files 1 changed/);
	} finally {
		controller.dispose();
	}
});

test("artifact revisions project only the latest request snapshot onto its anchor tool", () => {
	const controller = createToolRenderController({ isEnabled: () => true, getTheme: () => theme, now: () => 1_000 });
	try {
		controller.start?.({ toolCallId: "edit-1", toolName: "edit", args: { path: "src/app.ts" }, cwd: "/workspace/project", requestId: "request-1" });
		controller.start?.({ toolCallId: "edit-2", toolName: "edit", args: { path: "src/app.ts" }, cwd: "/workspace/project", requestId: "request-1" });
		const first = tool("edit-1");
		const second = tool("edit-2");

		controller.setArtifact?.({
			version: 2,
			receiptId: "receipt-1",
			requestId: "request-1",
			revision: 1,
			anchorToolCallId: "edit-1",
			files: [{ path: "src/app.ts", operation: "modified", additions: 1, deletions: 1, sources: ["edit"] }],
			successfulWrites: 1,
			failedWrites: 0,
			gitReconciled: true,
			startedAt: 1,
			revisedAt: 2,
		});
		assert.match(controller.render(first, 120, () => ["native first"]).join("\n"), /Files 1 changed.*src\/app\.ts/);

		controller.setArtifact?.({
			version: 2,
			receiptId: "receipt-2",
			requestId: "request-1",
			revision: 2,
			supersedes: "receipt-1",
			anchorToolCallId: "edit-2",
			files: [{ path: "src/app.ts", operation: "modified", additions: 2, deletions: 1, sources: ["edit", "write"] }],
			successfulWrites: 2,
			failedWrites: 0,
			gitReconciled: true,
			startedAt: 1,
			revisedAt: 3,
		});
		assert.deepEqual(controller.render(first, 120, () => ["native first"]), []);
		assert.match(controller.render(second, 120, () => ["native second"]).join("\n"), /Files 1 changed.*\+2.*-1/);

		second.expanded = true;
		const expanded = controller.render(second, 120, () => ["native expanded"]);
		assert.match(expanded.join("\n"), /native expanded/);
		assert.match(expanded.join("\n"), /M src\/app\.ts.*\+2.*-1/);
	} finally {
		controller.dispose();
	}
});
