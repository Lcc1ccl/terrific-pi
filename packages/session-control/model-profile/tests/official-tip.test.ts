import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatOfficialDefaultsTip } from "../lib/official-tip.ts";

describe("formatOfficialDefaultsTip", () => {
	it("mentions official picker and defaults", () => {
		const text = formatOfficialDefaultsTip("model", "openai/gpt-5.6-luna");
		assert.match(text, /official picker/i);
		assert.match(text, /settings defaults updated/i);
		assert.match(text, /openai\/gpt-5\.6-luna/);
		assert.match(text, /\/profile/);
	});

	it("mentions cycle path", () => {
		assert.match(formatOfficialDefaultsTip("cycle", "grok/x"), /model cycle/i);
	});

	it("mentions thinking path", () => {
		assert.match(formatOfficialDefaultsTip("thinking", "max"), /defaultThinkingLevel/i);
	});
});
