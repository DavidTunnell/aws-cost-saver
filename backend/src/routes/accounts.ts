import { Router, Request, Response } from "express";
import db from "../db";
import { encrypt, decrypt } from "../crypto";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

const router = Router();

interface CreateAccountBody {
  name: string;
  access_key_id: string;
  secret_access_key: string;
  default_region?: string;
}

// List all accounts (credentials redacted)
router.get("/", (_req: Request, res: Response) => {
  const rows = db
    .prepare(
      `SELECT id, name, aws_account_id, default_region, created_at FROM aws_accounts ORDER BY created_at DESC`
    )
    .all();
  res.json(rows);
});

// Get single account
router.get("/:id", (req: Request, res: Response) => {
  const row = db
    .prepare(
      `SELECT id, name, aws_account_id, default_region, created_at FROM aws_accounts WHERE id = ?`
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Account not found" });
  res.json(row);
});

// Create account
router.post("/", (req: Request, res: Response) => {
  const { name, access_key_id, secret_access_key, default_region } =
    req.body as CreateAccountBody;

  if (!name || !access_key_id || !secret_access_key) {
    return res
      .status(400)
      .json({ error: "name, access_key_id, and secret_access_key are required" });
  }

  const result = db
    .prepare(
      `INSERT INTO aws_accounts (name, access_key_id_enc, secret_access_key_enc, default_region)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      name,
      encrypt(access_key_id),
      encrypt(secret_access_key),
      default_region || "us-east-1"
    );

  res.status(201).json({ id: result.lastInsertRowid });
});

// Update account
router.put("/:id", (req: Request, res: Response) => {
  const existing = db
    .prepare(`SELECT * FROM aws_accounts WHERE id = ?`)
    .get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: "Account not found" });

  const { name, access_key_id, secret_access_key, default_region } =
    req.body as Partial<CreateAccountBody>;

  db.prepare(
    `UPDATE aws_accounts
     SET name = ?, access_key_id_enc = ?, secret_access_key_enc = ?, default_region = ?
     WHERE id = ?`
  ).run(
    name || existing.name,
    access_key_id ? encrypt(access_key_id) : existing.access_key_id_enc,
    secret_access_key
      ? encrypt(secret_access_key)
      : existing.secret_access_key_enc,
    default_region || existing.default_region,
    req.params.id
  );

  res.json({ success: true });
});

// Delete account
router.delete("/:id", (req: Request, res: Response) => {
  const result = db
    .prepare(`DELETE FROM aws_accounts WHERE id = ?`)
    .run(req.params.id);
  if (result.changes === 0)
    return res.status(404).json({ error: "Account not found" });
  res.json({ success: true });
});

// Test connection
router.post("/:id/test", async (req: Request, res: Response) => {
  const row = db
    .prepare(`SELECT * FROM aws_accounts WHERE id = ?`)
    .get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "Account not found" });

  try {
    const sts = new STSClient({
      region: row.default_region,
      credentials: {
        accessKeyId: decrypt(row.access_key_id_enc),
        secretAccessKey: decrypt(row.secret_access_key_enc),
      },
    });
    const identity = await sts.send(new GetCallerIdentityCommand({}));

    // Update the stored account ID
    if (identity.Account) {
      db.prepare(`UPDATE aws_accounts SET aws_account_id = ? WHERE id = ?`).run(
        identity.Account,
        row.id
      );
    }

    res.json({
      success: true,
      account_id: identity.Account,
      arn: identity.Arn,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
