import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

const COLORS = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#f97316",
  "#14b8a6", "#6366f1",
];

interface AccountLine {
  id: number;
  name: string;
}

interface CostChartProps {
  /** Flat data: one object per month, with keys for each account name holding the cost */
  data: Record<string, string | number>[];
  accounts: AccountLine[];
  isDark: boolean;
}

function formatMonth(value: string) {
  if (!value) return "";
  const [year, month] = value.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(month, 10) - 1]} '${year.slice(2)}`;
}

function formatDollar(value: number) {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export default function CostChart({ data, accounts, isDark }: CostChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">
        No cost data available
      </div>
    );
  }

  const axisColor = isDark ? "#9ca3af" : "#6b7280";
  const gridColor = isDark ? "#374151" : "#e5e7eb";

  return (
    <ResponsiveContainer width="100%" height={400}>
      <LineChart data={data} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis
          dataKey="month"
          tickFormatter={formatMonth}
          tick={{ fill: axisColor, fontSize: 12 }}
          stroke={gridColor}
        />
        <YAxis
          tickFormatter={formatDollar}
          tick={{ fill: axisColor, fontSize: 12 }}
          stroke={gridColor}
        />
        <Tooltip
          formatter={(value) => [formatDollar(Number(value)), undefined]}
          labelFormatter={(label) => formatMonth(String(label))}
          contentStyle={{
            backgroundColor: isDark ? "#1f2937" : "#ffffff",
            border: `1px solid ${isDark ? "#374151" : "#e5e7eb"}`,
            borderRadius: "0.375rem",
            color: isDark ? "#f3f4f6" : "#111827",
          }}
        />
        <Legend />
        {accounts.map((account, i) => (
          <Line
            key={account.id}
            type="monotone"
            dataKey={account.name}
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
