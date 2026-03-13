import Anthropic from "@anthropic-ai/sdk";
import type {
  NatGatewayAccountData,
  NatGatewayData,
} from "../aws/nat-collector";
import type { Recommendation } from "./analyzer";

// Re-export for convenience
export type { Recommendation };

// ─── Deterministic helpers ──────────────────────────────────────────────────

function getSeverity(savings: number): "high" | "medium" | "low" {
  if (savings > 50) return "high";
  if (savings >= 10) return "medium";
  return "low";
}

const ONE_MB = 1024 * 1024;
const ONE_GB = 1024 * 1024 * 1024;

// ─── Deterministic recommendations (5 categories) ───────────────────────────

function generateNatDeterministicRecs(
  data: NatGatewayAccountData
): Recommendation[] {
  const recs: Recommendation[] = [];

  // 1. nat-idle: Virtually zero traffic over 14 days
  for (const gw of data.gateways) {
    const totalBytes =
      (gw.metrics.bytesOutSum ?? 0) + (gw.metrics.bytesInSum ?? 0);
    if (totalBytes >= ONE_MB) continue; // More than 1MB processed — not idle

    const savings = gw.currentMonthlyCost;
    if (savings <= 0) continue;

    const costNote = gw.costIsActual
      ? ""
      : " (estimate based on $0.045/hr rate; actual cost may differ)";

    recs.push({
      instanceId: gw.natGatewayId,
      instanceName: gw.tags["Name"] || gw.natGatewayId,
      instanceType: "nat-gateway",
      category: "nat-idle",
      severity: getSeverity(savings),
      currentMonthlyCost: savings,
      estimatedSavings: savings,
      action: `Delete idle NAT Gateway ${gw.natGatewayId} in ${gw.vpcId} — virtually zero traffic in 14 days`,
      reasoning: `NAT Gateway processed less than 1MB of data over the monitoring period but costs $${savings.toFixed(2)}/mo (fixed hourly charge alone is ~$32.85/mo).${costNote}`,
    });
  }

  // 2. nat-low-utilization: Less than 1GB/mo of data processed
  for (const gw of data.gateways) {
    const totalBytes =
      (gw.metrics.bytesOutSum ?? 0) + (gw.metrics.bytesInSum ?? 0);
    if (totalBytes < ONE_MB) continue; // Already covered by nat-idle
    if (totalBytes >= ONE_GB) continue; // More than 1GB — not low utilization

    // For low-utilization, savings is the fixed cost minus minimal data processing
    const fixedCost = 0.045 * 730; // ~$32.85/mo
    const dataCost =
      (totalBytes / ONE_GB) * 0.045;
    const savings = fixedCost; // Could eliminate the gateway entirely
    if (savings <= 0) continue;

    const costNote = gw.costIsActual
      ? ""
      : " (estimate based on $0.045/hr rate; actual cost may differ)";
    const dataGb = (totalBytes / ONE_GB).toFixed(3);

    recs.push({
      instanceId: gw.natGatewayId,
      instanceName: gw.tags["Name"] || gw.natGatewayId,
      instanceType: "nat-gateway",
      category: "nat-low-utilization",
      severity: "medium",
      currentMonthlyCost: gw.currentMonthlyCost,
      estimatedSavings: savings,
      action: `Review NAT Gateway ${gw.natGatewayId} — only ${dataGb}GB processed in 14 days. Consider removing if workloads can use VPC endpoints or public subnets instead.`,
      reasoning: `NAT Gateway processes very little data (${dataGb}GB in 14 days) but incurs ~$32.85/mo fixed cost. If the traffic can be routed through VPC endpoints or public subnets, the gateway can be removed.${costNote}`,
    });
  }

  // 3. nat-no-vpc-endpoint: VPC has NAT Gateway but no S3 Gateway Endpoint
  const vpcsWithNat = new Set(data.gateways.map((g) => g.vpcId));
  for (const vpcId of vpcsWithNat) {
    const gatewayServices = data.vpcGatewayEndpoints[vpcId] || [];
    const hasS3Endpoint = gatewayServices.some((s) => s.includes(".s3"));
    const hasDynamoEndpoint = gatewayServices.some((s) =>
      s.includes(".dynamodb")
    );

    const vpcGateways = data.gateways.filter((g) => g.vpcId === vpcId);
    // Estimate: S3/DynamoDB typically account for 10-30% of NAT traffic
    const totalVpcNatCost = vpcGateways.reduce(
      (s, g) => s + g.currentMonthlyCost,
      0
    );
    const totalBytes = vpcGateways.reduce(
      (s, g) =>
        s + (g.metrics.bytesOutSum ?? 0) + (g.metrics.bytesInSum ?? 0),
      0
    );

    if (!hasS3Endpoint && totalBytes > ONE_GB) {
      // Conservative 15% savings estimate for S3 traffic through VPC endpoint
      const savings = totalVpcNatCost * 0.15;
      if (savings <= 0) continue;

      recs.push({
        instanceId: vpcId,
        instanceName: `VPC ${vpcId}`,
        instanceType: "vpc-endpoint",
        category: "nat-no-vpc-endpoint",
        severity: getSeverity(savings),
        currentMonthlyCost: totalVpcNatCost,
        estimatedSavings: savings,
        action: `Create S3 Gateway Endpoint for ${vpcId} — S3 traffic currently routes through NAT Gateway(s) at $0.045/GB`,
        reasoning: `VPC ${vpcId} has ${vpcGateways.length} NAT Gateway(s) costing $${totalVpcNatCost.toFixed(2)}/mo total but no S3 Gateway Endpoint. S3 Gateway Endpoints are free and eliminate NAT data processing charges for S3 traffic (estimated 15% of NAT cost = $${savings.toFixed(2)}/mo savings).`,
      });
    }

    if (!hasDynamoEndpoint && totalBytes > ONE_GB) {
      const savings = totalVpcNatCost * 0.05; // Conservative 5% for DynamoDB
      if (savings < 5) continue; // Skip if savings are trivial

      recs.push({
        instanceId: vpcId,
        instanceName: `VPC ${vpcId}`,
        instanceType: "vpc-endpoint",
        category: "nat-no-vpc-endpoint",
        severity: getSeverity(savings),
        currentMonthlyCost: totalVpcNatCost,
        estimatedSavings: savings,
        action: `Create DynamoDB Gateway Endpoint for ${vpcId} — DynamoDB traffic currently routes through NAT Gateway(s)`,
        reasoning: `VPC ${vpcId} has NAT Gateway(s) but no DynamoDB Gateway Endpoint. DynamoDB Gateway Endpoints are free and eliminate NAT data processing charges for DynamoDB traffic (estimated $${savings.toFixed(2)}/mo savings).`,
      });
    }
  }

  // 4. nat-redundant-az: Multiple NAT Gateways in same VPC, each with low utilization
  const byVpc = new Map<string, NatGatewayData[]>();
  for (const gw of data.gateways) {
    if (!byVpc.has(gw.vpcId)) byVpc.set(gw.vpcId, []);
    byVpc.get(gw.vpcId)!.push(gw);
  }

  for (const [vpcId, vpcGws] of byVpc) {
    if (vpcGws.length < 2) continue;

    // Check if ALL gateways in this VPC are low utilization
    const allLowUtil = vpcGws.every((gw) => {
      const totalBytes =
        (gw.metrics.bytesOutSum ?? 0) + (gw.metrics.bytesInSum ?? 0);
      return totalBytes < 5 * ONE_GB; // Less than 5GB each in 14 days
    });

    if (!allLowUtil) continue;

    // Could consolidate to 1 NAT Gateway
    const totalCost = vpcGws.reduce(
      (s, g) => s + g.currentMonthlyCost,
      0
    );
    const savings = totalCost - vpcGws[0].currentMonthlyCost; // Save all but one
    if (savings <= 0) continue;

    recs.push({
      instanceId: vpcId,
      instanceName: `VPC ${vpcId}`,
      instanceType: `${vpcGws.length} nat-gateways`,
      category: "nat-redundant-az",
      severity: getSeverity(savings),
      currentMonthlyCost: totalCost,
      estimatedSavings: savings,
      action: `Consider consolidating ${vpcGws.length} low-utilization NAT Gateways in ${vpcId} to a single gateway`,
      reasoning: `VPC ${vpcId} has ${vpcGws.length} NAT Gateways (${vpcGws.map((g) => g.natGatewayId).join(", ")}), each processing less than 5GB in 14 days. Total cost is $${totalCost.toFixed(2)}/mo. Consolidating to one could save $${savings.toFixed(2)}/mo. Note: this reduces AZ redundancy — acceptable for non-production workloads.`,
    });
  }

  // 5. nat-high-error-rate: Port allocation errors or packet drops
  for (const gw of data.gateways) {
    const errorPort = gw.metrics.errorPortAllocationSum ?? 0;
    const packetDrop = gw.metrics.packetsDropSum ?? 0;

    if (errorPort < 100 && packetDrop < 1000) continue;

    // Errors may indicate the gateway is under-provisioned or misconfigured
    // This is more of an operational warning — savings are indirect
    recs.push({
      instanceId: gw.natGatewayId,
      instanceName: gw.tags["Name"] || gw.natGatewayId,
      instanceType: "nat-gateway",
      category: "nat-high-error-rate",
      severity: "low",
      currentMonthlyCost: gw.currentMonthlyCost,
      estimatedSavings: 0,
      action: `Investigate errors on NAT Gateway ${gw.natGatewayId}: ${errorPort > 0 ? `${errorPort} port allocation errors` : ""}${errorPort > 0 && packetDrop > 0 ? ", " : ""}${packetDrop > 0 ? `${packetDrop} dropped packets` : ""} in 14 days`,
      reasoning: `NAT Gateway is experiencing errors that may indicate connectivity issues or capacity problems. Port allocation errors suggest too many concurrent connections from a single source. Dropped packets may cause application retries and increased data transfer costs.`,
    });
  }

  return recs;
}

// ─── LLM-only prompt (judgment-based categories) ────────────────────────────

const NAT_SYSTEM_PROMPT = `You are an AWS cost optimization expert. Analyze NAT Gateway metrics and return JSON recommendations.

Return a JSON array of objects with these fields:
- instanceId (NatGatewayId or VpcId), instanceName, instanceType, category, severity ("high"/"medium"/"low"), currentMonthlyCost, estimatedSavings, action, reasoning

You ONLY analyze for these categories (all others are handled separately — do NOT generate them):
- "nat-architecture-optimize": Cross-cutting architectural suggestions such as consolidating NAT Gateways across VPCs using Transit Gateway, using VPC peering to reduce NAT hops, or moving workloads to public subnets where appropriate. Only suggest when data supports it.
- "nat-traffic-pattern": Unusual traffic patterns that warrant investigation — e.g., asymmetric traffic (much more outbound than inbound suggesting large uploads/downloads), traffic spikes at specific times suggesting batch jobs that could use VPC endpoints, or unexpectedly high connection counts suggesting connection pooling issues.

Do NOT generate recommendations for: nat-idle, nat-low-utilization, nat-no-vpc-endpoint, nat-redundant-az, nat-high-error-rate. These are computed separately.
Do NOT generate recommendations for NAT Gateways that have virtually zero traffic (< 1MB in 14 days) — these are already flagged as idle and should simply be deleted.

Severity: high (>$50/mo savings), medium ($10-50/mo), low (<$10/mo or operational).
estimatedSavings MUST NOT exceed the total NAT cost for the resources involved.
Return ONLY a JSON array. No markdown, no explanation outside the JSON.
If no recommendations, return [].`;

// ─── Main analysis function ─────────────────────────────────────────────────

export async function analyzeNatWithClaude(
  data: NatGatewayAccountData
): Promise<Recommendation[]> {
  // Step 1: Deterministic recs
  const deterministicRecs = generateNatDeterministicRecs(data);

  // Step 2: LLM recs for judgment-based categories
  let llmRecs: Recommendation[] = [];

  if (data.gateways.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn(
        "ANTHROPIC_API_KEY not set — skipping LLM analysis for NAT"
      );
    } else {
      try {
        const client = new Anthropic({ apiKey });
        const prompt = buildNatPrompt(data);
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: NAT_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        });
        llmRecs = parseResponse(response);
      } catch (err: any) {
        console.warn(`NAT LLM analysis failed: ${err.message}`);
      }
    }
  }

  // Step 3: Merge — deterministic wins
  const merged = mergeNatRecommendations(deterministicRecs, llmRecs);

  // Step 4: Deduplicate overlapping recs on same resource
  return deduplicateNatRecommendations(merged);
}

// ─── Deduplication (prevents double-counting savings on same resource) ───────

function deduplicateNatRecommendations(recs: Recommendation[]): Recommendation[] {
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

    const hasIdle = uniqueByCategory.some((r) => r.category === "nat-idle");

    if (hasIdle) {
      // Idle = delete it. All other recs for this gateway are moot.
      // Keep only the idle rec and error-rate (operational, not savings-related).
      for (const rec of uniqueByCategory) {
        if (rec.category === "nat-idle" || rec.category === "nat-high-error-rate") {
          result.push(rec);
        }
      }
      continue;
    }

    const hasLowUtil = uniqueByCategory.some((r) => r.category === "nat-low-utilization");

    if (hasLowUtil) {
      // Low utilization subsumes LLM recs for this gateway — already flagged for review.
      // Keep deterministic recs only.
      for (const rec of uniqueByCategory) {
        if (!rec.category.startsWith("nat-architecture") && !rec.category.startsWith("nat-traffic")) {
          result.push(rec);
        }
      }
      continue;
    }

    result.push(...uniqueByCategory);
  }

  // Preserve recs with no instanceId (shouldn't happen but be safe)
  for (const rec of recs) {
    if (!rec.instanceId) result.push(rec);
  }

  return result;
}

// ─── LLM helpers ────────────────────────────────────────────────────────────

function mergeNatRecommendations(
  deterministic: Recommendation[],
  llm: Recommendation[]
): Recommendation[] {
  const deterministicCategories = new Set([
    "nat-idle",
    "nat-low-utilization",
    "nat-no-vpc-endpoint",
    "nat-redundant-az",
    "nat-high-error-rate",
  ]);

  // Filter out any LLM recs that overlap with deterministic categories
  const filteredLlm = llm.filter(
    (r) => !deterministicCategories.has(r.category)
  );

  // Also cap LLM savings: don't let LLM suggest savings > total NAT cost for a resource
  const costByResource = new Map<string, number>();
  for (const r of deterministic) {
    costByResource.set(
      r.instanceId,
      Math.max(
        costByResource.get(r.instanceId) || 0,
        r.currentMonthlyCost
      )
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

function buildNatPrompt(data: NatGatewayAccountData): string {
  let prompt = `Analyze the following NAT Gateway infrastructure for cost savings.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n`;
  prompt += `Total NAT cost: $${data.accountSummary.totalMonthlyCost.toFixed(2)}/mo\n\n`;

  prompt += `## NAT Gateways (${data.gateways.length})\n\n`;

  for (const gw of data.gateways) {
    const totalBytes =
      (gw.metrics.bytesOutSum ?? 0) + (gw.metrics.bytesInSum ?? 0);
    const totalGb = totalBytes / ONE_GB;

    prompt += `- **${gw.natGatewayId}** | VPC: ${gw.vpcId} | Subnet: ${gw.subnetId}`;
    prompt += ` | Type: ${gw.connectivityType}`;
    prompt += ` | Cost: $${gw.currentMonthlyCost.toFixed(2)}/mo${gw.costIsActual ? " (actual)" : " (estimated)"}`;
    prompt += ` | Data processed: ${totalGb.toFixed(3)}GB in 14d`;

    if (gw.metrics.bytesOutSum != null && gw.metrics.bytesInSum != null) {
      const outGb = gw.metrics.bytesOutSum / ONE_GB;
      const inGb = gw.metrics.bytesInSum / ONE_GB;
      prompt += ` (out: ${outGb.toFixed(3)}GB, in: ${inGb.toFixed(3)}GB)`;
    }

    if (gw.metrics.activeConnectionsAvg != null) {
      prompt += ` | Connections avg: ${gw.metrics.activeConnectionsAvg.toFixed(0)}, max: ${gw.metrics.activeConnectionsMax?.toFixed(0) ?? "N/A"}`;
    }
    if (gw.metrics.connectionAttemptSum != null) {
      prompt += ` | Attempts: ${gw.metrics.connectionAttemptSum.toFixed(0)}`;
    }
    if (gw.metrics.errorPortAllocationSum != null && gw.metrics.errorPortAllocationSum > 0) {
      prompt += ` | PortErrors: ${gw.metrics.errorPortAllocationSum}`;
    }
    if (gw.metrics.packetsDropSum != null && gw.metrics.packetsDropSum > 0) {
      prompt += ` | DroppedPkts: ${gw.metrics.packetsDropSum}`;
    }

    const name = gw.tags["Name"];
    if (name) prompt += ` | Name: ${name}`;

    prompt += `\n`;
  }

  // VPC Endpoint info
  prompt += `\n## VPC Gateway Endpoints\n\n`;
  for (const [vpcId, services] of Object.entries(
    data.vpcGatewayEndpoints
  )) {
    prompt += `- VPC ${vpcId}: ${services.join(", ")}\n`;
  }
  const vpcsWithNat = new Set(data.gateways.map((g) => g.vpcId));
  const vpcsWithoutEndpoints = [...vpcsWithNat].filter(
    (v) => !data.vpcGatewayEndpoints[v]
  );
  if (vpcsWithoutEndpoints.length > 0) {
    prompt += `- VPCs with NAT but NO Gateway Endpoints: ${vpcsWithoutEndpoints.join(", ")}\n`;
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
      "No JSON array found in NAT Claude response:",
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
    console.warn("Failed to parse NAT Claude response as JSON:", err);
    return [];
  }
}
