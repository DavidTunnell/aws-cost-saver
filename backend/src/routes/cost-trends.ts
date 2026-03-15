import { Router, Request, Response } from "express";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import db from "../db";
import { decrypt } from "../crypto";
import { getMonthlyCostTrend, VALID_SERVICES } from "../aws/cost-trends";

const router = Router();

interface AccountRow {
  id: number;
  name: string;
  aws_account_id: string;
  access_key_id_enc: string;
  secret_access_key_enc: string;
  default_region: string;
}

function parseParams(req: Request) {
  const months = Math.min(Math.max(parseInt(req.query.months as string) || 12, 1), 24);
  const service = req.query.service as string | undefined;
  const validService = service && VALID_SERVICES.includes(service) ? service : undefined;
  return { months, service: validService };
}

function createCEClient(account: AccountRow): CostExplorerClient {
  return new CostExplorerClient({
    region: account.default_region,
    credentials: {
      accessKeyId: decrypt(account.access_key_id_enc),
      secretAccessKey: decrypt(account.secret_access_key_enc),
    },
  });
}

// GET /api/cost-trends — aggregate all accounts
router.get("/", async (_req: Request, res: Response) => {
  const { months, service } = parseParams(_req);

  const accounts = db
    .prepare(`SELECT id, name, aws_account_id, access_key_id_enc, secret_access_key_enc, default_region FROM aws_accounts ORDER BY name`)
    .all() as AccountRow[];

  if (accounts.length === 0) {
    return res.json({ months, service: service || null, accounts: [] });
  }

  // Process accounts in batches of 5 to respect Cost Explorer rate limits
  const BATCH_SIZE = 5;
  const results: any[] = [];

  for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
    const batch = accounts.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (account) => {
        const client = createCEClient(account);
        const dataPoints = await getMonthlyCostTrend(client, months, service);
        return {
          accountId: account.id,
          accountName: account.name,
          dataPoints,
          error: null,
        };
      })
    );

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          accountId: batch[j].id,
          accountName: batch[j].name,
          dataPoints: [],
          error: result.reason?.message || "Failed to fetch cost data",
        });
      }
    }
  }

  res.json({ months, service: service || null, accounts: results });
});

// GET /api/cost-trends/:accountId — single account
router.get("/:accountId", async (req: Request, res: Response) => {
  const { months, service } = parseParams(req);

  const account = db
    .prepare(`SELECT id, name, aws_account_id, access_key_id_enc, secret_access_key_enc, default_region FROM aws_accounts WHERE id = ?`)
    .get(req.params.accountId) as AccountRow | undefined;

  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  try {
    const client = createCEClient(account);
    const dataPoints = await getMonthlyCostTrend(client, months, service);

    res.json({
      accountId: account.id,
      accountName: account.name,
      months,
      service: service || null,
      dataPoints,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
