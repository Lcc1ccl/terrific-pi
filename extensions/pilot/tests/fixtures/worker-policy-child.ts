import { readFileSync } from "node:fs";

import pilot from "../../extensions/pilot.ts";
import { PILOT_WORKER_BOOTSTRAP_TOOLS } from "../../lib/worker-policy.ts";

const hooks = new Map<string, Array<(event: unknown, context: unknown) => Promise<unknown> | unknown>>();
let activeTools: string[] = [...PILOT_WORKER_BOOTSTRAP_TOOLS, "edit", "write", "subagent_wait", "subagent_supervisor"];
const events = { on() { return () => {}; }, emit() {} };

pilot({
	events,
	registerCommand() {},
	on(name: string, handler: (event: unknown, context: unknown) => Promise<unknown> | unknown) {
		hooks.set(name, [...(hooks.get(name) ?? []), handler]);
	},
	appendEntry() {},
	getActiveTools() { return [...activeTools]; },
	setActiveTools(next: string[]) { activeTools = [...next]; },
} as never);

const cwd = process.env.PILOT_TEST_CHILD_CWD;
if (!cwd) throw new Error("PILOT_TEST_CHILD_CWD is required.");
const context = {
	cwd,
	ui: { notify() {}, setStatus() {} },
	sessionManager: { getBranch: () => [] },
};
const prompt = readFileSync(0, "utf8");
for (const handler of hooks.get("before_agent_start") ?? []) await handler({ prompt }, context);
const input = { path: "src/from-fixed-runner.ts" };
let outcome: unknown;
for (const handler of hooks.get("tool_call") ?? []) outcome = await handler({ toolName: "write", input }, context);

process.stdout.write(JSON.stringify({ activeTools: [...activeTools].sort(), input, outcome }));
