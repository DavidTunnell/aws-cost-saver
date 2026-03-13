import {
  RDSClient,
  DescribeDBInstancesCommand,
  DescribeDBClustersCommand,
  DescribeDBSnapshotsCommand,
  DescribeDBClusterSnapshotsCommand,
} from "@aws-sdk/client-rds";

export interface RDSInstanceInfo {
  dbInstanceId: string;
  dbInstanceClass: string;
  engine: string;
  engineVersion: string;
  status: string;
  multiAZ: boolean;
  storageType: string;
  allocatedStorageGb: number;
  provisionedIops: number | null;
  backupRetentionPeriod: number;
  dbClusterIdentifier: string | null;
  availabilityZone: string;
  name: string;
  tags: Record<string, string>;
  instanceCreateTime: string;
  isAurora: boolean;
  readReplicaIds: string[];
  readReplicaSourceId: string | null;
}

export interface RDSClusterInfo {
  dbClusterIdentifier: string;
  engine: string;
  engineVersion: string;
  status: string;
  members: string[];
  allocatedStorageGb: number;
  backupRetentionPeriod: number;
  multiAZ: boolean;
  tags: Record<string, string>;
}

export interface RDSSnapshotInfo {
  dbSnapshotId: string;
  dbInstanceId: string;
  snapshotType: string;
  snapshotCreateTime: string;
  allocatedStorageGb: number;
  engine: string;
}

export async function describeDBInstances(
  client: RDSClient
): Promise<RDSInstanceInfo[]> {
  const instances: RDSInstanceInfo[] = [];
  let marker: string | undefined;

  do {
    const resp = await client.send(
      new DescribeDBInstancesCommand({ Marker: marker })
    );

    for (const db of resp.DBInstances || []) {
      const tags: Record<string, string> = {};
      for (const tag of db.TagList || []) {
        if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
      }

      instances.push({
        dbInstanceId: db.DBInstanceIdentifier || "",
        dbInstanceClass: db.DBInstanceClass || "",
        engine: db.Engine || "",
        engineVersion: db.EngineVersion || "",
        status: db.DBInstanceStatus || "",
        multiAZ: db.MultiAZ || false,
        storageType: db.StorageType || "gp2",
        allocatedStorageGb: db.AllocatedStorage || 0,
        provisionedIops: db.Iops ?? null,
        backupRetentionPeriod: db.BackupRetentionPeriod || 0,
        dbClusterIdentifier: db.DBClusterIdentifier ?? null,
        availabilityZone: db.AvailabilityZone || "",
        name: db.DBInstanceIdentifier || "",
        tags,
        instanceCreateTime: db.InstanceCreateTime?.toISOString() || "",
        isAurora: (db.Engine || "").startsWith("aurora"),
        readReplicaIds: (db.ReadReplicaDBInstanceIdentifiers || []) as string[],
        readReplicaSourceId: db.ReadReplicaSourceDBInstanceIdentifier ?? null,
      });
    }

    marker = resp.Marker;
  } while (marker);

  return instances;
}

export async function describeDBClusters(
  client: RDSClient
): Promise<RDSClusterInfo[]> {
  const clusters: RDSClusterInfo[] = [];
  let marker: string | undefined;

  do {
    const resp = await client.send(
      new DescribeDBClustersCommand({ Marker: marker })
    );

    for (const cl of resp.DBClusters || []) {
      const tags: Record<string, string> = {};
      for (const tag of cl.TagList || []) {
        if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
      }

      clusters.push({
        dbClusterIdentifier: cl.DBClusterIdentifier || "",
        engine: cl.Engine || "",
        engineVersion: cl.EngineVersion || "",
        status: cl.Status || "",
        members: (cl.DBClusterMembers || []).map(
          (m) => m.DBInstanceIdentifier || ""
        ),
        allocatedStorageGb: cl.AllocatedStorage || 0,
        backupRetentionPeriod: cl.BackupRetentionPeriod || 0,
        multiAZ: cl.MultiAZ || false,
        tags,
      });
    }

    marker = resp.Marker;
  } while (marker);

  return clusters;
}

export async function describeDBSnapshots(
  client: RDSClient
): Promise<RDSSnapshotInfo[]> {
  const snapshots: RDSSnapshotInfo[] = [];
  let marker: string | undefined;

  do {
    const resp = await client.send(
      new DescribeDBSnapshotsCommand({
        SnapshotType: "manual",
        Marker: marker,
      })
    );

    for (const snap of resp.DBSnapshots || []) {
      snapshots.push({
        dbSnapshotId: snap.DBSnapshotIdentifier || "",
        dbInstanceId: snap.DBInstanceIdentifier || "",
        snapshotType: snap.SnapshotType || "manual",
        snapshotCreateTime: snap.SnapshotCreateTime?.toISOString() || "",
        allocatedStorageGb: snap.AllocatedStorage || 0,
        engine: snap.Engine || "",
      });
    }

    marker = resp.Marker;
  } while (marker);

  return snapshots;
}

// ─── Cluster Snapshots ──────────────────────────────────────────────────────

export interface RDSClusterSnapshotInfo {
  dbClusterSnapshotId: string;
  dbClusterIdentifier: string;
  snapshotType: string;
  snapshotCreateTime: string;
  allocatedStorageGb: number;
  engine: string;
}

export async function describeDBClusterSnapshots(
  client: RDSClient
): Promise<RDSClusterSnapshotInfo[]> {
  const snapshots: RDSClusterSnapshotInfo[] = [];
  let marker: string | undefined;

  do {
    const resp = await client.send(
      new DescribeDBClusterSnapshotsCommand({
        SnapshotType: "manual",
        Marker: marker,
      })
    );

    for (const snap of resp.DBClusterSnapshots || []) {
      snapshots.push({
        dbClusterSnapshotId: snap.DBClusterSnapshotIdentifier || "",
        dbClusterIdentifier: snap.DBClusterIdentifier || "",
        snapshotType: snap.SnapshotType || "manual",
        snapshotCreateTime: snap.SnapshotCreateTime?.toISOString() || "",
        allocatedStorageGb: snap.AllocatedStorage || 0,
        engine: snap.Engine || "",
      });
    }

    marker = resp.Marker;
  } while (marker);

  return snapshots;
}
