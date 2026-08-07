export const PRESENTATION_SYSTEM_ENTRY_TYPE = "presentation-system-v1";
export const PRESENTATION_ARTIFACT_ENTRY_TYPE = "presentation-artifacts-v1";
export const PRESENTATION_ARTIFACT_STATE_ENTRY_TYPE = "presentation-artifact-state-v2";
export const PRESENTATION_TOOL_ENTRY_TYPE = "presentation-tools-v1";
export const PRESENTATION_EVENT_NAME = "terrific-pi:presentation:event-v1";

export type PresentationTone = "info" | "success" | "warning" | "error" | "muted";
export type PresentationKind = "workspace" | "model" | "thinking" | "mode" | "fast" | "skill";

export interface PresentationSystemEntry {
	version: 1;
	kind: PresentationKind;
	tone: PresentationTone;
	label: string;
	message: string;
	detail?: string;
	timestamp: number;
	dedupeKey: string;
}

export interface PresentationEvent {
	version: 1;
	kind: "mode" | "fast";
	source: "user" | "startup" | "restore" | "system";
	tone: PresentationTone;
	label: string;
	message: string;
	dedupeKey: string;
	/** Event-bus acknowledgement set only after a visible TUI system entry is appended. */
	presentationHandled?: boolean;
}

export interface FileArtifact {
	path: string;
	operation: "added" | "modified" | "deleted" | "unknown";
	additions?: number;
	deletions?: number;
	sources: string[];
	preExisting?: boolean;
}

export interface ArtifactReceipt {
	version: 1;
	turnIndex: number | "settled-reconcile";
	files: FileArtifact[];
	successfulWrites: number;
	failedWrites: number;
	gitReconciled: boolean;
	startedAt: number;
	flushedAt: number;
}

/** Durable UI-only state. The compatibility renderer projects only the latest revision onto a tool row. */
export interface PresentationArtifactState {
	version: 2;
	receiptId: string;
	requestId: string;
	revision: number;
	supersedes?: string;
	anchorToolCallId: string;
	files: FileArtifact[];
	successfulWrites: number;
	failedWrites: number;
	gitReconciled: boolean;
	reverted?: true;
	startedAt: number;
	revisedAt: number;
}

export type PresentationToolKind = "exploration" | "command" | "generic" | "skill" | "failure";

/** Durable, UI-only semantic summary for a tool batch. */
export interface PresentationToolEntry {
	version: 1;
	kind: PresentationToolKind;
	tone: PresentationTone;
	label: string;
	message: string;
	detail?: string;
	/** Raw native output is hidden in collapsed mode and available via app.tools.expand. */
	expandable?: boolean;
	timestamp: number;
}

export interface PresentationConfig {
	enabled: boolean;
	/** Selects the existing compact renderer or the OMP-inspired transcript profile. */
	style: "classic" | "omp";
	workspace: boolean;
	systemEvents: boolean;
	artifacts: boolean;
	/** Adds the native user-message frame through the guarded compatibility renderer. */
	userMessageBox: boolean;
	/** Uses the guarded compact transcript renderer without replacing tool definitions. */
	compactTools: boolean;
	maxExpandedArtifacts: number;
}
