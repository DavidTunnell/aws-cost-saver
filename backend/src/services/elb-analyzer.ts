import Anthropic from "@anthropic-ai/sdk";
import type {
  ELBAccountData,
  ELBLoadBalancerData,
} from "../aws/elb-collector";
import type { TargetGroupInfo } from "../aws/elb";
import type { Recommendation } from "./analyzer";

// Re-export for convenience
export type { Recommendation };

// ─── Deterministic helpers ──────────────────────────────────────────────────

function getSeverity(savings: number): "high" | "medium" | "low" {
  if (savings > 50) return "high";
  if (savings >= 10) return "medium";
  return "low";
}

const ONE_GB = 1024 * 1024 * 1024;

function getLBTypeLabel(type: string): string {
  switch (type) {
    case "alb":
      return "Application Load Balancer";
    case "nlb":
      return "Network Load Balancer";
    case "gwlb":
      return "Gateway Load Balancer";
    case "clb":
      return "Classic Load Balancer";
    default:
      return "Load Balancer";
  }
}

// ─── Deterministic recommendations (6 categories) ───────────────────────────

function generateELBDeterministicRecs(
  data: ELBAccountData
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const lb of data.loadBalancers) {
    const m = lb.metrics;
    const typeLabel = getLBTypeLabel(lb.type);
    const nameTag = lb.tags["Name"] || lb.name;

    // Track which rules fire for deduplication
    let isIdle = false;
    let hasNoTargets = false;

    // ─── Rule 1: elb-idle — zero traffic AND zero healthy targets ─────────
    {
      // Guard: only flag idle if CloudWatch actually returned data.
      // metricsCollected=false means API failure — can't distinguish from zero traffic.
      if (m.metricsCollected) {
        let trafficIsZero = false;

        if (lb.type === "alb" || lb.type === "clb") {
          trafficIsZero =
            (m.requestCountSum === null || m.requestCountSum === 0) &&
            (m.healthyHostCountAvg === null || m.healthyHostCountAvg === 0);
        } else if (lb.type === "nlb") {
          trafficIsZero =
            (m.activeFlowCountAvg === null || m.activeFlowCountAvg === 0) &&
            (m.newFlowCountSum === null || m.newFlowCountSum === 0) &&
            (m.healthyHostCountAvg === null || m.healthyHostCountAvg === 0);
        } else {
          // GWLB — use ProcessedBytes (GWLB doesn't publish flow counts like NLB)
          trafficIsZero =
            (m.processedBytesSum === null || m.processedBytesSum === 0) &&
            (m.healthyHostCountAvg === null || m.healthyHostCountAvg === 0);
        }

        if (trafficIsZero) {
          isIdle = true;
          const savings = lb.currentMonthlyCost;
          if (savings > 0) {
            const costNote = lb.costIsActual
              ? ""
              : " (estimated from hourly rate)";

            recs.push({
              instanceId: lb.id,
              instanceName: nameTag,
              instanceType: `${lb.type.toUpperCase()} (${lb.scheme})`,
              category: "elb-idle",
              severity: getSeverity(savings),
              currentMonthlyCost: lb.currentMonthlyCost,
              estimatedSavings: savings,
              action: `Delete idle ${typeLabel} "${lb.name}" — zero traffic and zero healthy targets over 14 days`,
              reasoning: `${typeLabel} "${lb.name}" has had no requests/flows and no healthy targets for the monitoring period but costs $${savings.toFixed(2)}/mo.${costNote} If the load balancer is no longer needed, deleting it will eliminate the fixed hourly charge.`,
            });
          }
        }
      }
    }

    // ─── Rule 2: elb-low-traffic — <100 requests/day average ──────────────
    if (!isIdle) {
      let isLowTraffic = false;
      let trafficDesc = "";

      if (lb.type === "alb" || lb.type === "clb") {
        if (
          m.requestCountSum !== null &&
          m.requestCountSum > 0 &&
          m.requestCountSum < 1400 // ~100/day × 14 days
        ) {
          isLowTraffic = true;
          const avgPerDay = Math.round(m.requestCountSum / 14);
          trafficDesc = `${avgPerDay} requests/day avg (${m.requestCountSum.toLocaleString()} total in 14 days)`;
        }
      } else if (lb.type === "nlb") {
        if (
          m.newFlowCountSum !== null &&
          m.newFlowCountSum > 0 &&
          m.newFlowCountSum < 1400
        ) {
          isLowTraffic = true;
          const avgPerDay = Math.round(m.newFlowCountSum / 14);
          trafficDesc = `${avgPerDay} new flows/day avg (${m.newFlowCountSum.toLocaleString()} total in 14 days)`;
        }
      }

      if (isLowTraffic) {
        // Fixed cost dominates at low traffic — full cost recoverable if removed
        const savings = lb.currentMonthlyCost;
        if (savings > 1) {
          recs.push({
            instanceId: lb.id,
            instanceName: nameTag,
            instanceType: `${lb.type.toUpperCase()} (${lb.scheme})`,
            category: "elb-low-traffic",
            severity: "medium",
            currentMonthlyCost: lb.currentMonthlyCost,
            estimatedSavings: savings,
            action: `Review low-traffic ${typeLabel} "${lb.name}" — only ${trafficDesc}. Consider consolidating with another LB or removing if no longer needed.`,
            reasoning: `${typeLabel} "${lb.name}" processes very little traffic but incurs $${lb.currentMonthlyCost.toFixed(2)}/mo in fixed charges. At this volume, the workload may be better served by consolidating into a shared load balancer (using host-based or path-based routing on ALB), or the LB may no longer be needed.`,
          });
        }
      }
    }

    // ─── Rule 3: elb-no-targets — LB with zero registered targets ─────────
    if (!isIdle && lb.totalTargets === 0 && lb.type !== "clb") {
      hasNoTargets = true;
      const savings = lb.currentMonthlyCost;
      if (savings > 0) {
        recs.push({
          instanceId: lb.id,
          instanceName: nameTag,
          instanceType: `${lb.type.toUpperCase()} (${lb.scheme})`,
          category: "elb-no-targets",
          severity: getSeverity(savings),
          currentMonthlyCost: lb.currentMonthlyCost,
          estimatedSavings: savings,
          action: `Investigate ${typeLabel} "${lb.name}" — has ${lb.targetGroupCount} target group(s) but zero registered targets. Requests are returning 503 errors.`,
          reasoning: `${typeLabel} "${lb.name}" has no registered targets in any of its target groups. This means all incoming requests receive 503 errors. The LB costs $${savings.toFixed(2)}/mo. Either register targets or delete the load balancer if it's no longer needed.`,
        });
      }
    }

    // For CLB, check instanceCount instead
    if (
      !isIdle &&
      lb.type === "clb" &&
      lb.totalTargets === 0
    ) {
      hasNoTargets = true;
      const savings = lb.currentMonthlyCost;
      if (savings > 0) {
        recs.push({
          instanceId: lb.id,
          instanceName: nameTag,
          instanceType: "CLB",
          category: "elb-no-targets",
          severity: getSeverity(savings),
          currentMonthlyCost: lb.currentMonthlyCost,
          estimatedSavings: savings,
          action: `Investigate Classic Load Balancer "${lb.name}" — zero registered instances.`,
          reasoning: `Classic Load Balancer "${lb.name}" has no registered instances. The LB costs $${savings.toFixed(2)}/mo and is serving no backend. Either register instances or delete it.`,
        });
      }
    }

    // ─── Rule 4: elb-classic-migrate — CLB detected ───────────────────────
    if (lb.type === "clb" && !isIdle) {
      // CLB hourly rate is $0.025 vs ALB/NLB $0.0225 — small fixed savings
      const fixedSavings = (0.025 - 0.0225) * 730; // ~$1.83/mo
      recs.push({
        instanceId: lb.id,
        instanceName: nameTag,
        instanceType: "CLB",
        category: "elb-classic-migrate",
        severity: "low",
        currentMonthlyCost: lb.currentMonthlyCost,
        estimatedSavings: fixedSavings,
        action: `Migrate Classic Load Balancer "${lb.name}" to ALB or NLB — CLBs are previous generation with limited features and slightly higher hourly cost.`,
        reasoning: `Classic Load Balancers are a previous generation service. Migrating to ALB (for HTTP/HTTPS) or NLB (for TCP/UDP) provides: lower fixed hourly cost (~$1.83/mo savings), better performance, host/path-based routing (ALB), WebSocket support, and continued AWS feature updates. AWS provides a migration wizard to assist.`,
      });
    }

    // ─── Rule 5: elb-single-az — only 1 AZ configured ────────────────────
    if (!isIdle && lb.availabilityZones.length === 1) {
      recs.push({
        instanceId: lb.id,
        instanceName: nameTag,
        instanceType: `${lb.type.toUpperCase()} (${lb.scheme})`,
        category: "elb-single-az",
        severity: "low",
        currentMonthlyCost: lb.currentMonthlyCost,
        estimatedSavings: 0,
        action: `Add availability zones to ${typeLabel} "${lb.name}" — currently only in ${lb.availabilityZones[0]}. Single-AZ deployment has no redundancy.`,
        reasoning: `${typeLabel} "${lb.name}" is configured in only one AZ (${lb.availabilityZones[0]}). If that AZ experiences issues, the load balancer cannot route traffic. AWS recommends at least 2 AZs for high availability. There is no additional cost for multi-AZ on ALB/CLB; NLB charges for cross-zone data transfer.`,
      });
    }
  }

  // ─── Rule 6: elb-orphaned-target-group — TG with no LB ─────────────────
  for (const tg of data.orphanedTargetGroups) {
    recs.push({
      instanceId: tg.arn,
      instanceName: tg.name,
      instanceType: `Target Group (${tg.targetType})`,
      category: "elb-orphaned-target-group",
      severity: "low",
      currentMonthlyCost: 0,
      estimatedSavings: 0,
      action: `Delete orphaned target group "${tg.name}" — not associated with any load balancer.`,
      reasoning: `Target group "${tg.name}" (${tg.targetType}, port ${tg.port}) is not associated with any load balancer. It has ${tg.totalTargets} registered target(s). Orphaned target groups add configuration clutter and may indicate incomplete cleanup after a deployment change.`,
    });
  }

  return recs;
}

// ─── LLM-only prompt (judgment-based categories) ────────────────────────────

const ELB_SYSTEM_PROMPT = `You are an AWS cost optimization expert. Analyze Elastic Load Balancer data and return JSON recommendations.

Return a JSON array of objects with these fields:
- instanceId (LB ARN or name), instanceName, instanceType, category, severity ("high"/"medium"/"low"), currentMonthlyCost, estimatedSavings, action, reasoning

You ONLY analyze for these categories (all others are handled separately — do NOT generate them):
- "elb-consolidation": Multiple low-traffic load balancers in the same VPC that could be consolidated into a single ALB using host-based or path-based routing rules. Only suggest when multiple LBs exist in the same VPC with similar traffic patterns.
- "elb-architecture": Architecture recommendations such as NLB vs ALB selection mismatch (e.g., NLB being used for HTTP traffic that would be cheaper on ALB), cross-zone load balancing cost implications for NLB, or GWLB optimization opportunities.
- "elb-scheduling": Non-production load balancers (detected via tags like "Environment=dev/staging/test" or name patterns) that run 24/7 but could be shut down during off-hours to save on fixed hourly costs.

Do NOT generate recommendations for: elb-idle, elb-low-traffic, elb-no-targets, elb-classic-migrate, elb-single-az, elb-orphaned-target-group. These are computed separately.
Do NOT generate recommendations for load balancers that have zero traffic — these are already flagged as idle.

Severity: high (>$50/mo savings), medium ($10-50/mo), low (<$10/mo or operational).
estimatedSavings MUST NOT exceed the total ELB cost for the resources involved.
Return ONLY a JSON array. No markdown, no explanation outside the JSON.
If no recommendations, return [].`;

// ─── Main analysis function ─────────────────────────────────────────────────

export async function analyzeELBWithClaude(
  data: ELBAccountData
): Promise<Recommendation[]> {
  // Step 1: Deterministic recs
  const deterministicRecs = generateELBDeterministicRecs(data);

  // Step 2: LLM recs for judgment-based categories
  let llmRecs: Recommendation[] = [];

  if (data.loadBalancers.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn(
        "ANTHROPIC_API_KEY not set — skipping LLM analysis for ELB"
      );
    } else {
      try {
        const client = new Anthropic({ apiKey });
        const prompt = buildELBPrompt(data);
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: ELB_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        });
        llmRecs = parseResponse(response);
      } catch (err: any) {
        console.warn(`ELB LLM analysis failed: ${err.message}`);
      }
    }
  }

  // Step 3: Merge — deterministic wins
  const merged = mergeELBRecommendations(deterministicRecs, llmRecs);

  // Step 4: Deduplicate overlapping recs
  return deduplicateELBRecommendations(merged);
}

// ─── Deduplication ──────────────────────────────────────────────────────────

function deduplicateELBRecommendations(
  recs: Recommendation[]
): Recommendation[] {
  const byResource = new Map<string, Recommendation[]>();
  for (const rec of recs) {
    if (!rec.instanceId) continue;
    if (!byResource.has(rec.instanceId))
      byResource.set(rec.instanceId, []);
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

    const hasIdle = uniqueByCategory.some(
      (r) => r.category === "elb-idle"
    );
    const hasNoTargets = uniqueByCategory.some(
      (r) => r.category === "elb-no-targets"
    );

    if (hasIdle) {
      // Idle = delete it. Suppress all other recs for this LB.
      for (const rec of uniqueByCategory) {
        if (rec.category === "elb-idle") {
          result.push(rec);
        }
      }
      continue;
    }

    if (hasNoTargets) {
      // No targets = should be deleted. Only keep the no-targets rec.
      // Suppress classic-migrate (pointless to migrate a broken LB),
      // single-az, and all LLM recs.
      for (const rec of uniqueByCategory) {
        if (rec.category === "elb-no-targets") {
          result.push(rec);
        }
      }
      continue;
    }

    // Low-traffic: suppress LLM architecture/scheduling recs (consolidation is kept
    // since it's the primary action for low-traffic LBs)
    const hasLowTraffic = uniqueByCategory.some(
      (r) => r.category === "elb-low-traffic"
    );
    if (hasLowTraffic) {
      for (const rec of uniqueByCategory) {
        if (
          rec.category !== "elb-architecture" &&
          rec.category !== "elb-scheduling"
        ) {
          result.push(rec);
        }
      }
      continue;
    }

    result.push(...uniqueByCategory);
  }

  // Preserve recs with no instanceId
  for (const rec of recs) {
    if (!rec.instanceId) result.push(rec);
  }

  // Cumulative savings cap per resource: if total savings > cost, scale all recs
  // proportionally so sum = cost. This works because each rec gets multiplied by
  // (cost / totalSavings), and sum of (savings_i * cost/total) = cost.
  const resourceSavings = new Map<string, number>();
  for (const rec of result) {
    if (!rec.instanceId) continue;
    resourceSavings.set(
      rec.instanceId,
      (resourceSavings.get(rec.instanceId) || 0) + rec.estimatedSavings
    );
  }

  for (const rec of result) {
    if (!rec.instanceId) continue;
    const totalSavings = resourceSavings.get(rec.instanceId) || 0;
    if (totalSavings > rec.currentMonthlyCost && rec.currentMonthlyCost > 0) {
      const scale = rec.currentMonthlyCost / totalSavings;
      rec.estimatedSavings =
        Math.round(rec.estimatedSavings * scale * 100) / 100;
    }
  }

  return result;
}

// ─── LLM helpers ────────────────────────────────────────────────────────────

function mergeELBRecommendations(
  deterministic: Recommendation[],
  llm: Recommendation[]
): Recommendation[] {
  const deterministicCategories = new Set([
    "elb-idle",
    "elb-low-traffic",
    "elb-no-targets",
    "elb-classic-migrate",
    "elb-single-az",
    "elb-orphaned-target-group",
  ]);

  // Filter out any LLM recs that overlap with deterministic categories
  const filteredLlm = llm.filter(
    (r) => !deterministicCategories.has(r.category)
  );

  // Cap LLM savings
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

function buildELBPrompt(data: ELBAccountData): string {
  let prompt = `Analyze the following Elastic Load Balancer infrastructure for cost savings.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n`;
  prompt += `Total ELB cost: $${data.accountSummary.totalMonthlyCost.toFixed(2)}/mo\n`;
  prompt += `Summary: ${data.accountSummary.totalALBs} ALBs, ${data.accountSummary.totalNLBs} NLBs, ${data.accountSummary.totalCLBs} CLBs, ${data.accountSummary.totalGWLBs} GWLBs\n\n`;

  prompt += `## Load Balancers (${data.loadBalancers.length})\n\n`;

  for (const lb of data.loadBalancers) {
    prompt += `- **${lb.name}** | Type: ${lb.type.toUpperCase()} | Scheme: ${lb.scheme}`;
    prompt += ` | VPC: ${lb.vpcId} | AZs: ${lb.availabilityZones.join(", ")}`;
    prompt += ` | Cost: $${lb.currentMonthlyCost.toFixed(2)}/mo${lb.costIsActual ? " (actual)" : " (estimated)"}`;

    // Targets
    prompt += ` | Targets: ${lb.healthyTargets} healthy, ${lb.unhealthyTargets} unhealthy (${lb.totalTargets} total)`;
    if (lb.targetGroupCount > 0) {
      prompt += ` in ${lb.targetGroupCount} TGs`;
    }

    // Metrics
    if (lb.type === "alb" || lb.type === "clb") {
      if (lb.metrics.requestCountSum != null) {
        prompt += ` | Requests: ${lb.metrics.requestCountSum.toLocaleString()} in 14d`;
      }
    }
    if (lb.type === "nlb") {
      if (lb.metrics.newFlowCountSum != null) {
        prompt += ` | NewFlows: ${lb.metrics.newFlowCountSum.toLocaleString()} in 14d`;
      }
      if (lb.metrics.activeFlowCountAvg != null) {
        prompt += ` | ActiveFlows avg: ${lb.metrics.activeFlowCountAvg.toFixed(0)}`;
      }
    }

    if (lb.metrics.processedBytesSum != null) {
      const gb = lb.metrics.processedBytesSum / ONE_GB;
      prompt += ` | Processed: ${gb.toFixed(3)}GB in 14d`;
    }

    if (lb.metrics.consumedLCUsAvg != null) {
      prompt += ` | LCU avg: ${lb.metrics.consumedLCUsAvg.toFixed(2)}`;
    }

    if (lb.metrics.activeConnectionsAvg != null) {
      prompt += ` | Connections avg: ${lb.metrics.activeConnectionsAvg.toFixed(0)}, max: ${lb.metrics.activeConnectionsMax?.toFixed(0) ?? "N/A"}`;
    }

    // Tags
    const name = lb.tags["Name"];
    const env = lb.tags["Environment"] || lb.tags["environment"] || lb.tags["env"];
    if (name && name !== lb.name) prompt += ` | Name: ${name}`;
    if (env) prompt += ` | Env: ${env}`;

    prompt += `\n`;
  }

  if (data.orphanedTargetGroups.length > 0) {
    prompt += `\n## Orphaned Target Groups (${data.orphanedTargetGroups.length})\n\n`;
    for (const tg of data.orphanedTargetGroups) {
      prompt += `- ${tg.name} | Type: ${tg.targetType} | Port: ${tg.port} | Targets: ${tg.totalTargets}\n`;
    }
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
      "No JSON array found in ELB Claude response:",
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
    console.warn("Failed to parse ELB Claude response as JSON:", err);
    return [];
  }
}
