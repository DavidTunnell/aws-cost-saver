import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeAddressesCommand,
  DescribeSnapshotsCommand,
  DescribeImagesCommand,
  type Instance,
  type Volume,
  type Address,
} from "@aws-sdk/client-ec2";

export interface EC2InstanceInfo {
  instanceId: string;
  instanceType: string;
  state: string;
  name: string;
  launchTime: string;
  platform: string;
  availabilityZone: string;
  tags: Record<string, string>;
  architecture: string;
  attachedVolumeIds: string[];
  imageId: string;
}

export interface OrphanVolume {
  volumeId: string;
  size: number;
  volumeType: string;
  state: string;
  createTime: string;
}

export interface IdleEip {
  allocationId: string;
  publicIp: string;
  associationId?: string;
}

export interface VolumeDetail {
  volumeId: string;
  volumeType: string;
  sizeGb: number;
  iops: number | null;
  throughput: number | null;
}

export interface SnapshotInfo {
  snapshotId: string;
  volumeId: string;
  startTime: string;
  volumeSizeGb: number;
  description: string;
}

export interface AmiInfo {
  imageId: string;
  name: string;
  creationDate: string;
  snapshotIds: string[];
  totalSnapshotSizeGb: number;
  description: string;
}

function getNameTag(tags?: { Key?: string; Value?: string }[]): string {
  return tags?.find((t) => t.Key === "Name")?.Value || "";
}

function tagsToRecord(
  tags?: { Key?: string; Value?: string }[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of tags || []) {
    if (tag.Key && tag.Value) result[tag.Key] = tag.Value;
  }
  return result;
}

export async function describeInstances(
  client: EC2Client
): Promise<EC2InstanceInfo[]> {
  const instances: EC2InstanceInfo[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await client.send(
      new DescribeInstancesCommand({ NextToken: nextToken })
    );
    for (const reservation of resp.Reservations || []) {
      for (const inst of reservation.Instances || []) {
        const attachedVolumeIds = (inst.BlockDeviceMappings || [])
          .map((bdm) => bdm.Ebs?.VolumeId)
          .filter((id): id is string => !!id);

        instances.push({
          instanceId: inst.InstanceId || "",
          instanceType: inst.InstanceType || "",
          state: inst.State?.Name || "unknown",
          name: getNameTag(inst.Tags),
          launchTime: inst.LaunchTime?.toISOString() || "",
          platform: inst.PlatformDetails || "Linux/UNIX",
          availabilityZone: inst.Placement?.AvailabilityZone || "",
          tags: tagsToRecord(inst.Tags),
          architecture: inst.Architecture || "x86_64",
          attachedVolumeIds,
          imageId: inst.ImageId || "",
        });
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  return instances;
}

export async function describeOrphanVolumes(
  client: EC2Client
): Promise<OrphanVolume[]> {
  const volumes: OrphanVolume[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await client.send(
      new DescribeVolumesCommand({
        Filters: [{ Name: "status", Values: ["available"] }],
        NextToken: nextToken,
      })
    );
    for (const vol of resp.Volumes || []) {
      volumes.push({
        volumeId: vol.VolumeId || "",
        size: vol.Size || 0,
        volumeType: vol.VolumeType || "",
        state: vol.State || "",
        createTime: vol.CreateTime?.toISOString() || "",
      });
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  return volumes;
}

export async function describeIdleEips(
  client: EC2Client
): Promise<IdleEip[]> {
  const resp = await client.send(new DescribeAddressesCommand({}));
  return (resp.Addresses || [])
    .filter((addr) => !addr.AssociationId)
    .map((addr) => ({
      allocationId: addr.AllocationId || "",
      publicIp: addr.PublicIp || "",
    }));
}

export async function describeVolumeDetails(
  client: EC2Client,
  volumeIds: string[]
): Promise<VolumeDetail[]> {
  if (volumeIds.length === 0) return [];

  const details: VolumeDetail[] = [];

  // DescribeVolumes supports max 200 IDs per call
  for (let i = 0; i < volumeIds.length; i += 200) {
    const batch = volumeIds.slice(i, i + 200);
    const resp = await client.send(
      new DescribeVolumesCommand({ VolumeIds: batch })
    );
    for (const vol of resp.Volumes || []) {
      details.push({
        volumeId: vol.VolumeId || "",
        volumeType: vol.VolumeType || "",
        sizeGb: vol.Size || 0,
        iops: vol.Iops ?? null,
        throughput: vol.Throughput ?? null,
      });
    }
  }

  return details;
}

export async function describeSnapshots(
  client: EC2Client
): Promise<SnapshotInfo[]> {
  const snapshots: SnapshotInfo[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await client.send(
      new DescribeSnapshotsCommand({
        OwnerIds: ["self"],
        NextToken: nextToken,
      })
    );
    for (const snap of resp.Snapshots || []) {
      // Only include snapshots older than 30 days for cost relevance
      const startTime = snap.StartTime;
      if (startTime) {
        const ageMs = Date.now() - startTime.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays < 30) continue;
      }

      snapshots.push({
        snapshotId: snap.SnapshotId || "",
        volumeId: snap.VolumeId || "",
        startTime: snap.StartTime?.toISOString() || "",
        volumeSizeGb: snap.VolumeSize || 0,
        description: snap.Description || "",
      });
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  return snapshots;
}

export async function describeOwnImages(
  client: EC2Client
): Promise<AmiInfo[]> {
  const images: AmiInfo[] = [];

  const resp = await client.send(
    new DescribeImagesCommand({ Owners: ["self"] })
  );

  for (const img of resp.Images || []) {
    const snapshotIds: string[] = [];
    let totalSnapshotSizeGb = 0;

    for (const bdm of img.BlockDeviceMappings || []) {
      if (bdm.Ebs?.SnapshotId) {
        snapshotIds.push(bdm.Ebs.SnapshotId);
        totalSnapshotSizeGb += bdm.Ebs.VolumeSize || 0;
      }
    }

    images.push({
      imageId: img.ImageId || "",
      name: img.Name || "",
      creationDate: img.CreationDate || "",
      snapshotIds,
      totalSnapshotSizeGb,
      description: img.Description || "",
    });
  }

  return images;
}
