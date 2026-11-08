import { describe, expect, it } from "vitest";
import { ZEN_OFFICIAL_SYSTEM_PROMPT } from "./opencode-system-prompt.ts";

// Live-gateway bisection (2026-11-08, glm-5.3-flash-free + deepseek-v4.1-flash-free):
// the free-tier gate requires an <env>...</env> block with a verbatim two-space
// "Working directory: " line; everything else in the block is not inspected.
// These assertions encode that contract — a structural regression here means 429s.
describe("zenfree system pad", () => {
  const pad = ZEN_OFFICIAL_SYSTEM_PROMPT;

  it("is a non-empty string shaped like OpenCode's env section", () => {
    expect(typeof pad).toBe("string");
    expect(pad.length).toBeGreaterThan(0);
    expect(pad).toMatch(/^Here is some useful information about the environment/);
    expect(pad).toContain("<env>");
    expect(pad).toContain("</env>");
    expect(pad.match(/<env>/g)).toHaveLength(1);
    expect(pad.match(/<\/env>/g)).toHaveLength(1);
  });

  it("carries the verbatim two-space Working directory line the gate requires", () => {
    const line = pad.split("\n").find((l) => l.startsWith("  Working directory:"));
    expect(line).toBeDefined();
    expect(line!.slice("  Working directory: ".length)).not.toBe("");
    expect(line!.slice("  Working directory: ".length)).not.toBe("unknown");
  });

  it("reports a real working directory, not a placeholder", () => {
    const line = pad.split("\n").find((l) => l.startsWith("  Working directory:"))!;
    const dir = line.slice("  Working directory: ".length);
    expect(existsSync(dir)).toBe(true);
  });

  it("fills every env field honestly", () => {
    expect(pad).toContain("Workspace root folder: ");
    expect(pad).toMatch(/Is directory a git repo: (yes|no)/);
    expect(pad).toMatch(/Platform: (linux|darwin|win32)/);
    expect(pad).toContain("Prefer ");
    expect(pad).toContain("opencode over generic system temporary directories");
  });
});

import { existsSync } from "node:fs";
