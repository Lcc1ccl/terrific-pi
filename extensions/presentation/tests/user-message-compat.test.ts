import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import {
	initTheme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { installPresentationCompatibility } from "../lib/compat/index.ts";
import { renderUserMessageBox } from "../lib/compat/user-message.ts";

const OSC_A = "\x1b]133;A\x07";
const OSC_B = "\x1b]133;B\x07";
const OSC_C = "\x1b]133;C\x07";

function occurrences(lines: string[], marker: string): number {
	return lines.join("").split(marker).length - 1;
}

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

test("active native profile renders a full-width prompt band from native Markdown at supported widths", () => {
	initTheme("dark", false);
	const handle = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => true,
		isCompactToolsEnabled: () => false,
		isTerrificNativeActive: () => true,
		getTheme: () => ({
			fg(color: string, text: string) { return color === "accent" ? `\x1b[32m${text}\x1b[39m` : text; },
			getBgAnsi(color: string) { assert.equal(color, "userMessageBg"); return "\x1b[48;5;22m"; },
			bold(text: string) { return text; },
		}),
	} as never);
	try {
		const message = new UserMessageComponent("1. first\n\n`code` and **bold**\n中文🙂 ANSI", undefined, 0);
		for (const width of [40, 80, 120, 160]) {
			const lines = message.render(width);
			const output = lines.map(stripVTControlCharacters).join("\n");
			assert.match(output, /❯ 1\. first/);
			assert.match(output, /code and bold/);
			assert.match(output, /中文🙂 ANSI/);
			assert.doesNotMatch(output, /╭ user |╰─|│/);
			assert.equal(occurrences(lines, OSC_A), 1);
			assert.equal(occurrences(lines, OSC_B), 1);
			assert.equal(occurrences(lines, OSC_C), 1);
			assert.ok(lines.some((line) => line.includes("\x1b[38;2;")), "native Markdown foreground survives");
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.filter((line) => visibleWidth(line) > 0).every((line) => visibleWidth(line) === width));
		}
	} finally {
		handle.uninstall();
	}
});

test("synthetic OSC 133/633 BEL/ST zones preserve native A-content-B-C ordering", () => {
	const markers = {
		a133: "\x1b]133;A\x07",
		a633: "\x1b]633;A\x1b\\",
		b133: "\x1b]133;B\x1b\\",
		b633: "\x1b]633;B\x07",
		c133: "\x1b]133;C\x07",
		c633: "\x1b]633;C\x1b\\",
	};
	const lines = renderUserMessageBox(
		{},
		40,
		function (width) {
			assert.equal(width, 38);
			return [
				`${markers.a133}${markers.a633}${" ".repeat(width)}`,
				`\x1b[31mcontent\x1b[39m${" ".repeat(width - 7)}`,
				`${markers.b133}${markers.b633}${markers.c133}${markers.c633}${" ".repeat(width)}`,
			];
		},
		{ fg(_color, text) { return text; }, getBgAnsi() { return "\x1b[48;5;22m"; } },
		true,
		true,
	);
	const output = lines.join("\n");
	for (const marker of Object.values(markers)) assert.equal(output.split(marker).length - 1, 1, marker);
	const aEnd = Math.max(output.indexOf(markers.a133), output.indexOf(markers.a633));
	const prompt = output.indexOf("❯");
	const content = output.indexOf("content");
	const bStart = Math.min(output.indexOf(markers.b133), output.indexOf(markers.b633));
	const bEnd = Math.max(output.indexOf(markers.b133), output.indexOf(markers.b633));
	const cStart = Math.min(output.indexOf(markers.c133), output.indexOf(markers.c633));
	assert.ok(aEnd < prompt && prompt < content && content < bStart && bEnd < cStart);
	assert.ok(lines[0]?.startsWith(`${markers.a133}${markers.a633}`));
	assert.ok(lines.at(-1)?.startsWith(`${markers.b133}${markers.b633}${markers.c133}${markers.c633}`));
});

test("active pure wrapper fails open at narrow width and after theme failure", () => {
	const narrowCalls: number[] = [];
	const narrow = renderUserMessageBox(
		{}, 7,
		function (width) { narrowCalls.push(width); return [`native:${width}`]; },
		{ fg(_color, text) { return text; }, getBgAnsi() { return ""; } },
		true, true,
	);
	assert.deepEqual(narrow, ["native:7"]);
	assert.deepEqual(narrowCalls, [7]);

	const failureCalls: number[] = [];
	const failed = renderUserMessageBox(
		{}, 40,
		function (width) {
			failureCalls.push(width);
			return width === 40 ? ["native:40"] : ["content"];
		},
		{ fg() { throw new Error("theme failed"); }, getBgAnsi() { throw new Error("background failed"); } },
		true, true,
	);
	assert.deepEqual(failed, ["native:40"]);
	assert.deepEqual(failureCalls, [38, 40]);
});

test("active native profile uses ASCII prompt for TERM=dumb and fails open narrowly", () => {
	initTheme("dark", false);
	const previousTerm = process.env.TERM;
	process.env.TERM = "dumb";
	const original = UserMessageComponent.prototype.render;
	const handle = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => true,
		isCompactToolsEnabled: () => false,
		isTerrificNativeActive: () => true,
		getTheme: () => ({
			fg(_color: string, text: string) { return text; },
			getBgAnsi() { return ""; },
		}),
	} as never);
	try {
		const message = new UserMessageComponent("fallback", undefined, 0);
		assert.match(message.render(40).map(stripVTControlCharacters).join("\n"), /> fallback/);
		const narrow = message.render(7);
		assert.deepEqual(narrow, original.call(message, 7));
		assert.ok(narrow.every((line) => visibleWidth(line) <= 7));
	} finally {
		handle.uninstall();
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
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
