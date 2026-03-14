import db from "../db";
import { decrypt } from "../crypto";
import { collectELBData } from "../aws/elb-collector";
import { analyzeELBWithClaude } from "./elb-analyzer";
import { registerAuditType } from "../audit-registry";
import { carryOverResolutions } from "./resolution-carry-over";

registerAuditType({
  key: "elb",
  label: "Load Balancers",
  resourceNoun: "load balancers",
  runner: runELBAudit,
});

export async function runELBAudit(accountId: number, auditId: number) {
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

    // Collect ELB data
    const data = await collectELBData(
      credentials,
      account.default_region,
      account.name,
      account.aws_account_id || "unknown",
      (msg) => console.log(`[ELB Audit ${auditId}] ${msg}`)
    );

    // Analyze with deterministic rules + Claude
    console.log(`[ELB Audit ${auditId}] Analyzing...`);
    const recommendations = await analyzeELBWithClaude(data);
    console.log(
      `[ELB Audit ${auditId}] Got ${recommendations.length} recommendations`
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
          JSON.stringify({ reasoning: rec.reasoning, ...(rec.metadata && { metadata: rec.metadata }) })
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
    ).run(totalSavings, data.loadBalancers.length, auditId);

    console.log(
      `[ELB Audit ${auditId}] Completed. Total potential savings: $${totalSavings.toFixed(2)}/mo`
    );
  } catch (err: any) {
    console.error(`[ELB Audit ${auditId}] Failed:`, err.message);
    db.prepare(
      `UPDATE audits SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?`
    ).run(err.message, auditId);
  }
}
