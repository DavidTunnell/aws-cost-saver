import { Router, Request, Response } from "express";
import db from "../db";
import { decrypt } from "../crypto";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";

const router = Router();

// ─── GET /api/reports/cost-trends ─────────────────────────────────────────
// Returns monthly (or daily) cost data for a given account, grouped by service.

interface CostPeriod {
  start: string;
  end: string;
  totalCost: number;
  byService: Record<string, number>;
}

router.get("/cost-trends", async (req: Request, res: Response) => {
  const accountId = parseInt(req.query.accountId as string, 10);
  if (!accountId || isNaN(accountId)) {
    return res.status(400).json({ error: "accountId query parameter is required" });
  }

  const months = Math.min(Math.max(parseInt(req.query.months as string, 10) || 6, 1), 12);
  const granularity = (req.query.granularity as string)?.toUpperCase() === "DAILY" ? "DAILY" : "MONTHLY";
  const serviceFilter = req.query.services
    ? (req.query.services as string).split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // Look up account
  const account = db
    .prepare(`SELECT * FROM aws_accounts WHERE id = ?`)
    .get(accountId) as any;
  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  try {
    const costExplorer = new CostExplorerClient({
      region: account.default_region || "us-east-1",
      credentials: {
        accessKeyId: decrypt(account.access_key_id_enc),
        secretAccessKey: decrypt(account.secret_access_key_enc),
      },
    });

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);
    // Align to first of month for MONTHLY granularity
    if (granularity === "MONTHLY") {
      startDate.setDate(1);
    }

    const formatDate = (d: Date) => d.toISOString().split("T")[0];

    // Build filter
    let filter: any = undefined;
    if (serviceFilter.length > 0) {
      filter = {
        Dimensions: {
          Key: "SERVICE",
          Values: serviceFilter,
        },
      };
    }

    const resp = await costExplorer.send(
      new GetCostAndUsageCommand({
        TimePeriod: {
          Start: formatDate(startDate),
          End: formatDate(endDate),
        },
        Granularity: granularity,
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        Filter: filter,
      })
    );

    const periods: CostPeriod[] = [];

    for (const result of resp.ResultsByTime || []) {
      const byService: Record<string, number> = {};
      let totalCost = 0;

      for (const group of result.Groups || []) {
        const service = group.Keys?.[0] || "Other";
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
        if (cost > 0.01) {
          byService[service] = Math.round(cost * 100) / 100;
          totalCost += cost;
        }
      }

      // Only include periods with actual spending
      if (totalCost > 0.01) {
        periods.push({
          start: result.TimePeriod?.Start || "",
          end: result.TimePeriod?.End || "",
          totalCost: Math.round(totalCost * 100) / 100,
          byService,
        });
      }
    }

    res.json({
      accountId: account.id,
      accountName: account.name,
      awsAccountId: account.aws_account_id || "",
      granularity,
      months,
      periods,
    });
  } catch (err: any) {
    console.error(`[Reports] Cost trends query failed for account ${accountId}:`, err.message);
    res.status(500).json({ error: `Failed to fetch cost data: ${err.message}` });
  }
});

// ─── GET /api/reports/services ────────────────────────────────────────────
// Returns a list of AWS services with costs for a given account (for filter dropdown).

router.get("/services", async (req: Request, res: Response) => {
  const accountId = parseInt(req.query.accountId as string, 10);
  if (!accountId || isNaN(accountId)) {
    return res.status(400).json({ error: "accountId query parameter is required" });
  }

  const account = db
    .prepare(`SELECT * FROM aws_accounts WHERE id = ?`)
    .get(accountId) as any;
  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  try {
    const costExplorer = new CostExplorerClient({
      region: account.default_region || "us-east-1",
      credentials: {
        accessKeyId: decrypt(account.access_key_id_enc),
        secretAccessKey: decrypt(account.secret_access_key_enc),
      },
    });

    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 3);
    startDate.setDate(1);

    const formatDate = (d: Date) => d.toISOString().split("T")[0];

    const resp = await costExplorer.send(
      new GetCostAndUsageCommand({
        TimePeriod: {
          Start: formatDate(startDate),
          End: formatDate(endDate),
        },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      })
    );

    const serviceCosts = new Map<string, number>();
    for (const result of resp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const service = group.Keys?.[0] || "";
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
        if (service && cost > 0.01) {
          serviceCosts.set(service, (serviceCosts.get(service) || 0) + cost);
        }
      }
    }

    // Sort by cost descending
    const services = [...serviceCosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, totalCost]) => ({
        name,
        totalCost: Math.round(totalCost * 100) / 100,
      }));

    res.json({ services });
  } catch (err: any) {
    console.error(`[Reports] Services query failed for account ${accountId}:`, err.message);
    res.status(500).json({ error: `Failed to fetch services: ${err.message}` });
  }
});

export default router;
