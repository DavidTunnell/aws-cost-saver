import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";

export interface MonthlyCostPoint {
  month: string; // "YYYY-MM"
  cost: number;
  currency: string;
}

const SERVICE_MAP: Record<string, string> = {
  EC2: "Amazon Elastic Compute Cloud - Compute",
  RDS: "Amazon Relational Database Service",
  S3: "Amazon Simple Storage Service",
  Lambda: "AWS Lambda",
  DynamoDB: "Amazon DynamoDB",
  ELB: "Amazon Elastic Load Balancing",
};

export const VALID_SERVICES = Object.keys(SERVICE_MAP);

/**
 * Fetches monthly total cost from AWS Cost Explorer.
 * Optionally filters by a specific AWS service.
 */
export async function getMonthlyCostTrend(
  client: CostExplorerClient,
  months: number = 12,
  service?: string
): Promise<MonthlyCostPoint[]> {
  const now = new Date();
  const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const startDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);

  const formatDate = (d: Date) => d.toISOString().split("T")[0];

  const filter =
    service && SERVICE_MAP[service]
      ? {
          Filter: {
            Dimensions: {
              Key: "SERVICE" as const,
              Values: [SERVICE_MAP[service]],
            },
          },
        }
      : {};

  try {
    const resp = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: {
          Start: formatDate(startDate),
          End: formatDate(endDate),
        },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        ...filter,
      })
    );

    const dataPoints: MonthlyCostPoint[] = [];

    for (const result of resp.ResultsByTime || []) {
      const month = result.TimePeriod?.Start?.substring(0, 7) || "";
      const cost = parseFloat(
        result.Total?.UnblendedCost?.Amount || "0"
      );
      const currency = result.Total?.UnblendedCost?.Unit || "USD";

      if (month) {
        dataPoints.push({ month, cost, currency });
      }
    }

    return dataPoints;
  } catch (err: any) {
    console.warn(`Cost Explorer monthly trend query failed: ${err.message}`);
    return [];
  }
}
