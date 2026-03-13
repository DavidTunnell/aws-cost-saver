import Anthropic from "@anthropic-ai/sdk";
import type {
  OpenSearchAccountData,
  OpenSearchDomainData,
} from "../aws/opensearch-collector";
import {
  OS_INSTANCE_PRICING,
  GP2_PER_GB_MONTH,
  GP3_PER_GB_MONTH,
  GRAVITON_DISCOUNT,
} from "../aws/opensearch-collector";
import type { Recommendation } from "./analyzer";

export type { Recommendation };

// ─── Deterministic helpers ───────────────────────────────────────────────────

function getSeverity(savings: number): "high" | "medium" | "low" {
  if (savings > 50) return "high";
  if (savings >= 10) return "medium";
  return "low";
}

function isNonProd(domain: OpenSearchDomainData): boolean {
  const name = domain.domainName.toLowerCase();
  const envTag = (
    domain.tags["Environment"] ||
    domain.tags["environment"] ||
    domain.tags["env"] ||
    ""
  ).toLowerCase();

  const nonProdPatterns = [
    "dev", "development", "test", "testing", "staging", "stage",
    "qa", "uat", "sandbox", "demo", "preview", "nonprod", "non-prod",
    "perf", "load-test", "canary", "ephemeral", "temp", "tmp",
  ];
  return nonProdPatterns.some(
    (p) => name.includes(p) || envTag.includes(p)
  );
}

// Check if instance type is old generation (2+ gens behind, with a newer equivalent)
function isOldGeneration(instanceType: string): boolean {
  const oldGenPrefixes = [
    "m3.", "m4.", "m5.", "r3.", "r4.", "r5.", "i2.", "c4.", "c5.",
  ];
  return oldGenPrefixes.some((p) => instanceType.startsWith(p));
}

// Check if instance type is x86 (has a Graviton equivalent)
function isX86WithGravitonAlternative(instanceType: string): boolean {
  const x86Prefixes = ["m5.", "r5.", "c5.", "i3.", "m7i.", "r7i.", "c7i."];
  return x86Prefixes.some((p) => instanceType.startsWith(p));
}

// Get the Graviton equivalent of an x86 instance type
function getGravitonEquivalent(instanceType: string): string | null {
  const mapping: Record<string, string> = {
    "m7i.": "m7g.",
    "r7i.": "r7g.",
    "c7i.": "c7g.",
    "m5.": "m6g.",
    "r5.": "r6g.",
    "c5.": "c6g.",
    "i3.": "or1.",
  };
  for (const [prefix, gravitonPrefix] of Object.entries(mapping)) {
    if (instanceType.startsWith(prefix)) {
      return instanceType.replace(prefix, gravitonPrefix);
    }
  }
  return null;
}

// Get the next-gen equivalent for old-gen instance types
function getNextGenEquivalent(instanceType: string): string | null {
  const mapping: Record<string, string> = {
    "m3.": "m6g.",
    "m4.": "m6g.",
    "m5.": "m7g.",
    "r3.": "r6g.",
    "r4.": "r6g.",
    "r5.": "r7g.",
    "c4.": "c6g.",
    "c5.": "c7g.",
  };
  for (const [prefix, newPrefix] of Object.entries(mapping)) {
    if (instanceType.startsWith(prefix)) {
      return instanceType.replace(prefix, newPrefix);
    }
  }
  return null;
}

// Get the next smaller instance size within the same family
function getNextSmallerInstance(instanceType: string): string | null {
  const sizeOrder = [
    "small", "medium", "large", "xlarge", "2xlarge",
    "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge",
  ];
  const parts = instanceType.replace(".search", "").split(".");
  if (parts.length !== 2) return null;
  const family = parts[0];
  const currentSize = parts[1];
  const currentIdx = sizeOrder.indexOf(currentSize);
  if (currentIdx <= 0) return null; // Already smallest or unknown
  return `${family}.${sizeOrder[currentIdx - 1]}.search`;
}

// Estimate savings from downsizing one step, with CE-cost fallback
function estimateDownsizeSavings(
  domain: OpenSearchDomainData,
  currentType: string,
  smallerType: string
): number | null {
  const currentRate = OS_INSTANCE_PRICING[currentType];
  const smallerRate = OS_INSTANCE_PRICING[smallerType];

  if (currentRate && smallerRate) {
    const savings = (currentRate - smallerRate) * 730 * domain.instanceCount;
    return savings > 1 ? savings : null;
  }

  // Fallback: estimate ~30% savings from one-step downsize based on actual cost
  // Instance cost is typically 70-85% of total domain cost
  if (domain.currentMonthlyCost > 0) {
    if (!OS_INSTANCE_PRICING[currentType]) {
      console.warn(
        `[OpenSearch Analyzer] No pricing for ${currentType} — using CE cost fallback`
      );
    }
    const estimatedInstanceCostShare = domain.currentMonthlyCost * 0.75;
    const savings = estimatedInstanceCostShare * 0.3;
    return savings > 1 ? savings : null;
  }

  return null;
}

// ─── Deterministic recommendations (9 categories) ───────────────────────────

function generateOpenSearchDeterministicRecs(
  data: OpenSearchAccountData
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const domain of data.domains) {
    const cpuAvg = domain.metrics.cpuUtilizationAvg;
    const cpuMax = domain.metrics.cpuUtilizationMax;
    const jvmAvg = domain.metrics.jvmMemoryPressureAvg;
    const jvmMax = domain.metrics.jvmMemoryPressureMax;
    const searchRate = domain.metrics.searchRateAvg;
    const indexRate = domain.metrics.indexingRateAvg;
    const freeStorageAvg = domain.metrics.freeStorageSpaceAvg;

    const fields = {
      instanceId: domain.domainName,
      instanceName: domain.domainName,
      instanceType: `${domain.instanceType} × ${domain.instanceCount}`,
      currentMonthlyCost: domain.currentMonthlyCost,
    };

    // 1. os-idle-domain: CPU < 1%, search rate ≈ 0, indexing rate ≈ 0
    // Require at least some metrics to be present — don't flag idle on missing data
    const hasMetrics = cpuAvg !== null || searchRate !== null || indexRate !== null;
    const isIdle =
      hasMetrics &&
      (cpuAvg === null || cpuAvg < 1.0) &&
      (searchRate === null || searchRate < 0.1) &&
      (indexRate === null || indexRate < 0.1);

    if (isIdle) {
      recs.push({
        ...fields,
        category: "os-idle-domain",
        severity:
          domain.currentMonthlyCost > 0
            ? getSeverity(domain.currentMonthlyCost)
            : "low",
        estimatedSavings: domain.currentMonthlyCost,
        action: `Consider deleting or shutting down idle domain "${domain.domainName}" — near-zero CPU, search, and indexing activity over 14 days`,
        reasoning: `Domain shows minimal activity: CPU avg ${cpuAvg?.toFixed(1) ?? "N/A"}%, search rate ${searchRate?.toFixed(2) ?? "N/A"}/s, indexing rate ${indexRate?.toFixed(2) ?? "N/A"}/s. Costing $${domain.currentMonthlyCost.toFixed(2)}/mo with no meaningful work.`,
      });
      continue; // Idle suppresses all other recs
    }

    // 2. os-over-provisioned-cpu: CPU avg < 15% and max < 40%
    let cpuAlreadySuggestedDownsize = false;
    if (cpuAvg != null && cpuMax != null && cpuAvg < 15 && cpuMax < 40) {
      const smaller = getNextSmallerInstance(domain.instanceType);
      if (smaller) {
        const savings = estimateDownsizeSavings(domain, domain.instanceType, smaller);
        if (savings != null) {
          cpuAlreadySuggestedDownsize = true;
          const jvmNote =
            jvmAvg != null && jvmAvg < 40
              ? ` JVM memory pressure is also low (avg ${jvmAvg.toFixed(1)}%), further supporting a downsize.`
              : "";
          recs.push({
            ...fields,
            category: "os-over-provisioned-cpu",
            severity: getSeverity(savings),
            estimatedSavings: savings,
            action: `Downsize "${domain.domainName}" from ${domain.instanceType} to ${smaller} — CPU avg ${cpuAvg.toFixed(1)}%, max ${cpuMax.toFixed(1)}%`,
            reasoning: `CPU utilization is low (avg ${cpuAvg.toFixed(1)}%, max ${cpuMax.toFixed(1)}%) over 14 days across ${domain.instanceCount} nodes.${jvmNote} Downsizing to ${smaller} saves ~$${savings.toFixed(2)}/mo.`,
          });
        }
      }
    }

    // 3. os-over-provisioned-jvm: JVM avg < 40% — only if CPU didn't already suggest downsize
    if (!cpuAlreadySuggestedDownsize && jvmAvg != null && jvmAvg < 40 && jvmMax != null && jvmMax < 70) {
      const smaller = getNextSmallerInstance(domain.instanceType);
      if (smaller) {
        const savings = estimateDownsizeSavings(domain, domain.instanceType, smaller);
        if (savings != null) {
          recs.push({
            ...fields,
            category: "os-over-provisioned-jvm",
            severity: getSeverity(savings),
            estimatedSavings: savings,
            action: `JVM memory pressure is low on "${domain.domainName}" — consider downsizing from ${domain.instanceType} to ${smaller}`,
            reasoning: `JVM memory pressure avg ${jvmAvg.toFixed(1)}%, max ${jvmMax.toFixed(1)}%. Instance memory is significantly over-provisioned. Downsizing saves ~$${savings.toFixed(2)}/mo across ${domain.instanceCount} nodes.`,
          });
        }
      }
    }

    // 4. os-over-provisioned-storage: Free storage > 70% of total capacity
    if (domain.ebsEnabled && domain.ebsVolumeSize > 0 && freeStorageAvg != null) {
      const totalStorageMB = domain.ebsVolumeSize * 1024 * domain.instanceCount;
      const freePercent = (freeStorageAvg / totalStorageMB) * 100;
      if (freePercent > 70) {
        const usedGB =
          ((totalStorageMB - freeStorageAvg) / 1024) / domain.instanceCount;
        const suggestedSizePerNode = Math.max(
          10,
          Math.ceil(usedGB * 2) // 2x headroom
        );
        if (suggestedSizePerNode < domain.ebsVolumeSize) {
          const gbRate =
            domain.ebsVolumeType === "gp3"
              ? GP3_PER_GB_MONTH
              : domain.ebsVolumeType === "io1"
                ? 0.125
                : GP2_PER_GB_MONTH;
          const savings =
            gbRate *
            (domain.ebsVolumeSize - suggestedSizePerNode) *
            domain.instanceCount;
          if (savings > 1) {
            recs.push({
              ...fields,
              category: "os-over-provisioned-storage",
              severity: getSeverity(savings),
              estimatedSavings: savings,
              action: `Reduce EBS storage on "${domain.domainName}" from ${domain.ebsVolumeSize}GB to ~${suggestedSizePerNode}GB per node — ${freePercent.toFixed(0)}% free`,
              reasoning: `${freePercent.toFixed(0)}% of storage is free across ${domain.instanceCount} nodes. Reducing from ${domain.ebsVolumeSize}GB to ${suggestedSizePerNode}GB/node saves ~$${savings.toFixed(2)}/mo while keeping 2× headroom.`,
            });
          }
        }
      }
    }

    // 5. os-gp2-to-gp3: EBS volume type is gp2
    if (domain.ebsEnabled && domain.ebsVolumeType === "gp2") {
      const savings =
        (GP2_PER_GB_MONTH - GP3_PER_GB_MONTH) *
        domain.ebsVolumeSize *
        domain.instanceCount;
      if (savings > 0.5) {
        recs.push({
          ...fields,
          category: "os-gp2-to-gp3",
          severity: getSeverity(savings),
          estimatedSavings: savings,
          action: `Migrate "${domain.domainName}" EBS from GP2 to GP3 — 20% storage cost reduction`,
          reasoning: `Domain uses GP2 EBS volumes (${domain.ebsVolumeSize}GB × ${domain.instanceCount} nodes). GP3 offers the same baseline performance at 20% lower cost, plus configurable IOPS/throughput. Saves ~$${savings.toFixed(2)}/mo.`,
        });
      }
    }

    // 6. os-graviton-migration: x86 instance with Graviton equivalent
    //    Skip if old-gen — rule 7 (generation-upgrade) handles those with a bigger jump
    if (isX86WithGravitonAlternative(domain.instanceType) && !isOldGeneration(domain.instanceType)) {
      const gravitonType = getGravitonEquivalent(domain.instanceType);
      if (gravitonType) {
        const currentRate =
          OS_INSTANCE_PRICING[domain.instanceType] || 0;
        const gravitonRate = OS_INSTANCE_PRICING[gravitonType] || 0;
        let savings: number;
        if (currentRate > 0 && gravitonRate > 0) {
          savings = (currentRate - gravitonRate) * 730 * domain.instanceCount;
        } else {
          // Fallback: estimate ~20% savings
          savings = domain.currentMonthlyCost * GRAVITON_DISCOUNT;
        }
        if (savings > 1) {
          recs.push({
            ...fields,
            category: "os-graviton-migration",
            severity: getSeverity(savings),
            estimatedSavings: savings,
            action: `Migrate "${domain.domainName}" from ${domain.instanceType} to ${gravitonType} (Graviton) — ~20% cost reduction`,
            reasoning: `Domain uses x86 instance type ${domain.instanceType}. Graviton equivalent ${gravitonType} offers ~20% lower pricing with comparable or better performance. Saves ~$${savings.toFixed(2)}/mo across ${domain.instanceCount} nodes.`,
          });
        }
      }
    }

    // 7. os-generation-upgrade: old-gen instance type
    if (isOldGeneration(domain.instanceType)) {
      const nextGen = getNextGenEquivalent(domain.instanceType);
      if (nextGen) {
        const currentRate =
          OS_INSTANCE_PRICING[domain.instanceType] || 0;
        const nextGenRate = OS_INSTANCE_PRICING[nextGen] || 0;
        let savings: number;
        if (currentRate > 0 && nextGenRate > 0) {
          savings =
            (currentRate - nextGenRate) * 730 * domain.instanceCount;
        } else {
          savings = domain.currentMonthlyCost * 0.15; // ~15% estimate
        }
        if (savings > 0) {
          recs.push({
            ...fields,
            category: "os-generation-upgrade",
            severity: getSeverity(savings),
            estimatedSavings: Math.max(savings, 0),
            action: `Upgrade "${domain.domainName}" from old-gen ${domain.instanceType} to ${nextGen}`,
            reasoning: `Domain uses deprecated ${domain.instanceType} instance type. Upgrading to ${nextGen} (Graviton) provides better price/performance. Old-gen instances may lose support and miss security patches.`,
          });
        }
      }
    }

    // 8. os-dedicated-master-oversized: dedicated master larger than necessary
    if (
      domain.dedicatedMasterEnabled &&
      domain.dedicatedMasterType &&
      domain.instanceCount <= 5
    ) {
      // If master type is larger than data node type, it's likely oversized
      const masterRate = OS_INSTANCE_PRICING[domain.dedicatedMasterType];
      const dataRate = OS_INSTANCE_PRICING[domain.instanceType];
      if (masterRate && dataRate && masterRate > dataRate) {
        const smallerMaster = getNextSmallerInstance(
          domain.dedicatedMasterType
        );
        if (smallerMaster) {
          const smallerRate = OS_INSTANCE_PRICING[smallerMaster];
          if (smallerRate) {
            const savings =
              (masterRate - smallerRate) * 730 * domain.dedicatedMasterCount;
            if (savings > 1) {
              recs.push({
                ...fields,
                category: "os-dedicated-master-oversized",
                severity: getSeverity(savings),
                estimatedSavings: savings,
                action: `Downsize dedicated masters on "${domain.domainName}" from ${domain.dedicatedMasterType} to ${smallerMaster}`,
                reasoning: `Dedicated master nodes (${domain.dedicatedMasterType} × ${domain.dedicatedMasterCount}) are larger than data nodes (${domain.instanceType} × ${domain.instanceCount}). For ${domain.instanceCount} data nodes, smaller masters are sufficient. Saves ~$${savings.toFixed(2)}/mo.`,
              });
            }
          }
        }
      }
    }

    // 9. os-single-az: zone awareness disabled (risk flag)
    if (!domain.zoneAwarenessEnabled && domain.instanceCount >= 2) {
      recs.push({
        ...fields,
        category: "os-single-az",
        severity: "low",
        estimatedSavings: 0,
        action: `Enable zone awareness for "${domain.domainName}" — currently running ${domain.instanceCount} nodes in a single AZ`,
        reasoning: `Domain runs ${domain.instanceCount} data nodes without zone awareness. A single AZ failure would cause downtime. Enable zone awareness with 2+ AZs for production resilience. No cost impact (same number of nodes distributed across AZs).`,
      });
    }
  }

  return recs;
}

// ─── LLM prompt (judgment-based categories) ──────────────────────────────────

const OPENSEARCH_SYSTEM_PROMPT = `You are an AWS cost optimization expert specializing in Amazon OpenSearch Service. Analyze domain metrics and return JSON recommendations.

Return a JSON array of objects with these fields:
- instanceId (domain name), instanceName (domain name), instanceType, category, severity ("high"/"medium"/"low"), currentMonthlyCost, estimatedSavings, action, reasoning

You ONLY analyze for these categories (all others are handled separately — do NOT generate them):
- "os-right-size": Holistic right-sizing considering CPU, JVM pressure, storage, search/indexing rates together. Suggest specific instance type changes when the metrics pattern indicates a better fit.
- "os-reserved-instance": Domains that are stable and long-running (created months ago, steady utilization) that would benefit from Reserved Instances or Savings Plans. Estimate 30-40% savings for 1-year RI.
- "os-architecture": Shard strategy improvements, index lifecycle management (ILM) recommendations, UltraWarm/cold storage tier usage for infrequently accessed indices. Consider if the domain would benefit from enabling UltraWarm.
- "os-consolidation": Multiple small domains that could be consolidated into fewer, larger domains to reduce per-domain overhead (dedicated masters, cross-cluster coordination).
- "os-scheduling": Non-production domains (dev/test/staging) that don't need to run 24/7. Suggest shut-down schedules or reduced capacity outside business hours.

Do NOT generate recommendations for: os-idle-domain, os-over-provisioned-cpu, os-over-provisioned-jvm, os-over-provisioned-storage, os-gp2-to-gp3, os-graviton-migration, os-generation-upgrade, os-dedicated-master-oversized, os-single-az. These are computed separately.

Severity: high (>$50/mo savings), medium ($10-50/mo), low (<$10/mo or operational).
estimatedSavings MUST NOT exceed the domain's current monthly cost.
Return ONLY a JSON array. No markdown, no explanation outside the JSON.
If no recommendations, return [].`;

// ─── Main analysis function ──────────────────────────────────────────────────

export async function analyzeOpenSearchWithClaude(
  data: OpenSearchAccountData
): Promise<Recommendation[]> {
  // Step 1: Deterministic recs
  const deterministicRecs = generateOpenSearchDeterministicRecs(data);

  // Step 2: LLM recs for judgment-based categories
  let llmRecs: Recommendation[] = [];

  if (data.domains.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn(
        "ANTHROPIC_API_KEY not set — skipping LLM analysis for OpenSearch"
      );
    } else {
      try {
        const client = new Anthropic({ apiKey });
        const prompt = buildOpenSearchPrompt(data);
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: OPENSEARCH_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        });
        llmRecs = parseResponse(response);
        if (llmRecs.length === 0) {
          console.log(
            `[OpenSearch Analyzer] LLM returned 0 recommendations for ${data.domains.length} domains`
          );
        }
      } catch (err: any) {
        console.warn(`OpenSearch LLM analysis failed: ${err.message}`);
      }
    }
  }

  // Step 3: Merge — deterministic wins
  const merged = mergeRecommendations(deterministicRecs, llmRecs);

  // Step 4: Deduplicate
  return deduplicateRecommendations(merged);
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicateRecommendations(
  recs: Recommendation[]
): Recommendation[] {
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

    // Idle domain suppresses all other recs for that domain
    const hasIdle = uniqueByCategory.some(
      (r) => r.category === "os-idle-domain"
    );
    if (hasIdle) {
      result.push(
        ...uniqueByCategory.filter((r) => r.category === "os-idle-domain")
      );
      continue;
    }

    result.push(...uniqueByCategory);
  }

  // Preserve recs with no instanceId
  for (const rec of recs) {
    if (!rec.instanceId) result.push(rec);
  }

  // Cap cumulative savings per domain to not exceed domain cost
  const domainSavings = new Map<string, number>();
  for (const rec of result) {
    if (!rec.instanceId) continue;
    domainSavings.set(
      rec.instanceId,
      (domainSavings.get(rec.instanceId) || 0) + rec.estimatedSavings
    );
  }
  for (const rec of result) {
    if (!rec.instanceId) continue;
    const totalSavings = domainSavings.get(rec.instanceId) || 0;
    if (totalSavings > rec.currentMonthlyCost && rec.currentMonthlyCost > 0) {
      const scale = rec.currentMonthlyCost / totalSavings;
      rec.estimatedSavings =
        Math.round(rec.estimatedSavings * scale * 100) / 100;
    }
  }

  return result;
}

// ─── LLM helpers ─────────────────────────────────────────────────────────────

function mergeRecommendations(
  deterministic: Recommendation[],
  llm: Recommendation[]
): Recommendation[] {
  const deterministicCategories = new Set([
    "os-idle-domain",
    "os-over-provisioned-cpu",
    "os-over-provisioned-jvm",
    "os-over-provisioned-storage",
    "os-gp2-to-gp3",
    "os-graviton-migration",
    "os-generation-upgrade",
    "os-dedicated-master-oversized",
    "os-single-az",
  ]);

  const filteredLlm = llm.filter(
    (r) => !deterministicCategories.has(r.category)
  );

  // Cap LLM savings to resource cost
  const costByResource = new Map<string, number>();
  for (const r of deterministic) {
    costByResource.set(
      r.instanceId,
      Math.max(costByResource.get(r.instanceId) || 0, r.currentMonthlyCost)
    );
  }

  for (const r of filteredLlm) {
    const maxCost = costByResource.get(r.instanceId);
    if (maxCost != null && r.estimatedSavings > maxCost) {
      r.estimatedSavings = maxCost;
    }
  }

  return [...deterministic, ...filteredLlm];
}

function buildOpenSearchPrompt(data: OpenSearchAccountData): string {
  let prompt = `Analyze the following OpenSearch domains for cost savings.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n`;
  prompt += `Total OpenSearch cost: $${data.accountSummary.totalMonthlyCost.toFixed(2)}/mo\n`;
  prompt += `Total domains: ${data.domains.length}\n\n`;

  prompt += `## OpenSearch Domains\n\n`;

  for (const domain of data.domains) {
    prompt += `- **${domain.domainName}**`;
    prompt += ` | Engine: ${domain.engineVersion}`;
    prompt += ` | Instance: ${domain.instanceType} × ${domain.instanceCount}`;
    prompt += ` | Cost: $${domain.currentMonthlyCost.toFixed(2)}/mo${domain.costIsActual ? " (actual)" : " (est)"}`;

    if (domain.ebsEnabled) {
      prompt += ` | EBS: ${domain.ebsVolumeType} ${domain.ebsVolumeSize}GB/node`;
      if (domain.ebsIops) prompt += ` (${domain.ebsIops} IOPS)`;
    }

    if (domain.dedicatedMasterEnabled) {
      prompt += ` | Masters: ${domain.dedicatedMasterType} × ${domain.dedicatedMasterCount}`;
    }

    if (domain.warmEnabled) {
      prompt += ` | UltraWarm: ${domain.warmType} × ${domain.warmCount}`;
    }

    prompt += ` | AZs: ${domain.availabilityZoneCount}${domain.zoneAwarenessEnabled ? " (zone-aware)" : " (single-AZ)"}`;

    if (domain.metrics.cpuUtilizationAvg != null) {
      prompt += ` | CPU: avg ${domain.metrics.cpuUtilizationAvg.toFixed(1)}%, max ${domain.metrics.cpuUtilizationMax?.toFixed(1) ?? "N/A"}%`;
    }
    if (domain.metrics.jvmMemoryPressureAvg != null) {
      prompt += ` | JVM: avg ${domain.metrics.jvmMemoryPressureAvg.toFixed(1)}%, max ${domain.metrics.jvmMemoryPressureMax?.toFixed(1) ?? "N/A"}%`;
    }
    if (domain.metrics.freeStorageSpaceAvg != null) {
      prompt += ` | FreeStorage: avg ${(domain.metrics.freeStorageSpaceAvg / 1024).toFixed(1)}GB, min ${domain.metrics.freeStorageSpaceMin != null ? (domain.metrics.freeStorageSpaceMin / 1024).toFixed(1) + "GB" : "N/A"}`;
    }
    if (domain.metrics.searchRateAvg != null) {
      prompt += ` | Search: ${domain.metrics.searchRateAvg.toFixed(2)}/s`;
    }
    if (domain.metrics.indexingRateAvg != null) {
      prompt += ` | Indexing: ${domain.metrics.indexingRateAvg.toFixed(2)}/s`;
    }
    if (domain.metrics.searchLatencyAvg != null) {
      prompt += ` | Latency: ${domain.metrics.searchLatencyAvg.toFixed(1)}ms`;
    }

    prompt += ` | AutoTune: ${domain.autoTuneEnabled ? "on" : "off"}`;
    prompt += ` | Encryption: ${domain.encryptionAtRest ? "at-rest" : "none"}${domain.nodeToNodeEncryption ? "+n2n" : ""}`;

    if (domain.createdAt)
      prompt += ` | Created: ${domain.createdAt.split("T")[0]}`;

    const tagStr = Object.entries(domain.tags)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    if (tagStr) prompt += ` | Tags: ${tagStr}`;

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
    console.warn(
      "No JSON array found in OpenSearch Claude response:",
      text.slice(0, 200)
    );
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
    console.warn("Failed to parse OpenSearch Claude response as JSON:", err);
    return [];
  }
}
