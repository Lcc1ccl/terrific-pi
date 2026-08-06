type Method = (this: unknown, ...args: any[]) => any;

interface PatchOwner {
	token: object;
	wrapper: Method;
}

interface PatchState {
	version: number;
	originalDescriptor: PropertyDescriptor | undefined;
	original: Method;
	owners: PatchOwner[];
}

export interface PrototypePatchHandle {
	uninstall(): void;
}

export function patchPrototypeMethod(
	prototype: object,
	key: string,
	stateKey: symbol,
	version: number,
	build: (original: Method) => Method,
): PrototypePatchHandle | undefined {
	const target = prototype as Record<PropertyKey, unknown>;
	const current = target[key];
	if (typeof current !== "function") return undefined;

	let state = target[stateKey] as PatchState | undefined;
	const currentOwner = state?.owners.at(-1);
	if (!state || state.version !== version || current !== currentOwner?.wrapper) {
		const original = current as Method;
		state = {
			version,
			originalDescriptor: Object.getOwnPropertyDescriptor(prototype, key),
			original,
			owners: [],
		};
		target[stateKey] = state;
	}

	const owner: PatchOwner = { token: {}, wrapper: build(state.original) };
	state.owners.push(owner);
	Object.defineProperty(prototype, key, {
		...(state.originalDescriptor ?? {}),
		value: owner.wrapper,
		writable: true,
		configurable: true,
	});
	let active = true;
	return {
		uninstall() {
			if (!active) return;
			active = false;
			const ownerIndex = state!.owners.findIndex((candidate) => candidate.token === owner.token);
			if (ownerIndex < 0) return;
			const ownsCurrentMethod = target[key] === owner.wrapper;
			state!.owners.splice(ownerIndex, 1);
			if (target[stateKey] !== state) return;
			const previousOwner = state!.owners.at(-1);
			if (ownsCurrentMethod && previousOwner) {
				Object.defineProperty(prototype, key, {
					...(state!.originalDescriptor ?? {}),
					value: previousOwner.wrapper,
					writable: true,
					configurable: true,
				});
			} else if (ownsCurrentMethod) {
				if (state!.originalDescriptor) Object.defineProperty(prototype, key, state!.originalDescriptor);
				else target[key] = state!.original;
			}
			if (!previousOwner) delete target[stateKey];
		},
	};
}
