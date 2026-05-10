import { Incident, ScanResponse, SearchPlan, SourceDocument } from "./types";
import { loadProjectEnv } from "./env";

type AzureMessage = {
  role: "system" | "user";
  content: string;
};

function getAzureConfig() {
  loadProjectEnv();
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, "");
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

  if (!endpoint || !apiKey || !deployment) {
    throw new Error("Azure OpenAI env vars are not fully configured");
  }

  return { endpoint, apiKey, deployment };
}

export async function analyzeCrisisSignals(input: {
  query: string;
  region: string;
  sources: SourceDocument[];
  searchPlan?: SearchPlan;
}): Promise<Omit<ScanResponse, "query" | "region" | "generatedAt" | "sources">> {
  const { endpoint, apiKey, deployment } = getAzureConfig();
  const messages: AzureMessage[] = [
    {
      role: "system",
      content:
        "You are CrisisSignal, a disaster-response intelligence analyst. You do not dispatch responders. You turn messy public web reports into cautious, source-backed triage leads for human review. Never invent facts. Mark low-confidence claims clearly."
    },
    {
      role: "user",
      content: buildAnalysisPrompt(input.query, input.region, input.sources, input.searchPlan)
    }
  ];

  const body = {
    model: deployment,
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" }
  };

  const { response, payload } = await callAzure(endpoint, apiKey, deployment, body);

  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("Azure OpenAI did not return text content");
  }

  return normalizeAnalysis(JSON.parse(content));
}

export async function planCrisisSearch(input: {
  query: string;
  region: string;
  disasterType?: string;
}): Promise<SearchPlan> {
  try {
    const { endpoint, apiKey, deployment } = getAzureConfig();
    const messages: AzureMessage[] = [
      {
        role: "system",
        content:
          "You are a crisis-intelligence search planner. Create diverse web-search queries and candidate locations so a scraper can find official, local, and specialist sources. Return only JSON."
      },
      {
        role: "user",
        content: buildSearchPlanPrompt(input.query, input.region, input.disasterType)
      }
    ];

    const body = {
      model: deployment,
      messages,
      temperature: 0.1,
      response_format: { type: "json_object" }
    };

    const { payload } = await callAzure(endpoint, apiKey, deployment, body);
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("Azure OpenAI did not return search-plan content");
    }

    return normalizeSearchPlan(JSON.parse(content), input);
  } catch {
    return buildDefaultSearchPlan(input);
  }
}

async function callAzure(
  endpoint: string,
  apiKey: string,
  deployment: string,
  body: Record<string, unknown>
) {
  const attempts: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [
    {
      url: `${endpoint}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body
    },
    {
      url: `${endpoint}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey
      },
      body
    }
  ];

  const legacyBase = endpoint.replace(/\/openai\/v1$/, "");
  if (legacyBase !== endpoint) {
    attempts.push({
      url: `${legacyBase}/openai/deployments/${encodeURIComponent(
        deployment
      )}/chat/completions?api-version=2024-10-21`,
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey
      },
      body: {
        messages: body.messages,
        temperature: body.temperature,
        response_format: body.response_format
      }
    });
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    const response = await fetch(attempt.url, {
      method: "POST",
      headers: attempt.headers,
      body: JSON.stringify(attempt.body)
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      return { response, payload };
    }
    errors.push(`${response.status}: ${JSON.stringify(payload)}`);
  }

  throw new Error(`Azure OpenAI request failed after ${attempts.length} attempts: ${errors.join(" | ")}`);
}

function buildAnalysisPrompt(
  query: string,
  region: string,
  sources: SourceDocument[],
  searchPlan?: SearchPlan
) {
  const sourceText = sources
    .map((source) => {
      const body = (source.content || source.snippet).replace(/\s+/g, " ").slice(0, 4500);
      return [
        `SOURCE_ID: ${source.id}`,
        `KIND: ${source.kind}`,
        `TITLE: ${source.title}`,
        `URL: ${source.url}`,
        `PUBLISHED: ${source.publishedAt ?? "unknown"}`,
        `TEXT: ${body}`
      ].join("\n");
    })
    .join("\n\n---\n\n");

  const supplementalContext = searchPlan
    ? [
        `BACKGROUND_CONTEXT: ${searchPlan.backgroundContext || "none"}`,
        `CANDIDATE_LOCATIONS: ${searchPlan.candidateLocations.join("; ") || "none"}`,
        `OFFICIAL_SOURCE_HINTS: ${searchPlan.officialSourceHints.join("; ") || "none"}`
      ].join("\n")
    : "none";

  return `
Analyze crisis signals for:
Query: ${query}
Region: ${region}

Return strict JSON with this shape:
{
  "executiveSummary": "2-4 sentences for an operations lead",
  "incidents": [
    {
      "type": "rescue_need | medical_need | road_blocked | shelter | utility_outage | evacuation | supply_need | infrastructure_damage | rumor | other",
      "title": "short incident title",
      "summary": "what appears to be happening",
      "location": "best available location, or region-wide",
      "latitude": number or null,
      "longitude": number or null,
      "severity": "critical | high | medium | low",
      "confidence": 0.0-1.0,
      "status": "corroborated | single-source | official | needs-verification",
      "recommendedAction": "human-safe next step, usually verify with authority or inspect source",
      "evidenceSourceIds": ["source-1"],
      "evidenceQuotes": ["short quote or paraphrase from source"]
    }
  ],
  "limitations": ["what is missing or uncertain"]
}

Rules:
- Do not create more than 12 incidents.
- Prefer concrete operational needs over general weather descriptions.
- For health or outbreak queries, treat separate affected cities, districts, states, hospitals, or clusters as separate incident/location records when evidence or context supports them.
- If the region is an entire country, analyze country-wide coverage and avoid collapsing every finding into the country centroid. Use the most specific city/state/district location available.
- If only one weak source mentions something, status must be "single-source" or "needs-verification".
- If an official source confirms it, status can be "official".
- Assign higher confidence when multiple independent sources support the same event.
- Approximate coordinates are allowed only when the location is explicit; otherwise use null. A geocoder will refine coordinates after this step.
- Use source ids exactly as provided.
- Source evidence is primary. Supplemental model context can help identify coverage gaps or candidate locations, but it is not proof.
- If supplemental context identifies a relevant location that is missing from scraped sources, include it only as "needs-verification", confidence <= 0.35, evidenceSourceIds: [], and evidenceQuotes: ["Model background candidate; verify with official source."].

Supplemental model/search-planning context:
${supplementalContext}

Sources:
${sourceText}
`;
}

function buildSearchPlanPrompt(query: string, region: string, disasterType?: string) {
  return `
Create a search plan for this crisis scan.

Query: ${query}
Region: ${region}
Type: ${disasterType || "unknown"}

Return strict JSON:
{
  "searchQueries": [
    "specific query for official/government sources",
    "specific query for local news and city/district reports",
    "specific query for specialist/medical/weather/relief sources"
  ],
  "candidateLocations": ["specific city/state/district/location inside the requested region that may be relevant"],
  "officialSourceHints": ["likely official or authoritative source families to check"],
  "backgroundContext": "short paragraph of relevant model background, clearly not treated as verified evidence"
}

Rules:
- Create 4 to 7 search queries.
- Include the original topic words exactly.
- Include the requested region in every query.
- For country-wide scans, include queries that search for state, district, city, and official case-location coverage.
- For disease/outbreak topics, include terms such as cases, outbreak, surveillance, health department, hospital, city, state, and official report.
- Candidate locations must be inside the requested region.
- Do not claim that candidate locations are verified.
`;
}

function normalizeAnalysis(value: unknown): Omit<ScanResponse, "query" | "region" | "generatedAt" | "sources"> {
  const data = value as {
    executiveSummary?: unknown;
    incidents?: unknown;
    limitations?: unknown;
  };

  const incidents = Array.isArray(data.incidents) ? data.incidents : [];

  return {
    executiveSummary:
      typeof data.executiveSummary === "string"
        ? data.executiveSummary
        : "CrisisSignal collected public reports, but the model did not return a summary.",
    incidents: incidents.map(normalizeIncident).filter(Boolean).slice(0, 12) as Incident[],
    limitations: Array.isArray(data.limitations)
      ? data.limitations.filter((item): item is string => typeof item === "string").slice(0, 6)
      : ["Public web data can be incomplete, stale, or wrong. Human verification is required."]
  };
}

function normalizeSearchPlan(
  value: unknown,
  input: { query: string; region: string; disasterType?: string }
): SearchPlan {
  if (!value || typeof value !== "object") return buildDefaultSearchPlan(input);
  const data = value as Record<string, unknown>;
  const fallback = buildDefaultSearchPlan(input);

  return {
    searchQueries: normalizeStringArray(data.searchQueries, 7, fallback.searchQueries),
    candidateLocations: normalizeStringArray(data.candidateLocations, 12, fallback.candidateLocations),
    officialSourceHints: normalizeStringArray(data.officialSourceHints, 8, fallback.officialSourceHints),
    backgroundContext:
      typeof data.backgroundContext === "string"
        ? data.backgroundContext.slice(0, 1200)
        : fallback.backgroundContext
  };
}

function buildDefaultSearchPlan(input: {
  query: string;
  region: string;
  disasterType?: string;
}): SearchPlan {
  const year = new Date().getUTCFullYear();
  const base = `${input.query} ${input.region}`;
  return {
    searchQueries: [
      `${base} official case locations affected districts ${year}`,
      `${base} local news city state district reports ${year}`,
      `${base} government health department emergency update ${year}`,
      `${base} cases outbreak surveillance hospital official report ${year}`,
      `${base} map locations timeline latest today`
    ],
    candidateLocations: [input.region],
    officialSourceHints: [
      "national government portals",
      "state or city health/emergency departments",
      "WHO or public-health agencies",
      "local official advisories"
    ],
    backgroundContext:
      "No live model search plan was available. The system used deterministic query expansion and will treat all findings as needing source verification."
  };
}

function normalizeStringArray(value: unknown, limit: number, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return normalized.length > 0 ? normalized.slice(0, limit) : fallback;
}

function normalizeIncident(value: unknown, index: number): Incident | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const evidenceSourceIds = Array.isArray(item.evidenceSourceIds)
    ? item.evidenceSourceIds.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    id: `incident-${index + 1}`,
    type: typeof item.type === "string" ? (item.type as Incident["type"]) : "other",
    title: typeof item.title === "string" ? item.title : "Unlabeled incident",
    summary: typeof item.summary === "string" ? item.summary : "",
    location: typeof item.location === "string" ? item.location : "Unknown location",
    latitude: typeof item.latitude === "number" ? item.latitude : undefined,
    longitude: typeof item.longitude === "number" ? item.longitude : undefined,
    severity: isSeverity(item.severity) ? item.severity : "medium",
    confidence: typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0.4,
    status: isStatus(item.status) ? item.status : "needs-verification",
    recommendedAction:
      typeof item.recommendedAction === "string"
        ? item.recommendedAction
        : "Verify with official channels before acting.",
    evidenceSourceIds,
    evidenceQuotes: Array.isArray(item.evidenceQuotes)
      ? item.evidenceQuotes.filter((entry): entry is string => typeof entry === "string").slice(0, 3)
      : []
  };
}

function isSeverity(value: unknown): value is Incident["severity"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function isStatus(value: unknown): value is Incident["status"] {
  return (
    value === "corroborated" ||
    value === "single-source" ||
    value === "official" ||
    value === "needs-verification"
  );
}
