import db from "../db";
import { decrypt } from "../crypto";
import { collectRDSAccountData } from "../aws/rds-collector";
import { analyzeRDSWithClaude } from "./rds-analyzer";
import { registerAuditType } from "../audit-registry";
import { carryOverResolutions } from "./resolution-carry-over";

registerAuditType({
  key: "rds",
  label: "RDS",
  resourceNoun: "databases",
  runner: runRDSAudit,
});

export async function runRDSAudit(accountId: number, auditId: number) {
  try {
    const account = db
      .prepare(`SELECT * FROM aws_accounts WHERE id = ?`)
      .get(accountId) as any;

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const credentials = {
      accessKeyId: decrypt(account.access_key_id_enc),
      secretAccessKey: decrypt(account.secret_access_key_enc),
    };

    // Collect RDS data
    const data = await collectRDSAccountData(
      credentials,
      account.default_region,
      account.name,
      account.aws_account_id || "unknown",
      (msg) => console.log(`[RDS Audit ${auditId}] ${msg}`)
    );

    // Analyze with Claude
    console.log(`[RDS Audit ${auditId}] Analyzing with Claude...`);
    const recommendations = await analyzeRDSWithClaude(data);
    console.log(
      `[RDS Audit ${auditId}] Got ${recommendations.length} recommendations`
    );

    // Write recommendations to DB
    const insertRec = db.prepare(
      `INSERT INTO recommendations
         (audit_id, instance_id, instance_name, instance_type, category, severity,
          current_monthly_cost, estimated_savings, action, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let totalSavings = 0;
    const writeAll = db.transaction(() => {
      for (const rec of recommendations) {
        totalSavings += rec.estimatedSavings;
        insertRec.run(
          auditId,
          rec.instanceId,
          rec.instanceName,
          rec.instanceType,
          rec.category,
          rec.severity,
          rec.currentMonthlyCost,
          rec.estimatedSavings,
          rec.action,
          JSON.stringify({ reasoning: rec.reasoning })
        );
      }
    });
    writeAll();

    carryOverResolutions(accountId, auditId);

    // Mark audit as completed
    db.prepare(
      `UPDATE audits
       SET status = 'completed',
           total_savings_monthly = ?,
           instance_count = ?,
           completed_at = datetime('now')
       WHERE id = ?`
    ).run(totalSavings, data.instances.length, auditId);

    console.log(
      `[RDS Audit ${auditId}] Completed. Total potential savings: $${totalSavings.toFixed(2)}/mo`
    );
  } catch (err: any) {
    console.error(`[RDS Audit ${auditId}] Failed:`, err.message);
    db.prepare(
      `UPDATE audits SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?`
    ).run(err.message, auditId);
  }
}
