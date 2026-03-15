import { describe, it, expect } from "vitest";
import { deterministicDedup } from "./full-audit-analyzer";
import type { DbRecommendation } from "./full-audit-analyzer";

function makeDbRec(overrides: Partial<DbRecommendation> = {}): DbRecommendation {
  return {
    id: 1,
    audit_id: 1,
    instance_id: "i-abc123",
    instance_name: "test-instance",
    instance_type: "t3.medium",
    category: "stop",
    severity: "high",
    current_monthly_cost: 100,
    estimated_savings: 100,
    action: "Stop this instance",
    details: JSON.stringify({ reasoning: "Instance is idle" }),
    ...overrides,
  };
}

describe("deterministicDedup", () => {
  it("returns empty array for empty input", () => {
    expect(deterministicDedup([])).toHaveLength(0);
  });

  it("passes through single recommendation unchanged", () => {
    const rec = makeDbRec();
    const result = deterministicDedup([rec]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(rec);
  });

  it("deduplicates exact same instance_id + category, keeps highest savings", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "stop", estimated_savings: 50 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "stop", estimated_savings: 100 }),
    ];
    const result = deterministicDedup(recs);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2); // higher savings
  });

  it("keeps different categories for same instance", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "stop", estimated_savings: 100 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "orphan-ebs", estimated_savings: 20 }),
    ];
    const result = deterministicDedup(recs);
    // stop + storage category → both kept
    expect(result).toHaveLength(2);
  });

  it("stop subsumes compute categories", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "stop", estimated_savings: 100 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "right-size", estimated_savings: 30 }),
      makeDbRec({ id: 3, instance_id: "i-1", category: "graviton-migrate", estimated_savings: 20 }),
    ];
    const result = deterministicDedup(recs);
    const categories = result.map((r) => r.category);
    expect(categories).toContain("stop");
    expect(categories).not.toContain("right-size");
    expect(categories).not.toContain("graviton-migrate");
  });

  it("idle subsumes compute categories like stop does", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "idle", estimated_savings: 100 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "right-size", estimated_savings: 30 }),
      makeDbRec({ id: 3, instance_id: "i-1", category: "schedule-stop", estimated_savings: 50 }),
    ];
    const result = deterministicDedup(recs);
    const categories = result.map((r) => r.category);
    expect(categories).toContain("idle");
    expect(categories).not.toContain("right-size");
    expect(categories).not.toContain("schedule-stop");
  });

  it("stop keeps storage categories", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "stop", estimated_savings: 100 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "orphan-ebs", estimated_savings: 10 }),
      makeDbRec({ id: 3, instance_id: "i-1", category: "stopped-ebs", estimated_savings: 5 }),
      makeDbRec({ id: 4, instance_id: "i-1", category: "snapshot-cleanup", estimated_savings: 3 }),
    ];
    const result = deterministicDedup(recs);
    expect(result).toHaveLength(4);
  });

  it("opensearch-idle subsumes other opensearch categories", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "domain-1", category: "opensearch-idle", estimated_savings: 200 }),
      makeDbRec({ id: 2, instance_id: "domain-1", category: "opensearch-oversized-storage", estimated_savings: 30 }),
      makeDbRec({ id: 3, instance_id: "domain-1", category: "opensearch-old-engine", estimated_savings: 10 }),
    ];
    const result = deterministicDedup(recs);
    const categories = result.map((r) => r.category);
    expect(categories).toContain("opensearch-idle");
    expect(categories).not.toContain("opensearch-oversized-storage");
    expect(categories).not.toContain("opensearch-old-engine");
  });

  it("opensearch-idle keeps non-opensearch categories for same ID", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "resource-1", category: "opensearch-idle", estimated_savings: 200 }),
      makeDbRec({ id: 2, instance_id: "resource-1", category: "orphan-ebs", estimated_savings: 50 }),
    ];
    const result = deterministicDedup(recs);
    // opensearch-idle subsumption only removes other opensearch-* categories
    // orphan-ebs is not an opensearch category, so both should be kept
    expect(result).toHaveLength(2);
  });

  it("right-size vs graviton overlap: zeroes smaller savings", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "right-size", estimated_savings: 60 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "graviton-migrate", estimated_savings: 40 }),
    ];
    const result = deterministicDedup(recs);
    expect(result).toHaveLength(2);
    const rightSize = result.find((r) => r.category === "right-size")!;
    const graviton = result.find((r) => r.category === "graviton-migrate")!;
    expect(rightSize.estimated_savings).toBe(60);
    expect(graviton.estimated_savings).toBe(0);
  });

  it("schedule-stop vs reserved-instance conflict: zeroes smaller savings", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "schedule-stop", estimated_savings: 30 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "reserved-instance", estimated_savings: 50 }),
    ];
    const result = deterministicDedup(recs);
    expect(result).toHaveLength(2);
    const schedStop = result.find((r) => r.category === "schedule-stop")!;
    const ri = result.find((r) => r.category === "reserved-instance")!;
    expect(schedStop.estimated_savings).toBe(0);
    expect(ri.estimated_savings).toBe(50);
  });

  it("schedule-stop vs savings-plan conflict: zeroes smaller savings", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "schedule-stop", estimated_savings: 70 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "savings-plan", estimated_savings: 40 }),
    ];
    const result = deterministicDedup(recs);
    const schedStop = result.find((r) => r.category === "schedule-stop")!;
    const sp = result.find((r) => r.category === "savings-plan")!;
    expect(schedStop.estimated_savings).toBe(70);
    expect(sp.estimated_savings).toBe(0);
  });

  it("handles multiple resources independently", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "stop", estimated_savings: 100 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "right-size", estimated_savings: 50 }),
      makeDbRec({ id: 3, instance_id: "i-2", category: "right-size", estimated_savings: 30 }),
      makeDbRec({ id: 4, instance_id: "i-2", category: "graviton-migrate", estimated_savings: 20 }),
    ];
    const result = deterministicDedup(recs);

    // i-1: stop subsumes right-size → only stop
    const i1Recs = result.filter((r) => r.instance_id === "i-1");
    expect(i1Recs).toHaveLength(1);
    expect(i1Recs[0].category).toBe("stop");

    // i-2: right-size > graviton → graviton savings zeroed, both kept
    const i2Recs = result.filter((r) => r.instance_id === "i-2");
    expect(i2Recs).toHaveLength(2);
    const graviton = i2Recs.find((r) => r.category === "graviton-migrate")!;
    expect(graviton.estimated_savings).toBe(0);
  });

  it("handles recommendations without instance_id", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "", category: "stop", estimated_savings: 100 }),
      makeDbRec({ id: 2, instance_id: "", category: "stop", estimated_savings: 50 }),
    ];
    const result = deterministicDedup(recs);
    // Same instance_id ("") + same category → dedup to highest
    expect(result).toHaveLength(1);
    expect(result[0].estimated_savings).toBe(100);
  });

  // ─── Additional subsumption coverage ──────────────────────────────────────

  it("stop subsumes generation-upgrade, reserved-instance, savings-plan", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "stop", estimated_savings: 100 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "generation-upgrade", estimated_savings: 20 }),
      makeDbRec({ id: 3, instance_id: "i-1", category: "reserved-instance", estimated_savings: 40 }),
      makeDbRec({ id: 4, instance_id: "i-1", category: "savings-plan", estimated_savings: 35 }),
    ];
    const result = deterministicDedup(recs);
    const categories = result.map((r) => r.category);
    expect(categories).toEqual(["stop"]);
  });

  it("stop keeps all storage categories (ebs-optimize, ebs-iops-optimize, unused-ami)", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "stop", estimated_savings: 100 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "ebs-optimize", estimated_savings: 10 }),
      makeDbRec({ id: 3, instance_id: "i-1", category: "ebs-iops-optimize", estimated_savings: 5 }),
      makeDbRec({ id: 4, instance_id: "i-1", category: "unused-ami", estimated_savings: 3 }),
    ];
    const result = deterministicDedup(recs);
    expect(result).toHaveLength(4);
    const categories = result.map((r) => r.category).sort();
    expect(categories).toEqual(["ebs-iops-optimize", "ebs-optimize", "stop", "unused-ami"]);
  });

  it("right-size == graviton tie: graviton is zeroed (right-size >= graviton)", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "right-size", estimated_savings: 50 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "graviton-migrate", estimated_savings: 50 }),
    ];
    const result = deterministicDedup(recs);
    const rightSize = result.find((r) => r.category === "right-size")!;
    const graviton = result.find((r) => r.category === "graviton-migrate")!;
    expect(rightSize.estimated_savings).toBe(50); // wins tie
    expect(graviton.estimated_savings).toBe(0);
  });

  it("schedule-stop == reserved-instance tie: RI is zeroed (schedule-stop >= RI)", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "schedule-stop", estimated_savings: 50 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "reserved-instance", estimated_savings: 50 }),
    ];
    const result = deterministicDedup(recs);
    const schedStop = result.find((r) => r.category === "schedule-stop")!;
    const ri = result.find((r) => r.category === "reserved-instance")!;
    expect(schedStop.estimated_savings).toBe(50); // wins tie
    expect(ri.estimated_savings).toBe(0);
  });

  it("combined conflicts: right-size + graviton + schedule-stop + savings-plan on same resource", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "right-size", estimated_savings: 60 }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "graviton-migrate", estimated_savings: 40 }),
      makeDbRec({ id: 3, instance_id: "i-1", category: "schedule-stop", estimated_savings: 70 }),
      makeDbRec({ id: 4, instance_id: "i-1", category: "savings-plan", estimated_savings: 30 }),
    ];
    const result = deterministicDedup(recs);
    expect(result).toHaveLength(4);
    // right-size (60) > graviton (40) → graviton zeroed
    expect(result.find((r) => r.category === "graviton-migrate")!.estimated_savings).toBe(0);
    // schedule-stop (70) > savings-plan (30) → savings-plan zeroed
    expect(result.find((r) => r.category === "savings-plan")!.estimated_savings).toBe(0);
    // Winners keep their savings
    expect(result.find((r) => r.category === "right-size")!.estimated_savings).toBe(60);
    expect(result.find((r) => r.category === "schedule-stop")!.estimated_savings).toBe(70);
  });

  it("subsumption removes specific IDs (verified by ID, not just length)", () => {
    const recs = [
      makeDbRec({ id: 10, instance_id: "i-1", category: "stop", estimated_savings: 100 }),
      makeDbRec({ id: 20, instance_id: "i-1", category: "right-size", estimated_savings: 50 }),
      makeDbRec({ id: 30, instance_id: "i-1", category: "graviton-migrate", estimated_savings: 30 }),
    ];
    const result = deterministicDedup(recs);
    const resultIds = result.map((r) => r.id);
    expect(resultIds).toContain(10);    // stop kept
    expect(resultIds).not.toContain(20); // right-size subsumed
    expect(resultIds).not.toContain(30); // graviton subsumed
  });

  it("exact dedup preserves all fields of winner and leaves unrelated recs untouched", () => {
    const recs = [
      makeDbRec({ id: 1, instance_id: "i-1", category: "stop", estimated_savings: 50, action: "Lower savings" }),
      makeDbRec({ id: 2, instance_id: "i-1", category: "stop", estimated_savings: 100, action: "Higher savings" }),
      makeDbRec({ id: 3, instance_id: "i-2", category: "orphan-ebs", estimated_savings: 25, action: "Delete volume" }),
    ];
    const result = deterministicDedup(recs);
    expect(result).toHaveLength(2);
    // Winner keeps all fields
    const winner = result.find((r) => r.instance_id === "i-1")!;
    expect(winner.id).toBe(2);
    expect(winner.estimated_savings).toBe(100);
    expect(winner.action).toBe("Higher savings");
    // Unrelated rec untouched
    const other = result.find((r) => r.instance_id === "i-2")!;
    expect(other.id).toBe(3);
    expect(other.estimated_savings).toBe(25);
    expect(other.action).toBe("Delete volume");
  });

  it("deduplicateFullAudit converts DbRecommendation to DedupResult format", async () => {
    const { deduplicateFullAudit } = await import("./full-audit-analyzer");
    const recs = [
      makeDbRec({
        id: 1,
        instance_id: "i-test",
        instance_name: "my-server",
        instance_type: "t3.large",
        category: "orphan-ebs",
        severity: "medium",
        current_monthly_cost: 50,
        estimated_savings: 30,
        action: "Delete orphaned volume",
        details: JSON.stringify({ reasoning: "Volume is detached", metadata: { region: "us-east-1", az: "us-east-1a" } }),
      }),
    ];
    // LLM calls are skipped (no API key in test setup)
    const result = await deduplicateFullAudit(recs);
    expect(result).toHaveLength(1);
    expect(result[0].instanceId).toBe("i-test");
    expect(result[0].instanceName).toBe("my-server");
    expect(result[0].instanceType).toBe("t3.large");
    expect(result[0].category).toBe("orphan-ebs");
    expect(result[0].severity).toBe("medium");
    expect(result[0].currentMonthlyCost).toBe(50);
    expect(result[0].estimatedSavings).toBe(30);
    expect(result[0].action).toBe("Delete orphaned volume");
    expect(result[0].reasoning).toBe("Volume is detached");
    expect(result[0].metadata).toEqual({ region: "us-east-1", az: "us-east-1a" });
  });
});
