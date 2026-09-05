import assert from "node:assert/strict";
import { it } from "node:test";

import { formatFastStatus } from "../lib/status.ts";

it("reports preference separately from effective GPT priority support", () => {
	const inactive = formatFastStatus(true, "openai-responses", "/tmp/terrific.json", "grok-4.5", false);
	assert.match(inactive, /Preferred: on/);
	assert.match(inactive, /Eligible: no/);
	assert.match(inactive, /Current API: openai-responses/);
	assert.match(inactive, /Current model: grok-4\.5/);
	assert.match(inactive, /Requires: GPT model id/);
	assert.match(inactive, /Config: \/tmp\/terrific\.json/);

	const active = formatFastStatus(true, "openai-responses", "/tmp/terrific.json", "gpt-5.6-sol", true, {
		api: "openai-responses",
		modelId: "gpt-5.6-sol",
		eligible: true,
		injected: true,
	});
	assert.match(active, /Preferred: on/);
	assert.match(active, /Eligible: yes/);
	assert.match(active, /Injected \(last provider request\): yes/);
	assert.match(active, /Current model: gpt-5\.6-sol/);

	const unseen = formatFastStatus(true, "openai-responses", "/tmp/terrific.json", "gpt-5.6-sol", true);
	assert.match(unseen, /Injected \(last provider request\): not observed/);
});
