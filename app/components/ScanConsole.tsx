"use client";

import {
  Activity,
  AlertTriangle,
  Building2,
  Clock,
  ExternalLink,
  Flame,
  Gauge,
  Info,
  Layers,
  Loader2,
  MapPin,
  Moon,
  Radio,
  Radar,
  Search,
  ShieldCheck,
  Siren,
  Sun,
  Waves,
  Zap
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { CrisisMap } from "./CrisisMap";
import { Incident, ScanResponse, SourceDocument } from "@/lib/types";

const CRISIS_TYPES = [
  { label: "Flood", icon: <Waves size={16} /> },
  { label: "Wildfire", icon: <Flame size={16} /> },
  { label: "Earthquake", icon: <Activity size={16} /> },
  { label: "Cyclone", icon: <Radar size={16} /> },
  { label: "Disease outbreak", icon: <Siren size={16} /> },
  { label: "Other", icon: <AlertTriangle size={16} /> }
];

const REGION_CHIPS = [
  { label: "India", country: "in" },
  { label: "Mumbai, India", country: "in" },
  { label: "United States", country: "us" },
  { label: "Japan", country: "jp" },
  { label: "Philippines", country: "ph" }
];

const SOURCE_DEPTHS = [
  { label: "Fast", value: 3, detail: "3 src" },
  { label: "Balanced", value: 5, detail: "5 src" },
  { label: "Deep", value: 8, detail: "8 src" },
  { label: "Full", value: 12, detail: "12 src" }
];

const STATUS_CARDS = [
  {
    label: "Active Signals",
    value: "2,450",
    tone: "high",
    description: "Public web items currently being watched, scored, or queued for review."
  },
  {
    label: "Watch Regions",
    value: "18",
    tone: "low",
    description: "Regions with active monitoring coverage in the dashboard context."
  },
  {
    label: "Source Health",
    value: "97%",
    tone: "low",
    description: "Estimated availability of configured scraping, search, and analysis services."
  },
  {
    label: "Queue Load",
    value: "42",
    tone: "medium",
    description: "Signals waiting for automated extraction or human verification."
  }
];

const WATCHLIST = [
  {
    title: "Flood-linked road disruption",
    place: "Assam, India",
    status: "watching",
    confidence: "62%"
  },
  {
    title: "Heat stress hospital signal",
    place: "Delhi NCR",
    status: "verify",
    confidence: "48%"
  },
  {
    title: "Cyclone shelter capacity update",
    place: "Eastern Visayas",
    status: "official",
    confidence: "81%"
  }
];

export function ScanConsole() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState("");
  const [disasterType, setDisasterType] = useState("Other");
  const [country, setCountry] = useState("in");
  const [maxSources, setMaxSources] = useState(8);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runScan(event?: FormEvent) {
    event?.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          region,
          disasterType,
          country,
          maxSources,
          useDemoFallback: false
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Scan failed");
      }

      setScan(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }

  const metrics = useMemo(() => buildMetrics(scan), [scan]);

  return (
    <main className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark">
              <Radio size={18} />
            </div>
            <div>
              <h1>CrisisSignal</h1>
              <span>Web Intelligence Crisis Triage.</span>
            </div>
          </div>
          <div className="status-strip">
            <span className="status-dot" />
            <span>Automated + Human-Review Decision Support (Active)</span>
          </div>
          <div className="header-actions" aria-label="Display controls">
            <button
              type="button"
              className="theme-toggle"
              aria-label="Toggle theme"
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              <span>{theme === "dark" ? "Light" : "Dark"}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-rail">
          <form className="section" onSubmit={runScan}>
            <p className="section-title">Scan Target</p>
            <div className="field">
              <label htmlFor="query">Primary Query</label>
              <div className="input-shell">
                <Search size={15} />
                <input
                  id="query"
                  className="input"
                  value={query}
                  placeholder="hantavirus cases India official locations"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="region">Region / City</label>
              <div className="input-shell">
                <MapPin size={15} />
                <input
                  id="region"
                  className="input"
                  value={region}
                  placeholder="India, Mumbai, or Bhopal"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  onChange={(event) => setRegion(event.target.value)}
                />
              </div>
              <div className="chip-row" aria-label="Region shortcuts">
                {REGION_CHIPS.map((chip) => (
                  <button
                    key={chip.label}
                    className="mini-chip"
                    type="button"
                    onClick={() => {
                      setRegion(chip.label);
                      setCountry(chip.country);
                    }}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Crisis Type</label>
              <div className="type-grid">
                {CRISIS_TYPES.map((type) => (
                  <button
                    key={type.label}
                    type="button"
                    className={`type-button ${disasterType === type.label ? "active" : ""}`}
                    onClick={() => setDisasterType(type.label)}
                    aria-pressed={disasterType === type.label}
                  >
                    {type.icon}
                    <span>{type.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="row">
              <div className="field compact-field">
                <label htmlFor="country">Proxy / Source</label>
                <select
                  id="country"
                  className="select"
                  value={country}
                  onChange={(event) => setCountry(event.target.value)}
                >
                  <option value="in">IN India</option>
                  <option value="us">US United States</option>
                  <option value="gb">GB United Kingdom</option>
                  <option value="jp">JP Japan</option>
                  <option value="ph">PH Philippines</option>
                  <option value="sg">SG Singapore</option>
                  <option value="au">AU Australia</option>
                </select>
              </div>
              <div className="field compact-field">
                <label>Mode</label>
                <div className="mode-badge">
                  <Layers size={14} />
                  Live web
                </div>
              </div>
            </div>
            <div className="field">
              <label>Source Deep Scan</label>
              <div className="depth-control">
                {SOURCE_DEPTHS.map((depth) => (
                  <button
                    key={depth.value}
                    type="button"
                    className={`depth-segment ${maxSources === depth.value ? "active" : ""}`}
                    onClick={() => setMaxSources(depth.value)}
                    aria-pressed={maxSources === depth.value}
                  >
                    <span>{depth.label}</span>
                    <small>{depth.detail}</small>
                  </button>
                ))}
              </div>
            </div>
            <button className="primary-button" disabled={loading} type="submit">
              {loading ? <Loader2 size={17} className="spin" /> : <Search size={17} />}
              {loading ? "Scanning" : "Run crisis scan"}
            </button>
            {error ? <div className="error-box">{error}</div> : null}
          </form>
        </aside>

        <section className="content-grid">
          <div className="map-panel">
            <div className="map-header">
              <div>
                <h2>Operational Map</h2>
                <p>Source-backed incident points and geocoded verification targets</p>
              </div>
              <div className="map-header-actions">
                <span className="pill">
                  <MapPin size={13} /> {(scan?.region ?? region) || "No region selected"}
                </span>
                <span className="pill">
                  <Radar size={13} /> {loading ? "Scanning" : "Standby"}
                </span>
              </div>
            </div>
            <CrisisMap incidents={scan?.incidents ?? []} region={scan?.region ?? region} theme={theme} />
          </div>

          <div className="dashboard-stack">
            {scan ? (
              <>
                <section className="summary-panel">
                  <div className="panel-header" style={{ padding: 0, borderBottom: 0 }}>
                    <h2>Situation Brief</h2>
                    <span className="pill">
                      <Clock size={13} /> {new Date(scan.generatedAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <p>{scan.executiveSummary}</p>
                </section>

                <div className="metrics">
                  <Metric label="Incidents" value={String(metrics.total)} />
                  <Metric label="Critical/High" value={String(metrics.severe)} />
                  <Metric label="Official Signals" value={String(metrics.official)} />
                  <Metric label="Sources" value={String(scan.sources.length)} />
                </div>

                <Panel title="Incident Triage" icon={<AlertTriangle size={17} />}>
                  <div className="incident-list">
                    {scan.incidents.map((incident) => (
                      <IncidentCard
                        key={incident.id}
                        incident={incident}
                        sources={scan.sources}
                      />
                    ))}
                  </div>
                </Panel>

                <Panel title="Source Evidence" icon={<ShieldCheck size={17} />}>
                  <div className="source-list">
                    {scan.sources.map((source) => (
                      <SourceRow key={source.id} source={source} />
                    ))}
                  </div>
                </Panel>

                {scan.searchPlan ? (
                  <Panel title="Search Strategy" icon={<Search size={17} />}>
                    <div className="source-list">
                      <div className="source-row">
                        <h3>Expanded queries</h3>
                        <p>{scan.searchPlan.searchQueries.join(" | ")}</p>
                      </div>
                      {scan.searchPlan.candidateLocations.length > 0 ? (
                        <div className="source-row">
                          <h3>Candidate locations</h3>
                          <p>{scan.searchPlan.candidateLocations.join(", ")}</p>
                        </div>
                      ) : null}
                      <div className="source-row">
                        <h3>Background context</h3>
                        <p>{scan.searchPlan.backgroundContext}</p>
                      </div>
                    </div>
                  </Panel>
                ) : null}

                <Panel title="Limitations" icon={<Activity size={17} />}>
                  <div className="source-list">
                    {scan.limitations.map((limitation) => (
                      <div className="source-row" key={limitation}>
                        <p>{limitation}</p>
                      </div>
                    ))}
                  </div>
                </Panel>
              </>
            ) : (
              <PreScanConsole loading={loading} />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function Panel({
  title,
  icon,
  children
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="main-panel">
      <div className="panel-header">
        <h2>
          <span style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 8 }}>
            {icon}
          </span>
          {title}
        </h2>
      </div>
      <div className="section">{children}</div>
    </section>
  );
}

function PreScanConsole({ loading }: { loading: boolean }) {
  return (
    <div className="pre-scan-grid">
      <section className="summary-panel status-overview">
        <div className="panel-header compact">
          <h2>
            <Radar size={17} /> Platform Status
          </h2>
          <span className="pill">{loading ? "scan running" : "ready"}</span>
        </div>
        <div className="status-card-grid">
          {STATUS_CARDS.map((card) => (
            <div className={`status-card tone-${card.tone}`} key={card.label}>
              <div className="status-card-label">
                <span>{card.label}</span>
                <button
                  type="button"
                  className="info-button"
                  aria-label={`${card.label}: ${card.description}`}
                  title={card.description}
                  data-tooltip={card.description}
                >
                  <Info size={13} />
                </button>
              </div>
              <strong>{card.value}</strong>
              <p>{card.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="main-panel">
        <div className="panel-header">
          <h2>
            <Zap size={17} /> Recent High-Value Watchlist
          </h2>
          <span className="pill">sample context</span>
        </div>
        <div className="section watchlist">
          {WATCHLIST.map((item) => (
            <article className="watch-row" key={item.title}>
              <div>
                <h3>{item.title}</h3>
                <span>{item.place}</span>
              </div>
              <div className="watch-meta">
                <span className="pill">{item.status}</span>
                <strong>{item.confidence}</strong>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="main-panel">
        <div className="panel-header">
          <h2>
            <Gauge size={17} /> Intelligence Readiness
          </h2>
        </div>
        <div className="section readiness-grid">
          <div>
            <Building2 size={18} />
            <span>Official source bias</span>
            <strong>Enabled</strong>
          </div>
          <div>
            <ShieldCheck size={18} />
            <span>Human review gate</span>
            <strong>Required</strong>
          </div>
          <div>
            <MapPin size={18} />
            <span>Geocoding layer</span>
            <strong>Active</strong>
          </div>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function IncidentCard({
  incident,
  sources
}: {
  incident: Incident;
  sources: SourceDocument[];
}) {
  const linkedSources = sources.filter((source) => incident.evidenceSourceIds.includes(source.id));
  return (
    <article className="incident-card">
      <div className="incident-head">
        <div>
          <h3 className="incident-title">{incident.title}</h3>
          <div className="incident-meta">
            <span className={`pill severity-${incident.severity}`}>{incident.severity}</span>
            <span className="pill">{Math.round(incident.confidence * 100)}% confidence</span>
            <span className="pill">{incident.status}</span>
          </div>
        </div>
        <span className="pill">
          <MapPin size={13} /> {incident.location}
        </span>
      </div>
      <p className="incident-summary">{incident.summary}</p>
      <div className="evidence">
        <p>
          <strong>Action:</strong> {incident.recommendedAction}
        </p>
        {incident.evidenceQuotes.map((quote) => (
          <p key={quote}>&ldquo;{quote}&rdquo;</p>
        ))}
        {linkedSources.length > 0 ? (
          <p>
            Evidence:{" "}
            {linkedSources.map((source, index) => (
              <span key={source.id}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.id}
                </a>
                {index < linkedSources.length - 1 ? ", " : ""}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function SourceRow({ source }: { source: SourceDocument }) {
  return (
    <article className="source-row">
      <h3>
        <a href={source.url} target="_blank" rel="noreferrer">
          {source.title} <ExternalLink size={12} />
        </a>
      </h3>
      <div className="source-meta">
        <span className="pill">{source.id}</span>
        <span className="pill">{source.kind}</span>
        <span className="pill">{source.scraped ? "scraped" : "snippet only"}</span>
      </div>
      <p>{source.snippet || trimText(source.content, 180)}</p>
    </article>
  );
}

function buildMetrics(scan: ScanResponse | null) {
  if (!scan) return { total: 0, severe: 0, official: 0 };
  return {
    total: scan.incidents.length,
    severe: scan.incidents.filter(
      (incident) => incident.severity === "critical" || incident.severity === "high"
    ).length,
    official: scan.incidents.filter((incident) => incident.status === "official").length
  };
}

function trimText(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}
