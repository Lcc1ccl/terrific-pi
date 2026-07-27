import assert from "node:assert/strict";
import { describe, test } from "node:test";

import docsflow from "../../docsflow/extensions/docsflow.ts";
import mode from "../../mode/extensions/mode.ts";
import pilot from "../extensions/pilot.ts";

class Events {
	private readonly handlers = new Map<string, Array<(value: unknown) => void>>();
	on(name: string, handler: (value: unknown) => void): () => void {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
		return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
	}
	emit(name: string, value: unknown): void {
		for (const handler of this.handlers.get(name) ?? []) handler(value);
	}
}

describe("Pilot package coexistence", () => {
	test("loads mode, Pilot, and docsflow without duplicate command ownership", () => {
		const commands = new Set<string>();
		const hooks = new Map<string, unknown[]>();
		const api = {
			events: new Events(),
			registerCommand(name: string) {
				if (commands.has(name)) throw new Error(`duplicate command: ${name}`);
				commands.add(name);
			},
			on(name: string, handler: unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
			appendEntry() {},
			getActiveTools() { return ["read", "grep", "find", "ls", "bash", "edit", "write"]; },
			setActiveTools() {},
		} as never;

		mode(api);
		pilot(api);
		docsflow(api);

		assert.equal(commands.has("mode"), true);
		assert.equal(commands.has("pilot"), true);
		assert.equal(commands.has("docsflow"), true);
		assert.equal(commands.size, 3);
	});
});
