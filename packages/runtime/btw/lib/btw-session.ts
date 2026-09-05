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
	const loader = {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => BTW_SYSTEM_PROMPT,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources() {},
		async reload() {},
	};
	return loader;
}

export function raceWithSignal<T>(
	operation: Promise<T>,
	signal: AbortSignal,
	onLateValue?: (value: T) => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let finished = false;
		const onAbort = () => {
			if (finished) return;
			finished = true;
			reject(signal.reason ?? new Error("Operation aborted"));
		};
		void operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				if (finished) {
					try { onLateValue?.(value); } catch {}
					return;
				}
				finished = true;
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				if (finished) return;
				finished = true;
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function createSidecarModelRuntime(
	model: Model<Api>,
	registry?: RegistryBridge,
	signal?: AbortSignal,
): Promise<ModelRuntime> {
	const credentials = new InMemoryCredentialStore();
	const wait = <T>(operation: Promise<T>) => signal ? raceWithSignal(operation, signal) : operation;
	if (!registry) return wait(ModelRuntime.create({ credentials, allowModelNetwork: false }));

	const auth = await wait(registry.getApiKeyAndHeaders(model));
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key for ${model.provider}`);
	await wait(credentials.modify(model.provider, async () => ({ type: "api_key", key: auth.apiKey, env: auth.env })));
	const runtime = await wait(ModelRuntime.create({ credentials, allowModelNetwork: false }));
	for (const providerId of registry.getRegisteredProviderIds()) {
		const config = registry.getRegisteredProviderConfig(providerId);
		if (!config) continue;
		const registered = providerId === model.provider && auth.headers
			? { ...config, headers: { ...config.headers, ...auth.headers } }
			: config;
		// registerProvider() still declares string-only headers but preserves null suppression at runtime.
		runtime.registerProvider(providerId, registered as Parameters<ModelRuntime["registerProvider"]>[1]);
	}
	return runtime;
}

export async function createIsolatedBtwSession(options: {
	cwd: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	messages: Message[];
	modelRegistry?: RegistryBridge;
	signal?: AbortSignal;
}): Promise<AgentSession> {
	const modelRuntime = await createSidecarModelRuntime(options.model, options.modelRegistry, options.signal);
	const create = createAgentSession({
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
	const { session } = options.signal
		? await raceWithSignal(create, options.signal, ({ session: lateSession }) => lateSession.dispose())
		: await create;
	session.agent.state.messages = [...options.messages] as typeof session.agent.state.messages;
	return session;
}
