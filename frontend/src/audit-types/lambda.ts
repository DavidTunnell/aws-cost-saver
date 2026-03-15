import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "lambda",
  label: "Lambda",
  resourceNoun: "functions",
  buttonColor: "bg-amber-600 hover:bg-amber-700",
  badgeStyle: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800",
  categoryLabels: {
    "lambda-unused-function": "Unused Function",
    "lambda-overprovisioned-memory": "Overprovisioned Memory",
    "lambda-excessive-timeout": "Excessive Timeout",
    "lambda-old-runtime": "Deprecated Runtime",
    "lambda-no-arm64": "ARM64 Migration",
    "lambda-excessive-versions": "Excessive Versions",
    "lambda-provisioned-concurrency-waste": "Provisioned Concurrency Waste",
    "lambda-right-size-memory": "Right-Size Memory",
    "lambda-consolidate": "Function Consolidation",
    "lambda-scheduling": "Scheduling Optimization",
    "lambda-architecture": "Architecture Optimization",
  },
});
