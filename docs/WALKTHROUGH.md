# CrisisSignal Walkthrough

CrisisSignal is a disaster-response triage dashboard. After the operator enters a disaster query and region, the app searches the live public web, scrapes the most relevant pages, asks Azure OpenAI to extract operational incidents, and displays a human-review map plus evidence list.

This project is not a dispatch system. It produces source-backed leads for a human responder, NGO operator, journalist, or emergency-control-room analyst to review.

## Input

The operator provides:

- `Disaster query`: the live information need, for example `latest flood alerts road closures shelters rescue needs India today`.
- `Region`: the geographic area to focus on, for example `India` or `Bhopal, India`.
- `Type`: flood, wildfire, earthquake, cyclone, heatwave, or other.
- `Proxy`: country code used by Anakin while scraping pages.
- `Source count`: how many sources to inspect, currently 3, 5, 8, or 12.

The frontend sends this payload to:

```txt
POST /api/scan
```

Implemented in:

```txt
app/components/ScanConsole.tsx
app/api/scan/route.ts
```

## Step 1: Validate The Request

The API validates the incoming scan request using `zod`.

Required fields:

- `query`: 3 to 180 characters
- `region`: 2 to 120 characters
- `maxSources`: 3 to 12
- `country`: two-letter country code

If validation fails, the API returns `400`.

## Step 2: Build A Search Plan With Azure OpenAI

Before scraping, the app asks Azure OpenAI to create a search plan. This is used to widen the collection step so country-wide or specialist topics do not depend on one broad search result page.

The search plan contains:

- expanded search queries
- candidate cities, districts, or states inside the requested region
- likely official source families to check
- background context that is treated as unverified until supported by sources

For example, a disease query such as `hantavirus cases India` can produce searches for official health reports, local Mumbai reports, surveillance pages, and candidate Maharashtra city names.

The app displays this plan in the `Search Strategy` panel.

Implemented in:

```txt
lib/azure.ts -> planCrisisSearch()
app/components/ScanConsole.tsx -> Search Strategy panel
```

## Step 3: Build Live Search Prompts

The backend does not use a fixed list of disaster websites.

Instead, it builds several live search prompts from the operator input and the AI search plan:

```txt
{query}
{region}
{disasterType}
current latest today
{current year}
local news official emergency update damage road hospital shelter power outage rescue
```

Additional prompts target official sources, local reports, health/weather/specialist sources, and candidate locations. This makes the search biased toward recent operational information, not general articles.

Implemented in:

```txt
lib/anakin.ts -> collectSources()
lib/anakin.ts -> buildSearchPrompts()
```

## Step 4: Search The Web With Anakin

The app calls Anakin Search:

```txt
POST https://api.anakin.io/v1/search
```

The request body contains:

```json
{
  "prompt": "combined live disaster search prompt",
  "limit": "maxSources + 2"
}
```

The app runs multiple Anakin searches in parallel. Anakin returns search results with fields like:

- `title`
- `url`
- `snippet`
- `date` or `last_updated`

The app filters out invalid results, removes duplicate URLs, ranks source quality, and keeps only the requested number of sources.

## Which Websites Are Scraped?

The exact websites change every time based on the query, region, date, and Anakin search ranking.

For example, an India flood scan can return sources such as:

- Government flood forecast or water authority pages
- Local or national news reports
- Weather or emergency-alert pages
- Relief or disaster-management updates

The app classifies each result by URL:

- `official`: `.gov`, FEMA, NDMA, police, weather.gov, IMD, ReliefWeb-style domains
- `health`: WHO, CDC, NIH/NCBI, ICMR, MoHFW, and other health-specialist domains
- `weather`: weather, Met Office, IMD-style domains
- `social`: Reddit domains, once Reddit sources are connected
- `news`: default for news/public web domains
- `other`: anything that cannot be classified

The actual scraped websites are visible in the app under `Source Evidence`. Each source row shows the title, URL, source type, and whether the full page was scraped or only the search snippet was used.

Implemented in:

```txt
lib/anakin.ts -> classifySource()
app/components/ScanConsole.tsx -> SourceRow()
```

## Step 5: Scrape Each Selected URL With Anakin

For each selected search result, the app calls Anakin URL Scraper:

```txt
POST https://api.anakin.io/v1/url-scraper
```

The request body contains:

```json
{
  "url": "selected source URL",
  "country": "selected proxy country",
  "useBrowser": false,
  "generateJson": false
}
```

Anakin returns a scrape job id. The app then polls:

```txt
GET https://api.anakin.io/v1/url-scraper/{jobId}
```

Polling continues until the scrape is:

- `completed`
- `failed`
- timed out after 45 seconds

If full scraping succeeds, the app uses the page content. If scraping one URL fails, the app still keeps the search result and uses its snippet. This prevents one bad website from breaking the full scan.

Implemented in:

```txt
lib/anakin.ts -> scrapeUrl()
lib/anakin.ts -> pollScrape()
```

## Step 6: Normalize Sources

Each source is converted into a `SourceDocument`:

```json
{
  "id": "source-1",
  "kind": "official | news | social | weather | health | other",
  "title": "source title",
  "url": "source URL",
  "snippet": "search snippet",
  "content": "scraped page text or snippet",
  "publishedAt": "date if provided",
  "scraped": true
}
```

The app limits each scraped source body to 10,000 characters before analysis so the model gets enough evidence without wasting tokens.

Implemented in:

```txt
lib/anakin.ts -> toSourceDocument()
```

## Step 7: Analyze With Azure OpenAI

After live sources are collected, the app sends them to Azure OpenAI.

The model is instructed to behave as a disaster-response intelligence analyst. It must:

- avoid inventing facts
- extract only source-backed incidents
- mark weak claims as low confidence
- prefer operational needs over general weather descriptions
- return strict JSON
- use background context only for low-confidence candidate locations unless scraped sources verify it

The expected output contains:

- `executiveSummary`
- `incidents`
- `limitations`

Each incident includes:

- incident type
- title
- summary
- best-known location
- optional latitude and longitude
- severity
- confidence score
- verification status
- recommended human action
- evidence source ids
- short evidence quotes or paraphrases

Implemented in:

```txt
lib/azure.ts -> analyzeCrisisSignals()
lib/azure.ts -> buildAnalysisPrompt()
```

## Step 8: Normalize Model Output

The backend validates and normalizes the model response before sending it to the frontend.

This prevents malformed model output from breaking the UI.

Examples:

- Missing severity becomes `medium`.
- Missing status becomes `needs-verification`.
- Confidence is clamped between `0` and `1`.
- Evidence quotes are limited to three.

Implemented in:

```txt
lib/azure.ts -> normalizeAnalysis()
lib/azure.ts -> normalizeIncident()
```

## Step 9: Geocode Incident Locations

After incidents are extracted, the backend geocodes specific locations with OpenStreetMap Nominatim.

This improves country-wide scans. For example, if the region is `India` but an incident location is `Colaba, Mumbai`, the map point is placed on Mumbai/Colaba instead of the center of India.

The map no longer creates fake offset markers for incidents with no coordinates. If a location cannot be geocoded, it remains visible in the incident list but is not plotted as a precise map point.

Implemented in:

```txt
lib/geocode.ts -> geocodeIncidents()
app/components/CrisisMap.tsx
```

## Step 10: Fallback Behavior

There are two different failure paths:

### Source Collection Failure

If Anakin search or source collection fails completely, the API returns an error.

It does not generate fake disaster data.

Current behavior:

```txt
HTTP 502
```

This is intentional because fake disaster data would be misleading in a response tool.

### Azure Analysis Failure

If live sources were collected but Azure OpenAI fails, the app still produces a keyword-based triage pass from the real source text.

This fallback checks for operational signals like:

- rescue or stranded people
- hospital or medical needs
- road closures
- utility outages
- shelter or evacuation needs
- infrastructure damage
- rumors or misinformation

The fallback is clearly labeled with `fallbackReason`.

Implemented in:

```txt
app/api/scan/route.ts -> heuristicAnalysis()
```

## Step 11: Display Results

The frontend displays:

- `Operational Map`: plotted incidents when coordinates are available
- `Situation Brief`: short operational summary
- `Metrics`: incident count, severe count, official signals, source count
- `Incident Triage`: severity, confidence, status, action, and evidence
- `Source Evidence`: every scraped source title, URL, source type, and snippet
- `Search Strategy`: expanded queries, candidate locations, and model background context
- `Limitations`: gaps or uncertainty from the scan

Implemented in:

```txt
app/components/ScanConsole.tsx
app/components/CrisisMap.tsx
```

## End-To-End Flow

```txt
User input
  -> POST /api/scan
  -> validate request
  -> Azure OpenAI builds expanded search strategy
  -> build live disaster search prompts
  -> Anakin Search finds relevant public pages across multiple queries
  -> dedupe, rank, and select top sources
  -> Anakin URL Scraper extracts page content
  -> normalize sources
  -> Azure OpenAI extracts incidents
  -> add low-confidence candidate locations for verification
  -> geocode specific incident locations
  -> normalize incident JSON
  -> return source-backed response
  -> render map, brief, triage cards, and evidence list
```

## Current Limitations

- Reddit is not connected yet.
- X/Twitter is not connected yet.
- Coordinates depend on the model extracting usable locations from source text.
- The app does not dispatch responders or verify ground truth.
- It only shows public web intelligence leads for human review.

## Why This Is Useful

During disasters, local reports often appear before official consolidated bulletins. CrisisSignal helps an operator quickly turn scattered public web pages into a structured review queue:

- What happened?
- Where is it reported?
- How severe could it be?
- Which source supports it?
- What should a human verify next?
