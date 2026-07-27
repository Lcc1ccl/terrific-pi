import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import pilot from "../extensions/pilot.ts";
import {
	PILOT_DELEGATION_REQUEST_EVENT,
	PILOT_DELEGATION_RESPONSE_EVENT,
	PILOT_DELEGATION_STARTED_EVENT,
} from "../lib/delegation.ts";

class Events {
	private readonly handlers = new Map<string, Array<(value: unknown) => void>>();

	on(event: string, handler: (value: unknown) => void): () => void {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
		return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
	}

	emit(event: string, value: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(value);
	}
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createProject(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pilot-copilot-"));
	roots.push(root);
	const project = path.join(root, "project");
	mkdirSync(path.join(project, "src"), { recursive: true });
	const git = (args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
	git(["init"]);
	git(["config", "user.email", "pilot@example.test"]);
	git(["config", "user.name", "Pilot Test"]);
	writeFileSync(path.join(project, "src", "feature.ts"), "export const feature = false;\n", "utf8");
	writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "copilot", scripts: {
		pretest: "node --version",
		test: "node --version",
		posttest: "node --version",
	} }), "utf8");
	git(["add", "."]);
	git(["commit", "-m", "initial"]);
	return project;
}

function createHarness(
	project: string,
	trusted = true,
	reviewerVerdict: "pass" | "fail" = "pass",
	plannerNeedsDecision = false,
	plannerControl?: { started(): void; wait: Promise<void> },
	workerControl?: { started(): void; wait: Promise<void> },
) {
	const events = new Events();
	const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
	const hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	let branchEntries: Array<{ type: string; customType: string; data: unknown }> = entries;
	const notifications: string[] = [];
	const statuses = new Map<string, string | undefined>();
	let delegationLaunches = 0;
	let workerLaunches = 0;
	let reviewerLaunches = 0;
	const reviewerTasks: string[] = [];

	events.on(PILOT_DELEGATION_REQUEST_EVENT, (value) => {
		const request = value as { requestId: string; agent: string; task: string; artifacts?: boolean };
		assert.equal(request.artifacts, false);
		delegationLaunches++;
		events.emit(PILOT_DELEGATION_STARTED_EVENT, { version: 1, requestId: request.requestId });
		if (request.agent === "pilot.planner") {
			const completePlanner = () => events.emit(PILOT_DELEGATION_RESPONSE_EVENT, {
				version: 1,
				requestId: request.requestId,
				status: "completed",
				agent: request.agent,
				output: JSON.stringify({
					goal: "Enable the feature.",
					scope: ["src/feature.ts"],
					nonGoals: ["Do not change package metadata."],
					acceptance: ["Feature is enabled."],
					writeRoots: ["src"],
					verificationCommands: ["npm test"],
					risks: ["The package test script executes trusted project code."],
					...(plannerNeedsDecision ? { needsDecision: "Choose whether this risky scope is acceptable." } : {}),
				}),
			});
			if (plannerControl) {
				plannerControl.started();
				void plannerControl.wait.then(completePlanner);
			} else {
				completePlanner();
			}
			return;
		}
		if (request.agent === "pilot.worker") {
			workerLaunches++;
			writeFileSync(path.join(project, "src", "feature.ts"), "export const feature = true;\n", "utf8");
			const completeWorker = () => events.emit(PILOT_DELEGATION_RESPONSE_EVENT, {
				version: 1,
				requestId: request.requestId,
				status: "completed",
				agent: request.agent,
				runId: "worker-run",
				output: JSON.stringify({ summary: "Enabled the feature.", changedFiles: ["src/feature.ts"], residualRisks: [] }),
			});
			if (workerControl) {
				workerControl.started();
				void workerControl.wait.then(completeWorker);
			} else {
				completeWorker();
			}
			return;
		}
		reviewerLaunches++;
		reviewerTasks.push(request.task);
			events.emit(PILOT_DELEGATION_RESPONSE_EVENT, {
			version: 1,
			requestId: request.requestId,
			status: "completed",
			agent: request.agent,
			runId: "reviewer-run",
			output: JSON.stringify({
				verdict: reviewerVerdict,
				findings: reviewerVerdict === "fail" ? ["Missing required edge-case evidence."] : [],
				validationGaps: [],
				scopeDrift: [],
				residualRisks: [],
				evidence: ["Reviewed the actual Git diff."],
				acceptanceEvidence: [{ criterion: "Feature is enabled.", evidence: "src/feature.ts now exports true." }],
			}),
		});
	});

	pilot({
		events,
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		getActiveTools() { return ["read", "grep", "find", "ls", "bash", "edit", "write"]; },
		setActiveTools() {},
	} as never);

	const ctx = {
		cwd: project,
		hasUI: false,
		mode: "print",
		isIdle: () => true,
		isProjectTrusted: () => trusted,
		ui: {
			notify(message: string) { notifications.push(message); },
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
		},
		sessionManager: { getBranch: () => branchEntries },
	};
	const emit = async (event: string, value: unknown) => {
		let result: unknown;
		for (const handler of hooks.get(event) ?? []) result = await handler(value, ctx);
		return result;
	};
	return {
		commands,
		ctx,
		emit,
		entries,
		notifications,
		statuses,
		getLaunches: () => ({ delegationLaunches, workerLaunches, reviewerLaunches }),
		getReviewerTasks: () => [...reviewerTasks],
		setBranch(next: Array<{ type: string; customType: string; data: unknown }>) { branchEntries = next; },
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Pilot integration state.");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function plan(harness: ReturnType<typeof createHarness>): Promise<void> {
	await harness.emit("session_start", { reason: "startup" });
	assert.deepEqual(await harness.emit("input", { source: "interactive", text: "Enable the feature." }), { action: "continue" });
	await harness.commands.get("pilot")!.handler("", harness.ctx);
	assert.deepEqual(await harness.emit("input", { source: "interactive", text: "Enable the feature." }), { action: "handled" });
	assert.ok(harness.notifications.some((message) => message.startsWith("Pilot ready for work:")));
}

describe("Pilot manual primary-solo extension flow", () => {
	test("discloses the complete plan, risks, and resolved package scripts before authorization", async () => {
		const harness = createHarness(createProject());
		await plan(harness);
		assert.equal(harness.commands.has("mode"), false);
		assert.deepEqual(harness.getLaunches(), { delegationLaunches: 1, workerLaunches: 0, reviewerLaunches: 0 });

		await harness.commands.get("pilot")!.handler("work", harness.ctx);
		const gate = harness.notifications.at(-1) ?? "";
		assert.match(gate, /# Requirements/);
		assert.match(gate, /Enable the feature\./);
		assert.match(gate, /Do not change package metadata\./);
		assert.match(gate, /Feature is enabled\./);
		assert.match(gate, /trusted project code/);
		assert.match(gate, /npm test/);
		assert.match(gate, /pretest => node --version/);
		assert.match(gate, /test => node --version/);
		assert.match(gate, /posttest => node --version/);
		assert.match(gate, /package\.json sha256: [a-f0-9]{64}/);
		assert.match(gate, /verification deadline: 900000 ms per command/);
		assert.match(gate, /tools: edit, find, grep, ls, read, write/);
		assert.match(gate, /baseline: [a-f0-9]{64}(?:\n|$)/);
		assert.match(gate, /digest: [a-f0-9]{64}/);
		assert.deepEqual(harness.getLaunches(), { delegationLaunches: 1, workerLaunches: 0, reviewerLaunches: 0 });

		const headlessSummary = gate.replace(/^Pilot Work Envelope\n/, "").replace(/\nRun \/pilot work --confirm [a-f0-9]{64} to authorize\.$/, "");
		let dialogSummary = "";
		harness.ctx.hasUI = true;
		(harness.ctx.ui as any).confirm = async (_title: string, body: string) => {
			dialogSummary = body;
			return false;
		};
		await harness.commands.get("pilot")!.handler("work", harness.ctx);
		assert.equal(dialogSummary, headlessSummary, "TUI and headless Work Gates must use the identical summary");
		assert.deepEqual(harness.getLaunches(), { delegationLaunches: 1, workerLaunches: 0, reviewerLaunches: 0 });
	});

	test("refuses to execute package scripts for an untrusted project", async () => {
		const harness = createHarness(createProject(), false);
		await plan(harness);
		await harness.commands.get("pilot")!.handler("work", harness.ctx);
		assert.match(harness.notifications.at(-1) ?? "", /trusted project/i);
		assert.deepEqual(harness.getLaunches(), { delegationLaunches: 1, workerLaunches: 0, reviewerLaunches: 0 });
	});

	test("discards an in-flight Planner completion after a session-tree change", async () => {
		const project = createProject();
		let releasePlanner!: () => void;
		let markStarted!: () => void;
		const wait = new Promise<void>((resolve) => { releasePlanner = resolve; });
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const harness = createHarness(project, true, "pass", false, { started: markStarted, wait });
		await harness.emit("session_start", { reason: "startup" });
		await harness.commands.get("pilot")!.handler("", harness.ctx);
		const pendingInput = harness.emit("input", { source: "interactive", text: "Implement after a delayed plan." });
		await started;
		await harness.emit("session_tree", {});
		releasePlanner();
		await pendingInput;

		const bundleEntry = harness.entries.find((entry) => entry.customType === "terrific-pi:pilot:bundle-v1");
		assert.ok(bundleEntry);
		const bundleDir = (bundleEntry!.data as { bundleDir: string }).bundleDir;
		const manifest = JSON.parse(readFileSync(path.join(bundleDir, "manifest.json"), "utf8")) as { status: string; phase: string };
		assert.equal(manifest.status, "cancelled");
		assert.equal(manifest.phase, "terminal");
		assert.match(readFileSync(path.join(bundleDir, "receipt.json"), "utf8"), /session tree changed/);
		assert.equal(harness.notifications.some((message) => /ready for work/.test(message)), false);
	});

	test("lets the execution owner write the final cancelled receipt after a session-tree change", async () => {
		const project = createProject();
		let releaseWorker!: () => void;
		let markWorkerStarted!: () => void;
		const wait = new Promise<void>((resolve) => { releaseWorker = resolve; });
		const started = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
		const harness = createHarness(project, true, "pass", false, undefined, { started: markWorkerStarted, wait });
		await plan(harness);
		await harness.commands.get("pilot")!.handler("work", harness.ctx);
		const digest = (harness.notifications.at(-1) ?? "").match(/digest: ([a-f0-9]{64})/)?.[1];
		assert.ok(digest);
		const pendingWork = harness.commands.get("pilot")!.handler(`work --confirm ${digest}`, harness.ctx);
		await started;
		await harness.emit("session_tree", {});
		await harness.emit("session_tree", {});
		await harness.commands.get("pilot")!.handler("cancel", harness.ctx);
		await harness.commands.get("pilot")!.handler("off", harness.ctx);
		assert.match(harness.notifications.at(-1) ?? "", /wait or cancel before deactivating/i, "execution ownership must remain until the Worker reports terminal state");
		releaseWorker();
		await pendingWork;

		const bundleEntry = harness.entries.find((entry) => entry.customType === "terrific-pi:pilot:bundle-v1");
		assert.ok(bundleEntry);
		const bundleDir = (bundleEntry!.data as { bundleDir: string }).bundleDir;
		const receipt = JSON.parse(readFileSync(path.join(bundleDir, "receipt.json"), "utf8")) as { status: string; changedFiles?: string[]; phase?: string };
		assert.equal(receipt.status, "cancelled");
		assert.deepEqual(receipt.changedFiles, ["src/feature.ts"]);
		assert.equal(receipt.phase, undefined);
	});

	test("shows terminal-response pending after cancellation on the original branch", async () => {
		const project = createProject();
		let releaseWorker!: () => void;
		let markWorkerStarted!: () => void;
		const wait = new Promise<void>((resolve) => { releaseWorker = resolve; });
		const started = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
		const harness = createHarness(project, true, "pass", false, undefined, { started: markWorkerStarted, wait });
		await plan(harness);
		await harness.commands.get("pilot")!.handler("work", harness.ctx);
		const digest = (harness.notifications.at(-1) ?? "").match(/digest: ([a-f0-9]{64})/)?.[1];
		assert.ok(digest);
		const pendingWork = harness.commands.get("pilot")!.handler(`work --confirm ${digest}`, harness.ctx);
		await started;
		await harness.commands.get("pilot")!.handler("cancel", harness.ctx);
		assert.match(harness.statuses.get("pilot") ?? "", /work:terminal-pending/);
		await harness.commands.get("pilot")!.handler("status", harness.ctx);
		assert.match(harness.notifications.at(-1) ?? "", /execution owner active; terminal response pending.*working/);
		releaseWorker();
		await pendingWork;
	});

	test("keeps parent writes closed when execution crosses to an inactive session branch", async () => {
		const project = createProject();
		let releaseWorker!: () => void;
		let markWorkerStarted!: () => void;
		const wait = new Promise<void>((resolve) => { releaseWorker = resolve; });
		const started = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
		const harness = createHarness(project, true, "pass", false, undefined, { started: markWorkerStarted, wait });
		await plan(harness);
		await harness.commands.get("pilot")!.handler("work", harness.ctx);
		const digest = (harness.notifications.at(-1) ?? "").match(/digest: ([a-f0-9]{64})/)?.[1];
		assert.ok(digest);
		const pendingWork = harness.commands.get("pilot")!.handler(`work --confirm ${digest}`, harness.ctx);
		await started;
		harness.setBranch([]);
		await harness.emit("session_tree", {});

		assert.deepEqual(await harness.emit("input", { source: "interactive", text: "Start another writer." }), { action: "handled" });
		const blocked = await harness.emit("tool_call", { toolName: "write", input: { path: "src/other.ts", content: "unsafe" } }) as { block?: boolean; reason?: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason ?? "", /authorized Worker/);
		assert.match(harness.statuses.get("pilot") ?? "", /work:terminal-pending/);
		await harness.commands.get("pilot")!.handler("status", harness.ctx);
		assert.match(harness.notifications.at(-1) ?? "", /execution owner active; terminal response pending/);

		releaseWorker();
		await pendingWork;
		assert.equal(harness.statuses.get("pilot"), undefined, "HUD must clear after the cross-branch execution owner releases");
		const bundleEntry = harness.entries.find((entry) => entry.customType === "terrific-pi:pilot:bundle-v1");
		assert.ok(bundleEntry);
		const receipt = JSON.parse(readFileSync(path.join((bundleEntry!.data as { bundleDir: string }).bundleDir, "receipt.json"), "utf8")) as { status: string };
		assert.equal(receipt.status, "cancelled");
	});

	test("keeps execution receipt ownership across repeated tree changes during verification", { timeout: 15_000 }, async () => {
		const project = createProject();
		writeFileSync(path.join(project, "verify.cjs"), [
			"const fs = require('node:fs');",
			"fs.writeFileSync('verification.started', 'yes');",
			"process.on('SIGTERM', () => {});",
			"setInterval(() => {}, 1000);",
		].join("\n"), "utf8");
		writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "copilot", scripts: { test: "node verify.cjs" } }), "utf8");
		execFileSync("git", ["add", "."], { cwd: project });
		execFileSync("git", ["commit", "-m", "verification fixture"], { cwd: project, stdio: "ignore" });
		const harness = createHarness(project);
		await plan(harness);
		await harness.commands.get("pilot")!.handler("work", harness.ctx);
		const digest = (harness.notifications.at(-1) ?? "").match(/digest: ([a-f0-9]{64})/)?.[1];
		assert.ok(digest);
		const pendingWork = harness.commands.get("pilot")!.handler(`work --confirm ${digest}`, harness.ctx);
		await waitFor(() => existsSync(path.join(project, "verification.started")));
		await harness.emit("session_tree", {});
		await harness.emit("session_tree", {});
		await harness.commands.get("pilot")!.handler("cancel", harness.ctx);
		await pendingWork;

		const bundleEntry = harness.entries.find((entry) => entry.customType === "terrific-pi:pilot:bundle-v1");
		assert.ok(bundleEntry);
		const bundleDir = (bundleEntry!.data as { bundleDir: string }).bundleDir;
		const receipt = JSON.parse(readFileSync(path.join(bundleDir, "receipt.json"), "utf8")) as {
			status: string;
			changedFiles?: string[];
			phase?: string;
			verification?: Array<{ exitCode: number | null; termination?: string; error?: string }>;
		};
		assert.equal(receipt.status, "cancelled");
		assert.deepEqual(receipt.changedFiles, ["src/feature.ts", "verification.started"]);
		assert.equal(receipt.phase, undefined);
		assert.equal(receipt.verification?.[0]?.exitCode, null);
		assert.equal(receipt.verification?.[0]?.termination, "cancelled");
		assert.match(receipt.verification?.[0]?.error ?? "", /cancelled/i);
	});

	test("terminates planner needs-decision with a blocked receipt and no Worker", async () => {
		const harness = createHarness(createProject(), true, "pass", true);
		await harness.emit("session_start", { reason: "startup" });
		await harness.commands.get("pilot")!.handler("", harness.ctx);
		assert.deepEqual(await harness.emit("input", { source: "interactive", text: "Perform risky work." }), { action: "handled" });
		const bundleEntry = harness.entries.find((entry) => entry.customType === "terrific-pi:pilot:bundle-v1");
		assert.ok(bundleEntry);
		const bundleDir = (bundleEntry!.data as { bundleDir: string }).bundleDir;
		const manifest = JSON.parse(readFileSync(path.join(bundleDir, "manifest.json"), "utf8")) as { status: string; phase: string };
		const receipt = JSON.parse(readFileSync(path.join(bundleDir, "receipt.json"), "utf8")) as { status: string; reason: string };
		assert.deepEqual(manifest, { ...manifest, status: "blocked", phase: "terminal" });
		assert.equal(receipt.status, "blocked");
		assert.match(receipt.reason, /Choose whether this risky scope is acceptable/);
		assert.deepEqual(harness.getLaunches(), { delegationLaunches: 1, workerLaunches: 0, reviewerLaunches: 0 });
	});

	test("cancels a ready Bundle without launching a Worker", async () => {
		const harness = createHarness(createProject());
		await plan(harness);
		const bundleEntry = harness.entries.find((entry) => entry.customType === "terrific-pi:pilot:bundle-v1");
		assert.ok(bundleEntry);
		const bundleDir = (bundleEntry!.data as { bundleDir: string }).bundleDir;

		await harness.commands.get("pilot")!.handler("cancel", harness.ctx);
		assert.deepEqual(harness.getLaunches(), { delegationLaunches: 1, workerLaunches: 0, reviewerLaunches: 0 });
		assert.equal((JSON.parse(readFileSync(path.join(bundleDir, "manifest.json"), "utf8")) as { status: string }).status, "cancelled");
		assert.equal((JSON.parse(readFileSync(path.join(bundleDir, "receipt.json"), "utf8")) as { status: string }).status, "cancelled");
	});

	test("does not report a ready Bundle cancelled when terminal persistence fails", async () => {
		const harness = createHarness(createProject());
		await plan(harness);
		const bundleEntry = harness.entries.find((entry) => entry.customType === "terrific-pi:pilot:bundle-v1");
		assert.ok(bundleEntry);
		const bundleDir = (bundleEntry!.data as { bundleDir: string }).bundleDir;
		writeFileSync(path.join(bundleDir, "manifest.json"), "{", "utf8");

		await harness.commands.get("pilot")!.handler("cancel", harness.ctx);
		assert.match(harness.notifications.at(-1) ?? "", /could not be persisted; its state is unchanged/i);
		assert.doesNotMatch(harness.notifications.at(-1) ?? "", /cancelled before Work authorization/i);
	});

	test("stops after one failed review and surfaces the findings to the human", async () => {
		const harness = createHarness(createProject(), true, "fail");
		await plan(harness);
		await harness.commands.get("pilot")!.handler("work", harness.ctx);
		const digest = (harness.notifications.at(-1) ?? "").match(/digest: ([a-f0-9]{64})/)?.[1];
		assert.ok(digest);
		await harness.commands.get("pilot")!.handler(`work --confirm ${digest}`, harness.ctx);

		assert.deepEqual(harness.getLaunches(), { delegationLaunches: 3, workerLaunches: 1, reviewerLaunches: 1 });
		assert.match(harness.notifications.at(-1) ?? "", /Missing required edge-case evidence/);
		assert.doesNotMatch(harness.notifications.at(-1) ?? "", /Pilot passed/);
		const bundleEntry = harness.entries.find((entry) => entry.customType === "terrific-pi:pilot:bundle-v1");
		assert.ok(bundleEntry);
		const bundleDir = (bundleEntry!.data as { bundleDir: string }).bundleDir;
		assert.match(readFileSync(path.join(bundleDir, "reviews", "implementation-01.json"), "utf8"), /Missing required edge-case evidence/);
	});

	test("runs one authorized worker, verifies, reviews the actual diff, and persists a receipt", async () => {
		const project = createProject();
		const harness = createHarness(project);
		await plan(harness);
		await harness.commands.get("pilot")!.handler("work", harness.ctx);
		const digest = (harness.notifications.at(-1) ?? "").match(/digest: ([a-f0-9]{64})/)?.[1];
		assert.ok(digest, "headless Work Gate must print a digest");

		await harness.commands.get("pilot")!.handler(`work --confirm ${digest}`, harness.ctx);
		assert.deepEqual(harness.getLaunches(), { delegationLaunches: 3, workerLaunches: 1, reviewerLaunches: 1 });
		assert.equal(readFileSync(path.join(project, "src", "feature.ts"), "utf8"), "export const feature = true;\n");
		assert.ok(harness.notifications.some((message) => message.startsWith("Pilot passed:")));
		assert.equal(existsSync(path.join(project, ".pi-subagents")), false);
		const bundleEntry = harness.entries.find((entry) => entry.customType === "terrific-pi:pilot:bundle-v1");
		assert.ok(bundleEntry);
		const bundleDir = (bundleEntry!.data as { bundleDir: string }).bundleDir;
		assert.match(readFileSync(path.join(bundleDir, "receipt.json"), "utf8"), /"passed"/);
	});
});
