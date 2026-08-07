import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import {
	AssistantMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createAssistantRenderController } from "../lib/compat/assistant-message.ts";
import { installPresentationCompatibility } from "../lib/compat/index.ts";

const THINKING_FRAMES = /[✻✼❉❊✺✹✸✶]/;
const OSC_A = "\x1b]133;A\x07";
const OSC_B = "\x1b]133;B\x07";
const OSC_C = "\x1b]133;C\x07";

function occurrences(lines: string[], marker: string): number {
	return lines.join("").split(marker).length - 1;
}

function assistant(content: Array<Record<string, unknown>>) {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

test("OMP assistant keeps literal Thinking text while removing only hidden-thinking rows", () => {
	initTheme("dark", false);
	const handle = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => false,
		isCompactToolsEnabled: () => false,
		isOmpStyleEnabled: () => true,
		getTheme: () => ({ fg(_color: string, text: string) { return text; } }),
	} as never);
	try {
		const component = new AssistantMessageComponent(assistant([
			{ type: "text", text: "Thinking..." },
			{ type: "thinking", thinking: "hidden reasoning" },
			{ type: "text", text: "Answer" },
		]) as never, true, undefined, "Thinking...", 0);
		const output = component.render(80).map(stripVTControlCharacters).join("\n");
		assert.equal(output.match(/Thinking\.\.\./g)?.length, 1);
		assert.match(output, /Answer/);
	} finally {
		handle.uninstall();
	}
});

test("OMP assistant removes only the native leading spacer and preserves Markdown blank rows", () => {
	const controller = createAssistantRenderController({
		isEnabled: () => true,
		getTheme: () => undefined,
		now: () => 0,
	});
	const message = assistant([{ type: "text", text: "First\n\nSecond" }]);
	const rendered = controller.render(
		{ lastMessage: message, hideThinkingBlock: false },
		80,
		() => ["", "First", "", "", "Second", ""],
	);
	assert.deepEqual(rendered, ["First", "", "", "Second", ""]);
});

test("OMP assistant preserves visible thinking and stops hidden pulse when text becomes the tail", () => {
	initTheme("dark", false);
	let now = 0;
	const handle = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => false,
		isCompactToolsEnabled: () => false,
		isOmpStyleEnabled: () => true,
		getTheme: () => ({ fg(_color: string, text: string) { return text; } }),
		now: () => now,
	} as never);
	try {
		const visible = assistant([{ type: "thinking", thinking: "visible reasoning" }]);
		assert.match(new AssistantMessageComponent(visible as never, false, undefined, "Thinking...", 0)
			.render(80).map(stripVTControlCharacters).join("\n"), /visible reasoning/);

		const streaming = assistant([{ type: "thinking", thinking: "hidden reasoning" }]);
		handle.assistantStart(streaming);
		now = 100;
		handle.assistantUpdate(streaming);
		const component = new AssistantMessageComponent(streaming as never, true, undefined, "Thinking...", 0);
		assert.match(component.render(80).map(stripVTControlCharacters).join("\n"), THINKING_FRAMES);
		streaming.content.push({ type: "text", text: "Answer" });
		now = 200;
		handle.assistantUpdate(streaming);
		component.updateContent(streaming as never);
		const output = component.render(80).map(stripVTControlCharacters).join("\n");
		assert.match(output, /Answer/);
		assert.doesNotMatch(output, THINKING_FRAMES);
		assert.doesNotMatch(output, /Thinking\.\.\.|toks\/s/);
	} finally {
		handle.uninstall();
	}
});

test("OMP assistant keeps one OSC prompt zone and width bounds without invented usage", () => {
	initTheme("dark", false);
	let now = 0;
	const handle = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => false,
		isCompactToolsEnabled: () => false,
		isOmpStyleEnabled: () => true,
		getTheme: () => ({ fg(_color: string, text: string) { return text; } }),
		now: () => now,
	} as never);
	try {
		const message = assistant([{ type: "thinking", thinking: "hidden reasoning" }]);
		handle.assistantStart(message);
		now = 100;
		handle.assistantUpdate(message);
		for (const width of [40, 80, 120, 160]) {
			const lines = new AssistantMessageComponent(message as never, true, undefined, "Thinking...", 0).render(width);
			assert.equal(occurrences(lines, OSC_A), 1);
			assert.equal(occurrences(lines, OSC_B), 1);
			assert.equal(occurrences(lines, OSC_C), 1);
			assert.ok(lines[0]?.startsWith(`${OSC_A}${OSC_B}${OSC_C}`));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(lines.map(stripVTControlCharacters).join("\n"), /\d+ toks|toks\/s/);
		}
	} finally {
		handle.uninstall();
	}
});

test("OMP assistant preserves native OSC zone marker positions", () => {
	initTheme("dark", false);
	const handle = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => false,
		isCompactToolsEnabled: () => false,
		isOmpStyleEnabled: () => true,
		getTheme: () => ({ fg(_color: string, text: string) { return text; } }),
	} as never);
	try {
		const lines = new AssistantMessageComponent(
			assistant([{ type: "text", text: "First\n\nSecond" }]) as never,
			true,
			undefined,
			"Thinking...",
			0,
		).render(80);
		assert.ok(lines[0]?.startsWith(OSC_A));
		assert.ok(lines.at(-1)?.startsWith(`${OSC_B}${OSC_C}`));
		assert.match(stripVTControlCharacters(lines.at(-1) ?? ""), /^Second/);

		const single = new AssistantMessageComponent(
			assistant([{ type: "text", text: "Answer" }]) as never,
			true,
			undefined,
			"Thinking...",
			0,
		).render(80);
		assert.ok(single[0]?.startsWith(`${OSC_A}${OSC_B}${OSC_C}`));
		assert.match(stripVTControlCharacters(single[0] ?? ""), /^Answer/);

		const hiddenOnly = new AssistantMessageComponent(
			assistant([{ type: "thinking", thinking: "historical reasoning" }]) as never,
			true,
			undefined,
			"Thinking...",
			0,
		).render(80);
		assert.equal(hiddenOnly.length, 1);
		assert.equal(visibleWidth(hiddenOnly[0] ?? ""), 0);
		assert.ok(hiddenOnly[0]?.startsWith(`${OSC_A}${OSC_B}${OSC_C}`));
		assert.doesNotMatch(hiddenOnly.join(""), /Thinking/);
	} finally {
		handle.uninstall();
	}
});

test("OMP assistant pulse replaces hidden thinking while streaming and disappears from final history", () => {
	initTheme("dark", false);
	const original = AssistantMessageComponent.prototype.render;
	let now = 0;
	const handle = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => false,
		isCompactToolsEnabled: () => false,
		isOmpStyleEnabled: () => true,
		getTheme: () => ({
			fg(_color: string, text: string) { return text; },
			bold(text: string) { return text; },
		}),
		now: () => now,
	} as never) as unknown as {
		assistantStart(message: unknown): void;
		assistantUpdate(message: unknown): void;
		assistantEnd(message: unknown): void;
		uninstall(): void;
	};
	try {
		const message = assistant([{ type: "thinking", thinking: "Working through the fix" }]);
		handle.assistantStart(message);
		message.usage.output = 10;
		message.usage.reasoning = 2;
		handle.assistantUpdate(message);
		now = 100;
		message.usage.output = 20;
		message.usage.reasoning = 4;
		handle.assistantUpdate(message);

		const component = new AssistantMessageComponent(message as never, true, undefined, "Thinking...", 0);
		const streaming = component.render(80).map(stripVTControlCharacters).join("\n");
		assert.match(streaming, /[✻✼❉❊✺✹✸✶] Thinking/);
		assert.match(streaming, /20 · 100\.0 toks\/s/);
		assert.doesNotMatch(streaming, /Thinking\.\.\./);

		handle.assistantEnd({ role: "toolResult" });
		assert.match(component.render(80).map(stripVTControlCharacters).join("\n"), THINKING_FRAMES);

		message.content.push({ type: "text", text: "Done" });
		handle.assistantEnd(message);
		component.updateContent(message as never);
		const finalLines = component.render(80).map(stripVTControlCharacters);
		assert.doesNotMatch(finalLines.join("\n"), /Thinking/);
		assert.match(finalLines.join("\n"), /Done/);
		assert.match(finalLines[0] ?? "", /Done/, "OMP final output removes Pi's extra leading blank row");

		const replay = new AssistantMessageComponent(assistant([
			{ type: "thinking", thinking: "historical reasoning" },
			{ type: "text", text: "Restored answer" },
		]) as never, true, undefined, "Thinking...", 0);
		const restored = replay.render(80).map(stripVTControlCharacters).join("\n");
		assert.doesNotMatch(restored, /Thinking/);
		assert.match(restored, /Restored answer/);
	} finally {
		handle.uninstall();
	}
	assert.equal(AssistantMessageComponent.prototype.render, original);
});
