import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const PROCESS_ENTRY_TYPE = "process-view-state-v1";
export const PROCESS_CONTEXT_TYPE = "process-view-context";
export const PROCESS_WIDGET_KEY = "terrific-pi:process-view";

export type ProcessStatus = "running" | "waiting" | "blocked" | "completed" | "interrupted";
export type StepStatus = "pending" | "active" | "done" | "failed";
export type ArtifactKind = "file" | "test" | "screenshot" | "url" | "commit" | "report";
export type ProcessViewMode = "compact" | "full" | "off";

export interface ProcessStep {
	text: string;
	status: StepStatus;
}

export interface ProcessArtifact {
	kind: ArtifactKind;
	label: string;
	ref?: string;
}

export interface ProcessSnapshot {
	version: 1;
	title: string;
	status: ProcessStatus;
	steps: ProcessStep[];
	update?: string;
	blocker?: string;
	verification?: string;
	artifacts: ProcessArtifact[];
	startedAt: number;
	updatedAt: number;
}

export type RuntimeStage =
	| "starting"
	| "analyzing"
	| "preparing_tools"
	| "running_tools"
	| "analyzing_results"
	| "drafting"
	| "settled";

export interface ToolActivity {
	callId: string;
	toolName: string;
	label: string;
	startedAt: number;
}

export interface RecentToolOutcome {
	toolName: string;
	label: string;
	isError: boolean;
	finishedAt: number;
}

export interface ActivitySnapshot {
	stage: RuntimeStage;
	activeTools: ToolActivity[];
	recentOutcome?: RecentToolOutcome;
}

export interface PersistedProcessState {
	version: 1;
	viewMode: ProcessViewMode;
	snapshot?: ProcessSnapshot;
	cleared: boolean;
}

export interface RuntimeControlState {
	pendingStopReason?: "aborted" | "error";
	pendingContextReminder?: ProcessSnapshot;
	requestStarted: boolean;
}

export interface ProcessRenderState {
	viewMode: ProcessViewMode;
	snapshot?: ProcessSnapshot;
	activity: ActivitySnapshot;
}

export const ProcessUpdateParams = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 120 }),
	status: StringEnum(["running", "waiting", "blocked", "completed"] as const),
	steps: Type.Array(
		Type.Object({
			text: Type.String({ minLength: 1, maxLength: 100 }),
			status: StringEnum(["pending", "active", "done", "failed"] as const),
		}),
		{ minItems: 1, maxItems: 5 },
	),
	update: Type.Optional(Type.String({ maxLength: 180 })),
	blocker: Type.Optional(Type.String({ maxLength: 240 })),
	verification: Type.Optional(Type.String({ maxLength: 180 })),
	artifacts: Type.Optional(Type.Array(
		Type.Object({
			kind: StringEnum(["file", "test", "screenshot", "url", "commit", "report"] as const),
			label: Type.String({ minLength: 1, maxLength: 80 }),
			ref: Type.Optional(Type.String({ maxLength: 200 })),
		}),
		{ maxItems: 5 },
	)),
});

export type ProcessUpdateInput = Static<typeof ProcessUpdateParams>;
