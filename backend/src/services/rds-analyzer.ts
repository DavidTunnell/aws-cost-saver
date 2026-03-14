import Anthropic from "@anthropic-ai/sdk";
import type { RDSCollectedData, RDSInstanceData } from "../aws/rds-collector";
import type { Recommendation } from "./analyzer";
import { buildMetadata } from "./analyzer";

// Re-export for convenience
export type { Recommendation };

// ─── Deterministic helpers ──────────────────────────────────────────────────

function getSeverity(savings: number): "high" | "medium" | "low" {
  if (savings > 50) return "high";
  if (savings >= 10) return "medium";
  return "low";
}

const OLD_GEN_RDS_FAMILIES = new Set([
  "db.m1", "db.m2", "db.m3", "db.m4",
  "db.r3", "db.r4",
  "db.t2",
  "db.cr1",
]);

function getRDSInstanceFamily(dbInstanceClass: string): string {
  // db.m5.large → "db.m5"
  const parts = dbInstanceClass.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : dbInstanceClass;
}

function isNonProdTag(tags: Record<string, string>): boolean {
  const envTag = (
    tags["Environment"] || tags["Env"] || tags["env"] || tags["environment"] || ""
  ).toLowerCase();
  return /^(dev|test|staging|development|qa|sandbox)$/.test(envTag);
}

// ─── Extended Support EOL lookup ────────────────────────────────────────────

interface EngineEOL {
  eolDate: string; // ISO date when standard support ended
  rates: [number, number, number]; // $/vCPU-hr for Year 1, 2, 3+
}

const ENGINE_EOL: Record<string, EngineEOL> = {
  "mysql:5.7":             { eolDate: "2024-02-01", rates: [0.10, 0.20, 0.25] },
  "postgres:11":           { eolDate: "2024-02-01", rates: [0.10, 0.20, 0.25] },
  "postgres:12":           { eolDate: "2025-02-01", rates: [0.10, 0.20, 0.25] },
  "postgres:13":           { eolDate: "2026-02-01", rates: [0.10, 0.20, 0.25] },
  "aurora-mysql:5.7":      { eolDate: "2024-10-01", rates: [0.10, 0.20, 0.25] },
  "aurora-postgresql:11":  { eolDate: "2024-02-01", rates: [0.10, 0.20, 0.25] },
  "aurora-postgresql:12":  { eolDate: "2025-02-01", rates: [0.10, 0.20, 0.25] },
  "aurora-postgresql:13":  { eolDate: "2026-02-01", rates: [0.10, 0.20, 0.25] },
};

function getExtendedSupportRate(engine: string, engineVersion: string): { rate: number; year: number } | null {
  // Extract major version: "5.7.44" → "5.7", "11.22" → "11", "13.14" → "13"
  const parts = engineVersion.split(".");
  const majorVersion = engine.includes("mysql") ? `${parts[0]}.${parts[1]}` : parts[0];

  // Normalize engine name for Aurora
  let engineKey = engine;
  if (engine === "aurora-mysql" || engine === "aurora") engineKey = "aurora-mysql";
  if (engine === "aurora-postgresql") engineKey = "aurora-postgresql";

  const eol = ENGINE_EOL[`${engineKey}:${majorVersion}`];
  if (!eol) return null;

  const eolDate = new Date(eol.eolDate).getTime();
  const now = Date.now();
  if (now < eolDate) return null; // Still in standard support

  const yearsAfterEol = (now - eolDate) / (365.25 * 24 * 60 * 60 * 1000);
  const yearIndex = Math.min(2, Math.floor(yearsAfterEol)); // 0, 1, or 2 (capped at Year 3 rate)
  return { rate: eol.rates[yearIndex], year: yearIndex + 1 };
}

// ─── vCPU count from instance class ─────────────────────────────────────────

const VCPU_BY_SIZE: Record<string, number> = {
  micro: 1, small: 1, medium: 1,
  large: 2, xlarge: 4,
  "2xlarge": 8, "4xlarge": 16, "8xlarge": 32,
  "12xlarge": 48, "16xlarge": 64, "24xlarge": 96,
};

function getVCPUCount(dbInstanceClass: string): number {
  // "db.r5.2xlarge" → size = "2xlarge"
  const parts = dbInstanceClass.split(".");
  const size = parts[parts.length - 1];
  return VCPU_BY_SIZE[size] ?? 2; // conservative fallback
}

// ─── Deterministic recommendations (8 categories) ──────────────────────────

function generateRDSDeterministicRecs(data: RDSCollectedData): Recommendation[] {
  const recs: Recommendation[] = [];

  // 1. rds-idle: Zero database connections over the monitoring period
  for (const inst of data.instances) {
    if (inst.status !== "available") continue;
    if (inst.databaseConnectionsMax !== null && inst.databaseConnectionsMax === 0) {
      const savings = inst.totalMonthlyEstimate;
      if (savings <= 0) continue;
      recs.push({
        instanceId: inst.dbInstanceId,
        instanceName: inst.name,
        instanceType: inst.dbInstanceClass,
        category: "rds-idle",
        severity: getSeverity(savings),
        currentMonthlyCost: savings,
        estimatedSavings: savings,
        action: `Stop or delete idle RDS instance ${inst.dbInstanceId} (${inst.engine}) — zero connections in 14 days`,
        reasoning: `No database connections detected over the monitoring period. Instance + storage costs $${savings.toFixed(2)}/mo with no usage.`,
        metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: inst.dbInstanceArn, resourceId: inst.dbiResourceId, engine: inst.engine, engineVersion: inst.engineVersion, storageType: inst.storageType, multiAZ: String(inst.multiAZ) }),
      });
    }
  }

  // 2. rds-snapshot-cleanup: Manual snapshots older than 90 days
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  for (const snap of data.manualSnapshots) {
    const snapTime = new Date(snap.snapshotCreateTime).getTime();
    if (now - snapTime < ninetyDaysMs) continue;
    const cost = snap.monthlyCost;
    if (cost <= 0) continue;
    const costNote = snap.costIsActual ? "" : " (estimate based on allocated size; actual cost may be lower)";
    recs.push({
      instanceId: snap.dbSnapshotId,
      instanceName: `${snap.dbSnapshotId} (${snap.dbInstanceId})`,
      instanceType: "rds-snapshot",
      category: "rds-snapshot-cleanup",
      severity: getSeverity(cost),
      currentMonthlyCost: cost,
      estimatedSavings: cost,
      action: `Delete old manual snapshot ${snap.dbSnapshotId} (${snap.allocatedStorageGb}GB, ${snap.engine})`,
      reasoning: `Manual snapshot created ${snap.snapshotCreateTime} is over 90 days old, costing ~$${cost.toFixed(2)}/mo in backup storage.${costNote}`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: snap.dbSnapshotArn, engine: snap.engine, snapshotType: snap.snapshotType, createdAt: snap.snapshotCreateTime, storageGb: String(snap.allocatedStorageGb), sourceInstance: snap.dbInstanceId }),
    });
  }

  // 3. rds-old-generation: Old DB instance classes
  for (const inst of data.instances) {
    if (inst.status !== "available") continue;
    const family = getRDSInstanceFamily(inst.dbInstanceClass);
    if (!OLD_GEN_RDS_FAMILIES.has(family)) continue;
    const monthlyCost = inst.monthlyEstimate ?? 0;
    if (monthlyCost <= 0) continue;
    const savings = monthlyCost * 0.15;
    recs.push({
      instanceId: inst.dbInstanceId,
      instanceName: inst.name,
      instanceType: inst.dbInstanceClass,
      category: "rds-old-generation",
      severity: getSeverity(savings),
      currentMonthlyCost: inst.totalMonthlyEstimate,
      estimatedSavings: savings,
      action: `Upgrade ${inst.dbInstanceId} from ${inst.dbInstanceClass} to current generation (e.g., ${family.replace(/\d+/, "7")} equivalent)`,
      reasoning: `${inst.dbInstanceClass} is an old generation class. Current generation offers ~15% cost savings with better performance.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: inst.dbInstanceArn, resourceId: inst.dbiResourceId, engine: inst.engine, engineVersion: inst.engineVersion, storageType: inst.storageType, multiAZ: String(inst.multiAZ) }),
    });
  }

  // 4. rds-gp2-to-gp3: Storage type migration
  for (const inst of data.instances) {
    if (inst.storageType !== "gp2") continue;
    const savings = (0.115 - 0.08) * inst.allocatedStorageGb;
    if (savings <= 0) continue;
    recs.push({
      instanceId: inst.dbInstanceId,
      instanceName: inst.name,
      instanceType: `gp2 ${inst.allocatedStorageGb}GB`,
      category: "rds-gp2-to-gp3",
      severity: getSeverity(savings),
      currentMonthlyCost: inst.storageMonthlyPrice,
      estimatedSavings: savings,
      action: `Migrate ${inst.dbInstanceId} storage from gp2 to gp3 (${inst.allocatedStorageGb}GB)`,
      reasoning: `gp3 provides 3000 baseline IOPS at 30% lower storage cost, saving $${savings.toFixed(2)}/mo.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: inst.dbInstanceArn, resourceId: inst.dbiResourceId, engine: inst.engine, engineVersion: inst.engineVersion, storageType: inst.storageType, multiAZ: String(inst.multiAZ) }),
    });
  }

  // 5. rds-multi-az-dev: Multi-AZ on non-production instances
  for (const inst of data.instances) {
    if (!inst.multiAZ) continue;
    if (!isNonProdTag(inst.tags)) continue;
    const instanceCost = inst.monthlyEstimate ?? 0;
    if (instanceCost <= 0) continue;
    // Multi-AZ roughly doubles instance cost — savings = ~50% of current instance cost
    const savings = instanceCost * 0.5;
    recs.push({
      instanceId: inst.dbInstanceId,
      instanceName: inst.name,
      instanceType: inst.dbInstanceClass,
      category: "rds-multi-az-dev",
      severity: getSeverity(savings),
      currentMonthlyCost: inst.totalMonthlyEstimate,
      estimatedSavings: savings,
      action: `Disable Multi-AZ on non-production instance ${inst.dbInstanceId} (${inst.tags["Environment"] || inst.tags["Env"] || inst.tags["env"] || "dev/test"})`,
      reasoning: `Multi-AZ is enabled on a ${isNonProdTag(inst.tags) ? "non-production" : ""} instance. Disabling saves ~$${savings.toFixed(2)}/mo. Multi-AZ is typically unnecessary for dev/test/staging.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: inst.dbInstanceArn, resourceId: inst.dbiResourceId, engine: inst.engine, engineVersion: inst.engineVersion, storageType: inst.storageType, multiAZ: String(inst.multiAZ) }),
    });
  }

  // 6. rds-stopped-cost: Stopped RDS instances (auto-restart warning)
  for (const inst of data.instances) {
    if (inst.status !== "stopped") continue;
    const storageCost = inst.storageMonthlyPrice;
    if (storageCost <= 0) continue;
    recs.push({
      instanceId: inst.dbInstanceId,
      instanceName: inst.name,
      instanceType: inst.dbInstanceClass,
      category: "rds-stopped-cost",
      severity: getSeverity(storageCost),
      currentMonthlyCost: storageCost,
      estimatedSavings: storageCost,
      action: `Snapshot and delete stopped RDS instance ${inst.dbInstanceId} to eliminate $${storageCost.toFixed(2)}/mo storage cost`,
      reasoning: `Stopped RDS instance still incurs storage charges ($${storageCost.toFixed(2)}/mo). WARNING: AWS auto-restarts stopped RDS instances after 7 days. Consider taking a final snapshot and deleting.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: inst.dbInstanceArn, resourceId: inst.dbiResourceId, engine: inst.engine, engineVersion: inst.engineVersion, storageType: inst.storageType, multiAZ: String(inst.multiAZ) }),
    });
  }

  // 7. rds-overprovisioned-storage: >70% of allocated storage is free
  for (const inst of data.instances) {
    if (inst.status !== "available") continue;
    if (inst.freeStorageSpaceAvg == null || inst.allocatedStorageGb <= 0) continue;

    const freeStorageGb = inst.freeStorageSpaceAvg / (1024 * 1024 * 1024); // bytes → GB
    const usedGb = inst.allocatedStorageGb - freeStorageGb;
    const freePercent = freeStorageGb / inst.allocatedStorageGb;

    if (freePercent < 0.7) continue;

    // Suggest right-sized allocation with 30% headroom
    const suggestedGb = Math.max(20, Math.ceil(usedGb * 1.3)); // min 20GB
    if (suggestedGb >= inst.allocatedStorageGb) continue;

    const currentStorageCost = inst.storageMonthlyPrice;
    const newStorageCost =
      (currentStorageCost / inst.allocatedStorageGb) * suggestedGb;
    const savings = currentStorageCost - newStorageCost;
    if (savings <= 0) continue;

    recs.push({
      instanceId: inst.dbInstanceId,
      instanceName: inst.name,
      instanceType: `${inst.storageType} ${inst.allocatedStorageGb}GB`,
      category: "rds-overprovisioned-storage",
      severity: getSeverity(savings),
      currentMonthlyCost: currentStorageCost,
      estimatedSavings: savings,
      action: `Consider reducing allocated storage for ${inst.dbInstanceId} from ${inst.allocatedStorageGb}GB to ~${suggestedGb}GB (using ${usedGb.toFixed(0)}GB)`,
      reasoning: `Only ${((1 - freePercent) * 100).toFixed(0)}% of allocated storage is used (${usedGb.toFixed(0)}GB of ${inst.allocatedStorageGb}GB). Note: RDS does not support storage shrink — requires migration to new instance.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: inst.dbInstanceArn, resourceId: inst.dbiResourceId, engine: inst.engine, engineVersion: inst.engineVersion, storageType: inst.storageType, multiAZ: String(inst.multiAZ) }),
    });
  }

  // 8. rds-backup-retention: Excessive backup retention on non-prod
  for (const inst of data.instances) {
    if (inst.backupRetentionPeriod <= 14) continue;
    if (!isNonProdTag(inst.tags)) continue;

    // Estimate backup storage cost savings from reducing retention
    // Approximate: each day of retention ≈ allocatedStorageGb worth of backup
    const currentBackupGb = inst.allocatedStorageGb * inst.backupRetentionPeriod;
    const suggestedBackupGb = inst.allocatedStorageGb * 7;
    const savings = (currentBackupGb - suggestedBackupGb) * 0.095 / 30; // monthly estimate
    if (savings <= 1) continue; // Skip trivial savings

    recs.push({
      instanceId: inst.dbInstanceId,
      instanceName: inst.name,
      instanceType: inst.dbInstanceClass,
      category: "rds-backup-retention",
      severity: getSeverity(savings),
      currentMonthlyCost: (currentBackupGb * 0.095) / 30,
      estimatedSavings: savings,
      action: `Reduce backup retention for ${inst.dbInstanceId} from ${inst.backupRetentionPeriod} to 7 days`,
      reasoning: `Non-production instance has ${inst.backupRetentionPeriod}-day backup retention. Reducing to 7 days saves ~$${savings.toFixed(2)}/mo in backup storage costs.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: inst.dbInstanceArn, resourceId: inst.dbiResourceId, engine: inst.engine, engineVersion: inst.engineVersion, storageType: inst.storageType, multiAZ: String(inst.multiAZ) }),
    });
  }

  // 9. rds-extended-support: Engine versions past standard support incur surcharges
  for (const inst of data.instances) {
    if (inst.status !== "available" && inst.status !== "stopped") continue;
    const support = getExtendedSupportRate(inst.engine, inst.engineVersion);
    if (!support) continue;
    const vCPUs = getVCPUCount(inst.dbInstanceClass);
    const monthlySurcharge = vCPUs * support.rate * 730;
    if (monthlySurcharge <= 0) continue;
    recs.push({
      instanceId: inst.dbInstanceId,
      instanceName: inst.name,
      instanceType: `${inst.engine} ${inst.engineVersion}`,
      category: "rds-extended-support",
      severity: getSeverity(monthlySurcharge),
      currentMonthlyCost: monthlySurcharge,
      estimatedSavings: monthlySurcharge,
      action: `Upgrade ${inst.dbInstanceId} from ${inst.engine} ${inst.engineVersion} to a supported version to eliminate Extended Support charges`,
      reasoning: `Engine ${inst.engine} ${inst.engineVersion} is in Year ${support.year} of Extended Support at $${support.rate}/vCPU-hr. With ${vCPUs} vCPUs, this adds $${monthlySurcharge.toFixed(2)}/mo in surcharges.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: inst.dbInstanceArn, resourceId: inst.dbiResourceId, engine: inst.engine, engineVersion: inst.engineVersion, storageType: inst.storageType, multiAZ: String(inst.multiAZ) }),
    });
  }

  // 10. rds-iops-overprovisioned: io1/io2 with provisioned IOPS far exceeding actual usage
  for (const inst of data.instances) {
    if (inst.status !== "available") continue;
    if (inst.storageType !== "io1" && inst.storageType !== "io2") continue;
    if (!inst.provisionedIops || inst.provisionedIops <= 0) continue;

    const actualIOPS = (inst.readIOPSAvg ?? 0) + (inst.writeIOPSAvg ?? 0);
    if (actualIOPS >= inst.provisionedIops * 0.3) continue; // Using >30% of provisioned — OK

    const suggestedIops = Math.max(3000, Math.ceil(actualIOPS * 2)); // 2x actual, floor 3000
    if (suggestedIops >= inst.provisionedIops) continue;

    const wastedIops = inst.provisionedIops - suggestedIops;
    const savings = wastedIops * 0.10; // $0.10/IOPS/mo
    if (savings <= 0) continue;

    recs.push({
      instanceId: inst.dbInstanceId,
      instanceName: inst.name,
      instanceType: `${inst.storageType} ${inst.provisionedIops} IOPS`,
      category: "rds-iops-overprovisioned",
      severity: getSeverity(savings),
      currentMonthlyCost: inst.provisionedIops * 0.10,
      estimatedSavings: savings,
      action: `Reduce provisioned IOPS on ${inst.dbInstanceId} from ${inst.provisionedIops} to ~${suggestedIops} (or migrate to gp3 for baseline 3000 IOPS free)`,
      reasoning: `Actual IOPS usage averages ${actualIOPS.toFixed(0)} (${((actualIOPS / inst.provisionedIops) * 100).toFixed(0)}% of ${inst.provisionedIops} provisioned). ${wastedIops} excess IOPS cost $${savings.toFixed(2)}/mo.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: inst.dbInstanceArn, resourceId: inst.dbiResourceId, engine: inst.engine, engineVersion: inst.engineVersion, storageType: inst.storageType, multiAZ: String(inst.multiAZ) }),
    });
  }

  // 11. rds-cluster-snapshot-cleanup: Manual Aurora cluster snapshots older than 90 days
  if (data.clusterSnapshots) {
    for (const snap of data.clusterSnapshots) {
      const snapTime = new Date(snap.snapshotCreateTime).getTime();
      if (now - snapTime < ninetyDaysMs) continue;
      const cost = snap.monthlyCost;
      if (cost <= 0) continue;
      const costNote = snap.costIsActual ? "" : " (estimate based on allocated size; actual cost may be lower)";
      recs.push({
        instanceId: snap.dbClusterSnapshotId,
        instanceName: `${snap.dbClusterSnapshotId} (${snap.dbClusterIdentifier})`,
        instanceType: "aurora-cluster-snapshot",
        category: "rds-cluster-snapshot-cleanup",
        severity: getSeverity(cost),
        currentMonthlyCost: cost,
        estimatedSavings: cost,
        action: `Delete old manual cluster snapshot ${snap.dbClusterSnapshotId} (${snap.allocatedStorageGb}GB, ${snap.engine})`,
        reasoning: `Manual Aurora cluster snapshot created ${snap.snapshotCreateTime} is over 90 days old, costing ~$${cost.toFixed(2)}/mo in backup storage.${costNote}`,
        metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: snap.dbClusterSnapshotArn, engine: snap.engine, snapshotType: snap.snapshotType, createdAt: snap.snapshotCreateTime, storageGb: String(snap.allocatedStorageGb), sourceCluster: snap.dbClusterIdentifier }),
      });
    }
  }

  // 12. rds-read-replica-underused: Replicas with <10% of primary's ReadIOPS
  const instanceMap = new Map<string, RDSInstanceData>();
  for (const inst of data.instances) {
    instanceMap.set(inst.dbInstanceId, inst);
  }
  for (const inst of data.instances) {
    if (inst.status !== "available") continue;
    if (!inst.readReplicaSourceId) continue; // Not a replica

    const primary = instanceMap.get(inst.readReplicaSourceId);
    if (!primary) continue;
    if (primary.readIOPSAvg == null || inst.readIOPSAvg == null) continue;
    if (primary.readIOPSAvg <= 0) continue;

    const replicaReadRatio = inst.readIOPSAvg / primary.readIOPSAvg;
    if (replicaReadRatio >= 0.10) continue; // Using >10% of primary reads — OK

    const savings = inst.totalMonthlyEstimate;
    if (savings <= 0) continue;

    recs.push({
      instanceId: inst.dbInstanceId,
      instanceName: inst.name,
      instanceType: inst.dbInstanceClass,
      category: "rds-read-replica-underused",
      severity: getSeverity(savings),
      currentMonthlyCost: savings,
      estimatedSavings: savings,
      action: `Consider removing underused read replica ${inst.dbInstanceId} (replica of ${inst.readReplicaSourceId})`,
      reasoning: `Read replica handles only ${(replicaReadRatio * 100).toFixed(1)}% of primary's read IOPS (${inst.readIOPSAvg.toFixed(0)} vs ${primary.readIOPSAvg.toFixed(0)} on primary). Full replica cost is $${savings.toFixed(2)}/mo.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: inst.dbInstanceArn, resourceId: inst.dbiResourceId, engine: inst.engine, engineVersion: inst.engineVersion, storageType: inst.storageType, multiAZ: String(inst.multiAZ) }),
    });
  }

  return recs;
}

// ─── LLM-only prompt (judgment-based categories) ────────────────────────────

const RDS_SYSTEM_PROMPT = `You are an AWS cost optimization expert. Analyze RDS instance metrics and return JSON recommendations.

Return a JSON array of objects with these fields:
- instanceId (DBInstanceIdentifier), instanceName, instanceType (db instance class), category, severity ("high"/"medium"/"low"), currentMonthlyCost, estimatedSavings, action, reasoning

You ONLY analyze for these categories (all others are handled separately — do NOT generate them):
- "rds-right-size": CPU avg <15%, FreeableMemory > 70% of expected for class → suggest smaller instance class. Savings = 40% of on-demand estimate.
- "rds-reserved-instance": Consistent 24/7 usage (available, steady connections over weeks) → recommend RI. Savings = 40% of on-demand estimate.
- "rds-aurora-migration": MySQL or PostgreSQL on standard RDS (not already Aurora) with significant workload → suggest Aurora. Savings vary — estimate 20-30%.
- "rds-serverless-migration": Variable workloads (high peak-to-avg CPU ratio >5x, connection count varying >10x between avg and max, or very low avg CPU <10% with spikes) on MySQL/PostgreSQL → suggest Aurora Serverless v2. Savings = 30-60% for bursty workloads. Do NOT recommend for steady high-utilization instances.

Do NOT generate recommendations for: rds-idle, rds-snapshot-cleanup, rds-old-generation, rds-gp2-to-gp3, rds-multi-az-dev, rds-stopped-cost, rds-overprovisioned-storage, rds-backup-retention, rds-extended-support, rds-iops-overprovisioned, rds-cluster-snapshot-cleanup, rds-read-replica-underused. These are computed separately.

Severity: high (>$50/mo), medium ($10-50/mo), low (<$10/mo).
Do NOT double-count: if right-size and RI both apply, only recommend RI.
Return ONLY a JSON array. No markdown, no explanation outside the JSON.
If no recommendations, return [].`;

// ─── Main analysis function ─────────────────────────────────────────────────

export async function analyzeRDSWithClaude(
  data: RDSCollectedData
): Promise<Recommendation[]> {
  // Step 1: Deterministic recs
  const deterministicRecs = generateRDSDeterministicRecs(data);

  // Step 2: LLM recs for judgment-based categories (running instances only)
  const availableInstances = data.instances.filter((i) => i.status === "available");
  let llmRecs: Recommendation[] = [];

  if (availableInstances.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn("ANTHROPIC_API_KEY not set — skipping LLM analysis for RDS");
    } else {
      const client = new Anthropic({ apiKey });

      const CHUNK_SIZE = 25;
      if (availableInstances.length > CHUNK_SIZE) {
        llmRecs = await analyzeRDSLlmInChunks(client, data, CHUNK_SIZE);
      } else {
        const prompt = buildRDSPrompt(data);
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: RDS_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        });
        llmRecs = parseResponse(response);
      }
    }
  }

  // Enrich LLM recs with metadata and correct pricing from collector data
  const rdsInstanceMap = new Map(data.instances.map(i => [i.dbInstanceId, i]));
  for (const rec of llmRecs) {
    const inst = rdsInstanceMap.get(rec.instanceId);
    if (inst) {
      // Override LLM's currentMonthlyCost with actual known cost
      if (inst.totalMonthlyEstimate > 0) {
        const knownCost = inst.totalMonthlyEstimate;
        rec.currentMonthlyCost = knownCost;
        // Enforce deterministic savings formulas using the corrected cost
        if (rec.category === "rds-right-size") rec.estimatedSavings = knownCost * 0.40;
        else if (rec.category === "rds-reserved-instance") rec.estimatedSavings = knownCost * 0.40;
        else if (rec.category === "rds-aurora-migration") rec.estimatedSavings = knownCost * 0.25;
        // rds-serverless-migration: keep LLM value (30-60% range too wide), capped by self-cap
      }
      // Recalculate severity from corrected savings (LLM severity is unreliable)
      rec.severity = getSeverity(rec.estimatedSavings);
      rec.metadata = buildMetadata({
        region: data.region,
        accountId: data.accountId,
        arn: inst.dbInstanceArn,
        resourceId: inst.dbiResourceId,
        engine: inst.engine,
        engineVersion: inst.engineVersion,
        storageType: inst.storageType,
        multiAZ: String(inst.multiAZ),
      });
      // Show Aurora cluster storage cost (shared across members, not per-instance)
      if (inst.isAurora && inst.clusterStorageCostMonthly != null) {
        rec.metadata.clusterStorage = `${inst.clusterStorageGb}GB ($${inst.clusterStorageCostMonthly.toFixed(2)}/mo shared across ${inst.clusterMemberCount} members)`;
      }
    }
  }

  // Step 3: Merge — deterministic wins
  const merged = mergeRDSRecommendations(deterministicRecs, llmRecs);
  return deduplicateRDSRecommendations(merged);
}

// ─── LLM helpers ────────────────────────────────────────────────────────────

function mergeRDSRecommendations(
  deterministic: Recommendation[],
  llm: Recommendation[]
): Recommendation[] {
  const deterministicCategories = new Set([
    "rds-idle", "rds-snapshot-cleanup", "rds-old-generation", "rds-gp2-to-gp3",
    "rds-multi-az-dev", "rds-stopped-cost", "rds-overprovisioned-storage", "rds-backup-retention",
    "rds-extended-support", "rds-iops-overprovisioned", "rds-cluster-snapshot-cleanup", "rds-read-replica-underused",
  ]);

  const filteredLlm = llm.filter((r) => !deterministicCategories.has(r.category));

  // Cap LLM savings: don't let LLM suggest savings > actual cost for a resource
  const costByResource = new Map<string, number>();
  for (const r of deterministic) {
    costByResource.set(r.instanceId, Math.max(costByResource.get(r.instanceId) || 0, r.currentMonthlyCost));
  }
  for (const r of filteredLlm) {
    const maxCost = costByResource.get(r.instanceId);
    if (maxCost != null && r.estimatedSavings > maxCost) {
      r.estimatedSavings = maxCost;
    }
    // Self-cap: LLM savings should never exceed the LLM's own stated cost for the resource
    if (r.currentMonthlyCost > 0 && r.estimatedSavings > r.currentMonthlyCost) {
      r.estimatedSavings = r.currentMonthlyCost;
    }
    // Zero-cost edge case: can't save money on a $0 resource
    if (r.currentMonthlyCost === 0 && r.estimatedSavings > 0) {
      r.estimatedSavings = 0;
    }
  }

  return [...deterministic, ...filteredLlm];
}

function deduplicateRDSRecommendations(recs: Recommendation[]): Recommendation[] {
  const byResource = new Map<string, Recommendation[]>();
  for (const rec of recs) {
    if (!rec.instanceId) continue;
    if (!byResource.has(rec.instanceId)) byResource.set(rec.instanceId, []);
    byResource.get(rec.instanceId)!.push(rec);
  }

  const result: Recommendation[] = [];

  for (const [, group] of byResource) {
    // Deduplicate same resource + same category
    const uniqueByCategory: Recommendation[] = [];
    const catSeen = new Set<string>();
    for (const rec of group) {
      const catKey = `${rec.instanceId}:${rec.category}`;
      if (catSeen.has(catKey)) continue;
      catSeen.add(catKey);
      uniqueByCategory.push(rec);
    }

    const hasIdle = uniqueByCategory.some((r) => r.category === "rds-idle");

    if (hasIdle) {
      // Idle subsumes compute recs but keep storage, snapshot, and extended-support recs
      for (const rec of uniqueByCategory) {
        if ([
          "rds-idle", "rds-stopped-cost", "rds-gp2-to-gp3",
          "rds-overprovisioned-storage", "rds-snapshot-cleanup",
          "rds-backup-retention", "rds-extended-support",
          "rds-iops-overprovisioned", "rds-cluster-snapshot-cleanup",
        ].includes(rec.category)) {
          result.push(rec);
        }
      }
      continue;
    }

    result.push(...uniqueByCategory);
  }

  // Add recs with no instanceId (shouldn't happen but be safe)
  for (const rec of recs) {
    if (!rec.instanceId) result.push(rec);
  }

  return result;
}

async function analyzeRDSLlmInChunks(
  client: Anthropic,
  data: RDSCollectedData,
  chunkSize: number
): Promise<Recommendation[]> {
  const allRecs: Recommendation[] = [];
  const available = data.instances.filter((i) => i.status === "available");

  for (let i = 0; i < available.length; i += chunkSize) {
    const chunk = available.slice(i, i + chunkSize);
    const chunkData: RDSCollectedData = { ...data, instances: chunk };
    const prompt = buildRDSPrompt(chunkData);
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: RDS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });
    allRecs.push(...parseResponse(response));
  }

  return allRecs;
}

function buildRDSPrompt(data: RDSCollectedData): string {
  let prompt = `Analyze the following RDS instances for cost savings.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n\n`;

  const available = data.instances.filter((i) => i.status === "available");
  prompt += `## Available RDS Instances (${available.length})\n\n`;

  for (const inst of available) {
    prompt += `- **${inst.dbInstanceId}** | ${inst.dbInstanceClass} | ${inst.engine} ${inst.engineVersion}`;
    prompt += ` | MultiAZ: ${inst.multiAZ} | Storage: ${inst.storageType} ${inst.allocatedStorageGb}GB`;

    if (inst.cpuAvg != null) prompt += ` | CPU avg: ${inst.cpuAvg.toFixed(1)}%, max: ${inst.cpuMax?.toFixed(1) ?? "N/A"}%`;
    if (inst.freeableMemoryAvg != null) prompt += ` | FreeMemory avg: ${(inst.freeableMemoryAvg / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    if (inst.databaseConnectionsAvg != null) prompt += ` | Connections avg: ${inst.databaseConnectionsAvg.toFixed(1)}, max: ${inst.databaseConnectionsMax?.toFixed(0) ?? "N/A"}`;
    if (inst.readIOPSAvg != null) prompt += ` | ReadIOPS: ${inst.readIOPSAvg.toFixed(1)}, WriteIOPS: ${inst.writeIOPSAvg?.toFixed(1) ?? "N/A"}`;
    if (inst.monthlyEstimate != null) prompt += ` | Instance est: $${inst.monthlyEstimate.toFixed(2)}/mo`;
    prompt += ` | Storage cost: $${inst.storageMonthlyPrice.toFixed(2)}/mo`;
    prompt += ` | Total: $${inst.totalMonthlyEstimate.toFixed(2)}/mo`;

    // Tags for environment detection
    const envTag = inst.tags["Environment"] || inst.tags["Env"] || inst.tags["env"] || "";
    if (envTag) prompt += ` | env=${envTag}`;

    prompt += ` | Created: ${inst.instanceCreateTime}`;
    if (inst.isAurora) prompt += ` | Aurora cluster: ${inst.dbClusterIdentifier}`;
    prompt += `\n`;
  }

  prompt += `\nProvide your cost savings recommendations as a JSON array.`;
  return prompt;
}

function parseResponse(response: Anthropic.Message): Recommendation[] {
  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn("No JSON array found in RDS Claude response:", text.slice(0, 200));
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: any) => ({
      instanceId: item.instanceId || "",
      instanceName: item.instanceName || "",
      instanceType: item.instanceType || "",
      category: item.category || "other",
      severity: item.severity || "medium",
      currentMonthlyCost: Number(item.currentMonthlyCost) || 0,
      estimatedSavings: Number(item.estimatedSavings) || 0,
      action: item.action || "",
      reasoning: item.reasoning || "",
    }));
  } catch (err) {
    console.warn("Failed to parse RDS Claude response as JSON:", err);
    return [];
  }
}
