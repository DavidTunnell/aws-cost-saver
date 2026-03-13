import { EC2Client } from "@aws-sdk/client-ec2";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import { getMetric } from "./cloudwatch";
import {
  listNatGateways,
  listVpcEndpoints,
  type NatGatewayInfo,
  type VpcEndpointInfo,
} from "./nat";

// ─── Enriched data interfaces ───────────────────────────────────────────────

export interface NatGatewayMetrics {
  bytesOutSum: number | null;
  bytesInSum: number | null;
  bytesOutAvg: number | null;
  bytesInAvg: number | null;
  packetsDropSum: number | null;
  errorPortAllocationSum: number | null;
  activeConnectionsAvg: number | null;
  activeConnectionsMax: number | null;
  connectionAttemptSum: number | null;
}

export interface NatGatewayData extends NatGatewayInfo {
  metrics: NatGatewayMetrics;
  currentMonthlyCost: number;
  costIsActual: boolean;
}

export interface NatGatewayAccountData {
  accountName: string;
  accountId: string;
  region: string;
  gateways: NatGatewayData[];
  vpcEndpoints: VpcEndpointInfo[];
  /** VPC ID → set of service names with Gateway endpoints (e.g., "com.amazonaws.us-east-1.s3") */
  vpcGatewayEndpoints: Record<string, string[]>;
  accountSummary: {
    totalGateways: number;
    activeGateways: number;
    totalMonthlyCost: number;
  };
  collectedAt: string;
}

// ─── Cost Explorer helpers ──────────────────────────────────────────────────

interface NatCostData {
  costByGateway: Map<string, number>;
  totalNatCost: number;
  hasResourceData: boolean;
}

async function getNatGatewayCosts(
  client: CostExplorerClient,
  days: number = 30
): Promise<NatCostData | null> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0];
  const timePeriod = { Start: formatDate(startDate), End: formatDate(endDate) };

  // First, get aggregate NAT Gateway cost by usage type
  let natUsageTypes: string[] = [];
  let totalNatCost = 0;

  try {
    const aggResp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["Amazon Virtual Private Cloud"],
          },
        },
        GroupBy: [{ Type: "DIMENSION", Key: "USAGE_TYPE" }],
      })
    );

    for (const result of aggResp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const usageType = group.Keys?.[0] || "";
        if (!usageType.includes("NatGateway")) continue;
        natUsageTypes.push(usageType);
        totalNatCost += parseFloat(
          group.Metrics?.UnblendedCost?.Amount || "0"
        );
      }
    }

    if (totalNatCost <= 0) {
      return null;
    }
  } catch (err: any) {
    console.warn(
      `Cost Explorer NAT aggregate query failed: ${err.message}`
    );
    return null;
  }

  // Try per-resource grouping with timeout
  const costByGateway = new Map<string, number>();
  let hasResourceData = false;

  if (natUsageTypes.length > 0) {
    try {
      const resourcePromise = client.send(
        new GetCostAndUsageCommand({
          TimePeriod: timePeriod,
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"],
          Filter: {
            And: [
              {
                Dimensions: {
                  Key: "SERVICE",
                  Values: ["Amazon Virtual Private Cloud"],
                },
              },
              {
                Dimensions: {
                  Key: "USAGE_TYPE",
                  Values: natUsageTypes,
                },
              },
            ],
          },
          GroupBy: [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
        })
      );

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "NAT per-resource CE query timed out after 15s"
              )
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

          // Resource ID may be full ARN — extract NAT gateway ID
          const natId = resourceId.includes("nat-")
            ? resourceId.slice(
                resourceId.lastIndexOf("nat-")
              )
            : resourceId;

          costByGateway.set(
            natId,
            (costByGateway.get(natId) || 0) + cost
          );
        }
      }

      hasResourceData = costByGateway.size > 0;
    } catch (err: any) {
      console.warn(
        `Cost Explorer NAT per-resource query failed (will use aggregate): ${err.message}`
      );
    }
  }

  return { costByGateway, totalNatCost, hasResourceData };
}

// ─── Metric collection ──────────────────────────────────────────────────────

async function getNatGatewayMetrics(
  client: CloudWatchClient,
  natGatewayId: string,
  days: number = 14
): Promise<NatGatewayMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600; // 1-hour periods

  const [
    bytesOutDp,
    bytesInDp,
    packetsDropDp,
    errorPortDp,
    activeConnDp,
    connAttemptDp,
  ] = await Promise.all([
    getMetric(client, "NatGatewayId", natGatewayId, "BytesOutToDestination", ["Average", "Sum"], startTime, endTime, period, "AWS/NatGateway"),
    getMetric(client, "NatGatewayId", natGatewayId, "BytesInFromSource", ["Average", "Sum"], startTime, endTime, period, "AWS/NatGateway"),
    getMetric(client, "NatGatewayId", natGatewayId, "PacketsDropCount", ["Sum"], startTime, endTime, period, "AWS/NatGateway"),
    getMetric(client, "NatGatewayId", natGatewayId, "ErrorPortAllocation", ["Sum"], startTime, endTime, period, "AWS/NatGateway"),
    getMetric(client, "NatGatewayId", natGatewayId, "ActiveConnectionCount", ["Average", "Maximum"], startTime, endTime, period, "AWS/NatGateway"),
    getMetric(client, "NatGatewayId", natGatewayId, "ConnectionAttemptCount", ["Sum"], startTime, endTime, period, "AWS/NatGateway"),
  ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const sum = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) : null;
  const max = (arr: number[]) =>
    arr.length ? Math.max(...arr) : null;

  return {
    bytesOutSum: sum(bytesOutDp.map((d) => d.Sum!).filter((v) => v != null)),
    bytesInSum: sum(bytesInDp.map((d) => d.Sum!).filter((v) => v != null)),
    bytesOutAvg: avg(bytesOutDp.map((d) => d.Average!).filter((v) => v != null)),
    bytesInAvg: avg(bytesInDp.map((d) => d.Average!).filter((v) => v != null)),
    packetsDropSum: sum(packetsDropDp.map((d) => d.Sum!).filter((v) => v != null)),
    errorPortAllocationSum: sum(errorPortDp.map((d) => d.Sum!).filter((v) => v != null)),
    activeConnectionsAvg: avg(activeConnDp.map((d) => d.Average!).filter((v) => v != null)),
    activeConnectionsMax: max(activeConnDp.map((d) => d.Maximum!).filter((v) => v != null)),
    connectionAttemptSum: sum(connAttemptDp.map((d) => d.Sum!).filter((v) => v != null)),
  };
}

// ─── Main collector ─────────────────────────────────────────────────────────

// NAT Gateway fixed cost: $0.045/hr × 730 hrs/mo ≈ $32.85/mo
const NAT_FIXED_MONTHLY = 0.045 * 730;
// Data processing cost: $0.045/GB
const NAT_DATA_RATE_PER_GB = 0.045;

export async function collectNatGatewayData(
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string,
  accountName: string,
  accountId: string,
  onProgress?: (msg: string) => void
): Promise<NatGatewayAccountData> {
  const log = onProgress || (() => {});

  const ec2Client = new EC2Client({ region, credentials });
  const cwClient = new CloudWatchClient({ region, credentials });
  const ceClient = new CostExplorerClient({ region, credentials });

  // 1. Discover NAT Gateways
  log("Discovering NAT Gateways...");
  const rawGateways = await listNatGateways(ec2Client);
  const activeGateways = rawGateways.filter((g) => g.state === "available");
  log(`Found ${rawGateways.length} NAT Gateways (${activeGateways.length} active)`);

  // 2. Discover VPC Endpoints (for no-vpc-endpoint detection)
  log("Discovering VPC Endpoints...");
  const vpcEndpoints = await listVpcEndpoints(ec2Client);
  const gatewayEndpoints = vpcEndpoints.filter(
    (ep) => ep.endpointType === "Gateway" && ep.state === "available"
  );
  log(`Found ${gatewayEndpoints.length} active Gateway endpoints`);

  // Build VPC → gateway endpoint service names map
  const vpcGatewayEndpoints: Record<string, string[]> = {};
  for (const ep of gatewayEndpoints) {
    if (!vpcGatewayEndpoints[ep.vpcId]) {
      vpcGatewayEndpoints[ep.vpcId] = [];
    }
    vpcGatewayEndpoints[ep.vpcId].push(ep.serviceName);
  }

  // 3. Fetch Cost Explorer data (with overall timeout)
  log("Fetching NAT Gateway costs from Cost Explorer...");
  let costData: NatCostData | null = null;
  try {
    const ceTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error("NAT Cost Explorer overall timeout after 30s")
          ),
        30000
      )
    );
    costData = await Promise.race([getNatGatewayCosts(ceClient), ceTimeout]);
    if (costData) {
      log(
        `Cost Explorer: $${costData.totalNatCost.toFixed(2)}/mo total, ${costData.costByGateway.size} gateways with per-resource data`
      );
    }
  } catch (err: any) {
    console.warn(`NAT Cost Explorer fetch failed: ${err.message}`);
    log("Cost Explorer unavailable — using estimated costs");
  }

  // 4. Collect metrics for each active gateway
  const gateways: NatGatewayData[] = [];

  for (let i = 0; i < activeGateways.length; i++) {
    const gw = activeGateways[i];
    log(
      `Collecting metrics for ${gw.natGatewayId} (${i + 1}/${activeGateways.length})...`
    );

    let metrics: NatGatewayMetrics = {
      bytesOutSum: null,
      bytesInSum: null,
      bytesOutAvg: null,
      bytesInAvg: null,
      packetsDropSum: null,
      errorPortAllocationSum: null,
      activeConnectionsAvg: null,
      activeConnectionsMax: null,
      connectionAttemptSum: null,
    };

    try {
      metrics = await getNatGatewayMetrics(cwClient, gw.natGatewayId);
    } catch (err: any) {
      console.warn(
        `Failed to get metrics for ${gw.natGatewayId}: ${err.message}`
      );
    }

    // Estimate cost from metrics as fallback
    const totalBytesProcessed =
      (metrics.bytesOutSum ?? 0) + (metrics.bytesInSum ?? 0);
    const dataProcessingMonthly =
      (totalBytesProcessed / (1024 * 1024 * 1024)) * NAT_DATA_RATE_PER_GB;
    const estimatedCost = NAT_FIXED_MONTHLY + dataProcessingMonthly;

    gateways.push({
      ...gw,
      metrics,
      currentMonthlyCost: estimatedCost,
      costIsActual: false,
    });
  }

  // 5. Apply Cost Explorer actual costs (second pass)
  if (costData) {
    const totalEstimated = gateways.reduce(
      (s, g) => s + g.currentMonthlyCost,
      0
    );

    for (const gw of gateways) {
      const ceCost = costData.costByGateway.get(gw.natGatewayId);
      if (ceCost != null && ceCost > 0) {
        // Tier 1: Direct per-resource cost
        gw.currentMonthlyCost = ceCost;
        gw.costIsActual = true;
      } else if (
        costData.totalNatCost > 0 &&
        totalEstimated > 0 &&
        gw.currentMonthlyCost > 0
      ) {
        // Tier 2: Proportional distribution of aggregate
        const proportion = gw.currentMonthlyCost / totalEstimated;
        gw.currentMonthlyCost = costData.totalNatCost * proportion;
        gw.costIsActual = true;
      }
      // Tier 3: Keep the metric-based estimate (costIsActual = false)
    }
  }

  // 6. Build summary
  const totalMonthlyCost = gateways.reduce(
    (s, g) => s + g.currentMonthlyCost,
    0
  );

  log(
    `NAT collection complete: ${gateways.length} active gateways, est. $${totalMonthlyCost.toFixed(2)}/mo`
  );

  return {
    accountName,
    accountId,
    region,
    gateways,
    vpcEndpoints,
    vpcGatewayEndpoints,
    accountSummary: {
      totalGateways: rawGateways.length,
      activeGateways: gateways.length,
      totalMonthlyCost,
    },
    collectedAt: new Date().toISOString(),
  };
}
