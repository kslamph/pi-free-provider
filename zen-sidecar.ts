/**
 * Bun sidecar relay for zenfree — run by bun only (excluded from tsc; Bun globals).
 *
 * A loopback HTTP forwarder for https://opencode.ai/inference/openai/v1. Zen's
 * gateway TLS-fingerprints its clients and serves the free tier only to
 * BoringSSL-shaped ones (the official client's runtime); this relay gives the
 * Node-based pi extension that transport while stream.ts keeps full control of
 * the request shape.
 *
 * Protocol: prints `SIDECAR_READY <port>` on stdout once listening; exits when
 * stdin closes so it never outlives its parent. Requests are forwarded
 * verbatim (path, headers, body, abort signal); responses stream back with the
 * framing headers Bun's fetch already consumed stripped.
 *
 * Run: bun zen-sidecar.ts          (ZENFREE_SIDECAR_PORT pins the port; default: random)
 */

const UPSTREAM = "https://opencode.ai/inference/openai/v1";
const port = Number(process.env.ZENFREE_SIDECAR_PORT ?? 0);

const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	// Long-lived SSE streams: cap Bun's per-connection idle timeout.
	idleTimeout: 255,
	fetch: async (req) => {
		const url = new URL(req.url);
		const target = UPSTREAM + url.pathname.replace(/^\/v1/, "") + url.search;
		const headers = new Headers(req.headers);
		// Let Bun's fetch pick its own framing/compression headers.
		for (const hop of ["host", "content-length", "connection", "accept-encoding"]) headers.delete(hop);
		try {
			const upstream = await fetch(target, {
				method: req.method,
				headers,
				body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
				redirect: "manual",
				signal: req.signal,
			});
			const out = new Headers();
			for (const [key, value] of upstream.headers) {
				// Bun's fetch already decoded the body; pass framing headers through untouched.
				if (/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(key)) continue;
				out.set(key, value);
			}
			return new Response(upstream.body, { status: upstream.status, headers: out });
		} catch (error) {
			return new Response(
				JSON.stringify({ type: "error", error: { type: "SidecarError", message: error instanceof Error ? error.message : String(error) } }),
				{ status: 502, headers: { "content-type": "application/json" } },
			);
		}
	},
});

// Parent-death watchdog: the manager keeps stdin open for our lifetime.
process.stdin.resume();
process.stdin.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

console.log(`SIDECAR_READY ${server.port}`);
