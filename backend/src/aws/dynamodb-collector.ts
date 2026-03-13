import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeTimeToLiveCommand,
  ListTagsOfResourceCommand,
  paginateListTables,
} from "@aws-sdk/client-dynamodb";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import { getMetric } from "./cloudwatch";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface DynamoDBTableMetrics {
  consumedReadSum: number | null;
  consumedWriteSum: number | null;
  provisionedReadAvg: number | null;
  provisionedWriteAvg: number | null;
  throttledRequestsSum: number | null;
  readThrottleEventsSum: number | null;
  writeThrottleEventsSum: number | null;
}

export interface DynamoDBGSIDetail {
  name: string;
  provisionedRCU: number;
  provisionedWCU: number;
  itemCount: number;
  sizeBytes: number;
}

export interface DynamoDBTableData {
  tableName: string;
  tableArn: string;
  billingMode: "PAY_PER_REQUEST" | "PROVISIONED";
  provisionedRCU: number;
  provisionedWCU: number;
  tableSizeBytes: number;
  itemCount: number;
  gsiCount: number;
  gsiDetails: DynamoDBGSIDetail[];
  pitrEnabled: boolean;
  ttlEnabled: boolean;
  tableClass: string;
  creationDate: string;
  metrics: DynamoDBTableMetrics;
  currentMonthlyCost: number;
  costIsActual: boolean;
  tags: Record<string, string>;
}

export interface DynamoDBAccountData {
  accountName: string;
  accountId: string;
  region: string;
  tables: DynamoDBTableData[];
  accountSummary: {
    totalTables: number;
    totalMonthlyCost: number;
  };
  collectedAt: string;
}

// ─── Cost Explorer ───────────────────────────────────────────────────────────

interface DynamoDBCostData {
  costByTable: Map<string, number>;
  totalDynamoDBCost: number;
  hasResourceData: boolean;
}

async function getDynamoDBCosts(
  client: CostExplorerClient,
  days: number = 30
): Promise<DynamoDBCostData | null> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0];
  const timePeriod = { Start: formatDate(startDate), End: formatDate(endDate) };

  let totalDynamoDBCost = 0;

  try {
    const aggResp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["Amazon DynamoDB"],
          },
        },
      })
    );

    for (const result of aggResp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        totalDynamoDBCost += parseFloat(
          group.Metrics?.UnblendedCost?.Amount || "0"
        );
      }
      if (!result.Groups?.length) {
        totalDynamoDBCost += parseFloat(
          result.Total?.UnblendedCost?.Amount || "0"
        );
      }
    }

    if (totalDynamoDBCost <= 0) return null;
  } catch (err: any) {
    console.warn(`Cost Explorer DynamoDB aggregate query failed: ${err.message}`);
    return null;
  }

  // Note: Unlike EC2/S3/NAT, DynamoDB does NOT support RESOURCE_ID grouping in
  // Cost Explorer. The dimension is invalid and always fails. We use proportional
  // cost distribution in the collector instead (total cost ÷ number of tables,
  // weighted by provisioned capacity).
  return { costByTable: new Map(), totalDynamoDBCost, hasResourceData: false };
}

// ─── Metric collection ───────────────────────────────────────────────────────

async function getDynamoDBMetrics(
  client: CloudWatchClient,
  tableName: string,
  days: number = 14
): Promise<DynamoDBTableMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600;

  const [consumedReadDp, consumedWriteDp, provReadDp, provWriteDp, throttledDp, readThrottleDp, writeThrottleDp] =
    await Promise.all([
      getMetric(client, "TableName", tableName, "ConsumedReadCapacityUnits", ["Sum"], startTime, endTime, period, "AWS/DynamoDB"),
      getMetric(client, "TableName", tableName, "ConsumedWriteCapacityUnits", ["Sum"], startTime, endTime, period, "AWS/DynamoDB"),
      getMetric(client, "TableName", tableName, "ProvisionedReadCapacityUnits", ["Average"], startTime, endTime, period, "AWS/DynamoDB"),
      getMetric(client, "TableName", tableName, "ProvisionedWriteCapacityUnits", ["Average"], startTime, endTime, period, "AWS/DynamoDB"),
      getMetric(client, "TableName", tableName, "ThrottledRequests", ["Sum"], startTime, endTime, period, "AWS/DynamoDB"),
      getMetric(client, "TableName", tableName, "ReadThrottleEvents", ["Sum"], startTime, endTime, period, "AWS/DynamoDB"),
      getMetric(client, "TableName", tableName, "WriteThrottleEvents", ["Sum"], startTime, endTime, period, "AWS/DynamoDB"),
    ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const sum = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) : null;

  return {
    consumedReadSum: sum(consumedReadDp.filter((d) => d.Sum != null).map((d) => d.Sum!)),
    consumedWriteSum: sum(consumedWriteDp.filter((d) => d.Sum != null).map((d) => d.Sum!)),
    provisionedReadAvg: avg(provReadDp.filter((d) => d.Average != null).map((d) => d.Average!)),
    provisionedWriteAvg: avg(provWriteDp.filter((d) => d.Average != null).map((d) => d.Average!)),
    throttledRequestsSum: sum(throttledDp.filter((d) => d.Sum != null).map((d) => d.Sum!)),
    readThrottleEventsSum: sum(readThrottleDp.filter((d) => d.Sum != null).map((d) => d.Sum!)),
    writeThrottleEventsSum: sum(writeThrottleDp.filter((d) => d.Sum != null).map((d) => d.Sum!)),
  };
}

// ─── Main collector ──────────────────────────────────────────────────────────

// DynamoDB pricing (us-east-1)
const DYNAMO_RCU_COST_PER_HOUR = 0.00013;                    // per RCU-hour (provisioned)
const DYNAMO_WCU_COST_PER_HOUR = 0.00000065;                 // per WCU-hour (provisioned)
const DYNAMO_ON_DEMAND_READ_COST = 1.25 / 1_000_000;         // $1.25 per million read request units
const DYNAMO_ON_DEMAND_WRITE_COST = 1.25 / 1_000_000;        // $1.25 per million write request units
export const DYNAMO_STORAGE_COST_PER_GB = 0.25;               // per GB/month (standard)
export const DYNAMO_IA_STORAGE_COST_PER_GB = 0.10;            // per GB/month (infrequent access)
export const DYNAMO_PITR_COST_PER_GB = 0.20;                  // per GB/month (backup)
export const DYNAMO_RCU_HOURLY = DYNAMO_RCU_COST_PER_HOUR;
export const DYNAMO_WCU_HOURLY = DYNAMO_WCU_COST_PER_HOUR;
export const DYNAMO_ON_DEMAND_READ = DYNAMO_ON_DEMAND_READ_COST;
export const DYNAMO_ON_DEMAND_WRITE = DYNAMO_ON_DEMAND_WRITE_COST;

export async function collectDynamoDBData(
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string,
  accountName: string,
  accountId: string,
  onProgress?: (msg: string) => void
): Promise<DynamoDBAccountData> {
  const log = onProgress || (() => {});

  const ddbClient = new DynamoDBClient({ region, credentials });
  const cwClient = new CloudWatchClient({ region, credentials });
  const ceClient = new CostExplorerClient({ region, credentials });

  // 1. List all tables
  log("Discovering DynamoDB tables...");
  const tableNames: string[] = [];
  for await (const page of paginateListTables({ client: ddbClient }, {})) {
    tableNames.push(...(page.TableNames || []));
  }
  log(`Found ${tableNames.length} DynamoDB tables`);

  // 2. Fetch Cost Explorer data
  log("Fetching DynamoDB costs from Cost Explorer...");
  let costData: DynamoDBCostData | null = null;
  try {
    costData = await Promise.race([
      getDynamoDBCosts(ceClient),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("DynamoDB CE overall timeout")), 30000)
      ),
    ]);
    if (costData) {
      log(`Cost Explorer: $${costData.totalDynamoDBCost.toFixed(2)}/mo total, ${costData.costByTable.size} tables with per-resource data`);
    }
  } catch (err: any) {
    console.warn(`DynamoDB Cost Explorer fetch failed: ${err.message}`);
    log("Cost Explorer unavailable — using estimated costs");
  }

  // 3. Collect details and metrics for each table (batched)
  const tables: DynamoDBTableData[] = [];
  const batchSize = 5;

  for (let i = 0; i < tableNames.length; i += batchSize) {
    const batch = tableNames.slice(i, i + batchSize);
    log(`Collecting details for tables ${i + 1}-${Math.min(i + batchSize, tableNames.length)} of ${tableNames.length}...`);

    const batchResults = await Promise.all(
      batch.map(async (tableName) => {
        // Describe table
        let tableDesc: any = {};
        try {
          const resp = await ddbClient.send(
            new DescribeTableCommand({ TableName: tableName })
          );
          tableDesc = resp.Table || {};
        } catch (err: any) {
          console.warn(`Failed to describe table ${tableName}: ${err.message}`);
          return null;
        }

        // Get metrics
        let metrics: DynamoDBTableMetrics = {
          consumedReadSum: null,
          consumedWriteSum: null,
          provisionedReadAvg: null,
          provisionedWriteAvg: null,
          throttledRequestsSum: null,
          readThrottleEventsSum: null,
          writeThrottleEventsSum: null,
        };

        try {
          metrics = await getDynamoDBMetrics(cwClient, tableName);
        } catch (err: any) {
          console.warn(`Failed to get metrics for ${tableName}: ${err.message}`);
        }

        // Check PITR
        let pitrEnabled = false;
        try {
          const backupResp = await ddbClient.send(
            new DescribeContinuousBackupsCommand({ TableName: tableName })
          );
          pitrEnabled =
            backupResp.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus === "ENABLED";
        } catch (err: any) {
          // May fail if permission not granted
        }

        // Check TTL
        let ttlEnabled = false;
        try {
          const ttlResp = await ddbClient.send(
            new DescribeTimeToLiveCommand({ TableName: tableName })
          );
          ttlEnabled = ttlResp.TimeToLiveDescription?.TimeToLiveStatus === "ENABLED";
        } catch (err: any) {
          // May fail if permission not granted
        }

        // Get tags
        const tags: Record<string, string> = {};
        try {
          if (tableDesc.TableArn) {
            const tagResp = await ddbClient.send(
              new ListTagsOfResourceCommand({ ResourceArn: tableDesc.TableArn })
            );
            for (const tag of tagResp.Tags || []) {
              if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
            }
          }
        } catch (err: any) {
          // Tags may not be accessible
        }

        // Extract GSI details
        const gsiDetails: DynamoDBGSIDetail[] = (tableDesc.GlobalSecondaryIndexes || []).map((gsi: any) => ({
          name: gsi.IndexName || "",
          provisionedRCU: gsi.ProvisionedThroughput?.ReadCapacityUnits || 0,
          provisionedWCU: gsi.ProvisionedThroughput?.WriteCapacityUnits || 0,
          itemCount: gsi.ItemCount || 0,
          sizeBytes: gsi.IndexSizeBytes || 0,
        }));

        const billingMode: "PAY_PER_REQUEST" | "PROVISIONED" =
          tableDesc.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST"
            ? "PAY_PER_REQUEST"
            : "PROVISIONED";

        const provisionedRCU = tableDesc.ProvisionedThroughput?.ReadCapacityUnits || 0;
        const provisionedWCU = tableDesc.ProvisionedThroughput?.WriteCapacityUnits || 0;
        const tableSizeBytes = tableDesc.TableSizeBytes || 0;
        const tableSizeGb = tableSizeBytes / (1024 * 1024 * 1024);
        const tableClass = tableDesc.TableClassSummary?.TableClass || "STANDARD";

        // Estimate cost
        let estimatedCost = 0;
        const storageCostRate = tableClass === "STANDARD_INFREQUENT_ACCESS"
          ? DYNAMO_IA_STORAGE_COST_PER_GB
          : DYNAMO_STORAGE_COST_PER_GB;
        const storageCost = tableSizeGb * storageCostRate;
        const pitrCost = pitrEnabled ? tableSizeGb * DYNAMO_PITR_COST_PER_GB : 0;

        if (billingMode === "PROVISIONED") {
          // Include GSI provisioned throughput in cost
          let totalRCU = provisionedRCU;
          let totalWCU = provisionedWCU;
          for (const gsi of gsiDetails) {
            totalRCU += gsi.provisionedRCU;
            totalWCU += gsi.provisionedWCU;
          }
          const throughputCost = (totalRCU * DYNAMO_RCU_COST_PER_HOUR + totalWCU * DYNAMO_WCU_COST_PER_HOUR) * 730;
          estimatedCost = throughputCost + storageCost + pitrCost;
        } else {
          // On-demand: estimate from consumed capacity
          const consumedReads = metrics.consumedReadSum ?? 0;
          const consumedWrites = metrics.consumedWriteSum ?? 0;
          const monthlyReads = consumedReads * (30 / 14);
          const monthlyWrites = consumedWrites * (30 / 14);
          const onDemandCost = monthlyReads * DYNAMO_ON_DEMAND_READ_COST + monthlyWrites * DYNAMO_ON_DEMAND_WRITE_COST;
          estimatedCost = onDemandCost + storageCost + pitrCost;
        }

        return {
          tableName,
          tableArn: tableDesc.TableArn || "",
          billingMode,
          provisionedRCU,
          provisionedWCU,
          tableSizeBytes,
          itemCount: tableDesc.ItemCount || 0,
          gsiCount: gsiDetails.length,
          gsiDetails,
          pitrEnabled,
          ttlEnabled,
          tableClass,
          creationDate: tableDesc.CreationDateTime?.toISOString() || "",
          metrics,
          currentMonthlyCost: estimatedCost,
          costIsActual: false,
          tags,
        };
      })
    );

    for (const result of batchResults) {
      if (result) tables.push(result);
    }
  }

  // 4. Apply Cost Explorer actual costs
  if (costData) {
    const totalEstimated = tables.reduce((s, t) => s + t.currentMonthlyCost, 0);

    for (const table of tables) {
      const ceCost = costData.costByTable.get(table.tableName);
      if (ceCost != null && ceCost > 0) {
        table.currentMonthlyCost = ceCost;
        table.costIsActual = true;
      } else if (costData.totalDynamoDBCost > 0 && totalEstimated > 0 && table.currentMonthlyCost > 0) {
        const proportion = table.currentMonthlyCost / totalEstimated;
        table.currentMonthlyCost = costData.totalDynamoDBCost * proportion;
        table.costIsActual = true;
      }
    }
  }

  // 5. Build summary
  const totalMonthlyCost = tables.reduce((s, t) => s + t.currentMonthlyCost, 0);

  log(`DynamoDB collection complete: ${tables.length} tables, est. $${totalMonthlyCost.toFixed(2)}/mo`);

  return {
    accountName,
    accountId,
    region,
    tables,
    accountSummary: {
      totalTables: tables.length,
      totalMonthlyCost,
    },
    collectedAt: new Date().toISOString(),
  };
}
