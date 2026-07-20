import assert from "node:assert/strict";
import { it } from "node:test";

import { formatFastStatus } from "../lib/status.ts";

it("reports preference separately from effective priority support", () => {
	const text = formatFastStatus(true, "anthropic-messages", "/tmp/terrific.json");
	assert.match(text, /Preference: on/);
	assert.match(text, /Effective: inactive/);
	assert.match(text, /Current API: anthropic-messages/);
	assert.match(text, /Config: \/tmp\/terrific\.json/);
});
