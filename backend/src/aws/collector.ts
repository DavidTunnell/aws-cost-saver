import { EC2Client } from "@aws-sdk/client-ec2";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { PricingClient } from "@aws-sdk/client-pricing";
import {
  describeInstances,
  describeOrphanVolumes,
  describeIdleEips,
  describeVolumeDetails,
  describeSnapshots,
  describeOwnImages,
  type EC2InstanceInfo,
  type OrphanVolume,
  type IdleEip,
  type VolumeDetail,
  type SnapshotInfo,
  type AmiInfo,
} from "./ec2";
import { getInstanceMetrics, getVolumeMetrics, type InstanceMetrics, type VolumeMetrics } from "./cloudwatch";
import { getOnDemandPrice, clearPriceCache, getEbsMonthlyPrice, getSnapshotMonthlyPrice, getGravitonEquivalent } from "./pricing";
import { getEC2CostsByType } from "./cost-explorer";

export interface AttachedVolume {
  volumeId: string;
  volumeType: string;
  sizeGb: number;
  iops: number | null;
  throughput: number | null;
  monthlyPrice: number;
  // Volume CloudWatch metrics (io1/io2 + large volumes)
  actualReadOps: number | null;
  actualWriteOps: number | null;
  actualReadBytes: number | null;
  actualWriteBytes: number | null;
  iopsWasteMonthlyCost: number | null;
}

export interface InstanceData {
  instanceId: string;
  instanceType: string;
  state: string;
  name: string;
  launchTime: string;
  platform: string;
  availabilityZone: string;
  architecture: string;
  imageId: string;
  tags: Record<string, string>;
  // CloudWatch metrics
  cpuAvg: number | null;
  cpuMax: number | null;
  networkInAvg: number | null;
  networkOutAvg: number | null;
  networkInMax: number | null;
  networkOutMax: number | null;
  diskReadOps: number | null;
  diskWriteOps: number | null;
  cpuCreditBalance: number | null;
  ebsReadBandwidth: number | null;
  ebsWriteBandwidth: number | null;
  // Pricing
  onDemandHourly: number | null;
  monthlyEstimate: number | null;
  actualMonthlyCost: number | null;
  // Graviton migration
  gravitonEquivalent: string | null;
  gravitonHourlyPrice: number | null;
  // Attached EBS volumes
  attachedVolumes: AttachedVolume[];
  ebsMonthlyCost: number;
}

export interface EnrichedSnapshot extends SnapshotInfo {
  sourceVolumeExists: boolean;
  usedByAmi: string | null;
  monthlyCost: number;
}

export interface AccountSummary {
  totalInstances: number;
  runningInstances: number;
  stoppedInstances: number;
  totalMonthlySpend: number;
}

export interface CollectedData {
  accountName: string;
  accountId: string;
  region: string;
  instances: InstanceData[];
  orphanVolumes: OrphanVolume[];
  idleEips: IdleEip[];
  snapshots: EnrichedSnapshot[];
  amis: AmiInfo[];
  accountSummary: AccountSummary;
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

  log("Checking for old EBS snapshots...");
  const rawSnapshots = await describeSnapshots(ec2);
  log(`Found ${rawSnapshots.length} snapshots older than 30 days`);

  log("Scanning AMIs...");
  const amis = await describeOwnImages(ec2);
  const usedAmiIds = new Set(instances.map((i) => i.imageId).filter(Boolean));
  log(`Found ${amis.length} AMIs (${amis.filter((a) => !usedAmiIds.has(a.imageId)).length} unused)`);

  // Build snapshot→AMI lookup
  const snapshotToAmi = new Map<string, string>();
  for (const ami of amis) {
    for (const snapId of ami.snapshotIds) {
      snapshotToAmi.set(snapId, ami.imageId);
    }
  }

  // Collect all attached volume IDs for bulk describe
  const allVolumeIds = new Set<string>();
  for (const inst of instances) {
    for (const volId of inst.attachedVolumeIds) {
      allVolumeIds.add(volId);
    }
  }

  log(`Fetching details for ${allVolumeIds.size} attached volumes...`);
  const volumeDetails = await describeVolumeDetails(ec2, [...allVolumeIds]);
  const volumeMap = new Map<string, VolumeDetail>();
  for (const vol of volumeDetails) {
    volumeMap.set(vol.volumeId, vol);
  }

  // Fetch CloudWatch metrics for io1/io2 volumes and large volumes (>100GB)
  const volumesNeedingMetrics: string[] = [];
  for (const vol of volumeDetails) {
    if (vol.volumeType === "io1" || vol.volumeType === "io2" || vol.sizeGb > 100) {
      volumesNeedingMetrics.push(vol.volumeId);
    }
  }

  const volMetricsMap = new Map<string, VolumeMetrics>();
  if (volumesNeedingMetrics.length > 0) {
    log(`Fetching CloudWatch metrics for ${volumesNeedingMetrics.length} io1/io2/large volumes...`);
    for (let i = 0; i < volumesNeedingMetrics.length; i += 5) {
      const batch = volumesNeedingMetrics.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(async (volId) => {
          try {
            return await getVolumeMetrics(cw, volId);
          } catch (err) {
            console.warn(`Failed to get volume metrics for ${volId}: ${err}`);
            return { volumeId: volId, readOpsAvg: null, writeOpsAvg: null, readBytesAvg: null, writeBytesAvg: null };
          }
        })
      );
      for (const vm of results) {
        volMetricsMap.set(vm.volumeId, vm);
      }
    }
  }

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
          networkInMax: null,
          networkOutMax: null,
          diskReadOps: null,
          diskWriteOps: null,
          cpuCreditBalance: null,
          ebsReadBandwidth: null,
          ebsWriteBandwidth: null,
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

        // Look up Graviton equivalent pricing for x86_64 instances
        let gravitonEquivalent: string | null = null;
        let gravitonHourlyPrice: number | null = null;
        if (inst.architecture === "x86_64") {
          gravitonEquivalent = getGravitonEquivalent(inst.instanceType);
          if (gravitonEquivalent) {
            try {
              gravitonHourlyPrice = await getOnDemandPrice(
                pricing,
                gravitonEquivalent,
                region,
                inst.platform
              );
            } catch (err) {
              console.warn(
                `Failed to get Graviton pricing for ${gravitonEquivalent}: ${err}`
              );
            }
          }
        }

        // Use cost-by-type as a rough per-instance estimate
        const typeCost = costByType.get(inst.instanceType) ?? null;
        const actualMonthlyCost = typeCost;

        // Map attached volumes with pricing and metrics
        const attachedVolumes: AttachedVolume[] = inst.attachedVolumeIds
          .map((volId) => {
            const detail = volumeMap.get(volId);
            if (!detail) return null;

            const vm = volMetricsMap.get(volId);
            const actualReadOps = vm?.readOpsAvg ?? null;
            const actualWriteOps = vm?.writeOpsAvg ?? null;

            // Compute IOPS waste for io1/io2
            let iopsWasteMonthlyCost: number | null = null;
            if ((detail.volumeType === "io1" || detail.volumeType === "io2") && detail.iops && actualReadOps != null && actualWriteOps != null) {
              const actualIops = actualReadOps + actualWriteOps;
              // Wasted = provisioned IOPS beyond what's actually used (floor at gp3 baseline of 3000)
              const wastedIops = Math.max(0, detail.iops - Math.max(actualIops, 3000));
              iopsWasteMonthlyCost = wastedIops * 0.065;
            }

            return {
              volumeId: detail.volumeId,
              volumeType: detail.volumeType,
              sizeGb: detail.sizeGb,
              iops: detail.iops,
              throughput: detail.throughput,
              monthlyPrice: getEbsMonthlyPrice(detail.volumeType, detail.sizeGb, detail.iops),
              actualReadOps,
              actualWriteOps,
              actualReadBytes: vm?.readBytesAvg ?? null,
              actualWriteBytes: vm?.writeBytesAvg ?? null,
              iopsWasteMonthlyCost,
            };
          })
          .filter((v): v is AttachedVolume => v !== null);

        const ebsMonthlyCost = attachedVolumes.reduce((sum, v) => sum + v.monthlyPrice, 0);

        return {
          instanceId: inst.instanceId,
          instanceType: inst.instanceType,
          state: inst.state,
          name: inst.name,
          launchTime: inst.launchTime,
          platform: inst.platform,
          availabilityZone: inst.availabilityZone,
          architecture: inst.architecture,
          imageId: inst.imageId,
          tags: inst.tags,
          ...metrics,
          onDemandHourly,
          monthlyEstimate,
          actualMonthlyCost,
          gravitonEquivalent,
          gravitonHourlyPrice,
          attachedVolumes,
          ebsMonthlyCost,
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

  // Enrich snapshots with orphan/AMI status
  const existingVolumeIds = new Set<string>();
  for (const inst of instanceDataList) {
    for (const vol of inst.attachedVolumes) {
      existingVolumeIds.add(vol.volumeId);
    }
  }
  for (const vol of orphanVolumes) {
    existingVolumeIds.add(vol.volumeId);
  }

  const snapshots: EnrichedSnapshot[] = rawSnapshots.map((snap) => ({
    ...snap,
    sourceVolumeExists: !!snap.volumeId && existingVolumeIds.has(snap.volumeId),
    usedByAmi: snapshotToAmi.get(snap.snapshotId) ?? null,
    monthlyCost: getSnapshotMonthlyPrice(snap.volumeSizeGb),
  }));

  const accountSummary: AccountSummary = {
    totalInstances: instanceDataList.length,
    runningInstances: instanceDataList.filter((i) => i.state === "running").length,
    stoppedInstances: instanceDataList.filter((i) => i.state === "stopped").length,
    totalMonthlySpend: totalEC2Cost,
  };

  return {
    accountName,
    accountId,
    region,
    instances: instanceDataList,
    orphanVolumes,
    idleEips,
    snapshots,
    amis,
    accountSummary,
    collectedAt: new Date().toISOString(),
  };
}
