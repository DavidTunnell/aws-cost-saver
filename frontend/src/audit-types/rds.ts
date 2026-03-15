import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "rds",
  label: "RDS",
  resourceNoun: "databases",
  buttonColor: "bg-purple-600 hover:bg-purple-700",
  badgeStyle: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-800",
  categoryLabels: {
    "rds-idle": "Idle Database",
    "rds-snapshot-cleanup": "RDS Snapshot Cleanup",
    "rds-old-generation": "RDS Generation Upgrade",
    "rds-gp2-to-gp3": "GP2 \u2192 GP3 Storage",
    "rds-multi-az-dev": "Multi-AZ Non-Prod",
    "rds-stopped-cost": "Stopped Database",
    "rds-overprovisioned-storage": "Overprovisioned Storage",
    "rds-backup-retention": "Backup Retention",
    "rds-right-size": "RDS Right-Size",
    "rds-reserved-instance": "RDS Reserved Instance",
    "rds-aurora-migration": "Aurora Migration",
    "rds-extended-support": "Extended Support Surcharge",
    "rds-iops-overprovisioned": "IOPS Overprovisioned",
    "rds-cluster-snapshot-cleanup": "Cluster Snapshot Cleanup",
    "rds-read-replica-underused": "Underused Read Replica",
    "rds-serverless-migration": "Serverless Migration",
  },
});
