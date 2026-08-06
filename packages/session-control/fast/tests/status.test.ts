import assert from "node:assert/strict";
import { it } from "node:test";

import { formatFastStatus } from "../lib/status.ts";

it("reports preference separately from effective GPT priority support", () => {
	const inactive = formatFastStatus(true, "openai-responses", "/tmp/terrific.json", "grok-4.5");
	assert.match(inactive, /Preference: on/);
	assert.match(inactive, /Effective: inactive/);
	assert.match(inactive, /Current API: openai-responses/);
	assert.match(inactive, /Current model: grok-4\.5/);
	assert.match(inactive, /Requires: GPT model id/);
	assert.match(inactive, /Config: \/tmp\/terrific\.json/);

	const active = formatFastStatus(true, "openai-responses", "/tmp/terrific.json", "gpt-5.6-sol");
	assert.match(active, /Effective: active/);
	assert.match(active, /Current model: gpt-5\.6-sol/);
});
