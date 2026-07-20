/** Thinking levels accepted by pi.setThinkingLevel. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Apply scope: session-only or also write global settings defaults. */
export type ProfileScope = "session" | "global";

export interface ModelProfile {
	/** Numeric id as string, e.g. "1". Used for /profile 1 and alt+1. */
	id: string;
	/** Short alias for /profile <alias> and TUI labels, e.g. "default". */
	alias: string;
	/** Optional display label; falls back to alias. */
	label: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	/** Shortcut; defaults to alt+<id> for ids 1–9. */
	hotkey?: string;
}

export interface ProjectProfileOverride {
	/** Profile identity inherited from global config. */
	id: string;
	/** Provider and model always override as a pair. */
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
}

export interface ModelProfileConfig {
	/** Cold-start short-list picker. */
	startup: boolean;
	/** Preferred scope offered first on startup. */
	startupScope: ProfileScope;
	/** Open interactive /profile picker (default: ctrl+alt+l). */
	openHotkey?: string;
	profiles: ModelProfile[];
}

export type ApplyFailureKind =
	| "unknown-model"
	| "set-model-refused"
	| "settings-snapshot-failed"
	| "settings-write-failed";

export type ApplyResult =
	| {
			ok: true;
			profile: ModelProfile;
			scope: ProfileScope;
			thinking: ThinkingLevel;
			thinkingClamped: boolean;
			/** scope=global: wrote new defaults. */
			settingsWritten?: boolean;
			/** scope=session: restored previous defaults after pi setModel. */
			settingsRestored?: boolean;
			/** Human-readable settings warning (restore/write failure or incomplete snapshot). */
			settingsError?: string;
	  }
	| {
			ok: false;
			kind: ApplyFailureKind;
			reason: string;
	  };

