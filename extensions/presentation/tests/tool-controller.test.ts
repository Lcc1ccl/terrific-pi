import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { createToolRenderController } from "../lib/compat/tool-render.ts";

const theme = {
	fg(color: string, text: string) { return `<${color}>${text}</${color}>`; },
	bold(text: string) { return text; },
};

const plainTheme = {
	fg(_color: string, text: string) { return text; },
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

function pendingInstance(toolCallId: string, toolName: string, args: Record<string, unknown> = {}) {
	return {
		...instance(toolCallId, toolName, args),
		executionStarted: false,
		isPartial: true,
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

test("inactive profile preserves pre-profile collapsed rows byte for byte", () => {
	let now = 300;
	const controller = createToolRenderController({
		isEnabled: () => true,
		isTerrificNativeActive: () => false,
		getTheme: () => plainTheme,
		now: () => now,
		resolveSkillName: (args) => (args as { path?: string }).path === "/skills/release/SKILL.md" ? "release-notes" : undefined,
	});
	try {
		assert.deepEqual(
			controller.render(pendingInstance("generic-pending", "custom_tool"), 100, () => ["native"]),
			["", "⠋ Running · Custom tool · 0ms"],
		);
		assert.deepEqual(
			controller.render(pendingInstance("read-pending", "read", { path: "src/a.ts" }), 100, () => ["native"]),
			["", "⠋ Running · read src/a.ts · 0ms"],
		);
		assert.deepEqual(
			controller.render(pendingInstance("skill-pending", "read", { path: "/skills/release/SKILL.md" }), 100, () => ["native"]),
			["", "◆ Skill(release-notes) · loading"],
		);
		assert.deepEqual(
			controller.render(pendingInstance("bash-pending", "bash"), 100, () => ["native"]),
			["", "◆ Bash · pending"],
		);

		controller.start({ toolCallId: "bash-running", toolName: "bash", args: {}, cwd: "/workspace/project", timestamp: 100 });
		assert.deepEqual(
			controller.render(instance("bash-running", "bash", {}), 100, () => ["native"]),
			["", "⠙ Running · Bash · 200ms"],
		);

		const success = { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 }, isError: false };
		controller.start({ toolCallId: "bash-success", toolName: "bash", args: {}, cwd: "/workspace/project", timestamp: 100 });
		controller.end({ toolCallId: "bash-success", toolName: "bash", result: success, isError: false, timestamp: 1_350 });
		assert.deepEqual(
			controller.render(instance("bash-success", "bash", {}, success), 100, () => ["native"]),
			["", "◆ Bash · completed · 1 line · 1s"],
		);

		const failure = { content: [{ type: "text", text: "permission denied" }], details: { exitCode: 7 }, isError: true };
		controller.start({ toolCallId: "bash-error", toolName: "bash", args: {}, cwd: "/workspace/project", timestamp: 100 });
		controller.end({ toolCallId: "bash-error", toolName: "bash", result: failure, isError: true, timestamp: 350 });
		assert.deepEqual(
			controller.render(instance("bash-error", "bash", {}, failure), 100, () => ["native"]),
			["", "✗ Bash · failed · exit 7 · permission denied · 1 line · 250ms"],
		);

		const cancelled = { content: [{ type: "text", text: "cancelled by user" }], isError: true };
		controller.start({ toolCallId: "bash-cancelled", toolName: "bash", args: {}, cwd: "/workspace/project", timestamp: 100 });
		controller.end({ toolCallId: "bash-cancelled", toolName: "bash", result: cancelled, isError: true, timestamp: 200 });
		assert.deepEqual(
			controller.render(instance("bash-cancelled", "bash", {}, cancelled), 100, () => ["native"]),
			["", "✗ Bash · failed · cancelled by user · 1 line · 100ms"],
		);

		const genericSuccess = { content: [{ type: "text", text: "ok" }], isError: false };
		controller.start({ toolCallId: "generic-success", toolName: "custom_tool", args: {}, cwd: "/workspace/project", timestamp: 100 });
		controller.end({ toolCallId: "generic-success", toolName: "custom_tool", result: genericSuccess, isError: false, timestamp: 200 });
		assert.deepEqual(controller.render(instance("generic-success", "custom_tool", {}, genericSuccess), 100, () => ["native"]), ["", "◆ Custom tool · completed · 100ms"]);

		const genericError = { content: [{ type: "text", text: "generic failure" }], isError: true };
		controller.start({ toolCallId: "generic-error", toolName: "custom_tool", args: {}, cwd: "/workspace/project", timestamp: 100 });
		controller.end({ toolCallId: "generic-error", toolName: "custom_tool", result: genericError, isError: true, timestamp: 200 });
		assert.deepEqual(controller.render(instance("generic-error", "custom_tool", {}, genericError), 100, () => ["native"]), ["", "✗ Custom tool · failed · generic failure · 100ms"]);

		const exploreSuccess = { content: [{ type: "text", text: "file" }], isError: false };
		controller.start({ toolCallId: "explore-success", toolName: "read", args: { path: "src/b.ts" }, cwd: "/workspace/project", timestamp: 100 });
		controller.end({ toolCallId: "explore-success", toolName: "read", result: exploreSuccess, isError: false, timestamp: 200 });
		assert.deepEqual(controller.render(instance("explore-success", "read", { path: "src/b.ts" }, exploreSuccess), 100, () => ["native"]), ["", "◆ Explored · read 1 file · 100ms"]);

		const exploreError = { content: [{ type: "text", text: "read failure" }], isError: true };
		controller.start({ toolCallId: "explore-error", toolName: "read", args: { path: "src/c.ts" }, cwd: "/workspace/project", timestamp: 100 });
		controller.end({ toolCallId: "explore-error", toolName: "read", result: exploreError, isError: true, timestamp: 200 });
		assert.deepEqual(controller.render(instance("explore-error", "read", { path: "src/c.ts" }, exploreError), 100, () => ["native"]), ["", "✗ Read · failed · read failure · 100ms"]);

		const skillSuccess = { content: [], isError: false };
		controller.start({ toolCallId: "skill-success", toolName: "read", args: { path: "/skills/release/SKILL.md" }, cwd: "/workspace/project", timestamp: 100, skillName: "release-notes" });
		controller.end({ toolCallId: "skill-success", toolName: "read", result: skillSuccess, isError: false, timestamp: 200 });
		assert.deepEqual(controller.render(instance("skill-success", "read", { path: "/skills/release/SKILL.md" }, skillSuccess), 100, () => ["native"]), ["", "◆ Skill(release-notes) · loaded · 100ms"]);

		const skillError = { content: [{ type: "text", text: "skill failure" }], isError: true };
		controller.start({ toolCallId: "skill-error", toolName: "read", args: { path: "/skills/release/SKILL.md" }, cwd: "/workspace/project", timestamp: 100, skillName: "release-notes" });
		controller.end({ toolCallId: "skill-error", toolName: "read", result: skillError, isError: true, timestamp: 200 });
		assert.deepEqual(controller.render(instance("skill-error", "read", { path: "/skills/release/SKILL.md" }, skillError), 100, () => ["native"]), ["", "✗ Skill(release-notes) · failed · skill failure · 100ms"]);
	} finally {
		controller.dispose();
	}
});

test("active native profile applies the glyph contract across collapsed tool states", () => {
	let now = 1_000;
	const controller = createToolRenderController({
		isEnabled: () => true,
		isTerrificNativeActive: () => true,
		getTheme: () => theme,
		now: () => now,
	});
	try {
		const pending = { ...instance("bash-pending", "bash", {}), executionStarted: false, isPartial: true };
		assert.match(controller.render(pending, 80, () => ["native pending"]).join("\n"), /□<\/muted> Bash · pending/);

		controller.start({ toolCallId: "bash-run", toolName: "bash", args: {}, cwd: "/workspace/project", timestamp: now });
		assert.match(controller.render(instance("bash-run", "bash", {}), 80, () => ["native running"]).join("\n"), /Running · Bash · 0ms/);
		now = 2_250;
		const success = { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 }, isError: false };
		controller.end({ toolCallId: "bash-run", toolName: "bash", result: success, isError: false, timestamp: now });
		assert.match(controller.render(instance("bash-run", "bash", {}, success), 80, () => ["native success"]).join("\n"), /✓<\/success> Bash · completed · 1 line · 1s/);

		for (const [id, name, args, expected] of [
			["read", "read", { path: "src/a.ts" }, /✓<\/success> Explored · read 1 file/],
			["search", "grep", { path: "src", pattern: "x" }, /✓<\/success> Explored · searched 1 pattern/],
			["list", "ls", { path: "src" }, /✓<\/success> Explored · listed 1 directory/],
		] as const) {
			controller.boundary();
			controller.start({ toolCallId: id, toolName: name, args, cwd: "/workspace/project", timestamp: now });
			const result = { content: [], isError: false };
			controller.end({ toolCallId: id, toolName: name, result, isError: false, timestamp: now + 10 });
			assert.match(controller.render(instance(id, name, args, result), 100, () => ["native exploration"]).join("\n"), expected);
		}

		const failure = { content: [{ type: "text", text: "permission denied" }], isError: true };
		controller.start({ toolCallId: "write-error", toolName: "write", args: { path: "src/a.ts" }, cwd: "/workspace/project", timestamp: now });
		controller.end({ toolCallId: "write-error", toolName: "write", result: failure, isError: true, timestamp: now + 20 });
		assert.match(controller.render(instance("write-error", "write", {}, failure), 100, () => ["native write"]).join("\n"), /✗<\/error> Write · failed · permission denied/);

		const customResult = { content: [{ type: "text", text: "opaque" }], isError: false };
		controller.start({ toolCallId: "custom", toolName: "custom_tool", args: { secret: "hidden" }, cwd: "/workspace/project", timestamp: now });
		controller.end({ toolCallId: "custom", toolName: "custom_tool", result: customResult, isError: false, timestamp: now + 30 });
		const custom = instance("custom", "custom_tool", { secret: "hidden" }, customResult);
		assert.match(controller.render(custom, 100, () => ["native custom"]).join("\n"), /✓<\/success> Custom tool · completed/);
		assert.doesNotMatch(controller.render(custom, 100, () => ["native custom"]).join("\n"), /hidden/);
		custom.expanded = true;
		assert.deepEqual(controller.render(custom, 100, () => ["native custom facts"]), ["native custom facts"]);
	} finally {
		controller.dispose();
	}
});

test("active tool matrix preserves distinct owners, states, expansion, and width bounds", () => {
	const tools = [
		{ label: "read", name: "read", args: { path: "src/a.ts" }, success: /Explored/ },
		{ label: "search", name: "grep", args: { path: "src", pattern: "needle" }, success: /Explored/ },
		{ label: "list", name: "ls", args: { path: "src" }, success: /Explored/ },
		{ label: "bash", name: "bash", args: { command: "printf ok" }, success: /Bash · completed/ },
		{ label: "execute", name: "execute", args: { action: "opaque" }, success: /Execute · completed/ },
		{ label: "edit", name: "edit", args: { path: "src/a.ts" }, success: /Files 1 changed/ },
		{ label: "write", name: "write", args: { path: "src/a.ts" }, success: /Files 1 changed/ },
		{ label: "custom", name: "custom_tool", args: { opaque: true }, success: /Custom tool · completed/ },
	] as const;
	const widths = [40, 80, 120, 160] as const;
	for (const tool of tools) {
		for (const stateName of ["pending", "running", "success", "error", "expanded"] as const) {
			let now = 300;
			const controller = createToolRenderController({
				isEnabled: () => true,
				isArtifactProjectionEnabled: () => true,
				isTerrificNativeActive: () => true,
				getTheme: () => plainTheme,
				now: () => now,
			});
			try {
				const id = `${tool.label}-${stateName}`;
				let component = pendingInstance(id, tool.name, tool.args);
				if (stateName !== "pending" && stateName !== "expanded") {
					controller.start({ toolCallId: id, toolName: tool.name, args: tool.args, cwd: "/workspace/project", timestamp: 100, requestId: `request-${id}` });
					component = instance(id, tool.name, tool.args);
				}
				if (stateName === "success") {
					const result = { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 }, isError: false };
					controller.end({ toolCallId: id, toolName: tool.name, result, isError: false, timestamp: now });
					component = instance(id, tool.name, tool.args, result);
					if (tool.name === "edit" || tool.name === "write") {
						controller.setArtifact({
							version: 2,
							receiptId: `receipt-${id}`,
							requestId: `request-${id}`,
							revision: 1,
							anchorToolCallId: id,
							files: [{ path: "src/a.ts", operation: "modified", sources: [tool.name] }],
							successfulWrites: 1,
							failedWrites: 0,
							gitReconciled: false,
							startedAt: 100,
							revisedAt: now,
						});
					}
				} else if (stateName === "error") {
					const result = { content: [{ type: "text", text: "matrix failure" }], isError: true };
					controller.end({ toolCallId: id, toolName: tool.name, result, isError: true, timestamp: now });
					component = instance(id, tool.name, tool.args, result);
				} else if (stateName === "expanded") {
					component = { ...instance(id, tool.name, tool.args), expanded: true };
				}

				for (const width of widths) {
					const sentinel = `native:${tool.label}:${stateName}:${width}`;
					const lines = controller.render(component, width, () => [sentinel]);
					assert.ok(lines.every((line) => visibleWidth(line) <= width), `${tool.label}/${stateName}/${width}`);
					const output = lines.join("\n");
					if (stateName === "expanded") assert.equal(lines[0], sentinel);
					else if (stateName === "pending") assert.match(output, /pending/);
					else if (stateName === "running") assert.match(output, /Running|Exploring/);
					else if (stateName === "success") assert.match(output, tool.success);
					else assert.match(output, /failed/);
					if (tool.name === "execute") assert.doesNotMatch(output, /Bash/);
				}
			} finally {
				controller.dispose();
			}
		}
	}
});

test("active exact Skill identity is path-registered and remains native when expanded", () => {
	const path = "/skills/release/SKILL.md";
	const controller = createToolRenderController({
		isEnabled: () => true,
		isTerrificNativeActive: () => true,
		getTheme: () => plainTheme,
		now: () => 300,
		resolveSkillName: (args) => (args as { path?: string }).path === path ? "release-notes" : undefined,
	});
	try {
		assert.deepEqual(controller.render(pendingInstance("skill", "read", { path }), 80, () => ["native"]), ["", "□ Skill(release-notes) · pending"]);
		controller.start({ toolCallId: "skill", toolName: "read", args: { path }, cwd: "/workspace", timestamp: 100, skillName: "release-notes" });
		assert.deepEqual(controller.render(instance("skill", "read", { path }), 80, () => ["native"]), ["", "● Skill(release-notes) · loading"]);
		const expanded = { ...instance("skill", "read", { path }), expanded: true };
		assert.deepEqual(controller.render(expanded, 80, () => ["native skill facts"]), ["native skill facts"]);
		assert.match(controller.render(pendingInstance("ordinary", "read", { path: "/tmp/SKILL.md" }), 80, () => ["native"]).join("\n"), /read SKILL\.md/);
	} finally {
		controller.dispose();
	}
});

test("active TERM=dumb uses only centralized ASCII status glyphs and separators", () => {
	const previousTerm = process.env.TERM;
	process.env.TERM = "dumb";
	let now = 100;
	const controller = createToolRenderController({
		isEnabled: () => true,
		isArtifactProjectionEnabled: () => true,
		isTerrificNativeActive: () => true,
		getTheme: () => plainTheme,
		now: () => now,
	});
	try {
		assert.deepEqual(controller.render(pendingInstance("pending", "execute"), 100, () => ["native"]), ["", "[ ] Execute . pending"]);
		controller.start({ toolCallId: "running", toolName: "execute", args: {}, cwd: "/workspace", timestamp: now });
		assert.deepEqual(controller.render(instance("running", "execute", {}), 100, () => ["native"]), ["", "* Running . Execute . 0ms"]);

		now = 110;
		const success = { content: [{ type: "text", text: "ok" }], isError: false };
		controller.start({ toolCallId: "success", toolName: "execute", args: {}, cwd: "/workspace", timestamp: 100 });
		controller.end({ toolCallId: "success", toolName: "execute", result: success, isError: false, timestamp: now });
		assert.deepEqual(controller.render(instance("success", "execute", {}, success), 100, () => ["native"]), ["", "+ Execute . completed . 10ms"]);

		const failed = { content: [{ type: "text", text: "failed safely" }], isError: true };
		controller.start({ toolCallId: "failed", toolName: "execute", args: {}, cwd: "/workspace", timestamp: 100 });
		controller.end({ toolCallId: "failed", toolName: "execute", result: failed, isError: true, timestamp: now });
		assert.deepEqual(controller.render(instance("failed", "execute", {}, failed), 100, () => ["native"]), ["", "x Execute . failed . failed safely . 10ms"]);

		const cancelled = { content: [{ type: "text", text: "cancelled by user" }], isError: true };
		controller.start({ toolCallId: "cancelled", toolName: "execute", args: {}, cwd: "/workspace", timestamp: 100 });
		controller.end({ toolCallId: "cancelled", toolName: "execute", result: cancelled, isError: true, timestamp: now });
		assert.deepEqual(controller.render(instance("cancelled", "execute", {}, cancelled), 100, () => ["native"]), ["", "! Execute . cancelled . 10ms"]);

		const bashSuccess = { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 }, isError: false };
		controller.start({ toolCallId: "bash-success-ascii", toolName: "bash", args: {}, cwd: "/workspace", timestamp: 100 });
		controller.end({ toolCallId: "bash-success-ascii", toolName: "bash", result: bashSuccess, isError: false, timestamp: now });
		assert.deepEqual(controller.render(instance("bash-success-ascii", "bash", {}, bashSuccess), 100, () => ["native"]), ["", "+ Bash . completed . 1 line . 10ms"]);

		const bashFailure = { content: [{ type: "text", text: "permission denied" }], details: { exitCode: 7 }, isError: true };
		controller.start({ toolCallId: "bash-error-ascii", toolName: "bash", args: {}, cwd: "/workspace", timestamp: 100 });
		controller.end({ toolCallId: "bash-error-ascii", toolName: "bash", result: bashFailure, isError: true, timestamp: now });
		assert.deepEqual(controller.render(instance("bash-error-ascii", "bash", {}, bashFailure), 100, () => ["native"]), ["", "x Bash . failed . exit 7 . permission denied . 1 line . 10ms"]);
	} finally {
		controller.dispose();
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
});

test("process_update always hands rendering back to native", () => {
	const controller = createToolRenderController({
		isEnabled: () => true,
		isTerrificNativeActive: () => true,
		getTheme: () => theme,
		now: () => 1_000,
	});
	try {
		const process = instance("process", "process_update", { steps: [{ title: "one" }] });
		assert.deepEqual(controller.render(process, 80, () => ["native taskboard owner"]), ["native taskboard owner"]);
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
