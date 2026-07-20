import type { ModelProfile, ThinkingLevel } from "./types.ts";

export interface CurrentModelRef {
	provider: string;
	id: string;
}

/** True when current model + thinking match the profile exactly. */
export function profileMatches(
	profile: ModelProfile,
	model: CurrentModelRef | undefined | null,
	thinking: ThinkingLevel,
): boolean {
	if (!model) return false;
	return (
		model.provider === profile.provider &&
		model.id === profile.model &&
		thinking === profile.thinking
	);
}

/** First configured profile that matches current session state. */
export function findMatchingProfile(
	profiles: readonly ModelProfile[],
	model: CurrentModelRef | undefined | null,
	thinking: ThinkingLevel,
): ModelProfile | undefined {
	return profiles.find((profile) => profileMatches(profile, model, thinking));
}
