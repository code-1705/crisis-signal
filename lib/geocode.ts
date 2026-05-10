import { Incident } from "./types";

type NominatimResult = {
  lat?: string;
  lon?: string;
  display_name?: string;
  importance?: number;
};

const COUNTRY_CENTERS: Record<string, [number, number]> = {
  in: [20.5937, 78.9629],
  us: [39.8283, -98.5795],
  gb: [55.3781, -3.436],
  jp: [36.2048, 138.2529],
  ph: [12.8797, 121.774],
  sg: [1.3521, 103.8198],
  au: [-25.2744, 133.7751]
};

export async function geocodeIncidents(params: {
  incidents: Incident[];
  region: string;
  country: string;
}) {
  const cache = new Map<string, [number, number] | null>();
  const output: Incident[] = [];

  for (const incident of params.incidents) {
    const location = normalizeLocation(incident.location);
    if (!shouldGeocode(location, params.region)) {
      output.push(incident);
      continue;
    }

    const query = buildGeocodeQuery(location, params.region);
    const cacheKey = `${params.country}:${query.toLowerCase()}`;
    const point = cache.has(cacheKey)
      ? cache.get(cacheKey) ?? null
      : await geocodeLocation(query, params.country);
    cache.set(cacheKey, point);

    output.push(
      point
        ? {
            ...incident,
            latitude: point[0],
            longitude: point[1]
          }
        : incident
    );
  }

  return output;
}

export function fallbackCountryCenter(country: string): [number, number] {
  return COUNTRY_CENTERS[country.toLowerCase()] ?? COUNTRY_CENTERS.in;
}

async function geocodeLocation(query: string, country: string): Promise<[number, number] | null> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", query);

  const countryCode = country.toLowerCase();
  if (/^[a-z]{2}$/.test(countryCode)) {
    url.searchParams.set("countrycodes", countryCode);
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "CrisisSignal hackathon prototype; contact=local-demo",
        Accept: "application/json"
      }
    });
    if (!response.ok) return null;

    const results = (await response.json()) as NominatimResult[];
    const first = results[0];
    if (!first?.lat || !first.lon) return null;

    const latitude = Number(first.lat);
    const longitude = Number(first.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    return [latitude, longitude];
  } catch {
    return null;
  }
}

function normalizeLocation(location: string) {
  return location.replace(/\s+/g, " ").trim();
}

function shouldGeocode(location: string, region: string) {
  if (location.length < 3) return false;

  const normalizedLocation = location.toLowerCase();
  const normalizedRegion = region.trim().toLowerCase();

  if (normalizedLocation === normalizedRegion) return false;
  if (normalizedLocation === "unknown location") return false;
  if (normalizedLocation.includes("region-wide")) return false;
  if (normalizedLocation.includes("country-wide")) return false;
  if (normalizedLocation.includes("nationwide")) return false;

  return true;
}

function buildGeocodeQuery(location: string, region: string) {
  const normalizedLocation = location.toLowerCase();
  const normalizedRegion = region.trim().toLowerCase();
  if (normalizedLocation.includes(normalizedRegion)) return location;
  return `${location}, ${region}`;
}
