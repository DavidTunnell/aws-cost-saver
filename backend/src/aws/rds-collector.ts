import { RDSClient } from "@aws-sdk/client-rds";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { PricingClient } from "@aws-sdk/client-pricing";
import { getMetric } from "./cloudwatch";
import {
  describeDBInstances,
  describeDBClusters,
  describeDBSnapshots,
  describeDBClusterSnapshots,
  type RDSInstanceInfo,
  type RDSClusterInfo,
  type RDSSnapshotInfo,
  type RDSClusterSnapshotInfo,
} from "./rds";
import {
  getRDSOnDemandPrice,
  getRDSStorageMonthlyPrice,
  clearRDSPriceCache,
} from "./rds-pricing";
import { getRDSSnapshotCosts, type RDSSnapshotCostData } from "./cost-explorer";

// ─── Enriched data interfaces ───────────────────────────────────────────────

export interface RDSInstanceData extends RDSInstanceInfo {
  // CloudWatch metrics
  cpuAvg: number | null;
  cpuMax: number | null;
  freeableMemoryAvg: number | null;
  freeableMemoryMin: number | null;
  databaseConnectionsAvg: number | null;
  databaseConnectionsMax: number | null;
  readIOPSAvg: number | null;
  writeIOPSAvg: number | null;
  freeStorageSpaceAvg: number | null;
  freeStorageSpaceMin: number | null;
  networkReceiveAvg: number | null;
  networkTransmitAvg: number | null;
  // Pricing
  onDemandHourly: number | null;
  monthlyEstimate: number | null;
  storageMonthlyPrice: number;
  totalMonthlyEstimate: number;
  // Aurora cluster storage (cluster-level, shared across members)
  clusterStorageCostMonthly: number | null;
  clusterStorageGb: number | null;
  clusterMemberCount: number | null;
}

export interface EnrichedRDSSnapshot extends RDSSnapshotInfo {
  monthlyCost: number;
  costIsActual: boolean;
}

export interface EnrichedRDSClusterSnapshot extends RDSClusterSnapshotInfo {
  monthlyCost: number;
  costIsActual: boolean;
}

export interface RDSCollectedData {
  accountName: string;
  accountId: string;
  region: string;
  instances: RDSInstanceData[];
  clusters: RDSClusterInfo[];
  manualSnapshots: EnrichedRDSSnapshot[];
  clusterSnapshots: EnrichedRDSClusterSnapshot[];
  snapshotCostData: RDSSnapshotCostData | null;
  accountSummary: {
    totalInstances: number;
    availableInstances: number;
    stoppedInstances: number;
    totalMonthlySpend: number;
  };
  collectedAt: string;
}

// ─── Metric collection helper ───────────────────────────────────────────────

async function getRDSInstanceMetrics(
  client: CloudWatchClient,
  dbInstanceId: string,
  days: number = 14
) {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600;

  const [cpuDp, memDp, connDp, readIopsDp, writeIopsDp, freeStorageDp, netRxDp, netTxDp] =
    await Promise.all([
      getMetric(client, "DBInstanceIdentifier", dbInstanceId, "CPUUtilization", ["Average", "Maximum"], startTime, endTime, period, "AWS/RDS"),
      getMetric(client, "DBInstanceIdentifier", dbInstanceId, "FreeableMemory", ["Average", "Minimum"], startTime, endTime, period, "AWS/RDS"),
      getMetric(client, "DBInstanceIdentifier", dbInstanceId, "DatabaseConnections", ["Average", "Maximum"], startTime, endTime, period, "AWS/RDS"),
      getMetric(client, "DBInstanceIdentifier", dbInstanceId, "ReadIOPS", ["Average"], startTime, endTime, period, "AWS/RDS"),
      getMetric(client, "DBInstanceIdentifier", dbInstanceId, "WriteIOPS", ["Average"], startTime, endTime, period, "AWS/RDS"),
      getMetric(client, "DBInstanceIdentifier", dbInstanceId, "FreeStorageSpace", ["Average", "Minimum"], startTime, endTime, period, "AWS/RDS"),
      getMetric(client, "DBInstanceIdentifier", dbInstanceId, "NetworkReceiveThroughput", ["Average"], startTime, endTime, period, "AWS/RDS"),
      getMetric(client, "DBInstanceIdentifier", dbInstanceId, "NetworkTransmitThroughput", ["Average"], startTime, endTime, period, "AWS/RDS"),
    ]);

  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const max = (arr: number[]) => (arr.length ? Math.max(...arr) : null);
  const min = (arr: number[]) => (arr.length ? Math.min(...arr) : null);

  return {
    cpuAvg: avg(cpuDp.map((d) => d.Average!).filter((v) => v != null)),
    cpuMax: max(cpuDp.map((d) => d.Maximum!).filter((v) => v != null)),
    freeableMemoryAvg: avg(memDp.map((d) => d.Average!).filter((v) => v != null)),
    freeableMemoryMin: min(memDp.map((d) => d.Minimum!).filter((v) => v != null)),
    databaseConnectionsAvg: avg(connDp.map((d) => d.Average!).filter((v) => v != null)),
    databaseConnectionsMax: max(connDp.map((d) => d.Maximum!).filter((v) => v != null)),
    readIOPSAvg: avg(readIopsDp.map((d) => d.Average!).filter((v) => v != null)),
    writeIOPSAvg: avg(writeIopsDp.map((d) => d.Average!).filter((v) => v != null)),
    freeStorageSpaceAvg: avg(freeStorageDp.map((d) => d.Average!).filter((v) => v != null)),
    freeStorageSpaceMin: min(freeStorageDp.map((d) => d.Minimum!).filter((v) => v != null)),
    networkReceiveAvg: avg(netRxDp.map((d) => d.Average!).filter((v) => v != null)),
    networkTransmitAvg: avg(netTxDp.map((d) => d.Average!).filter((v) => v != null)),
  };
}

// ─── Main collector ─────────────────────────────────────────────────────────

export async function collectRDSAccountData(
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string,
  accountName: string,
  accountId: string,
  onProgress?: (msg: string) => void
): Promise<RDSCollectedData> {
  const log = onProgress || (() => {});
  clearRDSPriceCache();

  const rdsClient = new RDSClient({ region, credentials });
  const cwClient = new CloudWatchClient({ region, credentials });
  const ceClient = new CostExplorerClient({ region, credentials });
  const pricingClient = new PricingClient({ region: "us-east-1", credentials });

  // 1. Discover RDS resources
  log("Discovering RDS instances...");
  const rawInstances = await describeDBInstances(rdsClient);
  log(`Found ${rawInstances.length} RDS instances`);

  log("Discovering RDS clusters...");
  const clusters = await describeDBClusters(rdsClient);
  log(`Found ${clusters.length} RDS clusters`);

  log("Discovering manual RDS snapshots...");
  const rawManualSnapshots = await describeDBSnapshots(rdsClient);
  log(`Found ${rawManualSnapshots.length} manual snapshots`);

  log("Discovering manual Aurora cluster snapshots...");
  const rawClusterSnapshots = await describeDBClusterSnapshots(rdsClient);
  log(`Found ${rawClusterSnapshots.length} manual cluster snapshots`);

  // 1b. Fetch actual RDS backup costs from Cost Explorer
  log("Fetching RDS backup costs from Cost Explorer...");
  let snapshotCostData: RDSSnapshotCostData | null = null;
  try {
    snapshotCostData = await getRDSSnapshotCosts(ceClient);
    if (snapshotCostData) {
      log(`Cost Explorer: $${snapshotCostData.totalSnapshotCost.toFixed(2)}/mo RDS backup cost, ${snapshotCostData.costBySnapshot.size} per-resource entries`);
    } else {
      log("Cost Explorer returned no RDS backup data — will use estimated costs");
    }
  } catch (err: any) {
    console.warn(`Failed to fetch RDS backup costs from CE: ${err.message}`);
  }

  // Compute effective rate for proportional distribution when per-resource data isn't available
  const allSnapshotGb = rawManualSnapshots.reduce((sum, s) => sum + s.allocatedStorageGb, 0)
    + rawClusterSnapshots.reduce((sum, s) => sum + s.allocatedStorageGb, 0);
  const effectiveBackupRate = (snapshotCostData && allSnapshotGb > 0)
    ? snapshotCostData.totalSnapshotCost / allSnapshotGb
    : null;

  // Enrich manual snapshots with actual or estimated costs
  const manualSnapshots: EnrichedRDSSnapshot[] = rawManualSnapshots.map((snap) => {
    let monthlyCost: number;
    let costIsActual = false;

    if (snapshotCostData?.hasResourceData && snapshotCostData.costBySnapshot.has(snap.dbSnapshotId)) {
      monthlyCost = snapshotCostData.costBySnapshot.get(snap.dbSnapshotId)!;
      costIsActual = true;
    } else if (effectiveBackupRate !== null) {
      monthlyCost = effectiveBackupRate * snap.allocatedStorageGb;
      costIsActual = true;
    } else {
      monthlyCost = snap.allocatedStorageGb * 0.095; // fallback hardcoded rate
    }

    return { ...snap, monthlyCost, costIsActual };
  });

  // Enrich cluster snapshots with actual or estimated costs
  const clusterSnapshots: EnrichedRDSClusterSnapshot[] = rawClusterSnapshots.map((snap) => {
    let monthlyCost: number;
    let costIsActual = false;

    if (snapshotCostData?.hasResourceData && snapshotCostData.costBySnapshot.has(snap.dbClusterSnapshotId)) {
      monthlyCost = snapshotCostData.costBySnapshot.get(snap.dbClusterSnapshotId)!;
      costIsActual = true;
    } else if (effectiveBackupRate !== null) {
      monthlyCost = effectiveBackupRate * snap.allocatedStorageGb;
      costIsActual = true;
    } else {
      monthlyCost = snap.allocatedStorageGb * 0.095; // fallback hardcoded rate
    }

    return { ...snap, monthlyCost, costIsActual };
  });

  // 2. Enrich each instance with metrics and pricing
  const instances: RDSInstanceData[] = [];

  for (let i = 0; i < rawInstances.length; i++) {
    const inst = rawInstances[i];
    log(`Collecting metrics for ${inst.dbInstanceId} (${i + 1}/${rawInstances.length})...`);

    // CloudWatch metrics (only for available/running instances)
    let metrics = {
      cpuAvg: null as number | null,
      cpuMax: null as number | null,
      freeableMemoryAvg: null as number | null,
      freeableMemoryMin: null as number | null,
      databaseConnectionsAvg: null as number | null,
      databaseConnectionsMax: null as number | null,
      readIOPSAvg: null as number | null,
      writeIOPSAvg: null as number | null,
      freeStorageSpaceAvg: null as number | null,
      freeStorageSpaceMin: null as number | null,
      networkReceiveAvg: null as number | null,
      networkTransmitAvg: null as number | null,
    };

    if (inst.status === "available") {
      try {
        metrics = await getRDSInstanceMetrics(cwClient, inst.dbInstanceId);
      } catch (err: any) {
        console.warn(`Failed to get metrics for ${inst.dbInstanceId}: ${err.message}`);
      }
    }

    // Pricing
    let onDemandHourly: number | null = null;
    try {
      onDemandHourly = await getRDSOnDemandPrice(
        pricingClient,
        inst.dbInstanceClass,
        region,
        inst.engine,
        inst.multiAZ
      );
    } catch (err: any) {
      console.warn(`Failed to get pricing for ${inst.dbInstanceClass}: ${err.message}`);
    }

    if (!onDemandHourly) {
      console.warn(`[RDS Collector] No pricing data for ${inst.dbInstanceId} (${inst.dbInstanceClass}, ${inst.engine}) — cost will be $0`);
    }

    const monthlyEstimate = onDemandHourly ? onDemandHourly * 730 : null;

    // Aurora storage is billed at the cluster level, not per-instance.
    // Setting per-instance storage to $0 prevents double-counting across cluster members.
    const storageMonthlyPrice = inst.isAurora ? 0 : getRDSStorageMonthlyPrice(
      inst.storageType,
      inst.allocatedStorageGb,
      inst.provisionedIops
    );
    const totalMonthlyEstimate = (monthlyEstimate ?? 0) + storageMonthlyPrice;

    instances.push({
      ...inst,
      ...metrics,
      onDemandHourly,
      monthlyEstimate,
      storageMonthlyPrice,
      totalMonthlyEstimate,
      clusterStorageCostMonthly: null,
      clusterStorageGb: null,
      clusterMemberCount: null,
    });
  }

  // 2b. Enrich Aurora instances with cluster-level storage cost
  const AURORA_STORAGE_PRICE_PER_GB = 0.10; // Aurora Standard storage rate
  for (const cluster of clusters) {
    const storageCost = cluster.allocatedStorageGb * AURORA_STORAGE_PRICE_PER_GB;
    for (const inst of instances) {
      if (inst.dbClusterIdentifier === cluster.dbClusterIdentifier) {
        inst.clusterStorageCostMonthly = storageCost;
        inst.clusterStorageGb = cluster.allocatedStorageGb;
        inst.clusterMemberCount = cluster.members.length;
      }
    }
  }

  // 3. Build summary
  const availableInstances = instances.filter((i) => i.status === "available");
  const stoppedInstances = instances.filter((i) => i.status === "stopped");
  const totalMonthlySpend = instances.reduce((sum, i) => sum + i.totalMonthlyEstimate, 0);

  log(`RDS collection complete: ${instances.length} instances, est. $${totalMonthlySpend.toFixed(2)}/mo`);

  return {
    accountName,
    accountId,
    region,
    instances,
    clusters,
    manualSnapshots,
    clusterSnapshots,
    snapshotCostData,
    accountSummary: {
      totalInstances: instances.length,
      availableInstances: availableInstances.length,
      stoppedInstances: stoppedInstances.length,
      totalMonthlySpend,
    },
    collectedAt: new Date().toISOString(),
  };
}
