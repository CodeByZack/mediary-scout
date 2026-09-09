import { describe, expect, it } from "vitest";
import {


  phaseProgress,
  type AgentPhase,
} from "../src/acquisition-v2/activity.js";


describe("phaseProgress — phase-weighted, starts ~5%, never 100% pre-finalize", () => {
  it("bands per phase", () => {
    expect(phaseProgress("search")).toBeGreaterThanOrEqual(5);
    expect(phaseProgress("search")).toBeLessThan(15);
    expect(phaseProgress("transfer")).toBeGreaterThanOrEqual(25);
    expect(phaseProgress("transfer")).toBeLessThanOrEqual(60);
    expect(phaseProgress("finalize")).toBeLessThanOrEqual(99);
  });

  it("mark band driven by the real obtained/needed fraction", () => {
    expect(phaseProgress("mark", 0)).toBe(85);
    expect(phaseProgress("mark", 1)).toBe(95);
    expect(phaseProgress("mark", 0.5)).toBe(90);
  });
});


it("phase order is the canonical 7-phase pipeline", () => {
  const order: AgentPhase[] = ["search", "pick", "transfer", "verify", "organize", "mark", "finalize"];
  const percents = order.map((p) => phaseProgress(p, 0));
  for (let i = 1; i < percents.length; i += 1) {
    expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!);
  }
});
