import { Router, Request, Response } from "express";
import db from "../db";
import { runAudit } from "../services/audit-runner";

const router = Router();

// List all audits
router.get("/", (_req: Request, res: Response) => {
  const rows = db
    .prepare(
      `SELECT a.*, ac.name as account_name
       FROM audits a
       JOIN aws_accounts ac ON a.account_id = ac.id
       ORDER BY a.started_at DESC`
    )
    .all();
  res.json(rows);
});

// Get audit detail with recommendations
router.get("/:id", (req: Request, res: Response) => {
  const audit = db
    .prepare(
      `SELECT a.*, ac.name as account_name
       FROM audits a
       JOIN aws_accounts ac ON a.account_id = ac.id
       WHERE a.id = ?`
    )
    .get(req.params.id) as any;

  if (!audit) return res.status(404).json({ error: "Audit not found" });

  const recommendations = db
    .prepare(
      `SELECT * FROM recommendations WHERE audit_id = ? ORDER BY estimated_savings DESC`
    )
    .all(req.params.id);

  res.json({ ...audit, recommendations });
});

// Start a new audit
router.post("/", async (req: Request, res: Response) => {
  const { account_id } = req.body;
  if (!account_id) {
    return res.status(400).json({ error: "account_id is required" });
  }

  const account = db
    .prepare(`SELECT id FROM aws_accounts WHERE id = ?`)
    .get(account_id);
  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  // Check if there's already a running audit for this account
  const running = db
    .prepare(
      `SELECT id FROM audits WHERE account_id = ? AND status = 'running'`
    )
    .get(account_id);
  if (running) {
    return res
      .status(409)
      .json({ error: "An audit is already running for this account" });
  }

  const result = db
    .prepare(`INSERT INTO audits (account_id) VALUES (?)`)
    .run(account_id);
  const auditId = result.lastInsertRowid as number;

  // Run audit in background (don't await)
  runAudit(account_id, auditId).catch((err) => {
    console.error(`Background audit failed:`, err);
  });

  res.status(201).json({ id: auditId, status: "running" });
});

export default router;
