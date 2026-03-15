import { useState, useEffect, useCallback } from "react";
import { useDarkMode } from "../hooks/useDarkMode";
import { getAccounts, getCostTrends, type Account, type AccountCostTrend } from "../api";
import CostChart from "../components/CostChart";
import TrendFilters from "../components/TrendFilters";

export default function CostTrends() {
  const [isDark] = useDarkMode();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<number>>(new Set());
  const [months, setMonths] = useState(12);
  const [service, setService] = useState("");
  const [trendData, setTrendData] = useState<AccountCostTrend[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load accounts on mount
  useEffect(() => {
    getAccounts()
      .then((accts) => {
        setAccounts(accts);
        setSelectedAccountIds(new Set(accts.map((a) => a.id)));
      })
      .catch((err) => setError(err.message));
  }, []);

  // Fetch cost trends when filters change
  const fetchTrends = useCallback(async () => {
    if (accounts.length === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await getCostTrends(months, service || undefined);
      setTrendData(resp.accounts);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [accounts.length, months, service]);

  useEffect(() => {
    fetchTrends();
  }, [fetchTrends]);

  const handleAccountToggle = (id: number) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Transform API data into the flat shape Recharts expects
  const visibleAccounts = trendData.filter((a) => selectedAccountIds.has(a.accountId));

  const allMonths = new Set<string>();
  for (const account of visibleAccounts) {
    for (const dp of account.dataPoints) {
      allMonths.add(dp.month);
    }
  }

  const sortedMonths = Array.from(allMonths).sort();

  const chartData = sortedMonths.map((month) => {
    const row: Record<string, string | number> = { month };
    for (const account of visibleAccounts) {
      const dp = account.dataPoints.find((d) => d.month === month);
      row[account.accountName] = dp ? Math.round(dp.cost * 100) / 100 : 0;
    }
    return row;
  });

  const chartAccounts = visibleAccounts.map((a) => ({
    id: a.accountId,
    name: a.accountName,
  }));

  // Accounts with errors
  const errorAccounts = trendData.filter((a) => a.error);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Cost Trends</h2>
        {!loading && (
          <button
            onClick={fetchTrends}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            Refresh
          </button>
        )}
      </div>

      {accounts.length === 0 && !loading ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <p className="text-lg mb-2">No accounts connected</p>
          <p className="text-sm">Add an AWS account on the Accounts page to see cost trends.</p>
        </div>
      ) : (
        <>
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 mb-6">
            <TrendFilters
              months={months}
              onMonthsChange={setMonths}
              accounts={accounts}
              selectedAccountIds={selectedAccountIds}
              onAccountToggle={handleAccountToggle}
              service={service}
              onServiceChange={setService}
            />
          </div>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 p-3 rounded mb-4 text-sm">
              {error}
            </div>
          )}

          {errorAccounts.length > 0 && (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-yellow-700 dark:text-yellow-300 p-3 rounded mb-4 text-sm">
              <strong>Some accounts failed:</strong>
              <ul className="mt-1 list-disc list-inside">
                {errorAccounts.map((a) => (
                  <li key={a.accountId}>
                    {a.accountName}: {a.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            {loading ? (
              <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">
                <svg className="animate-spin h-6 w-6 mr-2" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Loading cost data...
              </div>
            ) : (
              <CostChart data={chartData} accounts={chartAccounts} isDark={isDark} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
