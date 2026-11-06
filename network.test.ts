import { describe, expect, it } from "vitest";
import { fetchWithTimeout, withSyncDeadline } from "./network.ts";

describe("background sync network bounds", () => {
	it("aborts a request when its per-request deadline expires", async () => {
		const fetcher: typeof fetch = async (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});

		await expect(fetchWithTimeout(fetcher, "https://example.test", undefined, undefined, 10)).rejects.toThrow("aborted");
	});

	it("aborts the shared controller when the overall sync deadline expires", async () => {
		const controller = new AbortController();
		const task = new Promise<void>(() => {});

		await expect(withSyncDeadline(task, controller, 10)).rejects.toThrow(/exceeded 10ms/);
		expect(controller.signal.aborted).toBe(true);
	});
});
