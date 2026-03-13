import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getAudits, type Audit } from "../api";
import { getAuditUI } from "../audit-registry";
import "../audit-types";

const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export default function Audits() {
  const [audits, setAudits] = useState<Audit[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    getAudits().then(setAudits).catch((e) => setError(e.message));
  };

  useEffect(() => {
    load();
    // Poll for running audits
    const interval = setInterval(() => {
      getAudits().then((data) => {
        setAudits(data);
        if (!data.some((a) => a.status === "running")) {
          clearInterval(interval);
        }
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Audit History</h2>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm">
          {error}
        </div>
      )}

      {audits.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg mb-2">No audits yet</p>
          <p className="text-sm">
            Go to{" "}
            <Link to="/" className="text-blue-600 hover:underline">
              Accounts
            </Link>{" "}
            and run an audit.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {audits.map((audit) => (
            <Link
              key={audit.id}
              to={`/audits/${audit.id}`}
              className="block bg-white border border-gray-200 rounded-lg p-4 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-800 flex items-center gap-2">
                    {audit.account_name}
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded border ${getAuditUI(audit.audit_type)?.badgeStyle || "bg-gray-50 text-gray-700 border-gray-200"}`}>
                      {(getAuditUI(audit.audit_type)?.label || audit.audit_type || "ec2").toUpperCase()}
                    </span>
                  </div>
                  <div className="text-sm text-gray-500">
                    {new Date(audit.started_at).toLocaleString()} &middot;{" "}
                    {audit.instance_count} {getAuditUI(audit.audit_type)?.resourceNoun || "resources"}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {audit.status === "completed" &&
                    audit.total_savings_monthly > 0 && (
                      <div className="text-right">
                        <div className="text-lg font-bold text-green-700">
                          ${audit.total_savings_monthly.toFixed(2)}
                        </div>
                        <div className="text-xs text-gray-500">
                          potential savings/mo
                        </div>
                      </div>
                    )}
                  <span
                    className={`text-xs font-medium px-2.5 py-1 rounded ${STATUS_STYLES[audit.status] || "bg-gray-100 text-gray-800"}`}
                  >
                    {audit.status}
                  </span>
                </div>
              </div>
              {audit.error && (
                <div className="text-sm text-red-600 mt-2">{audit.error}</div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
