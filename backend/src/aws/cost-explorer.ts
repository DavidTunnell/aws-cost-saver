import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type ResultByTime,
} from "@aws-sdk/client-cost-explorer";

export interface InstanceTypeCost {
  instanceType: string;
  totalCost: number;
  currency: string;
}

export interface SnapshotCostData {
  /** Per-snapshot actual monthly cost (snapshot ID → $/mo). Only populated if resource-level data is available. */
  costBySnapshot: Map<string, number>;
  /** Total actual snapshot cost for the account ($/mo). */
  totalSnapshotCost: number;
  /** Total snapshot usage in GB-months from Cost Explorer. */
  totalGbMonths: number;
  /** Whether per-resource data was available (vs aggregate only). */
  hasResourceData: boolean;
}

export async function getEC2CostsByType(
  client: CostExplorerClient,
  days: number = 30
): Promise<{ costByType: Map<string, number>; totalEC2Cost: number }> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  const formatDate = (d: Date) => d.toISOString().split("T")[0];

  try {
    const resp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: {
          Start: formatDate(startDate),
          End: formatDate(endDate),
        },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [
          { Type: "DIMENSION", Key: "INSTANCE_TYPE" },
        ],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["Amazon Elastic Compute Cloud - Compute"],
          },
        },
      })
    );

    const costByType = new Map<string, number>();
    let totalEC2Cost = 0;

    for (const result of resp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const instType = group.Keys?.[0] || "";
        const cost = parseFloat(
          group.Metrics?.UnblendedCost?.Amount || "0"
        );
        if (instType && cost > 0) {
          costByType.set(instType, (costByType.get(instType) || 0) + cost);
          totalEC2Cost += cost;
        }
      }
    }

    return { costByType, totalEC2Cost };
  } catch (err: any) {
    console.warn(`Cost Explorer query failed: ${err.message}`);
    return { costByType: new Map(), totalEC2Cost: 0 };
  }
}

/**
 * Fetches actual EBS snapshot costs from Cost Explorer.
 *
 * Strategy:
 * 1. Try per-resource grouping (RESOURCE_ID) to get actual cost per snapshot.
 * 2. If that fails or returns no data, fall back to aggregate snapshot cost
 *    which can be distributed proportionally across snapshots by provisioned size.
 * 3. If Cost Explorer fails entirely, returns null (caller should fall back to estimates).
 */
export async function getSnapshotCosts(
  client: CostExplorerClient,
  days: number = 30
): Promise<SnapshotCostData | null> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0];
  const timePeriod = { Start: formatDate(startDate), End: formatDate(endDate) };

  // First, get the aggregate snapshot cost and identify the exact usage type(s)
  let snapshotUsageTypes: string[] = [];
  let totalSnapshotCost = 0;
  let totalGbMonths = 0;

  try {
    const aggResp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost", "UsageQuantity"],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["EC2 - Other"],
          },
        },
        GroupBy: [{ Type: "DIMENSION", Key: "USAGE_TYPE" }],
      })
    );

    for (const result of aggResp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const usageType = group.Keys?.[0] || "";
        if (!usageType.includes("SnapshotUsage")) continue;
        snapshotUsageTypes.push(usageType);
        totalSnapshotCost += parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
        totalGbMonths += parseFloat(group.Metrics?.UsageQuantity?.Amount || "0");
      }
    }

    if (totalSnapshotCost <= 0 && totalGbMonths <= 0) {
      console.warn("Cost Explorer returned no snapshot usage data");
      return null;
    }
  } catch (err: any) {
    console.warn(`Cost Explorer snapshot aggregate query failed: ${err.message}`);
    return null;
  }

  // Now try per-resource grouping for per-snapshot costs
  const costBySnapshot = new Map<string, number>();
  let hasResourceData = false;

  if (snapshotUsageTypes.length > 0) {
    try {
      const resourceResp = await client.send(
        new GetCostAndUsageCommand({
          TimePeriod: timePeriod,
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost", "UsageQuantity"],
          Filter: {
            And: [
              {
                Dimensions: {
                  Key: "SERVICE",
                  Values: ["EC2 - Other"],
                },
              },
              {
                Dimensions: {
                  Key: "USAGE_TYPE",
                  Values: snapshotUsageTypes,
                },
              },
            ],
          },
          GroupBy: [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
        })
      );

      for (const result of resourceResp.ResultsByTime || []) {
        for (const group of result.Groups || []) {
          const resourceId = group.Keys?.[0] || "";
          const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
          if (!resourceId || cost <= 0) continue;

          // Resource ID may be a full ARN or just snap-xxx; extract snapshot ID
          const snapId = resourceId.includes("/")
            ? resourceId.split("/").pop()!
            : resourceId;

          costBySnapshot.set(snapId, (costBySnapshot.get(snapId) || 0) + cost);
        }
      }

      hasResourceData = costBySnapshot.size > 0;
    } catch (err: any) {
      // Resource-level grouping not available — fall back to aggregate
      console.warn(`Cost Explorer per-resource query failed (will use aggregate): ${err.message}`);
    }
  }

  return {
    costBySnapshot,
    totalSnapshotCost,
    totalGbMonths,
    hasResourceData,
  };
}

// ─── RDS Backup/Snapshot Costs ──────────────────────────────────────────────

export interface RDSSnapshotCostData {
  /** Per-snapshot actual monthly cost (snapshot ARN/ID → $/mo). Only populated if resource-level data is available. */
  costBySnapshot: Map<string, number>;
  /** Total actual RDS backup/snapshot cost for the account ($/mo). */
  totalSnapshotCost: number;
  /** Total RDS backup usage in GB-months from Cost Explorer. */
  totalGbMonths: number;
  /** Whether per-resource data was available (vs aggregate only). */
  hasResourceData: boolean;
}

/**
 * Fetches actual RDS backup/snapshot costs from Cost Explorer.
 *
 * Strategy (same as EBS snapshots):
 * 1. Try per-resource grouping (RESOURCE_ID) to get actual cost per snapshot.
 * 2. If that fails or returns no data, fall back to aggregate snapshot cost
 *    which can be distributed proportionally across snapshots by allocated size.
 * 3. If Cost Explorer fails entirely, returns null (caller should fall back to estimates).
 */
export async function getRDSSnapshotCosts(
  client: CostExplorerClient,
  days: number = 30
): Promise<RDSSnapshotCostData | null> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0];
  const timePeriod = { Start: formatDate(startDate), End: formatDate(endDate) };

  // First, get the aggregate RDS backup cost by usage type
  let backupUsageTypes: string[] = [];
  let totalSnapshotCost = 0;
  let totalGbMonths = 0;

  try {
    const aggResp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost", "UsageQuantity"],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["Amazon Relational Database Service"],
          },
        },
        GroupBy: [{ Type: "DIMENSION", Key: "USAGE_TYPE" }],
      })
    );

    for (const result of aggResp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const usageType = group.Keys?.[0] || "";
        // RDS backup usage types contain "BackupUsage" or "ChargedBackupUsage"
        if (!usageType.includes("BackupUsage") && !usageType.includes("ChargedBackupUsage")) continue;
        backupUsageTypes.push(usageType);
        totalSnapshotCost += parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
        totalGbMonths += parseFloat(group.Metrics?.UsageQuantity?.Amount || "0");
      }
    }

    if (totalSnapshotCost <= 0 && totalGbMonths <= 0) {
      console.warn("Cost Explorer returned no RDS backup usage data");
      return null;
    }
  } catch (err: any) {
    console.warn(`Cost Explorer RDS backup aggregate query failed: ${err.message}`);
    return null;
  }

  // Now try per-resource grouping for per-snapshot costs
  const costBySnapshot = new Map<string, number>();
  let hasResourceData = false;

  if (backupUsageTypes.length > 0) {
    try {
      const resourceResp = await client.send(
        new GetCostAndUsageCommand({
          TimePeriod: timePeriod,
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost", "UsageQuantity"],
          Filter: {
            And: [
              {
                Dimensions: {
                  Key: "SERVICE",
                  Values: ["Amazon Relational Database Service"],
                },
              },
              {
                Dimensions: {
                  Key: "USAGE_TYPE",
                  Values: backupUsageTypes,
                },
              },
            ],
          },
          GroupBy: [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
        })
      );

      for (const result of resourceResp.ResultsByTime || []) {
        for (const group of result.Groups || []) {
          const resourceId = group.Keys?.[0] || "";
          const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
          if (!resourceId || cost <= 0) continue;

          // Resource ID may be an ARN; extract just the snapshot identifier
          const snapId = resourceId.includes(":")
            ? resourceId.split(":").pop()!
            : resourceId;

          costBySnapshot.set(snapId, (costBySnapshot.get(snapId) || 0) + cost);
        }
      }

      hasResourceData = costBySnapshot.size > 0;
    } catch (err: any) {
      console.warn(`Cost Explorer RDS per-resource query failed (will use aggregate): ${err.message}`);
    }
  }

  return {
    costBySnapshot,
    totalSnapshotCost,
    totalGbMonths,
    hasResourceData,
  };
}

// ─── S3 Bucket Costs ────────────────────────────────────────────────────────

export interface S3BucketCostData {
  /** Per-bucket actual monthly cost (bucket name → $/mo). */
  costByBucket: Map<string, number>;
  /** Total actual S3 cost for the account ($/mo). */
  totalS3Cost: number;
  /** Whether per-resource data was available. */
  hasResourceData: boolean;
}

/**
 * Fetches actual S3 storage costs from Cost Explorer, grouped by bucket.
 *
 * Returns per-bucket costs from Cost Explorer which include all storage classes,
 * request costs, and data transfer — more accurate than hardcoded per-GB rates.
 * Returns null if Cost Explorer fails entirely.
 */
export async function getS3BucketCosts(
  client: CostExplorerClient,
  days: number = 30
): Promise<S3BucketCostData | null> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0];
  const timePeriod = { Start: formatDate(startDate), End: formatDate(endDate) };

  // First get aggregate S3 cost
  let totalS3Cost = 0;

  try {
    const aggResp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["Amazon Simple Storage Service"],
          },
        },
      })
    );

    for (const result of aggResp.ResultsByTime || []) {
      for (const metric of Object.values(result.Total || {})) {
        totalS3Cost += parseFloat(metric.Amount || "0");
      }
    }

    if (totalS3Cost <= 0) {
      console.warn("Cost Explorer returned no S3 cost data");
      return null;
    }
  } catch (err: any) {
    console.warn(`Cost Explorer S3 aggregate query failed: ${err.message}`);
    return null;
  }

  // Now try per-resource grouping for per-bucket costs (with timeout — this
  // query requires resource-level cost allocation and can be very slow)
  const costByBucket = new Map<string, number>();
  let hasResourceData = false;

  try {
    const resourcePromise = client.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["Amazon Simple Storage Service"],
          },
        },
        GroupBy: [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
      })
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("S3 per-resource CE query timed out after 15s")), 15000)
    );

    const resourceResp = await Promise.race([resourcePromise, timeoutPromise]);

    for (const result of resourceResp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const resourceId = group.Keys?.[0] || "";
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
        if (!resourceId || cost <= 0) continue;

        // Resource ID is the bucket name (or ARN — extract bucket name)
        const bucketName = resourceId.includes(":")
          ? resourceId.split(":::").pop()! // arn:aws:s3:::bucket-name
          : resourceId;

        costByBucket.set(bucketName, (costByBucket.get(bucketName) || 0) + cost);
      }
    }

    hasResourceData = costByBucket.size > 0;
  } catch (err: any) {
    console.warn(`Cost Explorer S3 per-resource query failed (will use aggregate): ${err.message}`);
  }

  return {
    costByBucket,
    totalS3Cost,
    hasResourceData,
  };
}
