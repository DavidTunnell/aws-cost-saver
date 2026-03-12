import Anthropic from "@anthropic-ai/sdk";
import type { CollectedData } from "../aws/collector";

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
}

const SYSTEM_PROMPT = `You are an AWS cost optimization expert. You analyze EC2 instance data and provide specific, actionable cost savings recommendations.

For each finding, you MUST return a JSON object with these exact fields:
- instanceId: the EC2 instance ID (or resource ID for EBS/EIP)
- instanceName: the Name tag or description
- instanceType: current instance type
- category: one of "right-size", "stop", "generation-upgrade", "reserved-instance", "savings-plan", "unused-eip", "orphan-ebs", "idle"
- severity: "high" (>$50/mo savings), "medium" ($10-50/mo), or "low" (<$10/mo)
- currentMonthlyCost: estimated current monthly cost in USD
- estimatedSavings: estimated monthly savings in USD
- action: a clear, specific action the user should take
- reasoning: 1-2 sentences explaining why

Analysis rules:
- CPU avg <10% over 14 days with max <30%: recommend right-sizing to a smaller instance
- CPU avg <5% with low network: flag as potentially idle, recommend stopping or terminating
- Old generation types (m3, m4, c3, c4, r3, r4, t1, t2, i2, d2): recommend upgrading to current generation (m7i, c7i, r7i, t3, etc.) for ~10-20% cost savings with better performance
- Stopped instances: flag EBS costs still being incurred
- Unattached EBS volumes: recommend deleting or snapshotting
- Idle Elastic IPs: recommend releasing (costs ~$3.65/month each since Feb 2024)
- Consistent usage (running 24/7 for months): recommend Reserved Instances or Savings Plans for 30-60% savings
- For right-sizing: suggest the specific smaller instance type (e.g., m5.xlarge -> m5.large)

Return ONLY a JSON array of recommendation objects. No markdown, no explanation outside the JSON.
If there are no recommendations for an account, return an empty array [].`;

export async function analyzeWithClaude(
  data: CollectedData
): Promise<Recommendation[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      `ANTHROPIC_API_KEY is not set. Env keys available: ${Object.keys(process.env).filter(k => k.includes("ANTHROPIC")).join(", ") || "none matching ANTHROPIC"}`
    );
  }

  const client = new Anthropic({ apiKey });

  // Build a concise summary for Claude
  const prompt = buildPrompt(data);

  // For large datasets, chunk instances
  const CHUNK_SIZE = 25;
  if (data.instances.length > CHUNK_SIZE) {
    return analyzeInChunks(client, data, CHUNK_SIZE);
  }

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  return parseResponse(response);
}

async function analyzeInChunks(
  client: Anthropic,
  data: CollectedData,
  chunkSize: number
): Promise<Recommendation[]> {
  const allRecommendations: Recommendation[] = [];
  const instanceChunks: CollectedData["instances"][] = [];

  for (let i = 0; i < data.instances.length; i += chunkSize) {
    instanceChunks.push(data.instances.slice(i, i + chunkSize));
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

  // Handle orphan volumes and idle EIPs in a separate call if present
  if (data.orphanVolumes.length > 0 || data.idleEips.length > 0) {
    const resourcePrompt = buildResourceOnlyPrompt(data);
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: resourcePrompt }],
    });
    allRecommendations.push(...parseResponse(response));
  }

  return allRecommendations;
}

function buildPrompt(data: CollectedData): string {
  let prompt = `Analyze the following AWS account for EC2 cost savings opportunities.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n`;
  prompt += `Collected at: ${data.collectedAt}\n\n`;

  prompt += `## EC2 Instances (${data.instances.length})\n\n`;
  for (const inst of data.instances) {
    prompt += `- **${inst.instanceId}** "${inst.name}" | ${inst.instanceType} | ${inst.state}`;
    if (inst.state === "running") {
      prompt += ` | CPU avg: ${inst.cpuAvg?.toFixed(1) ?? "N/A"}%, max: ${inst.cpuMax?.toFixed(1) ?? "N/A"}%`;
      prompt += ` | Net in: ${formatBytes(inst.networkInAvg)}, out: ${formatBytes(inst.networkOutAvg)}`;
    }
    if (inst.monthlyEstimate != null) {
      prompt += ` | On-demand est: $${inst.monthlyEstimate.toFixed(2)}/mo`;
    }
    if (inst.actualMonthlyCost != null) {
      prompt += ` | Actual cost: $${inst.actualMonthlyCost.toFixed(2)}/mo`;
    }
    prompt += ` | Launched: ${inst.launchTime}`;
    prompt += `\n`;
  }

  if (data.orphanVolumes.length > 0) {
    prompt += `\n## Unattached EBS Volumes (${data.orphanVolumes.length})\n\n`;
    for (const vol of data.orphanVolumes) {
      prompt += `- ${vol.volumeId} | ${vol.size}GB ${vol.volumeType} | Created: ${vol.createTime}\n`;
    }
  }

  if (data.idleEips.length > 0) {
    prompt += `\n## Idle Elastic IPs (${data.idleEips.length})\n\n`;
    for (const eip of data.idleEips) {
      prompt += `- ${eip.publicIp} (${eip.allocationId})\n`;
    }
  }

  prompt += `\nProvide your cost savings recommendations as a JSON array.`;
  return prompt;
}

function buildResourceOnlyPrompt(data: CollectedData): string {
  let prompt = `Analyze these orphaned AWS resources for cost savings.\n\n`;
  prompt += `Account: ${data.accountName} (${data.accountId})\n`;
  prompt += `Region: ${data.region}\n\n`;

  if (data.orphanVolumes.length > 0) {
    prompt += `## Unattached EBS Volumes (${data.orphanVolumes.length})\n\n`;
    for (const vol of data.orphanVolumes) {
      prompt += `- ${vol.volumeId} | ${vol.size}GB ${vol.volumeType} | Created: ${vol.createTime}\n`;
    }
  }

  if (data.idleEips.length > 0) {
    prompt += `\n## Idle Elastic IPs (${data.idleEips.length})\n\n`;
    for (const eip of data.idleEips) {
      prompt += `- ${eip.publicIp} (${eip.allocationId})\n`;
    }
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
