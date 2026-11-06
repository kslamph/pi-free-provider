/** Shared timeout and cancellation helpers for background provider syncs. */

/** Maximum time spent on one metadata request during automatic sync. */
export const SYNC_REQUEST_TIMEOUT_MS = 10_000;
/** Maximum time allowed for one complete automatic provider sync. */
export const SYNC_DEADLINE_MS = 30_000;

/**
 * Combine a caller's cancellation with a per-request deadline.
 * AbortSignal.timeout is available on the supported Node runtime (>=22).
 */
export function requestSignal(parent: AbortSignal | undefined, timeoutMs = SYNC_REQUEST_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** Fetch with a bounded wait while preserving the caller's abort signal. */
export function fetchWithTimeout(
	fetcher: typeof fetch,
	input: string | URL,
	init: RequestInit | undefined,
	parent?: AbortSignal,
	timeoutMs = SYNC_REQUEST_TIMEOUT_MS,
): Promise<Response> {
	return fetcher(input, { ...init, signal: requestSignal(parent, timeoutMs) });
}

/** A small error used when an automatic sync exceeds its overall deadline. */
export class SyncDeadlineError extends Error {
	constructor(timeoutMs = SYNC_DEADLINE_MS) {
		super(`automatic sync exceeded ${timeoutMs}ms`);
		this.name = "SyncDeadlineError";
	}
}

/**
 * Race a background task against a deadline. The caller owns the controller;
 * aborting it also cancels fetches that honor AbortSignal.
 */
export async function withSyncDeadline<T>(task: Promise<T>, controller: AbortController, timeoutMs = SYNC_DEADLINE_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new SyncDeadlineError(timeoutMs));
		}, timeoutMs);
	});
	try {
		return await Promise.race([task, deadline]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
