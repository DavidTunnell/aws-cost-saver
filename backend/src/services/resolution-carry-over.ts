import db from "../db";

/**
 * Carry over resolutions from prior audits to new recommendations.
 * Matches on (account_id, instance_id, category) fingerprint.
 * Call after recommendations are inserted but before marking the audit as completed.
 */
export function carryOverResolutions(accountId: number, auditId: number) {
  const result = db.prepare(`
    UPDATE recommendations
    SET resolution = prev.resolution,
        resolution_reason = prev.resolution_reason,
        resolved_at = prev.resolved_at
    FROM (
      SELECT r2.instance_id, r2.category, r2.resolution, r2.resolution_reason, r2.resolved_at
      FROM recommendations r2
      JOIN audits a2 ON r2.audit_id = a2.id
      WHERE a2.account_id = ?
        AND a2.id != ?
        AND r2.resolution IS NOT NULL
      ORDER BY r2.resolved_at DESC
    ) AS prev
    WHERE recommendations.audit_id = ?
      AND recommendations.instance_id = prev.instance_id
      AND recommendations.category = prev.category
      AND recommendations.resolution IS NULL
  `).run(accountId, auditId, auditId);

  if (result.changes > 0) {
    console.log(`[Resolution Carry-Over] Applied ${result.changes} prior resolution(s) to audit ${auditId}`);
  }
}
