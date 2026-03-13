import Anthropic from "@anthropic-ai/sdk";
import type { ECSAccountData, ECSServiceData } from "../aws/ecs-collector";
import {
  FARGATE_VCPU_HOURLY,
  FARGATE_MEMORY_GB_HOURLY,
  FARGATE_SPOT_DISCOUNT,
  FARGATE_GRAVITON_DISCOUNT,
} from "../aws/ecs-collector";
import type { Recommendation } from "./analyzer";

export type { Recommendation };

// ─── Deterministic helpers ───────────────────────────────────────────────────

function getSeverity(savings: number): "high" | "medium" | "low" {
  if (savings > 50) return "high";
  if (savings >= 10) return "medium";
  return "low";
}

// Valid Fargate CPU/memory combos for right-sizing suggestions
const FARGATE_CPU_MEMORY_COMBOS: Array<{ cpu: number; minMem: number; maxMem: number }> = [
  { cpu: 256, minMem: 512, maxMem: 2048 },
  { cpu: 512, minMem: 1024, maxMem: 4096 },
  { cpu: 1024, minMem: 2048, maxMem: 8192 },
  { cpu: 2048, minMem: 4096, maxMem: 16384 },
  { cpu: 4096, minMem: 8192, maxMem: 30720 },
];

function isNonProd(svc: ECSServiceData): boolean {
  const name = svc.serviceName.toLowerCase();
  const cluster = svc.clusterName.toLowerCase();
  const envTag = (svc.tags["Environment"] || svc.tags["environment"] || svc.tags["env"] || "").toLowerCase();

  const nonProdPatterns = [
    "dev", "development", "test", "testing", "staging", "stage",
    "qa", "uat", "sandbox", "demo", "preview", "nonprod", "non-prod",
    "perf", "load-test", "canary", "ephemeral", "temp", "tmp",
  ];
  return nonProdPatterns.some(
    (p) => name.includes(p) || cluster.includes(p) || envTag.includes(p)
  );
}

// ─── Deterministic recommendations (7 categories) ───────────────────────────

function generateECSDeterministicRecs(data: ECSAccountData): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const svc of data.services) {
    const isFargate = svc.launchType === "FARGATE";
    const cpuAvg = svc.metrics.cpuUtilizationAvg;
    const cpuMax = svc.metrics.cpuUtilizationMax;
    const memAvg = svc.metrics.memoryUtilizationAvg;
    const memMax = svc.metrics.memoryUtilizationMax;

    // 1. ecs-idle-service: desiredCount > 0 AND (runningCount = 0 OR zero CPU+Memory 14d)
    if (svc.desiredCount > 0) {
      const isIdle =
        svc.runningCount === 0 ||
        ((cpuAvg === null || cpuAvg < 1.0) && (memAvg === null || memAvg < 1.0));

      if (isIdle) {
        recs.push({
          instanceId: svc.serviceName,
          instanceName: `${svc.clusterName}/${svc.serviceName}`,
          instanceType: `${svc.launchType} / ${svc.taskCpu}cpu / ${svc.taskMemory}MB`,
          category: "ecs-idle-service",
          severity: svc.currentMonthlyCost > 0 ? getSeverity(svc.currentMonthlyCost) : "low",
          currentMonthlyCost: svc.currentMonthlyCost,
          estimatedSavings: svc.currentMonthlyCost,
          action: `Scale down or remove idle service "${svc.serviceName}" in cluster "${svc.clusterName}" — ${svc.runningCount === 0 ? "no running tasks" : "near-zero utilization"} over 14 days`,
          reasoning: `Service has ${svc.desiredCount} desired tasks but ${svc.runningCount === 0 ? "none are running" : `CPU avg ${cpuAvg?.toFixed(1) ?? "N/A"}% and memory avg ${memAvg?.toFixed(1) ?? "N/A"}%`}. Costing $${svc.currentMonthlyCost.toFixed(2)}/mo with no meaningful work.`,
        });
        continue; // Idle suppresses all other recs
      }
    }

    // 2. ecs-stopped-service: desiredCount = 0 (operational cleanup)
    if (svc.desiredCount === 0) {
      recs.push({
        instanceId: svc.serviceName,
        instanceName: `${svc.clusterName}/${svc.serviceName}`,
        instanceType: `${svc.launchType} / ${svc.taskCpu}cpu / ${svc.taskMemory}MB`,
        category: "ecs-stopped-service",
        severity: "low",
        currentMonthlyCost: 0,
        estimatedSavings: 0,
        action: `Clean up stopped service "${svc.serviceName}" in cluster "${svc.clusterName}" — desired count is 0`,
        reasoning: `Service is scaled to zero tasks. If no longer needed, delete the service and its task definition to reduce clutter. No active cost but creates operational overhead.`,
      });
      // Do NOT continue — stopped services can still get other recs (they're $0)
    }

    // Skip remaining checks for stopped services (they have no cost to optimize)
    if (svc.desiredCount === 0) continue;

    // 3. ecs-over-provisioned-cpu: cpuUtilAvg < 30% AND cpuUtilMax < 60%
    if (
      isFargate &&
      cpuAvg != null &&
      cpuMax != null &&
      cpuAvg < 30 &&
      cpuMax < 60
    ) {
      // Find the next lower valid Fargate CPU tier
      const currentCpuIndex = FARGATE_CPU_MEMORY_COMBOS.findIndex(
        (c) => c.cpu === svc.taskCpu
      );
      if (currentCpuIndex > 0) {
        const suggestedTier = FARGATE_CPU_MEMORY_COMBOS[currentCpuIndex - 1];
        // Only suggest if current memory fits in the lower CPU tier
        if (svc.taskMemory <= suggestedTier.maxMem && svc.taskMemory >= suggestedTier.minMem) {
          const currentCpuCost =
            (svc.taskCpu / 1024) * FARGATE_VCPU_HOURLY * 730 * svc.desiredCount;
          const newCpuCost =
            (suggestedTier.cpu / 1024) * FARGATE_VCPU_HOURLY * 730 * svc.desiredCount;
          const savings = currentCpuCost - newCpuCost;

          if (savings > 1) {
            recs.push({
              instanceId: svc.serviceName,
              instanceName: `${svc.clusterName}/${svc.serviceName}`,
              instanceType: `${svc.launchType} / ${svc.taskCpu}cpu / ${svc.taskMemory}MB`,
              category: "ecs-over-provisioned-cpu",
              severity: getSeverity(savings),
              currentMonthlyCost: svc.currentMonthlyCost,
              estimatedSavings: savings,
              action: `Reduce CPU for "${svc.serviceName}" from ${svc.taskCpu} to ${suggestedTier.cpu} units — avg CPU ${cpuAvg.toFixed(1)}%, max ${cpuMax.toFixed(1)}%`,
              reasoning: `CPU utilization is low (avg ${cpuAvg.toFixed(1)}%, max ${cpuMax.toFixed(1)}%) over 14 days. Reducing from ${svc.taskCpu} to ${suggestedTier.cpu} CPU units saves ~$${savings.toFixed(2)}/mo. Current memory (${svc.taskMemory}MB) is compatible with the lower CPU tier.`,
            });
          }
        } else {
          // Memory blocks the CPU downgrade — inform the user
          recs.push({
            instanceId: svc.serviceName,
            instanceName: `${svc.clusterName}/${svc.serviceName}`,
            instanceType: `${svc.launchType} / ${svc.taskCpu}cpu / ${svc.taskMemory}MB`,
            category: "ecs-over-provisioned-cpu",
            severity: "low",
            currentMonthlyCost: svc.currentMonthlyCost,
            estimatedSavings: 0,
            action: `CPU under-utilized for "${svc.serviceName}" (avg ${cpuAvg.toFixed(1)}%) but current memory (${svc.taskMemory}MB) prevents downsizing to ${suggestedTier.cpu} CPU units. Reduce memory first.`,
            reasoning: `CPU utilization is low (avg ${cpuAvg.toFixed(1)}%, max ${cpuMax.toFixed(1)}%) but memory allocation (${svc.taskMemory}MB) exceeds the ${suggestedTier.cpu} CPU tier max (${suggestedTier.maxMem}MB). Reduce memory to enable CPU downsizing.`,
          });
        }
      }
    }

    // 4. ecs-over-provisioned-memory: memUtilAvg < 30% AND memUtilMax < 60%
    if (
      isFargate &&
      memAvg != null &&
      memMax != null &&
      memAvg < 30 &&
      memMax < 60
    ) {
      // Find current CPU tier to know valid memory range
      const cpuTier = FARGATE_CPU_MEMORY_COMBOS.find(
        (c) => c.cpu === svc.taskCpu
      );
      if (cpuTier) {
        // Suggest halving memory, clamped to valid range
        const suggestedMem = Math.max(
          cpuTier.minMem,
          Math.ceil(svc.taskMemory / 2 / 512) * 512 // Round to 512MB increments
        );

        if (suggestedMem < svc.taskMemory) {
          const currentMemCost =
            (svc.taskMemory / 1024) * FARGATE_MEMORY_GB_HOURLY * 730 * svc.desiredCount;
          const newMemCost =
            (suggestedMem / 1024) * FARGATE_MEMORY_GB_HOURLY * 730 * svc.desiredCount;
          const savings = currentMemCost - newMemCost;

          if (savings > 1) {
            recs.push({
              instanceId: svc.serviceName,
              instanceName: `${svc.clusterName}/${svc.serviceName}`,
              instanceType: `${svc.launchType} / ${svc.taskCpu}cpu / ${svc.taskMemory}MB`,
              category: "ecs-over-provisioned-memory",
              severity: getSeverity(savings),
              currentMonthlyCost: svc.currentMonthlyCost,
              estimatedSavings: savings,
              action: `Reduce memory for "${svc.serviceName}" from ${svc.taskMemory}MB to ${suggestedMem}MB — avg memory ${memAvg.toFixed(1)}%, max ${memMax.toFixed(1)}%`,
              reasoning: `Memory utilization is low (avg ${memAvg.toFixed(1)}%, max ${memMax.toFixed(1)}%) over 14 days. Reducing from ${svc.taskMemory}MB to ${suggestedMem}MB saves ~$${savings.toFixed(2)}/mo within the ${svc.taskCpu} CPU tier's valid range.`,
            });
          }
        }
      }
    }

    // 5. ecs-fargate-spot-candidate: Fargate, no Spot in strategy, non-prod
    if (isFargate && isNonProd(svc)) {
      const hasSpot = (svc.capacityProviderStrategy || []).some(
        (cp) => cp.capacityProvider === "FARGATE_SPOT"
      );
      if (!hasSpot && svc.currentMonthlyCost > 0) {
        const savings = svc.currentMonthlyCost * FARGATE_SPOT_DISCOUNT;
        recs.push({
          instanceId: svc.serviceName,
          instanceName: `${svc.clusterName}/${svc.serviceName}`,
          instanceType: `${svc.launchType} / ${svc.taskCpu}cpu / ${svc.taskMemory}MB`,
          category: "ecs-fargate-spot-candidate",
          severity: getSeverity(savings),
          currentMonthlyCost: svc.currentMonthlyCost,
          estimatedSavings: savings,
          action: `Switch "${svc.serviceName}" to Fargate Spot — up to 70% cost reduction for non-production workloads`,
          reasoning: `Service appears to be non-production (name/tags suggest dev/test/staging). Fargate Spot provides up to 70% discount with 2-minute interruption notice. Suitable for fault-tolerant or non-critical workloads.`,
        });
      }
    }

    // 6. ecs-graviton-migration: Fargate, x86_64 architecture
    if (isFargate && svc.currentMonthlyCost > 0) {
      const arch = svc.runtimePlatform?.cpuArchitecture || "X86_64";
      if (arch === "X86_64" || arch === "x86_64") {
        const savings = svc.currentMonthlyCost * FARGATE_GRAVITON_DISCOUNT;
        if (savings > 1) {
          recs.push({
            instanceId: svc.serviceName,
            instanceName: `${svc.clusterName}/${svc.serviceName}`,
            instanceType: `${svc.launchType} / ${svc.taskCpu}cpu / ${svc.taskMemory}MB / x86_64`,
            category: "ecs-graviton-migration",
            severity: getSeverity(savings),
            currentMonthlyCost: svc.currentMonthlyCost,
            estimatedSavings: savings,
            action: `Migrate "${svc.serviceName}" to ARM64 (Graviton) — ~20% cost reduction`,
            reasoning: `Service uses x86_64 architecture. Fargate Graviton (ARM64) offers ~20% lower pricing with comparable or better performance. Verify container images are ARM-compatible or use multi-arch builds before migrating.`,
          });
        }
      }
    }

    // 7. ecs-over-provisioned-desired-count: desiredCount > 1 AND cpuAvg < 15% AND memAvg < 15%
    if (
      svc.desiredCount > 1 &&
      cpuAvg != null &&
      cpuAvg < 15 &&
      memAvg != null &&
      memAvg < 15
    ) {
      // Suggest reducing by half (minimum 1)
      const suggestedCount = Math.max(1, Math.floor(svc.desiredCount / 2));
      const reduction = svc.desiredCount - suggestedCount;
      if (reduction > 0 && svc.currentMonthlyCost > 0) {
        const savings =
          (svc.currentMonthlyCost / svc.desiredCount) * reduction;
        recs.push({
          instanceId: svc.serviceName,
          instanceName: `${svc.clusterName}/${svc.serviceName}`,
          instanceType: `${svc.launchType} / ${svc.taskCpu}cpu / ${svc.taskMemory}MB / ${svc.desiredCount} tasks`,
          category: "ecs-over-provisioned-desired-count",
          severity: getSeverity(savings),
          currentMonthlyCost: svc.currentMonthlyCost,
          estimatedSavings: savings,
          action: `Reduce task count for "${svc.serviceName}" from ${svc.desiredCount} to ${suggestedCount} — CPU avg ${cpuAvg.toFixed(1)}%, memory avg ${memAvg.toFixed(1)}%`,
          reasoning: `Service runs ${svc.desiredCount} tasks but both CPU (${cpuAvg.toFixed(1)}%) and memory (${memAvg.toFixed(1)}%) utilization are very low. Reducing to ${suggestedCount} tasks saves ~$${savings.toFixed(2)}/mo. Consider adding auto-scaling to handle traffic spikes.`,
        });
      }
    }
  }

  return recs;
}

// ─── LLM prompt (judgment-based categories) ──────────────────────────────────

const ECS_SYSTEM_PROMPT = `You are an AWS cost optimization expert. Analyze ECS/Fargate service metrics and return JSON recommendations.

Return a JSON array of objects with these fields:
- instanceId (service name), instanceName (cluster/service), instanceType, category, severity ("high"/"medium"/"low"), currentMonthlyCost, estimatedSavings, action, reasoning

You ONLY analyze for these categories (all others are handled separately — do NOT generate them):
- "ecs-right-size-tasks": Fine-grained CPU/memory tuning beyond the deterministic 30% threshold. Consider cases where the utilization pattern suggests a different task size configuration.
- "ecs-scheduling": Services that don't need to run 24/7 — dev/test services, batch processors, or services with clear on/off patterns that could use scheduled scaling or be shut down outside business hours.
- "ecs-consolidation": Multiple small services in the same cluster that could be combined into fewer tasks to reduce per-task overhead and Fargate minimum charges.
- "ecs-architecture": Capacity provider strategy improvements, placement optimizations, service mesh overhead reduction, or migration suggestions (e.g., EC2 launch type to Fargate or vice versa based on utilization patterns).

Do NOT generate recommendations for: ecs-idle-service, ecs-over-provisioned-cpu, ecs-over-provisioned-memory, ecs-fargate-spot-candidate, ecs-graviton-migration, ecs-stopped-service, ecs-over-provisioned-desired-count. These are computed separately.
Do NOT generate recommendations for services with desiredCount = 0 — these are already flagged.

Severity: high (>$50/mo savings), medium ($10-50/mo), low (<$10/mo or operational).
estimatedSavings MUST NOT exceed the total ECS cost for the resources involved.
Return ONLY a JSON array. No markdown, no explanation outside the JSON.
If no recommendations, return [].`;

// ─── Main analysis function ──────────────────────────────────────────────────

export async function analyzeECSWithClaude(
  data: ECSAccountData
): Promise<Recommendation[]> {
  // Step 1: Deterministic recs
  const deterministicRecs = generateECSDeterministicRecs(data);

  // Step 2: LLM recs for judgment-based categories
  let llmRecs: Recommendation[] = [];

  // Only call LLM if there are active services (desiredCount > 0)
  const activeServices = data.services.filter((s) => s.desiredCount > 0);

  if (activeServices.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn("ANTHROPIC_API_KEY not set — skipping LLM analysis for ECS");
    } else {
      try {
        const client = new Anthropic({ apiKey });
        const prompt = buildECSPrompt(data, activeServices);
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: ECS_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        });
        llmRecs = parseResponse(response);
        if (llmRecs.length === 0) {
          console.log(
            `[ECS Analyzer] LLM returned 0 recommendations for ${activeServices.length} active services`
          );
        }
      } catch (err: any) {
        console.warn(`ECS LLM analysis failed: ${err.message}`);
      }
    }
  }

  // Step 3: Merge — deterministic wins
  const merged = mergeECSRecommendations(deterministicRecs, llmRecs);

  // Step 4: Deduplicate
  return deduplicateECSRecommendations(merged);
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicateECSRecommendations(
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

    // Idle service suppresses all other recs for that service
    const hasIdle = uniqueByCategory.some(
      (r) => r.category === "ecs-idle-service"
    );
    if (hasIdle) {
      result.push(
        ...uniqueByCategory.filter((r) => r.category === "ecs-idle-service")
      );
      continue;
    }

    // CPU + Memory over-provisioned both kept (independent dimensions)
    // ecs-stopped-service does NOT suppress others (it has $0 savings)
    result.push(...uniqueByCategory);
  }

  // Preserve recs with no instanceId
  for (const rec of recs) {
    if (!rec.instanceId) result.push(rec);
  }

  return result;
}

// ─── LLM helpers ─────────────────────────────────────────────────────────────

function mergeECSRecommendations(
  deterministic: Recommendation[],
  llm: Recommendation[]
): Recommendation[] {
  const deterministicCategories = new Set([
    "ecs-idle-service",
    "ecs-over-provisioned-cpu",
    "ecs-over-provisioned-memory",
    "ecs-fargate-spot-candidate",
    "ecs-graviton-migration",
    "ecs-stopped-service",
    "ecs-over-provisioned-desired-count",
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

function buildECSPrompt(
  data: ECSAccountData,
  activeServices: ECSServiceData[]
): string {
  let prompt = `Analyze the following ECS/Fargate services for cost savings.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n`;
  prompt += `Total ECS cost: $${data.accountSummary.totalMonthlyCost.toFixed(2)}/mo\n`;
  prompt += `Total services: ${data.services.length} (${activeServices.length} active)\n\n`;

  prompt += `## Active ECS Services\n\n`;

  for (const svc of activeServices) {
    prompt += `- **${svc.clusterName}/${svc.serviceName}**`;
    prompt += ` | Launch: ${svc.launchType}`;
    prompt += ` | CPU: ${svc.taskCpu} units | Memory: ${svc.taskMemory}MB`;
    prompt += ` | Tasks: ${svc.desiredCount} desired, ${svc.runningCount} running`;
    prompt += ` | Cost: $${svc.currentMonthlyCost.toFixed(2)}/mo${svc.costIsActual ? " (actual)" : " (est)"}`;

    if (svc.metrics.cpuUtilizationAvg != null) {
      prompt += ` | CPU: avg ${svc.metrics.cpuUtilizationAvg.toFixed(1)}%, max ${svc.metrics.cpuUtilizationMax?.toFixed(1) ?? "N/A"}%`;
    }
    if (svc.metrics.memoryUtilizationAvg != null) {
      prompt += ` | Mem: avg ${svc.metrics.memoryUtilizationAvg.toFixed(1)}%, max ${svc.metrics.memoryUtilizationMax?.toFixed(1) ?? "N/A"}%`;
    }

    const arch = svc.runtimePlatform?.cpuArchitecture || "X86_64";
    prompt += ` | Arch: ${arch}`;

    if (svc.capacityProviderStrategy.length > 0) {
      const cpStr = svc.capacityProviderStrategy
        .map((cp) => `${cp.capacityProvider}(w:${cp.weight})`)
        .join(", ");
      prompt += ` | CapProviders: ${cpStr}`;
    }

    prompt += ` | Containers: ${svc.containerCount}`;

    if (svc.createdAt) prompt += ` | Created: ${svc.createdAt.split("T")[0]}`;

    const tagStr = Object.entries(svc.tags)
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
      "No JSON array found in ECS Claude response:",
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
    console.warn("Failed to parse ECS Claude response as JSON:", err);
    return [];
  }
}
