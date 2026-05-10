"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Layer, Map as LeafletMap } from "leaflet";
import { Incident } from "@/lib/types";

const CITY_CENTERS: Record<string, [number, number]> = {
  india: [20.5937, 78.9629],
  "united states": [39.8283, -98.5795],
  usa: [39.8283, -98.5795],
  japan: [36.2048, 138.2529],
  philippines: [12.8797, 121.774],
  "united kingdom": [55.3781, -3.436],
  uk: [55.3781, -3.436],
  singapore: [1.3521, 103.8198],
  australia: [-25.2744, 133.7751],
  bhopal: [23.2599, 77.4126],
  mumbai: [19.076, 72.8777],
  delhi: [28.6139, 77.209],
  bengaluru: [12.9716, 77.5946],
  bangalore: [12.9716, 77.5946],
  chennai: [13.0827, 80.2707],
  kolkata: [22.5726, 88.3639],
  hyderabad: [17.385, 78.4867],
  "los angeles": [34.0522, -118.2437],
  houston: [29.7604, -95.3698],
  miami: [25.7617, -80.1918],
  "new york": [40.7128, -74.006]
};

export function CrisisMap({
  incidents,
  region,
  theme
}: {
  incidents: Incident[];
  region: string;
  theme: "dark" | "light";
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef<Layer[]>([]);

  const fallbackView = useMemo(() => resolveRegionView(region), [region]);
  const mapStats = useMemo(() => {
    const plotted = incidents.filter(
      (incident) => typeof incident.latitude === "number" && typeof incident.longitude === "number"
    );
    return {
      plotted: plotted.length,
      total: incidents.length,
      severe: incidents.filter(
        (incident) => incident.severity === "critical" || incident.severity === "high"
      ).length
    };
  }, [incidents]);

  useEffect(() => {
    let disposed = false;

    async function bootMap() {
      if (!elementRef.current || mapRef.current) return;
      const leaflet = await import("leaflet");
      if (disposed || !elementRef.current) return;

      const map = leaflet.map(elementRef.current, {
        zoomControl: true,
        attributionControl: true
      });
      map.setView(fallbackView.center, fallbackView.zoom);

      leaflet
        .tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 19,
            attribution: "Tiles &copy; Esri"
          }
        )
        .addTo(map);

      leaflet
        .tileLayer(
          "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 19,
            attribution: "Labels &copy; Esri"
          }
        )
        .addTo(map);

      mapRef.current = map;
    }

    bootMap();

    return () => {
      disposed = true;
      layersRef.current.forEach((layer) => layer.remove());
      layersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [fallbackView, theme]);

  useEffect(() => {
    async function syncMarkers() {
      const map = mapRef.current;
      if (!map) return;
      const leaflet = await import("leaflet");

      layersRef.current.forEach((layer) => layer.remove());
      layersRef.current = [];

      const points = incidents.flatMap((incident) => {
        if (typeof incident.latitude !== "number" || typeof incident.longitude !== "number") {
          return [];
        }
        return [{ incident, point: [incident.latitude, incident.longitude] as [number, number] }];
      });

      points.forEach(({ incident, point }) => {
        const color = severityColor(incident.severity);
        const heatRadius =
          incident.severity === "critical" ? 32000 : incident.severity === "high" ? 22000 : 14000;
        const heat = leaflet
          .circle(point, {
            radius: heatRadius,
            stroke: false,
            fillColor: color,
            fillOpacity: incident.severity === "low" ? 0.12 : 0.2
          })
          .addTo(map);
        const marker = leaflet
          .marker(point, {
            icon: leaflet.divIcon({
              className: "",
              html: `<div class="marker-dot marker-${incident.severity}"></div>`,
              iconSize: [18, 18],
              iconAnchor: [9, 9]
            })
          })
          .bindPopup(
            `<strong>${escapeHtml(incident.title)}</strong><br/>${escapeHtml(
              incident.location
            )}<br/>Severity: ${incident.severity}`
          )
          .addTo(map);
        layersRef.current.push(heat, marker);
      });

      if (points.length > 0) {
        const bounds = leaflet.latLngBounds(points.map((entry) => entry.point));
        map.fitBounds(bounds.pad(0.35), { maxZoom: 12 });
      } else {
        map.setView(fallbackView.center, fallbackView.zoom);
      }
    }

    syncMarkers();
  }, [fallbackView, incidents]);

  return (
    <div className="map-frame">
      <div ref={elementRef} className="map-surface" aria-label="Incident map" />
      <div className="map-overlay-panel">
        <span>Active Signals</span>
        <strong>{mapStats.total}</strong>
        <div>
          <small>{mapStats.plotted} mapped</small>
          <small>{mapStats.severe} severe</small>
        </div>
      </div>
      <div className="map-grid-overlay" aria-hidden="true" />
    </div>
  );
}

function resolveRegionView(region: string): { center: [number, number]; zoom: number } {
  const normalized = region.trim().toLowerCase();
  for (const [key, value] of Object.entries(CITY_CENTERS)) {
    if (normalized.includes(key)) {
      return { center: value, zoom: isCountryKey(key) ? 5 : 11 };
    }
  }
  return { center: [20.5937, 78.9629], zoom: 5 };
}

function isCountryKey(key: string) {
  return [
    "india",
    "united states",
    "usa",
    "japan",
    "philippines",
    "united kingdom",
    "uk",
    "singapore",
    "australia"
  ].includes(key);
}

function severityColor(severity: Incident["severity"]) {
  if (severity === "critical") return "#ef4444";
  if (severity === "high") return "#f97316";
  if (severity === "medium") return "#facc15";
  return "#22c55e";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
