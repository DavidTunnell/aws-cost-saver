import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock db before importing router
vi.mock("../db", () => {
  const mockDb = {
    prepare: vi.fn(),
  };
  return { default: mockDb };
});

// Mock crypto
vi.mock("../crypto", () => ({
  encrypt: vi.fn((val: string) => `encrypted_${val}`),
  decrypt: vi.fn((val: string) => val.replace("encrypted_", "")),
}));

// Mock STS client
const { mockStsSend } = vi.hoisted(() => ({ mockStsSend: vi.fn() }));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: vi.fn().mockImplementation(function() {
    return { send: mockStsSend };
  }),
  GetCallerIdentityCommand: vi.fn().mockImplementation(function(params: any) { return params; }),
}));

import db from "../db";
import { encrypt } from "../crypto";
import accountsRouter from "./accounts";

const app = express();
app.use(express.json());
app.use("/accounts", accountsRouter);

const mockDb = db as any;

function mockPrepare(returnValue: any) {
  mockDb.prepare.mockReturnValue(returnValue);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /accounts", () => {
  it("returns list of accounts", async () => {
    const accounts = [
      { id: 1, name: "Test", aws_account_id: "123", default_region: "us-east-1", created_at: "2025-01-01" },
    ];
    mockPrepare({ all: vi.fn().mockReturnValue(accounts) });

    const res = await request(app).get("/accounts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(accounts);
  });

  it("returns empty array when no accounts", async () => {
    mockPrepare({ all: vi.fn().mockReturnValue([]) });

    const res = await request(app).get("/accounts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /accounts/:id", () => {
  it("returns single account", async () => {
    const account = { id: 1, name: "Test", aws_account_id: "123", default_region: "us-east-1" };
    mockPrepare({ get: vi.fn().mockReturnValue(account) });

    const res = await request(app).get("/accounts/1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(account);
  });

  it("returns 404 when account not found", async () => {
    mockPrepare({ get: vi.fn().mockReturnValue(undefined) });

    const res = await request(app).get("/accounts/999");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Account not found");
  });
});

describe("POST /accounts", () => {
  it("creates account and returns id", async () => {
    mockPrepare({ run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }) });

    const res = await request(app).post("/accounts").send({
      name: "My Account",
      access_key_id: "AKIAEXAMPLE",
      secret_access_key: "secretkey",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 1 });
  });

  it("returns 400 when missing required fields", async () => {
    const res = await request(app).post("/accounts").send({ name: "Test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("required");
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post("/accounts").send({
      access_key_id: "AKIAEXAMPLE",
      secret_access_key: "secretkey",
    });
    expect(res.status).toBe(400);
  });

  it("uses us-east-1 as default region", async () => {
    const runMock = vi.fn().mockReturnValue({ lastInsertRowid: 1 });
    mockPrepare({ run: runMock });

    await request(app).post("/accounts").send({
      name: "My Account",
      access_key_id: "AKIAEXAMPLE",
      secret_access_key: "secretkey",
    });
    // 4th arg to run() should be "us-east-1"
    expect(runMock).toHaveBeenCalledWith(
      "My Account",
      expect.any(String),
      expect.any(String),
      "us-east-1"
    );
  });
});

describe("PUT /accounts/:id", () => {
  it("updates account", async () => {
    const getMock = vi.fn().mockReturnValue({
      name: "Old Name",
      access_key_id_enc: "encrypted_old",
      secret_access_key_enc: "encrypted_old_secret",
      default_region: "us-east-1",
    });
    const runMock = vi.fn();
    mockDb.prepare
      .mockReturnValueOnce({ get: getMock })
      .mockReturnValueOnce({ run: runMock });

    const res = await request(app).put("/accounts/1").send({ name: "New Name" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("returns 404 when account not found", async () => {
    mockPrepare({ get: vi.fn().mockReturnValue(undefined) });

    const res = await request(app).put("/accounts/999").send({ name: "Test" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /accounts/:id", () => {
  it("deletes account", async () => {
    mockPrepare({ run: vi.fn().mockReturnValue({ changes: 1 }) });

    const res = await request(app).delete("/accounts/1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("returns 404 when account not found", async () => {
    mockPrepare({ run: vi.fn().mockReturnValue({ changes: 0 }) });

    const res = await request(app).delete("/accounts/999");
    expect(res.status).toBe(404);
  });
});

describe("POST /accounts/:id/test", () => {
  it("tests connection and returns identity", async () => {
    mockDb.prepare
      .mockReturnValueOnce({
        get: vi.fn().mockReturnValue({
          id: 1,
          default_region: "us-west-2",
          access_key_id_enc: "encrypted_AKIA123",
          secret_access_key_enc: "encrypted_secretkey",
        }),
      })
      .mockReturnValueOnce({ run: vi.fn() }); // UPDATE aws_account_id

    mockStsSend.mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/test",
    });

    const res = await request(app).post("/accounts/1/test");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.account_id).toBe("123456789012");
    expect(res.body.arn).toContain("arn:aws");
  });

  it("updates aws_account_id in database after successful test", async () => {
    const updateRunMock = vi.fn();
    mockDb.prepare
      .mockReturnValueOnce({
        get: vi.fn().mockReturnValue({
          id: 1,
          default_region: "us-east-1",
          access_key_id_enc: "encrypted_AKIA",
          secret_access_key_enc: "encrypted_secret",
        }),
      })
      .mockReturnValueOnce({ run: updateRunMock });

    mockStsSend.mockResolvedValue({
      Account: "987654321098",
      Arn: "arn:aws:iam::987654321098:user/admin",
    });

    await request(app).post("/accounts/1/test");
    expect(updateRunMock).toHaveBeenCalledWith("987654321098", 1);
  });

  it("returns 404 when account not found", async () => {
    mockPrepare({ get: vi.fn().mockReturnValue(undefined) });

    const res = await request(app).post("/accounts/999/test");
    expect(res.status).toBe(404);
  });

  it("returns 400 when STS call fails", async () => {
    mockPrepare({
      get: vi.fn().mockReturnValue({
        id: 1,
        default_region: "us-east-1",
        access_key_id_enc: "encrypted_AKIA",
        secret_access_key_enc: "encrypted_secret",
      }),
    });

    mockStsSend.mockRejectedValue(new Error("Invalid credentials"));

    const res = await request(app).post("/accounts/1/test");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid credentials");
  });
});

describe("PUT /accounts/:id - partial update verification", () => {
  const existingAccount = {
    name: "Old Name",
    access_key_id_enc: "encrypted_OLDKEY",
    secret_access_key_enc: "encrypted_OLDSECRET",
    default_region: "us-east-1",
  };

  it("preserves existing credentials when only name is updated", async () => {
    const runMock = vi.fn();
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(existingAccount) })
      .mockReturnValueOnce({ run: runMock });

    await request(app).put("/accounts/1").send({ name: "New Name" });
    expect(runMock).toHaveBeenCalledWith(
      "New Name",
      "encrypted_OLDKEY",       // unchanged — not re-encrypted
      "encrypted_OLDSECRET",    // unchanged — not re-encrypted
      "us-east-1",
      "1"
    );
  });

  it("re-encrypts credentials when they are updated", async () => {
    const runMock = vi.fn();
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(existingAccount) })
      .mockReturnValueOnce({ run: runMock });

    await request(app).put("/accounts/1").send({
      access_key_id: "NEWKEY",
      secret_access_key: "NEWSECRET",
    });
    expect(encrypt).toHaveBeenCalledWith("NEWKEY");
    expect(encrypt).toHaveBeenCalledWith("NEWSECRET");
    expect(runMock).toHaveBeenCalledWith(
      "Old Name",               // preserved
      "encrypted_NEWKEY",       // re-encrypted
      "encrypted_NEWSECRET",    // re-encrypted
      "us-east-1",              // preserved
      "1"
    );
  });

  it("updates only region, preserving name and credentials", async () => {
    const runMock = vi.fn();
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(existingAccount) })
      .mockReturnValueOnce({ run: runMock });

    await request(app).put("/accounts/1").send({ default_region: "eu-west-1" });
    expect(runMock).toHaveBeenCalledWith(
      "Old Name",
      "encrypted_OLDKEY",
      "encrypted_OLDSECRET",
      "eu-west-1",              // updated
      "1"
    );
  });

  it("updates all fields at once", async () => {
    const runMock = vi.fn();
    mockDb.prepare
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(existingAccount) })
      .mockReturnValueOnce({ run: runMock });

    await request(app).put("/accounts/1").send({
      name: "Brand New",
      access_key_id: "AKIA_NEW",
      secret_access_key: "SECRET_NEW",
      default_region: "ap-southeast-1",
    });
    expect(encrypt).toHaveBeenCalledWith("AKIA_NEW");
    expect(encrypt).toHaveBeenCalledWith("SECRET_NEW");
    expect(runMock).toHaveBeenCalledWith(
      "Brand New",
      "encrypted_AKIA_NEW",
      "encrypted_SECRET_NEW",
      "ap-southeast-1",
      "1"
    );
  });
});

describe("POST /accounts - encryption verification", () => {
  it("calls encrypt with the provided credentials", async () => {
    mockPrepare({ run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }) });

    await request(app).post("/accounts").send({
      name: "Test",
      access_key_id: "AKIAIOSFODNN7EXAMPLE",
      secret_access_key: "wJalrXUtnFEMI/K7MDENG",
    });

    expect(encrypt).toHaveBeenCalledWith("AKIAIOSFODNN7EXAMPLE");
    expect(encrypt).toHaveBeenCalledWith("wJalrXUtnFEMI/K7MDENG");
  });
});
