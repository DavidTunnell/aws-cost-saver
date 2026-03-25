import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Anthropic SDK — simulate LLM failures
const { MockAnthropic } = vi.hoisted(() => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockRejectedValue(new Error("API rate limit exceeded")),
    },
  }));
  return { MockAnthropic };
});
vi.mock("@anthropic-ai/sdk", () => {
  return { default: MockAnthropic };
});

// Mock pricing to avoid real AWS calls
vi.mock("../aws/pricing", () => ({
  getGravitonEquivalent: vi.fn().mockReturnValue(null),
  getSnapshotMonthlyPrice: vi.fn().mockReturnValue(5),
  getEbsMonthlyPrice: vi.fn().mockReturnValue(10),
  getGp2ToGp3Savings: vi.fn().mockReturnValue(null),
}));

// Mock RDS pricing
vi.mock("../aws/rds-pricing", () => ({
  getRDSStorageMonthlyPrice: vi.fn().mockReturnValue(10),
  clearRDSPriceCache: vi.fn(),
}));

import { analyzeWithClaude } from "./analyzer";
import { analyzeRDSWithClaude } from "./rds-analyzer";
import { analyzeS3WithClaude } from "./s3-analyzer";
import type { CollectedData } from "../aws/collector";
import type { RDSCollectedData } from "../aws/rds-collector";
import type { S3CollectedData } from "../aws/s3-collector";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Minimal test data factories ─────────────────────────────────────────────

function makeEC2Data(overrides: Partial<CollectedData> = {}): CollectedData {
  return {
    accountName: "test-account",
    accountId: "123456789012",
    region: "us-east-1",
    instances: [],
    orphanVolumes: [
      {
        volumeId: "vol-orphan1",
        volumeType: "gp2",
        size: 100,
        createTime: "2024-01-01T00:00:00Z",
        availabilityZone: "us-east-1a",
      },
    ],
    idleEips: [
      { allocationId: "eipalloc-123", publicIp: "1.2.3.4" },
    ],
    snapshots: [],
    amis: [],
    accountSummary: {
      totalInstances: 0,
      runningInstances: 0,
      stoppedInstances: 0,
      totalMonthlySpend: 0,
    },
    collectedAt: new Date().toISOString(),
    snapshotCostData: null,
    ...overrides,
  };
}

function makeRDSData(overrides: Partial<RDSCollectedData> = {}): RDSCollectedData {
  return {
    accountName: "test-account",
    accountId: "123456789012",
    region: "us-east-1",
    instances: [
      {
        dbInstanceId: "test-db",
        dbInstanceArn: "arn:aws:rds:us-east-1:123456789012:db:test-db",
        dbiResourceId: "dbi-resource-123",
        dbInstanceClass: "db.t3.micro",
        engine: "mysql",
        engineVersion: "8.0",
        status: "available",
        multiAZ: false,
        storageType: "gp2",
        allocatedStorageGb: 20,
        provisionedIops: null,
        isAurora: false,
        clusterIdentifier: null,
        tags: {},
        // Metrics
        cpuAvg: 5,
        cpuMax: 10,
        freeableMemoryAvg: 500000000,
        freeableMemoryMin: 400000000,
        databaseConnectionsAvg: 0,
        databaseConnectionsMax: 0,
        readIOPSAvg: 0,
        writeIOPSAvg: 0,
        freeStorageSpaceAvg: 15000000000,
        freeStorageSpaceMin: 14000000000,
        networkReceiveAvg: 0,
        networkTransmitAvg: 0,
        // Pricing
        onDemandHourly: 0.017,
        monthlyEstimate: 12.41,
        storageMonthlyPrice: 2.30,
        totalMonthlyEstimate: 14.71,
      } as any,
    ],
    clusters: [],
    manualSnapshots: [],
    clusterSnapshots: [],
    snapshotCostData: null,
    accountSummary: {
      totalInstances: 1,
      availableInstances: 1,
      stoppedInstances: 0,
      totalMonthlySpend: 14.71,
    },
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeS3Data(overrides: Partial<S3CollectedData> = {}): S3CollectedData {
  return {
    accountName: "test-account",
    accountId: "123456789012",
    region: "us-east-1",
    buckets: [
      {
        bucketName: "test-bucket",
        region: "us-east-1",
        creationDate: "2023-01-01T00:00:00Z",
        tags: {},
        versioningEnabled: false,
        hasLifecyclePolicy: false,
        lifecycleRules: [],
        hasIntelligentTiering: false,
        incompleteMultipartUploads: 0,
        standardStorageBytes: 50 * 1024 * 1024 * 1024, // 50 GB
        standardIAStorageBytes: null,
        oneZoneIAStorageBytes: null,
        glacierStorageBytes: null,
        deepArchiveStorageBytes: null,
        intelligentTieringStorageBytes: null,
        totalStorageBytes: 50 * 1024 * 1024 * 1024,
        numberOfObjects: 1000,
        currentMonthlyCost: 1.15,
        costIsActual: false,
      } as any,
    ],
    s3CostData: null,
    accountSummary: {
      totalBuckets: 1,
      totalStorageGB: 50,
      totalMonthlyCost: 1.15,
    },
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── EC2 Analyzer Tests ─────────────────────────────────────────────────────

describe("analyzeWithClaude (EC2)", () => {
  it("returns deterministic recommendations when LLM call fails", async () => {
    const data = makeEC2Data({
      instances: [
        {
          instanceId: "i-running1",
          instanceType: "m5.large",
          state: "running",
          name: "test-instance",
          launchTime: "2024-01-01T00:00:00Z",
          platform: "Linux/UNIX",
          availabilityZone: "us-east-1a",
          architecture: "x86_64",
          imageId: "ami-123",
          tags: {},
          cpuAvg: 5,
          cpuMax: 10,
          networkInAvg: 100,
          networkOutAvg: 100,
          networkInMax: 200,
          networkOutMax: 200,
          diskReadOps: null,
          diskWriteOps: null,
          cpuCreditBalance: null,
          ebsReadBandwidth: null,
          ebsWriteBandwidth: null,
          onDemandHourly: 0.096,
          monthlyEstimate: 70.08,
          actualMonthlyCost: null,
          gravitonEquivalent: null,
          gravitonHourlyPrice: null,
          attachedVolumes: [],
          ebsMonthlyCost: 0,
        } as any,
      ],
    });

    // Set API key so LLM path is attempted (and fails via mock)
    process.env.ANTHROPIC_API_KEY = "test-key";
    const recs = await analyzeWithClaude(data);
    process.env.ANTHROPIC_API_KEY = "";

    // Should NOT throw — should return deterministic recs
    expect(recs).toBeDefined();
    expect(Array.isArray(recs)).toBe(true);
    // Should have at least the orphan volume and idle EIP deterministic recs
    expect(recs.length).toBeGreaterThanOrEqual(2);
    expect(recs.some((r) => r.category === "orphan-ebs")).toBe(true);
    expect(recs.some((r) => r.category === "unused-eip")).toBe(true);
  });

  it("returns deterministic recommendations when API key is missing", async () => {
    const data = makeEC2Data();
    process.env.ANTHROPIC_API_KEY = "";

    const recs = await analyzeWithClaude(data);

    expect(recs).toBeDefined();
    expect(Array.isArray(recs)).toBe(true);
    // idle EIP + orphan volume
    expect(recs.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── RDS Analyzer Tests ─────────────────────────────────────────────────────

describe("analyzeRDSWithClaude", () => {
  it("returns deterministic recommendations when LLM call fails", async () => {
    const data = makeRDSData();

    process.env.ANTHROPIC_API_KEY = "test-key";
    const recs = await analyzeRDSWithClaude(data);
    process.env.ANTHROPIC_API_KEY = "";

    expect(recs).toBeDefined();
    expect(Array.isArray(recs)).toBe(true);
    // The idle RDS instance (0 connections) should trigger rds-idle deterministic rec
    expect(recs.some((r) => r.category === "rds-idle")).toBe(true);
  });

  it("returns deterministic recommendations when API key is missing", async () => {
    const data = makeRDSData();
    process.env.ANTHROPIC_API_KEY = "";

    const recs = await analyzeRDSWithClaude(data);

    expect(recs).toBeDefined();
    expect(Array.isArray(recs)).toBe(true);
  });
});

// ─── S3 Analyzer Tests ──────────────────────────────────────────────────────

describe("analyzeS3WithClaude", () => {
  it("returns deterministic recommendations when LLM call fails", async () => {
    const data = makeS3Data();

    process.env.ANTHROPIC_API_KEY = "test-key";
    const recs = await analyzeS3WithClaude(data);
    process.env.ANTHROPIC_API_KEY = "";

    expect(recs).toBeDefined();
    expect(Array.isArray(recs)).toBe(true);
    // Bucket with no lifecycle and >1GB standard storage should trigger s3-no-lifecycle
    expect(recs.some((r) => r.category === "s3-no-lifecycle")).toBe(true);
  });

  it("returns deterministic recommendations when API key is missing", async () => {
    const data = makeS3Data();
    process.env.ANTHROPIC_API_KEY = "";

    const recs = await analyzeS3WithClaude(data);

    expect(recs).toBeDefined();
    expect(Array.isArray(recs)).toBe(true);
  });
});

// ─── Retry Configuration Tests ──────────────────────────────────────────────

describe("Anthropic client retry configuration", () => {
  it("constructs Anthropic client with maxRetries: 5", async () => {
    const data = makeEC2Data({
      instances: [
        {
          instanceId: "i-test",
          instanceType: "m5.large",
          state: "running",
          name: "test",
          launchTime: "2024-01-01T00:00:00Z",
          platform: "Linux/UNIX",
          availabilityZone: "us-east-1a",
          architecture: "x86_64",
          imageId: "ami-123",
          tags: {},
          cpuAvg: 5, cpuMax: 10,
          networkInAvg: 100, networkOutAvg: 100,
          networkInMax: 200, networkOutMax: 200,
          diskReadOps: null, diskWriteOps: null,
          cpuCreditBalance: null, ebsReadBandwidth: null, ebsWriteBandwidth: null,
          onDemandHourly: 0.096, monthlyEstimate: 70.08, actualMonthlyCost: null,
          gravitonEquivalent: null, gravitonHourlyPrice: null,
          attachedVolumes: [], ebsMonthlyCost: 0,
        } as any,
      ],
    });

    process.env.ANTHROPIC_API_KEY = "test-key";
    await analyzeWithClaude(data);
    process.env.ANTHROPIC_API_KEY = "";

    expect(MockAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 5 })
    );
  });
});
