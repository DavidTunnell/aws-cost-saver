import Anthropic from "@anthropic-ai/sdk";
import type { CollectedData } from "../aws/collector";
import { getGravitonEquivalent, getSnapshotMonthlyPrice, getEbsMonthlyPrice, getGp2ToGp3Savings } from "../aws/pricing";

export interface Recommendation {
  instanceId: string;
  instanceName: string;
  instanceType: string;
  category: string;
  severity: string;
  currentMonthlyCost: number;
  estimatedSavings: number;
  action: string;
  reasoning: string;
  metadata?: Record<string, string>;
}

export function buildMetadata(entries: Record<string, string | undefined | null>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v) result[k] = v;
  }
  return result;
}

// ─── Deterministic helpers ───────────────────────────────────────────────────

function getSeverity(savings: number): "high" | "medium" | "low" {
  if (savings > 50) return "high";
  if (savings >= 10) return "medium";
  return "low";
}

const OLD_GEN_FAMILIES = new Set(["m3", "m4", "c3", "c4", "r3", "r4", "t1", "t2", "i2", "d2"]);

function getInstanceFamily(instanceType: string): string {
  return instanceType.split(".")[0];
}

/**
 * Generates recommendations for 9 categories that can be computed deterministically
 * from the collected data — no LLM needed. This eliminates run-to-run variance for
 * the majority of recommendation categories.
 */
function generateDeterministicRecs(data: CollectedData): Recommendation[] {
  const recs: Recommendation[] = [];
  const usedAmiIds = new Set(data.instances.map((i) => i.imageId).filter(Boolean));
  // Track snapshot IDs used by unused AMIs to avoid double-counting with snapshot-cleanup
  const snapshotIdsFromUnusedAmis = new Set<string>();

  // 1. unused-eip: Each idle EIP = $3.65/mo
  for (const eip of data.idleEips) {
    recs.push({
      instanceId: eip.allocationId,
      instanceName: eip.publicIp,
      instanceType: "eip",
      category: "unused-eip",
      severity: "low",
      currentMonthlyCost: 3.65,
      estimatedSavings: 3.65,
      action: `Release idle Elastic IP ${eip.publicIp} (${eip.allocationId})`,
      reasoning: "This Elastic IP is not associated with any running instance and costs $3.65/mo since Feb 2024 pricing.",
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: `arn:aws:ec2:${data.region}:${data.accountId}:elastic-ip/${eip.allocationId}` }),
    });
  }

  // 2. orphan-ebs: Unattached EBS volumes
  for (const vol of data.orphanVolumes) {
    const cost = getEbsMonthlyPrice(vol.volumeType, vol.size, null);
    recs.push({
      instanceId: vol.volumeId,
      instanceName: vol.volumeId,
      instanceType: `${vol.volumeType} ${vol.size}GB`,
      category: "orphan-ebs",
      severity: getSeverity(cost),
      currentMonthlyCost: cost,
      estimatedSavings: cost,
      action: `Delete or snapshot unattached volume ${vol.volumeId} (${vol.size}GB ${vol.volumeType})`,
      reasoning: `Unattached EBS volume created ${vol.createTime}, costing $${cost.toFixed(2)}/mo with no instance attached.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: `arn:aws:ec2:${data.region}:${data.accountId}:volume/${vol.volumeId}` }),
    });
  }

  // 3. unused-ami: AMIs not used by any instance
  // Build a lookup from snapshot ID to actual cost (from enriched snapshots)
  const snapCostMap = new Map<string, { cost: number; isActual: boolean }>();
  for (const snap of data.snapshots) {
    snapCostMap.set(snap.snapshotId, { cost: snap.monthlyCost, isActual: snap.costIsActual });
  }

  if (data.amis) {
    for (const ami of data.amis) {
      if (usedAmiIds.has(ami.imageId)) continue;

      // Sum actual costs of backing snapshots when available
      let cost = 0;
      let allActual = true;
      for (const snapId of ami.snapshotIds) {
        const snapCost = snapCostMap.get(snapId);
        if (snapCost) {
          cost += snapCost.cost;
          if (!snapCost.isActual) allActual = false;
        } else {
          // Snapshot not in enriched list (e.g., <30 days old) — use provisioned estimate
          cost += getSnapshotMonthlyPrice(ami.totalSnapshotSizeGb / Math.max(ami.snapshotIds.length, 1));
          allActual = false;
        }
      }

      if (cost <= 0) continue;
      const costWarning = allActual ? "" : " (estimate based on provisioned size; actual cost may be lower)";
      recs.push({
        instanceId: ami.imageId,
        instanceName: ami.name || ami.imageId,
        instanceType: "ami",
        category: "unused-ami",
        severity: getSeverity(cost),
        currentMonthlyCost: cost,
        estimatedSavings: cost,
        action: `Deregister unused AMI ${ami.imageId} ("${ami.name}") and delete its ${ami.snapshotIds.length} backing snapshots`,
        reasoning: `AMI not used by any instance. Backing snapshots (${ami.totalSnapshotSizeGb}GB provisioned) cost $${cost.toFixed(2)}/mo${costWarning}.`,
        metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: `arn:aws:ec2:${data.region}:${data.accountId}:image/${ami.imageId}` }),
      });
      for (const snapId of ami.snapshotIds) {
        snapshotIdsFromUnusedAmis.add(snapId);
      }
    }
  }

  // 4. snapshot-cleanup: Orphan snapshots (volume deleted, no AMI) — exclude those already in unused-ami
  for (const snap of data.snapshots) {
    if (snapshotIdsFromUnusedAmis.has(snap.snapshotId)) continue;
    if (snap.usedByAmi) continue; // BACKING_AMI — only cleanup if AMI is unused (handled above)
    if (snap.sourceVolumeExists) continue; // ACTIVE_BACKUP — not orphan
    // This is an ORPHAN snapshot
    const cost = snap.monthlyCost;
    if (cost <= 0) continue;
    const costWarning = snap.costIsActual ? "" : " (estimate based on provisioned size; actual cost may be lower)";
    recs.push({
      instanceId: snap.snapshotId,
      instanceName: snap.description || snap.snapshotId,
      instanceType: "snapshot",
      category: "snapshot-cleanup",
      severity: getSeverity(cost),
      currentMonthlyCost: cost,
      estimatedSavings: cost,
      action: `Delete orphan snapshot ${snap.snapshotId} (${snap.volumeSizeGb}GB provisioned)`,
      reasoning: `Orphan snapshot — source volume ${snap.volumeId || "unknown"} no longer exists and snapshot is not backing any AMI. Created ${snap.startTime}. Cost: $${cost.toFixed(2)}/mo${costWarning}.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: `arn:aws:ec2:${data.region}:${data.accountId}:snapshot/${snap.snapshotId}` }),
    });
  }

  // 5. stopped-ebs: Stopped instances still paying for EBS
  for (const inst of data.instances) {
    if (inst.state !== "stopped" || inst.ebsMonthlyCost <= 0) continue;
    recs.push({
      instanceId: inst.instanceId,
      instanceName: inst.name,
      instanceType: inst.instanceType,
      category: "stopped-ebs",
      severity: getSeverity(inst.ebsMonthlyCost),
      currentMonthlyCost: inst.ebsMonthlyCost,
      estimatedSavings: inst.ebsMonthlyCost,
      action: `Snapshot and delete EBS volumes on stopped instance ${inst.instanceId} ("${inst.name}") to save $${inst.ebsMonthlyCost.toFixed(2)}/mo`,
      reasoning: `Instance is stopped but ${inst.attachedVolumes.length} attached EBS volume(s) still incur $${inst.ebsMonthlyCost.toFixed(2)}/mo in storage costs.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: `arn:aws:ec2:${data.region}:${data.accountId}:instance/${inst.instanceId}`, az: inst.availabilityZone, platform: inst.platform }),
    });
  }

  // 6. ebs-optimize: gp2 → gp3 migration
  for (const inst of data.instances) {
    for (const vol of inst.attachedVolumes) {
      if (vol.volumeType !== "gp2") continue;
      const savings = getGp2ToGp3Savings(vol.sizeGb);
      if (savings <= 0) continue;
      recs.push({
        instanceId: vol.volumeId,
        instanceName: `${inst.name} (${inst.instanceId})`,
        instanceType: `gp2 ${vol.sizeGb}GB`,
        category: "ebs-optimize",
        severity: getSeverity(savings),
        currentMonthlyCost: vol.monthlyPrice,
        estimatedSavings: savings,
        action: `Migrate volume ${vol.volumeId} from gp2 to gp3 (${vol.sizeGb}GB on ${inst.instanceId})`,
        reasoning: `gp3 provides 3000 baseline IOPS (vs gp2 size-dependent) at 20% lower cost, saving $${savings.toFixed(2)}/mo.`,
        metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: `arn:aws:ec2:${data.region}:${data.accountId}:volume/${vol.volumeId}`, az: inst.availabilityZone }),
      });
    }
  }

  // 7. ebs-iops-optimize: io1/io2 IOPS waste
  for (const inst of data.instances) {
    for (const vol of inst.attachedVolumes) {
      if (!vol.iopsWasteMonthlyCost || vol.iopsWasteMonthlyCost <= 0) continue;
      recs.push({
        instanceId: vol.volumeId,
        instanceName: `${inst.name} (${inst.instanceId})`,
        instanceType: `${vol.volumeType} ${vol.sizeGb}GB`,
        category: "ebs-iops-optimize",
        severity: getSeverity(vol.iopsWasteMonthlyCost),
        currentMonthlyCost: vol.monthlyPrice,
        estimatedSavings: vol.iopsWasteMonthlyCost,
        action: `Reduce provisioned IOPS on ${vol.volumeId} or migrate to gp3 (3000 IOPS baseline included)`,
        reasoning: `Provisioned IOPS far exceed actual usage. Reducing to match actual needs saves $${vol.iopsWasteMonthlyCost.toFixed(2)}/mo.`,
        metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: `arn:aws:ec2:${data.region}:${data.accountId}:volume/${vol.volumeId}`, az: inst.availabilityZone }),
      });
    }
  }

  // 8. graviton-migrate: x86_64 instances with graviton pricing available
  for (const inst of data.instances) {
    if (inst.state !== "running") continue;
    if (inst.architecture !== "x86_64") continue;
    if (!inst.gravitonEquivalent || inst.gravitonHourlyPrice == null || inst.onDemandHourly == null) continue;
    const savings = (inst.onDemandHourly - inst.gravitonHourlyPrice) * 730;
    if (savings <= 0) continue;
    recs.push({
      instanceId: inst.instanceId,
      instanceName: inst.name,
      instanceType: inst.instanceType,
      category: "graviton-migrate",
      severity: getSeverity(savings),
      currentMonthlyCost: inst.monthlyEstimate ?? inst.onDemandHourly * 730,
      estimatedSavings: savings,
      action: `Migrate ${inst.instanceId} from ${inst.instanceType} to ${inst.gravitonEquivalent} (Graviton/ARM)`,
      reasoning: `Graviton equivalent saves $${savings.toFixed(2)}/mo ($${inst.onDemandHourly.toFixed(4)}/hr → $${inst.gravitonHourlyPrice.toFixed(4)}/hr). Requires ARM compatibility testing.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: `arn:aws:ec2:${data.region}:${data.accountId}:instance/${inst.instanceId}`, az: inst.availabilityZone, platform: inst.platform, imageId: inst.imageId, launchTime: inst.launchTime }),
    });
  }

  // 9. generation-upgrade: Old instance families
  for (const inst of data.instances) {
    if (inst.state !== "running") continue;
    const family = getInstanceFamily(inst.instanceType);
    if (!OLD_GEN_FAMILIES.has(family)) continue;
    const monthlyCost = inst.monthlyEstimate ?? 0;
    if (monthlyCost <= 0) continue;
    const savings = monthlyCost * 0.15;
    recs.push({
      instanceId: inst.instanceId,
      instanceName: inst.name,
      instanceType: inst.instanceType,
      category: "generation-upgrade",
      severity: getSeverity(savings),
      currentMonthlyCost: monthlyCost,
      estimatedSavings: savings,
      action: `Upgrade ${inst.instanceId} from ${inst.instanceType} to current generation (e.g., ${family.replace(/\d+/, "7")}i equivalent)`,
      reasoning: `${inst.instanceType} is an old generation type. Current generation offers ~15% cost savings with better performance.`,
      metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: `arn:aws:ec2:${data.region}:${data.accountId}:instance/${inst.instanceId}`, az: inst.availabilityZone, platform: inst.platform, imageId: inst.imageId, launchTime: inst.launchTime }),
    });
  }

  return recs;
}

// ─── LLM-only prompt (judgment-based categories) ────────────────────────────

const SYSTEM_PROMPT = `You are an AWS cost optimization expert. Analyze EC2 instance metrics and return JSON recommendations.

Return a JSON array of objects with these fields:
- instanceId, instanceName, instanceType, category, severity ("high"/"medium"/"low"), currentMonthlyCost, estimatedSavings, action, reasoning

You ONLY analyze for these categories (all others are handled separately — do NOT generate them):
- "right-size": CPU avg <10%, max <30% → suggest specific smaller type. Savings = 50% of on-demand estimate.
- "stop"/"idle": CPU avg <5%, low network → recommend stopping. currentMonthlyCost = on-demand + EBS. estimatedSavings = on-demand only.
- "schedule-stop": dev/test/staging tags + running 24/7 → stop nights/weekends. estimatedSavings = 65% of on-demand.
- "reserved-instance"/"savings-plan": consistent 24/7 usage for months → RI/SP. estimatedSavings = 40% of on-demand.

Do NOT generate recommendations for: unused-eip, orphan-ebs, snapshot-cleanup, unused-ami, stopped-ebs, ebs-optimize, ebs-iops-optimize, graviton-migrate, generation-upgrade. These are computed separately.

Severity: high (>$50/mo), medium ($10-50/mo), low (<$10/mo).
Do NOT double-count: if both right-size and stop apply, only recommend stop.
Return ONLY a JSON array. No markdown, no explanation outside the JSON.
If no recommendations, return [].`;

export async function analyzeWithClaude(
  data: CollectedData
): Promise<Recommendation[]> {
  // Step 1: Deterministic recs (always identical for same input data)
  const deterministicRecs = generateDeterministicRecs(data);

  // Step 2: LLM recs for judgment-based categories (right-size, stop, idle, schedule-stop, RI/SP)
  const runningInstances = data.instances.filter((i) => i.state === "running");
  let llmRecs: Recommendation[] = [];

  if (runningInstances.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        `ANTHROPIC_API_KEY is not set. Env keys available: ${Object.keys(process.env).filter(k => k.includes("ANTHROPIC")).join(", ") || "none matching ANTHROPIC"}`
      );
    }
    const client = new Anthropic({ apiKey });

    const CHUNK_SIZE = 25;
    if (runningInstances.length > CHUNK_SIZE) {
      llmRecs = await analyzeLlmInChunks(client, data, CHUNK_SIZE);
    } else {
      const prompt = buildPrompt(data);
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });
      llmRecs = parseResponse(response);
    }
  }

  // Enrich LLM recs with metadata and correct pricing from collector data
  const instanceMap = new Map(data.instances.map(i => [i.instanceId, i]));
  for (const rec of llmRecs) {
    const inst = instanceMap.get(rec.instanceId);
    if (inst) {
      // Override LLM's currentMonthlyCost with known cost — prefer Pricing API (on-demand, per-instance)
      // over Cost Explorer (may reflect RI/SP discounts and is aggregated per instance type)
      const knownCost = inst.monthlyEstimate ?? inst.actualMonthlyCost;
      if (inst.monthlyEstimate == null && inst.actualMonthlyCost != null) {
        console.warn(`[Analyzer] ${inst.instanceId}: using Cost Explorer cost ($${inst.actualMonthlyCost.toFixed(2)}) — Pricing API unavailable`);
      }
      if (knownCost != null && knownCost > 0) {
        rec.currentMonthlyCost = knownCost;
        // Enforce deterministic savings formulas using the corrected cost
        if (rec.category === "right-size") rec.estimatedSavings = knownCost * 0.50;
        else if (rec.category === "stop" || rec.category === "idle") rec.estimatedSavings = knownCost;
        else if (rec.category === "schedule-stop") rec.estimatedSavings = knownCost * 0.65;
        else if (rec.category === "reserved-instance" || rec.category === "savings-plan") rec.estimatedSavings = knownCost * 0.40;
      }
      // Recalculate severity from corrected savings (LLM severity is unreliable)
      rec.severity = getSeverity(rec.estimatedSavings);
      rec.metadata = buildMetadata({
        region: data.region,
        accountId: data.accountId,
        arn: `arn:aws:ec2:${data.region}:${data.accountId}:instance/${inst.instanceId}`,
        az: inst.availabilityZone,
        platform: inst.platform,
        imageId: inst.imageId,
        launchTime: inst.launchTime,
      });
      // Show Cost Explorer rate if it differs from on-demand (RI/SP discount visibility)
      if (inst.actualMonthlyCost != null && inst.monthlyEstimate != null &&
          Math.abs(inst.actualMonthlyCost - inst.monthlyEstimate) > 1) {
        rec.metadata.actualBillCost = `$${inst.actualMonthlyCost.toFixed(2)}/mo (Cost Explorer)`;
      }
    }
  }

  // Step 3: Merge — deterministic wins on collisions
  const merged = mergeRecommendations(deterministicRecs, llmRecs);
  return deduplicateRecommendations(merged);
}

/**
 * Merges deterministic and LLM recommendations. Deterministic recs win on
 * instanceId:category key collisions (safety net if LLM emits a deterministic category).
 */
function mergeRecommendations(deterministic: Recommendation[], llm: Recommendation[]): Recommendation[] {
  const deterministicCategories = new Set([
    "unused-eip", "orphan-ebs", "snapshot-cleanup", "unused-ami",
    "stopped-ebs", "ebs-optimize", "ebs-iops-optimize", "graviton-migrate", "generation-upgrade",
  ]);

  // Filter out any LLM recs that overlap with deterministic categories
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

async function analyzeLlmInChunks(
  client: Anthropic,
  data: CollectedData,
  chunkSize: number
): Promise<Recommendation[]> {
  const allRecommendations: Recommendation[] = [];
  const runningInstances = data.instances.filter((i) => i.state === "running");
  const instanceChunks: CollectedData["instances"][] = [];

  for (let i = 0; i < runningInstances.length; i += chunkSize) {
    instanceChunks.push(runningInstances.slice(i, i + chunkSize));
  }

  for (const chunk of instanceChunks) {
    const chunkData: CollectedData = {
      ...data,
      instances: chunk,
    };

    const prompt = buildPrompt(chunkData);
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    allRecommendations.push(...parseResponse(response));
  }

  return allRecommendations;
}

/**
 * Builds an LLM prompt containing only running instance data.
 * The LLM only needs to judge: right-size, stop/idle, schedule-stop, RI/SP.
 */
function buildPrompt(data: CollectedData): string {
  let prompt = `Analyze the following running EC2 instances for cost savings.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n\n`;

  const runningInstances = data.instances.filter((i) => i.state === "running");
  prompt += `## Running EC2 Instances (${runningInstances.length})\n\n`;

  for (const inst of runningInstances) {
    prompt += `- **${inst.instanceId}** "${inst.name}" | ${inst.instanceType} | arch: ${inst.architecture}`;
    prompt += ` | CPU avg: ${inst.cpuAvg?.toFixed(1) ?? "N/A"}%, max: ${inst.cpuMax?.toFixed(1) ?? "N/A"}%`;
    prompt += ` | Net in: ${formatBytes(inst.networkInAvg)} avg / ${formatBytes(inst.networkInMax)} max`;
    prompt += ` | Net out: ${formatBytes(inst.networkOutAvg)} avg / ${formatBytes(inst.networkOutMax)} max`;

    if (inst.diskReadOps != null || inst.diskWriteOps != null) {
      prompt += ` | Disk I/O: ${inst.diskReadOps?.toFixed(1) ?? "N/A"} read, ${inst.diskWriteOps?.toFixed(1) ?? "N/A"} write ops/hr`;
    }
    if (inst.cpuCreditBalance != null) {
      prompt += ` | CPU credits: ${inst.cpuCreditBalance.toFixed(1)}`;
    }
    if (inst.monthlyEstimate != null) {
      prompt += ` | On-demand est: $${inst.monthlyEstimate.toFixed(2)}/mo`;
    }
    if (inst.actualMonthlyCost != null) {
      prompt += ` | Actual cost: $${inst.actualMonthlyCost.toFixed(2)}/mo`;
    }
    if (inst.ebsMonthlyCost > 0) {
      prompt += ` | EBS cost: $${inst.ebsMonthlyCost.toFixed(2)}/mo`;
    }

    // Tags for schedule-stop detection
    const envTag = inst.tags["Environment"] || inst.tags["Env"] || inst.tags["env"] || inst.tags["environment"] || "";
    const scheduleTag = inst.tags["Schedule"] || inst.tags["schedule"] || "";
    const purposeTag = inst.tags["Purpose"] || inst.tags["purpose"] || "";
    if (envTag) prompt += ` | env=${envTag}`;
    if (scheduleTag) prompt += ` | schedule=${scheduleTag}`;
    if (purposeTag) prompt += ` | purpose=${purposeTag}`;

    prompt += ` | Launched: ${inst.launchTime}`;
    prompt += `\n`;
  }

  prompt += `\nProvide your cost savings recommendations as a JSON array.`;
  return prompt;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "N/A";
  if (bytes < 1024) return `${bytes.toFixed(0)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Deduplicates recommendations for the same resource to prevent inflated totals.
 * - stop/idle subsumes right-size, graviton, schedule-stop, generation-upgrade (but NOT stopped-ebs)
 * - right-size + graviton overlap: zero out the smaller saving
 * - Same resource + same category: keep first occurrence
 * Note: AMI/snapshot overlap is already handled in generateDeterministicRecs.
 */
function deduplicateRecommendations(recs: Recommendation[]): Recommendation[] {
  const byResource = new Map<string, Recommendation[]>();
  for (const rec of recs) {
    if (!rec.instanceId) continue;
    if (!byResource.has(rec.instanceId)) byResource.set(rec.instanceId, []);
    byResource.get(rec.instanceId)!.push(rec);
  }

  const result: Recommendation[] = [];

  for (const [, group] of byResource) {
    // Deduplicate same resource + same category (keep first)
    const uniqueByCategory: Recommendation[] = [];
    const catSeen = new Set<string>();
    for (const rec of group) {
      const catKey = `${rec.instanceId}:${rec.category}`;
      if (catSeen.has(catKey)) continue;
      catSeen.add(catKey);
      uniqueByCategory.push(rec);
    }

    const hasStop = uniqueByCategory.some((r) => r.category === "stop" || r.category === "idle");

    if (hasStop) {
      // Stop/idle subsumes compute-related recs but keep storage recs
      for (const rec of uniqueByCategory) {
        if (["stop", "idle", "stopped-ebs", "ebs-optimize", "ebs-iops-optimize", "orphan-ebs"].includes(rec.category)) {
          result.push(rec);
        }
      }
      continue;
    }

    // Handle right-size + graviton overlap: zero out the smaller saving
    const rightSize = uniqueByCategory.find((r) => r.category === "right-size");
    const graviton = uniqueByCategory.find((r) => r.category === "graviton-migrate");
    if (rightSize && graviton) {
      if (rightSize.estimatedSavings >= graviton.estimatedSavings) {
        graviton.estimatedSavings = 0;
      } else {
        rightSize.estimatedSavings = 0;
      }
    }

    result.push(...uniqueByCategory);
  }

  // Add recs with no instanceId (shouldn't happen but be safe)
  for (const rec of recs) {
    if (!rec.instanceId) result.push(rec);
  }

  return result;
}

function parseResponse(response: Anthropic.Message): Recommendation[] {
  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Extract JSON array from the response (Claude might wrap it in markdown)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn("No JSON array found in Claude response:", text.slice(0, 200));
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
    console.warn("Failed to parse Claude response as JSON:", err);
    return [];
  }
}
