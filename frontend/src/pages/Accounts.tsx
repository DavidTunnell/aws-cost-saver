import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  getAccounts,
  createAccount,
  deleteAccount,
  testConnection,
  startAudit,
  type Account,
} from "../api";
import AccountForm from "../components/AccountForm";
import { getAllAuditUIs } from "../audit-registry";
import "../audit-types";

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{
    id: number;
    success: boolean;
    message: string;
  } | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const load = () => {
    getAccounts().then(setAccounts).catch((e) => setError(e.message));
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async (data: {
    name: string;
    access_key_id: string;
    secret_access_key: string;
    default_region: string;
  }) => {
    try {
      await createAccount(data);
      setShowForm(false);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this account and all its audit history?")) return;
    try {
      await deleteAccount(id);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    setTestResult(null);
    try {
      const result = await testConnection(id);
      setTestResult({
        id,
        success: true,
        message: `Connected! Account: ${result.account_id}`,
      });
      load();
    } catch (e: any) {
      setTestResult({ id, success: false, message: e.message });
    } finally {
      setTesting(null);
    }
  };

  const handleAudit = async (accountId: number, auditType: string = 'ec2') => {
    try {
      const result = await startAudit(accountId, auditType);
      navigate(`/audits/${result.id}`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">AWS Accounts</h2>
        <button
          onClick={() => setShowForm(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-blue-700"
        >
          + Add Account
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm">
          {error}
          <button
            onClick={() => setError("")}
            className="float-right font-bold"
          >
            x
          </button>
        </div>
      )}

      {showForm && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">Add AWS Account</h3>
          <AccountForm
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {accounts.length === 0 && !showForm ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg mb-2">No AWS accounts configured</p>
          <p className="text-sm">
            Add an account to start analyzing AWS costs.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.map((acc) => (
            <div
              key={acc.id}
              className="bg-white border border-gray-200 rounded-lg p-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-800">{acc.name}</div>
                  <div className="text-sm text-gray-500">
                    {acc.aws_account_id || "Account ID unknown"} &middot;{" "}
                    {acc.default_region}
                  </div>
                  {testResult?.id === acc.id && (
                    <div
                      className={`text-sm mt-1 ${testResult.success ? "text-green-600" : "text-red-600"}`}
                    >
                      {testResult.message}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTest(acc.id)}
                    disabled={testing === acc.id}
                    className="border border-gray-300 px-3 py-1.5 rounded text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {testing === acc.id ? "Testing..." : "Test Connection"}
                  </button>
                  {getAllAuditUIs().filter((ui) => ui.key !== "full").map((auditUI) => (
                    <button
                      key={auditUI.key}
                      onClick={() => handleAudit(acc.id, auditUI.key)}
                      className={`${auditUI.buttonColor} text-white px-3 py-1.5 rounded text-xs font-medium`}
                    >
                      {auditUI.label} Audit
                    </button>
                  ))}
                  <button
                    onClick={() => handleDelete(acc.id)}
                    className="border border-red-200 text-red-600 px-3 py-1.5 rounded text-xs font-medium hover:bg-red-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-100 flex justify-end">
                <button
                  onClick={() => handleAudit(acc.id, "full")}
                  className="bg-gradient-to-r from-blue-600 to-purple-600 text-white px-4 py-2 rounded text-sm font-medium hover:from-blue-700 hover:to-purple-700 transition-all"
                >
                  Full Audit — Run All Services
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
