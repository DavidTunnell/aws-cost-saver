import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock db
vi.mock("../db", () => {
  const mockDb = { prepare: vi.fn() };
  return { default: mockDb };
});

// Mock audit registry
vi.mock("../audit-registry", () => ({
  getAuditType: vi.fn(),
  getRegisteredTypes: vi.fn().mockReturnValue(["ec2", "rds", "full"]),
}));

// Mock all audit runner imports (they self-register on import)
vi.mock("../services/audit-runner", () => ({}));
vi.mock("../services/rds-audit-runner", () => ({}));
vi.mock("../services/s3-audit-runner", () => ({}));
vi.mock("../services/nat-audit-runner", () => ({}));
vi.mock("../services/lambda-audit-runner", () => ({}));
vi.mock("../services/dynamodb-audit-runner", () => ({}));
vi.mock("../services/elb-audit-runner", () => ({}));
vi.mock("../services/opensearch-audit-runner", () => ({}));
vi.mock("../services/full-audit-runner", () => ({}));

import db from "../db";
import { getAuditType } from "../audit-registry";
import auditsRouter from "./audits";

const app = express();
app.use(express.json());
app.use("/audits", auditsRouter);

const mockDb = db as any;
const mockGetAuditType = getAuditType as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /audits", () => {
  it("returns list of audits", async () => {
    const audits = [
      { id: 1, account_id: 1, account_name: "Test", status: "completed", audit_type: "ec2" },
    ];
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue(audits) });

    const res = await request(app).get("/audits");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(audits);
  });
});

describe("GET /audits/:id", () => {
  it("returns audit with recommendations", async () => {
    const audit = { id: 1, account_id: 1, account_name: "Test", status: "completed", audit_type: "ec2" };
    const recommendations = [
      { id: 1, audit_id: 1, instance_id: "i-abc", estimated_savings: 50 },
    ];
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(audit) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue(recommendations) });

    const res = await request(app).get("/audits/1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.recommendations).toEqual(recommendations);
  });

  it("includes child_audits for full audit type", async () => {
    const audit = { id: 1, account_id: 1, account_name: "Test", status: "completed", audit_type: "full" };
    const recommendations: any[] = [];
    const children = [
      { id: 2, audit_type: "ec2", status: "completed", error: null },
    ];

    mockGetAuditType.mockReturnValue({ label: "EC2 Compute" });
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(audit) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue(recommendations) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue(children) });

    const res = await request(app).get("/audits/1");
    expect(res.status).toBe(200);
    expect(res.body.child_audits).toHaveLength(1);
    expect(res.body.child_audits[0].label).toBe("EC2 Compute");
  });

  it("returns 404 when audit not found", async () => {
    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });

    const res = await request(app).get("/audits/999");
    expect(res.status).toBe(404);
  });

  it("returns empty child_audits for non-full audit type", async () => {
    const audit = { id: 1, account_id: 1, account_name: "Test", status: "completed", audit_type: "ec2" };
    const recommendations = [{ id: 1, audit_id: 1, instance_id: "i-abc" }];
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(audit) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue(recommendations) });

    const res = await request(app).get("/audits/1");
    expect(res.status).toBe(200);
    expect(res.body.child_audits).toEqual([]);
  });
});

describe("POST /audits", () => {
  it("creates audit and returns 201", async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    mockGetAuditType.mockReturnValue({ label: "EC2", runner });
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ id: 1 }) }) // account exists
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(undefined) }) // no running audit
      .mockReturnValueOnce({ run: vi.fn().mockReturnValue({ lastInsertRowid: 5 }) }); // insert

    const res = await request(app).post("/audits").send({ account_id: 1, audit_type: "ec2" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 5, status: "running" });
  });

  it("returns 400 when account_id is missing", async () => {
    const res = await request(app).post("/audits").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("account_id");
  });

  it("returns 404 when account not found", async () => {
    mockGetAuditType.mockReturnValue({ label: "EC2", runner: vi.fn() });
    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });

    const res = await request(app).post("/audits").send({ account_id: 999, audit_type: "ec2" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when audit is already running", async () => {
    mockGetAuditType.mockReturnValue({ label: "EC2", runner: vi.fn() });
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ id: 1 }) }) // account exists
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ id: 3 }) }); // running audit exists

    const res = await request(app).post("/audits").send({ account_id: 1, audit_type: "ec2" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already running");
  });

  it("returns 400 for invalid audit type", async () => {
    mockGetAuditType.mockReturnValue(undefined);

    const res = await request(app).post("/audits").send({ account_id: 1, audit_type: "invalid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("audit_type");
  });

  it("calls the audit runner with account_id and audit_id", async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    mockGetAuditType.mockReturnValue({ label: "EC2", runner });
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ id: 1 }) })
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(undefined) })
      .mockReturnValueOnce({ run: vi.fn().mockReturnValue({ lastInsertRowid: 7 }) });

    await request(app).post("/audits").send({ account_id: 1, audit_type: "ec2" });
    // Runner should be invoked with account_id and new audit id
    expect(runner).toHaveBeenCalledWith(1, 7);
  });

  it("defaults to ec2 audit type when not specified", async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    mockGetAuditType.mockReturnValue({ label: "EC2", runner });
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ id: 1 }) })
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(undefined) })
      .mockReturnValueOnce({ run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }) });

    const res = await request(app).post("/audits").send({ account_id: 1 });
    expect(res.status).toBe(201);
    expect(mockGetAuditType).toHaveBeenCalledWith("ec2");
  });
});

describe("POST /audits - edge cases", () => {
  it("returns 201 even when runner rejects (fire-and-forget)", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("boom"));
    mockGetAuditType.mockReturnValue({ label: "EC2", runner });
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ id: 1 }) })
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(undefined) })
      .mockReturnValueOnce({ run: vi.fn().mockReturnValue({ lastInsertRowid: 10 }) });

    const res = await request(app).post("/audits").send({ account_id: 1, audit_type: "ec2" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 10, status: "running" });
  });
});

describe("GET /audits/:id - child_audits label fallback", () => {
  it("uses audit_type as label when getAuditType returns undefined", async () => {
    const audit = { id: 1, account_id: 1, account_name: "Test", status: "completed", audit_type: "full" };
    const children = [
      { id: 2, audit_type: "unknown-type", status: "completed", error: null },
    ];

    mockGetAuditType.mockReturnValue(undefined); // unknown type
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(audit) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue(children) });

    const res = await request(app).get("/audits/1");
    expect(res.status).toBe(200);
    expect(res.body.child_audits[0].label).toBe("unknown-type");
  });
});

describe("PATCH /audits/:auditId/recommendations/:recId", () => {
  it("resolves a recommendation as fixed", async () => {
    const updatedRec = { id: 1, resolution: "fixed", resolution_reason: null };
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ id: 1 }) }) // rec exists
      .mockReturnValueOnce({ run: vi.fn() }) // update
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(updatedRec) }); // return updated

    const res = await request(app)
      .patch("/audits/1/recommendations/1")
      .send({ resolution: "fixed" });
    expect(res.status).toBe(200);
    expect(res.body.resolution).toBe("fixed");
  });

  it("resolves a recommendation as incorrect with reason", async () => {
    const updatedRec = { id: 1, resolution: "incorrect", resolution_reason: "Not applicable" };
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ id: 1 }) })
      .mockReturnValueOnce({ run: vi.fn() })
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(updatedRec) });

    const res = await request(app)
      .patch("/audits/1/recommendations/1")
      .send({ resolution: "incorrect", reason: "Not applicable" });
    expect(res.status).toBe(200);
    expect(res.body.resolution).toBe("incorrect");
  });

  it("undoes resolution with null", async () => {
    const updatedRec = { id: 1, resolution: null, resolution_reason: null };
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ id: 1 }) })
      .mockReturnValueOnce({ run: vi.fn() })
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(updatedRec) });

    const res = await request(app)
      .patch("/audits/1/recommendations/1")
      .send({ resolution: null });
    expect(res.status).toBe(200);
    expect(res.body.resolution).toBeNull();
  });

  it("returns 400 for invalid resolution value", async () => {
    const res = await request(app)
      .patch("/audits/1/recommendations/1")
      .send({ resolution: "maybe" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when recommendation not found", async () => {
    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });

    const res = await request(app)
      .patch("/audits/1/recommendations/999")
      .send({ resolution: "fixed" });
    expect(res.status).toBe(404);
  });
});
