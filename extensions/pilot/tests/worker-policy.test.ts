import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, test } from "node:test";

import pilot from "../extensions/pilot.ts";
import { discardPilotDelegationPolicy, preflightPilotDelegation } from "../lib/delegation.ts";
import { expectedPilotProfile } from "../lib/profiles.ts";
import {
	PILOT_WORKER_BOOTSTRAP_TOOLS,
	createPilotWorkerCapability,
	createPilotWorkerPolicyHeader,
	discardPilotWorkerCapability,
	guardPilotWorkerToolCall,
	parsePilotWorkerPolicyPrompt,
} from "../lib/worker-policy.ts";

const roots: string[] = [];
const tools = ["read", "grep", "find", "ls", "edit", "write"];
const bootstrapTools = [...PILOT_WORKER_BOOTSTRAP_TOOLS];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function policyFixture(task = "Implement.") {
	const root = mkdtempSync(path.join(tmpdir(), "pilot-worker-policy-"));
	roots.push(root);
	const project = path.join(root, "project");
	const outside = path.join(root, "outside");
	mkdirSync(path.join(project, "src"), { recursive: true });
	mkdirSync(outside);
	const events = { on() {}, emit() {} };
	const policy = await preflightPilotDelegation({
		events,
		request: {
			agent: "pilot.worker",
			task,
			cwd: project,
			allowedTools: tools,
			writeRoots: ["src"],
			expectedAgent: expectedPilotProfile("pilot.worker"),
		},
	});
	return { project, outside, events, policy };
}

describe("Pilot Worker runtime policy", () => {
	test("binds the child cwd, active tools, profile, and write roots", async () => {
		const { project, events, policy } = await policyFixture();
		const runtime = createPilotWorkerCapability(policy);
		const result = parsePilotWorkerPolicyPrompt({
			prompt: `${createPilotWorkerPolicyHeader(runtime)}\nImplement.`,
			cwd: project,
			activeTools: bootstrapTools,
			childAgent: "pilot.worker",
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.policy.digest, policy.digest);
		const wrappedRuntime = createPilotWorkerCapability(policy);
		assert.equal(parsePilotWorkerPolicyPrompt({
			prompt: `<file name="/tmp/pi-subagent/task.md">\nTask: ${createPilotWorkerPolicyHeader(wrappedRuntime)}\nImplement.\n</file>\n`,
			cwd: project,
			activeTools: bootstrapTools,
			childAgent: "pilot.worker",
		}).ok, true);
		assert.equal(parsePilotWorkerPolicyPrompt({
			prompt: `${createPilotWorkerPolicyHeader(runtime)}\nImplement.`,
			cwd: project,
			activeTools: bootstrapTools,
			childAgent: "pilot.worker",
		}).ok, false, "a consumed Worker capability must not replay");
		discardPilotDelegationPolicy({ events, requestId: "test", policy });
	});

	test("fails closed when child tools or identity drift", async () => {
		const { project, events, policy } = await policyFixture();
		const runtime = createPilotWorkerCapability(policy);
		const prompt = `${createPilotWorkerPolicyHeader(runtime)}\nImplement.`;
		const toolDrift = parsePilotWorkerPolicyPrompt({ prompt, cwd: project, activeTools: tools, childAgent: "pilot.worker" });
		assert.equal(toolDrift.ok, false);
		if (!toolDrift.ok) assert.match(toolDrift.error, /bootstrap tools/);
		const identity = parsePilotWorkerPolicyPrompt({ prompt, cwd: project, activeTools: bootstrapTools, childAgent: "worker" });
		assert.equal(identity.ok, false);
		discardPilotWorkerCapability(runtime);
		discardPilotDelegationPolicy({ events, requestId: "test", policy });
	});

	test("binds the capability to the exact Worker task", async () => {
		const { project, events, policy } = await policyFixture();
		const runtime = createPilotWorkerCapability(policy);
		const header = createPilotWorkerPolicyHeader(runtime);
		const tampered = parsePilotWorkerPolicyPrompt({
			prompt: `${header}\nImplement something else.`,
			cwd: project,
			activeTools: bootstrapTools,
			childAgent: "pilot.worker",
		});
		assert.equal(tampered.ok, false);
		if (!tampered.ok) assert.match(tampered.error, /task does not match/);
		assert.equal(parsePilotWorkerPolicyPrompt({
			prompt: `${header}\nImplement.`,
			cwd: project,
			activeTools: bootstrapTools,
			childAgent: "pilot.worker",
		}).ok, true);
		discardPilotDelegationPolicy({ events, requestId: "test", policy });
	});

	test("canonicalizes authorized writes and blocks symlink escapes and undeclared tools", async () => {
		const { project, outside, events, policy } = await policyFixture();
		const runtime = createPilotWorkerCapability(policy);
		const parsed = parsePilotWorkerPolicyPrompt({
			prompt: `${createPilotWorkerPolicyHeader(runtime)}\nImplement.`,
			cwd: project,
			activeTools: bootstrapTools,
			childAgent: "pilot.worker",
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const input: { path: string } = { path: "src/new.ts" };
		assert.equal(guardPilotWorkerToolCall(parsed.policy, undefined, "write", input), undefined);
		assert.equal(input.path, path.join(project, "src", "new.ts"));
		assert.match(guardPilotWorkerToolCall(parsed.policy, undefined, "bash", { command: "pwd" })?.reason ?? "", /not allowed/);

		symlinkSync(outside, path.join(project, "src", "escape"), "dir");
		assert.match(
			guardPilotWorkerToolCall(parsed.policy, undefined, "write", { path: "src/escape/outside.ts" })?.reason ?? "",
			/outside the authorized roots/,
		);
		discardPilotDelegationPolicy({ events, requestId: "test", policy });
	});

	test("the loaded Pilot extension enforces the policy inside a pi-subagents Worker child", async () => {
		const { project, events, policy } = await policyFixture();
		const previousChild = process.env.PI_SUBAGENT_CHILD;
		const previousAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_CHILD_AGENT = "pilot.worker";
		try {
			const hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
			let activeTools: string[] = [...tools, "subagent_wait", "subagent_supervisor"];
			const transitions: string[][] = [];
			pilot({
				events,
				registerCommand() {},
				on(name: string, handler: any) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
				appendEntry() {},
				getActiveTools() { return [...activeTools]; },
				setActiveTools(next: string[]) { activeTools = [...next]; transitions.push([...next].sort()); },
			} as never);
			const ctx = {
				cwd: project,
				ui: { notify() {}, setStatus() {} },
				sessionManager: { getBranch: () => [] },
			};
			const runtime = createPilotWorkerCapability(policy);
			for (const handler of hooks.get("before_agent_start") ?? []) {
				await handler({ prompt: `${createPilotWorkerPolicyHeader(runtime)}\nImplement.` }, ctx);
			}
			assert.deepEqual(transitions[0], [...bootstrapTools].sort(), "runtime-added child tools must be removed before capability consumption");
			assert.deepEqual([...activeTools].sort(), [...tools].sort());
			const input = { path: "src/from-child.ts" };
			let outcome: unknown;
			for (const handler of hooks.get("tool_call") ?? []) outcome = await handler({ toolName: "write", input }, ctx);
			assert.equal(outcome, undefined);
			assert.equal(input.path, path.join(project, "src", "from-child.ts"));
			for (const handler of hooks.get("tool_call") ?? []) outcome = await handler({ toolName: "bash", input: { command: "pwd" } }, ctx);
			assert.match((outcome as { reason?: string })?.reason ?? "", /not allowed/);
			activeTools.push("subagent_supervisor");
			for (const handler of hooks.get("tool_call") ?? []) outcome = await handler({ toolName: "subagent_supervisor", input: {} }, ctx);
			assert.match((outcome as { reason?: string })?.reason ?? "", /not allowed/);
		} finally {
			if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = previousChild;
			if (previousAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
			else process.env.PI_SUBAGENT_CHILD_AGENT = previousAgent;
			discardPilotDelegationPolicy({ events, requestId: "test", policy });
		}
	});

	test("keeps a Worker with an invalid capability fully blocked after bootstrap reduction", async () => {
		const previousChild = process.env.PI_SUBAGENT_CHILD;
		const previousAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_CHILD_AGENT = "pilot.worker";
		try {
			const hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
			let activeTools = [...tools];
			pilot({
				events: { on() {}, emit() {} },
				registerCommand() {},
				on(name: string, handler: any) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
				appendEntry() {},
				getActiveTools() { return [...activeTools]; },
				setActiveTools(next: string[]) { activeTools = [...next]; },
			} as never);
			const ctx = { cwd: process.cwd(), ui: { notify() {}, setStatus() {} }, sessionManager: { getBranch: () => [] } };
			for (const handler of hooks.get("before_agent_start") ?? []) await handler({ prompt: "Task without a policy." }, ctx);
			assert.deepEqual([...activeTools].sort(), [...bootstrapTools].sort());
			let outcome: unknown;
			for (const handler of hooks.get("tool_call") ?? []) outcome = await handler({ toolName: "read", input: { path: "README.md" } }, ctx);
			assert.match((outcome as { reason?: string })?.reason ?? "", /policy is unavailable/);
		} finally {
			if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = previousChild;
			if (previousAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
			else process.env.PI_SUBAGENT_CHILD_AGENT = previousAgent;
		}
	});

	test("consumes a fixed-runner long-task capability in an independent Worker process", { timeout: 15_000 }, async () => {
		const originalTask = `Implement the approved handoff.\n${"evidence line\n".repeat(700)}`;
		const { project, events, policy } = await policyFixture(originalTask);
		const runtime = createPilotWorkerCapability(policy);
		const header = createPilotWorkerPolicyHeader(runtime);
		const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
		const required = JSON.parse(readFileSync(path.join(repositoryRoot, "agent", "required-external-packages.json"), "utf8")) as { packages: string[] };
		const source = required.packages.find((entry) => entry.startsWith("git:") && entry.includes("pi-subagents@"));
		const pin = source?.match(/@([a-f0-9]{40})$/)?.[1];
		assert.ok(source && pin, "the fixed pi-subagents source and commit are required");
		const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = configuredAgentDir === "~"
			? homedir()
			: configuredAgentDir?.startsWith("~/")
				? path.join(homedir(), configuredAgentDir.slice(2))
				: configuredAgentDir || path.join(homedir(), ".pi", "agent");
		const externalRoot = process.env.PILOT_TEST_PI_SUBAGENTS_ROOT
			?? path.join(agentDir, "git", source.slice(4, -(pin.length + 1)));
		execFileSync("git", ["-C", externalRoot, "cat-file", "-e", `${pin}^{commit}`]);
		const pinnedRoot = mkdtempSync(path.join(tmpdir(), "pilot-fixed-subagents-"));
		roots.push(pinnedRoot);
		const archive = execFileSync("git", ["-C", externalRoot, "archive", "--format=tar", pin], { maxBuffer: 50 * 1024 * 1024 });
		execFileSync("tar", ["-x", "-C", pinnedRoot], { input: archive, maxBuffer: 50 * 1024 * 1024 });
		symlinkSync(path.join(externalRoot, "node_modules"), path.join(pinnedRoot, "node_modules"), "dir");
		const piArgsPath = path.join(pinnedRoot, "src", "runs", "shared", "pi-args.ts");
		const fixedRunner = await import(pathToFileURL(piArgsPath).href) as {
			buildPiArgs(input: Record<string, unknown>): { args: string[]; tempDir?: string };
			cleanupTempDir(tempDir: string | undefined): void;
		};
		const built = fixedRunner.buildPiArgs({
			baseArgs: [],
			task: `${header}\n${originalTask}`,
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: [...tools],
			childAgentName: "pilot.worker",
		});
		try {
			const toolsIndex = built.args.indexOf("--tools");
			assert.notEqual(toolsIndex, -1);
			assert.deepEqual((built.args[toolsIndex + 1] ?? "").split(",").sort(), [...tools].sort(), "the fixed runner must register all authorized Worker tools");
			const taskArg = built.args.find((arg) => arg.startsWith("@") && path.basename(arg.slice(1)) === "task.md");
			assert.ok(taskArg, "the fixed runner must route this task through @task.md");
			const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
			const fileProcessorPath = path.join(path.dirname(piEntry), "cli", "file-processor.js");
			const fileProcessor = await import(pathToFileURL(fileProcessorPath).href) as {
				processFileArguments(files: string[]): Promise<{ text: string }>;
			};
			const expanded = await fileProcessor.processFileArguments([taskArg.slice(1)]);
			assert.match(expanded.text, /^<file name="[^"\r\n]*[\\/]task\.md">\nTask: PILOT_WORKER_POLICY_V1 /);
			const childPath = path.join(import.meta.dirname, "fixtures", "worker-policy-child.ts");
			const output = execFileSync(process.execPath, ["--experimental-strip-types", childPath], {
				encoding: "utf8",
				input: expanded.text,
				maxBuffer: 1024 * 1024,
				env: {
					...process.env,
					PI_SUBAGENT_CHILD: "1",
					PI_SUBAGENT_CHILD_AGENT: "pilot.worker",
					PILOT_TEST_CHILD_CWD: project,
				},
			});
			const child = JSON.parse(output) as { activeTools: string[]; input: { path: string }; outcome?: unknown };
			assert.deepEqual(child.activeTools, [...tools].sort());
			assert.equal(child.input.path, path.join(project, "src", "from-fixed-runner.ts"));
			assert.equal(Object.hasOwn(child, "outcome"), false);
			assert.equal(existsSync(runtime.capabilityPath), false, "the child must atomically consume the one-shot capability");
			assert.equal(parsePilotWorkerPolicyPrompt({
				prompt: expanded.text,
				cwd: project,
				activeTools: bootstrapTools,
				childAgent: "pilot.worker",
			}).ok, false, "the cross-process capability must not replay");
		} finally {
			fixedRunner.cleanupTempDir(built.tempDir);
			discardPilotWorkerCapability(runtime);
			discardPilotDelegationPolicy({ events, requestId: "test", policy });
		}
	});

	test("registers the six fixed Worker tools required by the public V1 runner", () => {
		const source = readFileSync(expectedPilotProfile("pilot.worker").filePath, "utf8");
		assert.match(source, /^tools: read, grep, find, ls, edit, write$/m);
	});

	test("blocks every tool when the runtime policy was not established", () => {
		assert.match(guardPilotWorkerToolCall(undefined, "missing header", "read", { path: "README.md" })?.reason ?? "", /unavailable/);
	});
});
