import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "dynamodb",
  label: "DynamoDB",
  resourceNoun: "tables",
  buttonColor: "bg-indigo-600 hover:bg-indigo-700",
  badgeStyle: "bg-indigo-50 text-indigo-700 border-indigo-200",
  categoryLabels: {
    "dynamodb-unused-table": "Unused Table",
    "dynamodb-over-provisioned-rcu": "Over-Provisioned RCU",
    "dynamodb-over-provisioned-wcu": "Over-Provisioned WCU",
    "dynamodb-switch-to-on-demand": "Switch to On-Demand",
    "dynamodb-switch-to-provisioned": "Switch to Provisioned",
    "dynamodb-infrequent-access": "Infrequent Access",
    "dynamodb-pitr-review": "PITR Review",
    "dynamodb-optimize-gsi": "GSI Optimization",
    "dynamodb-ttl-suggestion": "TTL Suggestion",
    "dynamodb-caching": "DAX Caching",
    "dynamodb-architecture": "Architecture Optimization",
  },
});
