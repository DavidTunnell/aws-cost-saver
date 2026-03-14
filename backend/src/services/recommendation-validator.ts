import Anthropic from "@anthropic-ai/sdk";
import type { DedupResult } from "./full-audit-analyzer";

// ─── Severity helper (local copy — same thresholds used across all analyzers) ─

function getSeverity(savings: number): "high" | "medium" | "low" {
  if (savings > 50) return "high";
  if (savings >= 10) return "medium";
  return "low";
}

// ─── Expected savings ratios for deterministic-formula categories ─────────────

const EXPECTED_RATIOS: Record<string, number> = {
  "right-size": 0.50,
  "stop": 1.00,
  "idle": 1.00,
  "schedule-stop": 0.65,
  "reserved-instance": 0.40,
  "savings-plan": 0.40,
  "rds-right-size": 0.40,
  "rds-reserved-instance": 0.40,
  "rds-aurora-migration": 0.25,
};

const RATIO_TOLERANCE = 0.02;

// ─── Part A: Deterministic validation (no LLM) ──────────────────────────────

function deterministicValidate(recs: DedupResult[]): { recs: DedupResult[]; fixes: string[] } {
  const fixes: string[] = [];

  for (const rec of recs) {
    // Rule 1: Cross-service recs must have $0 savings
    if (rec.category === "cross-service" && rec.estimatedSavings !== 0) {
      fixes.push(`[${rec.instanceId}] cross-service: zeroed savings from $${rec.estimatedSavings.toFixed(2)}`);
      rec.estimatedSavings = 0;
      rec.currentMonthlyCost = 0;
    }

    // Rule 2: Savings on zero-cost resource
    if (rec.category !== "cross-service" && rec.currentMonthlyCost === 0 && rec.estimatedSavings > 0) {
      fixes.push(`[${rec.instanceId}] ${rec.category}: zeroed savings ($${rec.estimatedSavings.toFixed(2)}) on $0 cost resource`);
      rec.estimatedSavings = 0;
    }

    // Rule 3: Savings exceeds cost
    if (rec.currentMonthlyCost > 0 && rec.estimatedSavings > rec.currentMonthlyCost) {
      fixes.push(`[${rec.instanceId}] ${rec.category}: capped savings from $${rec.estimatedSavings.toFixed(2)} to $${rec.currentMonthlyCost.toFixed(2)} (was > cost)`);
      rec.estimatedSavings = rec.currentMonthlyCost;
    }

    // Rule 4: Savings ratio check for deterministic-formula categories
    const expectedRatio = EXPECTED_RATIOS[rec.category];
    if (expectedRatio != null && rec.currentMonthlyCost > 0) {
      const actualRatio = rec.estimatedSavings / rec.currentMonthlyCost;
      if (Math.abs(actualRatio - expectedRatio) > RATIO_TOLERANCE) {
        const corrected = rec.currentMonthlyCost * expectedRatio;
        fixes.push(
          `[${rec.instanceId}] ${rec.category}: corrected savings ratio from ${(actualRatio * 100).toFixed(1)}% to ${(expectedRatio * 100).toFixed(1)}% ($${rec.estimatedSavings.toFixed(2)} → $${corrected.toFixed(2)})`
        );
        rec.estimatedSavings = corrected;
      }
    }

    // Rule 5: Severity mismatch (run last, after savings corrections)
    const expectedSeverity = getSeverity(rec.estimatedSavings);
    if (rec.severity !== expectedSeverity) {
      fixes.push(`[${rec.instanceId}] ${rec.category}: corrected severity from "${rec.severity}" to "${expectedSeverity}" (savings=$${rec.estimatedSavings.toFixed(2)})`);
      rec.severity = expectedSeverity;
    }
  }

  return { recs, fixes };
}

// ─── Part B: LLM coherence check (recs with savings >= $10) ──────────────────

function getValidationSystemPrompt(): string {
  const today = new Date().toISOString().split("T")[0];
  return `You are an AWS cost optimization QA reviewer. Today's date is ${today}. You are given recommendations that have already passed math/cost validation. Your job is to check ONLY for logical and reasoning errors.

For each recommendation, check:
1. Does the reasoning make sense for the stated category? (e.g., a "right-size" rec should discuss CPU/memory utilization, not storage)
2. Does the recommended action match what the category implies? (e.g., "rds-gp2-to-gp3" should not recommend deleting the instance)
3. Is the reasoning specific to the actual resource, or is it vague generic boilerplate that could apply to anything?
4. Are any time-based claims accurate? (e.g., "created over 90 days ago" — verify against today's date ${today})

For each recommendation index, respond with:
- "ok" if the recommendation is coherent and makes sense
- {"flag": "brief explanation of what is wrong and what should be verified"} if something is clearly wrong

Only flag CLEAR errors. When in doubt, respond with "ok". It is better to let a slightly imperfect recommendation through than to incorrectly flag a valid one.

Return ONLY a JSON object mapping recommendation index (as string) to status. No markdown, no explanation outside the JSON.

Example response:
{"0": "ok", "1": "ok", "2": {"flag": "reasoning discusses S3 storage tiers but category is EC2 right-size — verify the recommendation category is correct"}}`;
}

function buildValidationPrompt(recs: DedupResult[]): string {
  let prompt = "Review these AWS cost optimization recommendations for logical/reasoning coherence:\n\n";

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    prompt += `[${i}] category=${rec.category} | resource=${rec.instanceId} "${rec.instanceName}" (${rec.instanceType})\n`;
    prompt += `    savings=$${rec.estimatedSavings.toFixed(2)}/mo (from $${rec.currentMonthlyCost.toFixed(2)}/mo) | severity=${rec.severity}\n`;
    prompt += `    action: ${rec.action}\n`;
    prompt += `    reasoning: ${rec.reasoning}\n\n`;
  }

  prompt += "Return a JSON object mapping each index to \"ok\" or {\"flag\": \"explanation\"}.";
  return prompt;
}

async function llmValidate(recs: DedupResult[]): Promise<Map<number, string>> {
  const warnings = new Map<number, string>();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[Validator] No ANTHROPIC_API_KEY — skipping LLM coherence check");
    return warnings;
  }

  const client = new Anthropic({ apiKey });
  const prompt = buildValidationPrompt(recs);

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: getValidationSystemPrompt(),
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[Validator] LLM returned no JSON — skipping coherence check");
      return warnings;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed !== "object" || parsed === null) return warnings;

    for (const [indexStr, status] of Object.entries(parsed)) {
      const idx = parseInt(indexStr, 10);
      if (isNaN(idx) || idx < 0 || idx >= recs.length) continue;

      if (typeof status === "object" && status !== null && "flag" in status) {
        const flagText = String((status as any).flag);
        warnings.set(idx, flagText);
      }
    }
  } catch (err: any) {
    console.warn(`[Validator] LLM coherence check failed: ${err.message}`);
  }

  return warnings;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function validateRecommendations(recs: DedupResult[]): Promise<DedupResult[]> {
  console.log(`[Validator] Starting validation of ${recs.length} recommendations`);

  // Part A: Deterministic validation (all recs)
  const { recs: fixedRecs, fixes } = deterministicValidate(recs);
  if (fixes.length > 0) {
    console.log(`[Validator] Deterministic fixes (${fixes.length}):`);
    for (const fix of fixes) {
      console.log(`  ${fix}`);
    }
  } else {
    console.log("[Validator] Deterministic check: no issues found");
  }

  // Part B: LLM coherence check (recs with savings >= $10 only)
  const significantRecs = fixedRecs.filter((r) => r.estimatedSavings >= 10);
  console.log(`[Validator] LLM coherence check: ${significantRecs.length} recommendations >= $10`);

  if (significantRecs.length > 0) {
    const warnings = await llmValidate(significantRecs);

    if (warnings.size > 0) {
      console.log(`[Validator] LLM flagged ${warnings.size} recommendation(s):`);

      // Map significant rec indices back to the full array
      const significantIndices = fixedRecs
        .map((r, i) => (r.estimatedSavings >= 10 ? i : -1))
        .filter((i) => i !== -1);

      for (const [sigIdx, warningText] of warnings) {
        const fullIdx = significantIndices[sigIdx];
        if (fullIdx == null) continue;

        const rec = fixedRecs[fullIdx];
        console.log(`  [${rec.instanceId}] ${rec.category}: ${warningText}`);

        // Add warning to metadata (non-destructive — does not change savings/action/reasoning)
        if (!rec.metadata) rec.metadata = {};
        rec.metadata.validationWarning = warningText;
      }
    } else {
      console.log("[Validator] LLM coherence check: all recommendations OK");
    }
  }

  console.log(`[Validator] Validation complete`);
  return fixedRecs;
}
