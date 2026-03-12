import type { Recommendation } from "../api";

const SEVERITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-800",
  medium: "bg-yellow-100 text-yellow-800",
  low: "bg-green-100 text-green-800",
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
};

export default function RecommendationCard({
  rec,
}: {
  rec: Recommendation;
}) {
  let details: { reasoning?: string } = {};
  try {
    details = JSON.parse(rec.details);
  } catch {}

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-sm transition-shadow">
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
              {CATEGORY_LABELS[rec.category] || rec.category}
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
    </div>
  );
}
