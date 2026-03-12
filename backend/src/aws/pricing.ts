import {
  PricingClient,
  GetProductsCommand,
} from "@aws-sdk/client-pricing";

// Cache pricing per session to avoid repeated API calls
const priceCache = new Map<string, number>();

export async function getOnDemandPrice(
  client: PricingClient,
  instanceType: string,
  region: string,
  platform: string = "Linux"
): Promise<number | null> {
  const cacheKey = `${instanceType}:${region}:${platform}`;
  if (priceCache.has(cacheKey)) return priceCache.get(cacheKey)!;

  // The Pricing API uses long region names
  const regionNameMap: Record<string, string> = {
    "us-east-1": "US East (N. Virginia)",
    "us-east-2": "US East (Ohio)",
    "us-west-1": "US West (N. California)",
    "us-west-2": "US West (Oregon)",
    "eu-west-1": "EU (Ireland)",
    "eu-west-2": "EU (London)",
    "eu-central-1": "EU (Frankfurt)",
    "ap-southeast-1": "Asia Pacific (Singapore)",
    "ap-southeast-2": "Asia Pacific (Sydney)",
    "ap-northeast-1": "Asia Pacific (Tokyo)",
    "ap-south-1": "Asia Pacific (Mumbai)",
    "ca-central-1": "Canada (Central)",
    "sa-east-1": "South America (Sao Paulo)",
  };

  const regionName = regionNameMap[region] || region;
  const osFilter = platform.toLowerCase().includes("windows")
    ? "Windows"
    : "Linux";

  try {
    const resp = await client.send(
      new GetProductsCommand({
        ServiceCode: "AmazonEC2",
        Filters: [
          {
            Type: "TERM_MATCH",
            Field: "instanceType",
            Value: instanceType,
          },
          {
            Type: "TERM_MATCH",
            Field: "location",
            Value: regionName,
          },
          {
            Type: "TERM_MATCH",
            Field: "operatingSystem",
            Value: osFilter,
          },
          {
            Type: "TERM_MATCH",
            Field: "tenancy",
            Value: "Shared",
          },
          {
            Type: "TERM_MATCH",
            Field: "preInstalledSw",
            Value: "NA",
          },
          {
            Type: "TERM_MATCH",
            Field: "capacitystatus",
            Value: "Used",
          },
        ],
        MaxResults: 1,
      })
    );

    if (resp.PriceList && resp.PriceList.length > 0) {
      const product = JSON.parse(resp.PriceList[0]);
      const onDemand = product.terms?.OnDemand;
      if (onDemand) {
        const termKey = Object.keys(onDemand)[0];
        const priceDimensions = onDemand[termKey].priceDimensions;
        const dimKey = Object.keys(priceDimensions)[0];
        const pricePerUnit = parseFloat(
          priceDimensions[dimKey].pricePerUnit.USD
        );
        priceCache.set(cacheKey, pricePerUnit);
        return pricePerUnit;
      }
    }
  } catch (err) {
    console.warn(`Failed to get pricing for ${instanceType}: ${err}`);
  }

  return null;
}

export function clearPriceCache() {
  priceCache.clear();
}

// ─── EBS Pricing (hardcoded, simpler than Pricing API for storage) ───

const EBS_PRICES: Record<string, number> = {
  gp2: 0.10,     // $/GB/mo
  gp3: 0.08,     // $/GB/mo (baseline 3000 IOPS, 125 MB/s)
  io1: 0.125,    // $/GB/mo + $0.065/provisioned IOPS
  io2: 0.125,    // $/GB/mo + $0.065/provisioned IOPS
  st1: 0.045,    // $/GB/mo
  sc1: 0.015,    // $/GB/mo
  standard: 0.05, // magnetic $/GB/mo
};

const EBS_IOPS_PRICE: Record<string, number> = {
  io1: 0.065,
  io2: 0.065,
};

const SNAPSHOT_PRICE = 0.05; // $/GB/mo

export function getEbsMonthlyPrice(
  volumeType: string,
  sizeGb: number,
  iops?: number | null
): number {
  const basePrice = (EBS_PRICES[volumeType] || 0.10) * sizeGb;
  const iopsPrice = iops && EBS_IOPS_PRICE[volumeType]
    ? EBS_IOPS_PRICE[volumeType] * iops
    : 0;
  return basePrice + iopsPrice;
}

export function getSnapshotMonthlyPrice(sizeGb: number): number {
  return SNAPSHOT_PRICE * sizeGb;
}

export function getGp2ToGp3Savings(sizeGb: number): number {
  // gp2 → gp3 saves $0.02/GB/mo with better baseline performance
  return (EBS_PRICES.gp2 - EBS_PRICES.gp3) * sizeGb;
}

// ─── Graviton equivalent mapping ───

const GRAVITON_MAP: Record<string, string> = {
  // M-series (general purpose)
  m5: "m7g", m5a: "m7g", m5n: "m7g", m5zn: "m7g",
  m6i: "m7g", m6a: "m7g",
  m4: "m7g",
  // C-series (compute optimized)
  c5: "c7g", c5a: "c7g", c5n: "c7g",
  c6i: "c7g", c6a: "c7g",
  c4: "c7g",
  // R-series (memory optimized)
  r5: "r7g", r5a: "r7g", r5n: "r7g",
  r6i: "r7g", r6a: "r7g",
  r4: "r7g",
  // T-series (burstable)
  t3: "t4g", t3a: "t4g",
  t2: "t4g",
  // I-series (storage optimized)
  i3: "i4g",
  // X-series (memory intensive)
  x2idn: "x2gd",
};

/**
 * Returns the Graviton equivalent family for an x86_64 instance type.
 * e.g., "m5.xlarge" → "m7g.xlarge", "c5.2xlarge" → "c7g.2xlarge"
 * Returns null if no Graviton equivalent exists.
 */
export function getGravitonEquivalent(instanceType: string): string | null {
  const match = instanceType.match(/^([a-z]+\d+[a-z]*)\.(.+)$/);
  if (!match) return null;
  const [, family, size] = match;
  const gravitonFamily = GRAVITON_MAP[family];
  if (!gravitonFamily) return null;
  return `${gravitonFamily}.${size}`;
}
