/**
 * Minimal free-tier system pad.
 *
 * The Zen gate fingerprints the request body for OpenCode's official system
 * prompt. Live-gateway bisection (2026-11-08, glm-5.3-flash-free and
 * deepseek-v4.1-flash-free, identical verdicts) shows the fingerprint is an
 * <env>...</env> block with a verbatim two-space "Working directory: " line:
 * every other env field (workspace root, git flag, platform, tmp sentence),
 * the intro sentence, and even the directory value are not inspected —
 * though value checks were observed under a different network environment,
 * so the real working directory is reported. Keeping the contract — a single
 * ZEN_OFFICIAL_SYSTEM_PROMPT export, verbatim env format, real cwd — cuts the
 * pad from ~5.2K tokens to ~15 per request; identity across requests keeps
 * prefix caching intact.
 */
export const ZEN_OFFICIAL_SYSTEM_PROMPT = [
	"<env>",
	`  Working directory: ${process.cwd()}`,
	"</env>",
].join("\n");
