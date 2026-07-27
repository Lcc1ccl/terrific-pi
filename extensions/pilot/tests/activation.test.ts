import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	activateManualPilot,
	activationSource,
	deactivateManualPilot,
	isPilotActive,
	restoreActivationState,
	type PilotActivationState,
} from "../lib/activation.ts";

const inactive: PilotActivationState = { modePolicy: "edit", manualPilotActive: false };
const manual: PilotActivationState = { modePolicy: "edit", manualPilotActive: true };

describe("Pilot manual activation", () => {
	test("has only inactive and manual runtime states", () => {
		assert.equal(isPilotActive(inactive), false);
		assert.equal(activationSource(inactive), "inactive");
		assert.equal(isPilotActive(manual), true);
		assert.equal(activationSource(manual), "manual");
	});

	test("activates explicitly and refuses unsafe deactivation", () => {
		assert.deepEqual(activateManualPilot(inactive), { ok: true, state: manual });
		assert.deepEqual(deactivateManualPilot(manual, { safe: false }), {
			ok: false,
			reason: "Pilot is active; wait or cancel before deactivating it.",
		});
		assert.deepEqual(deactivateManualPilot(manual, { safe: true }), { ok: true, state: inactive });
	});

	test("restores explicit legacy manual activation but never legacy AUTO activation", () => {
		const legacyManual = restoreActivationState([{
			type: "custom",
			customType: "terrific-pi:pilot:activation-v1",
			data: { version: 1, modePolicy: "plan", manualPilotActive: true },
		}], inactive);
		assert.deepEqual(legacyManual, manual);

		const legacyAuto = restoreActivationState([{
			type: "custom",
			customType: "terrific-pi:pilot:activation-v1",
			data: { version: 1, modePolicy: "auto", manualPilotActive: false },
		}], manual);
		assert.deepEqual(legacyAuto, inactive);
	});

	test("ignores malformed or unsupported entries", () => {
		const restored = restoreActivationState([
			{ type: "custom", customType: "terrific-pi:pilot:activation-v1", data: { version: 1, modePolicy: "unknown", manualPilotActive: true } },
			{ type: "custom", customType: "other", data: { version: 1, modePolicy: "edit", manualPilotActive: true } },
		], inactive);
		assert.deepEqual(restored, inactive);
	});
});
