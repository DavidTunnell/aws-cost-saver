import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "opensearch",
  label: "OpenSearch",
  resourceNoun: "domains",
  buttonColor: "bg-teal-600 hover:bg-teal-700",
  badgeStyle: "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-800",
  categoryLabels: {
    "opensearch-idle": "Idle Domain",
    "opensearch-underutilized": "Underutilized",
    "opensearch-oversized-storage": "Oversized Storage",
    "opensearch-old-engine": "Outdated Engine",
    "opensearch-no-reserved": "No Reserved Instance",
    "opensearch-single-az": "Single AZ",
    "opensearch-unnecessary-master": "Unnecessary Master Nodes",
    "opensearch-gp2-to-gp3": "GP2 to GP3 Migration",
    "opensearch-warm-cold-candidate": "Warm/Cold Tier Candidate",
    "opensearch-graviton-migration": "Graviton Migration",
    "opensearch-overprovisioned-iops": "Overprovisioned IOPS",
    "opensearch-node-consolidation": "Node Consolidation",
    "opensearch-jvm-pressure": "JVM Memory Pressure",
    "opensearch-cluster-health": "Cluster Health",
  },
});
