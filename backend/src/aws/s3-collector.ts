import { S3Client } from "@aws-sdk/client-s3";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import {
  listBuckets,
  getBucketRegion,
  getBucketDetails,
  type S3BucketInfo,
} from "./s3";
import { getS3BucketCosts, type S3BucketCostData } from "./cost-explorer";

// ─── Enriched data interfaces ───────────────────────────────────────────────

export interface S3BucketData extends S3BucketInfo {
  standardStorageBytes: number | null;
  standardIAStorageBytes: number | null;
  oneZoneIAStorageBytes: number | null;
  glacierStorageBytes: number | null;
  deepArchiveStorageBytes: number | null;
  intelligentTieringStorageBytes: number | null;
  totalStorageBytes: number | null;
  numberOfObjects: number | null;
  currentMonthlyCost: number;
  costIsActual: boolean;
}

export interface S3CollectedData {
  accountName: string;
  accountId: string;
  region: string;
  buckets: S3BucketData[];
  s3CostData: S3BucketCostData | null;
  accountSummary: {
    totalBuckets: number;
    totalStorageGB: number;
    totalMonthlyCost: number;
  };
  collectedAt: string;
}

// ─── S3 pricing constants (us-east-1 standard, $/GB/mo) ────────────────────

const S3_PRICE_PER_GB: Record<string, number> = {
  StandardStorage: 0.023,
  StandardIAStorage: 0.0125,
  OneZoneIAStorage: 0.01,
  GlacierInstantRetrievalStorage: 0.004,
  GlacierStorage: 0.004,
  DeepArchiveStorage: 0.00099,
  IntelligentTieringFAStorage: 0.023, // frequent-access tier = Standard price
  IntelligentTieringIAStorage: 0.0125, // infrequent-access tier = IA price
};

// ─── CloudWatch S3 helper (two-dimension) ───────────────────────────────────

async function getS3StorageMetric(
  cwClient: CloudWatchClient,
  bucketName: string,
  storageType: string
): Promise<number | null> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days

  try {
    const resp = await cwClient.send(
      new GetMetricStatisticsCommand({
        Namespace: "AWS/S3",
        MetricName: "BucketSizeBytes",
        Dimensions: [
          { Name: "BucketName", Value: bucketName },
          { Name: "StorageType", Value: storageType },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 86400, // daily
        Statistics: ["Average"],
      })
    );

    const datapoints = resp.Datapoints || [];
    if (datapoints.length === 0) return null;

    // Take the most recent data point
    datapoints.sort(
      (a, b) =>
        (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0)
    );
    return datapoints[0].Average ?? null;
  } catch {
    return null;
  }
}

async function getS3ObjectCount(
  cwClient: CloudWatchClient,
  bucketName: string
): Promise<number | null> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 3 * 24 * 60 * 60 * 1000);

  try {
    const resp = await cwClient.send(
      new GetMetricStatisticsCommand({
        Namespace: "AWS/S3",
        MetricName: "NumberOfObjects",
        Dimensions: [
          { Name: "BucketName", Value: bucketName },
          { Name: "StorageType", Value: "AllStorageTypes" },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 86400,
        Statistics: ["Average"],
      })
    );

    const datapoints = resp.Datapoints || [];
    if (datapoints.length === 0) return null;

    datapoints.sort(
      (a, b) =>
        (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0)
    );
    return datapoints[0].Average ?? null;
  } catch {
    return null;
  }
}

// ─── Compute monthly cost from storage breakdown ────────────────────────────

function computeMonthlyCost(storageByType: Record<string, number | null>): number {
  let total = 0;
  for (const [type, bytes] of Object.entries(storageByType)) {
    if (bytes == null || bytes <= 0) continue;
    const gb = bytes / (1024 * 1024 * 1024);
    const pricePerGb = S3_PRICE_PER_GB[type] ?? 0;
    total += gb * pricePerGb;
  }
  return total;
}

// ─── Main collector ─────────────────────────────────────────────────────────

export async function collectS3AccountData(
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string,
  accountName: string,
  accountId: string,
  onProgress?: (msg: string) => void
): Promise<S3CollectedData> {
  const log = onProgress || (() => {});

  const s3Client = new S3Client({ region, credentials });
  const ceClient = new CostExplorerClient({ region, credentials });

  // 0. Fetch actual S3 costs from Cost Explorer (with overall timeout)
  log("Fetching S3 costs from Cost Explorer...");
  let s3CostData: S3BucketCostData | null = null;
  try {
    const ceTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("S3 Cost Explorer overall timeout after 30s")), 30000)
    );
    s3CostData = await Promise.race([getS3BucketCosts(ceClient), ceTimeout]);
    if (s3CostData) {
      log(
        `Cost Explorer: $${s3CostData.totalS3Cost.toFixed(2)}/mo total, ${s3CostData.costByBucket.size} buckets with per-resource data`
      );
    }
  } catch (err: any) {
    console.warn(`S3 Cost Explorer fetch failed: ${err.message}`);
    log("Cost Explorer unavailable — using estimated costs");
  }

  // 1. List all buckets
  log("Discovering S3 buckets...");
  const rawBuckets = await listBuckets(s3Client);
  log(`Found ${rawBuckets.length} S3 buckets`);

  // 2. Get region for each bucket
  log("Resolving bucket regions...");
  const bucketRegions: Record<string, string> = {};
  for (const b of rawBuckets) {
    bucketRegions[b.name] = await getBucketRegion(s3Client, b.name);
  }

  // 3. Enrich each bucket with details and metrics
  const buckets: S3BucketData[] = [];

  for (let i = 0; i < rawBuckets.length; i++) {
    const b = rawBuckets[i];
    const bucketRegion = bucketRegions[b.name];
    log(
      `Collecting details for ${b.name} (${i + 1}/${rawBuckets.length})...`
    );

    // Bucket configuration details
    let details: S3BucketInfo;
    try {
      details = await getBucketDetails(s3Client, b.name, bucketRegion, b.creationDate);
    } catch (err: any) {
      console.warn(`Failed to get details for ${b.name}: ${err.message}`);
      details = {
        bucketName: b.name,
        region: bucketRegion,
        creationDate: b.creationDate,
        tags: {},
        versioningEnabled: false,
        hasLifecyclePolicy: false,
        lifecycleRules: [],
        hasIntelligentTiering: false,
        incompleteMultipartUploads: 0,
      };
    }

    // CloudWatch storage metrics — per bucket, all storage types in parallel
    const cwClient = new CloudWatchClient({ region: bucketRegion, credentials });

    const storageTypes = [
      "StandardStorage",
      "StandardIAStorage",
      "OneZoneIAStorage",
      "GlacierStorage",
      "DeepArchiveStorage",
      "IntelligentTieringFAStorage",
      "IntelligentTieringIAStorage",
    ] as const;

    const [
      standardBytes,
      iaBytes,
      oneZoneBytes,
      glacierBytes,
      deepArchiveBytes,
      itFaBytes,
      itIaBytes,
      objectCount,
    ] = await Promise.all([
      getS3StorageMetric(cwClient, b.name, "StandardStorage"),
      getS3StorageMetric(cwClient, b.name, "StandardIAStorage"),
      getS3StorageMetric(cwClient, b.name, "OneZoneIAStorage"),
      getS3StorageMetric(cwClient, b.name, "GlacierStorage"),
      getS3StorageMetric(cwClient, b.name, "DeepArchiveStorage"),
      getS3StorageMetric(cwClient, b.name, "IntelligentTieringFAStorage"),
      getS3StorageMetric(cwClient, b.name, "IntelligentTieringIAStorage"),
      getS3ObjectCount(cwClient, b.name),
    ]);

    const itTotal =
      itFaBytes != null || itIaBytes != null
        ? (itFaBytes ?? 0) + (itIaBytes ?? 0)
        : null;

    const totalStorageBytes = [
      standardBytes,
      iaBytes,
      oneZoneBytes,
      glacierBytes,
      deepArchiveBytes,
      itFaBytes,
      itIaBytes,
    ].reduce<number | null>((sum, val) => {
      if (val == null) return sum;
      return (sum ?? 0) + val;
    }, null);

    const storageByType: Record<string, number | null> = {
      StandardStorage: standardBytes,
      StandardIAStorage: iaBytes,
      OneZoneIAStorage: oneZoneBytes,
      GlacierStorage: glacierBytes,
      DeepArchiveStorage: deepArchiveBytes,
      IntelligentTieringFAStorage: itFaBytes,
      IntelligentTieringIAStorage: itIaBytes,
    };

    const estimatedCost = computeMonthlyCost(storageByType);

    // Initial cost — will be upgraded with CE data in second pass
    buckets.push({
      ...details,
      standardStorageBytes: standardBytes,
      standardIAStorageBytes: iaBytes,
      oneZoneIAStorageBytes: oneZoneBytes,
      glacierStorageBytes: glacierBytes,
      deepArchiveStorageBytes: deepArchiveBytes,
      intelligentTieringStorageBytes: itTotal,
      totalStorageBytes,
      numberOfObjects: objectCount,
      currentMonthlyCost: estimatedCost,
      costIsActual: false,
    });
  }

  // 4. Apply Cost Explorer actual costs (second pass)
  if (s3CostData) {
    const totalEstimatedCost = buckets.reduce((s, b) => s + b.currentMonthlyCost, 0);

    for (const bucket of buckets) {
      // Tier 1: per-bucket cost from Cost Explorer
      const ceCost = s3CostData.costByBucket.get(bucket.bucketName);
      if (ceCost != null && ceCost > 0) {
        bucket.currentMonthlyCost = ceCost;
        bucket.costIsActual = true;
      } else if (s3CostData.totalS3Cost > 0 && totalEstimatedCost > 0 && bucket.currentMonthlyCost > 0) {
        // Tier 2: proportional share of aggregate CE total
        const proportion = bucket.currentMonthlyCost / totalEstimatedCost;
        bucket.currentMonthlyCost = s3CostData.totalS3Cost * proportion;
        bucket.costIsActual = true;
      }
      // Tier 3: keep hardcoded estimate (costIsActual remains false)
    }
  }

  // 5. Build summary
  const totalStorageGB = buckets.reduce((sum, b) => {
    return sum + (b.totalStorageBytes ? b.totalStorageBytes / (1024 * 1024 * 1024) : 0);
  }, 0);
  const totalMonthlyCost = buckets.reduce(
    (sum, b) => sum + b.currentMonthlyCost,
    0
  );

  log(
    `S3 collection complete: ${buckets.length} buckets, ${totalStorageGB.toFixed(1)} GB, est. $${totalMonthlyCost.toFixed(2)}/mo`
  );

  return {
    accountName,
    accountId,
    region,
    buckets,
    s3CostData,
    accountSummary: {
      totalBuckets: buckets.length,
      totalStorageGB,
      totalMonthlyCost,
    },
    collectedAt: new Date().toISOString(),
  };
}
