import { useState, useEffect } from "react";

interface SavingsFilterProps {
  defaultThreshold?: number;
  onThresholdChange: (threshold: number) => void;
}

export default function SavingsFilter({
  defaultThreshold = 1,
  onThresholdChange,
}: SavingsFilterProps) {
  const [value, setValue] = useState(String(defaultThreshold));

  useEffect(() => {
    const num = parseFloat(value);
    onThresholdChange(isNaN(num) ? 0 : Math.max(0, num));
  }, [value, onThresholdChange]);

  return (
    <div className="flex items-center gap-3 mb-4">
      <label className="text-sm text-gray-600 flex items-center gap-1">
        Min savings:
        <span className="text-gray-400">$</span>
        <input
          type="number"
          min="0"
          step="0.5"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-20 border border-gray-300 rounded px-2 py-1 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
      </label>
      {parseFloat(value) !== defaultThreshold && (
        <button
          onClick={() => setValue(String(defaultThreshold))}
          className="text-xs text-blue-600 hover:underline"
        >
          Reset
        </button>
      )}
    </div>
  );
}
