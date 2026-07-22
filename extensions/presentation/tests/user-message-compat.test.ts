import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import {
	initTheme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { installPresentationCompatibility } from "../lib/compat/index.ts";

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
