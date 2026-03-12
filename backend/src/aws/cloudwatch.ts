import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";

export interface InstanceMetrics {
  cpuAvg: number | null;
  cpuMax: number | null;
  networkInAvg: number | null;
  networkOutAvg: number | null;
}

export async function getInstanceMetrics(
  client: CloudWatchClient,
  instanceId: string,
  days: number = 14
): Promise<InstanceMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  // Use 1-hour periods
  const period = 3600;

  const [cpuResp, netInResp, netOutResp] = await Promise.all([
    client.send(
      new GetMetricStatisticsCommand({
        Namespace: "AWS/EC2",
        MetricName: "CPUUtilization",
        Dimensions: [{ Name: "InstanceId", Value: instanceId }],
        StartTime: startTime,
        EndTime: endTime,
        Period: period,
        Statistics: ["Average", "Maximum"],
      })
    ),
    client.send(
      new GetMetricStatisticsCommand({
        Namespace: "AWS/EC2",
        MetricName: "NetworkIn",
        Dimensions: [{ Name: "InstanceId", Value: instanceId }],
        StartTime: startTime,
        EndTime: endTime,
        Period: period,
        Statistics: ["Average"],
      })
    ),
    client.send(
      new GetMetricStatisticsCommand({
        Namespace: "AWS/EC2",
        MetricName: "NetworkOut",
        Dimensions: [{ Name: "InstanceId", Value: instanceId }],
        StartTime: startTime,
        EndTime: endTime,
        Period: period,
        Statistics: ["Average"],
      })
    ),
  ]);

  const cpuDatapoints = cpuResp.Datapoints || [];
  const netInDatapoints = netInResp.Datapoints || [];
  const netOutDatapoints = netOutResp.Datapoints || [];

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const max = (arr: number[]) =>
    arr.length ? Math.max(...arr) : null;

  return {
    cpuAvg: avg(cpuDatapoints.map((d) => d.Average!).filter((v) => v != null)),
    cpuMax: max(cpuDatapoints.map((d) => d.Maximum!).filter((v) => v != null)),
    networkInAvg: avg(
      netInDatapoints.map((d) => d.Average!).filter((v) => v != null)
    ),
    networkOutAvg: avg(
      netOutDatapoints.map((d) => d.Average!).filter((v) => v != null)
    ),
  };
}
