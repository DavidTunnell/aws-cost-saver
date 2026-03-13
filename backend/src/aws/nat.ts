import {
  EC2Client,
  DescribeNatGatewaysCommand,
  DescribeVpcEndpointsCommand,
  type NatGateway,
  type VpcEndpoint,
} from "@aws-sdk/client-ec2";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface NatGatewayInfo {
  natGatewayId: string;
  vpcId: string;
  subnetId: string;
  state: string;
  availabilityZone: string;
  createTime: string;
  tags: Record<string, string>;
  publicIp: string;
  privateIp: string;
  connectivityType: string; // "public" or "private"
}

export interface VpcEndpointInfo {
  vpcEndpointId: string;
  vpcId: string;
  serviceName: string;
  endpointType: string; // "Gateway" or "Interface"
  state: string;
}

// ─── Raw API helpers ─────────────────────────────────────────────────────────

export async function listNatGateways(
  client: EC2Client
): Promise<NatGatewayInfo[]> {
  const gateways: NatGatewayInfo[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await client.send(
      new DescribeNatGatewaysCommand({ NextToken: nextToken })
    );

    for (const nat of resp.NatGateways || []) {
      const tags: Record<string, string> = {};
      for (const tag of nat.Tags || []) {
        if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
      }

      // Extract addresses
      const addr = nat.NatGatewayAddresses?.[0];

      gateways.push({
        natGatewayId: nat.NatGatewayId || "",
        vpcId: nat.VpcId || "",
        subnetId: nat.SubnetId || "",
        state: nat.State || "",
        availabilityZone: "", // Will be enriched by collector if needed
        createTime: nat.CreateTime?.toISOString() || "",
        tags,
        publicIp: addr?.PublicIp || "",
        privateIp: addr?.PrivateIp || "",
        connectivityType: nat.ConnectivityType || "public",
      });
    }

    nextToken = resp.NextToken;
  } while (nextToken);

  return gateways;
}

export async function listVpcEndpoints(
  client: EC2Client
): Promise<VpcEndpointInfo[]> {
  const endpoints: VpcEndpointInfo[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await client.send(
      new DescribeVpcEndpointsCommand({ NextToken: nextToken })
    );

    for (const ep of resp.VpcEndpoints || []) {
      endpoints.push({
        vpcEndpointId: ep.VpcEndpointId || "",
        vpcId: ep.VpcId || "",
        serviceName: ep.ServiceName || "",
        endpointType: ep.VpcEndpointType || "",
        state: ep.State || "",
      });
    }

    nextToken = resp.NextToken;
  } while (nextToken);

  return endpoints;
}
