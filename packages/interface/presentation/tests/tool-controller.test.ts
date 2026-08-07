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

test("OMP read episodes render a path tree instead of one Explored summary", () => {
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => theme,
		now: () => 500,
	});
	try {
		controller.start({ toolCallId: "read-a", toolName: "read", args: { path: "src/auth.ts" }, cwd: "/workspace/project", timestamp: 100 });
		controller.start({ toolCallId: "read-b", toolName: "read", args: { path: "src/session.ts" }, cwd: "/workspace/project", timestamp: 120 });
		controller.end({ toolCallId: "read-a", toolName: "read", result: { content: [{ type: "text", text: "auth" }] }, isError: false, timestamp: 300 });
		controller.end({ toolCallId: "read-b", toolName: "read", result: { content: [{ type: "text", text: "session" }] }, isError: false, timestamp: 500 });
		const first = instance("read-a", "read", { path: "src/auth.ts" }, { content: [{ type: "text", text: "auth" }], isError: false });
		const second = instance("read-b", "read", { path: "src/session.ts" }, { content: [{ type: "text", text: "session" }], isError: false });
		assert.deepEqual(controller.render(first, 100, () => ["native first"]), []);
		const output = controller.render(second, 100, () => ["native second"]).join("\n");
		assert.match(output, /Read \(2\)/);
		assert.match(output, /├─ .*src\/auth\.ts/);
		assert.match(output, /└─ .*src\/session\.ts/);
		assert.doesNotMatch(output, /Explored/);
	} finally {
		controller.dispose();
	}
});

test("OMP read trees keep the first and latest paths within a fixed row budget", () => {
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => theme,
		now: () => 1_000,
	});
	try {
		for (let index = 0; index < 100; index += 1) {
			const id = `read-many-${index}`;
			const args = { path: `src/file-${index}.ts` };
			controller.start({ toolCallId: id, toolName: "read", args, cwd: "/workspace/project", timestamp: index });
			controller.end({ toolCallId: id, toolName: "read", result: { content: [{ type: "text", text: "file" }], isError: false }, isError: false, timestamp: 500 + index });
		}
		const result = { content: [{ type: "text", text: "file" }], isError: false };
		const lines = controller.render(instance("read-many-99", "read", { path: "src/file-99.ts" }, result), 100, () => ["native"]);
		const output = lines.join("\n");
		assert.ok(lines.length <= 10, `read tree grew to ${lines.length} rows`);
		assert.match(output, /Read \(100\)/);
		assert.match(output, /src\/file-0\.ts/);
		assert.match(output, /… 94 more paths/);
		assert.match(output, /src\/file-99\.ts/);
		assert.doesNotMatch(output, /src\/file-50\.ts/);
	} finally {
		controller.dispose();
	}
});

test("OMP search renders a bounded match block with result metadata", () => {
	const plainTheme = {
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => plainTheme,
		now: () => 400,
	});
	try {
		controller.start({ toolCallId: "grep-omp", toolName: "grep", args: { pattern: "refreshToken", path: "src" }, cwd: "/workspace/project", timestamp: 100 });
		const result = {
			content: [{ type: "text", text: "src/auth.ts:42 return refreshToken()\nsrc/session.ts:18 token = refreshToken()\nthird match\nfourth\nfifth\nsixth\nseventh" }],
			details: { matchCount: 3, fileCount: 2 },
			isError: false,
		};
		controller.end({ toolCallId: "grep-omp", toolName: "grep", result, isError: false, timestamp: 400 });
		const lines = controller.render(instance("grep-omp", "grep", { pattern: "refreshToken", path: "src" }, result), 80, () => ["native grep"]);
		const output = lines.join("\n");
		assert.match(output, /╭/);
		assert.match(output, /Search: refreshToken/);
		assert.match(output, /3 matches in 2 files/);
		assert.match(output, /src\/auth\.ts:42/);
		assert.ok(lines.length <= 10, `collapsed search grew to ${lines.length} lines`);
		assert.ok(lines.every((line) => visibleWidth(line) <= 80));
		assert.match(output, /… 1 more line/);
		assert.doesNotMatch(output, /seventh|native grep|Explored/);
	} finally {
		controller.dispose();
	}
});

test("OMP search redacts pattern secrets and absolute preview paths before truncation", () => {
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => theme,
		now: () => 1_000,
	});
	try {
		const args = { pattern: "password=hunter2", path: "/home/alice/private" };
		const result = {
			content: [{ type: "text", text: "/home/alice/private/a.ts:1 token=topsecret" }],
			details: { matchCount: 1, fileCount: 1 },
			isError: false,
		};
		controller.start({ toolCallId: "grep-private", toolName: "grep", args, cwd: "/workspace/project", timestamp: 500 });
		controller.end({ toolCallId: "grep-private", toolName: "grep", result, isError: false, timestamp: 1_000 });
		const output = controller.render(instance("grep-private", "grep", args, result), 120, () => ["native"]).join("\n");
		assert.doesNotMatch(output, /hunter2|topsecret|\/home\/alice/);
		assert.match(output, /password=<redacted>/);
		assert.match(output, /a\.ts:1 token=<redacted>/);
	} finally {
		controller.dispose();
	}
});

test("OMP previews hide credential aliases and file or UNC absolute paths", () => {
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => theme,
		now: () => 1_000,
	});
	try {
		const args = { command: "printf safe" };
		const result = {
			content: [{
				type: "text",
				text: "credential=plain-secret\nAuthorization: opaque-value\nfile:///home/alice/private/a.txt\n\\\\server\\share\\private.txt",
			}],
			details: { exitCode: 0 },
			isError: false,
		};
		controller.start({ toolCallId: "bash-aliases", toolName: "bash", args, cwd: "/workspace/project", timestamp: 500 });
		controller.end({ toolCallId: "bash-aliases", toolName: "bash", result, isError: false, timestamp: 1_000 });
		const output = controller.render(instance("bash-aliases", "bash", args, result), 120, () => ["native"]).join("\n");
		assert.match(output, /credential=<redacted>/);
		assert.match(output, /Authorization=<redacted>/);
		assert.match(output, /<file>/);
		assert.match(output, /private\.txt/);
		assert.doesNotMatch(output, /plain-secret|opaque-value|\/home\/alice|server|share/);
	} finally {
		controller.dispose();
	}
});

test("OMP bash renders a redacted command and bounded output block", () => {
	const plainTheme = {
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => plainTheme,
		now: () => 2_000,
	});
	try {
		const args = { command: "curl --password $'delta echo' --token \"charlie\\\" value\" && npm test", cwd: "/workspace/project" };
		const result = {
			content: [{ type: "text", text: "line one\nline two\nline three\nline four\nline five\n42 passed PASSWORD=\"result\\\" secret\"" }],
			details: { exitCode: 0 },
			isError: false,
		};
		controller.start({ toolCallId: "bash-omp", toolName: "bash", args, cwd: "/workspace/project", timestamp: 1_000 });
		controller.end({ toolCallId: "bash-omp", toolName: "bash", result, isError: false, timestamp: 2_000 });
		const lines = controller.render(instance("bash-omp", "bash", args, result), 120, () => ["native bash"]);
		const output = lines.join("\n");
		assert.match(output, /╭/);
		assert.match(output, /Bash/);
		assert.match(output, /\$ curl --password=<redacted>/);
		assert.match(output, /42 passed PASSWORD=<redacted>/);
		assert.doesNotMatch(output, /delta|echo|charlie|value|result|secret|line one|native bash|npm test/);
		assert.ok(lines.length <= 10, `collapsed bash grew to ${lines.length} lines`);
		assert.ok(lines.every((line) => visibleWidth(line) <= 120));
	} finally {
		controller.dispose();
	}
});

test("OMP edit renders a bounded file diff block", () => {
	const plainTheme = {
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => plainTheme,
		now: () => 1_000,
	});
	try {
		const args = { path: "src/auth.ts" };
		const result = {
			content: [{ type: "text", text: "Updated src/auth.ts" }],
			details: { diff: "@@ -40,2 +40,2 @@\n- return staleToken\n+ return await refreshToken()\n context" },
			isError: false,
		};
		controller.start({ toolCallId: "edit-omp", toolName: "edit", args, cwd: "/workspace/project", timestamp: 500 });
		controller.end({ toolCallId: "edit-omp", toolName: "edit", result, isError: false, timestamp: 1_000 });
		const lines = controller.render(instance("edit-omp", "edit", args, result), 80, () => ["native edit"]);
		const output = lines.join("\n");
		assert.match(output, /╭/);
		assert.match(output, /Edit: src\/auth\.ts/);
		assert.match(output, /- return staleToken/);
		assert.match(output, /\+ return await refreshToken/);
		assert.doesNotMatch(output, /native edit/);
		assert.ok(lines.length <= 12, `collapsed edit grew to ${lines.length} lines`);
		assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	} finally {
		controller.dispose();
	}
});

test("OMP generic tools use a bounded state card without opaque arguments", () => {
	const plainTheme = {
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => plainTheme,
		now: () => 1_000,
	});
	try {
		const args = { intent: "private release intent", prompt: "opaque prompt" };
		const result = { content: [{ type: "text", text: "Committed abc123" }], details: {}, isError: false };
		controller.start({ toolCallId: "git-omp", toolName: "git_finalize", args, cwd: "/workspace/project", timestamp: 500 });
		controller.end({ toolCallId: "git-omp", toolName: "git_finalize", result, isError: false, timestamp: 1_000 });
		const output = controller.render(instance("git-omp", "git_finalize", args, result), 80, () => ["native generic"]).join("\n");
		assert.match(output, /╭/);
		assert.match(output, /Git finalize/);
		assert.match(output, /Committed abc123/);
		assert.doesNotMatch(output, /private release intent|opaque prompt|native generic/);
	} finally {
		controller.dispose();
	}
});

test("OMP tool blocks stay physically bounded across narrow widths and long tokens", () => {
	const plainTheme = {
		fg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	};
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => plainTheme,
		now: () => 1_000,
	});
	try {
		const args = { command: `printf ${"x".repeat(300)}` };
		const result = {
			content: [{ type: "text", text: Array.from({ length: 8 }, (_, index) => `${index}:${"界".repeat(120)}`).join("\n") }],
			details: { exitCode: 0 },
			isError: false,
		};
		controller.start({ toolCallId: "bash-width", toolName: "bash", args, cwd: "/workspace/project", timestamp: 500 });
		controller.end({ toolCallId: "bash-width", toolName: "bash", result, isError: false, timestamp: 1_000 });
		for (const width of [40, 80, 120, 160]) {
			const lines = controller.render(instance("bash-width", "bash", args, result), width, () => ["native"]);
			assert.ok(lines.length <= 10, `${width} columns rendered ${lines.length} rows`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width} columns overflowed`);
		}
	} finally {
		controller.dispose();
	}
});

test("runtime profile switching restores the classic exploration episode without rehydration", () => {
	let omp = true;
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => omp,
		getTheme: () => theme,
		now: () => 500,
	});
	try {
		const readArgs = { path: "src/a.ts" };
		const grepArgs = { pattern: "render", path: "src" };
		const readResult = { content: [{ type: "text", text: "file" }], isError: false };
		const grepResult = { content: [{ type: "text", text: "match" }], details: { matchCount: 1, fileCount: 1 }, isError: false };
		controller.start({ toolCallId: "switch-read", toolName: "read", args: readArgs, cwd: "/workspace/project", timestamp: 100 });
		controller.start({ toolCallId: "switch-grep", toolName: "grep", args: grepArgs, cwd: "/workspace/project", timestamp: 120 });
		controller.end({ toolCallId: "switch-read", toolName: "read", result: readResult, isError: false, timestamp: 400 });
		controller.end({ toolCallId: "switch-grep", toolName: "grep", result: grepResult, isError: false, timestamp: 500 });

		const ompRead = controller.render(instance("switch-read", "read", readArgs, readResult), 100, () => ["native"]);
		const ompSearch = controller.render(instance("switch-grep", "grep", grepArgs, grepResult), 100, () => ["native"]);
		assert.match(ompRead.join("\n"), /Read/);
		assert.match(ompSearch.join("\n"), /Search: render/);

		omp = false;
		const classic = [
			...controller.render(instance("switch-read", "read", readArgs, readResult), 100, () => ["native"]),
			...controller.render(instance("switch-grep", "grep", grepArgs, grepResult), 100, () => ["native"]),
		].join("\n");
		assert.equal(classic.match(/Explored/g)?.length, 1);
		assert.match(classic, /read 1 file · searched 1 pattern/);
	} finally {
		controller.dispose();
	}
});

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

test("OMP leaves process_update rendering entirely native", () => {
	const controller = createToolRenderController({
		isEnabled: () => true,
		isOmpStyleEnabled: () => true,
		isArtifactProjectionEnabled: () => true,
		getTheme: () => theme,
		now: () => 1_000,
	});
	try {
		let calls = 0;
		const output = controller.render(instance("process-1", "process_update", { title: "Task" }), 80, () => {
			calls += 1;
			return ["native process_update"];
		});
		assert.deepEqual(output, ["native process_update"]);
		assert.equal(calls, 1);
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
