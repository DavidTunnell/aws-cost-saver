import db from "../db";
import { decrypt } from "../crypto";
import { collectECSData } from "../aws/ecs-collector";
import { analyzeECSWithClaude } from "./ecs-analyzer";
import { registerAuditType } from "../audit-registry";

registerAuditType({
  key: "ecs",
  label: "ECS/Fargate",
  resourceNoun: "services",
  runner: runECSAudit,
});

export async function runECSAudit(accountId: number, auditId: number) {
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

    // Collect ECS data
    const data = await collectECSData(
      credentials,
      account.default_region,
      account.name,
      account.aws_account_id || "unknown",
      (msg) => console.log(`[ECS Audit ${auditId}] ${msg}`)
    );

    // Analyze with deterministic rules + Claude
    console.log(`[ECS Audit ${auditId}] Analyzing...`);
    const recommendations = await analyzeECSWithClaude(data);
    console.log(
      `[ECS Audit ${auditId}] Got ${recommendations.length} recommendations`
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
    ).run(totalSavings, data.services.length, auditId);

    console.log(
      `[ECS Audit ${auditId}] Completed. Total potential savings: $${totalSavings.toFixed(2)}/mo`
    );
  } catch (err: any) {
    console.error(`[ECS Audit ${auditId}] Failed:`, err.message);
    db.prepare(
      `UPDATE audits SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?`
    ).run(err.message, auditId);
  }
}
