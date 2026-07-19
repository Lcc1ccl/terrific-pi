import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, type Api, type Message, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRegistry, ResourceLoader } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BTW_SYSTEM_PROMPT } from "./btw-context.ts";

type RegistryBridge = Pick<
	ModelRegistry,
	"getApiKeyAndHeaders" | "getRegisteredProviderConfig" | "getRegisteredProviderIds"
>;

function createIsolatedResourceLoader(): ResourceLoader {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => BTW_SYSTEM_PROMPT,
		getAppendSystemPrompt: () => [],
		extendResources() {},
		async reload() {},
	};
}

async function createSidecarModelRuntime(
	model: Model<Api>,
	registry?: RegistryBridge,
): Promise<ModelRuntime> {
	const credentials = new InMemoryCredentialStore();
	if (!registry) return ModelRuntime.create({ credentials, allowModelNetwork: false });

	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key for ${model.provider}`);
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: auth.apiKey, env: auth.env }));
	const runtime = await ModelRuntime.create({ credentials, allowModelNetwork: false });
	for (const providerId of registry.getRegisteredProviderIds()) {
		const config = registry.getRegisteredProviderConfig(providerId);
		if (!config) continue;
		runtime.registerProvider(providerId, providerId === model.provider && auth.headers
			? { ...config, headers: { ...config.headers, ...auth.headers } }
			: config);
	}
	return runtime;
}

export async function createIsolatedBtwSession(options: {
	cwd: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	messages: Message[];
	modelRegistry?: RegistryBridge;
}): Promise<AgentSession> {
	const modelRuntime = await createSidecarModelRuntime(options.model, options.modelRegistry);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		modelRuntime,
		resourceLoader: createIsolatedResourceLoader(),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		sessionManager: SessionManager.inMemory(options.cwd),
		noTools: "all",
		tools: [],
	});
	session.agent.state.messages = [...options.messages] as typeof session.agent.state.messages;
	return session;
}
