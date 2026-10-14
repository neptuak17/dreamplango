import type { Finding } from "@dpg/contracts";
import {
  AttributionControl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type GeoJSONSourceSpecification,
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
} from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { PathCollection, RideProps } from "./api";
import { DEVELOPMENT, SEVERITY } from "./status";

const BASEMAP = "https://tiles.openfreemap.org/styles/positron";

const developmentColor = [
  "match",
  ["get", "development"],
  ...Object.entries(DEVELOPMENT).flatMap(([k, v]) => [k, v.color]),
  "#000000",
] as unknown as ExpressionSpecification;

const severityColor = [
  "match",
  ["get", "severity"],
  ...Object.entries(SEVERITY).flatMap(([k, v]) => [k, v.color]),
  "#000000",
] as unknown as ExpressionSpecification;

interface Props {
  path: PathCollection;
  findings: Finding[];
  attribution: string[];
  selectedSection: number | null;
  selectedFinding: string | null;
  onSelectSection: (section: number | null) => void;
  onSelectFinding: (id: string) => void;
}

function boundsOf(path: PathCollection, section?: number): LngLatBounds | null {
  const bounds = new LngLatBounds();
  let any = false;
  for (const f of path.features) {
    if (f.properties.kind !== "ride") continue;
    if (section !== undefined && f.properties.section !== section) continue;
    for (const c of f.geometry.coordinates) {
      bounds.extend(c);
      any = true;
    }
  }
  return any ? bounds : null;
}

function findingsGeoJSON(findings: Finding[]) {
  return {
    type: "FeatureCollection" as const,
    features: findings
      .filter((f) => f.position)
      .map((f) => ({
        type: "Feature" as const,
        properties: { id: f.id, severity: f.severity, title: f.title },
        geometry: { type: "Point" as const, coordinates: f.position! },
      })),
  };
}

export function RouteMap(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const latest = useRef(props);
  latest.current = props;

  // Create the map once per route geometry.
  useEffect(() => {
    if (!container.current) return;
    // Open directly on the selected section (or the whole route) so no tiles are fetched for a throwaway view.
    const initial = boundsOf(props.path, latest.current.selectedSection ?? undefined) ?? boundsOf(props.path);
    const m = new MapLibreMap({
      container: container.current,
      style: BASEMAP,
      attributionControl: false,
      ...(initial ? { bounds: initial, fitBoundsOptions: { padding: 48, maxZoom: 12 } } : { center: [15, 41], zoom: 4 }),
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    m.addControl(new AttributionControl({ compact: true, customAttribution: props.attribution }), "bottom-right");
    // Start with the attribution collapsed to its (i) button; it expands on click.
    const el = container.current;
    const collapse = () => el.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    collapse();
    m.once("load", collapse);
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __dpgMap?: MapLibreMap }).__dpgMap = m;

    // Add our layers as soon as the basemap style is parsed, without waiting for its tiles.
    m.once("style.load", () => {
      m.addSource("route", { type: "geojson", data: props.path as unknown as GeoJSONSourceSpecification["data"] });
      m.addSource("findings", { type: "geojson", data: findingsGeoJSON(props.findings) });
      const ride: ExpressionSpecification = ["==", ["get", "kind"], "ride"];
      m.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        filter: ride,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 6 },
      });
      m.addLayer({
        id: "route-selected",
        type: "line",
        source: "route",
        filter: ["==", ["get", "section"], -1],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#1c7ed6", "line-width": 11, "line-opacity": 0.45 },
      });
      m.addLayer({
        id: "route-signed",
        type: "line",
        source: "route",
        filter: ["all", ride, ["==", ["get", "signage"], "signed"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": developmentColor, "line-width": 3.5 },
      });
      m.addLayer({
        id: "route-unsigned",
        type: "line",
        source: "route",
        filter: ["all", ride, ["!=", ["get", "signage"], "signed"]],
        layout: { "line-join": "round" },
        paint: { "line-color": developmentColor, "line-width": 3.5, "line-dasharray": [2, 1.2] },
      });
      m.addLayer({
        id: "gaps",
        type: "line",
        source: "route",
        filter: ["==", ["get", "kind"], "gap"],
        paint: { "line-color": "#343a40", "line-width": 1.5, "line-dasharray": [1, 2.5] },
      });
      m.addLayer({
        id: "findings",
        type: "circle",
        source: "findings",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3, 10, 6],
          "circle-color": severityColor,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });

      for (const layer of ["route-signed", "route-unsigned", "findings"]) {
        m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
      }
      m.on("click", (e) => {
        const hits = m.queryRenderedFeatures(e.point, { layers: ["findings", "route-signed", "route-unsigned"] });
        const hit = hits[0];
        if (!hit) return latest.current.onSelectSection(null);
        if (hit.layer.id === "findings") latest.current.onSelectFinding(String(hit.properties.id));
        else latest.current.onSelectSection(Number((hit.properties as RideProps).section));
      });

      ready.current = true;
      const { selectedSection } = latest.current;
      if (selectedSection !== null) m.setFilter("route-selected", ["==", ["get", "section"], selectedSection]);
    });

    return () => {
      ready.current = false;
      m.remove();
      map.current = null;
    };
    // Rebuilt only when the route itself changes; other props are applied by the effects below.
  }, [props.path]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    (m.getSource("findings") as GeoJSONSource | undefined)?.setData(findingsGeoJSON(props.findings));
  }, [props.findings]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    m.setFilter("route-selected", ["==", ["get", "section"], props.selectedSection ?? -1]);
    if (props.selectedSection !== null && props.selectedFinding === null) {
      const b = boundsOf(props.path, props.selectedSection);
      if (b) m.fitBounds(b, { padding: 64, maxZoom: 12 });
    }
  }, [props.selectedSection, props.selectedFinding, props.path]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current || props.selectedFinding === null) return;
    const f = props.findings.find((x) => x.id === props.selectedFinding);
    if (f?.position) m.flyTo({ center: f.position, zoom: Math.max(m.getZoom(), 10) });
  }, [props.selectedFinding, props.findings]);

  return <div className="map" ref={container} />;
}
