import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getAudits, deleteAudit, deleteAllAudits, type Audit } from "../api";
import { getAuditUI } from "../audit-registry";
import "../audit-types";

const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  completed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

export default function Audits() {
  const [audits, setAudits] = useState<Audit[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    getAudits().then(setAudits).catch((e) => setError(e.message));
  };

  const handleDeleteAll = async () => {
    if (!confirm("Delete all audit history? This cannot be undone.")) return;
    try {
      await deleteAllAudits();
      setAudits([]);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this audit record? This cannot be undone.")) return;
    try {
      await deleteAudit(id);
      setAudits((prev) => prev.filter((a) => a.id !== id));
    } catch (err: any) {
      setError(err.message);
    }
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
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Audit History</h2>
        {audits.length > 0 && (
          <button
            onClick={handleDeleteAll}
            className="text-sm px-3 py-1.5 rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 dark:hover:bg-red-900/60 transition-colors"
          >
            Delete All
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded mb-4 text-sm">
          {error}
        </div>
      )}

      {audits.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <p className="text-lg mb-2">No audits yet</p>
          <p className="text-sm">
            Go to{" "}
            <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline">
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
              className="block bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:shadow-sm dark:hover:shadow-gray-900/50 transition-shadow"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-800 dark:text-gray-100 flex items-center gap-2">
                    {audit.account_name}
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded border ${getAuditUI(audit.audit_type)?.badgeStyle || "bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600"}`}>
                      {(getAuditUI(audit.audit_type)?.label || audit.audit_type || "ec2").toUpperCase()}
                    </span>
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {new Date(audit.started_at).toLocaleString()} &middot;{" "}
                    {audit.instance_count} {getAuditUI(audit.audit_type)?.resourceNoun || "resources"}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {audit.status === "completed" &&
                    audit.total_savings_monthly > 0 && (
                      <div className="text-right">
                        <div className="text-lg font-bold text-green-700 dark:text-green-400">
                          ${audit.total_savings_monthly.toFixed(2)}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          potential savings/mo
                        </div>
                      </div>
                    )}
                  <span
                    className={`text-xs font-medium px-2.5 py-1 rounded ${STATUS_STYLES[audit.status] || "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"}`}
                  >
                    {audit.status}
                  </span>
                  <button
                    onClick={(e) => handleDelete(e, audit.id)}
                    className="text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors p-1"
                    title="Delete audit"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              </div>
              {audit.error && (
                <div className="text-sm text-red-600 dark:text-red-400 mt-2">{audit.error}</div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
