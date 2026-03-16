import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { getAudit, resolveRecommendation, type AuditDetail as AuditDetailType, type Recommendation } from "../api";
import RecommendationCard from "../components/RecommendationCard";
import SavingsFilter from "../components/SavingsFilter";
import { getAuditUI, getAllCategoryLabels } from "../audit-registry";
import "../audit-types";

const SEVERITY_COLORS: Record<string, string> = {
  high: "#dc2626",
  medium: "#ca8a04",
  low: "#16a34a",
};

function buildPdfHtml(
  audit: AuditDetailType,
  filteredRecs: Recommendation[],
  filteredSavings: number,
  categoryCounts: Record<string, number>,
  minSavings: number,
  showResolved: boolean
) {
  const ui = getAuditUI(audit.audit_type);
  const catLabels = getAllCategoryLabels();
  const totalRecs = audit.recommendations.length;
  const isFiltered = filteredRecs.length !== totalRecs;

  const recRows = filteredRecs
    .sort((a, b) => b.estimated_savings - a.estimated_savings)
    .map((rec: Recommendation) => {
      let reasoning = "";
      try { reasoning = JSON.parse(rec.details).reasoning || ""; } catch {}
      const sColor = SEVERITY_COLORS[rec.severity] || "#6b7280";
      return `
        <tr style="page-break-inside:avoid;">
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px;vertical-align:top;">
            ${rec.instance_id}<br/>
            <span style="color:#6b7280;font-family:sans-serif;">${rec.instance_name || ""}</span>
          </td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
            <span style="color:${sColor};font-weight:600;text-transform:uppercase;font-size:11px;">${rec.severity}</span><br/>
            <span style="font-size:12px;color:#2563eb;">${catLabels[rec.category] || rec.category}</span>
            ${rec.instance_type ? `<br/><span style="font-size:11px;color:#6b7280;">${rec.instance_type}</span>` : ""}
          </td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-size:13px;vertical-align:top;">
            ${rec.action}
            ${reasoning ? `<br/><span style="font-size:11px;color:#6b7280;">${reasoning}</span>` : ""}
          </td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;vertical-align:top;">
            ${rec.category === "cross-service" && rec.estimated_savings === 0
              ? `<strong style="color:#9333ea;">Strategic</strong>`
              : `<strong style="color:#15803d;">$${rec.estimated_savings.toFixed(2)}/mo</strong>
            ${rec.current_monthly_cost > 0 ? `<br/><span style="font-size:11px;color:#6b7280;">from $${rec.current_monthly_cost.toFixed(2)}/mo</span>` : ""}`}
          </td>
        </tr>`;
    })
    .join("");

  const summaryItems = Object.entries(categoryCounts)
    .map(([cat, count]) => `${catLabels[cat] || cat}: ${count}`)
    .join(" &nbsp;|&nbsp; ");

  const resourceNoun = ui ? ui.resourceNoun.charAt(0).toUpperCase() + ui.resourceNoun.slice(1) : "Resources";

  const findingsLabel = isFiltered
    ? `<strong>${filteredRecs.length}</strong> <span style="color:#9ca3af;">of ${totalRecs}</span>`
    : `<strong>${filteredRecs.length}</strong>`;

  const filterNotes: string[] = [];
  if (minSavings > 0) filterNotes.push(`min savings &ge; $${minSavings.toFixed(2)}/mo`);
  if (!showResolved) {
    const resolvedCount = audit.recommendations.filter(r => r.resolution).length;
    if (resolvedCount > 0) filterNotes.push(`${resolvedCount} resolved hidden`);
  }
  const filterLine = filterNotes.length > 0
    ? `<div style="font-size:11px;color:#9ca3af;margin-top:6px;font-style:italic;">Filters applied: ${filterNotes.join(" | ")}</div>`
    : "";

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:20px;color:#1f2937;font-size:14px;">
<h1 style="margin:0 0 4px;font-size:22px;">AWS ${ui?.label || audit.audit_type.toUpperCase()} Cost Savings Report</h1>
<p style="color:#6b7280;font-size:12px;margin:0 0 16px;">${audit.account_name} &mdash; Generated ${new Date().toLocaleDateString()}</p>
<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:24px;">
  <div style="display:flex;justify-content:space-between;align-items:center;">
    <div>
      <div style="font-size:13px;color:#6b7280;">${resourceNoun} analyzed: <strong>${audit.instance_count}</strong> &nbsp;|&nbsp; Findings: ${findingsLabel}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:4px;">${summaryItems}</div>
      ${filterLine}
    </div>
    <div style="text-align:right;">
      <div style="font-size:28px;font-weight:700;color:#15803d;">$${filteredSavings.toFixed(2)}/mo</div>
      <div style="font-size:12px;color:#6b7280;">potential savings</div>
    </div>
  </div>
</div>
<table style="width:100%;border-collapse:collapse;">
  <thead><tr>
    <th style="text-align:left;padding:8px;border-bottom:2px solid #d1d5db;font-size:12px;color:#6b7280;text-transform:uppercase;">Resource</th>
    <th style="text-align:left;padding:8px;border-bottom:2px solid #d1d5db;font-size:12px;color:#6b7280;text-transform:uppercase;">Category</th>
    <th style="text-align:left;padding:8px;border-bottom:2px solid #d1d5db;font-size:12px;color:#6b7280;text-transform:uppercase;">Recommendation</th>
    <th style="text-align:right;padding:8px;border-bottom:2px solid #d1d5db;font-size:12px;color:#6b7280;text-transform:uppercase;">Savings</th>
  </tr></thead>
  <tbody>${recRows}</tbody>
</table>
</div>`;
}

export default function AuditDetail() {
  const { id } = useParams<{ id: string }>();
  const [audit, setAudit] = useState<AuditDetailType | null>(null);
  const [error, setError] = useState("");
  const [minSavings, setMinSavings] = useState(1);
  const [showResolved, setShowResolved] = useState(false);
  const [exporting, setExporting] = useState(false);

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
        if (data.status !== "running" && data.status !== "consolidating" && data.status !== "validating") clearInterval(interval);
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [id]);

  const handleResolve = async (recId: number, resolution: "fixed" | "incorrect" | null, reason?: string) => {
    if (!audit) return;
    try {
      const updated = await resolveRecommendation(audit.id, recId, resolution, reason);
      setAudit((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          recommendations: prev.recommendations.map((r) =>
            r.id === recId ? { ...r, resolution: updated.resolution, resolution_reason: updated.resolution_reason, resolved_at: updated.resolved_at } : r
          ),
        };
      });
    } catch (err: any) {
      console.error("Failed to update recommendation:", err);
      setError(err.message || "Failed to update recommendation");
    }
  };

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded text-sm">
        {error}
      </div>
    );
  }

  if (!audit) {
    return <div className="text-gray-500 dark:text-gray-400">Loading...</div>;
  }

  const resolvedCount = audit.recommendations.filter((r) => r.resolution).length;
  const filteredRecs = audit.recommendations.filter(
    (r) => r.estimated_savings >= minSavings && (showResolved || !r.resolution)
  );
  const hiddenBySavings = audit.recommendations.filter(
    (r) => r.estimated_savings < minSavings && (showResolved || !r.resolution)
  ).length;

  const filteredSavings = filteredRecs.reduce(
    (sum, r) => sum + r.estimated_savings, 0
  );

  const categoryCounts = filteredRecs.reduce(
    (acc, r) => {
      acc[r.category] = (acc[r.category] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const exportPdf = async () => {
    if (!audit || audit.status !== "completed" || exporting) return;
    setExporting(true);
    try {
      const html = buildPdfHtml(audit, filteredRecs, filteredSavings, categoryCounts, minSavings, showResolved);
      const container = document.createElement("div");
      container.innerHTML = html;

      const { default: html2pdf } = await import("html2pdf.js");
      await html2pdf()
        .set({
          margin: [10, 10, 10, 10],
          filename: `aws-cost-audit-${audit.account_name.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`,
          image: { type: "jpeg", quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: "mm", format: "a4", orientation: "landscape" },
        })
        .from(container.firstElementChild as HTMLElement)
        .save();
    } catch (err: any) {
      console.error("PDF export failed:", err);
      setError(err.message || "PDF export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <Link
          to="/audits"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          &larr; Back to Audits
        </Link>
        {audit.status === "completed" && audit.recommendations.length > 0 && (
          <button
            onClick={exportPdf}
            disabled={exporting}
            className="flex items-center gap-2 bg-gray-800 dark:bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exporting ? (
              <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            )}
            {exporting ? "Generating..." : "Export PDF"}
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-3">
              {audit.account_name}
              <span className={`text-xs font-medium px-2 py-0.5 rounded border ${
                getAuditUI(audit.audit_type)?.badgeStyle || "bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600"
              }`}>
                {getAuditUI(audit.audit_type)?.label || audit.audit_type.toUpperCase()}
              </span>
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Started {new Date(audit.started_at).toLocaleString()}
              {audit.completed_at &&
                ` - Completed ${new Date(audit.completed_at).toLocaleString()}`}
            </p>
          </div>
          <div className="text-right">
            {audit.status === "running" && audit.audit_type !== "full" ? (
              <div className="flex items-center gap-2">
                <div className="animate-spin h-5 w-5 border-2 border-blue-600 border-t-transparent rounded-full"></div>
                <span className="text-sm text-blue-600 dark:text-blue-400 font-medium">
                  Analyzing...
                </span>
              </div>
            ) : audit.status === "running" && audit.audit_type === "full" ? (
              <div className="flex items-center gap-2">
                <div className="animate-spin h-5 w-5 border-2 border-blue-600 border-t-transparent rounded-full"></div>
                <span className="text-sm text-blue-600 dark:text-blue-400 font-medium">
                  Running all services...
                </span>
              </div>
            ) : audit.status === "consolidating" ? (
              <div className="flex items-center gap-2">
                <div className="animate-spin h-5 w-5 border-2 border-purple-600 border-t-transparent rounded-full"></div>
                <span className="text-sm text-purple-600 dark:text-purple-400 font-medium">
                  Consolidating results...
                </span>
              </div>
            ) : audit.status === "validating" ? (
              <div className="flex items-center gap-2">
                <div className="animate-spin h-5 w-5 border-2 border-amber-600 border-t-transparent rounded-full"></div>
                <span className="text-sm text-amber-600 dark:text-amber-400 font-medium">
                  Validating recommendations...
                </span>
              </div>
            ) : audit.status === "completed" ? (
              <>
                <div className="text-3xl font-bold text-green-700 dark:text-green-400">
                  ${filteredSavings.toFixed(2)}
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  potential monthly savings
                </div>
              </>
            ) : (
              <span className="text-red-600 dark:text-red-400 font-medium">Failed</span>
            )}
          </div>
        </div>

        {audit.status === "completed" && (
          <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
            <div className="flex gap-4 mb-2">
              <div className="text-sm">
                <span className="text-gray-500 dark:text-gray-400">{(getAuditUI(audit.audit_type)?.resourceNoun || "resources").charAt(0).toUpperCase() + (getAuditUI(audit.audit_type)?.resourceNoun || "resources").slice(1)} analyzed: </span>
                <span className="font-medium">{audit.instance_count}</span>
              </div>
              <div className="text-sm">
                <span className="text-gray-500 dark:text-gray-400">Findings: </span>
                <span className="font-medium">
                  {filteredRecs.length}
                  {hiddenBySavings > 0 && (
                    <span className="text-gray-400 dark:text-gray-500 font-normal"> of {audit.recommendations.length}</span>
                  )}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {Object.entries(categoryCounts).map(([cat, count]) => (
                <div key={cat} className="text-sm">
                  <span className="text-gray-500 dark:text-gray-400">{getAllCategoryLabels()[cat] || cat}: </span>
                  <span className="font-medium">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {audit.error && (
          <div className="mt-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded p-3 text-sm text-red-700 dark:text-red-400">
            {audit.error}
          </div>
        )}
      </div>

      {audit.audit_type === "full" && audit.child_audits && audit.child_audits.length > 0 && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Service Progress</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {audit.child_audits.map((child) => (
              <div
                key={child.id}
                className={`flex items-center gap-2 px-3 py-2 rounded text-sm ${
                  child.status === "completed"
                    ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                    : child.status === "failed"
                      ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                      : "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                }`}
              >
                {child.status === "running" && (
                  <div className="animate-spin h-3.5 w-3.5 border-2 border-blue-600 border-t-transparent rounded-full shrink-0"></div>
                )}
                {child.status === "completed" && (
                  <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {child.status === "failed" && (
                  <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
                <span className="font-medium">{child.label}</span>
              </div>
            ))}
          </div>
          {audit.status === "running" && (
            <div className="mt-3 text-xs text-gray-400 dark:text-gray-500">
              Aggregation and deduplication will run after all services complete.
            </div>
          )}
          {audit.status === "consolidating" && (
            <div className="mt-3 flex items-center gap-2 text-xs text-purple-600 dark:text-purple-400 font-medium">
              <div className="animate-spin h-3 w-3 border-2 border-purple-600 border-t-transparent rounded-full"></div>
              Consolidating and deduplicating results across services...
            </div>
          )}
          {audit.status === "validating" && (
            <div className="mt-3 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 font-medium">
              <div className="animate-spin h-3 w-3 border-2 border-amber-600 border-t-transparent rounded-full"></div>
              Validating recommendation accuracy...
            </div>
          )}
        </div>
      )}

      {audit.status === "completed" && audit.recommendations.length > 0 && (
        <div className="flex items-center gap-4 mb-4">
          <SavingsFilter onThresholdChange={setMinSavings} />
          {resolvedCount > 0 && (
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
                className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
              />
              Show resolved ({resolvedCount})
            </label>
          )}
        </div>
      )}

      {filteredRecs.length > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-3">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
              Recommendations
            </h3>
            {hiddenBySavings > 0 && (
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {hiddenBySavings} hidden below ${minSavings} threshold
              </span>
            )}
          </div>
          <div className="space-y-3">
            {filteredRecs.map((rec) => (
              <RecommendationCard key={rec.id} rec={rec} onResolve={handleResolve} accountId={audit.account_id} />
            ))}
          </div>
        </div>
      )}

      {audit.status === "completed" && audit.recommendations.length === 0 && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <p className="text-lg mb-2">No cost savings found</p>
          <p className="text-sm">
            Your {getAuditUI(audit.audit_type)?.label || audit.audit_type.toUpperCase()} {getAuditUI(audit.audit_type)?.resourceNoun || "resources"} appear to be well-optimized.
          </p>
        </div>
      )}

      {audit.status === "completed" && audit.recommendations.length > 0 && filteredRecs.length === 0 && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <p className="text-lg mb-2">All recommendations filtered out</p>
          <p className="text-sm">
            {audit.recommendations.length} recommendation{audit.recommendations.length !== 1 ? "s" : ""} below ${minSavings}/mo threshold.
          </p>
        </div>
      )}
    </div>
  );
}
