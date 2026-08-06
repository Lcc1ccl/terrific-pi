/**
 * User-facing tip when pi core updates settings defaults outside /profile.
 * Official /model, Ctrl+P cycle, and thinking changes all persist globals.
 */

export type OfficialChangeKind = "model" | "cycle" | "thinking";

export function formatOfficialDefaultsTip(kind: OfficialChangeKind, detail: string): string {
	switch (kind) {
		case "cycle":
			return `Switched via model cycle: settings defaults updated to ${detail} (pi core). Use /profile for session-only.`;
		case "thinking":
			return `Thinking changed outside /profile: settings defaultThinkingLevel updated to ${detail} (pi core).`;
		case "model":
		default:
			return `Switched via official picker: settings defaults updated to ${detail} (pi core). Use /profile for session-only.`;
	}
}
