import {
  OpenSearchClient,
  ListDomainNamesCommand,
  DescribeDomainsCommand,
  ListTagsCommand,
  DescribeReservedInstancesCommand,
} from "@aws-sdk/client-opensearch";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type Statistic,
} from "@aws-sdk/client-cloudwatch";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";

// ─── Data interfaces ────────────────────────────────────────────────────────

export interface OpenSearchDomainMetrics {
  avgCpuUtilization: number | null;
  maxCpuUtilization: number | null;
  avgJvmMemoryPressure: number | null;
  maxJvmMemoryPressure: number | null;
  avgSearchRate: number | null;
  avgIndexingRate: number | null;
  freeStorageSpaceGb: number | null;
  totalStorageGb: number;
  clusterStatusGreen: number | null;
}

export interface OpenSearchDomainData {
  domainName: string;
  domainArn: string;
  engineVersion: string;
  instanceType: string;
  instanceCount: number;
  masterType: string | null;
  masterCount: number;
  dedicatedMasterEnabled: boolean;
  storageType: string;
  ebsVolumeType: string | null;
  ebsVolumeSize: number | null;
  ebsIops: number | null;
  multiAZ: boolean;
  warmEnabled: boolean;
  warmType: string | null;
  warmCount: number;
  coldStorageEnabled: boolean;
  encryptionAtRest: boolean;
  nodeToNodeEncryption: boolean;
  tags: Record<string, string>;
  metrics: OpenSearchDomainMetrics;
  monthlyCost: number;
  costIsActual: boolean;
  estimatedMonthlyCost: number;
  endpoint: string | null;
  createdAt: string;
}

export interface OpenSearchReservedInstance {
  instanceType: string;
  instanceCount: number;
  state: string;
}

export interface OpenSearchAccountData {
  accountName: string;
  accountId: string;
  region: string;
  domains: OpenSearchDomainData[];
  reservedInstances: OpenSearchReservedInstance[];
  accountSummary: {
    totalDomains: number;
    totalMonthlyCost: number;
  };
  collectedAt: string;
}

// ─── Instance pricing (us-east-1 baseline, $/hr) ────────────────────────────

const INSTANCE_HOURLY_RATES: Record<string, number> = {
  "t3.small.search": 0.036,
  "t3.medium.search": 0.073,
  "t2.small.search": 0.036,
  "t2.medium.search": 0.073,
  "m6g.large.search": 0.128,
  "m6g.xlarge.search": 0.256,
  "m6g.2xlarge.search": 0.512,
  "m6g.4xlarge.search": 1.024,
  "m5.large.search": 0.142,
  "m5.xlarge.search": 0.284,
  "m5.2xlarge.search": 0.568,
  "m5.4xlarge.search": 1.136,
  "r6g.large.search": 0.167,
  "r6g.xlarge.search": 0.335,
  "r6g.2xlarge.search": 0.669,
  "r6g.4xlarge.search": 1.339,
  "r5.large.search": 0.186,
  "r5.xlarge.search": 0.371,
  "r5.2xlarge.search": 0.742,
  "r5.4xlarge.search": 1.484,
  "c6g.large.search": 0.111,
  "c6g.xlarge.search": 0.222,
  "c6g.2xlarge.search": 0.444,
  "c5.large.search": 0.123,
  "c5.xlarge.search": 0.245,
  "c5.2xlarge.search": 0.490,
  "i3.large.search": 0.175,
  "i3.xlarge.search": 0.351,
  "i3.2xlarge.search": 0.702,
  // UltraWarm types
  "ultrawarm1.medium.search": 0.238,
  "ultrawarm1.large.search": 0.476,
};

function getHourlyRate(instanceType: string): number {
  if (INSTANCE_HOURLY_RATES[instanceType]) {
    return INSTANCE_HOURLY_RATES[instanceType];
  }
  // Fallback by size suffix
  if (instanceType.includes("small")) return 0.04;
  if (instanceType.includes("medium")) return 0.08;
  if (instanceType.includes("xlarge") && instanceType.includes("2xlarge")) return 0.64;
  if (instanceType.includes("xlarge") && instanceType.includes("4xlarge")) return 1.28;
  if (instanceType.includes("xlarge")) return 0.32;
  if (instanceType.includes("large")) return 0.16;
  return 0.16; // default to large
}

// EBS pricing per GB/month
const EBS_PRICES: Record<string, number> = {
  gp2: 0.135,
  gp3: 0.108,
  io1: 0.154,
  io2: 0.154,
  standard: 0.10,
};

function estimateDomainMonthlyCost(
  instanceType: string,
  instanceCount: number,
  ebsVolumeType: string | null,
  ebsVolumeSize: number | null,
  ebsIops: number | null,
  dedicatedMasterEnabled: boolean,
  masterType: string | null,
  masterCount: number,
  warmEnabled: boolean,
  warmType: string | null,
  warmCount: number
): number {
  // Data node compute
  const dataNodeCost = instanceCount * getHourlyRate(instanceType) * 730;

  // EBS storage
  let ebsCost = 0;
  if (ebsVolumeType && ebsVolumeSize) {
    const pricePerGb = EBS_PRICES[ebsVolumeType] ?? EBS_PRICES["gp2"];
    ebsCost = ebsVolumeSize * instanceCount * pricePerGb;
    // io1/io2 IOPS cost
    if (ebsIops && (ebsVolumeType === "io1" || ebsVolumeType === "io2")) {
      ebsCost += ebsIops * instanceCount * 0.065;
    }
  }

  // Dedicated master nodes
  let masterCost = 0;
  if (dedicatedMasterEnabled && masterType) {
    masterCost = masterCount * getHourlyRate(masterType) * 730;
  }

  // UltraWarm nodes
  let warmCost = 0;
  if (warmEnabled && warmType) {
    warmCost = warmCount * getHourlyRate(warmType) * 730;
  }

  return dataNodeCost + ebsCost + masterCost + warmCost;
}

// ─── CloudWatch helper (2-dimension for OpenSearch) ─────────────────────────

async function getOpenSearchMetric(
  client: CloudWatchClient,
  domainName: string,
  clientId: string,
  metricName: string,
  statistics: Statistic[],
  startTime: Date,
  endTime: Date,
  period: number
) {
  const resp = await client.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/ES",
      MetricName: metricName,
      Dimensions: [
        { Name: "DomainName", Value: domainName },
        { Name: "ClientId", Value: clientId },
      ],
      StartTime: startTime,
      EndTime: endTime,
      Period: period,
      Statistics: statistics,
    })
  );
  return resp.Datapoints || [];
}

async function getDomainMetrics(
  client: CloudWatchClient,
  domainName: string,
  clientId: string,
  days: number = 30
): Promise<OpenSearchDomainMetrics & { totalStorageGb: number }> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600; // 1-hour periods

  const [cpuDp, jvmDp, searchDp, indexDp, freeDp, greenDp] =
    await Promise.all([
      getOpenSearchMetric(client, domainName, clientId, "CPUUtilization", ["Average", "Maximum"], startTime, endTime, period),
      getOpenSearchMetric(client, domainName, clientId, "JVMMemoryPressure", ["Average", "Maximum"], startTime, endTime, period),
      getOpenSearchMetric(client, domainName, clientId, "SearchRate", ["Average"], startTime, endTime, period),
      getOpenSearchMetric(client, domainName, clientId, "IndexingRate", ["Average"], startTime, endTime, period),
      getOpenSearchMetric(client, domainName, clientId, "FreeStorageSpace", ["Average"], startTime, endTime, period),
      getOpenSearchMetric(client, domainName, clientId, "ClusterStatus.green", ["Average"], startTime, endTime, period),
    ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const max = (arr: number[]) =>
    arr.length ? Math.max(...arr) : null;

  return {
    avgCpuUtilization: avg(cpuDp.map((d) => d.Average!).filter((v) => v != null)),
    maxCpuUtilization: max(cpuDp.map((d) => d.Maximum!).filter((v) => v != null)),
    avgJvmMemoryPressure: avg(jvmDp.map((d) => d.Average!).filter((v) => v != null)),
    maxJvmMemoryPressure: max(jvmDp.map((d) => d.Maximum!).filter((v) => v != null)),
    avgSearchRate: avg(searchDp.map((d) => d.Average!).filter((v) => v != null)),
    avgIndexingRate: avg(indexDp.map((d) => d.Average!).filter((v) => v != null)),
    // FreeStorageSpace is in MB, convert to GB
    freeStorageSpaceGb: avg(freeDp.map((d) => d.Average!).filter((v) => v != null)) != null
      ? avg(freeDp.map((d) => d.Average!).filter((v) => v != null))! / 1024
      : null,
    clusterStatusGreen: avg(greenDp.map((d) => d.Average!).filter((v) => v != null)),
    totalStorageGb: 0, // computed later from EBS config
  };
}

// ─── Cost Explorer ──────────────────────────────────────────────────────────

interface OpenSearchCostData {
  costByDomain: Map<string, number>;
  totalCost: number;
  hasResourceData: boolean;
}

async function getOpenSearchCosts(
  client: CostExplorerClient,
  days: number = 30
): Promise<OpenSearchCostData | null> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0];
  const timePeriod = { Start: formatDate(startDate), End: formatDate(endDate) };

  let totalCost = 0;

  // Aggregate query
  try {
    const aggResp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["Amazon OpenSearch Service"],
          },
        },
        GroupBy: [{ Type: "DIMENSION", Key: "USAGE_TYPE" }],
      })
    );

    for (const result of aggResp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        totalCost += parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
      }
    }

    if (totalCost <= 0) return null;
  } catch (err: any) {
    console.warn(`Cost Explorer OpenSearch aggregate query failed: ${err.message}`);
    return null;
  }

  // Per-resource query with timeout
  const costByDomain = new Map<string, number>();
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
            Values: ["Amazon OpenSearch Service"],
          },
        },
        GroupBy: [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
      })
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("OpenSearch per-resource CE query timed out after 15s")), 15000)
    );

    const resourceResp = await Promise.race([resourcePromise, timeoutPromise]);

    for (const result of resourceResp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const resourceId = group.Keys?.[0] || "";
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
        if (!resourceId || cost <= 0) continue;

        // Resource ID may be ARN — extract domain name
        const domainName = resourceId.includes("/")
          ? resourceId.split("/").pop()!
          : resourceId;

        costByDomain.set(domainName, (costByDomain.get(domainName) || 0) + cost);
      }
    }

    hasResourceData = costByDomain.size > 0;
  } catch (err: any) {
    console.warn(`Cost Explorer OpenSearch per-resource query failed (will use aggregate): ${err.message}`);
  }

  return { costByDomain, totalCost, hasResourceData };
}

// ─── Main collector ─────────────────────────────────────────────────────────

export async function collectOpenSearchData(
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string,
  accountName: string,
  accountId: string,
  onProgress?: (msg: string) => void
): Promise<OpenSearchAccountData> {
  const log = onProgress || (() => {});

  const osClient = new OpenSearchClient({ region, credentials });
  const cwClient = new CloudWatchClient({ region, credentials });
  const ceClient = new CostExplorerClient({ region, credentials });

  // 1. List domain names
  log("Discovering OpenSearch domains...");
  const listResp = await osClient.send(new ListDomainNamesCommand({ EngineType: "OpenSearch" }));
  const allDomainNames = (listResp.DomainNames || []).map((d) => d.DomainName!);

  // Also get Elasticsearch domains
  const listEsResp = await osClient.send(new ListDomainNamesCommand({ EngineType: "Elasticsearch" }));
  const esDomainNames = (listEsResp.DomainNames || []).map((d) => d.DomainName!);
  allDomainNames.push(...esDomainNames);

  log(`Found ${allDomainNames.length} OpenSearch/Elasticsearch domains`);

  // Fetch Reserved Instances
  log("Checking Reserved Instances...");
  const reservedInstances: OpenSearchReservedInstance[] = [];
  try {
    const riResp = await osClient.send(new DescribeReservedInstancesCommand({}));
    for (const ri of riResp.ReservedInstances || []) {
      if (ri.State === "active" && ri.InstanceType && ri.InstanceCount) {
        reservedInstances.push({
          instanceType: ri.InstanceType,
          instanceCount: ri.InstanceCount,
          state: ri.State,
        });
      }
    }
    log(`Found ${reservedInstances.length} active Reserved Instance reservations`);
  } catch (err: any) {
    log(`Warning: Could not fetch Reserved Instances: ${err.message}`);
  }

  if (allDomainNames.length === 0) {
    return {
      accountName,
      accountId,
      region,
      domains: [],
      reservedInstances,
      accountSummary: { totalDomains: 0, totalMonthlyCost: 0 },
      collectedAt: new Date().toISOString(),
    };
  }

  // 2. Describe domains (batch max 5 per call)
  log("Getting domain configurations...");
  const domainStatuses: any[] = [];
  for (let i = 0; i < allDomainNames.length; i += 5) {
    const batch = allDomainNames.slice(i, i + 5);
    const descResp = await osClient.send(new DescribeDomainsCommand({ DomainNames: batch }));
    domainStatuses.push(...(descResp.DomainStatusList || []));
  }

  // 3. Get tags for each domain
  log("Fetching domain tags...");
  const domainTags = new Map<string, Record<string, string>>();
  for (const ds of domainStatuses) {
    try {
      const tagResp = await osClient.send(new ListTagsCommand({ ARN: ds.ARN }));
      const tags: Record<string, string> = {};
      for (const tag of tagResp.TagList || []) {
        if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
      }
      domainTags.set(ds.DomainName!, tags);
    } catch {
      domainTags.set(ds.DomainName!, {});
    }
  }

  // 4. Get Cost Explorer data
  log("Fetching Cost Explorer data...");
  const costData = await getOpenSearchCosts(ceClient);

  // 5. Get CloudWatch metrics for each domain
  log("Fetching CloudWatch metrics...");
  const domains: OpenSearchDomainData[] = [];

  for (const ds of domainStatuses) {
    const domainName = ds.DomainName!;
    const clusterConfig = ds.ClusterConfig || {};
    const ebsOptions = ds.EBSOptions || {};
    const instanceType = clusterConfig.InstanceType || "unknown";
    const instanceCount = clusterConfig.InstanceCount || 1;
    const ebsVolumeType = ebsOptions.EBSEnabled ? (ebsOptions.VolumeType || null) : null;
    const ebsVolumeSize = ebsOptions.EBSEnabled ? (ebsOptions.VolumeSize || null) : null;
    const ebsIops = ebsOptions.Iops || null;
    const dedicatedMasterEnabled = clusterConfig.DedicatedMasterEnabled || false;
    const masterType = dedicatedMasterEnabled ? (clusterConfig.DedicatedMasterType || null) : null;
    const masterCount = dedicatedMasterEnabled ? (clusterConfig.DedicatedMasterCount || 3) : 0;
    const warmEnabled = clusterConfig.WarmEnabled || false;
    const warmType = warmEnabled ? (clusterConfig.WarmType || null) : null;
    const warmCount = warmEnabled ? (clusterConfig.WarmCount || 0) : 0;

    // Metrics
    let metrics: OpenSearchDomainMetrics & { totalStorageGb: number };
    try {
      metrics = await getDomainMetrics(cwClient, domainName, accountId);
    } catch (err: any) {
      log(`Warning: CloudWatch metrics failed for ${domainName}: ${err.message}`);
      metrics = {
        avgCpuUtilization: null,
        maxCpuUtilization: null,
        avgJvmMemoryPressure: null,
        maxJvmMemoryPressure: null,
        avgSearchRate: null,
        avgIndexingRate: null,
        freeStorageSpaceGb: null,
        totalStorageGb: 0,
        clusterStatusGreen: null,
      };
    }

    // Compute total storage
    const totalStorageGb = (ebsVolumeSize || 0) * instanceCount;
    metrics.totalStorageGb = totalStorageGb;

    // Cost estimation
    const estimatedMonthlyCost = estimateDomainMonthlyCost(
      instanceType, instanceCount,
      ebsVolumeType, ebsVolumeSize, ebsIops,
      dedicatedMasterEnabled, masterType, masterCount,
      warmEnabled, warmType, warmCount
    );

    // Actual cost from Cost Explorer
    let monthlyCost = estimatedMonthlyCost;
    let costIsActual = false;

    if (costData) {
      if (costData.hasResourceData && costData.costByDomain.has(domainName)) {
        monthlyCost = costData.costByDomain.get(domainName)!;
        costIsActual = true;
      } else if (!costData.hasResourceData && costData.totalCost > 0) {
        // Distribute proportionally by estimated cost
        const totalEstimated = domainStatuses.reduce((sum, d) => {
          const dc = d.ClusterConfig || {};
          const de = d.EBSOptions || {};
          return sum + estimateDomainMonthlyCost(
            dc.InstanceType || "unknown", dc.InstanceCount || 1,
            de.EBSEnabled ? (de.VolumeType || null) : null,
            de.EBSEnabled ? (de.VolumeSize || null) : null,
            de.Iops || null,
            dc.DedicatedMasterEnabled || false, dc.DedicatedMasterType || null, dc.DedicatedMasterCount || 3,
            dc.WarmEnabled || false, dc.WarmType || null, dc.WarmCount || 0
          );
        }, 0);

        if (totalEstimated > 0) {
          monthlyCost = costData.totalCost * (estimatedMonthlyCost / totalEstimated);
          costIsActual = true;
        }
      }
    }

    const endpoint = ds.Endpoints
      ? Object.values(ds.Endpoints)[0] || null
      : ds.Endpoint || null;

    domains.push({
      domainName,
      domainArn: ds.ARN || "",
      engineVersion: ds.EngineVersion || "unknown",
      instanceType,
      instanceCount,
      masterType,
      masterCount,
      dedicatedMasterEnabled,
      storageType: ebsOptions.EBSEnabled ? "ebs" : "instance",
      ebsVolumeType,
      ebsVolumeSize,
      ebsIops,
      multiAZ: clusterConfig.ZoneAwarenessEnabled || false,
      warmEnabled,
      warmType,
      warmCount,
      coldStorageEnabled: ds.ColdStorageOptions?.Enabled || false,
      encryptionAtRest: ds.EncryptionAtRestOptions?.Enabled || false,
      nodeToNodeEncryption: ds.NodeToNodeEncryptionOptions?.Enabled || false,
      tags: domainTags.get(domainName) || {},
      metrics,
      monthlyCost,
      costIsActual,
      estimatedMonthlyCost,
      endpoint: endpoint as string | null,
      // ds.Created is a boolean (domain creation complete), not a timestamp.
      // AWS OpenSearch API does not expose a creation date, so we omit it.
      createdAt: "",
    });
  }

  const totalMonthlyCost = domains.reduce((s, d) => s + d.monthlyCost, 0);

  log(`Collected data for ${domains.length} domains, total cost: $${totalMonthlyCost.toFixed(2)}/mo`);

  return {
    accountName,
    accountId,
    region,
    domains,
    reservedInstances,
    accountSummary: {
      totalDomains: domains.length,
      totalMonthlyCost,
    },
    collectedAt: new Date().toISOString(),
  };
}
