import { SearchPlan, SearchResult, SourceDocument, SourceKind } from "./types";
import { loadProjectEnv } from "./env";

const ANAKIN_BASE_URL = "https://api.anakin.io/v1";

function getApiKey() {
  loadProjectEnv();
  const apiKey = process.env.ANAKIN_API_KEY;
  if (!apiKey) {
    throw new Error("ANAKIN_API_KEY is not configured");
  }
  return apiKey;
}

async function anakinFetch<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${ANAKIN_BASE_URL}${path}`, {
    ...init,
    headers: {
      "X-API-Key": getApiKey(),
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    throw new Error(
      `Anakin request failed (${response.status}): ${
        typeof payload === "string" ? payload : JSON.stringify(payload)
      }`
    );
  }

  return payload as T;
}

export async function searchWeb(prompt: string, limit: number): Promise<SearchResult[]> {
  const data = await anakinFetch<{ results?: SearchResult[] }>("/search", {
    method: "POST",
    body: JSON.stringify({ prompt, limit })
  });

  return (data.results ?? [])
    .filter((result) => result.url && result.title)
    .slice(0, limit);
}

type ScrapeSubmitResponse = {
  jobId?: string;
  job_id?: string;
  status: string;
};

type ScrapeResult = {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  url?: string;
  html?: string;
  cleanedHtml?: string;
  markdown?: string;
  generatedJson?: unknown;
  error?: string | null;
};

export async function scrapeUrl(url: string, country = "us"): Promise<ScrapeResult> {
  const submitted = await anakinFetch<ScrapeSubmitResponse>("/url-scraper", {
    method: "POST",
    body: JSON.stringify({
      url,
      country,
      useBrowser: false,
      generateJson: false
    })
  });

  const jobId = submitted.jobId ?? submitted.job_id;
  if (!jobId) {
    throw new Error("Anakin scrape did not return a job id");
  }

  return pollScrape(jobId);
}

async function pollScrape(jobId: string): Promise<ScrapeResult> {
  const deadline = Date.now() + 45000;
  let last: ScrapeResult | null = null;

  while (Date.now() < deadline) {
    const result = await anakinFetch<ScrapeResult>(`/url-scraper/${jobId}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    last = result;

    if (result.status === "completed" || result.status === "failed") {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  if (last) return last;
  throw new Error(`Timed out polling Anakin scrape job ${jobId}`);
}

export async function collectSources(params: {
  query: string;
  region: string;
  disasterType?: string;
  maxSources: number;
  country?: string;
  searchPlan?: SearchPlan;
}): Promise<SourceDocument[]> {
  const searchPrompts = buildSearchPrompts(params);
  const perSearchLimit = Math.max(4, Math.ceil((params.maxSources + 8) / searchPrompts.length));
  const searchErrors: string[] = [];
  const rawResults: SearchResult[] = [];

  for (const prompt of searchPrompts) {
    try {
      rawResults.push(...(await searchWeb(prompt, perSearchLimit)));
    } catch (error) {
      searchErrors.push(errorToMessage(error));
    }

    if (dedupeByUrl(rawResults).length >= params.maxSources + 4) {
      break;
    }

    await delay(250);
  }

  const dedupedResults = dedupeByUrl(rawResults);

  if (dedupedResults.length === 0 && searchErrors.length > 0) {
    rawResults.push(...(await fallbackSearch(params)));
  }

  const finalResults = dedupeByUrl(rawResults);

  if (finalResults.length === 0 && searchErrors.length > 0) {
    const details = uniqueStrings(searchErrors).slice(0, 3).join(" | ");
    throw new Error(`Anakin search failed: ${details}`);
  }

  const selected = rankResults(finalResults, params).slice(0, params.maxSources);

  const documents = await Promise.all(
    selected.map(async (result, index) => {
      try {
        const scraped = await scrapeUrl(result.url, params.country ?? "us");
        const content = (scraped.markdown || scraped.cleanedHtml || scraped.html || "").slice(0, 10000);
        return toSourceDocument(result, index, content, true);
      } catch {
        return toSourceDocument(result, index, result.snippet ?? "", false);
      }
    })
  );

  return documents;
}

function buildSearchPrompts(params: {
  query: string;
  region: string;
  disasterType?: string;
  searchPlan?: SearchPlan;
}) {
  const year = new Date().getUTCFullYear();
  const baseTerms = [
    params.query,
    params.region,
    params.disasterType,
    "current latest today",
    year.toString(),
    "local news official emergency update affected locations damage road hospital shelter power outage rescue"
  ]
    .filter(Boolean)
    .join(" ");

  const officialTerms = [
    params.query,
    params.region,
    "official government advisory affected districts locations cases report",
    year.toString()
  ].join(" ");

  const localTerms = [
    params.query,
    params.region,
    "local news city district state hospital eyewitness update latest",
    year.toString()
  ].join(" ");

  const outbreakTerms = [
    params.query,
    params.region,
    "cases outbreak surveillance health department hospital city state official report",
    year.toString()
  ].join(" ");

  const candidateQueries =
    params.searchPlan?.candidateLocations.slice(0, 5).map((location) =>
      [params.query, location, "official news case report affected location", year.toString()].join(" ")
    ) ?? [];

  return uniqueStrings([
    baseTerms,
    officialTerms,
    localTerms,
    outbreakTerms,
    ...(params.searchPlan?.searchQueries ?? []),
    ...candidateQueries
  ]).slice(0, 8);
}

function toSourceDocument(
  result: SearchResult,
  index: number,
  content: string,
  scraped: boolean
): SourceDocument {
  const snippet = trimText(result.snippet ?? "", 520);
  return {
    id: `source-${index + 1}`,
    kind: classifySource(result.url),
    title: trimText(result.title, 180),
    url: result.url,
    snippet,
    content: content || snippet,
    publishedAt: result.date ?? result.last_updated,
    scraped
  };
}

async function fallbackSearch(params: {
  query: string;
  region: string;
  disasterType?: string;
  maxSources: number;
  country?: string;
  searchPlan?: SearchPlan;
}) {
  const fallbackResults: SearchResult[] = [];
  const prompts = buildFallbackQueries(params).slice(0, 4);

  for (const prompt of prompts) {
    try {
      fallbackResults.push(...(await searchGoogleNewsRss(prompt, params.country ?? "us")));
    } catch {
      // Continue to source-url fallback below.
    }

    if (dedupeByUrl(fallbackResults).length >= params.maxSources + 4) {
      break;
    }
  }

  fallbackResults.push(...buildOfficialFallbackResults(params));
  return dedupeByUrl(fallbackResults).slice(0, params.maxSources + 8);
}

function buildFallbackQueries(params: {
  query: string;
  region: string;
  disasterType?: string;
  searchPlan?: SearchPlan;
}) {
  const year = new Date().getUTCFullYear();
  return uniqueStrings([
    [params.query, params.region, params.disasterType, "latest official"].filter(Boolean).join(" "),
    [params.query, params.region, "local news affected locations", year].join(" "),
    [params.query, params.region, "government health weather emergency update", year].join(" "),
    ...(params.searchPlan?.searchQueries ?? [])
  ]);
}

async function searchGoogleNewsRss(prompt: string, country: string): Promise<SearchResult[]> {
  const locale = newsLocale(country);
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", prompt);
  url.searchParams.set("hl", locale.hl);
  url.searchParams.set("gl", locale.gl);
  url.searchParams.set("ceid", `${locale.gl}:en`);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "CrisisSignal hackathon prototype; contact=local-demo"
    },
    next: { revalidate: 300 }
  });

  if (!response.ok) {
    throw new Error(`Google News fallback failed (${response.status})`);
  }

  const xml = await response.text();
  return parseNewsItems(xml).slice(0, 8);
}

function parseNewsItems(xml: string): SearchResult[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const results: SearchResult[] = [];

  for (const match of items) {
    const item = match[1];
    const title = decodeXml(readXmlTag(item, "title"));
    const rawUrl = decodeXml(readXmlTag(item, "link"));
    const snippet = decodeXml(readXmlTag(item, "description")).replace(/<[^>]+>/g, " ");
    const publishedAt = decodeXml(readXmlTag(item, "pubDate"));
    const url = normalizeNewsUrl(rawUrl);
    if (!title || !url) continue;

    results.push({
      title,
      url,
      snippet: trimText(snippet || title, 520),
      date: publishedAt || undefined
    });
  }

  return results;
}

function readXmlTag(input: string, tag: string) {
  const match = input.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1]?.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim() ?? "";
}

function normalizeNewsUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function decodeXml(input: string) {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function buildOfficialFallbackResults(params: {
  query: string;
  region: string;
  disasterType?: string;
  country?: string;
}) {
  const q = encodeURIComponent(`${params.query} ${params.region}`);
  const country = (params.country ?? "").toLowerCase();
  const urls: Array<{ title: string; url: string; snippet: string }> = [
    {
      title: "ReliefWeb updates",
      url: `https://reliefweb.int/updates?search=${q}`,
      snippet: "Humanitarian updates and situation reports matching the scan query."
    }
  ];

  if (country === "in") {
    urls.push(
      {
        title: "PIB India search",
        url: `https://pib.gov.in/Search.aspx?kwd=${q}`,
        snippet: "Government press releases and official advisories from India."
      },
      {
        title: "MoHFW India",
        url: "https://www.mohfw.gov.in/",
        snippet: "India Ministry of Health and Family Welfare updates."
      },
      {
        title: "India Meteorological Department",
        url: "https://mausam.imd.gov.in/",
        snippet: "Official weather warnings and cyclone or heavy-rain alerts for India."
      },
      {
        title: "National Disaster Management Authority India",
        url: "https://ndma.gov.in/",
        snippet: "India disaster management authority resources and advisories."
      }
    );
  } else if (country === "us") {
    urls.push(
      {
        title: "FEMA disasters",
        url: `https://www.fema.gov/disaster/declarations?field_dv2_state_territory_tribal_value=All&field_year_value=All&search=${q}`,
        snippet: "US federal disaster declarations and emergency management updates."
      },
      {
        title: "CDC search",
        url: `https://search.cdc.gov/search/?query=${q}`,
        snippet: "US CDC public health search results."
      },
      {
        title: "National Weather Service alerts",
        url: "https://alerts.weather.gov/",
        snippet: "US official weather warnings and active alerts."
      }
    );
  } else if (country === "ph") {
    urls.push(
      {
        title: "NDRRMC Philippines",
        url: "https://ndrrmc.gov.ph/",
        snippet: "Philippines disaster risk reduction and management council updates."
      },
      {
        title: "PAGASA Philippines",
        url: "https://www.pagasa.dost.gov.ph/",
        snippet: "Official Philippines weather and cyclone warnings."
      },
      {
        title: "DOH Philippines",
        url: "https://doh.gov.ph/",
        snippet: "Philippines Department of Health updates."
      }
    );
  } else if (country === "jp") {
    urls.push(
      {
        title: "Japan Meteorological Agency",
        url: "https://www.jma.go.jp/jma/indexe.html",
        snippet: "Japan official weather, earthquake, tsunami, and warning information."
      },
      {
        title: "Japan disaster prevention portal",
        url: "https://www.bousai.go.jp/index-e.html",
        snippet: "Japan Cabinet Office disaster prevention information."
      }
    );
  } else if (country === "gb") {
    urls.push(
      {
        title: "GOV.UK search",
        url: `https://www.gov.uk/search/all?keywords=${q}`,
        snippet: "UK government search results for official advisories."
      },
      {
        title: "UK Met Office warnings",
        url: "https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings",
        snippet: "Official UK weather warnings."
      }
    );
  }

  return urls.map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet
  }));
}

function newsLocale(country: string) {
  const normalized = country.toLowerCase();
  const gl =
    {
      in: "IN",
      us: "US",
      gb: "GB",
      jp: "JP",
      ph: "PH",
      sg: "SG",
      au: "AU"
    }[normalized] ?? "US";

  return { gl, hl: `en-${gl}` };
}

function trimText(value: string, limit: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}...` : compact;
}

function errorToMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifySource(url: string): SourceKind {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }

  if (
    host.endsWith(".gov") ||
    host.includes("fema") ||
    host.includes("ndma") ||
    host.includes("police") ||
    host.includes("weather.gov") ||
    host.includes("imd.gov") ||
    host.includes("reliefweb")
  ) {
    return "official";
  }

  if (
    host.includes("who.int") ||
    host.includes("cdc.gov") ||
    host.includes("ecdc.europa.eu") ||
    host.includes("nih.gov") ||
    host.includes("ncbi.nlm.nih.gov") ||
    host.includes("icmr") ||
    host.includes("mohfw") ||
    host.includes("health")
  ) {
    return "health";
  }

  if (host.includes("weather") || host.includes("metoffice") || host.includes("imd")) {
    return "weather";
  }

  if (host.includes("reddit")) {
    return "social";
  }

  return "news";
}

function dedupeByUrl(results: SearchResult[]) {
  const seen = new Set<string>();
  return results.filter((result) => {
    const normalized = result.url.replace(/\/$/, "");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function rankResults(
  results: SearchResult[],
  params: {
    query: string;
    region: string;
    disasterType?: string;
    searchPlan?: SearchPlan;
  }
) {
  const queryTerms = tokenSet(`${params.query} ${params.region} ${params.disasterType ?? ""}`);
  const candidateTerms = tokenSet(params.searchPlan?.candidateLocations.join(" ") ?? "");
  const authorityTerms = tokenSet(params.searchPlan?.officialSourceHints.join(" ") ?? "");

  return [...results].sort((a, b) => scoreResult(b) - scoreResult(a));

  function scoreResult(result: SearchResult) {
    const text = `${result.title} ${result.snippet ?? ""} ${result.url}`.toLowerCase();
    const host = safeHost(result.url);
    let score = 0;

    for (const term of queryTerms) {
      if (text.includes(term)) score += 2;
    }
    for (const term of candidateTerms) {
      if (text.includes(term)) score += 3;
    }
    for (const term of authorityTerms) {
      if (text.includes(term)) score += 1;
    }

    const kind = classifySource(result.url);
    if (kind === "official") score += 10;
    if (kind === "health") score += 8;
    if (kind === "weather") score += 5;
    if (kind === "news") score += 2;

    if (text.includes("official")) score += 4;
    if (text.includes("case") || text.includes("cases")) score += 3;
    if (text.includes("outbreak") || text.includes("surveillance")) score += 3;
    if (text.includes("district") || text.includes("city") || text.includes("state")) score += 2;
    if (text.includes("location") || text.includes("affected")) score += 2;
    if (host.includes("example.")) score -= 20;

    return score;
  }
}

function tokenSet(input: string) {
  return uniqueStrings(
    input
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 3)
  ).slice(0, 30);
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}
