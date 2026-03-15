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

// Mock Anthropic SDK — use vi.hoisted to avoid hoisting issues
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function() {
    return { messages: { create: mockCreate } };
  }),
}));

// Mock child_process — use vi.hoisted
const { mockExecSync } = vi.hoisted(() => ({ mockExecSync: vi.fn() }));
vi.mock("child_process", () => ({
  execSync: mockExecSync,
}));

import db from "../db";
import solutionsRouter from "./solutions";

const app = express();
app.use(express.json());
app.use("/solutions", solutionsRouter);

const mockDb = db as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /solutions/generate", () => {
  it("returns 400 when category is missing", async () => {
    const res = await request(app)
      .post("/solutions/generate")
      .send({ action: "Stop instance" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("category");
  });

  it("returns 400 when action is missing", async () => {
    const res = await request(app)
      .post("/solutions/generate")
      .send({ category: "stop" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("action");
  });

  it("returns 500 when ANTHROPIC_API_KEY is not set", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const res = await request(app)
      .post("/solutions/generate")
      .send({ category: "stop", action: "Stop instance" });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("ANTHROPIC_API_KEY");

    process.env.ANTHROPIC_API_KEY = origKey;
  });

  it("returns console and CLI instructions on success", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    mockCreate.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          console: "1. Go to EC2 console\n2. Stop instance",
          cli: "```bash\naws ec2 stop-instances --instance-ids i-abc123\n```",
        }),
      }],
    });

    const res = await request(app)
      .post("/solutions/generate")
      .send({
        category: "stop",
        action: "Stop instance i-abc123",
        instanceId: "i-abc123",
        instanceType: "t3.medium",
        metadata: { region: "us-east-1" },
      });

    expect(res.status).toBe(200);
    expect(res.body.console).toContain("EC2 console");
    expect(res.body.cli).toContain("stop-instances");

    process.env.ANTHROPIC_API_KEY = "";
  });

  it("includes metadata in the Anthropic prompt", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: '{"console": "test", "cli": "test"}' }],
    });

    await request(app)
      .post("/solutions/generate")
      .send({
        category: "stop",
        action: "Stop instance",
        instanceId: "i-abc123",
        instanceType: "t3.medium",
        metadata: { region: "us-west-2", az: "us-west-2a" },
      });

    // Verify the prompt sent to Anthropic includes the metadata
    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;
    expect(userMessage).toContain("i-abc123");
    expect(userMessage).toContain("t3.medium");
    expect(userMessage).toContain("region");
    expect(userMessage).toContain("us-west-2");
    expect(userMessage).toContain("us-west-2a");

    process.env.ANTHROPIC_API_KEY = "";
  });

  it("filters validationWarning from metadata in prompt", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: '{"console": "test", "cli": "test"}' }],
    });

    await request(app)
      .post("/solutions/generate")
      .send({
        category: "stop",
        action: "Stop instance",
        metadata: { region: "us-east-1", validationWarning: "something suspicious" },
      });

    const userMessage = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userMessage).toContain("region");
    expect(userMessage).not.toContain("validationWarning");

    process.env.ANTHROPIC_API_KEY = "";
  });

  it("uses 'No additional metadata' when metadata is null", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: '{"console": "test", "cli": "test"}' }],
    });

    await request(app)
      .post("/solutions/generate")
      .send({ category: "stop", action: "Stop instance", metadata: null });

    const userMessage = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userMessage).toContain("No additional metadata");

    process.env.ANTHROPIC_API_KEY = "";
  });

  it("returns 500 when LLM returns non-JSON response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "I cannot help with that request." }],
    });

    const res = await request(app)
      .post("/solutions/generate")
      .send({ category: "stop", action: "Stop instance" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Failed to parse");

    process.env.ANTHROPIC_API_KEY = "";
  });
});

describe("POST /solutions/execute", () => {
  it("returns 400 when commands is missing", async () => {
    const res = await request(app)
      .post("/solutions/execute")
      .send({ accountId: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("commands");
  });

  it("returns 400 when accountId is missing", async () => {
    const res = await request(app)
      .post("/solutions/execute")
      .send({ commands: "aws ec2 describe-instances" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("accountId");
  });

  it("returns 404 when account not found", async () => {
    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });

    const res = await request(app)
      .post("/solutions/execute")
      .send({ commands: "aws ec2 describe-instances", accountId: 999 });
    expect(res.status).toBe(404);
  });

  it("executes commands and returns output", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        access_key_id_enc: "encrypted_AKIA123",
        secret_access_key_enc: "encrypted_secret",
        default_region: "us-west-2",
      }),
    });

    mockExecSync.mockReturnValue("Stopping instances...\n");

    const res = await request(app)
      .post("/solutions/execute")
      .send({
        commands: "aws ec2 stop-instances --instance-ids i-abc123",
        accountId: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.output).toContain("aws ec2 stop-instances");
    expect(res.body.output).toContain("Stopping instances...");
  });

  it("skips comments and empty lines", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        access_key_id_enc: "encrypted_AKIA123",
        secret_access_key_enc: "encrypted_secret",
        default_region: "us-east-1",
      }),
    });

    mockExecSync.mockReturnValue("done");

    const res = await request(app)
      .post("/solutions/execute")
      .send({
        commands: "# This is a comment\n\naws ec2 describe-instances\n\n# Another comment",
        accountId: 1,
      });

    expect(res.status).toBe(200);
    // Only one command should have been executed
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when no executable commands found", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        access_key_id_enc: "encrypted_AKIA123",
        secret_access_key_enc: "encrypted_secret",
        default_region: "us-east-1",
      }),
    });

    const res = await request(app)
      .post("/solutions/execute")
      .send({
        commands: "# Only comments\n# Nothing to run",
        accountId: 1,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No executable commands");
  });

  it("handles command execution failure gracefully", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        access_key_id_enc: "encrypted_AKIA123",
        secret_access_key_enc: "encrypted_secret",
        default_region: "us-east-1",
      }),
    });

    mockExecSync.mockImplementation(() => {
      throw { stderr: "An error occurred", message: "Command failed" };
    });

    const res = await request(app)
      .post("/solutions/execute")
      .send({
        commands: "aws ec2 stop-instances --instance-ids i-bad",
        accountId: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.output).toContain("ERROR");
  });

  it("passes correct AWS credentials as env vars to execSync", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        access_key_id_enc: "encrypted_AKIATEST123",
        secret_access_key_enc: "encrypted_SuperSecret",
        default_region: "eu-west-1",
      }),
    });

    mockExecSync.mockReturnValue("ok");

    await request(app)
      .post("/solutions/execute")
      .send({ commands: "aws s3 ls", accountId: 1 });

    expect(mockExecSync).toHaveBeenCalledWith(
      "aws s3 ls",
      expect.objectContaining({
        env: expect.objectContaining({
          AWS_ACCESS_KEY_ID: "AKIATEST123",
          AWS_SECRET_ACCESS_KEY: "SuperSecret",
          AWS_DEFAULT_REGION: "eu-west-1",
        }),
      })
    );
  });

  it("reports failure when first command fails but second succeeds", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        access_key_id_enc: "encrypted_AKIA",
        secret_access_key_enc: "encrypted_secret",
        default_region: "us-east-1",
      }),
    });

    mockExecSync
      .mockImplementationOnce(() => { throw { stderr: "not found", message: "Command failed" }; })
      .mockReturnValueOnce("success output");

    const res = await request(app)
      .post("/solutions/execute")
      .send({
        commands: "aws ec2 stop-instances --instance-ids i-bad\naws s3 ls",
        accountId: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.output).toContain("ERROR");
    expect(res.body.output).toContain("success output");
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it("returns 500 when credential decryption fails", async () => {
    // Need to re-mock crypto's decrypt to throw for this test
    const { decrypt } = await import("../crypto");
    const decryptMock = decrypt as any;
    decryptMock.mockImplementationOnce(() => { throw new Error("decrypt failed"); });

    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        access_key_id_enc: "bad_encrypted_data",
        secret_access_key_enc: "encrypted_secret",
        default_region: "us-east-1",
      }),
    });

    const res = await request(app)
      .post("/solutions/execute")
      .send({ commands: "aws s3 ls", accountId: 1 });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Failed to decrypt");
  });

  it("shows (completed successfully) for empty command output", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        access_key_id_enc: "encrypted_AKIA",
        secret_access_key_enc: "encrypted_secret",
        default_region: "us-east-1",
      }),
    });

    mockExecSync.mockReturnValue("   "); // whitespace-only output

    const res = await request(app)
      .post("/solutions/execute")
      .send({ commands: "aws ec2 stop-instances --instance-ids i-abc", accountId: 1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.output).toContain("(completed successfully)");
  });

  it("joins line continuations (backslash-newline) into single command", async () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 1,
        access_key_id_enc: "encrypted_AKIA",
        secret_access_key_enc: "encrypted_secret",
        default_region: "us-east-1",
      }),
    });

    mockExecSync.mockReturnValue("done");

    await request(app)
      .post("/solutions/execute")
      .send({
        commands: "aws ec2 describe-instances \\\n--region us-east-1",
        accountId: 1,
      });

    // The backslash-newline should be joined into a single command
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      "aws ec2 describe-instances  --region us-east-1",
      expect.any(Object)
    );
  });
});
