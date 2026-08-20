import assert from "node:assert/strict";
import test from "node:test";

import { boundArtifactState, createToolRenderController } from "../lib/compat/tool-render.ts";

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
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/app.ts" } },
						{ type: "toolCall", id: "edit-2", name: "edit", arguments: { path: "src/app.ts" } },
					],
				},
			},
			{ type: "custom", customType: "presentation-artifact-state-v2", data: firstState },
			{ type: "custom", customType: "presentation-artifact-state-v2", data: secondState },
		]);
		assert.deepEqual(controller.render(tool("edit-1"), 120, () => ["native first"]), []);
		assert.match(controller.render(tool("edit-2"), 120, () => ["native second"]).join("\n"), /Files 1 changed/);
	} finally {
		controller.dispose();
	}
});

test("an orphaned latest artifact revision does not resurrect an older anchor", () => {
	const controller = createToolRenderController({ isEnabled: () => true, getTheme: () => theme, now: () => 1_000 });
	const firstState = {
		version: 2 as const,
		receiptId: "receipt-old",
		requestId: "request-orphan",
		revision: 1,
		anchorToolCallId: "edit-old",
		files: [{ path: "old.ts", operation: "modified" as const, sources: ["edit"] }],
		successfulWrites: 1,
		failedWrites: 0,
		gitReconciled: true,
		startedAt: 1,
		revisedAt: 2,
	};
	try {
		hydrate(controller, [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "edit-old", name: "edit", arguments: { path: "old.ts" } }] },
			},
			{ type: "custom", customType: "presentation-artifact-state-v2", data: firstState },
			{ type: "custom", customType: "presentation-artifact-state-v2", data: {
				...firstState,
				receiptId: "receipt-latest",
				revision: 2,
				supersedes: "receipt-old",
				anchorToolCallId: "edit-missing",
				files: [{ path: "latest.ts", operation: "modified", sources: ["edit"] }],
				revisedAt: 3,
			} },
		]);
		const rendered = controller.render(historyTool("edit-old", "edit", { path: "old.ts" }, "request-orphan"), 120, () => ["native"]).join("\n");
		assert.doesNotMatch(rendered, /Files/);
	} finally {
		controller.dispose();
	}
});

test("hydration bounds oversized legacy receipts while retaining the full count", () => {
	const controller = createToolRenderController({ isEnabled: () => true, getTheme: () => theme, now: () => 1_000 });
	try {
		const legacy = {
			version: 2 as const, receiptId: "legacy-many", requestId: "request-many", revision: 1,
			anchorToolCallId: "edit-many",
			files: Array.from({ length: 105 }, (_, index) => ({ path: `file-${index}.txt`, operation: "added" as const, sources: ["git"] })),
			successfulWrites: 1, failedWrites: 0, gitReconciled: true, startedAt: 1, revisedAt: 2,
		};
		const bounded = boundArtifactState(legacy);
		assert.equal(bounded.files.length, 100);
		assert.equal(bounded.totalFiles, 105);
		const huge = boundArtifactState({
			...legacy,
			receiptId: "legacy-huge-row",
			files: [{ path: "x".repeat(100_000), operation: "added", sources: ["s".repeat(100_000)] }],
		});
		assert.ok(Buffer.byteLength(JSON.stringify(huge), "utf8") <= 64 * 1024);
		assert.ok((huge.files[0]?.path.length ?? 0) <= 240);
		assert.ok((huge.files[0]?.sources[0]?.length ?? 0) <= 40);
		const hugeMetadata = boundArtifactState({
			...legacy,
			receiptId: "r".repeat(100_000),
			requestId: "q".repeat(100_000),
			unknownMetadata: "u".repeat(100_000),
		} as typeof legacy);
		assert.ok(Buffer.byteLength(JSON.stringify(hugeMetadata), "utf8") <= 64 * 1024);
		assert.ok(hugeMetadata.receiptId.length <= 240);
		assert.ok(hugeMetadata.requestId.length <= 240);
		assert.equal(Object.hasOwn(hugeMetadata, "unknownMetadata"), false);
		hydrate(controller, [
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "edit-many", name: "edit", arguments: { path: "src/app.ts" } }] } },
			{ type: "custom", customType: "presentation-artifact-state-v2", data: legacy },
		]);
		const rendered = controller.render(historyTool("edit-many", "edit", { path: "src/app.ts" }, "request-many"), 120, () => ["native"]).join("\n");
		assert.match(rendered, /Files 105 changed/);
		assert.match(rendered, /\+103 more/);
	} finally {
		controller.dispose();
	}
});

test("OMP artifact anchor keeps the edit block, appends one net receipt, and expands native-only", () => {
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		isArtifactProjectionEnabled: () => true,
		getTheme: () => theme,
		now: () => 1_000,
	});
	try {
		const args = { path: "src/app.ts" };
		const result = {
			content: [{ type: "text", text: "Updated src/app.ts" }],
			details: { diff: "- old\n+ new" },
			isError: false,
		};
		controller.start({ toolCallId: "edit-omp", toolName: "edit", args, cwd: "/workspace/project", requestId: "request-omp", timestamp: 100 });
		controller.end({ toolCallId: "edit-omp", toolName: "edit", result, isError: false, timestamp: 500 });
		controller.setArtifact({
			version: 2,
			receiptId: "receipt-omp",
			requestId: "request-omp",
			revision: 1,
			anchorToolCallId: "edit-omp",
			files: [{ path: "src/app.ts", operation: "modified", additions: 1, deletions: 1, sources: ["edit"] }],
			successfulWrites: 1,
			failedWrites: 0,
			gitReconciled: true,
			startedAt: 1,
			revisedAt: 2,
		});
		const component = historyTool("edit-omp", "edit", args, "request-omp");
		component.result = result;
		const collapsed = controller.render(component, 120, () => ["native collapsed"]).join("\n");
		assert.match(collapsed, /╭/);
		assert.match(collapsed, /Edit: src\/app\.ts/);
		assert.match(collapsed, /- old/);
		assert.equal(collapsed.match(/Files 1 changed/g)?.length, 1);

		component.expanded = true;
		const expanded = controller.render(component, 120, () => ["native expanded"]).join("\n");
		assert.equal(expanded, "native expanded");
		assert.doesNotMatch(expanded, /Files 1 changed/);
	} finally {
		controller.dispose();
	}
});

test("OMP keeps expanded artifact anchors native-only when compact tools are disabled", () => {
	const controller = createToolRenderController({
		isEnabled: () => false,
		isOmpStyleEnabled: () => true,
		isArtifactProjectionEnabled: () => true,
		getTheme: () => theme,
		now: () => 1_000,
	});
	try {
		controller.setArtifact({
			version: 2,
			receiptId: "receipt-native-expanded",
			requestId: "request-native-expanded",
			revision: 1,
			anchorToolCallId: "edit-native-expanded",
			files: [{ path: "src/app.ts", operation: "modified", additions: 1, deletions: 1, sources: ["edit"] }],
			successfulWrites: 1,
			failedWrites: 0,
			gitReconciled: true,
			startedAt: 1,
			revisedAt: 2,
		});
		const component = historyTool("edit-native-expanded", "edit", { path: "src/app.ts" }, "request-native-expanded");
		const collapsed = controller.render(component, 100, () => ["native collapsed"]).join("\n");
		assert.match(collapsed, /native collapsed/);
		assert.equal(collapsed.match(/Files 1 changed/g)?.length, 1);

		component.expanded = true;
		assert.deepEqual(controller.render(component, 100, () => ["native expanded"]), ["native expanded"]);
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
