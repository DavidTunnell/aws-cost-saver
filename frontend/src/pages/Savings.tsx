import { useState, useEffect, useCallback } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  getAccounts,
  getCostTrends,
  getAccountServices,
  type Account,
  type CostTrendData,
  type ServiceInfo,
} from "../api";

// ─── Color palette for services ───────────────────────────────────────────
const SERVICE_COLORS = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
  "#84cc16", // lime
  "#6366f1", // indigo
  "#14b8a6", // teal
  "#e11d48", // rose
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatMonth(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

function formatDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatCurrency(val: number): string {
  if (val >= 1000) return `$${(val / 1000).toFixed(1)}k`;
  return `$${val.toFixed(0)}`;
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-medium text-gray-900 dark:text-gray-100 mb-2">{label}</p>
      {payload
        .filter((p: any) => p.value > 0)
        .sort((a: any, b: any) => b.value - a.value)
        .map((p: any) => (
          <div key={p.dataKey} className="flex justify-between gap-4 text-gray-700 dark:text-gray-300">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: p.color }} />
              {p.dataKey === "totalCost" ? "Total" : p.dataKey}
            </span>
            <span className="font-mono">${p.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
        ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────

export default function Savings() {
  // State
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [months, setMonths] = useState(6);
  const [granularity, setGranularity] = useState<"MONTHLY" | "DAILY">("MONTHLY");
  const [viewMode, setViewMode] = useState<"total" | "byService">("total");
  const [trendData, setTrendData] = useState<CostTrendData | null>(null);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load accounts on mount
  useEffect(() => {
    getAccounts().then((accts) => {
      setAccounts(accts);
      if (accts.length > 0 && !selectedAccountId) {
        setSelectedAccountId(accts[0].id);
      }
    }).catch((err) => setError(err.message));
  }, []);

  // Load services when account changes
  useEffect(() => {
    if (!selectedAccountId) return;
    getAccountServices(selectedAccountId)
      .then((data) => {
        setServices(data.services);
        setSelectedServices([]); // reset filter
      })
      .catch(() => setServices([]));
  }, [selectedAccountId]);

  // Fetch cost trends when filters change
  const fetchTrends = useCallback(async () => {
    if (!selectedAccountId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getCostTrends(
        selectedAccountId,
        months,
        granularity,
        selectedServices.length > 0 ? selectedServices : undefined
      );
      setTrendData(data);
    } catch (err: any) {
      setError(err.message);
      setTrendData(null);
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId, months, granularity, selectedServices]);

  useEffect(() => {
    fetchTrends();
  }, [fetchTrends]);

  // ─── Derived data ─────────────────────────────────────────────────────

  // Get all unique services across all periods for stacked chart
  const allServices = trendData
    ? [...new Set(trendData.periods.flatMap((p) => Object.keys(p.byService)))]
        .sort((a, b) => {
          const totalA = trendData.periods.reduce((sum, p) => sum + (p.byService[a] || 0), 0);
          const totalB = trendData.periods.reduce((sum, p) => sum + (p.byService[b] || 0), 0);
          return totalB - totalA;
        })
    : [];

  // Build chart data
  const chartData = trendData?.periods.map((p) => ({
    name: granularity === "DAILY" ? formatDay(p.start) : formatMonth(p.start),
    totalCost: p.totalCost,
    ...p.byService,
  })) || [];

  // Summary metrics
  const currentPeriod = trendData?.periods[trendData.periods.length - 1];
  const previousPeriod = trendData?.periods.length && trendData.periods.length >= 2
    ? trendData.periods[trendData.periods.length - 2]
    : null;
  const currentCost = currentPeriod?.totalCost || 0;
  const previousCost = previousPeriod?.totalCost || 0;
  const costChange = previousCost > 0 ? currentCost - previousCost : 0;
  const costChangePct = previousCost > 0 ? (costChange / previousCost) * 100 : 0;

  // Total across all periods
  const totalCost = trendData?.periods.reduce((sum, p) => sum + p.totalCost, 0) || 0;

  // Toggle service filter
  const toggleService = (service: string) => {
    setSelectedServices((prev) =>
      prev.includes(service)
        ? prev.filter((s) => s !== service)
        : [...prev, service]
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Savings Report
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Track AWS spending trends to measure the impact of cost optimizations
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* Account selector */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Account
            </label>
            <select
              value={selectedAccountId || ""}
              onChange={(e) => setSelectedAccountId(parseInt(e.target.value, 10))}
              className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} {a.aws_account_id ? `(${a.aws_account_id})` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Date range */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Range
            </label>
            <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600">
              {[3, 6, 12].map((m) => (
                <button
                  key={m}
                  onClick={() => setMonths(m)}
                  className={`px-3 py-2 text-sm font-medium transition-colors ${
                    months === m
                      ? "bg-blue-600 text-white"
                      : "bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600"
                  }`}
                >
                  {m}mo
                </button>
              ))}
            </div>
          </div>

          {/* Granularity */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Granularity
            </label>
            <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600">
              {(["MONTHLY", "DAILY"] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => setGranularity(g)}
                  className={`px-3 py-2 text-sm font-medium transition-colors ${
                    granularity === g
                      ? "bg-blue-600 text-white"
                      : "bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600"
                  }`}
                >
                  {g === "MONTHLY" ? "Monthly" : "Daily"}
                </button>
              ))}
            </div>
          </div>

          {/* View mode */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              View
            </label>
            <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600">
              {(["total", "byService"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setViewMode(v)}
                  className={`px-3 py-2 text-sm font-medium transition-colors ${
                    viewMode === v
                      ? "bg-blue-600 text-white"
                      : "bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600"
                  }`}
                >
                  {v === "total" ? "Total" : "By Service"}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Service filter chips */}
        {services.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-2 border-t border-gray-100 dark:border-gray-700">
            <span className="text-xs text-gray-500 dark:text-gray-400 self-center mr-1">Filter:</span>
            {services.slice(0, 12).map((s) => (
              <button
                key={s.name}
                onClick={() => toggleService(s.name)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  selectedServices.includes(s.name)
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 ring-1 ring-blue-300 dark:ring-blue-700"
                    : selectedServices.length === 0
                    ? "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
                    : "bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
              >
                {s.name.replace("Amazon ", "").replace("AWS ", "")}
              </button>
            ))}
            {selectedServices.length > 0 && (
              <button
                onClick={() => setSelectedServices([])}
                className="px-2.5 py-1 rounded-full text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-xl p-4 text-sm">
          {error}
        </div>
      )}

      {/* Summary cards */}
      {trendData && !loading && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Latest Period
            </p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">
              ${currentCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            {previousCost > 0 && (
              <p className={`text-sm mt-1 font-medium ${costChange < 0 ? "text-green-600 dark:text-green-400" : costChange > 0 ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}>
                {costChange < 0 ? "↓" : costChange > 0 ? "↑" : "→"}{" "}
                ${Math.abs(costChange).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{" "}
                ({costChangePct > 0 ? "+" : ""}{costChangePct.toFixed(1)}%)
              </p>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {months}-Month Total
            </p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">
              ${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Avg ${(totalCost / (trendData.periods.length || 1)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/period
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Top Service
            </p>
            {currentPeriod && Object.keys(currentPeriod.byService).length > 0 ? (
              <>
                <p className="text-lg font-bold text-gray-900 dark:text-gray-100 mt-1 truncate">
                  {Object.entries(currentPeriod.byService)
                    .sort((a, b) => b[1] - a[1])[0]?.[0]
                    ?.replace("Amazon ", "")
                    .replace("AWS ", "")}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  ${Object.entries(currentPeriod.byService)
                    .sort((a, b) => b[1] - a[1])[0]?.[1]
                    ?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/period
                </p>
              </>
            ) : (
              <p className="text-lg text-gray-400 dark:text-gray-500 mt-1">—</p>
            )}
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
        {loading ? (
          <div className="flex items-center justify-center h-80">
            <div className="flex items-center gap-3 text-gray-500 dark:text-gray-400">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Loading cost data...
            </div>
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center h-80 text-gray-400 dark:text-gray-500">
            {accounts.length === 0
              ? "No accounts configured. Add an account to view cost trends."
              : "No cost data available for the selected filters."}
          </div>
        ) : (
          <>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
              {trendData?.accountName} — {granularity === "MONTHLY" ? "Monthly" : "Daily"} Cost Trend
            </h3>
            <ResponsiveContainer width="100%" height={400}>
              <AreaChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <defs>
                  {viewMode === "total" ? (
                    <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  ) : (
                    allServices.slice(0, 12).map((service, i) => (
                      <linearGradient key={service} id={`color${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={SERVICE_COLORS[i % SERVICE_COLORS.length]} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={SERVICE_COLORS[i % SERVICE_COLORS.length]} stopOpacity={0} />
                      </linearGradient>
                    ))
                  )}
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: "currentColor", fontSize: 12 }}
                  className="text-gray-500 dark:text-gray-400"
                />
                <YAxis
                  tickFormatter={formatCurrency}
                  tick={{ fill: "currentColor", fontSize: 12 }}
                  className="text-gray-500 dark:text-gray-400"
                />
                <Tooltip content={<CustomTooltip />} />
                {viewMode === "total" ? (
                  <Area
                    type="monotone"
                    dataKey="totalCost"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    fill="url(#colorTotal)"
                    name="Total Cost"
                  />
                ) : (
                  allServices.slice(0, 12).map((service, i) => (
                    <Area
                      key={service}
                      type="monotone"
                      dataKey={service}
                      stackId="1"
                      stroke={SERVICE_COLORS[i % SERVICE_COLORS.length]}
                      strokeWidth={1}
                      fill={`url(#color${i})`}
                      name={service.replace("Amazon ", "").replace("AWS ", "")}
                    />
                  ))
                )}
                {viewMode === "byService" && (
                  <Legend
                    wrapperStyle={{ fontSize: 11 }}
                    formatter={(value: string) => value.replace("Amazon ", "").replace("AWS ", "")}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </>
        )}
      </div>

      {/* Service breakdown table aggregated across selected range */}
      {trendData && !loading && trendData.periods.length > 0 && (() => {
        // Aggregate service costs across all periods in the selected range
        const aggregatedServices: Record<string, number> = {};
        for (const period of trendData.periods) {
          for (const [service, cost] of Object.entries(period.byService)) {
            aggregatedServices[service] = (aggregatedServices[service] || 0) + cost;
          }
        }
        const entries = Object.entries(aggregatedServices).sort((a, b) => b[1] - a[1]);
        if (entries.length === 0) return null;
        return (
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
              Service Breakdown — {months}-Month Total (${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
            </h3>
            <div className="space-y-2">
              {entries.map(([service, cost]) => {
                const pct = totalCost > 0 ? (cost / totalCost) * 100 : 0;
                return (
                  <div key={service} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-700 dark:text-gray-300 truncate">
                          {service.replace("Amazon ", "").replace("AWS ", "")}
                        </span>
                        <span className="text-gray-900 dark:text-gray-100 font-mono font-medium ml-4">
                          ${cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-1.5">
                        <div
                          className="bg-blue-500 dark:bg-blue-400 h-1.5 rounded-full transition-all"
                          style={{ width: `${Math.max(pct, 0.5)}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400 w-12 text-right">
                      {pct.toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
