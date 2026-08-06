import assert from "node:assert/strict";
import { it } from "node:test";
import { report } from "../lib/output.ts";

it("reports non-interactive errors on stderr", () => {
	let stderr = "";
	const original = process.stderr.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		report({ mode: "print", ui: { notify() {} } } as never, "unsupported", "error");
	} finally {
		process.stderr.write = original;
	}
	assert.equal(stderr, "unsupported\n");
});
