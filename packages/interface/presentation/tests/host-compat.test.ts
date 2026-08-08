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

test("host probe accepts compatible component shapes without a version allowlist", () => {
	for (const version of ["0.81.1", "0.83.0", "0.84.1", "0.85.0"]) {
		assert.deepEqual(probePresentationHost(host(version)), { supported: true, version });
	}
	const versionless = host("ignored") as Record<string, unknown>;
	delete versionless.VERSION;
	assert.deepEqual(probePresentationHost(versionless), { supported: true, version: "unknown" });
});

test("compatibility installation is all-or-nothing for an injected host namespace", () => {
	const options = {
		isUserMessageBoxEnabled: () => true,
		isCompactToolsEnabled: () => true,
		isOmpStyleEnabled: () => true,
		getTheme: () => undefined,
	};
	const incompatible = host("0.85.0") as Record<string, any>;
	delete incompatible.AssistantMessageComponent.prototype.updateContent;
	const incompatibleOriginals = ["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent"].map((name) =>
		incompatible[name].prototype.render,
	);
	const incompatibleHandle = Compat.installPresentationCompatibility(options as never, incompatible as never);
	try {
		assert.deepEqual(incompatibleHandle.host, {
			supported: false,
			version: "0.85.0",
			reason: "missing AssistantMessageComponent.prototype.updateContent",
		});
		for (const [index, name] of ["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent"].entries()) {
			assert.equal(incompatible[name].prototype.render, incompatibleOriginals[index]);
		}
	} finally {
		incompatibleHandle.uninstall();
	}

	const supported = host("0.85.0") as Record<string, { prototype?: { render?: unknown } } | string>;
	const supportedOriginals = ["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent"].map((name) =>
		(supported[name] as { prototype: { render: unknown } }).prototype.render,
	);
	const handle = Compat.installPresentationCompatibility(options as never, supported as never);
	try {
		assert.deepEqual(handle.host, { supported: true, version: "0.85.0" });
		for (const [index, name] of ["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent"].entries()) {
			assert.notEqual((supported[name] as { prototype: { render: unknown } }).prototype.render, supportedOriginals[index]);
		}
	} finally {
		handle.uninstall();
	}
	for (const [index, name] of ["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent"].entries()) {
		assert.equal((supported[name] as { prototype: { render: unknown } }).prototype.render, supportedOriginals[index]);
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
