export type SourceKind = "official" | "news" | "social" | "weather" | "health" | "other";

export type SearchResult = {
  url: string;
  title: string;
  snippet?: string;
  date?: string;
  last_updated?: string;
};

export type SourceDocument = {
  id: string;
  kind: SourceKind;
  title: string;
  url: string;
  snippet: string;
  content: string;
  publishedAt?: string;
  scraped: boolean;
};

export type SearchPlan = {
  searchQueries: string[];
  candidateLocations: string[];
  officialSourceHints: string[];
  backgroundContext: string;
};

export type IncidentType =
  | "rescue_need"
  | "medical_need"
  | "road_blocked"
  | "shelter"
  | "utility_outage"
  | "evacuation"
  | "supply_need"
  | "infrastructure_damage"
  | "rumor"
  | "other";

export type Incident = {
  id: string;
  type: IncidentType;
  title: string;
  summary: string;
  location: string;
  latitude?: number;
  longitude?: number;
  severity: "critical" | "high" | "medium" | "low";
  confidence: number;
  status: "corroborated" | "single-source" | "official" | "needs-verification";
  recommendedAction: string;
  evidenceSourceIds: string[];
  evidenceQuotes: string[];
};

export type ScanResponse = {
  query: string;
  region: string;
  generatedAt: string;
  searchPlan?: SearchPlan;
  executiveSummary: string;
  incidents: Incident[];
  sources: SourceDocument[];
  limitations: string[];
};
