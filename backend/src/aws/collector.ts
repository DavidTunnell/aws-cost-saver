import { EC2Client } from "@aws-sdk/client-ec2";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { PricingClient } from "@aws-sdk/client-pricing";
import {
  describeInstances,
  describeOrphanVolumes,
  describeIdleEips,
  type EC2InstanceInfo,
  type OrphanVolume,
  type IdleEip,
} from "./ec2";
import { getInstanceMetrics, type InstanceMetrics } from "./cloudwatch";
import { getOnDemandPrice, clearPriceCache } from "./pricing";
import { getEC2CostsByType } from "./cost-explorer";

export interface InstanceData {
  instanceId: string;
  instanceType: string;
  state: string;
  name: string;
  launchTime: string;
  platform: string;
  availabilityZone: string;
  cpuAvg: number | null;
  cpuMax: number | null;
  networkInAvg: number | null;
  networkOutAvg: number | null;
  onDemandHourly: number | null;
  monthlyEstimate: number | null;
  actualMonthlyCost: number | null;
}

export interface CollectedData {
  accountName: string;
  accountId: string;
  region: string;
  instances: InstanceData[];
  orphanVolumes: OrphanVolume[];
  idleEips: IdleEip[];
  collectedAt: string;
}

export async function collectAccountData(
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string,
  accountName: string,
  accountId: string,
  onProgress?: (msg: string) => void
): Promise<CollectedData> {
  const log = onProgress || console.log;

  const ec2 = new EC2Client({ region, credentials });
  const cw = new CloudWatchClient({ region, credentials });
  // Pricing API is only available in us-east-1 and ap-south-1
  const pricing = new PricingClient({
    region: "us-east-1",
    credentials,
  });
  const costExplorer = new CostExplorerClient({ region, credentials });

  clearPriceCache();

  log("Discovering EC2 instances...");
  const instances = await describeInstances(ec2);
  log(`Found ${instances.length} instances`);

  log("Checking for orphan EBS volumes...");
  const orphanVolumes = await describeOrphanVolumes(ec2);
  log(`Found ${orphanVolumes.length} unattached volumes`);

  log("Checking for idle Elastic IPs...");
  const idleEips = await describeIdleEips(ec2);
  log(`Found ${idleEips.length} idle EIPs`);

  log("Fetching Cost Explorer data...");
  const { costByType, totalEC2Cost } = await getEC2CostsByType(costExplorer);
  if (totalEC2Cost > 0) {
    log(`Total EC2 spend (last 30d): $${totalEC2Cost.toFixed(2)}`);
  }

  const runningInstances = instances.filter((i) => i.state === "running");
  log(
    `Collecting metrics for ${runningInstances.length} running instances...`
  );

  const instanceDataList: InstanceData[] = [];

  // Process instances in batches of 5 to avoid rate limiting
  for (let i = 0; i < instances.length; i += 5) {
    const batch = instances.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (inst) => {
        let metrics: InstanceMetrics = {
          cpuAvg: null,
          cpuMax: null,
          networkInAvg: null,
          networkOutAvg: null,
        };

        if (inst.state === "running") {
          try {
            metrics = await getInstanceMetrics(cw, inst.instanceId);
          } catch (err) {
            console.warn(
              `Failed to get metrics for ${inst.instanceId}: ${err}`
            );
          }
        }

        let onDemandHourly: number | null = null;
        try {
          onDemandHourly = await getOnDemandPrice(
            pricing,
            inst.instanceType,
            region,
            inst.platform
          );
        } catch (err) {
          console.warn(
            `Failed to get pricing for ${inst.instanceType}: ${err}`
          );
        }

        const monthlyEstimate = onDemandHourly
          ? onDemandHourly * 730 // avg hours/month
          : null;

        // Use cost-by-type as a rough per-instance estimate
        const typeCost = costByType.get(inst.instanceType) ?? null;
        const actualMonthlyCost = typeCost;

        return {
          instanceId: inst.instanceId,
          instanceType: inst.instanceType,
          state: inst.state,
          name: inst.name,
          launchTime: inst.launchTime,
          platform: inst.platform,
          availabilityZone: inst.availabilityZone,
          ...metrics,
          onDemandHourly,
          monthlyEstimate,
          actualMonthlyCost,
        };
      })
    );

    instanceDataList.push(...results);
    if (i + 5 < instances.length) {
      log(
        `Processed ${Math.min(i + 5, instances.length)}/${instances.length} instances...`
      );
    }
  }

  log("Data collection complete.");

  return {
    accountName,
    accountId,
    region,
    instances: instanceDataList,
    orphanVolumes,
    idleEips,
    collectedAt: new Date().toISOString(),
  };
}
