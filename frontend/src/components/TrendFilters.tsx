import type { Account } from "../api";

const MONTH_OPTIONS = [3, 6, 12, 24];
const SERVICE_OPTIONS = [
  { value: "", label: "All Services" },
  { value: "EC2", label: "EC2" },
  { value: "RDS", label: "RDS" },
  { value: "S3", label: "S3" },
  { value: "Lambda", label: "Lambda" },
  { value: "DynamoDB", label: "DynamoDB" },
  { value: "ELB", label: "ELB" },
];

interface TrendFiltersProps {
  months: number;
  onMonthsChange: (m: number) => void;
  accounts: Account[];
  selectedAccountIds: Set<number>;
  onAccountToggle: (id: number) => void;
  service: string;
  onServiceChange: (s: string) => void;
}

export default function TrendFilters({
  months,
  onMonthsChange,
  accounts,
  selectedAccountIds,
  onAccountToggle,
  service,
  onServiceChange,
}: TrendFiltersProps) {
  return (
    <div className="space-y-4">
      {/* Time range */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Time Range:</span>
        <div className="flex gap-1">
          {MONTH_OPTIONS.map((m) => (
            <button
              key={m}
              onClick={() => onMonthsChange(m)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                months === m
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              {m}mo
            </button>
          ))}
        </div>

        {/* Service filter */}
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300 ml-4">Service:</span>
        <select
          value={service}
          onChange={(e) => onServiceChange(e.target.value)}
          className="text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 px-2 py-1"
        >
          {SERVICE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Account selection */}
      {accounts.length > 1 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Accounts:</span>
          {accounts.map((account) => (
            <label
              key={account.id}
              className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selectedAccountIds.has(account.id)}
                onChange={() => onAccountToggle(account.id)}
                className="rounded border-gray-300 dark:border-gray-600"
              />
              {account.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
