import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  paginateListClusters,
  paginateListServices,
} from "@aws-sdk/client-ecs";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import { getMetricMultiDimension } from "./cloudwatch";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface ECSServiceMetrics {
  cpuUtilizationAvg: number | null;
  cpuUtilizationMax: number | null;
  memoryUtilizationAvg: number | null;
  memoryUtilizationMax: number | null;
}

export interface ECSServiceData {
  serviceName: string;
  serviceArn: string;
  clusterName: string;
  clusterArn: string;
  launchType: "FARGATE" | "EC2" | "EXTERNAL";
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  taskDefinitionArn: string;
  taskCpu: number; // CPU units (256, 512, 1024, 2048, 4096)
  taskMemory: number; // MB
  platformVersion: string;
  capacityProviderStrategy: Array<{
    capacityProvider: string;
    weight: number;
    base: number;
  }>;
  runtimePlatform: {
    cpuArchitecture: string;
    operatingSystemFamily: string;
  } | null;
  createdAt: string;
  tags: Record<string, string>;
  metrics: ECSServiceMetrics;
  currentMonthlyCost: number;
  costIsActual: boolean;
  containerCount: number;
}

export interface ECSAccountData {
  accountName: string;
  accountId: string;
  region: string;
  services: ECSServiceData[];
  accountSummary: {
    totalServices: number;
    totalMonthlyCost: number;
  };
  collectedAt: string;
}

// ─── Pricing Constants (us-east-1, Linux/x86) ───────────────────────────────

export const FARGATE_VCPU_HOURLY = 0.04052;
export const FARGATE_MEMORY_GB_HOURLY = 0.004446;
export const FARGATE_SPOT_DISCOUNT = 0.7;
export const FARGATE_GRAVITON_DISCOUNT = 0.2;

// ─── Cost Explorer ───────────────────────────────────────────────────────────

interface ECSCostData {
  totalECSCost: number;
}

async function getECSCosts(
  client: CostExplorerClient,
  days: number = 30
): Promise<ECSCostData | null> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0];
  const timePeriod = { Start: formatDate(startDate), End: formatDate(endDate) };

  let totalECSCost = 0;

  const parseCEResponse = (resp: any): number => {
    let cost = 0;
    for (const result of resp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        cost += parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
      }
      if (!result.Groups?.length) {
        cost += parseFloat(result.Total?.UnblendedCost?.Amount || "0");
      }
    }
    return cost;
  };

  try {
    // Try Fargate-specific filter first to exclude EC2 ECS management fees
    const fargateResp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: {
          And: [
            {
              Dimensions: {
                Key: "SERVICE",
                Values: ["Amazon Elastic Container Service"],
              },
            },
            {
              Dimensions: {
                Key: "USAGE_TYPE_GROUP",
                Values: ["AWS Fargate"],
              },
            },
          ],
        },
      })
    );
    totalECSCost = parseCEResponse(fargateResp);
  } catch {
    // USAGE_TYPE_GROUP not supported — fall back to broad ECS filter
    try {
      const aggResp = await client.send(
        new GetCostAndUsageCommand({
          TimePeriod: timePeriod,
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"],
          Filter: {
            Dimensions: {
              Key: "SERVICE",
              Values: ["Amazon Elastic Container Service"],
            },
          },
        })
      );
      totalECSCost = parseCEResponse(aggResp);
    } catch (err: any) {
      console.warn(`Cost Explorer ECS aggregate query failed: ${err.message}`);
      return null;
    }
  }

  if (totalECSCost <= 0) return null;
  return { totalECSCost };
}

// ─── Metric collection ───────────────────────────────────────────────────────

async function getECSServiceMetrics(
  client: CloudWatchClient,
  clusterName: string,
  serviceName: string,
  days: number = 14
): Promise<ECSServiceMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600;

  const dimensions = [
    { Name: "ClusterName", Value: clusterName },
    { Name: "ServiceName", Value: serviceName },
  ];

  const [cpuDp, memDp] = await Promise.all([
    getMetricMultiDimension(
      client,
      dimensions,
      "CPUUtilization",
      ["Average", "Maximum"],
      startTime,
      endTime,
      period,
      "AWS/ECS"
    ),
    getMetricMultiDimension(
      client,
      dimensions,
      "MemoryUtilization",
      ["Average", "Maximum"],
      startTime,
      endTime,
      period,
      "AWS/ECS"
    ),
  ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const max = (arr: number[]) => (arr.length ? Math.max(...arr) : null);

  return {
    cpuUtilizationAvg: avg(
      cpuDp.filter((d) => d.Average != null).map((d) => d.Average!)
    ),
    cpuUtilizationMax: max(
      cpuDp.filter((d) => d.Maximum != null).map((d) => d.Maximum!)
    ),
    memoryUtilizationAvg: avg(
      memDp.filter((d) => d.Average != null).map((d) => d.Average!)
    ),
    memoryUtilizationMax: max(
      memDp.filter((d) => d.Maximum != null).map((d) => d.Maximum!)
    ),
  };
}

// ─── Main collector ──────────────────────────────────────────────────────────

export async function collectECSData(
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string,
  accountName: string,
  accountId: string,
  onProgress?: (msg: string) => void
): Promise<ECSAccountData> {
  const log = onProgress || (() => {});

  const ecsClient = new ECSClient({ region, credentials });
  const cwClient = new CloudWatchClient({ region, credentials });
  const ceClient = new CostExplorerClient({ region, credentials });

  // 1. List all clusters
  log("Discovering ECS clusters...");
  const clusterArns: string[] = [];
  for await (const page of paginateListClusters({ client: ecsClient }, {})) {
    clusterArns.push(...(page.clusterArns || []));
  }
  log(`Found ${clusterArns.length} ECS clusters`);

  // 2. Fetch Cost Explorer data (always, even with 0 clusters — CE may have lingering charges)
  log("Fetching ECS costs from Cost Explorer...");
  let costData: ECSCostData | null = null;
  try {
    costData = await Promise.race([
      getECSCosts(ceClient),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("ECS CE overall timeout")),
          30000
        )
      ),
    ]);
    if (costData) {
      log(
        `Cost Explorer: $${costData.totalECSCost.toFixed(2)}/mo total ECS spend`
      );
    }
  } catch (err: any) {
    console.warn(`ECS Cost Explorer fetch failed: ${err.message}`);
    log("Cost Explorer unavailable — using estimated costs");
  }

  // 3. List all services across clusters
  const servicesByCluster: Map<string, string[]> = new Map();
  let totalServiceCount = 0;

  if (clusterArns.length > 0) {
    log("Discovering ECS services...");
    for (const clusterArn of clusterArns) {
      const serviceArns: string[] = [];
      for await (const page of paginateListServices(
        { client: ecsClient },
        { cluster: clusterArn }
      )) {
        serviceArns.push(...(page.serviceArns || []));
      }
      if (serviceArns.length > 0) {
        servicesByCluster.set(clusterArn, serviceArns);
        totalServiceCount += serviceArns.length;
      }
    }
    log(`Found ${totalServiceCount} ECS services across ${servicesByCluster.size} clusters`);
  }

  // 4. Describe services and collect metrics (batched)
  const services: ECSServiceData[] = [];
  // Cache task definitions to avoid re-fetching shared ones
  const taskDefCache = new Map<
    string,
    {
      cpu: number;
      memory: number;
      runtimePlatform: { cpuArchitecture: string; operatingSystemFamily: string } | null;
      containerCount: number;
    }
  >();

  for (const [clusterArn, serviceArns] of servicesByCluster) {
    const clusterName = clusterArn.split("/").pop() || clusterArn;

    // DescribeServices accepts max 10 at a time
    for (let i = 0; i < serviceArns.length; i += 10) {
      const batch = serviceArns.slice(i, i + 10);
      log(
        `Describing services ${i + 1}-${Math.min(i + 10, serviceArns.length)} in cluster ${clusterName}...`
      );

      let describedServices: any[] = [];
      try {
        const resp = await ecsClient.send(
          new DescribeServicesCommand({
            cluster: clusterArn,
            services: batch,
          })
        );
        // Filter to ACTIVE services only — DRAINING/INACTIVE are dead
        describedServices = (resp.services || []).filter(
          (s: any) => s.status === "ACTIVE"
        );
      } catch (err: any) {
        console.warn(
          `Failed to describe services in ${clusterName}: ${err.message}`
        );
        continue;
      }

      // Collect metrics in groups of 5
      const metricBatchSize = 5;
      for (let j = 0; j < describedServices.length; j += metricBatchSize) {
        const metricBatch = describedServices.slice(j, j + metricBatchSize);
        log(`Collecting metrics for services ${j + 1}-${Math.min(j + metricBatchSize, describedServices.length)} in ${clusterName}...`);

        const batchResults = await Promise.all(
          metricBatch.map(async (svc: any) => {
            const serviceName = svc.serviceName || "";
            const taskDefArn = svc.taskDefinition || "";

            // Get or cache task definition details
            let taskDefInfo = taskDefCache.get(taskDefArn);
            if (!taskDefInfo && taskDefArn) {
              try {
                const tdResp = await ecsClient.send(
                  new DescribeTaskDefinitionCommand({
                    taskDefinition: taskDefArn,
                  })
                );
                const td = tdResp.taskDefinition;
                taskDefInfo = {
                  cpu: parseInt(td?.cpu || "256", 10),
                  memory: parseInt(td?.memory || "512", 10),
                  runtimePlatform: td?.runtimePlatform
                    ? {
                        cpuArchitecture:
                          td.runtimePlatform.cpuArchitecture || "X86_64",
                        operatingSystemFamily:
                          td.runtimePlatform.operatingSystemFamily || "LINUX",
                      }
                    : null,
                  containerCount: td?.containerDefinitions?.length || 1,
                };
                taskDefCache.set(taskDefArn, taskDefInfo);
              } catch (err: any) {
                console.warn(
                  `Failed to describe task definition ${taskDefArn}: ${err.message}`
                );
                taskDefInfo = {
                  cpu: 256,
                  memory: 512,
                  runtimePlatform: null,
                  containerCount: 1,
                };
              }
            }
            if (!taskDefInfo) {
              taskDefInfo = {
                cpu: 256,
                memory: 512,
                runtimePlatform: null,
                containerCount: 1,
              };
            }

            // Get metrics
            let metrics: ECSServiceMetrics = {
              cpuUtilizationAvg: null,
              cpuUtilizationMax: null,
              memoryUtilizationAvg: null,
              memoryUtilizationMax: null,
            };
            try {
              metrics = await getECSServiceMetrics(
                cwClient,
                clusterName,
                serviceName
              );
            } catch (err: any) {
              console.warn(
                `Failed to get metrics for ${serviceName}: ${err.message}`
              );
            }

            // Determine launch type
            let launchType: "FARGATE" | "EC2" | "EXTERNAL" = "EC2";
            if (svc.launchType === "FARGATE") {
              launchType = "FARGATE";
            } else if (svc.launchType === "EXTERNAL") {
              launchType = "EXTERNAL";
            } else if (svc.capacityProviderStrategy?.length) {
              // Check if capacity provider strategy uses Fargate
              const hasFargate = svc.capacityProviderStrategy.some(
                (cp: any) =>
                  cp.capacityProvider === "FARGATE" ||
                  cp.capacityProvider === "FARGATE_SPOT"
              );
              if (hasFargate) launchType = "FARGATE";
            }

            // Estimate Fargate cost
            let estimatedCost = 0;
            if (launchType === "FARGATE") {
              const vcpuCost =
                (taskDefInfo.cpu / 1024) * FARGATE_VCPU_HOURLY;
              const memCost =
                (taskDefInfo.memory / 1024) * FARGATE_MEMORY_GB_HOURLY;
              estimatedCost =
                (vcpuCost + memCost) * 730 * (svc.desiredCount || 0);

              // If using Spot, apply discount
              const hasSpot = (svc.capacityProviderStrategy || []).some(
                (cp: any) => cp.capacityProvider === "FARGATE_SPOT"
              );
              if (hasSpot) {
                // Approximate: use weighted average if mixed
                const spotWeight =
                  svc.capacityProviderStrategy
                    ?.filter(
                      (cp: any) => cp.capacityProvider === "FARGATE_SPOT"
                    )
                    .reduce((s: number, cp: any) => s + (cp.weight || 0), 0) ||
                  0;
                const totalWeight =
                  svc.capacityProviderStrategy?.reduce(
                    (s: number, cp: any) => s + (cp.weight || 0),
                    0
                  ) || 1;
                const spotFraction = totalWeight > 0 ? spotWeight / totalWeight : 0;
                const discount =
                  spotFraction * FARGATE_SPOT_DISCOUNT;
                estimatedCost *= 1 - discount;
              }

              // If using Graviton, apply discount
              if (
                taskDefInfo.runtimePlatform?.cpuArchitecture === "ARM64"
              ) {
                estimatedCost *= 1 - FARGATE_GRAVITON_DISCOUNT;
              }
            }
            // EC2 launch type: compute cost is covered by the EC2 module, so $0 here

            // Parse capacity provider strategy
            const capacityProviderStrategy = (
              svc.capacityProviderStrategy || []
            ).map((cp: any) => ({
              capacityProvider: cp.capacityProvider || "",
              weight: cp.weight || 0,
              base: cp.base || 0,
            }));

            // Parse tags
            const tags: Record<string, string> = {};
            for (const tag of svc.tags || []) {
              if (tag.key && tag.value) tags[tag.key] = tag.value;
            }

            return {
              serviceName,
              serviceArn: svc.serviceArn || "",
              clusterName,
              clusterArn,
              launchType,
              desiredCount: svc.desiredCount || 0,
              runningCount: svc.runningCount || 0,
              pendingCount: svc.pendingCount || 0,
              taskDefinitionArn: taskDefArn,
              taskCpu: taskDefInfo.cpu,
              taskMemory: taskDefInfo.memory,
              platformVersion: svc.platformVersion || "LATEST",
              capacityProviderStrategy,
              runtimePlatform: taskDefInfo.runtimePlatform,
              createdAt: svc.createdAt?.toISOString?.() || "",
              tags,
              metrics,
              currentMonthlyCost: estimatedCost,
              costIsActual: false,
              containerCount: taskDefInfo.containerCount,
            } as ECSServiceData;
          })
        );

        services.push(...batchResults);
      }
    }
  }

  // 5. Apply Cost Explorer actual costs (proportional distribution for Fargate services)
  if (costData && costData.totalECSCost > 0) {
    const fargateServices = services.filter((s) => s.launchType === "FARGATE");
    const totalEstimated = fargateServices.reduce(
      (s, svc) => s + svc.currentMonthlyCost,
      0
    );

    if (totalEstimated > 0) {
      for (const svc of fargateServices) {
        if (svc.currentMonthlyCost > 0) {
          const proportion = svc.currentMonthlyCost / totalEstimated;
          svc.currentMonthlyCost = costData.totalECSCost * proportion;
          svc.costIsActual = true;
        }
      }
    }
  }

  // 6. Build summary — use CE total if higher (covers lingering charges not tied to active services)
  const serviceCostTotal = services.reduce(
    (s, svc) => s + svc.currentMonthlyCost,
    0
  );
  const totalMonthlyCost = Math.max(
    serviceCostTotal,
    costData?.totalECSCost || 0
  );

  log(
    `ECS collection complete: ${services.length} services, est. $${totalMonthlyCost.toFixed(2)}/mo`
  );

  return {
    accountName,
    accountId,
    region,
    services,
    accountSummary: {
      totalServices: services.length,
      totalMonthlyCost,
    },
    collectedAt: new Date().toISOString(),
  };
}
