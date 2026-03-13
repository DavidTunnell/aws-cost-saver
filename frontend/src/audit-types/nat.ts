import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "nat",
  label: "NAT Gateway",
  resourceNoun: "gateways",
  buttonColor: "bg-orange-600 hover:bg-orange-700",
  badgeStyle: "bg-orange-50 text-orange-700 border-orange-200",
  categoryLabels: {
    "nat-idle": "Idle NAT Gateway",
    "nat-low-utilization": "Low Utilization",
    "nat-no-vpc-endpoint": "Missing VPC Endpoint",
    "nat-redundant-az": "Redundant Gateways",
    "nat-high-error-rate": "High Error Rate",
    "nat-architecture-optimize": "Architecture Optimization",
    "nat-traffic-pattern": "Traffic Pattern",
  },
});
