import db from "../db";
import { decrypt } from "../crypto";
import { collectOpenSearchData } from "../aws/opensearch-collector";
import { analyzeOpenSearch } from "./opensearch-analyzer";
import { registerAuditType } from "../audit-registry";
import { carryOverResolutions } from "./resolution-carry-over";

registerAuditType({
  key: "opensearch",
  label: "OpenSearch",
  resourceNoun: "domains",
  runner: runOpenSearchAudit,
});

export async function runOpenSearchAudit(accountId: number, auditId: number) {
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

    // Collect OpenSearch data
    const data = await collectOpenSearchData(
      credentials,
      account.default_region,
      account.name,
      account.aws_account_id || "unknown",
      (msg) => console.log(`[OpenSearch Audit ${auditId}] ${msg}`)
    );

    // Analyze with deterministic rules (no LLM)
    console.log(`[OpenSearch Audit ${auditId}] Analyzing...`);
    const recommendations = analyzeOpenSearch(data);
    console.log(
      `[OpenSearch Audit ${auditId}] Got ${recommendations.length} recommendations`
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
    ).run(totalSavings, data.domains.length, auditId);

    console.log(
      `[OpenSearch Audit ${auditId}] Completed. Total potential savings: $${totalSavings.toFixed(2)}/mo`
    );
  } catch (err: any) {
    console.error(`[OpenSearch Audit ${auditId}] Failed:`, err.message);
    db.prepare(
      `UPDATE audits SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?`
    ).run(err.message, auditId);
  }
}
