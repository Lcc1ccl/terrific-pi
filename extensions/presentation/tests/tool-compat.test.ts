import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import {
	createBashToolDefinition,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";

import { installPresentationCompatibility } from "../lib/compat/index.ts";

function plain(lines: string[]): string {
	return lines.map((line) => stripVTControlCharacters(line)).join("\n");
}

function component(id: string, command: string): ToolExecutionComponent {
	const ui = { requestRender() {} };
	return new ToolExecutionComponent(
		"bash",
		id,
		{ command },
		{},
		createBashToolDefinition("/workspace"),
		ui as never,
		"/workspace",
	);
}

test("bash collapsed rendering preserves running success error and native expansion", () => {
	initTheme("dark", false);
	let now = 1_000;
	const handle = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => false,
		isCompactToolsEnabled: () => true,
		getTheme: () => ({
			fg(color: string, text: string) { return `<${color}>${text}</${color}>`; },
			bold(text: string) { return text; },
		}),
		now: () => now,
	} as never);
	try {
		const success = component("bash-success", "printf super-secret-command");
		success.markExecutionStarted();
		let output = plain(success.render(100));
		assert.match(output, /Running · Bash/);
		assert.doesNotMatch(output, /super-secret-command/);

		now = 3_400;
		success.updateResult({
			content: [{ type: "text", text: "line one\nline two" }],
			details: { exitCode: 0 },
			isError: false,
		}, false);
		output = plain(success.render(100));
		assert.match(output, /Bash · completed · 2 lines · 2s/);
		assert.match(output, /<success>/);
		assert.doesNotMatch(output, /super-secret-command/);

		success.setExpanded(true);
		output = plain(success.render(100));
		assert.match(output, /super-secret-command/);
		assert.match(output, /line one/);

		const failure = component("bash-error", "printf another-secret");
		failure.markExecutionStarted();
		now = 4_000;
		failure.updateResult({
			content: [{ type: "text", text: "permission denied\nCommand exited with code 7" }],
			details: { exitCode: 7 },
			isError: true,
		}, false);
		output = plain(failure.render(100));
		assert.match(output, /Bash · failed · exit 7/);
		assert.match(output, /<error>/);
		assert.doesNotMatch(output, /another-secret/);
	} finally {
		handle.uninstall();
	}
});
