import assert from "node:assert/strict";
import test from "node:test";

import * as Compat from "../lib/compat/index.ts";

const probePresentationHost = (value: unknown) => {
	assert.equal(typeof Compat.probePresentationHost, "function", "host probe must be exported");
	return Compat.probePresentationHost(value);
};

function host(version: string, missing?: "AssistantMessageComponent" | "UserMessageComponent" | "ToolExecutionComponent", render = true) {
	const component = (name: "AssistantMessageComponent" | "UserMessageComponent" | "ToolExecutionComponent") => {
		function Component() {}
		Object.assign(Component.prototype, {
			...(render ? { render() { return []; } } : {}),
			...(name === "AssistantMessageComponent" ? { updateContent() {}, setHideThinkingBlock() {} } : {}),
			...(name === "ToolExecutionComponent" ? { updateArgs() {}, updateResult() {}, setExpanded() {} } : {}),
		});
		return Component;
	};
	return {
		VERSION: version,
		...(missing === "AssistantMessageComponent" ? {} : { AssistantMessageComponent: component("AssistantMessageComponent") }),
		...(missing === "UserMessageComponent" ? {} : { UserMessageComponent: component("UserMessageComponent") }),
		...(missing === "ToolExecutionComponent" ? {} : { ToolExecutionComponent: component("ToolExecutionComponent") }),
	};
}

test("host probe accepts only the three verified Pi component shapes", () => {
	for (const version of ["0.81.1", "0.83.0", "0.84.1"]) {
		assert.deepEqual(probePresentationHost(host(version)), { supported: true, version });
	}
	assert.deepEqual(probePresentationHost(host("0.85.0")), {
		supported: false,
		version: "0.85.0",
		reason: "unsupported Pi version 0.85.0",
	});
});

test("compatibility installation is all-or-nothing for an injected host namespace", async () => {
	const options = {
		isUserMessageBoxEnabled: () => true,
		isCompactToolsEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => undefined,
	};
	const unsupported = host("0.85.0");
	const realAssistant = (await import("@earendil-works/pi-coding-agent")).AssistantMessageComponent.prototype.render;
	const unsupportedHandle = Compat.installPresentationCompatibility(options as never, unsupported as never);
	try {
		assert.deepEqual(unsupportedHandle.host, {
			supported: false,
			version: "0.85.0",
			reason: "unsupported Pi version 0.85.0",
		});
		assert.equal((await import("@earendil-works/pi-coding-agent")).AssistantMessageComponent.prototype.render, realAssistant);
	} finally {
		unsupportedHandle.uninstall();
	}

	const supported = host("0.84.1") as Record<string, { prototype?: { render?: unknown } } | string>;
	const originals = ["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent"].map((name) =>
		(supported[name] as { prototype: { render: unknown } }).prototype.render,
	);
	const handle = Compat.installPresentationCompatibility(options as never, supported as never);
	try {
		assert.deepEqual(handle.host, { supported: true, version: "0.84.1" });
		for (const [index, name] of ["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent"].entries()) {
			assert.notEqual((supported[name] as { prototype: { render: unknown } }).prototype.render, originals[index]);
		}
	} finally {
		handle.uninstall();
	}
	for (const [index, name] of ["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent"].entries()) {
		assert.equal((supported[name] as { prototype: { render: unknown } }).prototype.render, originals[index]);
	}
});

test("host probe fails all compatibility patches when any render export is absent", () => {
	for (const name of ["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent"] as const) {
		const result = probePresentationHost(host("0.84.1", name));
		assert.equal(result.supported, false);
		assert.match(result.reason ?? "", new RegExp(name));
	}
	const nonConstructor = host("0.84.1") as Record<string, any>;
	nonConstructor.AssistantMessageComponent = { prototype: nonConstructor.AssistantMessageComponent.prototype };
	const constructorResult = probePresentationHost(nonConstructor);
	assert.equal(constructorResult.supported, false);
	assert.match(constructorResult.reason ?? "", /AssistantMessageComponent constructor/);

	const missingMethod = host("0.84.1") as Record<string, any>;
	delete missingMethod.AssistantMessageComponent.prototype.updateContent;
	const methodResult = probePresentationHost(missingMethod);
	assert.equal(methodResult.supported, false);
	assert.match(methodResult.reason ?? "", /AssistantMessageComponent\.prototype\.updateContent/);

	const noRender = probePresentationHost(host("0.84.1", undefined, false));
	assert.equal(noRender.supported, false);
	assert.match(noRender.reason ?? "", /prototype\.render/);
});
