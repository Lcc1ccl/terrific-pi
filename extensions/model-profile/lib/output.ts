import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ReportLevel = "info" | "warning" | "error";

export function report(
	ctx: Pick<ExtensionContext, "mode" | "ui">,
	message: string,
	level: ReportLevel = "info",
): void {
	const line = message.endsWith("\n") ? message : `${message}\n`;
	if (ctx.mode === "print" && level === "info") {
		process.stdout.write(line);
		return;
	}
	if (ctx.mode === "print" || ctx.mode === "json") {
		process.stderr.write(line);
		return;
	}
	ctx.ui.notify(message, level);
}
