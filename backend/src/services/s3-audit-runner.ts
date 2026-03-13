import db from "../db";
import { decrypt } from "../crypto";
import { collectS3AccountData } from "../aws/s3-collector";
import { analyzeS3WithClaude } from "./s3-analyzer";
import { registerAuditType } from "../audit-registry";

registerAuditType({
  key: "s3",
  label: "S3",
  resourceNoun: "buckets",
  runner: runS3Audit,
});

export async function runS3Audit(accountId: number, auditId: number) {
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

    // Collect S3 data
    const data = await collectS3AccountData(
      credentials,
      account.default_region,
      account.name,
      account.aws_account_id || "unknown",
      (msg) => console.log(`[S3 Audit ${auditId}] ${msg}`)
    );

    // Analyze with Claude
    console.log(`[S3 Audit ${auditId}] Analyzing with Claude...`);
    const recommendations = await analyzeS3WithClaude(data);
    console.log(
      `[S3 Audit ${auditId}] Got ${recommendations.length} recommendations`
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

    // Mark audit as completed
    db.prepare(
      `UPDATE audits
       SET status = 'completed',
           total_savings_monthly = ?,
           instance_count = ?,
           completed_at = datetime('now')
       WHERE id = ?`
    ).run(totalSavings, data.buckets.length, auditId);

    console.log(
      `[S3 Audit ${auditId}] Completed. Total potential savings: $${totalSavings.toFixed(2)}/mo`
    );
  } catch (err: any) {
    console.error(`[S3 Audit ${auditId}] Failed:`, err.message);
    db.prepare(
      `UPDATE audits SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?`
    ).run(err.message, auditId);
  }
}
