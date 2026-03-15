import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "full",
  label: "Full Audit",
  resourceNoun: "resources",
  buttonColor: "bg-gradient-to-r from-blue-600 to-purple-600",
  badgeStyle: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-800",
  categoryLabels: {
    "cross-service": "Cross-Service Opportunity",
  },
});
