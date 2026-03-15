import { useState } from "react";
import type { Recommendation } from "../api";
import { getAllCategoryLabels } from "../audit-registry";
import "../audit-types";

const SEVERITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  low: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
};

const METADATA_LABELS: Record<string, string> = {
  region: "Region",
  accountId: "Account ID",
  az: "Availability Zone",
  availabilityZones: "Availability Zones",
  vpcId: "VPC",
  subnetId: "Subnet",
  arn: "ARN",
  resourceId: "Resource ID",
  publicIp: "Public IP",
  engine: "Engine",
  engineVersion: "Engine Version",
  storageType: "Storage Type",
  multiAZ: "Multi-AZ",
  runtime: "Runtime",
  memorySize: "Memory (MB)",
  billingMode: "Billing Mode",
  tableClass: "Table Class",
  type: "Type",
  scheme: "Scheme",
  platform: "Platform",
  launchTime: "Launch Time",
  imageId: "AMI",
  creationDate: "Created",
  architecture: "Architecture",
  numberOfObjects: "Objects",
  versioningEnabled: "Versioning",
  snapshotType: "Snapshot Type",
  validationWarning: "Validation Warning",
  createdAt: "Created At",
  storageGb: "Storage (GB)",
  sourceInstance: "Source Instance",
  sourceCluster: "Source Cluster",
  targetType: "Target Type",
  protocol: "Protocol",
  port: "Port",
};

export default function RecommendationCard({
  rec,
  onResolve,
}: {
  rec: Recommendation;
  onResolve?: (recId: number, resolution: "fixed" | "incorrect" | null, reason?: string) => void;
}) {
  const [showIncorrectForm, setShowIncorrectForm] = useState(false);
  const [showMetadata, setShowMetadata] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  let details: { reasoning?: string; metadata?: Record<string, string> } = {};
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
    <div className={`bg-white dark:bg-gray-800 border rounded-lg p-4 transition-shadow ${
      isResolved
        ? "border-gray-100 dark:border-gray-700 opacity-60"
        : "border-gray-200 dark:border-gray-700 hover:shadow-sm dark:hover:shadow-gray-900/50"
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-sm text-gray-600 dark:text-gray-400">
              {rec.instance_id}
            </span>
            {rec.instance_name && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                ({rec.instance_name})
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded ${SEVERITY_COLORS[rec.severity] || "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"}`}
            >
              {rec.severity}
            </span>
            <span className="text-xs bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 px-2 py-0.5 rounded">
              {getAllCategoryLabels()[rec.category] || rec.category}
            </span>
            {rec.instance_type && (
              <span className="text-xs text-gray-500 dark:text-gray-400">{rec.instance_type}</span>
            )}
          </div>
          <p className="text-sm text-gray-800 dark:text-gray-200 mb-2">{rec.action}</p>
          {details.reasoning && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{details.reasoning}</p>
          )}
      {details.metadata?.validationWarning && (
        <div className="mt-2 flex items-start gap-2 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <span className="shrink-0">&#9888;&#65039;</span>
          <span>{details.metadata.validationWarning}</span>
        </div>
      )}
      {details.metadata && Object.keys(details.metadata).filter(k => k !== "validationWarning").length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowMetadata(!showMetadata)}
            className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline"
          >
            {showMetadata ? "Hide details \u25BE" : "Resource details \u25B8"}
          </button>
          {showMetadata && (
            <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
              {Object.entries(details.metadata).filter(([key]) => key !== "validationWarning").map(([key, value]) => (
                <div key={key} className="contents">
                  <span className="text-gray-500 dark:text-gray-400 font-medium">
                    {METADATA_LABELS[key] || key}
                  </span>
                  <span className="text-gray-700 dark:text-gray-300 font-mono truncate" title={String(value)}>
                    {String(value)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
        </div>
        <div className="text-right shrink-0">
          {rec.category === "cross-service" && rec.estimated_savings === 0 ? (
            <span className="text-sm font-medium text-purple-600 dark:text-purple-400">Strategic</span>
          ) : (
            <>
              <div className="text-lg font-bold text-green-700 dark:text-green-400">
                ${rec.estimated_savings.toFixed(2)}
                <span className="text-xs font-normal text-gray-500 dark:text-gray-400">/mo</span>
              </div>
              {rec.current_monthly_cost > 0 && (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Current: ${rec.current_monthly_cost.toFixed(2)}/mo
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Resolution actions */}
      {onResolve && (
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
          {isResolved ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                  rec.resolution === "fixed"
                    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                    : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"
                }`}>
                  {rec.resolution === "fixed" ? "Fixed" : "Incorrect"}
                </span>
                {rec.resolution_reason && (
                  <span className="text-xs text-gray-500 dark:text-gray-400 italic">
                    {rec.resolution_reason}
                  </span>
                )}
              </div>
              <button
                onClick={() => handleResolve(null)}
                disabled={loading}
                className="text-xs font-medium px-3 py-1 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60 transition-colors disabled:opacity-50"
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
                  className="text-xs font-medium px-3 py-1 rounded border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/40 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/60 transition-colors disabled:opacity-50"
                >
                  Fixed
                </button>
                <button
                  onClick={() => setShowIncorrectForm(!showIncorrectForm)}
                  disabled={loading}
                  className="text-xs font-medium px-3 py-1 rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/40 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60 transition-colors disabled:opacity-50"
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
                    className="flex-1 text-sm border border-gray-200 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-red-300"
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
