import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { ElasticLoadBalancingClient } from "@aws-sdk/client-elastic-load-balancing";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import { getMetric } from "./cloudwatch";
import {
  listLoadBalancersV2,
  listTargetGroups,
  describeTargetHealth,
  getLoadBalancerTagsV2,
  listClassicLoadBalancers,
  describeClassicInstanceHealth,
  getClassicLoadBalancerTags,
  type TargetGroupInfo,
} from "./elb";

// ─── Pricing constants (us-east-1) ──────────────────────────────────────────

// Fixed hourly rates
const ALB_HOURLY = 0.0225; // $16.43/mo
const NLB_HOURLY = 0.0225; // $16.43/mo
const GWLB_HOURLY = 0.0125; // $9.13/mo
const CLB_HOURLY = 0.025; // $18.25/mo

// Per-unit rates (for cost estimation)
const ALB_LCU_HOURLY = 0.008;
const NLB_NLCU_HOURLY = 0.006;
const CLB_DATA_PER_GB = 0.008;

// ─── Enriched data interfaces ───────────────────────────────────────────────

export interface ELBMetrics {
  // ALB / CLB
  requestCountSum: number | null;
  // ALB
  activeConnectionsAvg: number | null;
  activeConnectionsMax: number | null;
  processedBytesSum: number | null;
  consumedLCUsAvg: number | null;
  // NLB
  activeFlowCountAvg: number | null;
  activeFlowCountMax: number | null;
  newFlowCountSum: number | null;
  // CLB
  backendErrorsSum: number | null;
  // Common
  healthyHostCountAvg: number | null;
  unhealthyHostCountAvg: number | null;
}

export interface ELBLoadBalancerData {
  id: string; // ARN for v2, name for CLB
  name: string;
  type: "alb" | "nlb" | "gwlb" | "clb";
  scheme: string;
  vpcId: string;
  availabilityZones: string[];
  createdTime: string;
  tags: Record<string, string>;

  // Target info
  targetGroupCount: number; // count of associated TGs (v2 only)
  healthyTargets: number;
  unhealthyTargets: number;
  totalTargets: number;

  // Metrics
  metrics: ELBMetrics;

  // Cost
  currentMonthlyCost: number;
  costIsActual: boolean;
}

export interface ELBAccountData {
  accountName: string;
  accountId: string;
  region: string;
  loadBalancers: ELBLoadBalancerData[];
  orphanedTargetGroups: TargetGroupInfo[];
  accountSummary: {
    totalLoadBalancers: number;
    totalALBs: number;
    totalNLBs: number;
    totalCLBs: number;
    totalGWLBs: number;
    totalMonthlyCost: number;
  };
  collectedAt: string;
}

// ─── Cost Explorer helpers ──────────────────────────────────────────────────

interface ELBCostData {
  costByResource: Map<string, number>;
  totalELBCost: number;
  hasResourceData: boolean;
}

async function getELBCosts(
  client: CostExplorerClient,
  days: number = 30
): Promise<ELBCostData | null> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0];
  const timePeriod = {
    Start: formatDate(startDate),
    End: formatDate(endDate),
  };

  // 1. Aggregate ELB cost
  let totalELBCost = 0;

  try {
    const aggResp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["Elastic Load Balancing"],
          },
        },
      })
    );

    for (const result of aggResp.ResultsByTime || []) {
      for (const group of result.Total
        ? [{ Metrics: result.Total }]
        : result.Groups || []) {
        totalELBCost += parseFloat(
          group.Metrics?.UnblendedCost?.Amount || "0"
        );
      }
    }

    if (totalELBCost <= 0) {
      return null;
    }
  } catch (err: any) {
    console.warn(
      `Cost Explorer ELB aggregate query failed: ${err.message}`
    );
    return null;
  }

  // 2. Per-resource grouping
  const costByResource = new Map<string, number>();
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
            Values: ["Elastic Load Balancing"],
          },
        },
        GroupBy: [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
      })
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error("ELB per-resource CE query timed out after 15s")
          ),
        15000
      )
    );

    const resourceResp = await Promise.race([
      resourcePromise,
      timeoutPromise,
    ]);

    for (const result of resourceResp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const resourceId = group.Keys?.[0] || "";
        const cost = parseFloat(
          group.Metrics?.UnblendedCost?.Amount || "0"
        );
        if (!resourceId || cost <= 0) continue;

        costByResource.set(
          resourceId,
          (costByResource.get(resourceId) || 0) + cost
        );
      }
    }

    hasResourceData = costByResource.size > 0;
  } catch (err: any) {
    console.warn(
      `Cost Explorer ELB per-resource query failed (will use aggregate): ${err.message}`
    );
  }

  return { costByResource, totalELBCost, hasResourceData };
}

// ─── CloudWatch metric collection ────────────────────────────────────────────

/**
 * Extract the dimension value for CloudWatch from an ALB/NLB ARN.
 * CloudWatch uses the ARN suffix after "loadbalancer/" as the dimension.
 * e.g., "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-lb/abc123"
 *   → "app/my-lb/abc123"
 */
function getCloudWatchDimensionFromArn(arn: string): string {
  const idx = arn.indexOf("loadbalancer/");
  if (idx === -1) return arn;
  return arn.slice(idx + "loadbalancer/".length);
}

async function getALBMetrics(
  client: CloudWatchClient,
  arn: string,
  days: number = 14
): Promise<ELBMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600;
  const dimensionValue = getCloudWatchDimensionFromArn(arn);

  const [
    requestCountDp,
    activeConnDp,
    processedBytesDp,
    consumedLCUsDp,
    healthyDp,
    unhealthyDp,
  ] = await Promise.all([
    getMetric(client, "LoadBalancer", dimensionValue, "RequestCount", ["Sum"], startTime, endTime, period, "AWS/ApplicationELB"),
    getMetric(client, "LoadBalancer", dimensionValue, "ActiveConnectionCount", ["Average", "Maximum"], startTime, endTime, period, "AWS/ApplicationELB"),
    getMetric(client, "LoadBalancer", dimensionValue, "ProcessedBytes", ["Sum"], startTime, endTime, period, "AWS/ApplicationELB"),
    getMetric(client, "LoadBalancer", dimensionValue, "ConsumedLCUs", ["Average"], startTime, endTime, period, "AWS/ApplicationELB"),
    getMetric(client, "LoadBalancer", dimensionValue, "HealthyHostCount", ["Average"], startTime, endTime, period, "AWS/ApplicationELB"),
    getMetric(client, "LoadBalancer", dimensionValue, "UnHealthyHostCount", ["Average"], startTime, endTime, period, "AWS/ApplicationELB"),
  ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const sum = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) : null;
  const max = (arr: number[]) =>
    arr.length ? Math.max(...arr) : null;

  return {
    requestCountSum: sum(requestCountDp.map((d) => d.Sum!).filter((v) => v != null)),
    activeConnectionsAvg: avg(activeConnDp.map((d) => d.Average!).filter((v) => v != null)),
    activeConnectionsMax: max(activeConnDp.map((d) => d.Maximum!).filter((v) => v != null)),
    processedBytesSum: sum(processedBytesDp.map((d) => d.Sum!).filter((v) => v != null)),
    consumedLCUsAvg: avg(consumedLCUsDp.map((d) => d.Average!).filter((v) => v != null)),
    activeFlowCountAvg: null,
    activeFlowCountMax: null,
    newFlowCountSum: null,
    backendErrorsSum: null,
    healthyHostCountAvg: avg(healthyDp.map((d) => d.Average!).filter((v) => v != null)),
    unhealthyHostCountAvg: avg(unhealthyDp.map((d) => d.Average!).filter((v) => v != null)),
  };
}

async function getNLBMetrics(
  client: CloudWatchClient,
  arn: string,
  days: number = 14
): Promise<ELBMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600;
  const dimensionValue = getCloudWatchDimensionFromArn(arn);

  const [
    activeFlowDp,
    newFlowDp,
    processedBytesDp,
    consumedLCUsDp,
    healthyDp,
    unhealthyDp,
  ] = await Promise.all([
    getMetric(client, "LoadBalancer", dimensionValue, "ActiveFlowCount", ["Average", "Maximum"], startTime, endTime, period, "AWS/NetworkELB"),
    getMetric(client, "LoadBalancer", dimensionValue, "NewFlowCount", ["Sum"], startTime, endTime, period, "AWS/NetworkELB"),
    getMetric(client, "LoadBalancer", dimensionValue, "ProcessedBytes", ["Sum"], startTime, endTime, period, "AWS/NetworkELB"),
    getMetric(client, "LoadBalancer", dimensionValue, "ConsumedLCUs", ["Average"], startTime, endTime, period, "AWS/NetworkELB"),
    getMetric(client, "LoadBalancer", dimensionValue, "HealthyHostCount", ["Average"], startTime, endTime, period, "AWS/NetworkELB"),
    getMetric(client, "LoadBalancer", dimensionValue, "UnHealthyHostCount", ["Average"], startTime, endTime, period, "AWS/NetworkELB"),
  ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const sum = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) : null;
  const max = (arr: number[]) =>
    arr.length ? Math.max(...arr) : null;

  return {
    requestCountSum: null,
    activeConnectionsAvg: null,
    activeConnectionsMax: null,
    processedBytesSum: sum(processedBytesDp.map((d) => d.Sum!).filter((v) => v != null)),
    consumedLCUsAvg: avg(consumedLCUsDp.map((d) => d.Average!).filter((v) => v != null)),
    activeFlowCountAvg: avg(activeFlowDp.map((d) => d.Average!).filter((v) => v != null)),
    activeFlowCountMax: max(activeFlowDp.map((d) => d.Maximum!).filter((v) => v != null)),
    newFlowCountSum: sum(newFlowDp.map((d) => d.Sum!).filter((v) => v != null)),
    backendErrorsSum: null,
    healthyHostCountAvg: avg(healthyDp.map((d) => d.Average!).filter((v) => v != null)),
    unhealthyHostCountAvg: avg(unhealthyDp.map((d) => d.Average!).filter((v) => v != null)),
  };
}

async function getCLBMetrics(
  client: CloudWatchClient,
  lbName: string,
  days: number = 14
): Promise<ELBMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600;

  const [requestCountDp, healthyDp, unhealthyDp, errorsDp] =
    await Promise.all([
      getMetric(client, "LoadBalancerName", lbName, "RequestCount", ["Sum"], startTime, endTime, period, "AWS/ELB"),
      getMetric(client, "LoadBalancerName", lbName, "HealthyHostCount", ["Average"], startTime, endTime, period, "AWS/ELB"),
      getMetric(client, "LoadBalancerName", lbName, "UnHealthyHostCount", ["Average"], startTime, endTime, period, "AWS/ELB"),
      getMetric(client, "LoadBalancerName", lbName, "BackendConnectionErrors", ["Sum"], startTime, endTime, period, "AWS/ELB"),
    ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const sum = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) : null;

  return {
    requestCountSum: sum(requestCountDp.map((d) => d.Sum!).filter((v) => v != null)),
    activeConnectionsAvg: null,
    activeConnectionsMax: null,
    processedBytesSum: null,
    consumedLCUsAvg: null,
    activeFlowCountAvg: null,
    activeFlowCountMax: null,
    newFlowCountSum: null,
    backendErrorsSum: sum(errorsDp.map((d) => d.Sum!).filter((v) => v != null)),
    healthyHostCountAvg: avg(healthyDp.map((d) => d.Average!).filter((v) => v != null)),
    unhealthyHostCountAvg: avg(unhealthyDp.map((d) => d.Average!).filter((v) => v != null)),
  };
}

// ─── Cost estimation helpers ─────────────────────────────────────────────────

function estimateMonthlyCost(lb: ELBLoadBalancerData): number {
  const hourlyRate =
    lb.type === "alb"
      ? ALB_HOURLY
      : lb.type === "nlb"
        ? NLB_HOURLY
        : lb.type === "gwlb"
          ? GWLB_HOURLY
          : CLB_HOURLY;

  let monthlyCost = hourlyRate * 730; // fixed cost

  // Add usage-based cost estimate
  if (lb.type === "alb" && lb.metrics.consumedLCUsAvg != null) {
    monthlyCost += lb.metrics.consumedLCUsAvg * ALB_LCU_HOURLY * 730;
  } else if (lb.type === "nlb" && lb.metrics.consumedLCUsAvg != null) {
    monthlyCost += lb.metrics.consumedLCUsAvg * NLB_NLCU_HOURLY * 730;
  } else if (lb.type === "clb" && lb.metrics.processedBytesSum != null) {
    const gbProcessed = lb.metrics.processedBytesSum / (1024 * 1024 * 1024);
    monthlyCost += gbProcessed * CLB_DATA_PER_GB * 2; // extrapolate 14-day to ~monthly
  }

  return monthlyCost;
}

// ─── Main collector ─────────────────────────────────────────────────────────

export async function collectELBData(
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string,
  accountName: string,
  accountId: string,
  onProgress?: (msg: string) => void
): Promise<ELBAccountData> {
  const log = onProgress || (() => {});

  const elbv2Client = new ElasticLoadBalancingV2Client({
    region,
    credentials,
  });
  const elbClassicClient = new ElasticLoadBalancingClient({
    region,
    credentials,
  });
  const cwClient = new CloudWatchClient({ region, credentials });
  const ceClient = new CostExplorerClient({ region, credentials });

  // 1. Discover load balancers (v2 + classic in parallel)
  log("Discovering load balancers...");
  const [v2LoadBalancers, classicLoadBalancers] = await Promise.all([
    listLoadBalancersV2(elbv2Client),
    listClassicLoadBalancers(elbClassicClient),
  ]);

  log(
    `Found ${v2LoadBalancers.length} v2 load balancers (ALB/NLB/GWLB) and ${classicLoadBalancers.length} Classic LBs`
  );

  // 2. Discover target groups
  log("Discovering target groups...");
  const allTargetGroups = await listTargetGroups(elbv2Client);
  log(`Found ${allTargetGroups.length} target groups`);

  // 3. Fetch target health for each target group (batched, 5 at a time)
  log("Checking target health...");
  for (let i = 0; i < allTargetGroups.length; i += 5) {
    const batch = allTargetGroups.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((tg) => describeTargetHealth(elbv2Client, tg.arn))
    );
    for (let j = 0; j < batch.length; j++) {
      const targets = results[j];
      batch[j].totalTargets = targets.length;
      batch[j].healthyCount = targets.filter(
        (t) => t.TargetHealth?.State === "healthy"
      ).length;
      batch[j].unhealthyCount = targets.filter(
        (t) =>
          t.TargetHealth?.State === "unhealthy" ||
          t.TargetHealth?.State === "draining"
      ).length;
    }
  }

  // 4. Fetch Classic LB instance health (batched, 5 at a time)
  for (let i = 0; i < classicLoadBalancers.length; i += 5) {
    const batch = classicLoadBalancers.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((lb) =>
        describeClassicInstanceHealth(elbClassicClient, lb.name)
      )
    );
    for (let j = 0; j < batch.length; j++) {
      batch[j].healthyCount = results[j].healthy;
      batch[j].unhealthyCount = results[j].unhealthy;
      batch[j].instanceCount = results[j].total;
    }
  }

  // 5. Fetch tags
  log("Fetching tags...");
  const v2Arns = v2LoadBalancers.map((lb) => lb.arn);
  const clbNames = classicLoadBalancers.map((lb) => lb.name);

  const [v2TagsMap, clbTagsMap] = await Promise.all([
    v2Arns.length > 0
      ? getLoadBalancerTagsV2(elbv2Client, v2Arns)
      : Promise.resolve(new Map<string, Record<string, string>>()),
    clbNames.length > 0
      ? getClassicLoadBalancerTags(elbClassicClient, clbNames)
      : Promise.resolve(new Map<string, Record<string, string>>()),
  ]);

  for (const lb of v2LoadBalancers) {
    lb.tags = v2TagsMap.get(lb.arn) || {};
  }
  for (const lb of classicLoadBalancers) {
    lb.tags = clbTagsMap.get(lb.name) || {};
  }

  // 6. Build target group mapping (LB ARN → aggregated target counts)
  const tgByLB = new Map<
    string,
    { count: number; healthy: number; unhealthy: number; total: number }
  >();
  for (const tg of allTargetGroups) {
    for (const lbArn of tg.loadBalancerArns) {
      const existing = tgByLB.get(lbArn) || {
        count: 0,
        healthy: 0,
        unhealthy: 0,
        total: 0,
      };
      existing.count++;
      existing.healthy += tg.healthyCount;
      existing.unhealthy += tg.unhealthyCount;
      existing.total += tg.totalTargets;
      tgByLB.set(lbArn, existing);
    }
  }

  // 7. Fetch Cost Explorer data
  log("Fetching ELB costs from Cost Explorer...");
  let costData: ELBCostData | null = null;
  try {
    const ceTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("ELB Cost Explorer overall timeout after 30s")),
        30000
      )
    );
    costData = await Promise.race([getELBCosts(ceClient), ceTimeout]);
    if (costData) {
      log(
        `Cost Explorer: $${costData.totalELBCost.toFixed(2)}/mo total, ${costData.costByResource.size} resources with per-resource data`
      );
    }
  } catch (err: any) {
    console.warn(`ELB Cost Explorer fetch failed: ${err.message}`);
    log("Cost Explorer unavailable — using estimated costs");
  }

  // 8. Collect CloudWatch metrics and build unified data
  const loadBalancers: ELBLoadBalancerData[] = [];

  // Process v2 load balancers
  for (let i = 0; i < v2LoadBalancers.length; i++) {
    const lb = v2LoadBalancers[i];
    log(
      `Collecting metrics for ${lb.name} (${i + 1}/${v2LoadBalancers.length + classicLoadBalancers.length})...`
    );

    const tgInfo = tgByLB.get(lb.arn) || {
      count: 0,
      healthy: 0,
      unhealthy: 0,
      total: 0,
    };

    let metrics: ELBMetrics;
    try {
      if (lb.type === "application") {
        metrics = await getALBMetrics(cwClient, lb.arn);
      } else if (lb.type === "network") {
        metrics = await getNLBMetrics(cwClient, lb.arn);
      } else {
        // GWLB — minimal metrics, just use NLB pattern
        metrics = await getNLBMetrics(cwClient, lb.arn);
      }
    } catch (err: any) {
      console.warn(
        `Failed to get metrics for ${lb.name}: ${err.message}`
      );
      metrics = emptyMetrics();
    }

    const lbType =
      lb.type === "application"
        ? "alb"
        : lb.type === "network"
          ? "nlb"
          : "gwlb";

    const data: ELBLoadBalancerData = {
      id: lb.arn,
      name: lb.name,
      type: lbType as "alb" | "nlb" | "gwlb",
      scheme: lb.scheme,
      vpcId: lb.vpcId,
      availabilityZones: lb.availabilityZones,
      createdTime: lb.createdTime,
      tags: lb.tags,
      targetGroupCount: tgInfo.count,
      healthyTargets: tgInfo.healthy,
      unhealthyTargets: tgInfo.unhealthy,
      totalTargets: tgInfo.total,
      metrics,
      currentMonthlyCost: 0, // calculated below
      costIsActual: false,
    };

    data.currentMonthlyCost = estimateMonthlyCost(data);
    loadBalancers.push(data);
  }

  // Process Classic LBs
  for (let i = 0; i < classicLoadBalancers.length; i++) {
    const lb = classicLoadBalancers[i];
    log(
      `Collecting metrics for CLB ${lb.name} (${v2LoadBalancers.length + i + 1}/${v2LoadBalancers.length + classicLoadBalancers.length})...`
    );

    let metrics: ELBMetrics;
    try {
      metrics = await getCLBMetrics(cwClient, lb.name);
    } catch (err: any) {
      console.warn(
        `Failed to get metrics for CLB ${lb.name}: ${err.message}`
      );
      metrics = emptyMetrics();
    }

    const data: ELBLoadBalancerData = {
      id: lb.name, // CLBs use name as ID
      name: lb.name,
      type: "clb",
      scheme: lb.scheme,
      vpcId: lb.vpcId,
      availabilityZones: lb.availabilityZones,
      createdTime: lb.createdTime,
      tags: lb.tags,
      targetGroupCount: 0,
      healthyTargets: lb.healthyCount,
      unhealthyTargets: lb.unhealthyCount,
      totalTargets: lb.instanceCount,
      metrics,
      currentMonthlyCost: 0,
      costIsActual: false,
    };

    data.currentMonthlyCost = estimateMonthlyCost(data);
    loadBalancers.push(data);
  }

  // 9. Apply Cost Explorer actual costs
  if (costData) {
    const totalEstimated = loadBalancers.reduce(
      (s, lb) => s + lb.currentMonthlyCost,
      0
    );

    for (const lb of loadBalancers) {
      // Try matching by ARN (v2) or name (CLB)
      const ceCost =
        costData.costByResource.get(lb.id) ||
        findCECostByPartialMatch(costData.costByResource, lb.id, lb.name);

      if (ceCost != null && ceCost > 0) {
        lb.currentMonthlyCost = ceCost;
        lb.costIsActual = true;
      } else if (
        costData.totalELBCost > 0 &&
        totalEstimated > 0 &&
        lb.currentMonthlyCost > 0
      ) {
        // Proportional distribution
        const proportion = lb.currentMonthlyCost / totalEstimated;
        lb.currentMonthlyCost = costData.totalELBCost * proportion;
        lb.costIsActual = true;
      }
    }
  }

  // 10. Identify orphaned target groups (TGs not associated with any LB)
  const orphanedTargetGroups = allTargetGroups.filter(
    (tg) => tg.loadBalancerArns.length === 0
  );

  // 11. Build summary
  const totalMonthlyCost = loadBalancers.reduce(
    (s, lb) => s + lb.currentMonthlyCost,
    0
  );

  log(
    `ELB collection complete: ${loadBalancers.length} load balancers, ${orphanedTargetGroups.length} orphaned TGs, est. $${totalMonthlyCost.toFixed(2)}/mo`
  );

  return {
    accountName,
    accountId,
    region,
    loadBalancers,
    orphanedTargetGroups,
    accountSummary: {
      totalLoadBalancers: loadBalancers.length,
      totalALBs: loadBalancers.filter((lb) => lb.type === "alb").length,
      totalNLBs: loadBalancers.filter((lb) => lb.type === "nlb").length,
      totalCLBs: loadBalancers.filter((lb) => lb.type === "clb").length,
      totalGWLBs: loadBalancers.filter((lb) => lb.type === "gwlb").length,
      totalMonthlyCost,
    },
    collectedAt: new Date().toISOString(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyMetrics(): ELBMetrics {
  return {
    requestCountSum: null,
    activeConnectionsAvg: null,
    activeConnectionsMax: null,
    processedBytesSum: null,
    consumedLCUsAvg: null,
    activeFlowCountAvg: null,
    activeFlowCountMax: null,
    newFlowCountSum: null,
    backendErrorsSum: null,
    healthyHostCountAvg: null,
    unhealthyHostCountAvg: null,
  };
}

/**
 * CE resource IDs may be full ARNs or partial names.
 * Try matching by suffix or name containment.
 */
function findCECostByPartialMatch(
  costMap: Map<string, number>,
  id: string,
  name: string
): number | null {
  for (const [key, cost] of costMap) {
    if (key === id) return cost;
    if (key.includes(name) || id.includes(key)) return cost;
  }
  return null;
}
