import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock("../db", () => {
  const run = vi.fn();
  const get = vi.fn();
  const all = vi.fn();
  const mockDb = {
    prepare: vi.fn().mockReturnValue({ run, get, all }),
    transaction: vi.fn((fn: Function) => fn),
  };
  return { default: mockDb };
});

vi.mock("../crypto", () => ({
  decrypt: vi.fn().mockReturnValue("decrypted-value"),
}));

vi.mock("../audit-registry", () => ({
  registerAuditType: vi.fn(),
}));

vi.mock("./resolution-carry-over", () => ({
  carryOverResolutions: vi.fn(),
}));

// Mock collectors
vi.mock("../aws/collector", () => ({
  collectAccountData: vi.fn(),
}));

vi.mock("../aws/rds-collector", () => ({
  collectRDSAccountData: vi.fn(),
}));

vi.mock("../aws/s3-collector", () => ({
  collectS3AccountData: vi.fn(),
}));

// Mock analyzers
vi.mock("./analyzer", () => ({
  analyzeWithClaude: vi.fn(),
  Recommendation: {},
  buildMetadata: vi.fn().mockReturnValue({}),
}));

vi.mock("./rds-analyzer", () => ({
  analyzeRDSWithClaude: vi.fn(),
}));

vi.mock("./s3-analyzer", () => ({
  analyzeS3WithClaude: vi.fn(),
}));

import db from "../db";
import { collectAccountData } from "../aws/collector";
import { collectRDSAccountData } from "../aws/rds-collector";
import { collectS3AccountData } from "../aws/s3-collector";
import { analyzeWithClaude } from "./analyzer";
import { analyzeRDSWithClaude } from "./rds-analyzer";
import { analyzeS3WithClaude } from "./s3-analyzer";
import { runAudit } from "./audit-runner";
import { runRDSAudit } from "./rds-audit-runner";
import { runS3Audit } from "./s3-audit-runner";

const mockDb = db as any;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: account exists
  mockDb.prepare.mockReturnValue({
    run: vi.fn(),
    get: vi.fn().mockReturnValue({
      id: 1,
      name: "TestAccount",
      access_key_id_enc: "enc-key",
      secret_access_key_enc: "enc-secret",
      default_region: "us-east-1",
      aws_account_id: "123456789012",
    }),
    all: vi.fn().mockReturnValue([]),
  });
});

// ─── EC2 Runner Tests ────────────────────────────────────────────────────────

describe("runAudit (EC2)", () => {
  it("sets status to failed when collector throws", async () => {
    (collectAccountData as any).mockRejectedValue(new Error("AWS API timeout"));

    await runAudit(1, 100);

    // Should have called UPDATE with 'failed' status
    const calls = mockDb.prepare.mock.results
      .map((r: any) => r.value)
      .filter((v: any) => v.run.mock.calls.length > 0);

    const failCall = calls.find((c: any) =>
      c.run.mock.calls.some((args: any[]) => args.includes("AWS API timeout"))
    );
    expect(failCall).toBeDefined();
  });

  it("sets status to failed when analyzer throws", async () => {
    (collectAccountData as any).mockResolvedValue({
      instances: [],
      orphanVolumes: [],
      idleEips: [],
      snapshots: [],
      amis: [],
      accountSummary: { totalInstances: 0, runningInstances: 0, stoppedInstances: 0, totalMonthlySpend: 0 },
      collectedAt: new Date().toISOString(),
      region: "us-east-1",
      accountName: "Test",
      accountId: "123",
      snapshotCostData: null,
    });
    (analyzeWithClaude as any).mockRejectedValue(new Error("Analyzer crash"));

    await runAudit(1, 100);

    const calls = mockDb.prepare.mock.results
      .map((r: any) => r.value)
      .filter((v: any) => v.run.mock.calls.length > 0);

    const failCall = calls.find((c: any) =>
      c.run.mock.calls.some((args: any[]) => args.includes("Analyzer crash"))
    );
    expect(failCall).toBeDefined();
  });

  it("sets status to completed on success", async () => {
    (collectAccountData as any).mockResolvedValue({
      instances: [],
      orphanVolumes: [],
      idleEips: [],
      snapshots: [],
      amis: [],
      accountSummary: { totalInstances: 0, runningInstances: 0, stoppedInstances: 0, totalMonthlySpend: 0 },
      collectedAt: new Date().toISOString(),
      region: "us-east-1",
      accountName: "Test",
      accountId: "123",
      snapshotCostData: null,
    });
    (analyzeWithClaude as any).mockResolvedValue([]);

    await runAudit(1, 100);

    // The last prepare call should be the completion UPDATE
    const allPrepCalls = mockDb.prepare.mock.calls.map((c: any) => c[0]);
    const completedCall = allPrepCalls.find((sql: string) =>
      sql.includes("completed") && sql.includes("UPDATE audits")
    );
    expect(completedCall).toBeDefined();
  });
});

// ─── RDS Runner Tests ────────────────────────────────────────────────────────

describe("runRDSAudit", () => {
  it("sets status to failed when collector throws", async () => {
    (collectRDSAccountData as any).mockRejectedValue(new Error("RDS API error"));

    await runRDSAudit(1, 200);

    const calls = mockDb.prepare.mock.results
      .map((r: any) => r.value)
      .filter((v: any) => v.run.mock.calls.length > 0);

    const failCall = calls.find((c: any) =>
      c.run.mock.calls.some((args: any[]) => args.includes("RDS API error"))
    );
    expect(failCall).toBeDefined();
  });

  it("sets status to completed on success", async () => {
    (collectRDSAccountData as any).mockResolvedValue({
      instances: [],
      clusters: [],
      manualSnapshots: [],
      clusterSnapshots: [],
      snapshotCostData: null,
      accountSummary: { totalInstances: 0, availableInstances: 0, stoppedInstances: 0, totalMonthlySpend: 0 },
      collectedAt: new Date().toISOString(),
      region: "us-east-1",
      accountName: "Test",
      accountId: "123",
    });
    (analyzeRDSWithClaude as any).mockResolvedValue([]);

    await runRDSAudit(1, 200);

    const allPrepCalls = mockDb.prepare.mock.calls.map((c: any) => c[0]);
    const completedCall = allPrepCalls.find((sql: string) =>
      sql.includes("completed") && sql.includes("UPDATE audits")
    );
    expect(completedCall).toBeDefined();
  });
});

// ─── S3 Runner Tests ─────────────────────────────────────────────────────────

describe("runS3Audit", () => {
  it("sets status to failed when collector throws", async () => {
    (collectS3AccountData as any).mockRejectedValue(new Error("S3 API error"));

    await runS3Audit(1, 300);

    const calls = mockDb.prepare.mock.results
      .map((r: any) => r.value)
      .filter((v: any) => v.run.mock.calls.length > 0);

    const failCall = calls.find((c: any) =>
      c.run.mock.calls.some((args: any[]) => args.includes("S3 API error"))
    );
    expect(failCall).toBeDefined();
  });

  it("sets status to completed on success", async () => {
    (collectS3AccountData as any).mockResolvedValue({
      buckets: [],
      s3CostData: null,
      accountSummary: { totalBuckets: 0, totalStorageGB: 0, totalMonthlyCost: 0 },
      collectedAt: new Date().toISOString(),
      region: "us-east-1",
      accountName: "Test",
      accountId: "123",
    });
    (analyzeS3WithClaude as any).mockResolvedValue([]);

    await runS3Audit(1, 300);

    const allPrepCalls = mockDb.prepare.mock.calls.map((c: any) => c[0]);
    const completedCall = allPrepCalls.find((sql: string) =>
      sql.includes("completed") && sql.includes("UPDATE audits")
    );
    expect(completedCall).toBeDefined();
  });
});
