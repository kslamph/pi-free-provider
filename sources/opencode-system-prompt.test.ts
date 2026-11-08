import { describe, expect, it } from "vitest";
import { ZEN_OFFICIAL_SYSTEM_PROMPT } from "./opencode-system-prompt.ts";

// Live-gateway bisection (2026-11-08, glm-5.3-flash-free + deepseek-v4.1-flash-free):
// the gate requires an <env>...</env> block with a verbatim two-space
// "Working directory: " line carrying a real directory. These assertions encode
// that contract — a structural regression here means 429s at runtime.
describe("zenfree system pad", () => {
  const pad = ZEN_OFFICIAL_SYSTEM_PROMPT;

  it("is exactly one env block", () => {
    expect(pad).toMatch(/^<env>\n/);
    expect(pad).toMatch(/\n<\/env>$/);
    expect(pad.match(/<env>/g)).toHaveLength(1);
    expect(pad.match(/<\/env>/g)).toHaveLength(1);
  });

  it("carries the verbatim two-space Working directory line", () => {
    const line = pad.split("\n").find((l) => l.startsWith("  Working directory:"));
    expect(line).toBeDefined();
    expect(line!.slice("  Working directory: ".length)).not.toBe("");
  });

  it("reports the real working directory, not a placeholder", () => {
    const line = pad.split("\n").find((l) => l.startsWith("  Working directory:"))!;
    const dir = line.slice("  Working directory: ".length);
    expect(dir).not.toBe("unknown");
    expect(existsSync(dir)).toBe(true);
  });

  it("contains nothing else (minimal kernel)", () => {
    expect(pad.split("\n")).toHaveLength(3);
  });
});

import { existsSync } from "node:fs";
