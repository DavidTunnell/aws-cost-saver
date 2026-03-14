import db from "../db";
import { registerAuditType, getAuditType, getRegisteredTypes } from "../audit-registry";
import { deduplicateFullAudit, type DbRecommendation } from "./full-audit-analyzer";

registerAuditType({
  key: "full",
  label: "Full Audit",
  resourceNoun: "resources",
  runner: runFullAudit,
});

export async function runFullAudit(accountId: number, auditId: number) {
  try {
    // 1. Determine child audit types (everything except "full")
    const childTypes = getRegisteredTypes().filter((t) => t !== "full");
    console.log(`[Full Audit ${auditId}] Starting ${childTypes.length} sub-audits: ${childTypes.join(", ")}`);

    // 2. Create child audit rows, skipping types that already have a running audit
    const childAudits: { id: number; type: string; reused: boolean }[] = [];
    const insertAudit = db.prepare(
      `INSERT INTO audits (account_id, audit_type, parent_audit_id) VALUES (?, ?, ?)`
    );
    const checkRunning = db.prepare(
      `SELECT id FROM audits WHERE account_id = ? AND audit_type = ? AND status = 'running' AND parent_audit_id IS NULL`
    );

    for (const type of childTypes) {
      // Guard: skip if a standalone audit of this type is already running
      const existing = checkRunning.get(accountId, type) as any;
      if (existing) {
        console.log(`[Full Audit ${auditId}] Skipping ${type} — standalone audit ${existing.id} already running`);
        childAudits.push({ id: existing.id, type, reused: true });
        continue;
      }

      const result = insertAudit.run(accountId, type, auditId);
      const childId = result.lastInsertRowid as number;
      childAudits.push({ id: childId, type, reused: false });
    }

    // Store child audit IDs in parent for progress tracking
    const childMeta = childAudits.map((c) => ({
      id: c.id,
      audit_type: c.type,
      label: getAuditType(c.type)?.label || c.type,
    }));
    db.prepare(`UPDATE audits SET details = ? WHERE id = ?`).run(
      JSON.stringify({ child_audit_ids: childMeta }),
      auditId
    );

    // 3. Launch child runners in parallel (skip reused audits — they're already running)
    const runnerPromises = childAudits
      .filter((child) => !child.reused)
      .map((child) => {
        const config = getAuditType(child.type);
        if (!config) return Promise.resolve();
        return config.runner(accountId, child.id).catch((err) => {
          console.error(`[Full Audit ${auditId}] Child ${child.type} (${child.id}) failed:`, err.message);
        });
      });

    // Wait for all child audits to complete
    await Promise.allSettled(runnerPromises);

    // 4. Mark parent as consolidating (so the frontend can show a spinner)
    db.prepare(`UPDATE audits SET status = 'consolidating' WHERE id = ?`).run(auditId);
    console.log(`[Full Audit ${auditId}] All sub-audits finished — consolidating results`);

    // 5. Gather results from completed children
    const childIds = childAudits.map((c) => c.id);
    const placeholders = childIds.map(() => "?").join(",");

    const completedChildren = db
      .prepare(`SELECT id, audit_type, instance_count FROM audits WHERE id IN (${placeholders}) AND status = 'completed'`)
      .all(...childIds) as any[];

    if (completedChildren.length === 0) {
      throw new Error("All sub-audits failed — no recommendations to aggregate");
    }

    const completedIds = completedChildren.map((c: any) => c.id);
    const completedPlaceholders = completedIds.map(() => "?").join(",");
    const allRecs = db
      .prepare(`SELECT * FROM recommendations WHERE audit_id IN (${completedPlaceholders}) ORDER BY estimated_savings DESC`)
      .all(...completedIds) as DbRecommendation[];

    console.log(`[Full Audit ${auditId}] Collected ${allRecs.length} recommendations from ${completedChildren.length} sub-audits`);

    // 5. Deduplicate with deterministic rules + LLM, then synthesize cross-service recs
    const dedupedRecs = await deduplicateFullAudit(allRecs);
    console.log(`[Full Audit ${auditId}] After dedup + synthesis: ${dedupedRecs.length} recommendations`);

    // 6. Write aggregated recommendations to parent audit
    const insertRec = db.prepare(
      `INSERT INTO recommendations
         (audit_id, instance_id, instance_name, instance_type, category, severity,
          current_monthly_cost, estimated_savings, action, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let totalSavings = 0;
    const totalInstances = completedChildren.reduce((sum: number, c: any) => sum + (c.instance_count || 0), 0);

    const writeAll = db.transaction(() => {
      for (const rec of dedupedRecs) {
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

    // 7. Mark parent audit as completed
    const failedChildren = childAudits.length - completedChildren.length;
    const detailsJson = JSON.stringify({
      child_audit_ids: childMeta,
      completed: completedChildren.length,
      failed: failedChildren,
    });

    db.prepare(
      `UPDATE audits
       SET status = 'completed',
           total_savings_monthly = ?,
           instance_count = ?,
           details = ?,
           completed_at = datetime('now')
       WHERE id = ?`
    ).run(totalSavings, totalInstances, detailsJson, auditId);

    console.log(`[Full Audit ${auditId}] Completed — $${totalSavings.toFixed(2)}/mo savings, ${dedupedRecs.length} recommendations`);
  } catch (err: any) {
    console.error(`[Full Audit ${auditId}] Failed:`, err);
    db.prepare(
      `UPDATE audits SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?`
    ).run(err.message, auditId);
  }
}
