/** Desired-vs-registered model diff. */

export function diffModels(current: string[], desired: string[]): { added: string[]; removed: string[] } {
	const have = new Set(current);
	const want = new Set(desired);
	const added = desired.filter((id) => !have.has(id));
	const removed = current.filter((id) => !want.has(id));
	return { added, removed };
}

/** Minimal pi surface the sync engine needs. */
export interface EnginePi {
	registerProvider(id: string, config: unknown): void;
	unregisterProvider(id: string): void;
}

/** What one source has registered: provider ids and the model ids inside them. */
export interface RegisteredState {
	providerIds: string[];
	modelIds: string[];
}

/** One provider the source wants live, with everything but the models decided. */
export interface DesiredProvider {
	providerId: string;
	models: { id: string }[];
	/** Register `models` under providerId (api/baseUrl/headers/streamSimple fixed per source). */
	register(models: { id: string }[]): void;
}

export interface MultiSyncDeps {
	pi: EnginePi;
	/** Notification prefix, e.g. "zenfree". */
	label: string;
	notify(message: string): void;
	notifyOnChange: boolean;
	isCurrentModel(id: string): boolean;
	/** Mutated in place — the caller's record of what is registered. */
	registered: RegisteredState;
}

/**
 * Apply a desired multi-provider registration atomically-ish: register every
 * target, drop stale providers, diff model ids for the aggregate change
 * notification, and prompt a switch when the active model was delisted.
 * Never throws.
 */
export function syncProviders(deps: MultiSyncDeps, desired: DesiredProvider[]): { added: string[]; removed: string[] } {
	const desiredIds = desired.flatMap((target) => target.models.map((m) => m.id));
	const { added, removed } = diffModels(deps.registered.modelIds, desiredIds);

	if (desired.length === 0) {
		if (deps.registered.providerIds.length > 0) {
			const delistedActive = deps.registered.modelIds.find((id) => deps.isCurrentModel(id));
			for (const providerId of [...deps.registered.providerIds]) {
				try {
					deps.pi.unregisterProvider(providerId);
				} catch {
					// already gone
				}
			}
			deps.registered.providerIds.length = 0;
			deps.registered.modelIds.length = 0;
			deps.notify(`${deps.label}: free lineup is empty — provider unregistered`);
			if (delistedActive) {
				deps.notify(`${deps.label}: active model ${delistedActive} was delisted and the free lineup is now empty — switch models to keep working`);
			}
		}
		return { added, removed };
	}

	for (const stale of deps.registered.providerIds.filter((id) => !desired.some((t) => t.providerId === id))) {
		try {
			deps.pi.unregisterProvider(stale);
		} catch {
			// already gone
		}
	}
	for (const target of desired) {
		try {
			target.register(target.models);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			deps.notify(`${deps.label}: registering ${target.providerId} failed (${reason})`);
		}
	}
	deps.registered.providerIds.splice(0, deps.registered.providerIds.length, ...desired.map((t) => t.providerId));
	deps.registered.modelIds.splice(0, deps.registered.modelIds.length, ...desiredIds);

	if (added.length > 0 || removed.length > 0) {
		if (deps.notifyOnChange) {
			const parts: string[] = [];
			if (added.length > 0) parts.push(`+${added.length} new: ${added.join(", ")}`);
			if (removed.length > 0) parts.push(`−${removed.length} delisted: ${removed.join(", ")}`);
			deps.notify(`${deps.label}: ${parts.join(" · ")}`);
		}
		const delistedActive = removed.find((id) => deps.isCurrentModel(id));
		if (delistedActive) {
			deps.notify(`${deps.label}: active model ${delistedActive} was delisted — switch models (e.g. /model ${desired[0]!.providerId}/${added[0] ?? desiredIds[0]}) to keep working`);
		}
	}

	return { added, removed };
}
