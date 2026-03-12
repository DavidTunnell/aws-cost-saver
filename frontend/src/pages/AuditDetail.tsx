import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { getAudit, type AuditDetail as AuditDetailType, type Recommendation } from "../api";
import RecommendationCard from "../components/RecommendationCard";

const SEVERITY_COLORS: Record<string, string> = {
  high: "#dc2626",
  medium: "#ca8a04",
  low: "#16a34a",
};

const CATEGORY_LABELS: Record<string, string> = {
  "right-size": "Right-Size",
  stop: "Stop/Terminate",
  "generation-upgrade": "Upgrade Generation",
  "reserved-instance": "Reserved Instance",
  "savings-plan": "Savings Plan",
  "unused-eip": "Unused EIP",
  "orphan-ebs": "Orphan EBS",
  idle: "Idle Instance",
  "ebs-optimize": "EBS Optimize",
  "graviton-migrate": "Graviton Migration",
  "schedule-stop": "Schedule Stop",
  "snapshot-cleanup": "Snapshot Cleanup",
};

function buildPdfHtml(audit: AuditDetailType) {
  const categoryCounts = audit.recommendations.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const recRows = audit.recommendations
    .sort((a, b) => b.estimated_savings - a.estimated_savings)
    .map((rec: Recommendation) => {
      let reasoning = "";
      try { reasoning = JSON.parse(rec.details).reasoning || ""; } catch {}
      const sColor = SEVERITY_COLORS[rec.severity] || "#6b7280";
      return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px;vertical-align:top;">
            ${rec.instance_id}<br/>
            <span style="color:#6b7280;font-family:sans-serif;">${rec.instance_name || ""}</span>
          </td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
            <span style="color:${sColor};font-weight:600;text-transform:uppercase;font-size:11px;">${rec.severity}</span><br/>
            <span style="font-size:12px;color:#2563eb;">${CATEGORY_LABELS[rec.category] || rec.category}</span>
            ${rec.instance_type ? `<br/><span style="font-size:11px;color:#6b7280;">${rec.instance_type}</span>` : ""}
          </td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-size:13px;vertical-align:top;">
            ${rec.action}
            ${reasoning ? `<br/><span style="font-size:11px;color:#6b7280;">${reasoning}</span>` : ""}
          </td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;vertical-align:top;">
            <strong style="color:#15803d;">$${rec.estimated_savings.toFixed(2)}/mo</strong>
            ${rec.current_monthly_cost > 0 ? `<br/><span style="font-size:11px;color:#6b7280;">from $${rec.current_monthly_cost.toFixed(2)}/mo</span>` : ""}
          </td>
        </tr>`;
    })
    .join("");

  const summaryItems = Object.entries(categoryCounts)
    .map(([cat, count]) => `${CATEGORY_LABELS[cat] || cat}: ${count}`)
    .join(" &nbsp;|&nbsp; ");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>AWS Cost Audit - ${audit.account_name}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 40px; color: #1f2937; font-size: 14px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
  .summary { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  .savings { font-size: 28px; font-weight: 700; color: #15803d; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid #d1d5db; font-size: 12px; color: #6b7280; text-transform: uppercase; }
  th:last-child { text-align: right; }
  @media print { body { margin: 20px; } }
</style>
</head><body>
<h1>AWS Cost Savings Report</h1>
<p class="meta">${audit.account_name} &mdash; Generated ${new Date().toLocaleDateString()}</p>
<div class="summary">
  <div style="display:flex;justify-content:space-between;align-items:center;">
    <div>
      <div style="font-size:13px;color:#6b7280;">Instances analyzed: <strong>${audit.instance_count}</strong> &nbsp;|&nbsp; Findings: <strong>${audit.recommendations.length}</strong></div>
      <div style="font-size:12px;color:#6b7280;margin-top:4px;">${summaryItems}</div>
    </div>
    <div style="text-align:right;">
      <div class="savings">$${audit.total_savings_monthly.toFixed(2)}/mo</div>
      <div style="font-size:12px;color:#6b7280;">potential savings</div>
    </div>
  </div>
</div>
<table>
  <thead><tr><th>Resource</th><th>Category</th><th>Recommendation</th><th>Savings</th></tr></thead>
  <tbody>${recRows}</tbody>
</table>
</body></html>`;
}

export default function AuditDetail() {
  const { id } = useParams<{ id: string }>();
  const [audit, setAudit] = useState<AuditDetailType | null>(null);
  const [error, setError] = useState("");

  const exportPdf = useCallback(() => {
    if (!audit || audit.status !== "completed") return;
    const html = buildPdfHtml(audit);
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 300);
  }, [audit]);

  useEffect(() => {
    if (!id) return;
    const load = () => {
      getAudit(parseInt(id))
        .then(setAudit)
        .catch((e) => setError(e.message));
    };
    load();

    // Poll while running
    const interval = setInterval(() => {
      getAudit(parseInt(id)).then((data) => {
        setAudit(data);
        if (data.status !== "running") clearInterval(interval);
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [id]);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
        {error}
      </div>
    );
  }

  if (!audit) {
    return <div className="text-gray-500">Loading...</div>;
  }

  const categoryCounts = audit.recommendations.reduce(
    (acc, r) => {
      acc[r.category] = (acc[r.category] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <Link
          to="/audits"
          className="text-sm text-blue-600 hover:underline"
        >
          &larr; Back to Audits
        </Link>
        {audit.status === "completed" && audit.recommendations.length > 0 && (
          <button
            onClick={exportPdf}
            className="flex items-center gap-2 bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export PDF
          </button>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">
              {audit.account_name}
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Started {new Date(audit.started_at).toLocaleString()}
              {audit.completed_at &&
                ` - Completed ${new Date(audit.completed_at).toLocaleString()}`}
            </p>
          </div>
          <div className="text-right">
            {audit.status === "running" ? (
              <div className="flex items-center gap-2">
                <div className="animate-spin h-5 w-5 border-2 border-blue-600 border-t-transparent rounded-full"></div>
                <span className="text-sm text-blue-600 font-medium">
                  Analyzing...
                </span>
              </div>
            ) : audit.status === "completed" ? (
              <>
                <div className="text-3xl font-bold text-green-700">
                  ${audit.total_savings_monthly.toFixed(2)}
                </div>
                <div className="text-sm text-gray-500">
                  potential monthly savings
                </div>
              </>
            ) : (
              <span className="text-red-600 font-medium">Failed</span>
            )}
          </div>
        </div>

        {audit.status === "completed" && (
          <div className="flex gap-4 mt-4 pt-4 border-t border-gray-100">
            <div className="text-sm">
              <span className="text-gray-500">Instances analyzed: </span>
              <span className="font-medium">{audit.instance_count}</span>
            </div>
            <div className="text-sm">
              <span className="text-gray-500">Findings: </span>
              <span className="font-medium">
                {audit.recommendations.length}
              </span>
            </div>
            {Object.entries(categoryCounts).map(([cat, count]) => (
              <div key={cat} className="text-sm">
                <span className="text-gray-500">{cat}: </span>
                <span className="font-medium">{count}</span>
              </div>
            ))}
          </div>
        )}

        {audit.error && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
            {audit.error}
          </div>
        )}
      </div>

      {audit.recommendations.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-gray-800 mb-3">
            Recommendations
          </h3>
          <div className="space-y-3">
            {audit.recommendations.map((rec) => (
              <RecommendationCard key={rec.id} rec={rec} />
            ))}
          </div>
        </div>
      )}

      {audit.status === "completed" && audit.recommendations.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg mb-2">No cost savings found</p>
          <p className="text-sm">
            Your EC2 resources appear to be well-optimized.
          </p>
        </div>
      )}
    </div>
  );
}
