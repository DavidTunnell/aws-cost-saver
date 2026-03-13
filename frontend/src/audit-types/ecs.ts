import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "ecs",
  label: "ECS/Fargate",
  resourceNoun: "services",
  buttonColor: "bg-teal-600 hover:bg-teal-700",
  badgeStyle: "bg-teal-50 text-teal-700 border-teal-200",
  categoryLabels: {
    "ecs-idle-service": "Idle Service",
    "ecs-over-provisioned-cpu": "Over-Provisioned CPU",
    "ecs-over-provisioned-memory": "Over-Provisioned Memory",
    "ecs-fargate-spot-candidate": "Fargate Spot Candidate",
    "ecs-graviton-migration": "Graviton Migration",
    "ecs-stopped-service": "Stopped Service",
    "ecs-over-provisioned-desired-count": "Over-Provisioned Task Count",
    "ecs-right-size-tasks": "Right-Size Tasks",
    "ecs-scheduling": "Scheduling Optimization",
    "ecs-consolidation": "Service Consolidation",
    "ecs-architecture": "Architecture Optimization",
  },
});
