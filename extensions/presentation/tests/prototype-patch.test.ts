import assert from "node:assert/strict";
import test from "node:test";

import { patchPrototypeMethod } from "../lib/compat/prototype-patch.ts";

test("prototype patches refresh to the newest owner and never restore over a foreign patch", () => {
	const key = Symbol("test-patch");
	const prototype = {
		render() { return "native"; },
	};
	const first = patchPrototypeMethod(prototype, "render", key, 1, (original) => function () {
		return `first:${original.call(this)}`;
	});
	const second = patchPrototypeMethod(prototype, "render", key, 1, (original) => function () {
		return `second:${original.call(this)}`;
	});
	assert.equal(prototype.render(), "second:native");
	first?.uninstall();
	assert.equal(prototype.render(), "second:native");

	const foreign = () => "foreign";
	prototype.render = foreign;
	second?.uninstall();
	assert.equal(prototype.render, foreign);
});
