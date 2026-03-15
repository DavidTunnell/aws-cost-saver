import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock db
vi.mock("../db", () => {
  const mockDb = { prepare: vi.fn() };
  return { default: mockDb };
});

// Mock crypto
vi.mock("../crypto", () => ({
  encrypt: vi.fn((val: string) => `encrypted_${val}`),
  decrypt: vi.fn((val: string) => val.replace("encrypted_", "")),
}));

// Mock CostExplorerClient — use vi.hoisted for mock references
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock("@aws-sdk/client-cost-explorer", () => ({
  CostExplorerClient: vi.fn().mockImplementation(function() {
    return { send: mockSend };
  }),
  GetCostAndUsageCommand: vi.fn().mockImplementation(function(params: any) { return params; }),
}));

import db from "../db";
import reportsRouter from "./reports";

const app = express();
app.use(express.json());
app.use("/reports", reportsRouter);

const mockDb = db as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /reports/cost-trends", () => {
  it("returns 400 when accountId is missing", async () => {
    const res = await request(app).get("/reports/cost-trends");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("accountId");
  });

  it("returns 404 when account not found", async () => {
    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });

    const res = await request(app).get("/reports/cost-trends?accountId=999");
    expect(res.status).toBe(404);
  });

  it("returns cost trend data", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        name: "Test Account",
        aws_account_id: "123456789",
        default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA",
        secret_access_key_enc: "encrypted_secret",
      }),
    });

    mockSend.mockResolvedValue({
      ResultsByTime: [
        {
          TimePeriod: { Start: "2025-01-01", End: "2025-02-01" },
          Groups: [
            {
              Keys: ["Amazon EC2"],
              Metrics: { UnblendedCost: { Amount: "150.50" } },
            },
            {
              Keys: ["Amazon S3"],
              Metrics: { UnblendedCost: { Amount: "25.75" } },
            },
          ],
        },
      ],
    });

    const res = await request(app).get("/reports/cost-trends?accountId=1");
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe(1);
    expect(res.body.periods).toHaveLength(1);
    expect(res.body.periods[0].byService["Amazon EC2"]).toBe(150.5);
    expect(res.body.periods[0].byService["Amazon S3"]).toBe(25.75);
    expect(res.body.periods[0].totalCost).toBeGreaterThan(0);
  });

  it("filters out periods with near-zero spending", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        name: "Test",
        aws_account_id: "123",
        default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA",
        secret_access_key_enc: "encrypted_secret",
      }),
    });

    mockSend.mockResolvedValue({
      ResultsByTime: [
        {
          TimePeriod: { Start: "2025-01-01", End: "2025-02-01" },
          Groups: [
            { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "0.005" } } },
          ],
        },
        {
          TimePeriod: { Start: "2025-02-01", End: "2025-03-01" },
          Groups: [
            { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } },
          ],
        },
      ],
    });

    const res = await request(app).get("/reports/cost-trends?accountId=1");
    expect(res.status).toBe(200);
    // First period should be filtered out (cost < 0.01)
    expect(res.body.periods).toHaveLength(1);
    expect(res.body.periods[0].start).toBe("2025-02-01");
  });

  it("respects granularity parameter", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        name: "Test",
        aws_account_id: "123",
        default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA",
        secret_access_key_enc: "encrypted_secret",
      }),
    });

    mockSend.mockResolvedValue({ ResultsByTime: [] });

    const res = await request(app).get("/reports/cost-trends?accountId=1&granularity=DAILY");
    expect(res.status).toBe(200);
    expect(res.body.granularity).toBe("DAILY");
  });

  it("defaults to MONTHLY granularity", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        name: "Test",
        aws_account_id: "123",
        default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA",
        secret_access_key_enc: "encrypted_secret",
      }),
    });

    mockSend.mockResolvedValue({ ResultsByTime: [] });

    const res = await request(app).get("/reports/cost-trends?accountId=1");
    expect(res.status).toBe(200);
    expect(res.body.granularity).toBe("MONTHLY");
  });

  it("treats months=0 as default (6) due to falsy || operator", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1, name: "Test", aws_account_id: "123", default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA", secret_access_key_enc: "encrypted_secret",
      }),
    });
    mockSend.mockResolvedValue({ ResultsByTime: [] });

    const res = await request(app).get("/reports/cost-trends?accountId=1&months=0");
    expect(res.status).toBe(200);
    // 0 is falsy → falls through to default 6
    expect(res.body.months).toBe(6);
  });

  it("clamps months=25 to 12", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1, name: "Test", aws_account_id: "123", default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA", secret_access_key_enc: "encrypted_secret",
      }),
    });
    mockSend.mockResolvedValue({ ResultsByTime: [] });

    const res = await request(app).get("/reports/cost-trends?accountId=1&months=25");
    expect(res.status).toBe(200);
    expect(res.body.months).toBe(12);
  });

  it("defaults months to 6 when not specified", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1, name: "Test", aws_account_id: "123", default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA", secret_access_key_enc: "encrypted_secret",
      }),
    });
    mockSend.mockResolvedValue({ ResultsByTime: [] });

    const res = await request(app).get("/reports/cost-trends?accountId=1");
    expect(res.status).toBe(200);
    expect(res.body.months).toBe(6);
  });

  it("handles empty ResultsByTime gracefully", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1, name: "Test", aws_account_id: "123", default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA", secret_access_key_enc: "encrypted_secret",
      }),
    });
    mockSend.mockResolvedValue({ ResultsByTime: undefined });

    const res = await request(app).get("/reports/cost-trends?accountId=1");
    expect(res.status).toBe(200);
    expect(res.body.periods).toEqual([]);
  });

  it("filters out services with cost exactly 0.01 (threshold is > 0.01)", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1, name: "Test", aws_account_id: "123", default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA", secret_access_key_enc: "encrypted_secret",
      }),
    });
    mockSend.mockResolvedValue({
      ResultsByTime: [{
        TimePeriod: { Start: "2025-01-01", End: "2025-02-01" },
        Groups: [
          { Keys: ["TinyService"], Metrics: { UnblendedCost: { Amount: "0.01" } } },
          { Keys: ["RealService"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
        ],
      }],
    });

    const res = await request(app).get("/reports/cost-trends?accountId=1");
    expect(res.status).toBe(200);
    expect(res.body.periods).toHaveLength(1);
    // TinyService (0.01) should be filtered out — threshold is > 0.01
    expect(res.body.periods[0].byService["TinyService"]).toBeUndefined();
    expect(res.body.periods[0].byService["RealService"]).toBe(50.00);
  });
});

describe("GET /reports/cost-trends - error handling", () => {
  it("returns 500 when CostExplorer throws", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1, name: "Test", aws_account_id: "123", default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA", secret_access_key_enc: "encrypted_secret",
      }),
    });

    mockSend.mockRejectedValue(new Error("AccessDenied"));

    const res = await request(app).get("/reports/cost-trends?accountId=1");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("AccessDenied");
  });
});

describe("GET /reports/services", () => {
  it("returns 400 when accountId is missing", async () => {
    const res = await request(app).get("/reports/services");
    expect(res.status).toBe(400);
  });

  it("returns 404 when account not found", async () => {
    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });

    const res = await request(app).get("/reports/services?accountId=999");
    expect(res.status).toBe(404);
  });

  it("returns services sorted by cost descending", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        name: "Test",
        aws_account_id: "123",
        default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA",
        secret_access_key_enc: "encrypted_secret",
      }),
    });

    mockSend.mockResolvedValue({
      ResultsByTime: [
        {
          Groups: [
            { Keys: ["Amazon S3"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
            { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "200.00" } } },
            { Keys: ["Amazon RDS"], Metrics: { UnblendedCost: { Amount: "100.00" } } },
          ],
        },
      ],
    });

    const res = await request(app).get("/reports/services?accountId=1");
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(3);
    // Should be sorted by cost descending
    expect(res.body.services[0].name).toBe("Amazon EC2");
    expect(res.body.services[1].name).toBe("Amazon RDS");
    expect(res.body.services[2].name).toBe("Amazon S3");
  });

  it("returns 500 when CostExplorer throws for services", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1, name: "Test", aws_account_id: "123", default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA", secret_access_key_enc: "encrypted_secret",
      }),
    });

    mockSend.mockRejectedValue(new Error("ThrottlingException"));

    const res = await request(app).get("/reports/services?accountId=1");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("ThrottlingException");
  });

  it("accumulates costs across multiple periods for same service", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1, name: "Test", aws_account_id: "123", default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA", secret_access_key_enc: "encrypted_secret",
      }),
    });

    mockSend.mockResolvedValue({
      ResultsByTime: [
        {
          Groups: [
            { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } },
          ],
        },
        {
          Groups: [
            { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "150.00" } } },
          ],
        },
      ],
    });

    const res = await request(app).get("/reports/services?accountId=1");
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0].name).toBe("Amazon EC2");
    expect(res.body.services[0].totalCost).toBe(250.00);
  });
});
