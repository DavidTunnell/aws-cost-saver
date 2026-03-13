import {
  OpenSearchClient,
  ListDomainNamesCommand,
  DescribeDomainsCommand,
  ListTagsCommand,
} from "@aws-sdk/client-opensearch";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import { getMetricMultiDimension } from "./cloudwatch";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface OpenSearchDomainMetrics {
  cpuUtilizationAvg: number | null;
  cpuUtilizationMax: number | null;
  jvmMemoryPressureAvg: number | null;
  jvmMemoryPressureMax: number | null;
  freeStorageSpaceAvg: number | null; // MB
  freeStorageSpaceMin: number | null; // MB — low watermark
  searchRateAvg: number | null;
  indexingRateAvg: number | null;
  searchLatencyAvg: number | null; // ms
}

export interface OpenSearchDomainData {
  domainName: string;
  domainArn: string;
  engineVersion: string; // "OpenSearch_2.11" or "Elasticsearch_7.10"
  instanceType: string; // "r6g.large.search"
  instanceCount: number;
  dedicatedMasterEnabled: boolean;
  dedicatedMasterType: string | null;
  dedicatedMasterCount: number;
  warmEnabled: boolean;
  warmType: string | null;
  warmCount: number;
  ebsEnabled: boolean;
  ebsVolumeType: string | null; // "gp2", "gp3", "io1"
  ebsVolumeSize: number; // GB per node
  ebsIops: number | null;
  ebsThroughput: number | null;
  zoneAwarenessEnabled: boolean;
  availabilityZoneCount: number;
  encryptionAtRest: boolean;
  nodeToNodeEncryption: boolean;
  autoTuneEnabled: boolean;
  createdAt: string;
  tags: Record<string, string>;
  metrics: OpenSearchDomainMetrics;
  currentMonthlyCost: number;
  costIsActual: boolean;
}

export interface OpenSearchAccountData {
  accountName: string;
  accountId: string;
  region: string;
  domains: OpenSearchDomainData[];
  accountSummary: {
    totalDomains: number;
    totalMonthlyCost: number;
  };
  collectedAt: string;
}

// ─── Pricing Constants (us-east-1, on-demand) ───────────────────────────────

// Instance pricing per hour (on-demand, us-east-1)
export const OS_INSTANCE_PRICING: Record<string, number> = {
  // T3 (burstable)
  "t3.small.search": 0.036,
  "t3.medium.search": 0.073,
  // M5 (general purpose, x86)
  "m5.large.search": 0.142,
  "m5.xlarge.search": 0.284,
  "m5.2xlarge.search": 0.568,
  "m5.4xlarge.search": 1.136,
  "m5.12xlarge.search": 3.408,
  // M6g (general purpose, Graviton)
  "m6g.large.search": 0.128,
  "m6g.xlarge.search": 0.256,
  "m6g.2xlarge.search": 0.511,
  "m6g.4xlarge.search": 1.023,
  "m6g.12xlarge.search": 3.068,
  // R5 (memory optimized, x86)
  "r5.large.search": 0.186,
  "r5.xlarge.search": 0.371,
  "r5.2xlarge.search": 0.742,
  "r5.4xlarge.search": 1.484,
  "r5.12xlarge.search": 4.452,
  // R6g (memory optimized, Graviton)
  "r6g.large.search": 0.167,
  "r6g.xlarge.search": 0.335,
  "r6g.2xlarge.search": 0.669,
  "r6g.4xlarge.search": 1.339,
  "r6g.12xlarge.search": 4.016,
  // C5 (compute optimized, x86)
  "c5.large.search": 0.121,
  "c5.xlarge.search": 0.242,
  "c5.2xlarge.search": 0.484,
  "c5.4xlarge.search": 0.967,
  // C6g (compute optimized, Graviton)
  "c6g.large.search": 0.111,
  "c6g.xlarge.search": 0.222,
  "c6g.2xlarge.search": 0.443,
  "c6g.4xlarge.search": 0.886,
  // I3 (storage optimized)
  "i3.large.search": 0.206,
  "i3.xlarge.search": 0.413,
  "i3.2xlarge.search": 0.825,
  // R7i (memory optimized, Intel, current gen x86)
  "r7i.large.search": 0.212,
  "r7i.xlarge.search": 0.423,
  "r7i.2xlarge.search": 0.847,
  "r7i.4xlarge.search": 1.693,
  "r7i.8xlarge.search": 3.387,
  "r7i.12xlarge.search": 5.08,
  // R7g (memory optimized, Graviton3)
  "r7g.medium.search": 0.089,
  "r7g.large.search": 0.178,
  "r7g.xlarge.search": 0.356,
  "r7g.2xlarge.search": 0.711,
  "r7g.4xlarge.search": 1.422,
  "r7g.8xlarge.search": 2.845,
  "r7g.12xlarge.search": 4.267,
  // M7i (general purpose, Intel, current gen x86)
  "m7i.large.search": 0.161,
  "m7i.xlarge.search": 0.323,
  "m7i.2xlarge.search": 0.645,
  "m7i.4xlarge.search": 1.29,
  // M7g (general purpose, Graviton3)
  "m7g.large.search": 0.135,
  "m7g.xlarge.search": 0.271,
  "m7g.2xlarge.search": 0.542,
  "m7g.4xlarge.search": 1.084,
  "m7g.8xlarge.search": 2.167,
  "m7g.12xlarge.search": 3.251,
  // C7g (compute optimized, Graviton3)
  "c7g.large.search": 0.12,
  "c7g.xlarge.search": 0.241,
  "c7g.2xlarge.search": 0.481,
  "c7g.4xlarge.search": 0.963,
  // OR1 (OR1 optimized storage)
  "or1.medium.search": 0.107,
  "or1.large.search": 0.214,
  "or1.xlarge.search": 0.428,
  // Older generations
  "m4.large.search": 0.142,
  "m4.xlarge.search": 0.283,
  "r4.large.search": 0.186,
  "r4.xlarge.search": 0.371,
  "r3.large.search": 0.186,
  "r3.xlarge.search": 0.371,
  "m3.medium.search": 0.067,
  "m3.large.search": 0.14,
  "m3.xlarge.search": 0.28,
};

export const GP2_PER_GB_MONTH = 0.10;
export const GP3_PER_GB_MONTH = 0.08;
export const IO1_PER_GB_MONTH = 0.125;
export const GRAVITON_DISCOUNT = 0.2; // ~20% savings over x86 equivalents

// ─── Cost Explorer ───────────────────────────────────────────────────────────

interface OpenSearchCostData {
  totalCost: number;
  costByDomain: Map<string, number>; // domain ARN or name → cost
}

async function getOpenSearchCosts(
  client: CostExplorerClient,
  days: number = 30
): Promise<OpenSearchCostData | null> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0];
  const timePeriod = { Start: formatDate(startDate), End: formatDate(endDate) };

  const costByDomain = new Map<string, number>();
  let totalCost = 0;

  // Try per-resource grouping first
  try {
    const resp = await client.send(
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

    for (const result of resp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const resourceId = group.Keys?.[0] || "";
        const cost = parseFloat(
          group.Metrics?.UnblendedCost?.Amount || "0"
        );
        if (cost > 0) {
          // Resource ID may be domain ARN — extract domain name
          const domainName = resourceId.includes("/")
            ? resourceId.split("/").pop() || resourceId
            : resourceId;
          costByDomain.set(
            domainName,
            (costByDomain.get(domainName) || 0) + cost
          );
          totalCost += cost;
        }
      }
    }

    if (totalCost > 0) {
      return { totalCost, costByDomain };
    }
  } catch (err: any) {
    console.warn(
      `Cost Explorer per-resource query failed (will use aggregate): ${err.message}`
    );
  }

  // Fall back to aggregate
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
      })
    );

    for (const result of aggResp.ResultsByTime || []) {
      totalCost += parseFloat(
        result.Total?.UnblendedCost?.Amount || "0"
      );
    }

    if (totalCost > 0) {
      return { totalCost, costByDomain }; // costByDomain is empty — aggregate only
    }
  } catch (err: any) {
    console.warn(
      `Cost Explorer OpenSearch aggregate query failed: ${err.message}`
    );
  }

  return null;
}

// ─── Metric collection ───────────────────────────────────────────────────────

async function getDomainMetrics(
  client: CloudWatchClient,
  domainName: string,
  accountId: string,
  days: number = 14
): Promise<OpenSearchDomainMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600;

  // OpenSearch metrics use AWS/ES namespace with DomainName + ClientId dimensions
  const dimensions = [
    { Name: "DomainName", Value: domainName },
    { Name: "ClientId", Value: accountId },
  ];

  const [cpuDp, jvmDp, storageDp, searchDp, indexDp, latencyDp] =
    await Promise.all([
      getMetricMultiDimension(
        client,
        dimensions,
        "CPUUtilization",
        ["Average", "Maximum"],
        startTime,
        endTime,
        period,
        "AWS/ES"
      ),
      getMetricMultiDimension(
        client,
        dimensions,
        "JVMMemoryPressure",
        ["Average", "Maximum"],
        startTime,
        endTime,
        period,
        "AWS/ES"
      ),
      getMetricMultiDimension(
        client,
        dimensions,
        "FreeStorageSpace",
        ["Average", "Minimum"],
        startTime,
        endTime,
        period,
        "AWS/ES"
      ),
      getMetricMultiDimension(
        client,
        dimensions,
        "SearchRate",
        ["Average"],
        startTime,
        endTime,
        period,
        "AWS/ES"
      ),
      getMetricMultiDimension(
        client,
        dimensions,
        "IndexingRate",
        ["Average"],
        startTime,
        endTime,
        period,
        "AWS/ES"
      ),
      getMetricMultiDimension(
        client,
        dimensions,
        "SearchLatency",
        ["Average"],
        startTime,
        endTime,
        period,
        "AWS/ES"
      ),
    ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const max = (arr: number[]) => (arr.length ? Math.max(...arr) : null);
  const min = (arr: number[]) => (arr.length ? Math.min(...arr) : null);

  return {
    cpuUtilizationAvg: avg(
      cpuDp.filter((d) => d.Average != null).map((d) => d.Average!)
    ),
    cpuUtilizationMax: max(
      cpuDp.filter((d) => d.Maximum != null).map((d) => d.Maximum!)
    ),
    jvmMemoryPressureAvg: avg(
      jvmDp.filter((d) => d.Average != null).map((d) => d.Average!)
    ),
    jvmMemoryPressureMax: max(
      jvmDp.filter((d) => d.Maximum != null).map((d) => d.Maximum!)
    ),
    freeStorageSpaceAvg: avg(
      storageDp.filter((d) => d.Average != null).map((d) => d.Average!)
    ),
    freeStorageSpaceMin: min(
      storageDp.filter((d) => d.Minimum != null).map((d) => d.Minimum!)
    ),
    searchRateAvg: avg(
      searchDp.filter((d) => d.Average != null).map((d) => d.Average!)
    ),
    indexingRateAvg: avg(
      indexDp.filter((d) => d.Average != null).map((d) => d.Average!)
    ),
    searchLatencyAvg: avg(
      latencyDp.filter((d) => d.Average != null).map((d) => d.Average!)
    ),
  };
}

// ─── Estimate cost from instance type + EBS ──────────────────────────────────

function estimateDomainMonthlyCost(domain: OpenSearchDomainData): number {
  // Instance cost
  const hourlyRate = OS_INSTANCE_PRICING[domain.instanceType] || 0;
  const instanceCost = hourlyRate * 730 * domain.instanceCount;

  // Dedicated master cost
  let masterCost = 0;
  if (domain.dedicatedMasterEnabled && domain.dedicatedMasterType) {
    const masterRate =
      OS_INSTANCE_PRICING[domain.dedicatedMasterType] || 0;
    masterCost = masterRate * 730 * domain.dedicatedMasterCount;
  }

  // UltraWarm cost (approximate)
  let warmCost = 0;
  if (domain.warmEnabled && domain.warmType) {
    const warmRate = OS_INSTANCE_PRICING[domain.warmType] || 0;
    warmCost = warmRate * 730 * domain.warmCount;
  }

  // EBS cost
  let ebsCost = 0;
  if (domain.ebsEnabled) {
    const gbRate =
      domain.ebsVolumeType === "gp3"
        ? GP3_PER_GB_MONTH
        : domain.ebsVolumeType === "io1"
          ? IO1_PER_GB_MONTH
          : GP2_PER_GB_MONTH;
    ebsCost = gbRate * domain.ebsVolumeSize * domain.instanceCount;
  }

  return instanceCost + masterCost + warmCost + ebsCost;
}

// ─── Main collector ──────────────────────────────────────────────────────────

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

  // 1. Fetch Cost Explorer data (always first — may have costs from deleted domains)
  log("Fetching OpenSearch costs from Cost Explorer...");
  let costData: OpenSearchCostData | null = null;
  try {
    costData = await Promise.race([
      getOpenSearchCosts(ceClient),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("OpenSearch CE overall timeout")),
          30000
        )
      ),
    ]);
    if (costData) {
      log(
        `Cost Explorer: $${costData.totalCost.toFixed(2)}/mo total OpenSearch spend`
      );
    }
  } catch (err: any) {
    console.warn(`OpenSearch Cost Explorer fetch failed: ${err.message}`);
    log("Cost Explorer unavailable — using estimated costs");
  }

  // 2. List all domains
  log("Discovering OpenSearch domains...");
  let domainNames: string[] = [];
  try {
    const listResp = await osClient.send(new ListDomainNamesCommand({}));
    domainNames = (listResp.DomainNames || [])
      .map((d) => d.DomainName)
      .filter((n): n is string => !!n);
  } catch (err: any) {
    console.warn(`Failed to list OpenSearch domains: ${err.message}`);
  }
  log(`Found ${domainNames.length} OpenSearch domains`);

  if (domainNames.length === 0) {
    // Still use CE cost if available
    const totalMonthlyCost = costData?.totalCost || 0;
    log(
      `OpenSearch collection complete: 0 domains, est. $${totalMonthlyCost.toFixed(2)}/mo`
    );
    return {
      accountName,
      accountId,
      region,
      domains: [],
      accountSummary: {
        totalDomains: 0,
        totalMonthlyCost,
      },
      collectedAt: new Date().toISOString(),
    };
  }

  // 3. Describe domains (batch up to 5 per API call)
  log("Fetching domain configurations...");
  const describedDomains: any[] = [];
  for (let i = 0; i < domainNames.length; i += 5) {
    const batch = domainNames.slice(i, i + 5);
    try {
      const resp = await osClient.send(
        new DescribeDomainsCommand({ DomainNames: batch })
      );
      describedDomains.push(...(resp.DomainStatusList || []));
    } catch (err: any) {
      console.warn(
        `Failed to describe OpenSearch domains [${batch.join(", ")}]: ${err.message}`
      );
    }
  }
  log(`Described ${describedDomains.length} domains`);

  // 4. Fetch tags for each domain
  log("Fetching domain tags...");
  const tagsByDomain = new Map<string, Record<string, string>>();
  for (const domain of describedDomains) {
    const arn = domain.ARN;
    if (!arn) continue;
    try {
      const tagResp = await osClient.send(
        new ListTagsCommand({ ARN: arn })
      );
      const tags: Record<string, string> = {};
      for (const tag of tagResp.TagList || []) {
        if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
      }
      tagsByDomain.set(domain.DomainName || "", tags);
    } catch (err: any) {
      console.warn(
        `Failed to list tags for ${domain.DomainName}: ${err.message}`
      );
    }
  }

  // 5. Collect CloudWatch metrics (batched)
  log(`Collecting metrics for ${describedDomains.length} domains...`);
  const domains: OpenSearchDomainData[] = [];
  const metricBatchSize = 5;

  for (let i = 0; i < describedDomains.length; i += metricBatchSize) {
    const batch = describedDomains.slice(i, i + metricBatchSize);
    if (describedDomains.length > metricBatchSize) {
      log(
        `Collecting metrics for domains ${i + 1}-${Math.min(i + metricBatchSize, describedDomains.length)}...`
      );
    }

    const batchResults = await Promise.all(
      batch.map(async (domain: any) => {
        const domainName = domain.DomainName || "";

        // Get metrics
        let metrics: OpenSearchDomainMetrics = {
          cpuUtilizationAvg: null,
          cpuUtilizationMax: null,
          jvmMemoryPressureAvg: null,
          jvmMemoryPressureMax: null,
          freeStorageSpaceAvg: null,
          freeStorageSpaceMin: null,
          searchRateAvg: null,
          indexingRateAvg: null,
          searchLatencyAvg: null,
        };
        try {
          metrics = await getDomainMetrics(cwClient, domainName, accountId);
        } catch (err: any) {
          console.warn(
            `Failed to get metrics for ${domainName}: ${err.message}`
          );
        }

        // Parse domain config
        const clusterConfig = domain.ClusterConfig || {};
        const ebsOptions = domain.EBSOptions || {};
        const encryptionConfig = domain.EncryptionAtRestOptions || {};
        const nodeToNode = domain.NodeToNodeEncryptionOptions || {};
        const autoTune = domain.AutoTuneOptions || {};
        const zoneConfig = clusterConfig.ZoneAwarenessConfig || {};

        const domainData: OpenSearchDomainData = {
          domainName,
          domainArn: domain.ARN || "",
          engineVersion: domain.EngineVersion || "unknown",
          instanceType: clusterConfig.InstanceType || "unknown",
          instanceCount: clusterConfig.InstanceCount || 1,
          dedicatedMasterEnabled:
            clusterConfig.DedicatedMasterEnabled || false,
          dedicatedMasterType:
            clusterConfig.DedicatedMasterType || null,
          dedicatedMasterCount:
            clusterConfig.DedicatedMasterCount || 0,
          warmEnabled: clusterConfig.WarmEnabled || false,
          warmType: clusterConfig.WarmType || null,
          warmCount: clusterConfig.WarmCount || 0,
          ebsEnabled: ebsOptions.EBSEnabled || false,
          ebsVolumeType: ebsOptions.VolumeType || null,
          ebsVolumeSize: ebsOptions.VolumeSize || 0,
          ebsIops: ebsOptions.Iops || null,
          ebsThroughput: ebsOptions.Throughput || null,
          zoneAwarenessEnabled:
            clusterConfig.ZoneAwarenessEnabled || false,
          availabilityZoneCount:
            zoneConfig.AvailabilityZoneCount || 1,
          encryptionAtRest: encryptionConfig.Enabled || false,
          nodeToNodeEncryption: nodeToNode.Enabled || false,
          autoTuneEnabled:
            autoTune.State === "ENABLED" ||
            autoTune.State === "ENABLE_IN_PROGRESS",
          createdAt: domain.Created
            ? new Date(domain.Created).toISOString()
            : "",
          tags: tagsByDomain.get(domainName) || {},
          metrics,
          currentMonthlyCost: 0,
          costIsActual: false,
        };

        // Estimate cost
        domainData.currentMonthlyCost = estimateDomainMonthlyCost(domainData);

        return domainData;
      })
    );

    domains.push(...batchResults);
  }

  // 6. Apply Cost Explorer actual costs
  if (costData && costData.totalCost > 0) {
    if (costData.costByDomain.size > 0) {
      // Per-resource costs available — assign directly
      for (const domain of domains) {
        const ceCost = costData.costByDomain.get(domain.domainName);
        if (ceCost != null && ceCost > 0) {
          domain.currentMonthlyCost = ceCost;
          domain.costIsActual = true;
        }
      }
    } else {
      // Aggregate only — distribute proportionally
      const totalEstimated = domains.reduce(
        (s, d) => s + d.currentMonthlyCost,
        0
      );
      if (totalEstimated > 0) {
        for (const domain of domains) {
          if (domain.currentMonthlyCost > 0) {
            const proportion = domain.currentMonthlyCost / totalEstimated;
            domain.currentMonthlyCost = costData.totalCost * proportion;
            domain.costIsActual = true;
          }
        }
      }
    }
  }

  // 7. Build summary
  const domainCostTotal = domains.reduce(
    (s, d) => s + d.currentMonthlyCost,
    0
  );
  const totalMonthlyCost = Math.max(
    domainCostTotal,
    costData?.totalCost || 0
  );

  log(
    `OpenSearch collection complete: ${domains.length} domains, est. $${totalMonthlyCost.toFixed(2)}/mo`
  );

  return {
    accountName,
    accountId,
    region,
    domains,
    accountSummary: {
      totalDomains: domains.length,
      totalMonthlyCost,
    },
    collectedAt: new Date().toISOString(),
  };
}
