import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import db from "../db";
import { decrypt } from "../crypto";

const router = Router();

const SYSTEM_PROMPT = `You are an AWS solutions architect. Given an AWS cost optimization recommendation, provide TWO things:

1. **CONSOLE**: Step-by-step instructions to implement the fix using the AWS Management Console. Be specific — reference exact menu paths, button names, and settings. Use the actual resource IDs, regions, and metadata provided.

2. **CLI**: The exact AWS CLI commands needed to implement the fix. Include all necessary flags, use the actual resource identifiers provided, and add brief comments explaining each command.

IMPORTANT RULES:
- Use the ACTUAL resource IDs, names, regions, and metadata from the recommendation — never use placeholders like <instance-id>
- For CLI commands, always include --region flag with the actual region
- Include any prerequisite checks or warnings (e.g., "ensure no active connections before stopping")
- If the action could cause downtime, warn about it
- Keep instructions concise but complete
- Format console steps as numbered lists
- Format CLI commands as code blocks with comments

Respond in EXACTLY this JSON format:
{
  "console": "markdown formatted console instructions",
  "cli": "markdown formatted CLI commands with code blocks"
}

Respond with ONLY the JSON object, no other text.`;

router.post("/generate", async (req, res) => {
  const { category, action, instanceId, instanceType, metadata } = req.body;

  if (!category || !action) {
    return res.status(400).json({ error: "category and action are required" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured" });
  }

  try {
    const client = new Anthropic({ apiKey });

    const metadataStr = metadata
      ? Object.entries(metadata)
          .filter(([key]) => key !== "validationWarning")
          .map(([key, value]) => `- ${key}: ${value}`)
          .join("\n")
      : "No additional metadata";

    const userPrompt = `Generate implementation instructions for this AWS cost optimization recommendation:

**Category:** ${category}
**Action:** ${action}
**Resource ID:** ${instanceId || "N/A"}
**Resource Type:** ${instanceType || "N/A"}
**Resource Metadata:**
${metadataStr}

Provide specific console instructions and CLI commands to implement this recommendation.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: "Failed to parse LLM response" });
    }

    const solutions = JSON.parse(jsonMatch[0]);
    return res.json({
      console: solutions.console || "No console instructions available.",
      cli: solutions.cli || "No CLI commands available.",
    });
  } catch (err: any) {
    console.error("[Solutions] Error generating solutions:", err.message);
    return res.status(500).json({ error: "Failed to generate solutions" });
  }
});

// ─── POST /api/solutions/execute ─────────────────────────────────────────
// Executes AWS CLI commands using the specified account's credentials.

router.post("/execute", async (req, res) => {
  const { commands, accountId } = req.body;

  if (!commands || !accountId) {
    return res.status(400).json({ error: "commands and accountId are required" });
  }

  // Look up account and decrypt credentials
  const account = db
    .prepare("SELECT * FROM aws_accounts WHERE id = ?")
    .get(accountId) as any;

  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  let accessKeyId: string;
  let secretAccessKey: string;
  try {
    accessKeyId = decrypt(account.access_key_id_enc);
    secretAccessKey = decrypt(account.secret_access_key_enc);
  } catch {
    return res.status(500).json({ error: "Failed to decrypt account credentials" });
  }

  const region = account.default_region || "us-east-1";

  // Parse commands: rejoin line continuations, split into individual commands
  const rawLines = commands.replace(/\\\n/g, " ").split("\n");
  const parsedCommands: string[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;
    parsedCommands.push(trimmed);
  }

  if (parsedCommands.length === 0) {
    return res.status(400).json({ error: "No executable commands found" });
  }

  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_DEFAULT_REGION: region,
  };

  const outputs: string[] = [];
  let allSucceeded = true;

  for (const cmd of parsedCommands) {
    outputs.push(`$ ${cmd}`);
    try {
      const result = execSync(cmd, {
        env,
        timeout: 30000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (result.trim()) {
        outputs.push(result.trim());
      } else {
        outputs.push("(completed successfully)");
      }
    } catch (err: any) {
      allSucceeded = false;
      const stderr = err.stderr?.trim() || err.message || "Unknown error";
      outputs.push(`ERROR: ${stderr}`);
    }
    outputs.push(""); // blank line between commands
  }

  return res.json({
    success: allSucceeded,
    output: outputs.join("\n"),
  });
});

export default router;
