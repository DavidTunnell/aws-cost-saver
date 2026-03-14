import Anthropic from "@anthropic-ai/sdk";

export interface DbRecommendation {
  id: number;
  audit_id: number;
  instance_id: string;
  instance_name: string;
  instance_type: string;
  category: string;
  severity: string;
  current_monthly_cost: number;
  estimated_savings: number;
  action: string;
  details: string;
}

export interface DedupResult {
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

// ─── Deterministic dedup pass ────────────────────────────────────────────────
// Mirrors the subsumption logic from analyzer.ts:409-462 so cross-audit
// recommendations for the same resource don't double-count savings.

const STORAGE_CATEGORIES = new Set([
  "stopped-ebs", "ebs-optimize", "ebs-iops-optimize", "orphan-ebs",
  "snapshot-cleanup", "unused-ami",
]);

const COMPUTE_CATEGORIES = new Set([
  "right-size", "graviton-migrate", "schedule-stop", "generation-upgrade",
  "reserved-instance", "savings-plan",
]);

function deterministicDedup(recs: DbRecommendation[]): DbRecommendation[] {
  // Step 1: Remove exact duplicates (same instance_id + same category → keep highest savings)
  const sorted = [...recs].sort((a, b) => b.estimated_savings - a.estimated_savings);
  const seenKeys = new Set<string>();
  const unique: DbRecommendation[] = [];

  for (const rec of sorted) {
    const key = `${rec.instance_id}::${rec.category}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    unique.push(rec);
  }

  // Step 2: Apply cross-category subsumption rules per resource
  const byResource = new Map<string, DbRecommendation[]>();
  for (const rec of unique) {
    const key = rec.instance_id || `__no_id_${rec.id}`;
    if (!byResource.has(key)) byResource.set(key, []);
    byResource.get(key)!.push(rec);
  }

  const result: DbRecommendation[] = [];

  for (const [, group] of byResource) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    const hasStop = group.some((r) => r.category === "stop" || r.category === "idle");

    if (hasStop) {
      // Stop/idle subsumes all compute-related recs; keep stop/idle + storage recs only
      for (const rec of group) {
        if (rec.category === "stop" || rec.category === "idle" || STORAGE_CATEGORIES.has(rec.category)) {
          result.push(rec);
        }
        // Drop: right-size, graviton-migrate, schedule-stop, generation-upgrade, RI, SP
      }
      continue;
    }

    // Handle right-size + graviton overlap: zero out the smaller saving
    const rightSize = group.find((r) => r.category === "right-size");
    const graviton = group.find((r) => r.category === "graviton-migrate");
    if (rightSize && graviton) {
      if (rightSize.estimated_savings >= graviton.estimated_savings) {
        graviton.estimated_savings = 0;
      } else {
        rightSize.estimated_savings = 0;
      }
    }

    // Handle schedule-stop + reserved-instance/savings-plan conflict
    const scheduleStop = group.find((r) => r.category === "schedule-stop");
    const ri = group.find((r) => r.category === "reserved-instance" || r.category === "savings-plan");
    if (scheduleStop && ri) {
      // These are mutually exclusive strategies — keep the higher savings, zero the other
      if (scheduleStop.estimated_savings >= ri.estimated_savings) {
        ri.estimated_savings = 0;
      } else {
        scheduleStop.estimated_savings = 0;
      }
    }

    result.push(...group);
  }

  return result;
}

// ─── LLM dedup pass ─────────────────────────────────────────────────────────

const DEDUP_SYSTEM_PROMPT = `You are an AWS cost optimization expert reviewing recommendations from multiple audit services (EC2, RDS, S3, Lambda, DynamoDB, NAT Gateway, Load Balancers).

Your task: identify OVERLAPPING or DUPLICATE recommendations where the same underlying savings would be double-counted across services.

Known cross-service overlaps to check:
- EC2 stop/terminate → may also reduce NAT Gateway data processing costs and ELB target costs. If both an EC2 "stop" rec and a NAT "reduce traffic" rec exist because stopping the instance eliminates its traffic, the NAT savings may be partially or fully subsumed.
- ELB idle/consolidation → check if the EC2 targets behind it also have stop/right-size recs. Don't double-count instance-level savings with load balancer-level savings for the same workload.
- Lambda + DynamoDB: if Lambda invocations are being reduced/eliminated, associated DynamoDB read/write capacity savings driven by that Lambda may overlap.
- NAT Gateway + EC2: stopping EC2 instances reduces NAT traffic. Don't count both the EC2 compute savings and the full NAT data processing savings if the NAT savings are caused by the EC2 stoppage.
- ELB consolidation may render individual ELB idle recommendations redundant.

IMPORTANT: When in doubt, do NOT remove. Only remove when you are confident the savings genuinely overlap. It is better to slightly over-count than to accidentally eliminate a real, independent recommendation.

For each group of overlapping recommendations, keep the one with the highest estimated_savings and mark the rest for removal.

Return a JSON array of recommendation IDs (the "id" field) to REMOVE.
If no overlaps found, return [].
Return ONLY a JSON array of numbers. No markdown, no explanation.`;

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[Full Audit] No ANTHROPIC_API_KEY — skipping LLM pass");
    return null;
  }
  return new Anthropic({ apiKey });
}

async function llmDedup(recs: DbRecommendation[]): Promise<number[]> {
  if (recs.length <= 1) return [];

  const client = getAnthropicClient();
  if (!client) return [];

  // Group by instance_id for the prompt to make overlaps visible
  const byResource = new Map<string, DbRecommendation[]>();
  for (const rec of recs) {
    const key = rec.instance_id || "no-id";
    if (!byResource.has(key)) byResource.set(key, []);
    byResource.get(key)!.push(rec);
  }

  // Only send resources that have multiple recommendations (potential overlaps)
  const multiRecResources = [...byResource.entries()].filter(([, group]) => group.length > 1);
  if (multiRecResources.length === 0) return [];

  let prompt = `Review these recommendations grouped by resource for cross-service overlaps.\n\n`;
  for (const [resourceId, group] of multiRecResources) {
    prompt += `## Resource: ${resourceId}\n`;
    for (const rec of group) {
      let reasoning = "";
      try { reasoning = JSON.parse(rec.details).reasoning || ""; } catch {}
      prompt += `- id=${rec.id} | category=${rec.category} | severity=${rec.severity}`;
      prompt += ` | savings=$${rec.estimated_savings.toFixed(2)}/mo | action: ${rec.action}`;
      if (reasoning) prompt += ` | reasoning: ${reasoning}`;
      prompt += `\n`;
    }
    prompt += `\n`;
  }
  prompt += `Return a JSON array of recommendation IDs to remove (the duplicates/overlaps).`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: DEDUP_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id: unknown) => typeof id === "number");
  } catch (err) {
    console.warn("[Full Audit] LLM dedup failed, continuing without:", err);
    return [];
  }
}

// ─── Cross-service synthesis pass ────────────────────────────────────────────
// Generates NEW recommendations only visible from the combined full-audit view.

const SYNTHESIS_SYSTEM_PROMPT = `You are an AWS cost optimization expert. You have been given the deduplicated recommendations from a full cross-service audit. Your job is to identify NEW cost-saving opportunities that are only visible when looking across multiple services together.

Examples of cross-service synthesis:
- Multiple NAT Gateways in the same region could be consolidated if the VPCs they serve could be peered
- Lambda functions and DynamoDB tables that serve the same workload could benefit from provisioned throughput plans
- Multiple idle load balancers in the same VPC could be consolidated into one with path-based routing
- EC2 instances across multiple services using the same patterns could benefit from a Savings Plan commitment

ONLY generate recommendations that require cross-service visibility. Do not repeat or rephrase existing recommendations.

Return a JSON array of objects with: instanceId (primary resource ARN/ID), instanceName, instanceType (service name), category ("cross-service"), severity ("high"/"medium"/"low"), currentMonthlyCost, estimatedSavings, action, reasoning.

If no cross-service opportunities exist, return [].
Return ONLY a JSON array. No markdown, no explanation.`;

async function synthesizeCrossServiceRecs(recs: DbRecommendation[]): Promise<DedupResult[]> {
  if (recs.length < 2) return [];

  const client = getAnthropicClient();
  if (!client) return [];

  // Build a summary of all recommendations grouped by service/category
  const byCategory = new Map<string, DbRecommendation[]>();
  for (const rec of recs) {
    if (!byCategory.has(rec.category)) byCategory.set(rec.category, []);
    byCategory.get(rec.category)!.push(rec);
  }

  let prompt = `Here are the deduplicated recommendations from a full AWS audit across all services:\n\n`;
  for (const [category, group] of byCategory) {
    prompt += `## ${category} (${group.length} recommendations)\n`;
    for (const rec of group.slice(0, 20)) { // Cap per category to keep prompt manageable
      prompt += `- ${rec.instance_id} "${rec.instance_name}" | $${rec.estimated_savings.toFixed(2)}/mo | ${rec.action}\n`;
    }
    if (group.length > 20) {
      prompt += `- ... and ${group.length - 20} more\n`;
    }
    prompt += `\n`;
  }
  prompt += `Identify any NEW cross-service cost-saving opportunities.`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYNTHESIS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((item: any) => ({
      instanceId: item.instanceId || "",
      instanceName: item.instanceName || "",
      instanceType: item.instanceType || "",
      category: "cross-service",
      severity: item.severity || "medium",
      currentMonthlyCost: Number(item.currentMonthlyCost) || 0,
      estimatedSavings: Number(item.estimatedSavings) || 0,
      action: item.action || "",
      reasoning: item.reasoning || "",
    }));
  } catch (err) {
    console.warn("[Full Audit] Cross-service synthesis failed, continuing without:", err);
    return [];
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function deduplicateFullAudit(recs: DbRecommendation[]): Promise<DedupResult[]> {
  // Pass 1: deterministic dedup (exact matches + subsumption rules)
  const afterDeterministic = deterministicDedup(recs);
  console.log(`[Full Audit] Deterministic dedup: ${recs.length} → ${afterDeterministic.length} recommendations`);

  // Pass 2: LLM dedup (cross-service overlaps the rules can't catch)
  const idsToRemove = await llmDedup(afterDeterministic);
  const removeSet = new Set(idsToRemove);
  console.log(`[Full Audit] LLM dedup: removing ${removeSet.size} overlapping recommendations`);

  const afterLlmDedup = afterDeterministic.filter((r) => !removeSet.has(r.id));

  // Pass 3: Cross-service synthesis (generate NEW cross-cutting recommendations)
  const synthesized = await synthesizeCrossServiceRecs(afterLlmDedup);
  console.log(`[Full Audit] Cross-service synthesis: ${synthesized.length} new recommendations`);

  // Convert DB format to output format
  const dedupedResults: DedupResult[] = afterLlmDedup.map((r) => {
    let reasoning = "";
    let metadata: Record<string, string> | undefined;
    try {
      const parsed = JSON.parse(r.details);
      reasoning = parsed.reasoning || "";
      metadata = parsed.metadata;
    } catch {}
    return {
      instanceId: r.instance_id,
      instanceName: r.instance_name,
      instanceType: r.instance_type,
      category: r.category,
      severity: r.severity,
      currentMonthlyCost: r.current_monthly_cost,
      estimatedSavings: r.estimated_savings,
      action: r.action,
      reasoning,
      metadata,
    };
  });

  return [...dedupedResults, ...synthesized];
}
