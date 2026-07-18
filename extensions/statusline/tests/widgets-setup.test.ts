import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatWidgetsPreview } from "../lib/widgets.ts";

describe("formatWidgetsPreview", () => {
	it("renders sample segments for enabled widgets", () => {
		const preview = formatWidgetsPreview(["path", "cache", "state"]);
		assert.match(preview, /proj|~/);
		assert.match(preview, /🎯 \d+\.\d+%/);
		assert.match(preview, /Ready/);
	});

	it("returns none when empty", () => {
		assert.equal(formatWidgetsPreview([]), "(none)");
	});
});
