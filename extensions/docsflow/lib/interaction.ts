export interface DocsflowManagerUi {
	select(title: string, options: string[]): Promise<string | undefined>;
}

export interface DocsflowManagerDeps {
	title: string;
	ui: DocsflowManagerUi;
	status(): Promise<void>;
	start(): Promise<void>;
	resume(): Promise<void>;
	drafts(): Promise<void>;
	reset(): Promise<void>;
	settings(): Promise<void>;
}

export async function runDocsflowManager(deps: DocsflowManagerDeps): Promise<void> {
	while (true) {
		const choice = await deps.ui.select(deps.title, [
			"Status",
			"Start wizard",
			"Resume / Retry",
			"Drafts",
			"Reset",
			"Settings",
			"Done",
		]);
		if (!choice || choice === "Done") return;
		if (choice === "Status") await deps.status();
		else if (choice === "Start wizard") await deps.start();
		else if (choice === "Resume / Retry") await deps.resume();
		else if (choice === "Drafts") await deps.drafts();
		else if (choice === "Reset") await deps.reset();
		else if (choice === "Settings") await deps.settings();
	}
}
