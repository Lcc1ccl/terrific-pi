type Method = (this: unknown, ...args: any[]) => any;

interface PatchState {
	version: number;
	originalDescriptor: PropertyDescriptor | undefined;
	original: Method;
	wrapper: Method;
	owners: Set<object>;
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
	if (state && state.version === version && current === state.wrapper) {
		// A reload can install a new extension closure before an older handle is
		// released. Rebind to the newest closure while retaining the real native
		// method as the only restoration target.
		state.wrapper = build(state.original);
		Object.defineProperty(prototype, key, {
			...(state.originalDescriptor ?? {}),
			value: state.wrapper,
			writable: true,
			configurable: true,
		});
	} else if (!state || state.version !== version || current !== state.wrapper) {
		const original = current as Method;
		state = {
			version,
			originalDescriptor: Object.getOwnPropertyDescriptor(prototype, key),
			original,
			wrapper: build(original),
			owners: new Set(),
		};
		Object.defineProperty(prototype, key, {
			...(state.originalDescriptor ?? {}),
			value: state.wrapper,
			writable: true,
			configurable: true,
		});
		target[stateKey] = state;
	}

	const owner = {};
	state.owners.add(owner);
	let active = true;
	return {
		uninstall() {
			if (!active) return;
			active = false;
			state!.owners.delete(owner);
			if (state!.owners.size > 0 || target[stateKey] !== state) return;
			if (target[key] === state!.wrapper) {
				if (state!.originalDescriptor) Object.defineProperty(prototype, key, state!.originalDescriptor);
				else target[key] = state!.original;
			}
			delete target[stateKey];
		},
	};
}
