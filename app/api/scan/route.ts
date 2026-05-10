import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { collectSources } from "@/lib/anakin";
import { analyzeCrisisSignals, planCrisisSearch } from "@/lib/azure";
import { geocodeIncidents } from "@/lib/geocode";
import { Incident, IncidentType, ScanResponse, SearchPlan, SourceDocument } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

const ScanRequest = z.object({
  query: z.string().min(3).max(180),
  region: z.string().min(2).max(120),
  disasterType: z.string().max(80).optional(),
  maxSources: z.number().int().min(3).max(12).default(8),
  country: z.string().min(2).max(2).default("us"),
  useDemoFallback: z.boolean().default(false)
});

export async function POST(request: NextRequest) {
  const parsed = ScanRequest.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid scan request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const startedAt = Date.now();
  const input = parsed.data;
  const searchPlan = await planCrisisSearch({
    query: input.query,
    region: input.region,
    disasterType: input.disasterType
  });

  let sources: SourceDocument[];
  try {
    sources = await collectSources({
      query: input.query,
      region: input.region,
      disasterType: input.disasterType,
      maxSources: input.maxSources,
      country: input.country.toLowerCase(),
      searchPlan
    });

    if (sources.length === 0) {
      throw new Error("No public sources were found for this query");
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Source collection failed" },
      { status: 502 }
    );
  }

  try {
    const analysis = await analyzeCrisisSignals({
      query: input.query,
      region: input.region,
      sources,
      searchPlan
    });
    const incidents = await geocodeIncidents({
      incidents: appendCandidateLocationIncidents(analysis.incidents, searchPlan, input.region),
      region: input.region,
      country: input.country
    });

    const response: ScanResponse & { processingMs: number } = {
      query: input.query,
      region: input.region,
      generatedAt: new Date().toISOString(),
      searchPlan,
      sources,
      ...analysis,
      incidents,
      processingMs: Date.now() - startedAt
    };

    return NextResponse.json(response);
  } catch (error) {
    const fallback = heuristicAnalysis(input.query, input.region, sources);
    const incidents = await geocodeIncidents({
      incidents: appendCandidateLocationIncidents(fallback.incidents, searchPlan, input.region),
      region: input.region,
      country: input.country
    });

    const response: ScanResponse & { processingMs: number; fallbackReason: string } = {
      query: input.query,
      region: input.region,
      generatedAt: new Date().toISOString(),
      searchPlan,
      sources,
      ...fallback,
      incidents,
      processingMs: Date.now() - startedAt,
      fallbackReason: error instanceof Error ? error.message : "Unknown analysis failure"
    };

    return NextResponse.json(response);
  }
}

const SIGNAL_RULES: Array<{
  type: IncidentType;
  title: string;
  severity: Incident["severity"];
  keywords: string[];
  action: string;
}> = [
  {
    type: "rescue_need",
    title: "Possible rescue or stranded-person signal",
    severity: "critical",
    keywords: ["stranded", "rescue", "trapped", "stuck", "missing", "evacuate"],
    action: "Escalate to the control room only after confirming location and source reliability."
  },
  {
    type: "medical_need",
    title: "Possible medical facility or supply need",
    severity: "critical",
    keywords: ["hospital", "oxygen", "ambulance", "medical", "injured", "clinic"],
    action: "Verify with the named facility or district health authority before routing support."
  },
  {
    type: "road_blocked",
    title: "Likely transport disruption",
    severity: "high",
    keywords: ["road", "bridge", "traffic", "underpass", "blocked", "closure", "waterlogging"],
    action: "Ask traffic police or public works to verify and publish alternate routes."
  },
  {
    type: "utility_outage",
    title: "Possible utility interruption",
    severity: "medium",
    keywords: ["power", "electricity", "outage", "water supply", "network", "mobile"],
    action: "Check utility outage boards or local operators before escalation."
  },
  {
    type: "shelter",
    title: "Shelter or evacuation support signal",
    severity: "high",
    keywords: ["shelter", "relief camp", "evacuation center", "school opened", "community hall"],
    action: "Confirm capacity, address, and required supplies with local administration."
  },
  {
    type: "infrastructure_damage",
    title: "Potential infrastructure damage",
    severity: "high",
    keywords: ["collapsed", "damaged", "breach", "landslide", "washed away", "crack"],
    action: "Request inspection by the relevant engineering or disaster management team."
  },
  {
    type: "rumor",
    title: "Low-confidence rumor or contradictory claim",
    severity: "low",
    keywords: ["rumor", "fake news", "false claim", "unverified claim", "misinformation"],
    action: "Do not amplify. Check official clarification channels and label as unverified."
  }
];

function heuristicAnalysis(
  query: string,
  region: string,
  sources: SourceDocument[]
) {
  const incidents: Incident[] = [];
  for (const rule of SIGNAL_RULES) {
    const matches = sources.filter((source) =>
      rule.keywords.some((keyword) =>
        rule.type === "rumor"
          ? `${source.title} ${source.snippet}`.toLowerCase().includes(keyword)
          : searchableText(source).includes(keyword)
      )
    );

    if (matches.length === 0) continue;

    const hasOfficial = matches.some(
      (source) => source.kind === "official" || source.kind === "weather" || source.kind === "health"
    );
    const confidence = Math.min(0.82, 0.38 + matches.length * 0.12 + (hasOfficial ? 0.18 : 0));

    incidents.push({
      id: `incident-${incidents.length + 1}`,
      type: rule.type,
      title: rule.title,
      summary: `Public sources for "${query}" mention ${rule.keywords
        .slice(0, 4)
        .join(", ")} signals around ${region}. This is a triage lead pending human verification.`,
      location: region,
      severity: rule.severity,
      confidence,
      status: hasOfficial ? "official" : matches.length > 1 ? "corroborated" : "single-source",
      recommendedAction: rule.action,
      evidenceSourceIds: matches.slice(0, 4).map((source) => source.id),
      evidenceQuotes: matches
        .slice(0, 3)
        .map((source) => trimText(source.snippet || source.title, 220))
    });
  }

  if (incidents.length === 0 && sources.length > 0) {
    incidents.push({
      id: "incident-1",
      type: "other",
      title: "General disaster signal requiring review",
      summary:
        "The source set contains disaster-related information, but automated keyword triage did not identify a concrete operational category.",
      location: region,
      severity: "medium",
      confidence: 0.35,
      status: "needs-verification",
      recommendedAction: "Review source evidence manually and verify with official channels.",
      evidenceSourceIds: sources.slice(0, 3).map((source) => source.id),
      evidenceQuotes: sources.slice(0, 3).map((source) => trimText(source.snippet || source.title, 220))
    });
  }

  return {
    executiveSummary:
      "CrisisSignal collected public sources and produced a heuristic triage pass because the AI analysis provider was unavailable. Treat these leads as review items, not verified facts.",
    incidents: incidents.slice(0, 12),
    limitations: [
      "Azure OpenAI analysis was unavailable, so this scan used keyword-based fallback scoring.",
      "Locations may be region-level until a working LLM or geocoder is connected.",
      "All incidents require human verification before operational action."
    ]
  };
}

function appendCandidateLocationIncidents(
  incidents: Incident[],
  searchPlan: SearchPlan,
  region: string
) {
  const output = [...incidents];

  for (const candidate of searchPlan.candidateLocations) {
    const candidateLocation = candidate.toLowerCase();
    const alreadyCovered = output.some((incident) => {
      const incidentLocation = incident.location.toLowerCase();
      const compositeLocation = /\b(and|or)\b|\/|&/.test(incidentLocation);

      if (incidentLocation === candidateLocation) return true;
      if (!compositeLocation && incidentLocation.includes(candidateLocation)) return true;
      return candidateLocation.includes(incidentLocation);
    });
    if (alreadyCovered || candidate.toLowerCase() === region.toLowerCase()) continue;

    output.push({
      id: `incident-${output.length + 1}`,
      type: "other",
      title: `Candidate location for verification: ${candidate}`,
      summary:
        "The search-planning model identified this as a potentially relevant location, but the collected sources did not provide enough evidence to treat it as confirmed.",
      location: candidate,
      severity: "low",
      confidence: 0.25,
      status: "needs-verification",
      recommendedAction:
        "Search official health, emergency, or local authority sources for confirmation before using this operationally.",
      evidenceSourceIds: [],
      evidenceQuotes: ["Model background candidate; verify with official source."]
    });

    if (output.length >= 12) break;
  }

  return output.slice(0, 12);
}

function searchableText(source: SourceDocument) {
  return `${source.title} ${source.snippet} ${source.content}`.toLowerCase();
}

function trimText(value: string, limit: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}...` : compact;
}
