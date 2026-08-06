import assert from "node:assert/strict";
import { it } from "node:test";
import { report } from "../lib/output.ts";

it("prints non-interactive output without UI notifications", () => {
	let stdout = "";
	const original = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		report({ mode: "print", ui: { notify() {} } } as never, "summary");
	} finally {
		process.stdout.write = original;
	}
	assert.equal(stdout, "summary\n");
});
