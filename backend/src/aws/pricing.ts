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
