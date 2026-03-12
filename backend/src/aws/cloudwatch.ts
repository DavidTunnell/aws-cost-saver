import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type Statistic,
} from "@aws-sdk/client-cloudwatch";

export interface InstanceMetrics {
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
}

async function getMetric(
  client: CloudWatchClient,
  dimensionName: string,
  dimensionValue: string,
  metricName: string,
  statistics: Statistic[],
  startTime: Date,
  endTime: Date,
  period: number,
  namespace: string = "AWS/EC2"
) {
  const resp = await client.send(
    new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: [{ Name: dimensionName, Value: dimensionValue }],
      StartTime: startTime,
      EndTime: endTime,
      Period: period,
      Statistics: statistics,
    })
  );
  return resp.Datapoints || [];
}

export async function getInstanceMetrics(
  client: CloudWatchClient,
  instanceId: string,
  days: number = 30
): Promise<InstanceMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600; // 1-hour periods

  const [
    cpuDp,
    netInDp,
    netOutDp,
    diskReadDp,
    diskWriteDp,
    creditDp,
    ebsReadDp,
    ebsWriteDp,
  ] = await Promise.all([
    getMetric(client, "InstanceId", instanceId, "CPUUtilization", ["Average", "Maximum"], startTime, endTime, period),
    getMetric(client, "InstanceId", instanceId, "NetworkIn", ["Average", "Maximum"], startTime, endTime, period),
    getMetric(client, "InstanceId", instanceId, "NetworkOut", ["Average", "Maximum"], startTime, endTime, period),
    getMetric(client, "InstanceId", instanceId, "DiskReadOps", ["Average"], startTime, endTime, period),
    getMetric(client, "InstanceId", instanceId, "DiskWriteOps", ["Average"], startTime, endTime, period),
    getMetric(client, "InstanceId", instanceId, "CPUCreditBalance", ["Average"], startTime, endTime, period),
    getMetric(client, "InstanceId", instanceId, "EBSReadBytes", ["Average"], startTime, endTime, period),
    getMetric(client, "InstanceId", instanceId, "EBSWriteBytes", ["Average"], startTime, endTime, period),
  ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const max = (arr: number[]) =>
    arr.length ? Math.max(...arr) : null;

  return {
    cpuAvg: avg(cpuDp.map((d) => d.Average!).filter((v) => v != null)),
    cpuMax: max(cpuDp.map((d) => d.Maximum!).filter((v) => v != null)),
    networkInAvg: avg(netInDp.map((d) => d.Average!).filter((v) => v != null)),
    networkOutAvg: avg(netOutDp.map((d) => d.Average!).filter((v) => v != null)),
    networkInMax: max(netInDp.map((d) => d.Maximum!).filter((v) => v != null)),
    networkOutMax: max(netOutDp.map((d) => d.Maximum!).filter((v) => v != null)),
    diskReadOps: avg(diskReadDp.map((d) => d.Average!).filter((v) => v != null)),
    diskWriteOps: avg(diskWriteDp.map((d) => d.Average!).filter((v) => v != null)),
    cpuCreditBalance: avg(creditDp.map((d) => d.Average!).filter((v) => v != null)),
    ebsReadBandwidth: avg(ebsReadDp.map((d) => d.Average!).filter((v) => v != null)),
    ebsWriteBandwidth: avg(ebsWriteDp.map((d) => d.Average!).filter((v) => v != null)),
  };
}

export interface VolumeMetrics {
  volumeId: string;
  readOpsAvg: number | null;
  writeOpsAvg: number | null;
  readBytesAvg: number | null;
  writeBytesAvg: number | null;
}

export async function getVolumeMetrics(
  client: CloudWatchClient,
  volumeId: string,
  days: number = 14
): Promise<VolumeMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  const period = 3600;

  const [readOpsDp, writeOpsDp, readBytesDp, writeBytesDp] = await Promise.all([
    getMetric(client, "VolumeId", volumeId, "VolumeReadOps", ["Average"], startTime, endTime, period, "AWS/EBS"),
    getMetric(client, "VolumeId", volumeId, "VolumeWriteOps", ["Average"], startTime, endTime, period, "AWS/EBS"),
    getMetric(client, "VolumeId", volumeId, "VolumeReadBytes", ["Average"], startTime, endTime, period, "AWS/EBS"),
    getMetric(client, "VolumeId", volumeId, "VolumeWriteBytes", ["Average"], startTime, endTime, period, "AWS/EBS"),
  ]);

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    volumeId,
    readOpsAvg: avg(readOpsDp.map((d) => d.Average!).filter((v) => v != null)),
    writeOpsAvg: avg(writeOpsDp.map((d) => d.Average!).filter((v) => v != null)),
    readBytesAvg: avg(readBytesDp.map((d) => d.Average!).filter((v) => v != null)),
    writeBytesAvg: avg(writeBytesDp.map((d) => d.Average!).filter((v) => v != null)),
  };
}
