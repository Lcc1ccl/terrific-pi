import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	PILOT_ACTIVATION_ENTRY_TYPE,
	activateManualPilot,
	activationSource,
	deactivateManualPilot,
	isPilotActive,
	restoreActivationState,
	toActivationEntry,
	type PilotActivationState,
} from "../lib/activation.ts";
import {
	createPilotBundle,
	openPilotBundle,
	readPilotBundleArtifact,
	updatePilotBundle,
	type PilotBundle,
} from "../lib/bundle.ts";
import {
	PILOT_BUNDLE_ENTRY_TYPE,
	restorePilotBundle,
	toPilotBundleEntry,
} from "../lib/bundle-session.ts";
import {
	launchPilotDelegation,
	preflightPilotDelegation,
	delegatePilotConstrained,
	discardPilotDelegationPolicy,
	type ConstrainedDelegationRequest,
	type PilotDelegationEventBus,
	type PilotResolvedLaunchPolicy,
} from "../lib/delegation.ts";
import {
	assertCleanPrimarySoloBaseline,
	buildExecutionEnvelope,
	captureGitBaseline,
	resolveGitCommonDir,
	type DelegatedProfileBinding,
	type ExecutionEnvelope,
} from "../lib/envelope.ts";
import {
	materializePilotPlan,
	parsePilotPlanningResult,
} from "../lib/planning.ts";
import { expectedPilotProfile } from "../lib/profiles.ts";
import { persistPilotPlanningReceipt } from "../lib/receipt.ts";
import { runPrimarySolo } from "../lib/primary-solo.ts";
import {
	guardPilotWorkerToolCall,
	parsePilotWorkerPolicyPrompt,
	type PilotWorkerRuntimePolicy,
} from "../lib/worker-policy.ts";

const PILOT_STATUS_KEY = "pilot";
const DEFAULT_STATE: PilotActivationState = { modePolicy: "edit", manualPilotActive: false };
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const WORKER_TOOLS = [...READ_ONLY_TOOLS, "edit", "write"];
const PARENT_READ_ONLY_TOOLS = new Set([...READ_ONLY_TOOLS, "aux_summarize", "web_research"]);
const PARENT_MUTATION_BLOCK_REASON = "Pilot is active; project mutations require the authorized Worker.";

function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, level);
}

function policyBinding(policy: PilotResolvedLaunchPolicy, expectedAgent: ReturnType<typeof expectedPilotProfile>): DelegatedProfileBinding {
	return {
		agent: policy.agent,
		agentDefinitionHash: policy.agentDefinitionHash,
		policyDigest: policy.digest,
		allowedTools: [...policy.allowedTools],
		writeRoots: [...policy.writeRoots],
		expectedAgent,
	};
}

function plannerTask(goal: string): string {
	return [
		"Create a constrained Pilot primary-solo plan for the explicit user goal below.",
		"Use only facts you can inspect in the current project. Return the required JSON contract exactly.",
		"<user-goal>",
		goal,
		"</user-goal>",
	].join("\n");
}

function workerTask(bundle: PilotBundle): string {
	return [
		"Implement the approved Pilot handoff exactly. The control plane enforces your write roots.",
		"<requirements>",
		readPilotBundleArtifact(bundle, "requirements"),
		"</requirements>",
		"<handoff>",
		readPilotBundleArtifact(bundle, "handoff"),
		"</handoff>",
	].join("\n");
}

function reviewerTask(bundle: PilotBundle, evidence: { changedFiles: string[]; worker: unknown; verification: unknown }): string {
	return [
		"Review the authorized Pilot primary-solo result using the required JSON contract.",
		"<requirements>",
		readPilotBundleArtifact(bundle, "requirements"),
		"</requirements>",
		"<handoff>",
		readPilotBundleArtifact(bundle, "handoff"),
		"</handoff>",
		"<observed-evidence>",
		JSON.stringify(evidence, null, 2),
		"</observed-evidence>",
	].join("\n");
}

function envelopeSummary(bundle: PilotBundle, envelope: ExecutionEnvelope): string {
	return [
		readPilotBundleArtifact(bundle, "requirements").trim(),
		"",
		readPilotBundleArtifact(bundle, "handoff").trim(),
		"",
		"# Execution Envelope",
		`cwd: ${envelope.cwd}`,
		"topology: primary-solo",
		`writer: ${envelope.worker.agent}`,
		`tools: ${envelope.worker.allowedTools.join(", ")}`,
		`write roots: ${envelope.worker.writeRoots.join(", ")}`,
		`package.json sha256: ${envelope.packageJsonSha256}`,
		`verification deadline: ${envelope.verificationTimeoutMs} ms per command`,
		"validation scripts:",
		...envelope.verificationScripts.flatMap((entry) => [
			`- ${entry.command}`,
			...entry.lifecycleScripts.map((script) => `  - ${script.name} => ${script.script}`),
		]),
		`baseline: ${envelope.baseline.digest}`,
		`digest: ${envelope.digest}`,
	].join("\n");
}

function restoredManualState(entries: readonly unknown[]): PilotActivationState {
	return restoreActivationState(entries, DEFAULT_STATE);
}

export default function pilot(pi: ExtensionAPI): void {
	const isPilotWorkerChild = process.env.PI_SUBAGENT_CHILD === "1" && process.env.PI_SUBAGENT_CHILD_AGENT === "pilot.worker";
	let workerRuntimePolicy: PilotWorkerRuntimePolicy | undefined;
	let workerRuntimeFailure = isPilotWorkerChild ? "Worker policy has not been initialized." : undefined;
	let state: PilotActivationState = { ...DEFAULT_STATE };
	let workflowController: AbortController | undefined;
	let workflowKind: "planning" | "execution" | undefined;
	let activeBundle: PilotBundle | undefined;
	let sessionGeneration = 0;

	function workflowStatus(): string | undefined {
		const manifest = activeBundle?.manifest;
		if (workflowController && workflowKind === "execution") {
			return workflowController.signal.aborted ? "work:terminal-pending" : "work:primary-solo";
		}
		if (!manifest || manifest.phase === "terminal") return isPilotActive(state) ? "manual" : undefined;
		switch (manifest.status) {
			case "planning": return "plan:planning";
			case "ready_for_work": return "ready";
			case "working": return "work:primary-solo";
			case "verifying": return "work:verify";
			case "reviewing": return "work:review";
			default: return manifest.status;
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(PILOT_STATUS_KEY, workflowStatus());
	}

	function persistActivation(): void {
		pi.appendEntry(PILOT_ACTIVATION_ENTRY_TYPE, toActivationEntry(state));
	}

	function persistBundle(bundle: PilotBundle): void {
		pi.appendEntry(PILOT_BUNDLE_ENTRY_TYPE, toPilotBundleEntry(bundle));
	}

	function setActiveBundle(bundle: PilotBundle, ctx: ExtensionContext, persist = false): void {
		activeBundle = bundle;
		if (persist) persistBundle(bundle);
		updateStatus(ctx);
	}

	function restoreContextBundle(ctx: ExtensionContext): PilotBundle | undefined {
		try {
			return restorePilotBundle(ctx.sessionManager.getBranch(), {
				cwd: ctx.cwd,
				gitCommonDir: resolveGitCommonDir(ctx.cwd),
			});
		} catch {
			return undefined;
		}
	}

	function contextBoundBundle(bundle: PilotBundle, ctx: ExtensionContext): PilotBundle {
		const restored = restorePilotBundle([{
			type: "custom",
			customType: PILOT_BUNDLE_ENTRY_TYPE,
			data: toPilotBundleEntry(bundle),
		}], {
			cwd: ctx.cwd,
			gitCommonDir: resolveGitCommonDir(ctx.cwd),
		});
		if (!restored) throw new Error("Pilot Bundle does not belong to the current project context.");
		return restored;
	}

	function terminateBundle(bundle: PilotBundle, ctx: ExtensionContext, reason: string, cancelled: boolean, activate = true): PilotBundle | undefined {
		try {
			const current = openPilotBundle(bundle.dir);
			if (current.manifest.phase === "terminal") return current;
			const status = cancelled ? "cancelled" : "blocked";
			const persisted = persistPilotPlanningReceipt(current, { status, reason });
			if (activate) setActiveBundle(persisted, ctx);
			return persisted;
		} catch {
			return undefined;
		}
	}

	function planningFailure(bundle: PilotBundle, ctx: ExtensionContext, reason: string, cancelled: boolean): PilotBundle | undefined {
		return terminateBundle(bundle, ctx, reason, cancelled);
	}

	function invalidateSessionWorkflow(ctx: ExtensionContext, reason: string): void {
		sessionGeneration++;
		const invalidatedKind = workflowKind;
		workflowController?.abort();
		if (invalidatedKind !== "execution") {
			workflowController = undefined;
			workflowKind = undefined;
			if (activeBundle && activeBundle.manifest.phase !== "terminal") {
				terminateBundle(activeBundle, ctx, reason, true, false);
			}
		}
		activeBundle = undefined;
	}

	async function startPlanning(goal: string, ctx: ExtensionContext): Promise<void> {
		if (workflowController) {
			report(ctx, "Pilot already has an active workflow.", "warning");
			return;
		}
		const generation = sessionGeneration;
		const controller = new AbortController();
		workflowController = controller;
		workflowKind = "planning";
		let bundle: PilotBundle | undefined;
		try {
			bundle = createPilotBundle({
				gitCommonDir: resolveGitCommonDir(ctx.cwd),
				cwd: ctx.cwd,
				originalPrompt: goal,
				modePolicy: "edit",
				pilotActivation: "manual",
				effectiveRoute: "edit",
			});
			setActiveBundle(bundle, ctx, true);
			const plannerRequestId = randomUUID();
			bundle = updatePilotBundle(bundle, (current) => ({
				...current,
				activeRequest: { id: plannerRequestId, role: "planner", generation: current.revision + 1 },
			}));
			setActiveBundle(bundle, ctx);
			const request: ConstrainedDelegationRequest = {
				agent: "pilot.planner",
				task: plannerTask(goal),
				cwd: bundle.manifest.cwd,
				allowedTools: READ_ONLY_TOOLS,
				writeRoots: [],
				expectedAgent: expectedPilotProfile("pilot.planner"),
				timeoutMs: 900_000,
				artifacts: false,
			};
			const { response } = await delegatePilotConstrained({
				events: events(),
				request,
				signal: controller.signal,
				preflightRequestId: plannerRequestId,
				launchRequestId: randomUUID(),
			});
			if (generation !== sessionGeneration) return;
			if (response.status !== "completed" || !response.output?.trim()) {
				throw new Error(`Pilot planner failed: ${response.error ?? response.status}`);
			}
			bundle = materializePilotPlan(bundle, parsePilotPlanningResult(response.output));
			setActiveBundle(bundle, ctx);
			if (bundle.manifest.status === "ready_for_work") {
				report(ctx, `Pilot ready for work: ${bundle.manifest.runId}`);
			} else {
				const reason = bundle.manifest.needsDecision ?? "Planner requires a human decision.";
				planningFailure(bundle, ctx, reason, false);
				report(ctx, `Pilot planning needs a decision: ${reason}`, "warning");
			}
		} catch (error) {
			if (generation !== sessionGeneration) return;
			const reason = error instanceof Error ? error.message : String(error);
			if (bundle) planningFailure(bundle, ctx, reason, controller.signal.aborted);
			report(ctx, controller.signal.aborted ? "Pilot planning cancelled." : `Pilot planning blocked: ${reason}`, controller.signal.aborted ? "warning" : "error");
		} finally {
			if (workflowController === controller) {
				workflowController = undefined;
				workflowKind = undefined;
			}
			if (generation === sessionGeneration) updateStatus(ctx);
		}
	}

	function events(): PilotDelegationEventBus {
		return pi.events as unknown as PilotDelegationEventBus;
	}

	async function prepareEnvelope(ctx: ExtensionContext): Promise<{ bundle: PilotBundle; envelope: ExecutionEnvelope }> {
		const generation = sessionGeneration;
		if (!ctx.isProjectTrusted()) throw new Error("Pilot Work requires a trusted project before it can execute package scripts.");
		const candidate = activeBundle ?? restoreContextBundle(ctx);
		const bundle = candidate ? contextBoundBundle(candidate, ctx) : undefined;
		if (!bundle) throw new Error("No active Pilot Bundle. Activate Pilot and submit a goal first.");
		if (!isPilotActive(state) || bundle.manifest.effectiveRoute !== "edit" || bundle.manifest.modePolicy !== "edit"
			|| bundle.manifest.pilotActivation !== "manual") {
			throw new Error("Pilot Work requires the unchanged manually activated EDIT Bundle.");
		}
		if (bundle.manifest.status !== "ready_for_work" || bundle.manifest.phase !== "ready" || bundle.manifest.needsDecision || !bundle.manifest.workPlan) {
			throw new Error("Pilot Bundle is not ready for work.");
		}
		const baseline = captureGitBaseline(bundle.manifest.cwd);
		assertCleanPrimarySoloBaseline(baseline);
		const workerProbe: ConstrainedDelegationRequest = {
			agent: "pilot.worker",
			task: workerTask(bundle),
			cwd: bundle.manifest.cwd,
			allowedTools: WORKER_TOOLS,
			writeRoots: bundle.manifest.workPlan.writeRoots,
			expectedAgent: expectedPilotProfile("pilot.worker"),
			timeoutMs: 900_000,
			artifacts: false,
		};
		const reviewerProbe: ConstrainedDelegationRequest = {
			agent: "pilot.reviewer",
			task: "Review the approved Pilot primary-solo result.",
			cwd: bundle.manifest.cwd,
			allowedTools: READ_ONLY_TOOLS,
			writeRoots: [],
			expectedAgent: expectedPilotProfile("pilot.reviewer"),
			timeoutMs: 900_000,
			artifacts: false,
		};
		const workerProbeRequestId = randomUUID();
		const workerPolicy = await preflightPilotDelegation({ events: events(), request: workerProbe, requestId: workerProbeRequestId });
		discardPilotDelegationPolicy({ events: events(), requestId: workerProbeRequestId, policy: workerPolicy });
		if (generation !== sessionGeneration) throw new Error("Pilot session changed during Work preparation.");
		const reviewerProbeRequestId = randomUUID();
		const reviewerPolicy = await preflightPilotDelegation({ events: events(), request: reviewerProbe, requestId: reviewerProbeRequestId });
		discardPilotDelegationPolicy({ events: events(), requestId: reviewerProbeRequestId, policy: reviewerPolicy });
		if (generation !== sessionGeneration) throw new Error("Pilot session changed during Work preparation.");
		const envelope = buildExecutionEnvelope({
			runId: bundle.manifest.runId,
			sourceRevision: bundle.manifest.revision,
			cwd: bundle.manifest.cwd,
			pilotActivation: "manual",
			modePolicy: "edit",
			effectiveRoute: "edit",
			topology: "primary_solo",
			isolation: "none",
			requirements: bundle.manifest.artifacts.requirements!,
			handoff: bundle.manifest.artifacts.handoff!,
			baseline,
			worker: policyBinding(workerPolicy, workerProbe.expectedAgent!),
			reviewer: policyBinding(reviewerPolicy, reviewerProbe.expectedAgent!),
			verificationCommands: bundle.manifest.workPlan.verificationCommands,
		});
		setActiveBundle(bundle, ctx);
		return { bundle, envelope };
	}

	async function authorizeAndRun(expectedDigest: string, ctx: ExtensionContext): Promise<void> {
		if (workflowController) throw new Error("Pilot already has an active workflow.");
		const generation = sessionGeneration;
		const prepared = await prepareEnvelope(ctx);
		if (generation !== sessionGeneration) throw new Error("Pilot session changed before Work authorization.");
		if (prepared.envelope.digest !== expectedDigest) throw new Error("Pilot Work Envelope changed; review and authorize the new digest.");
		let bundle = updatePilotBundle(prepared.bundle, (current) => ({
			...current,
			authorization: {
				digest: prepared.envelope.digest,
				envelope: JSON.parse(JSON.stringify(prepared.envelope)) as Record<string, unknown>,
				authorizedAt: new Date().toISOString(),
			},
		}));
		setActiveBundle(bundle, ctx);
		const controller = new AbortController();
		workflowController = controller;
		workflowKind = "execution";
		updateStatus(ctx);
		try {
			const result = await runPrimarySolo({
				bundle,
				envelope: prepared.envelope,
				workerTask: workerTask(bundle),
				reviewerTask: (evidence) => reviewerTask(bundle, evidence),
				signal: controller.signal,
				dependencies: {
					preflight: (request, requestId, signal) => preflightPilotDelegation({ events: events(), request, requestId, signal }),
					launch: (request, policy, requestId, signal) => launchPilotDelegation({ events: events(), request, policy, requestId, signal }),
				},
			});
			if (generation !== sessionGeneration) {
				if (activeBundle?.dir === result.bundle.dir) {
					activeBundle = result.bundle;
					updateStatus(ctx);
				}
				return;
			}
			bundle = result.bundle;
			setActiveBundle(bundle, ctx);
			const level = result.status === "passed" ? "info" : result.status === "cancelled" ? "warning" : "error";
			const findings = result.reviewer?.findings ?? [];
			report(ctx, result.status === "passed"
				? `Pilot passed: ${result.changedFiles.join(", ")} · receipt ${bundle.dir}/receipt.json`
				: `Pilot ${result.status}: ${result.reason ?? "See receipt.json"}${findings.length ? `\nFindings:\n${findings.map((finding) => `- ${finding}`).join("\n")}` : ""}`,
				level);
		} finally {
			const releasedOwner = workflowController === controller;
			if (releasedOwner) {
				workflowController = undefined;
				workflowKind = undefined;
			}
			if (releasedOwner || generation === sessionGeneration) updateStatus(ctx);
		}
	}

	async function handleWork(args: string, ctx: ExtensionContext): Promise<void> {
		const confirm = args.match(/^work\s+--confirm\s+([a-f0-9]{64})$/)?.[1];
		if (args !== "work" && !confirm) {
			report(ctx, "Usage: /pilot work [--confirm <digest>]", "warning");
			return;
		}
		try {
			const prepared = await prepareEnvelope(ctx);
			if (confirm) {
				if (confirm !== prepared.envelope.digest) throw new Error("Pilot Work digest does not match the current Envelope.");
				await authorizeAndRun(confirm, ctx);
				return;
			}
			if (!ctx.hasUI) {
				report(ctx, `Pilot Work Envelope\n${envelopeSummary(prepared.bundle, prepared.envelope)}\nRun /pilot work --confirm ${prepared.envelope.digest} to authorize.`);
				return;
			}
			const authorized = await ctx.ui.confirm("Authorize Pilot Work", envelopeSummary(prepared.bundle, prepared.envelope));
			if (!authorized) {
				report(ctx, "Pilot Work authorization cancelled.", "warning");
				return;
			}
			await authorizeAndRun(prepared.envelope.digest, ctx);
		} catch (error) {
			report(ctx, `Pilot Work blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	pi.registerCommand("pilot", {
		description: "Activate the manual Pilot Copilot or control its primary-solo workflow (off|status|cancel|work)",
		getArgumentCompletions: (prefix) => ["off", "status", "cancel", "work", "work --confirm"]
			.filter((option) => option.startsWith(prefix.trim().toLowerCase()))
			.map((option) => ({ value: option, label: option })),
		handler: async (args, ctx) => {
			const action = args.trim();
			const normalized = action.toLowerCase();
			if (normalized === "status") {
				const candidate = activeBundle ?? restoreContextBundle(ctx);
				let bundle = candidate;
				if (candidate) {
					try { bundle = contextBoundBundle(openPilotBundle(candidate.dir), ctx); } catch {}
				}
				if (bundle) setActiveBundle(bundle, ctx);
				const terminalPending = workflowController?.signal.aborted && workflowKind === "execution";
				report(ctx, terminalPending
					? `Pilot: ${activationSource(state)} · execution owner active; terminal response pending${bundle ? ` · ${bundle.manifest.status} · ${bundle.manifest.runId}` : ""}`
					: bundle
						? `Pilot: ${activationSource(state)} · ${bundle.manifest.status} · ${bundle.manifest.runId}`
						: workflowController
							? `Pilot: ${activationSource(state)} · ${workflowKind ?? "workflow"} owner active`
							: `Pilot: ${activationSource(state)}`);
				return;
			}
			if (normalized === "cancel") {
				if (workflowController) {
					workflowController.abort();
					updateStatus(ctx);
					report(ctx, "Pilot workflow cancellation requested.");
					return;
				}
				if (activeBundle && activeBundle.manifest.phase !== "terminal") {
					const cancelled = planningFailure(activeBundle, ctx, "Cancelled by user before Work authorization.", true);
					if (!cancelled) {
						report(ctx, "Pilot Bundle cancellation could not be persisted; its state is unchanged.", "error");
						return;
					}
					if (cancelled.manifest.status !== "cancelled") {
						report(ctx, `Pilot Bundle is already terminal: ${cancelled.manifest.status}.`, "warning");
						return;
					}
					report(ctx, "Pilot Bundle cancelled before Work authorization.", "warning");
					return;
				}
				report(ctx, "No Pilot workflow is running.", "warning");
				return;
			}
			if (normalized === "off") {
				const next = deactivateManualPilot(state, { safe: ctx.isIdle() && !workflowController });
				if (!next.ok) {
					report(ctx, next.reason, "warning");
					return;
				}
				state = { modePolicy: "edit", manualPilotActive: next.state.manualPilotActive };
				persistActivation();
				updateStatus(ctx);
				report(ctx, "Pilot manual activation ended.");
				return;
			}
			if (normalized === "work" || normalized.startsWith("work ")) {
				await handleWork(normalized, ctx);
				return;
			}
			if (action) {
				report(ctx, "Usage: /pilot [off|status|cancel|work [--confirm <digest>]]", "warning");
				return;
			}
			const next = activateManualPilot(state);
			if (!next.ok) {
				report(ctx, next.reason, "warning");
				return;
			}
			state = { modePolicy: "edit", manualPilotActive: true };
			persistActivation();
			updateStatus(ctx);
			report(ctx, "Pilot manual activation is active. Submit one implementation goal to create a reviewed Work Gate.");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isPilotWorkerChild) return;
		let bootstrapTools: string[];
		try {
			pi.setActiveTools([...READ_ONLY_TOOLS]);
			bootstrapTools = [...pi.getActiveTools()];
			if (JSON.stringify([...bootstrapTools].sort()) !== JSON.stringify([...READ_ONLY_TOOLS].sort())) {
				throw new Error("Worker tools could not be reduced to the fixed read-only bootstrap set.");
			}
		} catch (error) {
			workerRuntimePolicy = undefined;
			workerRuntimeFailure = error instanceof Error ? error.message : String(error);
			return;
		}
		const parsed = parsePilotWorkerPolicyPrompt({
			prompt: event.prompt,
			cwd: ctx.cwd,
			activeTools: bootstrapTools,
			childAgent: process.env.PI_SUBAGENT_CHILD_AGENT,
		});
		if (parsed.ok) {
			try {
				pi.setActiveTools(parsed.policy.allowedTools);
				const active = [...pi.getActiveTools()].sort();
				if (JSON.stringify(active) !== JSON.stringify([...parsed.policy.allowedTools].sort())) {
					throw new Error("Worker write tools could not be activated exactly.");
				}
				workerRuntimePolicy = parsed.policy;
				workerRuntimeFailure = undefined;
			} catch (error) {
				pi.setActiveTools([...READ_ONLY_TOOLS]);
				workerRuntimePolicy = undefined;
				workerRuntimeFailure = error instanceof Error ? error.message : String(error);
			}
		} else {
			pi.setActiveTools([...READ_ONLY_TOOLS]);
			workerRuntimePolicy = undefined;
			workerRuntimeFailure = parsed.error;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		invalidateSessionWorkflow(ctx, "Cancelled because the Pilot session context changed.");
		state = restoredManualState(ctx.sessionManager.getBranch());
		activeBundle = restoreContextBundle(ctx);
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		invalidateSessionWorkflow(ctx, "Cancelled because the Pilot session tree changed.");
		activeBundle = restoreContextBundle(ctx);
		state = restoredManualState(ctx.sessionManager.getBranch());
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		invalidateSessionWorkflow(ctx, "Cancelled because the Pilot session shut down.");
		ctx.ui.setStatus(PILOT_STATUS_KEY, undefined);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (workflowController) {
			report(ctx, "Pilot is already running a workflow.", "warning");
			return { action: "handled" };
		}
		if (!isPilotActive(state)) return { action: "continue" };
		await startPlanning(event.text, ctx);
		return { action: "handled" };
	});

	pi.on("tool_call", async (event) => {
		if (isPilotWorkerChild) {
			return guardPilotWorkerToolCall(workerRuntimePolicy, workerRuntimeFailure, event.toolName, event.input);
		}
		const executionOwnsWrites = !!workflowController && workflowKind === "execution";
		if ((!isPilotActive(state) && !executionOwnsWrites) || PARENT_READ_ONLY_TOOLS.has(event.toolName)) return;
		return { block: true, reason: PARENT_MUTATION_BLOCK_REASON };
	});
}
