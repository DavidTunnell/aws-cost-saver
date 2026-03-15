import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "elb",
  label: "Load Balancers",
  resourceNoun: "load balancers",
  buttonColor: "bg-purple-600 hover:bg-purple-700",
  badgeStyle: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-800",
  categoryLabels: {
    "elb-idle": "Idle Load Balancer",
    "elb-low-traffic": "Low Traffic",
    "elb-no-targets": "No Targets",
    "elb-classic-migrate": "Classic LB Migration",
    "elb-single-az": "Single AZ",
    "elb-orphaned-target-group": "Orphaned Target Group",
    "elb-consolidation": "Consolidation Opportunity",
    "elb-architecture": "Architecture Optimization",
    "elb-scheduling": "Scheduling Opportunity",
  },
});
