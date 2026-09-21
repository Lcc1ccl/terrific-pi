import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import {
	initTheme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { installPresentationCompatibility } from "../lib/compat/index.ts";
import { renderUserMessageFrame } from "../lib/compat/user-message.ts";

const OSC_A = "\x1b]133;A\x07";
const OSC_B = "\x1b]133;B\x07";
const OSC_C = "\x1b]133;C\x07";

test("OMP heavy frame preserves native Markdown, widths and markers across themes and toggles", () => {
	for (const name of ["dark", "light"] as const) {
		initTheme(name, false);
		const message = new UserMessageComponent("中文输入 **重点**\n\n[link](https://example.com)\n\n```ts\nconst value = 1;\n```", undefined, 0);
		const native = UserMessageComponent.prototype.render;
		const calls: string[] = [];
		const theme = { fg(color: string, text: string) { calls.push(color); return text; }, bold: (text: string) => { calls.push(`bold:${text}`); return `\x1b[1m${text}\x1b[22m`; } };
		for (const width of [7, 8, 40, 80, 120]) {
			const expected = native.call(message, width);
			const actual = renderUserMessageFrame(message, width, native, theme, true);
			if (width >= 8) {
				const plain = actual.map(stripVTControlCharacters).filter(Boolean);
				assert.match(plain[0]!, /^┏.*┓$/);
				assert.match(plain.at(-1)!, /^┗━+┛$/);
				assert.ok(plain.slice(1, -1).every(line => line.startsWith("┃ ") && line.endsWith(" ┃")));
				const nativeBody = native.call(message, width - 4).map(stripVTControlCharacters).slice(1, -1);
				assert.deepEqual(plain.slice(1, -1).map(line => line.slice(2, -2).trimEnd()), nativeBody.map(line => line.trimEnd()));
			}
			assert.ok(actual.every(line => visibleWidth(line) <= width));
			for (const marker of [OSC_A, OSC_B, OSC_C]) assert.equal(occurrences(actual, marker), occurrences(expected, marker));
			assert.deepEqual(renderUserMessageFrame(message, width, native, theme, false), expected);
			if (width < 8) assert.deepEqual(actual, expected);
		}
		assert.ok(calls.includes("accent"));
		assert.ok(calls.includes("bold:┃"));
		assert.ok(calls.includes("bold:┏"));
	}
});

test("OMP heavy frame preserves OSC 633 and unpadded host content", () => {
	const marker = "\x1b]633;A\x1b\\";
	const rows = [marker + " ".repeat(20), "body", "\x1b]633;B\x07"];
	const actual = renderUserMessageFrame(null, 20, () => rows, undefined, true);
	assert.equal(occurrences(actual, marker), 1);
	assert.ok(actual[1]!.startsWith(marker));
	assert.match(actual.join("\n"), /body/);
	const unpadded = ["keep first line", "body"];
	assert.match(renderUserMessageFrame(null, 20, () => unpadded, undefined, true).join("\n"), /keep first line/);
});

function occurrences(lines: string[], marker: string): number {
	return lines.join("").split(marker).length - 1;
}

test("OMP profile surrounds the user message with a bold complete frame", () => {
	initTheme("dark", false);
	const original = UserMessageComponent.prototype.render;
	const handle = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => true,
		isCompactToolsEnabled: () => false,
		isOmpStyleEnabled: () => true,
		getTheme: () => ({
			fg(_color: string, text: string) { return text; },
			bg(_color: string, text: string) { return text; },
			bold(text: string) { return text; },
		}),
	} as never);
	try {
		const message = new UserMessageComponent("native shaded prompt", undefined, 0);

		const lines = message.render(40);
		assert.match(stripVTControlCharacters(lines[1]!), /┏ ❯ You ━+┓/);
		assert.equal(visibleWidth(lines[1]!), 40);
		const plain = lines.map(stripVTControlCharacters).join("\n");
		assert.match(plain, /native shaded prompt/);
		assert.match(plain, /┃ .*native shaded prompt.* ┃/);
		assert.match(plain, /┗━+┛/);
		assert.equal(occurrences(lines, OSC_A), 1);
		assert.equal(occurrences(lines, OSC_B), 1);
	} finally {
		handle.uninstall();
	}
	assert.equal(UserMessageComponent.prototype.render, original);
});

test("new compatibility ownership survives an older reload handle unloading", () => {
	initTheme("dark", false);
	const original = UserMessageComponent.prototype.render;
	const options = {
		isUserMessageBoxEnabled: () => true,
		isCompactToolsEnabled: () => false,
		getTheme: () => ({
			fg(_color: string, text: string) { return text; },
			bg(_color: string, text: string) { return text; },
			bold(text: string) { return text; },
		}),
	};
	const first = installPresentationCompatibility(options as never);
	const second = installPresentationCompatibility(options as never);
	try {
		first.uninstall();
		const message = new UserMessageComponent("reload keeps the frame", undefined, 0);
		assert.match(message.render(40).map(stripVTControlCharacters).join("\n"), /╭ user ─+╮/);
	} finally {
		second.uninstall();
	}
	assert.equal(UserMessageComponent.prototype.render, original);
});

test("unloading the newest compatibility handle reactivates the previous live renderer", () => {
	initTheme("dark", false);
	const original = UserMessageComponent.prototype.render;
	const shared = {
		isCompactToolsEnabled: () => false,
		getTheme: () => ({
			fg(_color: string, text: string) { return text; },
			bg(_color: string, text: string) { return text; },
			bold(text: string) { return text; },
		}),
	};
	const first = installPresentationCompatibility({ ...shared, isUserMessageBoxEnabled: () => true } as never);
	const second = installPresentationCompatibility({ ...shared, isUserMessageBoxEnabled: () => false } as never);
	try {
		const message = new UserMessageComponent("owner stack", undefined, 0);
		assert.doesNotMatch(message.render(40).map(stripVTControlCharacters).join("\n"), /╭ user /);
		second.uninstall();
		assert.match(message.render(40).map(stripVTControlCharacters).join("\n"), /╭ user ─+╮/);
	} finally {
		first.uninstall();
	}
	assert.equal(UserMessageComponent.prototype.render, original);
});

test("user message compatibility adds one semantic full-width box without rebuilding content", () => {
	initTheme("dark", false);
	const original = UserMessageComponent.prototype.render;
	let enabled = true;
	const handle = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => enabled,
		isCompactToolsEnabled: () => false,
		getTheme: () => ({
			fg(_color: string, text: string) { return text; },
			bg(_color: string, text: string) { return text; },
			bold(text: string) { return text; },
		}),
	} as never);
	try {
		const message = new UserMessageComponent("1. first\n\n`code` and **bold**", undefined, 0);
		const lines = message.render(40);
		const plain = lines.map((line) => stripVTControlCharacters(line));
		assert.match(plain.join("\n"), /╭ user ─+╮/);
		assert.match(plain.join("\n"), /1\. first/);
		assert.match(plain.join("\n"), /code and bold/);
		assert.match(plain.join("\n"), /╰─+╯/);
		for (const line of lines.filter((line) => stripVTControlCharacters(line).length > 0)) {
			assert.equal(visibleWidth(line), 40);
		}
		assert.equal(occurrences(lines, OSC_A), 1);
		assert.equal(occurrences(lines, OSC_B), 1);
		assert.equal(occurrences(lines, OSC_C), 1);

		enabled = false;
		assert.doesNotMatch(message.render(40).map(stripVTControlCharacters).join("\n"), /╭ user /);
		assert.doesNotMatch(message.render(7).map(stripVTControlCharacters).join("\n"), /╭ user /);
	} finally {
		handle.uninstall();
	}
	assert.equal(UserMessageComponent.prototype.render, original);
});
