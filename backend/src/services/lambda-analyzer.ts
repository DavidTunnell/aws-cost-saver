import Anthropic from "@anthropic-ai/sdk";
import type {
  LambdaAccountData,
  LambdaFunctionData,
} from "../aws/lambda-collector";
import { LAMBDA_PROVISIONED_COST_PER_GB_HR } from "../aws/lambda-collector";
import type { Recommendation } from "./analyzer";
import { buildMetadata } from "./analyzer";

export type { Recommendation };

// ─── Deterministic helpers ───────────────────────────────────────────────────

function getSeverity(savings: number): "high" | "medium" | "low" {
  if (savings > 50) return "high";
  if (savings >= 10) return "medium";
  return "low";
}

const DEPRECATED_RUNTIMES = new Set([
  "python2.7", "python3.6", "python3.7", "python3.8",
  "nodejs10.x", "nodejs12.x", "nodejs14.x", "nodejs16.x",
  "dotnetcore2.1", "dotnetcore3.1", "dotnet5.0",
  "go1.x",
  "ruby2.5", "ruby2.7",
  "java8",
]);

const ARM_COMPATIBLE_RUNTIMES = new Set([
  "python3.9", "python3.10", "python3.11", "python3.12", "python3.13",
  "nodejs18.x", "nodejs20.x", "nodejs22.x",
  "java11", "java17", "java21",
  "dotnet6", "dotnet7", "dotnet8",
  "ruby3.2", "ruby3.3",
  "provided.al2", "provided.al2023",
]);

// ─── Deterministic recommendations (7 categories) ───────────────────────────

function generateLambdaDeterministicRecs(
  data: LambdaAccountData
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const fn of data.functions) {
    // 1. lambda-unused-function: Zero invocations in 14 days
    if ((fn.metrics.invocationsSum ?? 0) === 0) {
      const savings = fn.currentMonthlyCost;
      recs.push({
        instanceId: fn.functionName,
        instanceName: fn.description || fn.functionName,
        instanceType: `${fn.runtime} / ${fn.memorySize}MB`,
        category: "lambda-unused-function",
        severity: savings > 0 ? getSeverity(savings) : "low",
        currentMonthlyCost: fn.currentMonthlyCost,
        estimatedSavings: savings,
        action: `Delete unused Lambda function "${fn.functionName}" — zero invocations in 14 days`,
        reasoning: `Function has not been invoked in the monitoring period.${fn.provisionedConcurrency > 0 ? ` It has ${fn.provisionedConcurrency} provisioned concurrency units running (incurring cost even without invocations).` : ""} Last modified: ${fn.lastModified || "unknown"}.`,
        metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: fn.functionArn, runtime: fn.runtime, memorySize: String(fn.memorySize), architecture: fn.architecture }),
      });
      continue; // Skip all other checks for unused functions
    }

    // 2. lambda-overprovisioned-memory: High memory, short duration
    const avgDurationMs = fn.metrics.durationAvg ?? 0;
    const maxDurationMs = fn.metrics.durationMax ?? 0;
    if (fn.memorySize >= 512 && avgDurationMs > 0 && avgDurationMs < 1000 && maxDurationMs < 3000) {
      // Heuristic: if function runs fast with high memory, it likely doesn't need that much
      const currentMemoryGb = fn.memorySize / 1024;
      const suggestedMemoryMb = Math.max(128, Math.ceil(fn.memorySize / 2 / 64) * 64);
      const suggestedMemoryGb = suggestedMemoryMb / 1024;
      const ratio = suggestedMemoryGb / currentMemoryGb;

      // Duration cost scales linearly with memory
      const invocations = fn.metrics.invocationsSum ?? 0;
      const monthlyInvocations = invocations * (30 / 14);
      const currentDurationCostGbSec = (monthlyInvocations * avgDurationMs / 1000) * currentMemoryGb;
      const newDurationCostGbSec = (monthlyInvocations * avgDurationMs / 1000) * suggestedMemoryGb;
      const savings = (currentDurationCostGbSec - newDurationCostGbSec) * 0.0000166667;

      if (savings > 1) {
        recs.push({
          instanceId: fn.functionName,
          instanceName: fn.description || fn.functionName,
          instanceType: `${fn.runtime} / ${fn.memorySize}MB`,
          category: "lambda-overprovisioned-memory",
          severity: getSeverity(savings),
          currentMonthlyCost: fn.currentMonthlyCost,
          estimatedSavings: savings,
          action: `Reduce memory for "${fn.functionName}" from ${fn.memorySize}MB to ${suggestedMemoryMb}MB — avg duration is only ${avgDurationMs.toFixed(0)}ms`,
          reasoning: `Function completes quickly (avg ${avgDurationMs.toFixed(0)}ms, max ${maxDurationMs.toFixed(0)}ms) with ${fn.memorySize}MB memory. Reducing to ${suggestedMemoryMb}MB could save ~$${savings.toFixed(2)}/mo. Test to verify performance doesn't degrade.`,
          metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: fn.functionArn, runtime: fn.runtime, memorySize: String(fn.memorySize), architecture: fn.architecture }),
        });
      }
    }

    // 3. lambda-excessive-timeout: Timeout > 5x max observed duration
    if (maxDurationMs > 0 && fn.timeout * 1000 > maxDurationMs * 5 && fn.timeout > 30) {
      recs.push({
        instanceId: fn.functionName,
        instanceName: fn.description || fn.functionName,
        instanceType: `${fn.runtime} / ${fn.memorySize}MB`,
        category: "lambda-excessive-timeout",
        severity: "low",
        currentMonthlyCost: fn.currentMonthlyCost,
        estimatedSavings: 0,
        action: `Reduce timeout for "${fn.functionName}" from ${fn.timeout}s to ${Math.max(Math.ceil(maxDurationMs / 1000 * 3), 10)}s — max observed duration is ${(maxDurationMs / 1000).toFixed(1)}s`,
        reasoning: `Timeout (${fn.timeout}s) is ${(fn.timeout * 1000 / maxDurationMs).toFixed(0)}x the max observed duration (${(maxDurationMs / 1000).toFixed(1)}s). Reducing timeout prevents runaway invocations from consuming resources. No direct cost savings but reduces blast radius of failures.`,
        metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: fn.functionArn, runtime: fn.runtime, memorySize: String(fn.memorySize), architecture: fn.architecture }),
      });
    }

    // 4. lambda-old-runtime: Deprecated/EOL runtimes
    if (DEPRECATED_RUNTIMES.has(fn.runtime)) {
      recs.push({
        instanceId: fn.functionName,
        instanceName: fn.description || fn.functionName,
        instanceType: `${fn.runtime} / ${fn.memorySize}MB`,
        category: "lambda-old-runtime",
        severity: "medium",
        currentMonthlyCost: fn.currentMonthlyCost,
        estimatedSavings: 0,
        action: `Upgrade "${fn.functionName}" from deprecated runtime ${fn.runtime} to a supported version`,
        reasoning: `Runtime ${fn.runtime} is deprecated or end-of-life. Deprecated runtimes don't receive security patches and may stop being supported for new deployments. Newer runtimes also offer better performance.`,
        metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: fn.functionArn, runtime: fn.runtime, memorySize: String(fn.memorySize), architecture: fn.architecture }),
      });
    }

    // 5. lambda-no-arm64: x86_64 with ARM-compatible runtime (~20% savings)
    if (fn.architecture === "x86_64" && ARM_COMPATIBLE_RUNTIMES.has(fn.runtime) && fn.packageType === "Zip") {
      const savings = fn.currentMonthlyCost * 0.20;
      if (savings > 0.50) {
        recs.push({
          instanceId: fn.functionName,
          instanceName: fn.description || fn.functionName,
          instanceType: `${fn.runtime} / ${fn.memorySize}MB / x86_64`,
          category: "lambda-no-arm64",
          severity: getSeverity(savings),
          currentMonthlyCost: fn.currentMonthlyCost,
          estimatedSavings: savings,
          action: `Migrate "${fn.functionName}" to ARM64 (Graviton2) — ~20% cost reduction with ${fn.runtime}`,
          reasoning: `Function uses x86_64 architecture with ${fn.runtime} which supports ARM64. Graviton2 Lambda functions are ~20% cheaper and often perform better. Ensure dependencies are ARM-compatible before migrating.`,
          metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: fn.functionArn, runtime: fn.runtime, memorySize: String(fn.memorySize), architecture: fn.architecture }),
        });
      }
    }

    // 6. lambda-excessive-versions: >25 published versions
    if (fn.versionCount > 25) {
      // Each version retains code & config — storage costs at $0.0000000309/GB-second
      const storageCostPerVersion = (fn.codeSize / (1024 * 1024 * 1024)) * 0.0000000309 * 2592000; // ~per month
      const excessVersions = fn.versionCount - 5; // Keep 5
      const savings = excessVersions * storageCostPerVersion;

      recs.push({
        instanceId: fn.functionName,
        instanceName: fn.description || fn.functionName,
        instanceType: `${fn.runtime} / ${fn.versionCount} versions`,
        category: "lambda-excessive-versions",
        severity: "low",
        currentMonthlyCost: fn.currentMonthlyCost,
        estimatedSavings: savings > 0.01 ? savings : 0,
        action: `Clean up ${excessVersions} old versions of "${fn.functionName}" (currently ${fn.versionCount} published versions)`,
        reasoning: `Function has ${fn.versionCount} published versions. Each version retains its deployment package (${(fn.codeSize / (1024 * 1024)).toFixed(1)}MB). Consider retaining only recent versions referenced by aliases.`,
        metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: fn.functionArn, runtime: fn.runtime, memorySize: String(fn.memorySize), architecture: fn.architecture }),
      });
    }

    // 7. lambda-provisioned-concurrency-waste: Peak usage < 30% of provisioned
    if (fn.provisionedConcurrency > 0 && fn.provisionedConcurrencyUtilizationMax != null) {
      if (fn.provisionedConcurrencyUtilizationMax < 0.30) {
        const memGb = fn.memorySize / 1024;
        const provisionedCostPerUnit = memGb * LAMBDA_PROVISIONED_COST_PER_GB_HR * 730;
        const currentProvCost = fn.provisionedConcurrency * provisionedCostPerUnit;

        // Suggest reducing to 2x peak usage or minimum 1
        const peakUsed = Math.ceil(fn.provisionedConcurrency * fn.provisionedConcurrencyUtilizationMax);
        const suggested = Math.max(1, Math.ceil(peakUsed * 2));
        const reduction = fn.provisionedConcurrency - suggested;
        const savings = reduction > 0 ? reduction * provisionedCostPerUnit : 0;

        if (savings > 1) {
          recs.push({
            instanceId: fn.functionName,
            instanceName: fn.description || fn.functionName,
            instanceType: `${fn.runtime} / ${fn.provisionedConcurrency} provisioned`,
            category: "lambda-provisioned-concurrency-waste",
            severity: getSeverity(savings),
            currentMonthlyCost: currentProvCost,
            estimatedSavings: savings,
            action: `Reduce provisioned concurrency for "${fn.functionName}" from ${fn.provisionedConcurrency} to ${suggested} — peak utilization is only ${(fn.provisionedConcurrencyUtilizationMax * 100).toFixed(0)}%`,
            reasoning: `Provisioned concurrency peak utilization is ${(fn.provisionedConcurrencyUtilizationMax * 100).toFixed(0)}% (max ~${peakUsed} concurrent). Current ${fn.provisionedConcurrency} units cost ~$${currentProvCost.toFixed(2)}/mo. Reducing to ${suggested} saves ~$${savings.toFixed(2)}/mo.`,
            metadata: buildMetadata({ region: data.region, accountId: data.accountId, arn: fn.functionArn, runtime: fn.runtime, memorySize: String(fn.memorySize), architecture: fn.architecture }),
          });
        }
      }
    }
  }

  return recs;
}

// ─── LLM prompt (judgment-based categories) ──────────────────────────────────

const LAMBDA_SYSTEM_PROMPT = `You are an AWS cost optimization expert. Analyze Lambda function metrics and return JSON recommendations.

Return a JSON array of objects with these fields:
- instanceId (function name), instanceName, instanceType, category, severity ("high"/"medium"/"low"), currentMonthlyCost, estimatedSavings, action, reasoning

You ONLY analyze for these categories (all others are handled separately — do NOT generate them):
- "lambda-right-size-memory": Functions where memory could be optimized based on usage patterns. Use AWS Lambda Power Tuning logic — consider cases where MORE memory might be cheaper (faster execution at higher memory = fewer GB-seconds).
- "lambda-consolidate": Multiple small functions that could be merged to reduce cold starts and overhead.
- "lambda-scheduling": Functions invoked on predictable schedules that could benefit from provisioned concurrency or be replaced with Step Functions.
- "lambda-architecture": Cross-cutting architectural suggestions — e.g., using Lambda@Edge, replacing polling Lambdas with event-driven patterns, or moving high-frequency Lambdas to Fargate.

Do NOT generate recommendations for: lambda-unused-function, lambda-overprovisioned-memory, lambda-excessive-timeout, lambda-old-runtime, lambda-no-arm64, lambda-excessive-versions, lambda-provisioned-concurrency-waste. These are computed separately.
Do NOT generate recommendations for functions with 0 invocations — these are already flagged as unused.

Severity: high (>$50/mo savings), medium ($10-50/mo), low (<$10/mo or operational).
estimatedSavings MUST NOT exceed the total Lambda cost for the resources involved.
Return ONLY a JSON array. No markdown, no explanation outside the JSON.
If no recommendations, return [].`;

// ─── Main analysis function ──────────────────────────────────────────────────

export async function analyzeLambdaWithClaude(
  data: LambdaAccountData
): Promise<Recommendation[]> {
  // Step 1: Deterministic recs
  const deterministicRecs = generateLambdaDeterministicRecs(data);

  // Step 2: LLM recs for judgment-based categories
  let llmRecs: Recommendation[] = [];

  // Only call LLM if there are active functions (with invocations)
  const activeFunctions = data.functions.filter(
    (f) => (f.metrics.invocationsSum ?? 0) > 0
  );

  if (activeFunctions.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn("ANTHROPIC_API_KEY not set — skipping LLM analysis for Lambda");
    } else {
      try {
        const client = new Anthropic({ apiKey });
        const prompt = buildLambdaPrompt(data, activeFunctions);
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: LAMBDA_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        });
        llmRecs = parseResponse(response);
        if (llmRecs.length === 0) {
          console.log(`[Lambda Analyzer] LLM returned 0 recommendations for ${activeFunctions.length} active functions`);
        }
      } catch (err: any) {
        console.warn(`Lambda LLM analysis failed: ${err.message}`);
      }
    }
  }

  // Enrich LLM recs with metadata from collector data
  const fnMap = new Map(data.functions.map(f => [f.functionName, f]));
  for (const rec of llmRecs) {
    const fn = fnMap.get(rec.instanceId);
    if (fn) {
      rec.metadata = buildMetadata({
        region: data.region,
        accountId: data.accountId,
        arn: fn.functionArn,
        runtime: fn.runtime,
        memorySize: String(fn.memorySize),
        architecture: fn.architecture,
      });
    }
  }

  // Step 3: Merge — deterministic wins
  const merged = mergeLambdaRecommendations(deterministicRecs, llmRecs);

  // Step 4: Deduplicate
  return deduplicateLambdaRecommendations(merged);
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicateLambdaRecommendations(recs: Recommendation[]): Recommendation[] {
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

    // Unused function suppresses all other recs
    const hasUnused = uniqueByCategory.some((r) => r.category === "lambda-unused-function");
    if (hasUnused) {
      result.push(...uniqueByCategory.filter((r) => r.category === "lambda-unused-function"));
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

function mergeLambdaRecommendations(
  deterministic: Recommendation[],
  llm: Recommendation[]
): Recommendation[] {
  const deterministicCategories = new Set([
    "lambda-unused-function",
    "lambda-overprovisioned-memory",
    "lambda-excessive-timeout",
    "lambda-old-runtime",
    "lambda-no-arm64",
    "lambda-excessive-versions",
    "lambda-provisioned-concurrency-waste",
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

function buildLambdaPrompt(
  data: LambdaAccountData,
  activeFunctions: LambdaFunctionData[]
): string {
  let prompt = `Analyze the following Lambda functions for cost savings.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n`;
  prompt += `Total Lambda cost: $${data.accountSummary.totalMonthlyCost.toFixed(2)}/mo\n`;
  prompt += `Total functions: ${data.functions.length} (${activeFunctions.length} active)\n\n`;

  prompt += `## Active Lambda Functions\n\n`;

  for (const fn of activeFunctions) {
    const invocations = fn.metrics.invocationsSum ?? 0;
    const monthlyInvocations = invocations * (30 / 14);

    prompt += `- **${fn.functionName}**`;
    prompt += ` | Runtime: ${fn.runtime} | Arch: ${fn.architecture}`;
    prompt += ` | Memory: ${fn.memorySize}MB | Timeout: ${fn.timeout}s`;
    prompt += ` | Cost: $${fn.currentMonthlyCost.toFixed(2)}/mo${fn.costIsActual ? " (actual)" : " (est)"}`;
    prompt += ` | Invocations (14d): ${invocations.toLocaleString()} (~${Math.round(monthlyInvocations).toLocaleString()}/mo)`;

    if (fn.metrics.durationAvg != null) {
      prompt += ` | Duration avg: ${fn.metrics.durationAvg.toFixed(0)}ms, max: ${fn.metrics.durationMax?.toFixed(0) ?? "N/A"}ms`;
    }
    if (fn.metrics.errorsSum != null && fn.metrics.errorsSum > 0) {
      prompt += ` | Errors: ${fn.metrics.errorsSum}`;
    }
    if (fn.metrics.throttlesSum != null && fn.metrics.throttlesSum > 0) {
      prompt += ` | Throttles: ${fn.metrics.throttlesSum}`;
    }
    if (fn.metrics.concurrentExecutionsMax != null) {
      prompt += ` | ConcurrencyMax: ${fn.metrics.concurrentExecutionsMax.toFixed(0)}`;
    }
    if (fn.provisionedConcurrency > 0) {
      prompt += ` | Provisioned: ${fn.provisionedConcurrency}`;
    }
    if (fn.description) {
      prompt += ` | Desc: ${fn.description.slice(0, 80)}`;
    }

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
    console.warn("No JSON array found in Lambda Claude response:", text.slice(0, 200));
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
    console.warn("Failed to parse Lambda Claude response as JSON:", err);
    return [];
  }
}
