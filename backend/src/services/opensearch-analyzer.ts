import type { OpenSearchAccountData, OpenSearchDomainData, OpenSearchReservedInstance } from "../aws/opensearch-collector";
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

// EBS pricing for savings calculations
const EBS_PRICES: Record<string, number> = {
  gp2: 0.135,
  gp3: 0.108,
  io1: 0.154,
  io2: 0.154,
  standard: 0.10,
};

// ─── Right-sizing downgrade map ─────────────────────────────────────────────
// Maps instance types to the next smaller size within the same family.
// Falls back to cross-family suggestions for Graviton (m6g→t3 at bottom).

const DOWNGRADE_MAP: Record<string, string> = {
  // R6g family (memory-optimized, Graviton)
  "r6g.4xlarge.search": "r6g.2xlarge.search",
  "r6g.2xlarge.search": "r6g.xlarge.search",
  "r6g.xlarge.search": "r6g.large.search",
  "r6g.large.search": "m6g.large.search",
  // R5 family (memory-optimized)
  "r5.4xlarge.search": "r5.2xlarge.search",
  "r5.2xlarge.search": "r5.xlarge.search",
  "r5.xlarge.search": "r5.large.search",
  "r5.large.search": "m5.large.search",
  // M6g family (general-purpose, Graviton)
  "m6g.4xlarge.search": "m6g.2xlarge.search",
  "m6g.2xlarge.search": "m6g.xlarge.search",
  "m6g.xlarge.search": "m6g.large.search",
  "m6g.large.search": "t3.medium.search",
  // M5 family (general-purpose)
  "m5.4xlarge.search": "m5.2xlarge.search",
  "m5.2xlarge.search": "m5.xlarge.search",
  "m5.xlarge.search": "m5.large.search",
  "m5.large.search": "t3.medium.search",
  // C6g family (compute-optimized, Graviton)
  "c6g.2xlarge.search": "c6g.xlarge.search",
  "c6g.xlarge.search": "c6g.large.search",
  "c6g.large.search": "t3.medium.search",
  // C5 family (compute-optimized)
  "c5.2xlarge.search": "c5.xlarge.search",
  "c5.xlarge.search": "c5.large.search",
  "c5.large.search": "t3.medium.search",
  // I3 family (storage-optimized)
  "i3.2xlarge.search": "i3.xlarge.search",
  "i3.xlarge.search": "i3.large.search",
  // T3 family (burstable)
  "t3.medium.search": "t3.small.search",
  // T2 family (burstable, older)
  "t2.medium.search": "t2.small.search",
};

// ─── Graviton upgrade map ───────────────────────────────────────────────────
// Maps Intel/AMD instance families to equivalent Graviton types (~20% cheaper)

const GRAVITON_UPGRADE_MAP: Record<string, string> = {
  // M5 → M6g (general-purpose)
  "m5.large.search": "m6g.large.search",
  "m5.xlarge.search": "m6g.xlarge.search",
  "m5.2xlarge.search": "m6g.2xlarge.search",
  "m5.4xlarge.search": "m6g.4xlarge.search",
  // R5 → R6g (memory-optimized)
  "r5.large.search": "r6g.large.search",
  "r5.xlarge.search": "r6g.xlarge.search",
  "r5.2xlarge.search": "r6g.2xlarge.search",
  "r5.4xlarge.search": "r6g.4xlarge.search",
  // C5 → C6g (compute-optimized)
  "c5.large.search": "c6g.large.search",
  "c5.xlarge.search": "c6g.xlarge.search",
  "c5.2xlarge.search": "c6g.2xlarge.search",
  // T2 → T3 (burstable, not Graviton but newer gen)
  "t2.small.search": "t3.small.search",
  "t2.medium.search": "t3.medium.search",
};

// ─── Reserved Instance matching ─────────────────────────────────────────────

function isDomainCoveredByRI(
  domain: OpenSearchDomainData,
  reservedInstances: OpenSearchReservedInstance[]
): boolean {
  // Check if any active RI covers this domain's instance type
  const matchingRIs = reservedInstances.filter(
    (ri) => ri.instanceType === domain.instanceType && ri.state === "active"
  );
  // Sum total reserved capacity for this instance type
  const totalReservedCount = matchingRIs.reduce((sum, ri) => sum + ri.instanceCount, 0);
  // If there are any RIs for this instance type, consider it covered
  // (conservative: even partial coverage means they're aware of RIs)
  return totalReservedCount > 0;
}

function getEbsCost(domain: OpenSearchDomainData): number {
  if (!domain.ebsVolumeType || !domain.ebsVolumeSize) return 0;
  const pricePerGb = EBS_PRICES[domain.ebsVolumeType] ?? EBS_PRICES["gp2"];
  let cost = domain.ebsVolumeSize * domain.instanceCount * pricePerGb;
  if (domain.ebsIops && (domain.ebsVolumeType === "io1" || domain.ebsVolumeType === "io2")) {
    cost += domain.ebsIops * domain.instanceCount * 0.065;
  }
  return cost;
}

// Master node hourly rates (subset)
const MASTER_HOURLY_RATES: Record<string, number> = {
  "t3.small.search": 0.036,
  "t3.medium.search": 0.073,
  "m6g.large.search": 0.128,
  "m5.large.search": 0.142,
  "r6g.large.search": 0.167,
  "r5.large.search": 0.186,
  "c6g.large.search": 0.111,
  "c5.large.search": 0.123,
};

function getMasterHourlyRate(masterType: string): number {
  if (MASTER_HOURLY_RATES[masterType]) return MASTER_HOURLY_RATES[masterType];
  if (masterType.includes("small")) return 0.04;
  if (masterType.includes("medium")) return 0.08;
  if (masterType.includes("xlarge")) return 0.32;
  if (masterType.includes("large")) return 0.16;
  return 0.16;
}

// ─── 14 Deterministic recommendation categories ────────────────────────────

function generateOpenSearchDeterministicRecs(
  data: OpenSearchAccountData
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const domain of data.domains) {
    const m = domain.metrics;
    const meta = () =>
      buildMetadata({
        region: data.region,
        accountId: data.accountId,
        arn: domain.domainArn,
        engine: domain.engineVersion,
        type: `${domain.instanceCount}x ${domain.instanceType}`,
        storageType: domain.ebsVolumeType
          ? `${domain.ebsVolumeType} (${domain.ebsVolumeSize}GB/node)`
          : domain.storageType,
        multiAZ: String(domain.multiAZ),
        ...(domain.createdAt ? { createdAt: domain.createdAt } : {}),
      });

    // 1. opensearch-idle: Near-zero search and indexing
    const isIdle =
      (m.avgSearchRate != null && m.avgIndexingRate != null &&
        m.avgSearchRate < 1 && m.avgIndexingRate < 1) ||
      (m.avgSearchRate == null && m.avgIndexingRate == null &&
        m.avgCpuUtilization != null && m.avgCpuUtilization < 2);

    if (isIdle && domain.monthlyCost > 0) {
      recs.push({
        instanceId: domain.domainName,
        instanceName: domain.tags["Name"] || domain.domainName,
        instanceType: domain.instanceType,
        category: "opensearch-idle",
        severity: getSeverity(domain.monthlyCost),
        currentMonthlyCost: domain.monthlyCost,
        estimatedSavings: domain.monthlyCost,
        action: `Delete idle OpenSearch domain ${domain.domainName} — near-zero search and indexing activity over 30 days`,
        reasoning: `Domain ${domain.domainName} (${domain.instanceCount}x ${domain.instanceType}, ${domain.engineVersion}) shows virtually no search or indexing activity but costs $${domain.monthlyCost.toFixed(2)}/mo.`,
        metadata: meta(),
      });
      continue; // idle suppresses all other recs for this domain
    }

    // 2. opensearch-underutilized: Very low CPU and search rate — with specific right-sizing
    if (
      m.avgCpuUtilization != null &&
      m.avgCpuUtilization < 10 &&
      (m.avgSearchRate == null || m.avgSearchRate < 5)
    ) {
      const suggestedType = DOWNGRADE_MAP[domain.instanceType] || null;
      const savings = domain.monthlyCost * 0.5;
      if (savings > 0) {
        const searchNote =
          m.avgSearchRate != null ? `, search rate ${m.avgSearchRate.toFixed(1)}/s` : "";
        const downsizeTo = suggestedType
          ? ` → downsize to ${domain.instanceCount}x ${suggestedType}`
          : "";
        recs.push({
          instanceId: domain.domainName,
          instanceName: domain.tags["Name"] || domain.domainName,
          instanceType: domain.instanceType,
          category: "opensearch-underutilized",
          severity: getSeverity(savings),
          currentMonthlyCost: domain.monthlyCost,
          estimatedSavings: Math.round(savings * 100) / 100,
          action: `Downsize OpenSearch domain ${domain.domainName} from ${domain.instanceCount}x ${domain.instanceType}${downsizeTo} — CPU avg ${m.avgCpuUtilization.toFixed(1)}%${searchNote}`,
          reasoning: suggestedType
            ? `Domain is significantly underutilized with avg CPU at ${m.avgCpuUtilization.toFixed(1)}%. Recommend downsizing from ${domain.instanceType} to ${suggestedType} to save ~50% on compute costs.`
            : `Domain is significantly underutilized with avg CPU at ${m.avgCpuUtilization.toFixed(1)}%. Already at smallest size in family — consider reducing node count or switching to a burstable instance type.`,
          metadata: meta(),
        });
      }
    }

    // 3. opensearch-oversized-storage: Free storage > 75% of total
    if (
      m.freeStorageSpaceGb != null &&
      m.totalStorageGb > 0 &&
      m.freeStorageSpaceGb / m.totalStorageGb > 0.75
    ) {
      const ebsCost = getEbsCost(domain);
      const freeRatio = m.freeStorageSpaceGb / m.totalStorageGb;
      // Savings from reducing to 25% free
      const savings = ebsCost * (freeRatio - 0.25);
      if (savings > 0) {
        const pct = (freeRatio * 100).toFixed(0);
        recs.push({
          instanceId: domain.domainName,
          instanceName: domain.tags["Name"] || domain.domainName,
          instanceType: domain.instanceType,
          category: "opensearch-oversized-storage",
          severity: getSeverity(savings),
          currentMonthlyCost: domain.monthlyCost,
          estimatedSavings: Math.round(savings * 100) / 100,
          action: `Reduce EBS volume size on ${domain.domainName} — ${m.freeStorageSpaceGb.toFixed(0)}GB free of ${m.totalStorageGb}GB total (${pct}% unused)`,
          reasoning: `Storage is ${pct}% free. Reducing EBS volume size while maintaining a 25% free buffer would save ~$${savings.toFixed(2)}/mo on storage costs.`,
          metadata: meta(),
        });
      }
    }

    // 4. opensearch-old-engine: Outdated engine version
    const isOldEngine =
      domain.engineVersion.startsWith("Elasticsearch") ||
      (domain.engineVersion.startsWith("OpenSearch_1.") || domain.engineVersion === "OpenSearch_1");
    if (isOldEngine) {
      recs.push({
        instanceId: domain.domainName,
        instanceName: domain.tags["Name"] || domain.domainName,
        instanceType: domain.instanceType,
        category: "opensearch-old-engine",
        severity: "low",
        currentMonthlyCost: domain.monthlyCost,
        estimatedSavings: 0,
        action: `Upgrade ${domain.domainName} from ${domain.engineVersion} to latest OpenSearch 2.x for performance and security improvements`,
        reasoning: `Domain is running ${domain.engineVersion}. Upgrading to OpenSearch 2.x provides better performance, security patches, and new features at no additional cost.`,
        metadata: meta(),
      });
    }

    // 5. opensearch-no-reserved: Check actual RI coverage via AWS API data
    const isCoveredByRI = isDomainCoveredByRI(domain, data.reservedInstances);

    if (!isCoveredByRI && domain.monthlyCost > 0) {
      const savings = domain.monthlyCost * 0.3;
      if (savings > 0) {
        recs.push({
          instanceId: domain.domainName,
          instanceName: domain.tags["Name"] || domain.domainName,
          instanceType: domain.instanceType,
          category: "opensearch-no-reserved",
          severity: getSeverity(savings),
          currentMonthlyCost: domain.monthlyCost,
          estimatedSavings: Math.round(savings * 100) / 100,
          action: `Purchase Reserved Instance for ${domain.domainName} (${domain.instanceCount}x ${domain.instanceType}) — no active RI found for this instance type`,
          reasoning: `No active Reserved Instance reservation found for instance type ${domain.instanceType}. A 1-year RI commitment would save approximately 30% ($${savings.toFixed(2)}/mo).`,
          metadata: meta(),
        });
      }
    }

    // 6. opensearch-single-az: Not multi-AZ with multiple nodes
    if (!domain.multiAZ && domain.instanceCount > 1) {
      recs.push({
        instanceId: domain.domainName,
        instanceName: domain.tags["Name"] || domain.domainName,
        instanceType: domain.instanceType,
        category: "opensearch-single-az",
        severity: "low",
        currentMonthlyCost: domain.monthlyCost,
        estimatedSavings: 0,
        action: `Enable Multi-AZ for ${domain.domainName} (${domain.instanceCount} nodes) to improve availability`,
        reasoning: `Domain has ${domain.instanceCount} data nodes but is not configured for zone awareness. Enabling Multi-AZ distributes nodes across availability zones for better fault tolerance.`,
        metadata: meta(),
      });
    }

    // 7. opensearch-unnecessary-master: Dedicated masters on small clusters
    if (domain.dedicatedMasterEnabled && domain.instanceCount <= 2 && domain.masterType) {
      const masterHourly = getMasterHourlyRate(domain.masterType);
      const savings = masterHourly * 730 * domain.masterCount;
      if (savings > 0) {
        recs.push({
          instanceId: domain.domainName,
          instanceName: domain.tags["Name"] || domain.domainName,
          instanceType: domain.instanceType,
          category: "opensearch-unnecessary-master",
          severity: getSeverity(savings),
          currentMonthlyCost: domain.monthlyCost,
          estimatedSavings: Math.round(savings * 100) / 100,
          action: `Remove dedicated master nodes from ${domain.domainName} — only ${domain.instanceCount} data node(s), dedicated masters unnecessary`,
          reasoning: `Domain has ${domain.masterCount}x ${domain.masterType} dedicated master nodes but only ${domain.instanceCount} data node(s). AWS recommends dedicated masters for clusters with 3+ data nodes. Removing saves ~$${savings.toFixed(2)}/mo.`,
          metadata: meta(),
        });
      }
    }

    // 8. opensearch-gp2-to-gp3: EBS migration
    if (domain.ebsVolumeType === "gp2" && domain.ebsVolumeSize) {
      const ebsCost = domain.ebsVolumeSize * domain.instanceCount * EBS_PRICES["gp2"];
      const savings = ebsCost * 0.2;
      if (savings > 0) {
        recs.push({
          instanceId: domain.domainName,
          instanceName: domain.tags["Name"] || domain.domainName,
          instanceType: domain.instanceType,
          category: "opensearch-gp2-to-gp3",
          severity: getSeverity(savings),
          currentMonthlyCost: domain.monthlyCost,
          estimatedSavings: Math.round(savings * 100) / 100,
          action: `Migrate ${domain.domainName} EBS from gp2 to gp3 — saves ~20% on storage costs ($${savings.toFixed(2)}/mo)`,
          reasoning: `Domain uses gp2 EBS volumes (${domain.ebsVolumeSize}GB x ${domain.instanceCount} nodes). gp3 provides the same baseline performance at ~20% lower cost with configurable IOPS/throughput.`,
          metadata: meta(),
        });
      }
    }

    // 9. opensearch-warm-cold-candidate: High storage, low search rate
    if (
      !domain.warmEnabled &&
      m.totalStorageGb > 500 &&
      (m.avgSearchRate == null || m.avgSearchRate < 10)
    ) {
      const ebsCost = getEbsCost(domain);
      // Moving ~50% of data to UltraWarm saves ~67% on that portion
      const savings = ebsCost * 0.5 * 0.67;
      if (savings > 0) {
        const searchNote =
          m.avgSearchRate != null ? ` with avg search rate of ${m.avgSearchRate.toFixed(1)}/s` : "";
        recs.push({
          instanceId: domain.domainName,
          instanceName: domain.tags["Name"] || domain.domainName,
          instanceType: domain.instanceType,
          category: "opensearch-warm-cold-candidate",
          severity: getSeverity(savings),
          currentMonthlyCost: domain.monthlyCost,
          estimatedSavings: Math.round(savings * 100) / 100,
          action: `Enable UltraWarm tier on ${domain.domainName} to move infrequently accessed data off hot storage`,
          reasoning: `Domain has ${m.totalStorageGb}GB of hot storage${searchNote}. Moving older/infrequently accessed indices to UltraWarm (~$0.024/GB/mo vs ~$0.135/GB for gp2) could save ~$${savings.toFixed(2)}/mo.`,
          metadata: meta(),
        });
      }
    }

    // 10. opensearch-graviton-migration: Intel/AMD → Graviton for ~20% savings
    const gravitonTarget = GRAVITON_UPGRADE_MAP[domain.instanceType] || null;
    if (gravitonTarget) {
      const computeCost = domain.monthlyCost - getEbsCost(domain);
      const savings = computeCost * 0.2;
      if (savings > 5) {
        recs.push({
          instanceId: domain.domainName,
          instanceName: domain.tags["Name"] || domain.domainName,
          instanceType: domain.instanceType,
          category: "opensearch-graviton-migration",
          severity: getSeverity(savings),
          currentMonthlyCost: domain.monthlyCost,
          estimatedSavings: Math.round(savings * 100) / 100,
          action: `Migrate ${domain.domainName} from ${domain.instanceType} to ${gravitonTarget} (Graviton) — ~20% compute savings`,
          reasoning: `Domain uses ${domain.instanceType} (Intel/AMD). Migrating to ${gravitonTarget} (AWS Graviton) provides equivalent or better performance at ~20% lower cost. No application changes required.`,
          metadata: meta(),
        });
      }
    }

    // 11. opensearch-overprovisioned-iops: io1/io2 with low utilization
    if (
      domain.ebsIops &&
      (domain.ebsVolumeType === "io1" || domain.ebsVolumeType === "io2") &&
      m.avgCpuUtilization != null &&
      m.avgCpuUtilization < 20 &&
      (m.avgSearchRate == null || m.avgSearchRate < 10)
    ) {
      const iopsCost = domain.ebsIops * domain.instanceCount * 0.065;
      // Suggest switching to gp3 (3000 baseline IOPS free) or reducing IOPS
      const savings = iopsCost * 0.5;
      if (savings > 5) {
        recs.push({
          instanceId: domain.domainName,
          instanceName: domain.tags["Name"] || domain.domainName,
          instanceType: domain.instanceType,
          category: "opensearch-overprovisioned-iops",
          severity: getSeverity(savings),
          currentMonthlyCost: domain.monthlyCost,
          estimatedSavings: Math.round(savings * 100) / 100,
          action: `Reduce provisioned IOPS on ${domain.domainName} or migrate from ${domain.ebsVolumeType} to gp3 — ${domain.ebsIops} IOPS provisioned per node but utilization is low`,
          reasoning: `Domain has ${domain.ebsIops} provisioned IOPS (${domain.ebsVolumeType}) per node at $0.065/IOPS/mo but CPU is only ${m.avgCpuUtilization.toFixed(1)}%. Consider switching to gp3 (3000 baseline IOPS included free) or reducing provisioned IOPS to save ~$${savings.toFixed(2)}/mo.`,
          metadata: meta(),
        });
      }
    }

    // 12. opensearch-node-consolidation: Too many nodes for the workload
    if (
      domain.instanceCount >= 3 &&
      m.avgCpuUtilization != null &&
      m.avgCpuUtilization < 15
    ) {
      // Calculate how many nodes we actually need
      // If avg CPU is 10% across 5 nodes, total load = 50% of one node
      // We need at least 2 nodes for HA, and target ~50% CPU utilization
      const totalCpuLoad = m.avgCpuUtilization * domain.instanceCount;
      const targetUtilization = 50; // target 50% CPU per node
      const minNodes = domain.multiAZ ? 2 : 1; // at least 2 for multi-AZ
      const neededNodes = Math.max(minNodes, Math.ceil(totalCpuLoad / targetUtilization));

      if (neededNodes < domain.instanceCount) {
        const removedNodes = domain.instanceCount - neededNodes;
        // Approximate per-node cost
        const perNodeCost = domain.monthlyCost / domain.instanceCount;
        const savings = perNodeCost * removedNodes;
        if (savings > 5) {
          recs.push({
            instanceId: domain.domainName,
            instanceName: domain.tags["Name"] || domain.domainName,
            instanceType: domain.instanceType,
            category: "opensearch-node-consolidation",
            severity: getSeverity(savings),
            currentMonthlyCost: domain.monthlyCost,
            estimatedSavings: Math.round(savings * 100) / 100,
            action: `Reduce ${domain.domainName} from ${domain.instanceCount} to ${neededNodes} data nodes — avg CPU is only ${m.avgCpuUtilization.toFixed(1)}% per node`,
            reasoning: `Cluster has ${domain.instanceCount} data nodes averaging ${m.avgCpuUtilization.toFixed(1)}% CPU each (total load: ${totalCpuLoad.toFixed(0)}%). Consolidating to ${neededNodes} nodes at ~${targetUtilization}% target utilization would save ~$${savings.toFixed(2)}/mo while maintaining headroom.`,
            metadata: meta(),
          });
        }
      }
    }

    // 13. opensearch-jvm-pressure: High JVM memory pressure (risk of OOM/GC thrashing)
    if (
      m.maxJvmMemoryPressure != null &&
      m.maxJvmMemoryPressure > 90
    ) {
      recs.push({
        instanceId: domain.domainName,
        instanceName: domain.tags["Name"] || domain.domainName,
        instanceType: domain.instanceType,
        category: "opensearch-jvm-pressure",
        severity: m.maxJvmMemoryPressure > 95 ? "high" : "medium",
        currentMonthlyCost: domain.monthlyCost,
        estimatedSavings: 0,
        action: `Investigate high JVM memory pressure on ${domain.domainName} — peak ${m.maxJvmMemoryPressure.toFixed(0)}%${m.avgJvmMemoryPressure != null ? `, avg ${m.avgJvmMemoryPressure.toFixed(0)}%` : ""}`,
        reasoning: `JVM memory pressure peaked at ${m.maxJvmMemoryPressure.toFixed(0)}%. Sustained pressure >85% causes aggressive garbage collection, query latency spikes, and risk of OOM crashes. Consider upsizing to a memory-optimized instance type (r6g family) or reducing shard count.`,
        metadata: meta(),
      });
    }

    // 14. opensearch-cluster-health: Cluster not consistently green
    if (
      m.clusterStatusGreen != null &&
      m.clusterStatusGreen < 0.95
    ) {
      const greenPct = (m.clusterStatusGreen * 100).toFixed(0);
      recs.push({
        instanceId: domain.domainName,
        instanceName: domain.tags["Name"] || domain.domainName,
        instanceType: domain.instanceType,
        category: "opensearch-cluster-health",
        severity: m.clusterStatusGreen < 0.8 ? "high" : "medium",
        currentMonthlyCost: domain.monthlyCost,
        estimatedSavings: 0,
        action: `Investigate cluster health for ${domain.domainName} — only ${greenPct}% green status over 30 days`,
        reasoning: `Cluster was in green status only ${greenPct}% of the time over the past 30 days. Yellow status indicates unassigned replica shards; red status means unassigned primary shards with potential data loss. Review shard allocation, storage capacity, and node health.`,
        metadata: meta(),
      });
    }
  }

  return recs;
}

// ─── Deduplication ──────────────────────────────────────────────────────────

function deduplicateOpenSearchRecs(recs: Recommendation[]): Recommendation[] {
  // Group by domain
  const byDomain = new Map<string, Recommendation[]>();
  for (const rec of recs) {
    const existing = byDomain.get(rec.instanceId) || [];
    existing.push(rec);
    byDomain.set(rec.instanceId, existing);
  }

  const result: Recommendation[] = [];

  for (const [domainName, domainRecs] of byDomain) {
    // If idle exists, keep only idle
    const idleRec = domainRecs.find((r) => r.category === "opensearch-idle");
    if (idleRec) {
      result.push(idleRec);
      continue;
    }

    // Deduplicate same category
    const seen = new Set<string>();
    const filtered: Recommendation[] = [];
    for (const rec of domainRecs) {
      if (seen.has(rec.category)) continue;
      seen.add(rec.category);
      filtered.push(rec);
    }

    // Cap total savings to not exceed monthly cost
    const monthlyCost = filtered[0]?.currentMonthlyCost ?? 0;
    let totalSavings = 0;
    for (const rec of filtered) {
      const remaining = monthlyCost - totalSavings;
      if (rec.estimatedSavings > remaining && remaining > 0) {
        rec.estimatedSavings = Math.round(remaining * 100) / 100;
      } else if (remaining <= 0 && rec.estimatedSavings > 0) {
        rec.estimatedSavings = 0;
      }
      totalSavings += rec.estimatedSavings;
      result.push(rec);
    }
  }

  return result;
}

// ─── Main analyzer ──────────────────────────────────────────────────────────

export function analyzeOpenSearch(
  data: OpenSearchAccountData
): Recommendation[] {
  if (data.domains.length === 0) return [];

  const recs = generateOpenSearchDeterministicRecs(data);
  return deduplicateOpenSearchRecs(recs);
}
