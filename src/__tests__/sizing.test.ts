import { describe, it, expect } from "vitest";
import { clampProposedMultiplier } from "../decision/sizing.js";
import { SMART_MIN_MULT, SMART_DEFAULT_MAX_MULT } from "../ledger/schedule.js";

describe("clampProposedMultiplier — the agent's proposal is never trusted raw", () => {
  it("passes an in-range proposal through unchanged", () => {
    expect(clampProposedMultiplier(1.8)).toBe(1.8);
    expect(clampProposedMultiplier(1)).toBe(1);
  });

  it("clamps above the ceiling and below the floor", () => {
    expect(clampProposedMultiplier(99)).toBe(SMART_DEFAULT_MAX_MULT);
    expect(clampProposedMultiplier(0)).toBe(SMART_MIN_MULT);
    expect(clampProposedMultiplier(-4)).toBe(SMART_MIN_MULT);
  });

  it("treats a non-finite proposal as neutral (1.0), so a bad LLM output is safe", () => {
    expect(clampProposedMultiplier(Number.NaN)).toBe(1);
    expect(clampProposedMultiplier(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
