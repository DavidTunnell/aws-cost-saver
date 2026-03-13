import {
  LambdaClient,
  ListFunctionsCommand,
  GetFunctionConfigurationCommand,
  ListVersionsByFunctionCommand,
  ListAliasesCommand,
  ListProvisionedConcurrencyConfigsCommand,
  paginateListFunctions,
  type FunctionConfiguration,
  type FunctionCodeLocation,
} from "@aws-sdk/client-lambda";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import { getMetric } from "./cloudwatch";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface LambdaFunctionMetrics {
  invocationsSum: number | null;
  durationAvg: number | null;
  durationMax: number | null;
  durationP99: number | null;
  errorsSum: number | null;
  throttlesSum: number | null;
  concurrentExecutionsAvg: number | null;
  concurrentExecutionsMax: number | null;
}

export interface LambdaVersionInfo {
  version: string;
  lastModified: string;
}

export interface LambdaFunctionData {
  functionName: string;
  functionArn: string;
  runtime: string;
  architecture: string;
  memorySize: number;
  timeout: number;
  codeSize: number;
  lastModified: string;
  handler: string;
  description: string;
  packageType: string;
  tags: Record<string, string>;
  metrics: LambdaFunctionMetrics;
  currentMonthlyCost: number;
  costIsActual: boolean;
  versionCount: number;
  provisionedConcurrency: number;
  provisionedConcurrencyUtilizationMax: number | null;
}

export interface LambdaAccountData {
  accountName: string;
  accountId: string;
  region: string;
  functions: LambdaFunctionData[];
  accountSummary: {
    totalFunctions: number;
    totalMonthlyCost: number;
  };
  collectedAt: string;
}

// ─── Cost Explorer ───────────────────────────────────────────────────────────

interface LambdaCostData {
  costByFunction: Map<string, number>;
  totalLambdaCost: number;
  hasResourceData: boolean;
}

async function getLambdaCosts(
  client: CostExplorerClient,
  days: number = 30
): Promise<LambdaCostData | null> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0];
  const timePeriod = { Start: formatDate(startDate), End: formatDate(endDate) };

  let totalLambdaCost = 0;

  try {
    const aggResp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["AWS Lambda"],
          },
        },
      })
    );

    for (const result of aggResp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        totalLambdaCost += parseFloat(
          group.Metrics?.UnblendedCost?.Amount || "0"
        );
      }
      // If no groups, check total
      if (!result.Groups?.length) {
        totalLambdaCost += parseFloat(
          result.Total?.UnblendedCost?.Amount || "0"
        );
      }
    }

    if (totalLambdaCost <= 0) return null;
  } catch (err: any) {
    console.warn(`Cost Explorer Lambda aggregate query failed: ${err.message}`);
    return null;
  }

  // Try per-resource grouping
  const costByFunction = new Map<string, number>();
  let hasResourceData = false;

  try {
    const resourceResp = await Promise.race([
      client.send(
        new GetCostAndUsageCommand({
          TimePeriod: timePeriod,
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"],
          Filter: {
            Dimensions: {
              Key: "SERVICE",
              Values: ["AWS Lambda"],
            },
          },
          GroupBy: [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
        })
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Lambda per-resource CE query timed out")), 15000)
      ),
    ]);

    for (const result of resourceResp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const resourceId = group.Keys?.[0] || "";
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
        if (!resourceId || cost <= 0) continue;

        // Extract function name from ARN
        const fnName = resourceId.includes(":")
          ? resourceId.split(":").pop() || resourceId
          : resourceId;

        costByFunction.set(fnName, (costByFunction.get(fnName) || 0) + cost);
      }
    }

    hasResourceData = costByFunction.size > 0;
  } catch (err: any) {
    console.warn(`Cost Explorer Lambda per-resource query failed: ${err.message}`);
  }

  return { costByFunction, totalLambdaCost, hasResourceData };
}

// ─── Metric collection ───────────────────────────────────────────────────────

async function getLambdaMetrics(
  client: CloudWatchClient,
  functionName: string,
  days: number = 14
): Promise<LambdaFunctionMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600;

  const [invocationsDp, durationDp, errorsDp, throttlesDp, concurrentDp] =
    await Promise.all([
      getMetric(client, "FunctionName", functionName, "Invocations", ["Sum"], startTime, endTime, period, "AWS/Lambda"),
      getMetric(client, "FunctionName", functionName, "Duration", ["Average", "Maximum"], startTime, endTime, period, "AWS/Lambda"),
      getMetric(client, "FunctionName", functionName, "Errors", ["Sum"], startTime, endTime, period, "AWS/Lambda"),
      getMetric(client, "FunctionName", functionName, "Throttles", ["Sum"], startTime, endTime, period, "AWS/Lambda"),
      getMetric(client, "FunctionName", functionName, "ConcurrentExecutions", ["Average", "Maximum"], startTime, endTime, period, "AWS/Lambda"),
    ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const sum = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) : null;
  const max = (arr: number[]) =>
    arr.length ? Math.max(...arr) : null;

  return {
    invocationsSum: sum(invocationsDp.filter((d) => d.Sum != null).map((d) => d.Sum!)),
    durationAvg: avg(durationDp.filter((d) => d.Average != null).map((d) => d.Average!)),
    durationMax: max(durationDp.filter((d) => d.Maximum != null).map((d) => d.Maximum!)),
    durationP99: null, // Would need percentile statistics which require extended metrics
    errorsSum: sum(errorsDp.filter((d) => d.Sum != null).map((d) => d.Sum!)),
    throttlesSum: sum(throttlesDp.filter((d) => d.Sum != null).map((d) => d.Sum!)),
    concurrentExecutionsAvg: avg(concurrentDp.filter((d) => d.Average != null).map((d) => d.Average!)),
    concurrentExecutionsMax: max(concurrentDp.filter((d) => d.Maximum != null).map((d) => d.Maximum!)),
  };
}

// ─── Main collector ──────────────────────────────────────────────────────────

// Lambda pricing (us-east-1)
const LAMBDA_REQUEST_COST = 0.20 / 1_000_000; // $0.20 per 1M requests
const LAMBDA_DURATION_COST_PER_GB_SEC = 0.0000166667; // per GB-second
export const LAMBDA_PROVISIONED_COST_PER_GB_HR = 0.0000041667 * 3600; // per GB-hour

export async function collectLambdaData(
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string,
  accountName: string,
  accountId: string,
  onProgress?: (msg: string) => void
): Promise<LambdaAccountData> {
  const log = onProgress || (() => {});

  const lambdaClient = new LambdaClient({ region, credentials });
  const cwClient = new CloudWatchClient({ region, credentials });
  const ceClient = new CostExplorerClient({ region, credentials });

  // 1. List all functions
  log("Discovering Lambda functions...");
  const rawFunctions: FunctionConfiguration[] = [];
  for await (const page of paginateListFunctions({ client: lambdaClient }, {})) {
    rawFunctions.push(...(page.Functions || []));
  }
  log(`Found ${rawFunctions.length} Lambda functions`);

  // 2. Fetch Cost Explorer data
  log("Fetching Lambda costs from Cost Explorer...");
  let costData: LambdaCostData | null = null;
  try {
    costData = await Promise.race([
      getLambdaCosts(ceClient),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Lambda CE overall timeout")), 30000)
      ),
    ]);
    if (costData) {
      log(`Cost Explorer: $${costData.totalLambdaCost.toFixed(2)}/mo total, ${costData.costByFunction.size} functions with per-resource data`);
    }
  } catch (err: any) {
    console.warn(`Lambda Cost Explorer fetch failed: ${err.message}`);
    log("Cost Explorer unavailable — using estimated costs");
  }

  // 3. Collect metrics and version info for each function (batched)
  const functions: LambdaFunctionData[] = [];
  const batchSize = 5;

  for (let i = 0; i < rawFunctions.length; i += batchSize) {
    const batch = rawFunctions.slice(i, i + batchSize);
    log(`Collecting metrics for functions ${i + 1}-${Math.min(i + batchSize, rawFunctions.length)} of ${rawFunctions.length}...`);

    const batchResults = await Promise.all(
      batch.map(async (fn) => {
        const functionName = fn.FunctionName!;

        // Get metrics
        let metrics: LambdaFunctionMetrics = {
          invocationsSum: null,
          durationAvg: null,
          durationMax: null,
          durationP99: null,
          errorsSum: null,
          throttlesSum: null,
          concurrentExecutionsAvg: null,
          concurrentExecutionsMax: null,
        };

        try {
          metrics = await getLambdaMetrics(cwClient, functionName);
        } catch (err: any) {
          console.warn(`Failed to get metrics for ${functionName}: ${err.message}`);
        }

        // Get version count
        let versionCount = 0;
        try {
          const versionsResp = await lambdaClient.send(
            new ListVersionsByFunctionCommand({ FunctionName: functionName })
          );
          // Subtract 1 for $LATEST
          versionCount = Math.max(0, (versionsResp.Versions?.length || 0) - 1);
        } catch (err: any) {
          console.warn(`Failed to get versions for ${functionName}: ${err.message}`);
        }

        // Get provisioned concurrency
        let provisionedConcurrency = 0;
        let provisionedUtilMax: number | null = null;
        try {
          const pcResp = await lambdaClient.send(
            new ListProvisionedConcurrencyConfigsCommand({ FunctionName: functionName })
          );
          for (const pc of pcResp.ProvisionedConcurrencyConfigs || []) {
            provisionedConcurrency += pc.AllocatedProvisionedConcurrentExecutions || 0;
          }
          // If there's provisioned concurrency, get its utilization metric
          if (provisionedConcurrency > 0) {
            const endTime = new Date();
            const startTime = new Date(endTime.getTime() - 14 * 24 * 60 * 60 * 1000);
            const pcUtilDp = await getMetric(
              cwClient, "FunctionName", functionName,
              "ProvisionedConcurrencyUtilization", ["Maximum"],
              startTime, endTime, 3600, "AWS/Lambda"
            );
            const maxVals = pcUtilDp.map((d) => d.Maximum!).filter((v) => v != null);
            provisionedUtilMax = maxVals.length ? Math.max(...maxVals) : null;
          }
        } catch (err: any) {
          // ListProvisionedConcurrencyConfigs may fail if function has no aliases
        }

        // Estimate cost from metrics
        const invocations = metrics.invocationsSum ?? 0;
        const avgDurationMs = metrics.durationAvg ?? 0;
        const memoryMb = fn.MemorySize || 128;

        // Scale 14-day metrics to monthly
        const monthlyInvocations = invocations * (30 / 14);
        const requestCost = monthlyInvocations * LAMBDA_REQUEST_COST;
        const gbSeconds = (monthlyInvocations * avgDurationMs / 1000) * (memoryMb / 1024);
        const durationCost = gbSeconds * LAMBDA_DURATION_COST_PER_GB_SEC;
        const provisionedCost = provisionedConcurrency * (memoryMb / 1024) * LAMBDA_PROVISIONED_COST_PER_GB_HR * 730;
        const estimatedCost = requestCost + durationCost + provisionedCost;

        // Parse tags
        const tags: Record<string, string> = {};
        if ((fn as any).Tags) {
          Object.assign(tags, (fn as any).Tags);
        }

        return {
          functionName,
          functionArn: fn.FunctionArn || "",
          runtime: fn.Runtime || "unknown",
          architecture: fn.Architectures?.[0] || "x86_64",
          memorySize: memoryMb,
          timeout: fn.Timeout || 3,
          codeSize: fn.CodeSize || 0,
          lastModified: fn.LastModified || "",
          handler: fn.Handler || "",
          description: fn.Description || "",
          packageType: fn.PackageType || "Zip",
          tags,
          metrics,
          currentMonthlyCost: estimatedCost,
          costIsActual: false,
          versionCount,
          provisionedConcurrency,
          provisionedConcurrencyUtilizationMax: provisionedUtilMax,
        };
      })
    );

    functions.push(...batchResults);
  }

  // 4. Apply Cost Explorer actual costs
  if (costData) {
    const totalEstimated = functions.reduce((s, f) => s + f.currentMonthlyCost, 0);

    for (const fn of functions) {
      const ceCost = costData.costByFunction.get(fn.functionName);
      if (ceCost != null && ceCost > 0) {
        fn.currentMonthlyCost = ceCost;
        fn.costIsActual = true;
      } else if (costData.totalLambdaCost > 0 && totalEstimated > 0 && fn.currentMonthlyCost > 0) {
        const proportion = fn.currentMonthlyCost / totalEstimated;
        fn.currentMonthlyCost = costData.totalLambdaCost * proportion;
        fn.costIsActual = true;
      }
    }
  }

  // 5. Build summary
  const totalMonthlyCost = functions.reduce((s, f) => s + f.currentMonthlyCost, 0);

  log(`Lambda collection complete: ${functions.length} functions, est. $${totalMonthlyCost.toFixed(2)}/mo`);

  return {
    accountName,
    accountId,
    region,
    functions,
    accountSummary: {
      totalFunctions: functions.length,
      totalMonthlyCost,
    },
    collectedAt: new Date().toISOString(),
  };
}
