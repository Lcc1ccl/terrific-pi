import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { createToolRenderController } from "../lib/compat/tool-render.ts";

const theme = {
	fg(color: string, text: string) { return `<${color}>${text}</${color}>`; },
	bold(text: string) { return text; },
};

function instance(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
	result?: { content: Array<{ type: string; text: string }>; details?: unknown; isError: boolean },
) {
	return {
		toolCallId,
		toolName,
		args,
		cwd: "/workspace/project",
		executionStarted: true,
		isPartial: result === undefined,
		result,
		expanded: false,
		ui: { requestRender() {} },
	};
}

test("exploration episodes use one representative and settle by wall-clock span", () => {
	let now = 100;
	const controller = createToolRenderController({ isEnabled: () => true, getTheme: () => theme, now: () => now });
	try {
		controller.start?.({ toolCallId: "read-1", toolName: "read", args: { path: "src/a.ts" }, cwd: "/workspace/project", timestamp: 100 });
		controller.start?.({ toolCallId: "grep-1", toolName: "grep", args: { pattern: "render", path: "src" }, cwd: "/workspace/project", timestamp: 120 });

		const read = instance("read-1", "read", { path: "src/a.ts" });
		const grep = instance("grep-1", "grep", { pattern: "render", path: "src" });
		assert.deepEqual(controller.render(read, 100, () => ["native read"]), []);
		assert.match(controller.render(grep, 100, () => ["native grep"]).join("\n"), /Exploring · search src · \+1/);

		now = 300;
		controller.end?.({ toolCallId: "grep-1", toolName: "grep", result: { content: [{ type: "text", text: "match" }] }, isError: false, timestamp: 300 });
		Object.assign(grep, { isPartial: false, result: { content: [{ type: "text", text: "match" }], isError: false } });
		assert.match(controller.render(grep, 100, () => ["native grep"]).join("\n"), /Exploring/);

		now = 500;
		controller.end?.({ toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "file" }] }, isError: false, timestamp: 500 });
		Object.assign(read, { isPartial: false, result: { content: [{ type: "text", text: "file" }], isError: false } });
		const settled = controller.render(grep, 100, () => ["native grep"]).join("\n");
		assert.match(settled, /Explored · read 1 file · searched 1 pattern · 400ms/);
		assert.match(settled, /<success>/);
	} finally {
		controller.dispose();
	}
});

test("exact registered Skill reads retain their loading and loaded identity", () => {
	let now = 100;
	const controller = createToolRenderController({
		isEnabled: () => true,
		getTheme: () => theme,
		now: () => now,
		resolveSkillName: (args) => (args as { path?: string }).path === "/skills/release/SKILL.md" ? "release-notes" : undefined,
	});
	try {
		controller.start({ toolCallId: "skill-1", toolName: "read", args: { path: "/skills/release/SKILL.md" }, cwd: "/workspace/project", timestamp: now, skillName: "release-notes" });
		const read = instance("skill-1", "read", { path: "/skills/release/SKILL.md" });
		assert.match(controller.render(read, 100, () => ["native read"]).join("\n"), /Skill\(release-notes\) · loading/);
		now = 300;
		controller.end({ toolCallId: "skill-1", toolName: "read", result: { content: [] }, isError: false, timestamp: now });
		Object.assign(read, { isPartial: false, result: { content: [], isError: false } });
		assert.match(controller.render(read, 100, () => ["native read"]).join("\n"), /Skill\(release-notes\) · loaded/);
	} finally {
		controller.dispose();
	}
});

test("file receipts remain attached to native rows when compact summaries are disabled", () => {
	const controller = createToolRenderController({
		isEnabled: () => false,
		isArtifactProjectionEnabled: () => true,
		getTheme: () => theme,
		now: () => 1_000,
	});
	try {
		controller.setArtifact({
			version: 2,
			receiptId: "receipt-1",
			requestId: "request-1",
			revision: 1,
			anchorToolCallId: "edit-1",
			files: [{ path: "src/app.ts", operation: "modified", sources: ["edit"] }],
			successfulWrites: 1,
			failedWrites: 0,
			gitReconciled: false,
			startedAt: 1,
			revisedAt: 2,
		});
		const edit = instance("edit-1", "edit", { path: "src/app.ts" }, { content: [], isError: false });
		const output = controller.render(edit, 100, () => ["native edit"]).join("\n");
		assert.match(output, /native edit/);
		assert.match(output, /Files 1 changed/);
		assert.match(output, /src\/app\.ts/);
	} finally {
		controller.dispose();
	}
});

test("failed compact rows redact credential URLs and absolute paths before truncation", () => {
	const controller = createToolRenderController({
		isEnabled: () => true,
		getTheme: () => ({
			fg(_color: string, text: string) { return text; },
			bold(text: string) { return text; },
		}),
		now: () => 1_000,
	});
	try {
		const read = instance(
			"read-error",
			"read",
			{ path: "/workspace/project/src/missing.ts" },
			{
				content: [{
					type: "text",
					text: "ENOENT: request https://alice:hunter2@example.invalid/private failed for '/home/alice/private/project/secret.txt' token=credential-value",
				}],
				isError: true,
			},
		);
		for (const width of [80, 120, 160]) {
			const lines = controller.render(read, width, () => ["native read"]);
			const output = lines.join("\n");
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(output, /Read · failed · ENOENT/);
			assert.doesNotMatch(output, /alice|hunter2|credential-value|\/home\//);
			assert.doesNotMatch(output, /to expand/);
		}

		const windows = instance("windows-error", "read", {}, {
			content: [{ type: "text", text: String.raw`ENOENT: C:\Users\Alice Smith\private\secret.txt` }],
			isError: true,
		});
		const windowsOutput = controller.render(windows, 160, () => ["native read"]).join("\n");
		assert.match(windowsOutput, /secret\.txt/);
		assert.doesNotMatch(windowsOutput, /C:\\Users|Alice Smith|private/);

		const bracketed = instance("bracketed-error", "read", {}, {
			content: [{ type: "text", text: "ENOENT: [/home/alice/private/secret.txt]" }],
			isError: true,
		});
		const bracketedOutput = controller.render(bracketed, 160, () => ["native read"]).join("\n");
		assert.match(bracketedOutput, /\[secret\.txt\]/);
		assert.doesNotMatch(bracketedOutput, /\/home\/alice|private/);
	} finally {
		controller.dispose();
	}
});

test("adjacent failures with the same safe reason collapse onto the latest row", () => {
	const controller = createToolRenderController({ isEnabled: () => true, getTheme: () => theme, now: () => 1_000 });
	const result = { content: [{ type: "text", text: "service unavailable" }], isError: true };
	try {
		controller.start({ toolCallId: "fetch-1", toolName: "fetch_content", args: {}, cwd: "/workspace/project" });
		controller.start({ toolCallId: "fetch-2", toolName: "fetch_content", args: {}, cwd: "/workspace/project" });
		controller.end({ toolCallId: "fetch-1", toolName: "fetch_content", result, isError: true });
		controller.end({ toolCallId: "fetch-2", toolName: "fetch_content", result, isError: true });
		assert.deepEqual(controller.render(instance("fetch-1", "fetch_content", {}, result), 120, () => ["native first"]), []);
		assert.match(controller.render(instance("fetch-2", "fetch_content", {}, result), 120, () => ["native second"]).join("\n"), /failed · service unavailable.*×2/);
	} finally {
		controller.dispose();
	}
});

test("custom tools use one safe terminal row without copying opaque arguments", () => {
	const controller = createToolRenderController({ isEnabled: () => true, getTheme: () => theme, now: () => 1_000 });
	try {
		const tool = instance(
			"git-1",
			"git_finalize",
			{ intent: "private intent" },
			{ content: [{ type: "text", text: "Committed abc123" }], details: {}, isError: false },
		);
		const output = controller.render(tool, 100, () => ["native custom"]).join("\n");
		assert.match(output, /Git finalize · Committed abc123/);
		assert.match(output, /<success>/);
		assert.doesNotMatch(output, /private intent|native custom/);
	} finally {
		controller.dispose();
	}
});
