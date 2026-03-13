import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "ec2",
  label: "EC2",
  resourceNoun: "instances",
  buttonColor: "bg-green-600 hover:bg-green-700",
  badgeStyle: "bg-green-50 text-green-700 border-green-200",
  categoryLabels: {
    "right-size": "Right-Size",
    stop: "Stop/Terminate",
    "generation-upgrade": "Upgrade Generation",
    "reserved-instance": "Reserved Instance",
    "savings-plan": "Savings Plan",
    "unused-eip": "Unused EIP",
    "orphan-ebs": "Orphan EBS",
    idle: "Idle Instance",
    "ebs-optimize": "EBS Optimize",
    "graviton-migrate": "Graviton Migration",
    "schedule-stop": "Schedule Stop",
    "snapshot-cleanup": "Snapshot Cleanup",
  },
});
