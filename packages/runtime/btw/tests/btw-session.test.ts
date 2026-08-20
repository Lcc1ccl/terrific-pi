import assert from "node:assert/strict";
import { it } from "node:test";
import type { Message, Model } from "@earendil-works/pi-ai";
import { createIsolatedBtwSession, raceWithSignal } from "../lib/btw-session.ts";

it("stops awaiting an operation that ignores cancellation", async () => {
	const controller = new AbortController();
	const pending = raceWithSignal(new Promise<never>(() => {}), controller.signal);
	controller.abort(new Error("deadline"));
	await assert.rejects(pending, /deadline/);
});

it("disposes a value that resolves after cancellation", async () => {
	const controller = new AbortController();
	let resolve!: (value: string) => void;
	let disposed = "";
	const operation = new Promise<string>((done) => { resolve = done; });
	const pending = raceWithSignal(operation, controller.signal, (value) => { disposed = value; });
	controller.abort(new Error("deadline"));
	await assert.rejects(pending, /deadline/);
	resolve("late session");
	await new Promise<void>((done) => setImmediate(done));
	assert.equal(disposed, "late session");
});

it("creates an in-memory role-preserving no-tool session", async () => {
	const model = {
		id: "btw-test-model",
		name: "BTW Test Model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 256,
	} as Model<"openai-responses">;
	const messages = [{ role: "user", content: [{ type: "text", text: "main goal" }], timestamp: 1 }] as Message[];
	const session = await createIsolatedBtwSession({
		cwd: "/tmp/pi-btw-test",
		model,
		thinkingLevel: "minimal",
		messages,
	});
	try {
		assert.equal(session.sessionFile, undefined);
		assert.deepEqual(session.agent.state.tools, []);
		assert.deepEqual(session.agent.state.messages.map((message) => message.role), ["user"]);
		assert.match(session.agent.state.systemPrompt, /旁路解释器/);
	} finally {
		session.dispose();
	}
});
