import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  DescribeTagsCommand as DescribeTagsV2Command,
  type LoadBalancer,
  type TargetGroup,
  type TargetHealthDescription,
} from "@aws-sdk/client-elastic-load-balancing-v2";

import {
  ElasticLoadBalancingClient,
  DescribeLoadBalancersCommand as DescribeClassicLBsCommand,
  DescribeInstanceHealthCommand,
  DescribeTagsCommand as DescribeTagsClassicCommand,
  type LoadBalancerDescription,
} from "@aws-sdk/client-elastic-load-balancing";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface ELBv2Info {
  arn: string;
  name: string;
  type: "application" | "network" | "gateway";
  scheme: string; // "internet-facing" | "internal"
  vpcId: string;
  state: string;
  availabilityZones: string[];
  createdTime: string;
  tags: Record<string, string>;
}

export interface TargetGroupInfo {
  arn: string;
  name: string;
  protocol: string;
  port: number;
  targetType: string; // "instance" | "ip" | "lambda" | "alb"
  loadBalancerArns: string[];
  healthyCount: number;
  unhealthyCount: number;
  totalTargets: number;
}

export interface CLBInfo {
  name: string;
  dnsName: string;
  vpcId: string;
  scheme: string;
  availabilityZones: string[];
  listenerCount: number;
  instanceCount: number;
  healthyCount: number;
  unhealthyCount: number;
  createdTime: string;
  tags: Record<string, string>;
}

// ─── ELBv2 helpers (ALB / NLB / GWLB) ──────────────────────────────────────

export async function listLoadBalancersV2(
  client: ElasticLoadBalancingV2Client
): Promise<ELBv2Info[]> {
  const loadBalancers: ELBv2Info[] = [];
  let marker: string | undefined;

  do {
    const resp = await client.send(
      new DescribeLoadBalancersCommand({ Marker: marker })
    );

    for (const lb of resp.LoadBalancers || []) {
      const azNames = (lb.AvailabilityZones || []).map(
        (az) => az.ZoneName || ""
      );

      loadBalancers.push({
        arn: lb.LoadBalancerArn || "",
        name: lb.LoadBalancerName || "",
        type: (lb.Type?.toLowerCase() || "application") as
          | "application"
          | "network"
          | "gateway",
        scheme: lb.Scheme || "internet-facing",
        vpcId: lb.VpcId || "",
        state: lb.State?.Code || "",
        availabilityZones: azNames.filter(Boolean),
        createdTime: lb.CreatedTime?.toISOString() || "",
        tags: {}, // populated later
      });
    }

    marker = resp.NextMarker;
  } while (marker);

  return loadBalancers;
}

export async function listTargetGroups(
  client: ElasticLoadBalancingV2Client
): Promise<TargetGroupInfo[]> {
  const targetGroups: TargetGroupInfo[] = [];
  let marker: string | undefined;

  do {
    const resp = await client.send(
      new DescribeTargetGroupsCommand({ Marker: marker })
    );

    for (const tg of resp.TargetGroups || []) {
      targetGroups.push({
        arn: tg.TargetGroupArn || "",
        name: tg.TargetGroupName || "",
        protocol: tg.Protocol || "",
        port: tg.Port || 0,
        targetType: tg.TargetType || "instance",
        loadBalancerArns: tg.LoadBalancerArns || [],
        healthyCount: 0, // populated by describeTargetHealth
        unhealthyCount: 0,
        totalTargets: 0,
      });
    }

    marker = resp.NextMarker;
  } while (marker);

  return targetGroups;
}

export async function describeTargetHealth(
  client: ElasticLoadBalancingV2Client,
  targetGroupArn: string
): Promise<TargetHealthDescription[]> {
  try {
    const resp = await client.send(
      new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn })
    );
    return resp.TargetHealthDescriptions || [];
  } catch (err: any) {
    console.warn(
      `Failed to get target health for ${targetGroupArn}: ${err.message}`
    );
    return [];
  }
}

/**
 * Fetch tags for ELBv2 resources. Batches in groups of 20 (API limit).
 * Returns a Map of ARN → tags record.
 */
export async function getLoadBalancerTagsV2(
  client: ElasticLoadBalancingV2Client,
  arns: string[]
): Promise<Map<string, Record<string, string>>> {
  const result = new Map<string, Record<string, string>>();
  const batchSize = 20;

  for (let i = 0; i < arns.length; i += batchSize) {
    const batch = arns.slice(i, i + batchSize);
    try {
      const resp = await client.send(
        new DescribeTagsV2Command({ ResourceArns: batch })
      );

      for (const desc of resp.TagDescriptions || []) {
        const tags: Record<string, string> = {};
        for (const tag of desc.Tags || []) {
          if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
        }
        if (desc.ResourceArn) {
          result.set(desc.ResourceArn, tags);
        }
      }
    } catch (err: any) {
      console.warn(`Failed to get tags for ELBv2 batch: ${err.message}`);
    }
  }

  return result;
}

// ─── Classic ELB helpers ─────────────────────────────────────────────────────

export async function listClassicLoadBalancers(
  client: ElasticLoadBalancingClient
): Promise<CLBInfo[]> {
  const loadBalancers: CLBInfo[] = [];
  let marker: string | undefined;

  do {
    const resp = await client.send(
      new DescribeClassicLBsCommand({ Marker: marker })
    );

    for (const lb of resp.LoadBalancerDescriptions || []) {
      loadBalancers.push({
        name: lb.LoadBalancerName || "",
        dnsName: lb.DNSName || "",
        vpcId: lb.VPCId || "",
        scheme: lb.Scheme || "internet-facing",
        availabilityZones: lb.AvailabilityZones || [],
        listenerCount: (lb.ListenerDescriptions || []).length,
        instanceCount: (lb.Instances || []).length,
        healthyCount: 0, // populated by describeClassicInstanceHealth
        unhealthyCount: 0,
        createdTime: lb.CreatedTime?.toISOString() || "",
        tags: {}, // populated later
      });
    }

    marker = resp.NextMarker;
  } while (marker);

  return loadBalancers;
}

export async function describeClassicInstanceHealth(
  client: ElasticLoadBalancingClient,
  loadBalancerName: string
): Promise<{ healthy: number; unhealthy: number; total: number }> {
  try {
    const resp = await client.send(
      new DescribeInstanceHealthCommand({
        LoadBalancerName: loadBalancerName,
      })
    );

    const states = resp.InstanceStates || [];
    let healthy = 0;
    let unhealthy = 0;

    for (const s of states) {
      if (s.State === "InService") healthy++;
      else unhealthy++;
    }

    return { healthy, unhealthy, total: states.length };
  } catch (err: any) {
    console.warn(
      `Failed to get instance health for CLB ${loadBalancerName}: ${err.message}`
    );
    return { healthy: 0, unhealthy: 0, total: 0 };
  }
}

/**
 * Fetch tags for Classic Load Balancers. Batches in groups of 20.
 */
export async function getClassicLoadBalancerTags(
  client: ElasticLoadBalancingClient,
  lbNames: string[]
): Promise<Map<string, Record<string, string>>> {
  const result = new Map<string, Record<string, string>>();
  const batchSize = 20;

  for (let i = 0; i < lbNames.length; i += batchSize) {
    const batch = lbNames.slice(i, i + batchSize);
    try {
      const resp = await client.send(
        new DescribeTagsClassicCommand({ LoadBalancerNames: batch })
      );

      for (const desc of resp.TagDescriptions || []) {
        const tags: Record<string, string> = {};
        for (const tag of desc.Tags || []) {
          if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
        }
        if (desc.LoadBalancerName) {
          result.set(desc.LoadBalancerName, tags);
        }
      }
    } catch (err: any) {
      console.warn(`Failed to get tags for Classic LB batch: ${err.message}`);
    }
  }

  return result;
}
