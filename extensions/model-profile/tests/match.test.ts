import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findMatchingProfile, profileMatches } from "../lib/match.ts";
import type { ModelProfile } from "../lib/types.ts";

const profiles: ModelProfile[] = [
	{ id: "1", alias: "default", provider: "grok", model: "grok-4.5", thinking: "high" },
	{ id: "2", alias: "fast", provider: "openai", model: "mini", thinking: "low" },
];

describe("profileMatches", () => {
	it("requires provider, model id, and thinking", () => {
		assert.equal(
			profileMatches(profiles[0]!, { provider: "grok", id: "grok-4.5" }, "high"),
			true,
		);
		assert.equal(
			profileMatches(profiles[0]!, { provider: "grok", id: "grok-4.5" }, "low"),
			false,
		);
		assert.equal(profileMatches(profiles[0]!, undefined, "high"), false);
	});
});

describe("findMatchingProfile", () => {
	it("returns the first exact match", () => {
		const hit = findMatchingProfile(profiles, { provider: "openai", id: "mini" }, "low");
		assert.equal(hit?.id, "2");
	});

	it("returns undefined when nothing matches", () => {
		assert.equal(
			findMatchingProfile(profiles, { provider: "openai", id: "mini" }, "high"),
			undefined,
		);
	});
});
