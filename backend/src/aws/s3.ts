import {
  S3Client,
  ListBucketsCommand,
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  GetBucketTaggingCommand,
  GetBucketLifecycleConfigurationCommand,
  ListMultipartUploadsCommand,
  ListBucketIntelligentTieringConfigurationsCommand,
} from "@aws-sdk/client-s3";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface S3LifecycleRule {
  id: string;
  status: string;
  hasTransitions: boolean;
  hasExpiration: boolean;
  hasNoncurrentExpiration: boolean;
}

export interface S3BucketInfo {
  bucketName: string;
  region: string;
  creationDate: string;
  tags: Record<string, string>;
  versioningEnabled: boolean;
  hasLifecyclePolicy: boolean;
  lifecycleRules: S3LifecycleRule[];
  hasIntelligentTiering: boolean;
  incompleteMultipartUploads: number;
}

// ─── Raw API helpers ─────────────────────────────────────────────────────────

export async function listBuckets(
  client: S3Client
): Promise<{ name: string; creationDate: string }[]> {
  const resp = await client.send(new ListBucketsCommand({}));
  return (resp.Buckets || []).map((b) => ({
    name: b.Name!,
    creationDate: b.CreationDate?.toISOString() ?? "",
  }));
}

export async function getBucketRegion(
  client: S3Client,
  bucketName: string
): Promise<string> {
  try {
    const resp = await client.send(
      new GetBucketLocationCommand({ Bucket: bucketName })
    );
    // AWS returns "" or null for us-east-1
    return resp.LocationConstraint || "us-east-1";
  } catch {
    return "us-east-1";
  }
}

export async function getBucketDetails(
  client: S3Client,
  bucketName: string,
  bucketRegion: string,
  creationDate: string
): Promise<S3BucketInfo> {
  // Use a region-specific client for bucket operations
  const regionalClient = new S3Client({
    region: bucketRegion,
    credentials: await client.config.credentials(),
  });

  // Gather details in parallel — each sub-call is individually try/catch'd
  const [versioning, tags, lifecycle, multipart, intelligentTiering] =
    await Promise.all([
      getVersioning(regionalClient, bucketName),
      getTags(regionalClient, bucketName),
      getLifecycle(regionalClient, bucketName),
      getIncompleteMultipartCount(regionalClient, bucketName),
      getIntelligentTiering(regionalClient, bucketName),
    ]);

  return {
    bucketName,
    region: bucketRegion,
    creationDate,
    tags,
    versioningEnabled: versioning,
    hasLifecyclePolicy: lifecycle.length > 0,
    lifecycleRules: lifecycle,
    hasIntelligentTiering: intelligentTiering,
    incompleteMultipartUploads: multipart,
  };
}

// ─── Sub-helpers ─────────────────────────────────────────────────────────────

async function getVersioning(
  client: S3Client,
  bucket: string
): Promise<boolean> {
  try {
    const resp = await client.send(
      new GetBucketVersioningCommand({ Bucket: bucket })
    );
    return resp.Status === "Enabled";
  } catch {
    return false;
  }
}

async function getTags(
  client: S3Client,
  bucket: string
): Promise<Record<string, string>> {
  try {
    const resp = await client.send(
      new GetBucketTaggingCommand({ Bucket: bucket })
    );
    const tags: Record<string, string> = {};
    for (const tag of resp.TagSet || []) {
      if (tag.Key && tag.Value !== undefined) {
        tags[tag.Key] = tag.Value;
      }
    }
    return tags;
  } catch {
    // NoSuchTagSet is expected for untagged buckets
    return {};
  }
}

async function getLifecycle(
  client: S3Client,
  bucket: string
): Promise<S3LifecycleRule[]> {
  try {
    const resp = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
    );
    return (resp.Rules || []).map((r) => ({
      id: r.ID || "",
      status: r.Status || "Unknown",
      hasTransitions: (r.Transitions?.length ?? 0) > 0,
      hasExpiration: r.Expiration != null,
      hasNoncurrentExpiration: r.NoncurrentVersionExpiration != null,
    }));
  } catch {
    // NoSuchLifecycleConfiguration is expected
    return [];
  }
}

async function getIncompleteMultipartCount(
  client: S3Client,
  bucket: string
): Promise<number> {
  try {
    const resp = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, MaxUploads: 100 })
    );
    return resp.Uploads?.length ?? 0;
  } catch {
    return 0;
  }
}

async function getIntelligentTiering(
  client: S3Client,
  bucket: string
): Promise<boolean> {
  try {
    const resp = await client.send(
      new ListBucketIntelligentTieringConfigurationsCommand({ Bucket: bucket })
    );
    return (resp.IntelligentTieringConfigurationList?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
