import assert from "node:assert/strict";
import { it } from "node:test";

import statusline from "../extensions/statusline.ts";

it("offers only reload completion and rejects unknown arguments", async () => {
	const commands = new Map<string, any>();
	statusline({
		events: { on() {} },
		on() {},
		registerCommand(name: string, command: unknown) { commands.set(name, command); },
	} as never);
	const command = commands.get("statusline");
	assert.deepEqual(command.getArgumentCompletions("").map((item: { value: string }) => item.value), ["reload"]);
	const notifications: string[] = [];
	await command.handler("unknown", {
		mode: "tui",
		ui: { notify(message: string) { notifications.push(message); } },
	});
	assert.match(notifications.at(-1) ?? "", /Usage: \/statusline \[reload\]/);
});
