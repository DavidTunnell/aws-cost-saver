import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "opensearch",
  label: "OpenSearch",
  resourceNoun: "domains",
  buttonColor: "bg-rose-600 hover:bg-rose-700",
  badgeStyle: "bg-rose-50 text-rose-700 border-rose-200",
  categoryLabels: {
    "os-idle-domain": "Idle Domain",
    "os-over-provisioned-cpu": "Over-Provisioned CPU",
    "os-over-provisioned-jvm": "Over-Provisioned JVM",
    "os-over-provisioned-storage": "Over-Provisioned Storage",
    "os-gp2-to-gp3": "GP2 → GP3 Migration",
    "os-graviton-migration": "Graviton Migration",
    "os-generation-upgrade": "Generation Upgrade",
    "os-dedicated-master-oversized": "Oversized Dedicated Masters",
    "os-single-az": "Single AZ Risk",
    "os-right-size": "Right-Size Instance",
    "os-reserved-instance": "Reserved Instance",
    "os-architecture": "Architecture Optimization",
    "os-consolidation": "Domain Consolidation",
    "os-scheduling": "Scheduling Optimization",
  },
});
