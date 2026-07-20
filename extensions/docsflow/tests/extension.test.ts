import assert from "node:assert/strict";
import { test } from "node:test";

import { runDocsflowManager } from "../lib/interaction.ts";

test("bare /docsflow manager exposes status before its other actions", async () => {
	const choices = ["Status", "Done"];
	const actions: string[] = [];
	await runDocsflowManager({
		title: "Docsflow\nstatus: idle",
		ui: {
			select: async (_title, options) => {
				const choice = choices.shift();
				assert.ok(choice && options.includes(choice));
				return choice;
			},
		},
		status: async () => { actions.push("status"); },
		start: async () => { actions.push("start"); },
		resume: async () => { actions.push("resume"); },
		drafts: async () => { actions.push("drafts"); },
		reset: async () => { actions.push("reset"); },
		settings: async () => { actions.push("settings"); },
	});
	assert.deepEqual(actions, ["status"]);
});
