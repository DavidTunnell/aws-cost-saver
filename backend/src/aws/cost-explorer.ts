import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type ResultByTime,
} from "@aws-sdk/client-cost-explorer";

export interface InstanceTypeCost {
  instanceType: string;
  totalCost: number;
  currency: string;
}

export async function getEC2CostsByType(
  client: CostExplorerClient,
  days: number = 30
): Promise<{ costByType: Map<string, number>; totalEC2Cost: number }> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  const formatDate = (d: Date) => d.toISOString().split("T")[0];

  try {
    const resp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: {
          Start: formatDate(startDate),
          End: formatDate(endDate),
        },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [
          { Type: "DIMENSION", Key: "INSTANCE_TYPE" },
        ],
        Filter: {
          Dimensions: {
            Key: "SERVICE",
            Values: ["Amazon Elastic Compute Cloud - Compute"],
          },
        },
      })
    );

    const costByType = new Map<string, number>();
    let totalEC2Cost = 0;

    for (const result of resp.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const instType = group.Keys?.[0] || "";
        const cost = parseFloat(
          group.Metrics?.UnblendedCost?.Amount || "0"
        );
        if (instType && cost > 0) {
          costByType.set(instType, (costByType.get(instType) || 0) + cost);
          totalEC2Cost += cost;
        }
      }
    }

    return { costByType, totalEC2Cost };
  } catch (err: any) {
    console.warn(`Cost Explorer query failed: ${err.message}`);
    return { costByType: new Map(), totalEC2Cost: 0 };
  }
}
