import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeAddressesCommand,
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
        instances.push({
          instanceId: inst.InstanceId || "",
          instanceType: inst.InstanceType || "",
          state: inst.State?.Name || "unknown",
          name: getNameTag(inst.Tags),
          launchTime: inst.LaunchTime?.toISOString() || "",
          platform: inst.PlatformDetails || "Linux/UNIX",
          availabilityZone: inst.Placement?.AvailabilityZone || "",
          tags: tagsToRecord(inst.Tags),
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
