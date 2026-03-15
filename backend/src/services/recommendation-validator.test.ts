import { describe, it, expect } from "vitest";
import { getSeverity, deterministicValidate } from "./recommendation-validator";
import type { DedupResult } from "./full-audit-analyzer";

function makeRec(overrides: Partial<DedupResult> = {}): DedupResult {
  return {
    instanceId: "i-abc123",
    instanceName: "test-instance",
    instanceType: "t3.medium",
    category: "stop",
    severity: "high",
    currentMonthlyCost: 100,
    estimatedSavings: 100,
    action: "Stop this instance",
    reasoning: "Instance is idle",
    ...overrides,
  };
}

describe("getSeverity", () => {
  it("returns 'high' for savings > 50", () => {
    expect(getSeverity(50.01)).toBe("high");
    expect(getSeverity(100)).toBe("high");
    expect(getSeverity(1000)).toBe("high");
  });

  it("returns 'medium' for savings >= 10 and <= 50", () => {
    expect(getSeverity(50)).toBe("medium");
    expect(getSeverity(10)).toBe("medium");
    expect(getSeverity(25)).toBe("medium");
  });

  it("returns 'low' for savings < 10", () => {
    expect(getSeverity(9.99)).toBe("low");
    expect(getSeverity(0)).toBe("low");
    expect(getSeverity(5)).toBe("low");
  });
});

describe("deterministicValidate", () => {
  it("zeroes savings for cross-service recommendations (Rule 1)", () => {
    const rec = makeRec({
      category: "cross-service",
      estimatedSavings: 100,
      currentMonthlyCost: 200,
    });
    const { recs, fixes } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(0);
    expect(recs[0].currentMonthlyCost).toBe(0);
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes[0]).toContain("cross-service");
  });

  it("zeroes savings on zero-cost resource (Rule 2)", () => {
    const rec = makeRec({
      category: "stop",
      currentMonthlyCost: 0,
      estimatedSavings: 50,
      severity: "medium",
    });
    const { recs, fixes } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(0);
    expect(fixes.some((f) => f.includes("$0 cost resource"))).toBe(true);
  });

  it("caps savings that exceed cost (Rule 3)", () => {
    const rec = makeRec({
      currentMonthlyCost: 100,
      estimatedSavings: 150,
      // Use a category without expected ratio so Rule 4 doesn't also fire
      category: "orphan-ebs",
    });
    const { recs, fixes } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(100);
    expect(fixes.some((f) => f.includes("capped"))).toBe(true);
  });

  it("corrects savings ratio for deterministic categories (Rule 4)", () => {
    const rec = makeRec({
      category: "right-size",
      currentMonthlyCost: 100,
      estimatedSavings: 30, // actual ratio 0.30, expected 0.50
      severity: "medium",
    });
    const { recs, fixes } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(50); // 100 * 0.50
    expect(fixes.some((f) => f.includes("corrected savings ratio"))).toBe(true);
  });

  it("does not correct ratio within tolerance (Rule 4)", () => {
    const rec = makeRec({
      category: "stop",
      currentMonthlyCost: 100,
      estimatedSavings: 100, // ratio 1.00, expected 1.00
      severity: "high",
    });
    const { recs, fixes } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(100);
    // Only severity fix if any, not ratio
    expect(fixes.every((f) => !f.includes("corrected savings ratio"))).toBe(true);
  });

  it("corrects severity mismatch (Rule 5)", () => {
    const rec = makeRec({
      category: "orphan-ebs", // no ratio check
      currentMonthlyCost: 200,
      estimatedSavings: 100, // should be "high"
      severity: "low",
    });
    const { recs, fixes } = deterministicValidate([rec]);
    expect(recs[0].severity).toBe("high");
    expect(fixes.some((f) => f.includes("corrected severity"))).toBe(true);
  });

  it("compounds multiple rules correctly", () => {
    const rec = makeRec({
      category: "right-size",
      currentMonthlyCost: 100,
      estimatedSavings: 200, // > cost, then ratio correction
      severity: "high",
    });
    const { recs, fixes } = deterministicValidate([rec]);
    // Rule 3: capped to 100, Rule 4: corrected to 50 (0.50 ratio)
    expect(recs[0].estimatedSavings).toBe(50);
    // Rule 5: severity should now be "medium" (savings=50)
    expect(recs[0].severity).toBe("medium");
    expect(fixes.length).toBeGreaterThanOrEqual(2);
  });

  it("passes clean recommendation through unchanged", () => {
    const rec = makeRec({
      category: "orphan-ebs", // no ratio check
      currentMonthlyCost: 200,
      estimatedSavings: 100,
      severity: "high",
    });
    const { recs, fixes } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(100);
    expect(recs[0].severity).toBe("high");
    expect(fixes).toHaveLength(0);
  });

  it("handles empty input", () => {
    const { recs, fixes } = deterministicValidate([]);
    expect(recs).toHaveLength(0);
    expect(fixes).toHaveLength(0);
  });

  it("handles multiple recommendations independently", () => {
    const recs = [
      makeRec({ instanceId: "i-1", category: "orphan-ebs", currentMonthlyCost: 50, estimatedSavings: 30, severity: "medium" }),
      makeRec({ instanceId: "i-2", category: "orphan-ebs", currentMonthlyCost: 200, estimatedSavings: 100, severity: "low" }),
    ];
    const result = deterministicValidate(recs);
    expect(result.recs[0].estimatedSavings).toBe(30); // unchanged
    expect(result.recs[1].severity).toBe("high"); // corrected
  });

  // ─── Ratio tests for ALL EXPECTED_RATIOS categories ──────────────────────

  it("corrects idle category ratio to 1.00", () => {
    const rec = makeRec({ category: "idle", currentMonthlyCost: 100, estimatedSavings: 80, severity: "high" });
    const { recs } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(100); // 100 * 1.00
  });

  it("corrects schedule-stop category ratio to 0.65", () => {
    const rec = makeRec({ category: "schedule-stop", currentMonthlyCost: 100, estimatedSavings: 30, severity: "medium" });
    const { recs } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(65); // 100 * 0.65
  });

  it("corrects reserved-instance category ratio to 0.40", () => {
    const rec = makeRec({ category: "reserved-instance", currentMonthlyCost: 100, estimatedSavings: 20, severity: "medium" });
    const { recs } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(40); // 100 * 0.40
  });

  it("corrects savings-plan category ratio to 0.40", () => {
    const rec = makeRec({ category: "savings-plan", currentMonthlyCost: 100, estimatedSavings: 20, severity: "medium" });
    const { recs } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(40); // 100 * 0.40
  });

  it("corrects rds-right-size category ratio to 0.40", () => {
    const rec = makeRec({ category: "rds-right-size", currentMonthlyCost: 200, estimatedSavings: 50, severity: "medium" });
    const { recs } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(80); // 200 * 0.40
  });

  it("corrects rds-reserved-instance category ratio to 0.40", () => {
    const rec = makeRec({ category: "rds-reserved-instance", currentMonthlyCost: 100, estimatedSavings: 20, severity: "medium" });
    const { recs } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(40); // 100 * 0.40
  });

  it("corrects rds-aurora-migration category ratio to 0.25", () => {
    const rec = makeRec({ category: "rds-aurora-migration", currentMonthlyCost: 200, estimatedSavings: 20, severity: "medium" });
    const { recs } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(50); // 200 * 0.25
  });

  // ─── RATIO_TOLERANCE boundary tests ──────────────────────────────────────

  it("does NOT correct ratio within tolerance boundary", () => {
    // right-size expected = 0.50, tolerance = 0.02
    // savings=510, cost=1000 → ratio = 0.51, deviation = 0.01 → within tolerance, NOT corrected
    const rec = makeRec({ category: "right-size", currentMonthlyCost: 1000, estimatedSavings: 510, severity: "high" });
    const { recs, fixes } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(510); // unchanged
    expect(fixes.every((f) => !f.includes("corrected savings ratio"))).toBe(true);
  });

  it("corrects ratio beyond tolerance boundary", () => {
    // right-size expected = 0.50, tolerance = 0.02
    // savings=470, cost=1000 → ratio = 0.47, deviation = 0.03 → beyond tolerance, corrected
    const rec = makeRec({ category: "right-size", currentMonthlyCost: 1000, estimatedSavings: 470, severity: "high" });
    const { recs, fixes } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(500); // 1000 * 0.50
    expect(fixes.some((f) => f.includes("corrected savings ratio"))).toBe(true);
  });

  // ─── Cross-rule interaction tests ─────────────────────────────────────────

  it("Rule 2 + Rule 4: zero-cost right-size stays zeroed (ratio correction doesn't re-inflate)", () => {
    const rec = makeRec({
      category: "right-size",
      currentMonthlyCost: 0,
      estimatedSavings: 50,
      severity: "medium",
    });
    const { recs } = deterministicValidate([rec]);
    // Rule 2 zeroes savings (cost=0), Rule 4 would set 0*0.50=0 — stays 0
    expect(recs[0].estimatedSavings).toBe(0);
  });

  it("Rule 1 + Rule 5: cross-service zeroes savings AND corrects severity to low", () => {
    const rec = makeRec({
      category: "cross-service",
      currentMonthlyCost: 200,
      estimatedSavings: 100,
      severity: "high",
    });
    const { recs, fixes } = deterministicValidate([rec]);
    expect(recs[0].estimatedSavings).toBe(0);
    expect(recs[0].currentMonthlyCost).toBe(0);
    expect(recs[0].severity).toBe("low"); // getSeverity(0) = "low"
    expect(fixes.some((f) => f.includes("cross-service"))).toBe(true);
    expect(fixes.some((f) => f.includes("corrected severity"))).toBe(true);
  });

  // ─── validateRecommendations integration test ────────────────────────────

  it("validateRecommendations applies deterministic fixes (LLM skipped when no API key)", async () => {
    const { validateRecommendations } = await import("./recommendation-validator");
    const recs = [
      makeRec({ category: "orphan-ebs", currentMonthlyCost: 100, estimatedSavings: 200, severity: "high" }),
      makeRec({ instanceId: "i-2", category: "cross-service", estimatedSavings: 50, currentMonthlyCost: 0 }),
    ];
    const result = await validateRecommendations(recs);
    // First rec: savings capped to cost (200 → 100)
    expect(result[0].estimatedSavings).toBe(100);
    // Second rec: cross-service zeroed
    expect(result[1].estimatedSavings).toBe(0);
    expect(result[1].currentMonthlyCost).toBe(0);
  });
});
