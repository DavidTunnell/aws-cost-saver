import Anthropic from "@anthropic-ai/sdk";
import type {
  DynamoDBAccountData,
  DynamoDBTableData,
} from "../aws/dynamodb-collector";
import {
  DYNAMO_STORAGE_COST_PER_GB,
  DYNAMO_IA_STORAGE_COST_PER_GB,
  DYNAMO_PITR_COST_PER_GB,
  DYNAMO_RCU_HOURLY,
  DYNAMO_WCU_HOURLY,
  DYNAMO_ON_DEMAND_READ,
  DYNAMO_ON_DEMAND_WRITE,
} from "../aws/dynamodb-collector";
import type { Recommendation } from "./analyzer";
import { buildMetadata } from "./analyzer";

export type { Recommendation };

// ─── Deterministic helpers ───────────────────────────────────────────────────

function getSeverity(savings: number): "high" | "medium" | "low" {
  if (savings > 50) return "high";
  if (savings >= 10) return "medium";
  return "low";
}

// ─── Deterministic recommendations (7 categories) ───────────────────────────

function generateDynamoDBDeterministicRecs(
  data: DynamoDBAccountData
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const table of data.tables) {
    const tableSizeGb = table.tableSizeBytes / (1024 * 1024 * 1024);
    const consumedReads = table.metrics.consumedReadSum ?? 0;
    const consumedWrites = table.metrics.consumedWriteSum ?? 0;

    // 1. dynamodb-unused-table: Zero consumed reads AND writes in 14 days
    if (consumedReads === 0 && consumedWrites === 0) {
      const savings = table.currentMonthlyCost;
      recs.push({
        instanceId: table.tableName,
        instanceName: table.tableName,
        instanceType: `${table.billingMode} / ${table.itemCount.toLocaleString()} items`,
        category: "dynamodb-unused-table",
        severity: savings > 0 ? getSeverity(savings) : "low",
        currentMonthlyCost: table.currentMonthlyCost,
        estimatedSavings: savings,
        action: `Delete unused DynamoDB table "${table.tableName}" — zero reads and writes in 14 days`,
        reasoning: `Table has had no read or write activity in the monitoring period.${table.pitrEnabled ? ` PITR backup is enabled, adding backup costs.` : ""} Table size: ${tableSizeGb.toFixed(2)}GB, ${table.itemCount.toLocaleString()} items. Created: ${table.creationDate || "unknown"}.`,
        metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: table.tableArn, billingMode: table.billingMode, tableClass: table.tableClass || "STANDARD", creationDate: table.creationDate }),
      });
      continue; // Skip all other checks for unused tables
    }

    // 2. dynamodb-over-provisioned-rcu: Consumed RCU avg < 30% of provisioned (14d)
    if (
      table.billingMode === "PROVISIONED" &&
      table.provisionedRCU > 0 &&
      table.metrics.provisionedReadAvg != null &&
      table.metrics.provisionedReadAvg > 0
    ) {
      // consumedReadSum is total across all 14d hourly datapoints
      // To get avg RCU/sec: consumedReadSum / (14 * 24 * 3600)
      // provisionedReadAvg is avg provisioned RCU (from CloudWatch)
      const totalSeconds = 14 * 24 * 3600;
      const avgConsumedRCU = consumedReads / totalSeconds;
      const utilizationPct = avgConsumedRCU / table.metrics.provisionedReadAvg;

      if (utilizationPct < 0.30) {
        // Suggest provisioning at 2x the average consumed (with min of 1)
        const suggestedRCU = Math.max(1, Math.ceil(avgConsumedRCU * 2));
        const reduction = table.provisionedRCU - suggestedRCU;

        if (reduction > 0) {
          const savings = reduction * DYNAMO_RCU_HOURLY * 730;

          if (savings > 1) {
            recs.push({
              instanceId: table.tableName,
              instanceName: table.tableName,
              instanceType: `PROVISIONED / ${table.provisionedRCU} RCU`,
              category: "dynamodb-over-provisioned-rcu",
              severity: getSeverity(savings),
              currentMonthlyCost: table.currentMonthlyCost,
              estimatedSavings: savings,
              action: `Reduce read capacity for "${table.tableName}" from ${table.provisionedRCU} RCU to ${suggestedRCU} RCU — avg utilization is ${(utilizationPct * 100).toFixed(1)}%`,
              reasoning: `Average consumed RCU is ${avgConsumedRCU.toFixed(1)} vs ${table.provisionedRCU} provisioned (${(utilizationPct * 100).toFixed(1)}% utilization over 14 days). Reducing to ${suggestedRCU} RCU (2x average) saves ~$${savings.toFixed(2)}/mo.${(table.metrics.readThrottleEventsSum ?? 0) > 0 ? ` Note: ${table.metrics.readThrottleEventsSum} read throttle events detected — consider auto-scaling instead of fixed reduction.` : ""}`,
              metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: table.tableArn, billingMode: table.billingMode, tableClass: table.tableClass || "STANDARD", creationDate: table.creationDate }),
            });
          }
        }
      }
    }

    // 3. dynamodb-over-provisioned-wcu: Consumed WCU avg < 30% of provisioned (14d)
    if (
      table.billingMode === "PROVISIONED" &&
      table.provisionedWCU > 0 &&
      table.metrics.provisionedWriteAvg != null &&
      table.metrics.provisionedWriteAvg > 0
    ) {
      const totalSeconds = 14 * 24 * 3600;
      const avgConsumedWCU = consumedWrites / totalSeconds;
      const utilizationPct = avgConsumedWCU / table.metrics.provisionedWriteAvg;

      if (utilizationPct < 0.30) {
        const suggestedWCU = Math.max(1, Math.ceil(avgConsumedWCU * 2));
        const reduction = table.provisionedWCU - suggestedWCU;

        if (reduction > 0) {
          const savings = reduction * DYNAMO_WCU_HOURLY * 730;

          if (savings > 1) {
            recs.push({
              instanceId: table.tableName,
              instanceName: table.tableName,
              instanceType: `PROVISIONED / ${table.provisionedWCU} WCU`,
              category: "dynamodb-over-provisioned-wcu",
              severity: getSeverity(savings),
              currentMonthlyCost: table.currentMonthlyCost,
              estimatedSavings: savings,
              action: `Reduce write capacity for "${table.tableName}" from ${table.provisionedWCU} WCU to ${suggestedWCU} WCU — avg utilization is ${(utilizationPct * 100).toFixed(1)}%`,
              reasoning: `Average consumed WCU is ${avgConsumedWCU.toFixed(1)} vs ${table.provisionedWCU} provisioned (${(utilizationPct * 100).toFixed(1)}% utilization over 14 days). Reducing to ${suggestedWCU} WCU (2x average) saves ~$${savings.toFixed(2)}/mo.${(table.metrics.writeThrottleEventsSum ?? 0) > 0 ? ` Note: ${table.metrics.writeThrottleEventsSum} write throttle events detected — consider auto-scaling instead of fixed reduction.` : ""}`,
              metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: table.tableArn, billingMode: table.billingMode, tableClass: table.tableClass || "STANDARD", creationDate: table.creationDate }),
            });
          }
        }
      }
    }

    // 4. dynamodb-switch-to-on-demand: Provisioned mode + <20% avg utilization + bursty
    if (table.billingMode === "PROVISIONED" && table.provisionedRCU > 0) {
      const totalSeconds = 14 * 24 * 3600;
      const avgConsumedRCU = consumedReads / totalSeconds;
      const avgConsumedWCU = consumedWrites / totalSeconds;

      const rcuUtil = table.provisionedRCU > 0 ? avgConsumedRCU / table.provisionedRCU : 0;
      const wcuUtil = table.provisionedWCU > 0 ? avgConsumedWCU / table.provisionedWCU : 0;
      const avgUtil = (rcuUtil + wcuUtil) / 2;

      if (avgUtil < 0.20) {
        // Calculate current provisioned cost
        let totalRCU = table.provisionedRCU;
        let totalWCU = table.provisionedWCU;
        for (const gsi of table.gsiDetails) {
          totalRCU += gsi.provisionedRCU;
          totalWCU += gsi.provisionedWCU;
        }
        const currentProvisionedCost = (totalRCU * DYNAMO_RCU_HOURLY + totalWCU * DYNAMO_WCU_HOURLY) * 730;

        // Calculate what on-demand would cost for actual usage (scaled to monthly).
        // Note: CloudWatch ConsumedReadCapacityUnits (CU) and on-demand Read Request
        // Units (RRU) are 1:1 equivalent — both represent 4KB strongly-consistent reads
        // or 8KB eventually-consistent reads. Same equivalence applies for WCU↔WRU.
        const monthlyReads = consumedReads * (30 / 14);
        const monthlyWrites = consumedWrites * (30 / 14);
        const onDemandCost = monthlyReads * DYNAMO_ON_DEMAND_READ + monthlyWrites * DYNAMO_ON_DEMAND_WRITE;

        const savings = currentProvisionedCost - onDemandCost;

        if (savings > 5) {
          recs.push({
            instanceId: table.tableName,
            instanceName: table.tableName,
            instanceType: `PROVISIONED / ${table.provisionedRCU} RCU / ${table.provisionedWCU} WCU`,
            category: "dynamodb-switch-to-on-demand",
            severity: getSeverity(savings),
            currentMonthlyCost: table.currentMonthlyCost,
            estimatedSavings: savings,
            action: `Switch "${table.tableName}" from Provisioned to On-Demand billing — avg utilization is only ${(avgUtil * 100).toFixed(1)}%`,
            reasoning: `Table has ${(avgUtil * 100).toFixed(1)}% average utilization of provisioned capacity. Current provisioned throughput costs ~$${currentProvisionedCost.toFixed(2)}/mo, while on-demand pricing for actual usage would be ~$${onDemandCost.toFixed(2)}/mo — saving ~$${savings.toFixed(2)}/mo. On-demand is ideal for unpredictable or low-utilization workloads.`,
            metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: table.tableArn, billingMode: table.billingMode, tableClass: table.tableClass || "STANDARD", creationDate: table.creationDate }),
          });
        }
      }
    }

    // 5. dynamodb-switch-to-provisioned: On-demand mode + steady high throughput
    if (table.billingMode === "PAY_PER_REQUEST" && (consumedReads > 0 || consumedWrites > 0)) {
      const monthlyReads = consumedReads * (30 / 14);
      const monthlyWrites = consumedWrites * (30 / 14);
      const currentOnDemandCost = monthlyReads * DYNAMO_ON_DEMAND_READ + monthlyWrites * DYNAMO_ON_DEMAND_WRITE;

      // Calculate what provisioned would cost (provision at avg consumed * 1.3 for headroom)
      const totalSeconds = 14 * 24 * 3600;
      const avgRCU = consumedReads / totalSeconds;
      const avgWCU = consumedWrites / totalSeconds;
      const provRCU = Math.max(1, Math.ceil(avgRCU * 1.3));
      const provWCU = Math.max(1, Math.ceil(avgWCU * 1.3));
      const provisionedCost = (provRCU * DYNAMO_RCU_HOURLY + provWCU * DYNAMO_WCU_HOURLY) * 730;

      const savings = currentOnDemandCost - provisionedCost;

      // Only recommend if significant savings and meaningful throughput
      if (savings > 5 && currentOnDemandCost > 10) {
        recs.push({
          instanceId: table.tableName,
          instanceName: table.tableName,
          instanceType: `PAY_PER_REQUEST / ~${avgRCU.toFixed(0)} RCU / ~${avgWCU.toFixed(0)} WCU avg`,
          category: "dynamodb-switch-to-provisioned",
          severity: getSeverity(savings),
          currentMonthlyCost: table.currentMonthlyCost,
          estimatedSavings: savings,
          action: `Switch "${table.tableName}" from On-Demand to Provisioned billing with ~${provRCU} RCU / ${provWCU} WCU`,
          reasoning: `Table has steady throughput (~${avgRCU.toFixed(0)} avg RCU, ~${avgWCU.toFixed(0)} avg WCU). Current on-demand cost is ~$${currentOnDemandCost.toFixed(2)}/mo vs ~$${provisionedCost.toFixed(2)}/mo provisioned — saving ~$${savings.toFixed(2)}/mo. Use auto-scaling to handle traffic spikes.`,
          metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: table.tableArn, billingMode: table.billingMode, tableClass: table.tableClass || "STANDARD", creationDate: table.creationDate }),
        });
      }
    }

    // 6. dynamodb-infrequent-access: Table class STANDARD + storage-dominated cost profile
    //
    // Standard-IA trades higher read/write costs for lower storage costs ($0.25→$0.10/GB).
    // The right threshold is economic: recommend IA when the table's throughput cost is
    // small relative to its storage cost (i.e., it's storage-dominated).
    //
    // IA read/write cost increase: ~25% higher per-RRU/WRU in on-demand mode.
    // So we calculate net savings = storageSavings - estimatedThroughputCostIncrease.
    if (
      table.tableClass === "STANDARD" &&
      tableSizeGb >= 1 // Only relevant for tables with meaningful storage
    ) {
      const currentStorageCost = tableSizeGb * DYNAMO_STORAGE_COST_PER_GB;

      // Estimate monthly throughput cost (works for both billing modes)
      const monthlyReads = consumedReads * (30 / 14);
      const monthlyWrites = consumedWrites * (30 / 14);
      let estimatedThroughputCost: number;
      if (table.billingMode === "PROVISIONED") {
        let totalRCU = table.provisionedRCU;
        let totalWCU = table.provisionedWCU;
        for (const gsi of table.gsiDetails) {
          totalRCU += gsi.provisionedRCU;
          totalWCU += gsi.provisionedWCU;
        }
        estimatedThroughputCost = (totalRCU * DYNAMO_RCU_HOURLY + totalWCU * DYNAMO_WCU_HOURLY) * 730;
      } else {
        estimatedThroughputCost = monthlyReads * DYNAMO_ON_DEMAND_READ + monthlyWrites * DYNAMO_ON_DEMAND_WRITE;
      }

      // Only recommend IA if table is storage-dominated: throughput cost < 50% of storage cost
      if (estimatedThroughputCost < currentStorageCost * 0.5) {
        const storageSavings = tableSizeGb * (DYNAMO_STORAGE_COST_PER_GB - DYNAMO_IA_STORAGE_COST_PER_GB);
        // IA throughput costs are ~25% higher; estimate the increase
        const throughputCostIncrease = estimatedThroughputCost * 0.25;
        const netSavings = storageSavings - throughputCostIncrease;

        if (netSavings > 1) {
          recs.push({
            instanceId: table.tableName,
            instanceName: table.tableName,
            instanceType: `STANDARD / ${tableSizeGb.toFixed(1)}GB`,
            category: "dynamodb-infrequent-access",
            severity: getSeverity(netSavings),
            currentMonthlyCost: table.currentMonthlyCost,
            estimatedSavings: netSavings,
            action: `Switch "${table.tableName}" to Standard-Infrequent Access table class — net savings ~$${netSavings.toFixed(2)}/mo`,
            reasoning: `Table is storage-dominated: ${tableSizeGb.toFixed(1)}GB storage costs ~$${currentStorageCost.toFixed(2)}/mo vs ~$${estimatedThroughputCost.toFixed(2)}/mo throughput. IA saves $${storageSavings.toFixed(2)}/mo on storage but adds ~$${throughputCostIncrease.toFixed(2)}/mo in higher read/write costs — net saving ~$${netSavings.toFixed(2)}/mo.`,
            metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: table.tableArn, billingMode: table.billingMode, tableClass: table.tableClass || "STANDARD", creationDate: table.creationDate }),
          });
        }
      }
    }

    // 7. dynamodb-pitr-review: PITR enabled on unused or very low-traffic tables
    if (table.pitrEnabled && tableSizeGb > 0) {
      const dailyReads = consumedReads / 14;
      const dailyWrites = consumedWrites / 14;
      const isLowTraffic = (dailyReads + dailyWrites) < 100;

      if (isLowTraffic) {
        const pitrCost = tableSizeGb * DYNAMO_PITR_COST_PER_GB;

        if (pitrCost > 1) {
          recs.push({
            instanceId: table.tableName,
            instanceName: table.tableName,
            instanceType: `PITR enabled / ${tableSizeGb.toFixed(1)}GB`,
            category: "dynamodb-pitr-review",
            severity: getSeverity(pitrCost),
            currentMonthlyCost: table.currentMonthlyCost,
            estimatedSavings: pitrCost,
            action: `Review PITR on "${table.tableName}" — backup costs $${pitrCost.toFixed(2)}/mo for a low-traffic table`,
            reasoning: `Point-in-time recovery is enabled on this ${tableSizeGb.toFixed(1)}GB table that has very low traffic (${(dailyReads + dailyWrites).toFixed(0)} operations/day). PITR costs $${DYNAMO_PITR_COST_PER_GB}/GB/mo = $${pitrCost.toFixed(2)}/mo. Consider whether continuous backups are necessary for this table or if periodic on-demand backups would suffice.`,
            metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: table.tableArn, billingMode: table.billingMode, tableClass: table.tableClass || "STANDARD", creationDate: table.creationDate }),
          });
        }
      }
    }
  }

  return recs;
}

// ─── LLM prompt (judgment-based categories) ──────────────────────────────────

const DYNAMODB_SYSTEM_PROMPT = `You are an AWS cost optimization expert. Analyze DynamoDB table metrics and return JSON recommendations.

Return a JSON array of objects with these fields:
- instanceId (table name), instanceName, instanceType, category, severity ("high"/"medium"/"low"), currentMonthlyCost, estimatedSavings, action, reasoning

You ONLY analyze for these categories (all others are handled separately — do NOT generate them):
- "dynamodb-optimize-gsi": Global Secondary Indexes that may be redundant, underutilized, or could benefit from sparse indexes or projection optimization.
- "dynamodb-ttl-suggestion": Tables with data that appears to be time-series, logs, sessions, or event-based that could benefit from TTL auto-expiration to reduce storage costs. Each table's current TTL status (enabled/disabled) is provided — do NOT recommend TTL for tables that already have it enabled.
- "dynamodb-caching": Tables with high read:write ratios that would benefit from DAX (DynamoDB Accelerator) to reduce read costs and improve latency.
- "dynamodb-architecture": Cross-cutting architectural suggestions — e.g., using DynamoDB Streams for async processing, optimizing partition key design, consolidating small tables, or moving cold data to S3.

Do NOT generate recommendations for: dynamodb-unused-table, dynamodb-over-provisioned-rcu, dynamodb-over-provisioned-wcu, dynamodb-switch-to-on-demand, dynamodb-switch-to-provisioned, dynamodb-infrequent-access, dynamodb-pitr-review. These are computed separately.
Do NOT generate recommendations for tables with 0 reads and 0 writes — these are already flagged as unused.

Severity: high (>$50/mo savings), medium ($10-50/mo), low (<$10/mo or operational).
estimatedSavings MUST NOT exceed the total DynamoDB cost for the resources involved.
Return ONLY a JSON array. No markdown, no explanation outside the JSON.
If no recommendations, return [].`;

// ─── Main analysis function ──────────────────────────────────────────────────

export async function analyzeDynamoDBWithClaude(
  data: DynamoDBAccountData
): Promise<Recommendation[]> {
  // Step 1: Deterministic recs
  const deterministicRecs = generateDynamoDBDeterministicRecs(data);

  // Step 2: LLM recs for judgment-based categories
  let llmRecs: Recommendation[] = [];

  // Only call LLM if there are active tables (with reads or writes)
  const activeTables = data.tables.filter(
    (t) => (t.metrics.consumedReadSum ?? 0) > 0 || (t.metrics.consumedWriteSum ?? 0) > 0
  );

  if (activeTables.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn("ANTHROPIC_API_KEY not set — skipping LLM analysis for DynamoDB");
    } else {
      try {
        const client = new Anthropic({ apiKey });
        const prompt = buildDynamoDBPrompt(data, activeTables);
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: DYNAMODB_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        });
        llmRecs = parseResponse(response);
        if (llmRecs.length === 0) {
          console.log(`[DynamoDB Analyzer] LLM returned 0 recommendations for ${activeTables.length} active tables`);
        }
      } catch (err: any) {
        console.warn(`DynamoDB LLM analysis failed: ${err.message}`);
      }
    }
  }

  // Enrich LLM recs with metadata from collector data
  const tableMap = new Map(data.tables.map(t => [t.tableName, t]));
  for (const rec of llmRecs) {
    const table = tableMap.get(rec.instanceId);
    if (table) {
      rec.metadata = buildMetadata({
        region: data.region,
        accountId: data.accountId,
        arn: table.tableArn,
        billingMode: table.billingMode,
        tableClass: table.tableClass || "STANDARD",
        creationDate: table.creationDate,
      });
    }
  }

  // Step 3: Merge — deterministic wins
  const merged = mergeDynamoDBRecommendations(deterministicRecs, llmRecs);

  // Step 4: Deduplicate
  return deduplicateDynamoDBRecommendations(merged);
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicateDynamoDBRecommendations(recs: Recommendation[]): Recommendation[] {
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

    // Unused table suppresses all other recs for that table
    const hasUnused = uniqueByCategory.some((r) => r.category === "dynamodb-unused-table");
    if (hasUnused) {
      result.push(...uniqueByCategory.filter((r) => r.category === "dynamodb-unused-table"));
      continue;
    }

    // switch-to-on-demand suppresses over-provisioned-rcu/wcu (mutually exclusive —
    // the switch already captures the full savings from reduced provisioned throughput)
    const hasSwitchToOnDemand = uniqueByCategory.some((r) => r.category === "dynamodb-switch-to-on-demand");
    if (hasSwitchToOnDemand) {
      result.push(
        ...uniqueByCategory.filter(
          (r) => r.category !== "dynamodb-over-provisioned-rcu" && r.category !== "dynamodb-over-provisioned-wcu"
        )
      );
      continue;
    }

    result.push(...uniqueByCategory);
  }

  // Preserve recs with no instanceId
  for (const rec of recs) {
    if (!rec.instanceId) result.push(rec);
  }

  return result;
}

// ─── LLM helpers ─────────────────────────────────────────────────────────────

function mergeDynamoDBRecommendations(
  deterministic: Recommendation[],
  llm: Recommendation[]
): Recommendation[] {
  const deterministicCategories = new Set([
    "dynamodb-unused-table",
    "dynamodb-over-provisioned-rcu",
    "dynamodb-over-provisioned-wcu",
    "dynamodb-switch-to-on-demand",
    "dynamodb-switch-to-provisioned",
    "dynamodb-infrequent-access",
    "dynamodb-pitr-review",
  ]);

  const filteredLlm = llm.filter((r) => !deterministicCategories.has(r.category));

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

function buildDynamoDBPrompt(
  data: DynamoDBAccountData,
  activeTables: DynamoDBTableData[]
): string {
  let prompt = `Analyze the following DynamoDB tables for cost savings.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n`;
  prompt += `Total DynamoDB cost: $${data.accountSummary.totalMonthlyCost.toFixed(2)}/mo\n`;
  prompt += `Total tables: ${data.tables.length} (${activeTables.length} active)\n\n`;

  prompt += `## Active DynamoDB Tables\n\n`;

  for (const table of activeTables) {
    const tableSizeGb = table.tableSizeBytes / (1024 * 1024 * 1024);
    const consumedReads = table.metrics.consumedReadSum ?? 0;
    const consumedWrites = table.metrics.consumedWriteSum ?? 0;
    const monthlyReads = consumedReads * (30 / 14);
    const monthlyWrites = consumedWrites * (30 / 14);

    prompt += `- **${table.tableName}**`;
    prompt += ` | Billing: ${table.billingMode}`;
    prompt += ` | Cost: $${table.currentMonthlyCost.toFixed(2)}/mo${table.costIsActual ? " (actual)" : " (est)"}`;
    prompt += ` | Size: ${tableSizeGb.toFixed(2)}GB / ${table.itemCount.toLocaleString()} items`;

    if (table.billingMode === "PROVISIONED") {
      prompt += ` | Provisioned: ${table.provisionedRCU} RCU / ${table.provisionedWCU} WCU`;
    }

    prompt += ` | Consumed (14d): ${consumedReads.toLocaleString()} reads / ${consumedWrites.toLocaleString()} writes`;
    prompt += ` | ~${Math.round(monthlyReads).toLocaleString()} reads/mo / ~${Math.round(monthlyWrites).toLocaleString()} writes/mo`;

    if ((table.metrics.throttledRequestsSum ?? 0) > 0) {
      prompt += ` | Throttles: ${table.metrics.throttledRequestsSum}`;
    }

    if (table.gsiCount > 0) {
      prompt += ` | GSIs: ${table.gsiCount}`;
      for (const gsi of table.gsiDetails) {
        prompt += ` [${gsi.name}: ${gsi.provisionedRCU}R/${gsi.provisionedWCU}W, ${(gsi.sizeBytes / (1024 * 1024)).toFixed(1)}MB]`;
      }
    }

    if (table.pitrEnabled) prompt += ` | PITR: on`;
    prompt += ` | TTL: ${table.ttlEnabled ? "enabled" : "disabled"}`;
    if (table.tableClass !== "STANDARD") prompt += ` | Class: ${table.tableClass}`;

    // Include relevant tags
    const envTag = table.tags["Environment"] || table.tags["Env"] || table.tags["env"] || "";
    const purposeTag = table.tags["Purpose"] || table.tags["purpose"] || "";
    if (envTag) prompt += ` | env=${envTag}`;
    if (purposeTag) prompt += ` | purpose=${purposeTag}`;

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
    console.warn("No JSON array found in DynamoDB Claude response:", text.slice(0, 200));
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
    console.warn("Failed to parse DynamoDB Claude response as JSON:", err);
    return [];
  }
}
