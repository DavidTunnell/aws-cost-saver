import {
  PricingClient,
  GetProductsCommand,
} from "@aws-sdk/client-pricing";

// ─── Price cache ────────────────────────────────────────────────────────────

const rdsPriceCache = new Map<string, number>();

export function clearRDSPriceCache(): void {
  rdsPriceCache.clear();
}

// ─── Region name mapping (same as EC2 pricing — duplicated for modularity) ──

const regionNameMap: Record<string, string> = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "eu-west-1": "EU (Ireland)",
  "eu-west-2": "EU (London)",
  "eu-west-3": "EU (Paris)",
  "eu-central-1": "EU (Frankfurt)",
  "eu-north-1": "EU (Stockholm)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-northeast-2": "Asia Pacific (Seoul)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "sa-east-1": "South America (Sao Paulo)",
  "ca-central-1": "Canada (Central)",
};

// ─── Engine name mapping for Pricing API ────────────────────────────────────

const engineNameMap: Record<string, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  mariadb: "MariaDB",
  "aurora-mysql": "Aurora MySQL",
  "aurora-postgresql": "Aurora PostgreSQL",
  "oracle-ee": "Oracle",
  "oracle-se2": "Oracle",
  "oracle-se2-cdb": "Oracle",
  "sqlserver-ee": "SQL Server",
  "sqlserver-se": "SQL Server",
  "sqlserver-ex": "SQL Server",
  "sqlserver-web": "SQL Server",
};

// ─── Storage pricing (hardcoded, us-east-1 baseline) ────────────────────────

const RDS_STORAGE_PRICES: Record<string, number> = {
  gp2: 0.115,
  gp3: 0.08,
  io1: 0.125,
  io2: 0.125,
  magnetic: 0.10,
  standard: 0.10,
};

const RDS_IOPS_PRICES: Record<string, number> = {
  io1: 0.10,
  io2: 0.10,
};

const RDS_BACKUP_PRICE_PER_GB = 0.095;

// ─── Exported functions ─────────────────────────────────────────────────────

export async function getRDSOnDemandPrice(
  client: PricingClient,
  dbInstanceClass: string,
  region: string,
  engine: string,
  multiAZ: boolean
): Promise<number | null> {
  const isAurora = engine.startsWith("aurora");
  const cacheKey = `${dbInstanceClass}:${region}:${engine}:${multiAZ}:${isAurora}`;
  if (rdsPriceCache.has(cacheKey)) return rdsPriceCache.get(cacheKey)!;

  const location = regionNameMap[region];
  if (!location) return null;

  const databaseEngine = engineNameMap[engine];
  if (!databaseEngine) return null;

  const deploymentOption = multiAZ ? "Multi-AZ" : "Single-AZ";

  // Build filters — Aurora pricing doesn't use Single-AZ/Multi-AZ deployment options
  // (Aurora handles HA at the cluster level, not per-instance)
  const filters: { Type: "TERM_MATCH"; Field: string; Value: string }[] = [
    { Type: "TERM_MATCH", Field: "instanceType", Value: dbInstanceClass },
    { Type: "TERM_MATCH", Field: "location", Value: location },
    { Type: "TERM_MATCH", Field: "databaseEngine", Value: databaseEngine },
  ];
  if (!isAurora) {
    filters.push({ Type: "TERM_MATCH", Field: "deploymentOption", Value: deploymentOption });
  }

  try {
    const resp = await client.send(
      new GetProductsCommand({
        ServiceCode: "AmazonRDS",
        Filters: filters,
      })
    );

    for (const priceStr of resp.PriceList || []) {
      const product = typeof priceStr === "string" ? JSON.parse(priceStr) : priceStr;
      const onDemand = product.terms?.OnDemand;
      if (!onDemand) continue;

      for (const term of Object.values(onDemand) as any[]) {
        for (const dim of Object.values(term.priceDimensions || {}) as any[]) {
          const price = parseFloat(dim.pricePerUnit?.USD);
          if (price > 0) {
            rdsPriceCache.set(cacheKey, price);
            return price;
          }
        }
      }
    }
  } catch (err: any) {
    console.warn(`RDS pricing lookup failed for ${dbInstanceClass}: ${err.message}`);
  }

  return null;
}

export function getRDSStorageMonthlyPrice(
  storageType: string,
  sizeGb: number,
  iops: number | null
): number {
  const pricePerGb = RDS_STORAGE_PRICES[storageType] ?? RDS_STORAGE_PRICES["gp2"];
  let cost = pricePerGb * sizeGb;

  // Add IOPS cost for io1/io2
  if (iops && RDS_IOPS_PRICES[storageType]) {
    cost += RDS_IOPS_PRICES[storageType] * iops;
  }

  return cost;
}

export function getRDSGp2ToGp3Savings(sizeGb: number): number {
  const gp2Cost = RDS_STORAGE_PRICES["gp2"] * sizeGb;
  const gp3Cost = RDS_STORAGE_PRICES["gp3"] * sizeGb;
  return gp2Cost - gp3Cost;
}

/**
 * Estimates extra backup storage cost beyond the free tier.
 * Free tier = 100% of allocated storage for each DB instance.
 * Only charged for manual snapshots and automated backups beyond that.
 */
export function getRDSBackupExtraCost(
  totalSnapshotStorageGb: number,
  allocatedStorageGb: number
): number {
  const chargeableGb = Math.max(0, totalSnapshotStorageGb - allocatedStorageGb);
  return chargeableGb * RDS_BACKUP_PRICE_PER_GB;
}
