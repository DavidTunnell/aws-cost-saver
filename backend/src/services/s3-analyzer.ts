import Anthropic from "@anthropic-ai/sdk";
import type { S3CollectedData, S3BucketData } from "../aws/s3-collector";
import type { Recommendation } from "./analyzer";

// Re-export for convenience
export type { Recommendation };

// ─── Deterministic helpers ──────────────────────────────────────────────────

function getSeverity(savings: number): "high" | "medium" | "low" {
  if (savings > 50) return "high";
  if (savings >= 10) return "medium";
  return "low";
}

function bytesToGB(bytes: number | null): number {
  if (bytes == null || bytes <= 0) return 0;
  return bytes / (1024 * 1024 * 1024);
}

function hasBackupArchiveTag(tags: Record<string, string>): boolean {
  const allValues = Object.entries(tags)
    .map(([k, v]) => `${k} ${v}`.toLowerCase())
    .join(" ");
  return /backup|archive|log|cold|historical/.test(allValues);
}

// ─── Deterministic recommendations (6 categories) ──────────────────────────

function generateS3DeterministicRecs(data: S3CollectedData): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const bucket of data.buckets) {
    const standardGB = bytesToGB(bucket.standardStorageBytes);
    const totalGB = bytesToGB(bucket.totalStorageBytes);
    const cost = bucket.currentMonthlyCost;
    const costNote = bucket.costIsActual
      ? ""
      : " (estimate based on us-east-1 rates; actual cost may differ)";

    // Track which checks fire per bucket for dedup
    let firedNoLifecycle = false;
    let firedAllStandard = false;
    let firedGlacierCandidate = false;
    let firedNoIT = false;

    // 1. s3-no-lifecycle: No lifecycle policy AND >1GB Standard storage
    if (!bucket.hasLifecyclePolicy && standardGB > 1) {
      const savings = cost * 0.35;
      if (savings > 0) {
        firedNoLifecycle = true;
        recs.push({
          instanceId: bucket.bucketName,
          instanceName: bucket.bucketName,
          instanceType: `S3 ${totalGB.toFixed(1)}GB`,
          category: "s3-no-lifecycle",
          severity: getSeverity(savings),
          currentMonthlyCost: cost,
          estimatedSavings: savings,
          action: `Add lifecycle policy to ${bucket.bucketName} to transition or expire old objects`,
          reasoning: `Bucket has ${standardGB.toFixed(1)}GB in Standard with no lifecycle policy. Adding transitions to IA/Glacier could save ~35% ($${savings.toFixed(2)}/mo).${costNote}`,
        });
      }
    }

    // 2. s3-all-standard: 100% Standard storage AND >50GB
    const nonStandardBytes =
      (bucket.standardIAStorageBytes ?? 0) +
      (bucket.oneZoneIAStorageBytes ?? 0) +
      (bucket.glacierStorageBytes ?? 0) +
      (bucket.deepArchiveStorageBytes ?? 0) +
      (bucket.intelligentTieringStorageBytes ?? 0);

    if (standardGB > 50 && nonStandardBytes === 0) {
      // Savings = moving 40% of data to Standard-IA
      const savings = standardGB * (0.023 - 0.0125) * 0.4;
      if (savings > 0) {
        firedAllStandard = true;
        recs.push({
          instanceId: bucket.bucketName,
          instanceName: bucket.bucketName,
          instanceType: `S3 Standard ${standardGB.toFixed(1)}GB`,
          category: "s3-all-standard",
          severity: getSeverity(savings),
          currentMonthlyCost: cost,
          estimatedSavings: savings,
          action: `Add lifecycle transitions for ${bucket.bucketName} to move infrequently accessed objects to Standard-IA`,
          reasoning: `All ${standardGB.toFixed(1)}GB is in Standard class. Transitioning ~40% to Standard-IA saves ~$${savings.toFixed(2)}/mo.`,
        });
      }
    }

    // 3. s3-incomplete-multipart: Incomplete multipart uploads
    if (bucket.incompleteMultipartUploads > 0) {
      recs.push({
        instanceId: bucket.bucketName,
        instanceName: bucket.bucketName,
        instanceType: `S3 ${bucket.incompleteMultipartUploads} uploads`,
        category: "s3-incomplete-multipart",
        severity: "medium",
        currentMonthlyCost: 0,
        estimatedSavings: 0,
        action: `Abort incomplete multipart uploads in ${bucket.bucketName} and add AbortIncompleteMultipartUpload lifecycle rule`,
        reasoning: `Found ${bucket.incompleteMultipartUploads} incomplete multipart upload(s). These consume storage indefinitely until aborted. Add a lifecycle rule to auto-abort after 7 days.`,
      });
    }

    // 4. s3-versioning-no-lifecycle: Versioning ON + no lifecycle (subsume if #1 already fired)
    if (bucket.versioningEnabled && !bucket.hasLifecyclePolicy && !firedNoLifecycle) {
      const savings = cost * 0.20;
      if (savings > 0) {
        recs.push({
          instanceId: bucket.bucketName,
          instanceName: bucket.bucketName,
          instanceType: `S3 versioned ${totalGB.toFixed(1)}GB`,
          category: "s3-versioning-no-lifecycle",
          severity: getSeverity(savings),
          currentMonthlyCost: cost,
          estimatedSavings: savings,
          action: `Add NoncurrentVersionExpiration lifecycle rule to ${bucket.bucketName}`,
          reasoning: `Versioning is enabled but no lifecycle policy expires old versions. Noncurrent versions accumulate indefinitely, potentially adding ~20% to costs ($${savings.toFixed(2)}/mo).${costNote}`,
        });
      }
    }

    // 5. s3-glacier-candidate: >100GB Standard + backup/archive tags
    if (standardGB > 100 && hasBackupArchiveTag(bucket.tags)) {
      const glacierSavings = standardGB * (0.023 - 0.004);
      if (glacierSavings > 0) {
        firedGlacierCandidate = true;
        // Glacier subsumes all-standard if glacier savings > IA savings
        if (firedAllStandard) {
          const iaSavings = standardGB * (0.023 - 0.0125) * 0.4;
          if (glacierSavings > iaSavings) {
            // Remove the all-standard rec for this bucket
            const idx = recs.findIndex(
              (r) =>
                r.instanceId === bucket.bucketName &&
                r.category === "s3-all-standard"
            );
            if (idx >= 0) {
              recs.splice(idx, 1);
              firedAllStandard = false;
            }
          }
        }
        recs.push({
          instanceId: bucket.bucketName,
          instanceName: bucket.bucketName,
          instanceType: `S3 Standard ${standardGB.toFixed(1)}GB`,
          category: "s3-glacier-candidate",
          severity: getSeverity(glacierSavings),
          currentMonthlyCost: cost,
          estimatedSavings: glacierSavings,
          action: `Transition ${bucket.bucketName} to Glacier Instant Retrieval (tagged as backup/archive)`,
          reasoning: `Bucket has ${standardGB.toFixed(1)}GB Standard storage and is tagged for backup/archive use. Moving to Glacier Instant Retrieval saves ~$${glacierSavings.toFixed(2)}/mo.`,
        });
      }
    }

    // 6. s3-no-intelligent-tiering: >100GB Standard + no IT configured
    if (standardGB > 100 && !bucket.hasIntelligentTiering && !firedGlacierCandidate) {
      // Monitoring fee: $0.0025 per 1000 objects
      const monitoringFee = ((bucket.numberOfObjects ?? 0) / 1000) * 0.0025;
      const savings = cost * 0.30 - monitoringFee;
      if (savings > 0) {
        // Keep higher savings between all-standard and IT
        if (firedAllStandard) {
          const allStdRec = recs.find(
            (r) =>
              r.instanceId === bucket.bucketName &&
              r.category === "s3-all-standard"
          );
          if (allStdRec && savings > allStdRec.estimatedSavings) {
            // Replace all-standard with IT rec
            const idx = recs.indexOf(allStdRec);
            if (idx >= 0) recs.splice(idx, 1);
          } else {
            // all-standard has higher savings — skip IT rec
            continue;
          }
        }

        recs.push({
          instanceId: bucket.bucketName,
          instanceName: bucket.bucketName,
          instanceType: `S3 Standard ${standardGB.toFixed(1)}GB`,
          category: "s3-no-intelligent-tiering",
          severity: getSeverity(savings),
          currentMonthlyCost: cost,
          estimatedSavings: savings,
          action: `Enable S3 Intelligent-Tiering for ${bucket.bucketName}`,
          reasoning: `Bucket has ${standardGB.toFixed(1)}GB in Standard with no Intelligent-Tiering. IT auto-moves data between access tiers, saving ~$${savings.toFixed(2)}/mo after monitoring fees.${costNote}`,
        });
      }
    }
  }

  return recs;
}

// ─── LLM-only prompt (judgment-based categories) ────────────────────────────

const S3_SYSTEM_PROMPT = `You are an AWS cost optimization expert. Analyze S3 bucket data and return JSON recommendations.

Return a JSON array of objects with these fields:
- instanceId (bucket name), instanceName, instanceType, category, severity ("high"/"medium"/"low"), currentMonthlyCost, estimatedSavings, action, reasoning

You ONLY analyze for these categories (all others are handled separately — do NOT generate them):
- "s3-access-pattern-optimize": Suggest optimal storage class mix based on storage distribution, bucket tags, naming patterns, and size. For example: buckets with "logs" in name or tags should use lifecycle to Glacier, buckets with mixed access patterns should use Intelligent-Tiering with archive tiers enabled. Be specific about which tiers and transitions.
- "s3-consolidation": Identify opportunities to merge similar or very small buckets (<1GB) that share naming patterns, tags, or apparent purpose. Consolidation reduces management overhead and can enable better lifecycle policies. Only suggest when there are clear groupings.

Do NOT generate recommendations for: s3-no-lifecycle, s3-all-standard, s3-incomplete-multipart, s3-versioning-no-lifecycle, s3-glacier-candidate, s3-no-intelligent-tiering. These are computed separately.

Severity: high (>$50/mo savings), medium ($10-50/mo), low (<$10/mo).
Return ONLY a JSON array. No markdown, no explanation outside the JSON.
If no recommendations, return [].`;

// ─── Main analysis function ─────────────────────────────────────────────────

export async function analyzeS3WithClaude(
  data: S3CollectedData
): Promise<Recommendation[]> {
  // Step 1: Deterministic recs
  const deterministicRecs = generateS3DeterministicRecs(data);

  // Step 2: LLM recs for judgment-based categories
  let llmRecs: Recommendation[] = [];

  if (data.buckets.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn("ANTHROPIC_API_KEY not set — skipping LLM analysis for S3");
    } else {
      const client = new Anthropic({ apiKey });

      const CHUNK_SIZE = 30;
      if (data.buckets.length > CHUNK_SIZE) {
        llmRecs = await analyzeS3LlmInChunks(client, data, CHUNK_SIZE);
      } else {
        const prompt = buildS3Prompt(data);
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: S3_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        });
        llmRecs = parseResponse(response);
      }
    }
  }

  // Step 3: Merge — deterministic wins
  const merged = mergeS3Recommendations(deterministicRecs, llmRecs);
  return merged;
}

// ─── LLM helpers ────────────────────────────────────────────────────────────

function mergeS3Recommendations(
  deterministic: Recommendation[],
  llm: Recommendation[]
): Recommendation[] {
  const deterministicCategories = new Set([
    "s3-no-lifecycle",
    "s3-all-standard",
    "s3-incomplete-multipart",
    "s3-versioning-no-lifecycle",
    "s3-glacier-candidate",
    "s3-no-intelligent-tiering",
  ]);

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
  }

  return [...deterministic, ...filteredLlm];
}

async function analyzeS3LlmInChunks(
  client: Anthropic,
  data: S3CollectedData,
  chunkSize: number
): Promise<Recommendation[]> {
  const allRecs: Recommendation[] = [];

  for (let i = 0; i < data.buckets.length; i += chunkSize) {
    const chunk = data.buckets.slice(i, i + chunkSize);
    const chunkData: S3CollectedData = {
      ...data,
      buckets: chunk,
    };
    const prompt = buildS3Prompt(chunkData);
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: S3_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });
    allRecs.push(...parseResponse(response));
  }

  return allRecs;
}

function buildS3Prompt(data: S3CollectedData): string {
  let prompt = `Analyze the following S3 buckets for cost savings.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n`;
  prompt += `Total buckets: ${data.buckets.length}\n\n`;

  prompt += `## S3 Buckets\n\n`;

  for (const b of data.buckets) {
    const totalGB = bytesToGB(b.totalStorageBytes);
    const stdGB = bytesToGB(b.standardStorageBytes);
    const iaGB = bytesToGB(b.standardIAStorageBytes);
    const ozGB = bytesToGB(b.oneZoneIAStorageBytes);
    const glacierGB = bytesToGB(b.glacierStorageBytes);
    const daGB = bytesToGB(b.deepArchiveStorageBytes);
    const itGB = bytesToGB(b.intelligentTieringStorageBytes);

    prompt += `- **${b.bucketName}** | Region: ${b.region} | ${totalGB.toFixed(1)}GB total`;
    prompt += ` | Objects: ${b.numberOfObjects ?? "N/A"}`;
    prompt += ` | Cost: $${b.currentMonthlyCost.toFixed(2)}/mo`;

    // Storage breakdown
    const classes: string[] = [];
    if (stdGB > 0) classes.push(`Standard: ${stdGB.toFixed(1)}GB`);
    if (iaGB > 0) classes.push(`IA: ${iaGB.toFixed(1)}GB`);
    if (ozGB > 0) classes.push(`OneZone-IA: ${ozGB.toFixed(1)}GB`);
    if (glacierGB > 0) classes.push(`Glacier: ${glacierGB.toFixed(1)}GB`);
    if (daGB > 0) classes.push(`DeepArchive: ${daGB.toFixed(1)}GB`);
    if (itGB > 0) classes.push(`IT: ${itGB.toFixed(1)}GB`);
    if (classes.length > 0) prompt += ` | ${classes.join(", ")}`;

    // Config
    prompt += ` | Versioning: ${b.versioningEnabled ? "ON" : "OFF"}`;
    prompt += ` | Lifecycle: ${b.hasLifecyclePolicy ? "YES" : "NO"}`;
    prompt += ` | IT config: ${b.hasIntelligentTiering ? "YES" : "NO"}`;
    if (b.incompleteMultipartUploads > 0)
      prompt += ` | Incomplete uploads: ${b.incompleteMultipartUploads}`;

    // Tags
    const tagStr = Object.entries(b.tags)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    if (tagStr) prompt += ` | Tags: ${tagStr}`;

    prompt += ` | Created: ${b.creationDate}`;
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
      "No JSON array found in S3 Claude response:",
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
    console.warn("Failed to parse S3 Claude response as JSON:", err);
    return [];
  }
}
