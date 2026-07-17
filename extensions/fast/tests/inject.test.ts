import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { injectPriority } from "../extensions/fast.ts";

describe("injectPriority", () => {
	it("sets service_tier=priority on plain objects", () => {
		const payload = { model: "gpt-5.2", stream: true, store: false };
		const next = injectPriority(payload);
		assert.equal(next, payload);
		assert.equal((payload as { service_tier?: string }).service_tier, "priority");
	});

	it("overwrites an existing service_tier", () => {
		const payload = { service_tier: "default" };
		injectPriority(payload);
		assert.equal(payload.service_tier, "priority");
	});

	it("ignores non-objects", () => {
		assert.equal(injectPriority(null), undefined);
		assert.equal(injectPriority(undefined), undefined);
		assert.equal(injectPriority("x"), undefined);
		assert.equal(injectPriority([1]), undefined);
	});
});
