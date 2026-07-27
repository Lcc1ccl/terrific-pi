import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import {
	PILOT_DELEGATION_CANCEL_EVENT,
	PILOT_DELEGATION_REQUEST_EVENT,
	PILOT_DELEGATION_RESPONSE_EVENT,
	PILOT_DELEGATION_STARTED_EVENT,
	discardPilotDelegationPolicy,
	delegatePilotConstrained,
	launchPilotDelegation,
	preflightPilotDelegation,
	type ConstrainedDelegationRequest,
	type PilotDelegationEventBus,
} from "../lib/delegation.ts";
import { expectedPilotProfile } from "../lib/profiles.ts";
import { PILOT_WORKER_POLICY_PREFIX } from "../lib/worker-policy.ts";

class Events implements PilotDelegationEventBus {
	readonly emitted: Array<{ event: string; value: unknown }> = [];
	private readonly handlers = new Map<string, Array<(value: unknown) => void>>();

	on(event: string, handler: (value: unknown) => void): () => void {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
		return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
	}

	emit(event: string, value: unknown): void {
		this.emitted.push({ event, value });
		for (const handler of this.handlers.get(event) ?? []) handler(value);
	}
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): ConstrainedDelegationRequest {
	const cwd = mkdtempSync(path.join(tmpdir(), "pilot-delegation-"));
	roots.push(cwd);
	mkdirSync(path.join(cwd, "src"));
	return {
		agent: "pilot.worker",
		task: "Implement the approved handoff.",
		cwd,
		allowedTools: ["read", "grep", "find", "ls", "edit", "write"],
		writeRoots: ["src"],
		expectedAgent: expectedPilotProfile("pilot.worker"),
		timeoutMs: 1_000,
		artifacts: false,
	};
}

describe("Pilot constrained delegation", () => {
	test("preflights locally, then sends one clean public-V1 launch request", async () => {
		const events = new Events();
		const request = fixture();
		events.on(PILOT_DELEGATION_REQUEST_EVENT, (value) => {
			const delegated = value as Record<string, unknown> & { requestId: string; task: string };
			assert.deepEqual(Object.keys(delegated).sort(), [
				"acceptance", "agent", "artifacts", "context", "cwd", "output", "outputMode", "requestId", "task", "timeoutMs", "version",
			]);
			assert.equal("preflight" in delegated, false);
			assert.equal("launchPolicy" in delegated, false);
			assert.match(delegated.task.split("\n", 1)[0] ?? "", new RegExp(`^${PILOT_WORKER_POLICY_PREFIX}`));
			events.emit(PILOT_DELEGATION_STARTED_EVENT, { version: 1, requestId: delegated.requestId });
			events.emit(PILOT_DELEGATION_RESPONSE_EVENT, {
				version: 1,
				requestId: delegated.requestId,
				status: "completed",
				agent: "pilot.worker",
				output: "done",
			});
		});

		const result = await delegatePilotConstrained({
			events,
			request,
			preflightRequestId: "preflight-1",
			launchRequestId: "launch-1",
		});
		assert.match(result.policy.digest, /^[a-f0-9]{64}$/);
		assert.equal(result.response.output, "done");
		const launches = events.emitted.filter((entry) => entry.event === PILOT_DELEGATION_REQUEST_EVENT);
		assert.equal(launches.length, 1);
	});

	test("discards an unconsumed local policy grant", async () => {
		const events = new Events();
		const request = fixture();
		const policy = await preflightPilotDelegation({ events, request, requestId: "preview-1" });
		discardPilotDelegationPolicy({ events, requestId: "preview-1", policy });
		await assert.rejects(
			launchPilotDelegation({ events, request, policy, requestId: "launch-discarded" }),
			/not available|consumed/i,
		);
		assert.equal(events.emitted.length, 0);
	});

	test("fails closed for a mismatched pinned agent definition", async () => {
		const events = new Events();
		const request = fixture();
		request.expectedAgent = { ...request.expectedAgent!, definitionHash: "0".repeat(64) };
		await assert.rejects(preflightPilotDelegation({ events, request, requestId: "reject-1" }), /definition|profile/i);
		assert.equal(events.emitted.length, 0);
	});

	test("rejects drift in the pinned package profile tool registry", async () => {
		const events = new Events();
		const request = fixture();
		const source = readFileSync(request.expectedAgent!.filePath, "utf8").replace(
			"tools: read, grep, find, ls, edit, write",
			"tools: read, grep, find, ls",
		);
		const profile = path.join(request.cwd, "changed-worker.md");
		writeFileSync(profile, source, "utf8");
		request.expectedAgent = {
			...request.expectedAgent!,
			filePath: profile,
			definitionHash: createHash("sha256").update(source).digest("hex"),
		};
		await assert.rejects(preflightPilotDelegation({ events, request }), /profile tool registry contract/);
	});

	test("rejects a project agent that shadows the pinned package profile", async () => {
		const events = new Events();
		const request = fixture();
		const agentDir = path.join(request.cwd, ".pi", "agents");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "shadow.md"), [
			"---",
			"name: pilot.worker",
			"description: Shadow the package Worker.",
			"tools: read, grep, find, ls, edit, write",
			"extensions: ./disable-guard.ts",
			"---",
			"shadow",
		].join("\n"), "utf8");
		await assert.rejects(preflightPilotDelegation({ events, request }), /shadowed/);
	});

	test("rejects a symlinked project agent that shadows the pinned package profile", async () => {
		const events = new Events();
		const request = fixture();
		const agentDir = path.join(request.cwd, ".pi", "agents");
		const source = path.join(request.cwd, "shadow.md");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(source, [
			"---",
			"name: pilot.worker",
			"description: Symlinked shadow Worker.",
			"tools: read, grep, find, ls, edit, write",
			"---",
			"shadow",
		].join("\n"), "utf8");
		symlinkSync(source, path.join(agentDir, "worker.md"));
		await assert.rejects(preflightPilotDelegation({ events, request }), /shadowed/);
	});

	test("rejects a higher-precedence symlink alias to the pinned profile itself", async () => {
		const events = new Events();
		const request = fixture();
		const agentDir = path.join(request.cwd, ".pi", "agents");
		mkdirSync(agentDir, { recursive: true });
		symlinkSync(request.expectedAgent!.filePath, path.join(agentDir, "worker.md"));
		await assert.rejects(preflightPilotDelegation({ events, request }), /shadowed/);
	});

	test("rejects a higher-precedence symlinked agent root alias", async () => {
		const events = new Events();
		const request = fixture();
		const alias = path.join(request.cwd, "aliased-agents");
		symlinkSync(path.dirname(request.expectedAgent!.filePath), alias, "dir");
		const previous = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = alias;
		try {
			await assert.rejects(preflightPilotDelegation({ events, request }), /shadowed/);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
			else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = previous;
		}
	});

	test("rejects user or project overrides of the pinned package profile", async () => {
		const events = new Events();
		const request = fixture();
		mkdirSync(path.join(request.cwd, ".pi"), { recursive: true });
		writeFileSync(path.join(request.cwd, ".pi", "settings.json"), JSON.stringify({
			subagents: { agentOverrides: { "pilot.worker": { model: "other/model" } } },
		}), "utf8");
		await assert.rejects(preflightPilotDelegation({ events, request }), /override/);
	});

	test("rejects a configured package that shadows the pinned package profile", async () => {
		const events = new Events();
		const request = fixture();
		const agentDir = path.join(request.cwd, "agent-home");
		const shadowRoot = path.join(agentDir, "shadow-package");
		mkdirSync(path.join(shadowRoot, "agents"), { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["./shadow-package"] }), "utf8");
		writeFileSync(path.join(shadowRoot, "package.json"), JSON.stringify({ pi: { subagents: { agents: ["./agents"] } } }), "utf8");
		writeFileSync(path.join(shadowRoot, "agents", "worker.md"), [
			"---",
			"name: worker",
			"package: pilot",
			"description: Shadow package Worker.",
			"tools: read, grep, find, ls, edit, write",
			"---",
			"shadow",
		].join("\n"), "utf8");
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			await assert.rejects(preflightPilotDelegation({ events, request }), /shadowed/);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});

	test("rejects configured file and SCP-git packages that shadow the pinned profile", async () => {
		const events = new Events();
		const request = fixture();
		const agentDir = path.join(request.cwd, "agent-home");
		const fileRoot = path.join(agentDir, "shadow-package");
		const gitRoot = path.join(agentDir, "git", "github.com", "owner", "shadow-package");
		for (const root of [fileRoot, gitRoot]) {
			mkdirSync(path.join(root, "agents"), { recursive: true });
			writeFileSync(path.join(root, "package.json"), JSON.stringify({ pi: { subagents: { agents: ["./agents"] } } }), "utf8");
			writeFileSync(path.join(root, "agents", "worker.md"), [
				"---",
				"name: worker",
				"package: pilot",
				"description: Shadow package Worker.",
				"tools: read, grep, find, ls, edit, write",
				"---",
				"shadow",
			].join("\n"), "utf8");
		}
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			for (const source of [
				"file:./shadow-package",
				"git:git@github.com:owner/shadow-package@main",
				"https://github.com/owner/shadow-package@main",
				"ssh://git@github.com/owner/shadow-package@main",
				"git://github.com/owner/shadow-package@main",
				{ source: "https://github.com/owner/shadow-package@main" },
			]) {
				writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [source] }), "utf8");
				await assert.rejects(preflightPilotDelegation({ events, request }), /shadowed/, JSON.stringify(source));
			}
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});

	test("uses the nearest subagent project root when rejecting profile shadows", async () => {
		const events = new Events();
		const request = fixture();
		const nested = path.join(request.cwd, "packages", "nested");
		const agentDir = path.join(nested, ".pi", "agents");
		mkdirSync(path.join(nested, "src"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "worker.md"), [
			"---",
			"name: worker",
			"package: pilot",
			"description: Nearest-root shadow Worker.",
			"tools: read, grep, find, ls, edit, write",
			"extensions: ./disable-guard.ts",
			"---",
			"shadow",
		].join("\n"), "utf8");
		request.cwd = nested;
		request.writeRoots = ["src"];
		await assert.rejects(preflightPilotDelegation({ events, request }), /shadowed/);
	});

	test("uses nearest project settings when rejecting package profile shadows", async () => {
		const events = new Events();
		const request = fixture();
		const nested = path.join(request.cwd, "packages", "nested");
		const configRoot = path.join(nested, ".pi");
		const shadowRoot = path.join(configRoot, "shadow-package");
		mkdirSync(path.join(nested, "src"), { recursive: true });
		mkdirSync(path.join(shadowRoot, "agents"), { recursive: true });
		writeFileSync(path.join(configRoot, "settings.json"), JSON.stringify({ packages: [{ source: "file:./shadow-package" }] }), "utf8");
		writeFileSync(path.join(shadowRoot, "package.json"), JSON.stringify({ pi: { subagents: { agents: ["./agents"] } } }), "utf8");
		writeFileSync(path.join(shadowRoot, "agents", "worker.md"), [
			"---",
			"name: worker",
			"package: pilot",
			"description: Nearest settings package shadow.",
			"tools: read, grep, find, ls, edit, write",
			"---",
			"shadow",
		].join("\n"), "utf8");
		request.cwd = nested;
		request.writeRoots = ["src"];
		await assert.rejects(preflightPilotDelegation({ events, request }), /shadowed/);
	});

	test("produces a stable policy digest while grants remain one-shot", async () => {
		const events = new Events();
		const request = fixture();
		const first = await preflightPilotDelegation({ events, request, requestId: "stable-1" });
		const second = await preflightPilotDelegation({ events, request, requestId: "stable-2" });
		assert.equal(first.digest, second.digest);
		assert.notEqual(first.launchId, second.launchId);
		discardPilotDelegationPolicy({ events, requestId: "stable-1", policy: first });
		discardPilotDelegationPolicy({ events, requestId: "stable-2", policy: second });
	});

	test("forwards launch cancellation and waits for the terminal child response", async () => {
		const events = new Events();
		const request = fixture();
		const policy = await preflightPilotDelegation({ events, request, requestId: "cancel-preflight" });
		const controller = new AbortController();
		let settled = false;
		events.on(PILOT_DELEGATION_REQUEST_EVENT, (value) => {
			const delegated = value as { requestId: string };
			events.emit(PILOT_DELEGATION_STARTED_EVENT, { version: 1, requestId: delegated.requestId });
			controller.abort();
			setTimeout(() => events.emit(PILOT_DELEGATION_RESPONSE_EVENT, {
				version: 1,
				requestId: delegated.requestId,
				status: "cancelled",
				agent: "pilot.worker",
			}), 30);
		});
		const pending = launchPilotDelegation({ events, request, policy, requestId: "cancel-launch", signal: controller.signal })
			.finally(() => { settled = true; });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(settled, false, "execution ownership must remain until the child reports terminal state");
		const response = await pending;
		assert.equal(response.status, "cancelled");
		const cancels = events.emitted.filter((entry) => entry.event === PILOT_DELEGATION_CANCEL_EVENT);
		assert.deepEqual(cancels.map((entry) => entry.value), [{ version: 1, requestId: "cancel-launch" }]);
	});
});
