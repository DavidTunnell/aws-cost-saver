import { useState } from "react";
import type { Recommendation } from "../api";
import { getAllCategoryLabels } from "../audit-registry";
import "../audit-types";

const SEVERITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-800",
  medium: "bg-yellow-100 text-yellow-800",
  low: "bg-green-100 text-green-800",
};

export default function RecommendationCard({
  rec,
  onResolve,
}: {
  rec: Recommendation;
  onResolve?: (recId: number, resolution: "fixed" | "incorrect" | null, reason?: string) => void;
}) {
  const [showIncorrectForm, setShowIncorrectForm] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  let details: { reasoning?: string } = {};
  try {
    details = JSON.parse(rec.details);
  } catch {}

  const isResolved = rec.resolution !== null && rec.resolution !== undefined;

  const handleResolve = async (resolution: "fixed" | "incorrect" | null, submitReason?: string) => {
    if (!onResolve || loading) return;
    setLoading(true);
    try {
      await onResolve(rec.id, resolution, submitReason);
      setShowIncorrectForm(false);
      setReason("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`bg-white border rounded-lg p-4 transition-shadow ${
      isResolved
        ? "border-gray-100 opacity-60"
        : "border-gray-200 hover:shadow-sm"
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-sm text-gray-600">
              {rec.instance_id}
            </span>
            {rec.instance_name && (
              <span className="text-sm text-gray-500">
                ({rec.instance_name})
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded ${SEVERITY_COLORS[rec.severity] || "bg-gray-100 text-gray-800"}`}
            >
              {rec.severity}
            </span>
            <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
              {getAllCategoryLabels()[rec.category] || rec.category}
            </span>
            {rec.instance_type && (
              <span className="text-xs text-gray-500">{rec.instance_type}</span>
            )}
          </div>
          <p className="text-sm text-gray-800 mb-2">{rec.action}</p>
          {details.reasoning && (
            <p className="text-xs text-gray-500">{details.reasoning}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-bold text-green-700">
            ${rec.estimated_savings.toFixed(2)}
            <span className="text-xs font-normal text-gray-500">/mo</span>
          </div>
          {rec.current_monthly_cost > 0 && (
            <div className="text-xs text-gray-500">
              Current: ${rec.current_monthly_cost.toFixed(2)}/mo
            </div>
          )}
        </div>
      </div>

      {/* Resolution actions */}
      {onResolve && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          {isResolved ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                  rec.resolution === "fixed"
                    ? "bg-green-100 text-green-700"
                    : "bg-orange-100 text-orange-700"
                }`}>
                  {rec.resolution === "fixed" ? "Fixed" : "Incorrect"}
                </span>
                {rec.resolution_reason && (
                  <span className="text-xs text-gray-500 italic">
                    {rec.resolution_reason}
                  </span>
                )}
              </div>
              <button
                onClick={() => handleResolve(null)}
                disabled={loading}
                className="text-xs font-medium px-3 py-1 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-50"
              >
                Undo
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleResolve("fixed")}
                  disabled={loading}
                  className="text-xs font-medium px-3 py-1 rounded border border-green-200 bg-green-50 text-green-700 hover:bg-green-100 transition-colors disabled:opacity-50"
                >
                  Fixed
                </button>
                <button
                  onClick={() => setShowIncorrectForm(!showIncorrectForm)}
                  disabled={loading}
                  className="text-xs font-medium px-3 py-1 rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 transition-colors disabled:opacity-50"
                >
                  Incorrect
                </button>
              </div>
              {showIncorrectForm && (
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why is this incorrect?"
                    className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-red-300"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && reason.trim()) {
                        handleResolve("incorrect", reason.trim());
                      }
                    }}
                  />
                  <button
                    onClick={() => handleResolve("incorrect", reason.trim())}
                    disabled={loading || !reason.trim()}
                    className="text-xs font-medium px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    Submit
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
