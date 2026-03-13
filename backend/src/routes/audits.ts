import { Router, Request, Response } from "express";
import db from "../db";
import { runAudit } from "../services/audit-runner";
import { runRDSAudit } from "../services/rds-audit-runner";
import { runS3Audit } from "../services/s3-audit-runner";
import { runNatAudit } from "../services/nat-audit-runner";

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
  const { account_id, audit_type = "ec2" } = req.body;
  if (!account_id) {
    return res.status(400).json({ error: "account_id is required" });
  }

  if (!["ec2", "rds", "s3", "nat"].includes(audit_type)) {
    return res.status(400).json({ error: "audit_type must be 'ec2', 'rds', 's3', or 'nat'" });
  }

  const account = db
    .prepare(`SELECT id FROM aws_accounts WHERE id = ?`)
    .get(account_id);
  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  // Check if there's already a running audit for this account + type
  const running = db
    .prepare(
      `SELECT id FROM audits WHERE account_id = ? AND audit_type = ? AND status = 'running'`
    )
    .get(account_id, audit_type);
  if (running) {
    return res
      .status(409)
      .json({ error: `A ${audit_type.toUpperCase()} audit is already running for this account` });
  }

  const result = db
    .prepare(`INSERT INTO audits (account_id, audit_type) VALUES (?, ?)`)
    .run(account_id, audit_type);
  const auditId = result.lastInsertRowid as number;

  // Run audit in background (don't await)
  if (audit_type === "s3") {
    runS3Audit(account_id, auditId).catch((err) => {
      console.error(`Background S3 audit failed:`, err);
    });
  } else if (audit_type === "rds") {
    runRDSAudit(account_id, auditId).catch((err) => {
      console.error(`Background RDS audit failed:`, err);
    });
  } else if (audit_type === "nat") {
    runNatAudit(account_id, auditId).catch((err) => {
      console.error(`Background NAT audit failed:`, err);
    });
  } else {
    runAudit(account_id, auditId).catch((err) => {
      console.error(`Background audit failed:`, err);
    });
  }

  res.status(201).json({ id: auditId, status: "running" });
});

export default router;
