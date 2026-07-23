import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	activateManualPilot,
	activationSource,
	changeModePolicy,
	deactivateManualPilot,
	isPilotActive,
	restoreActivationState,
	type PilotActivationState,
} from "../lib/activation.ts";

function state(modePolicy: PilotActivationState["modePolicy"], manualPilotActive = false): PilotActivationState {
	return { modePolicy, manualPilotActive };
}

describe("Pilot activation", () => {
	test("derives AUTO, manual, and inactive sources from the two canonical fields", () => {
		assert.equal(isPilotActive(state("auto")), true);
		assert.equal(activationSource(state("auto")), "auto");
		assert.equal(isPilotActive(state("plan")), false);
		assert.equal(activationSource(state("plan")), "inactive");
		assert.equal(isPilotActive(state("edit", true)), true);
		assert.equal(activationSource(state("edit", true)), "manual");
	});

	test("keeps manual activation across locked modes and clears it when entering AUTO", () => {
		const manual = activateManualPilot(state("plan"));
		assert.deepEqual(manual, { ok: true, state: state("plan", true) });

		const edit = changeModePolicy(manual.state, "edit", { safeToLeaveAuto: true });
		assert.deepEqual(edit, { ok: true, state: state("edit", true) });

		const auto = changeModePolicy(edit.state, "auto", { safeToLeaveAuto: true });
		assert.deepEqual(auto, { ok: true, state: state("auto", false) });
	});

	test("refuses AUTO exit and manual deactivation while a workflow is unsafe", () => {
		assert.deepEqual(changeModePolicy(state("auto"), "plan", { safeToLeaveAuto: false }), {
			ok: false,
			reason: "Pilot is active; wait, pause, or cancel before leaving AUTO.",
		});
		assert.deepEqual(deactivateManualPilot(state("edit", true), { safe: false }), {
			ok: false,
			reason: "Pilot is active; wait, pause, or cancel before deactivating it.",
		});
	});

	test("restores only the latest valid Pilot state entry", () => {
		const restored = restoreActivationState([
			{ type: "custom", customType: "terrific-pi:pilot:activation-v1", data: { version: 1, modePolicy: "plan", manualPilotActive: true } },
			{ type: "custom", customType: "terrific-pi:pilot:activation-v1", data: { version: 1, modePolicy: "unknown", manualPilotActive: true } },
			{ type: "custom", customType: "terrific-pi:pilot:activation-v1", data: { version: 1, modePolicy: "edit", manualPilotActive: false } },
		], state("auto"));
		assert.deepEqual(restored, state("edit", false));
	});
});
