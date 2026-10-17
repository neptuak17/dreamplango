/**
 * The plan on a map (11.6): the stretch day by day, the night stops, gaps, and the selected day's heads-ups and
 * highlights. MapLibre with the OpenFreeMap basemap, as in the audit viewer.
 */
import { dayItems, type Geometry, type PlanResult, slice } from "@dpg/planner";
import {
  AttributionControl,
  type GeoJSONSource,
  type GeoJSONSourceSpecification,
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
} from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";

const BASEMAP = "https://tiles.openfreemap.org/styles/positron";
type FC = { type: "FeatureCollection"; features: unknown[] };
const fc = (features: unknown[]): FC => ({ type: "FeatureCollection", features });

interface Props {
  geometry: Geometry;
  plan: PlanResult;
  selectedDay: number | null;
  onSelectDay: (n: number | null) => void;
  attribution: string[];
}

function tripFeatures(geo: Geometry, plan: PlanResult) {
  const days = [];
  for (const d of plan.days) {
    if (d.kind !== "ride") continue;
    for (const seg of slice(geo, d.fromM, d.toM)) {
      days.push({ type: "Feature", properties: { day: d.number, odd: d.number % 2 }, geometry: { type: "LineString", coordinates: seg } });
    }
  }
  const lo = Math.min(plan.inputs.fromM, plan.inputs.toM);
  const hi = Math.max(plan.inputs.fromM, plan.inputs.toM);
  const gaps = geo.gaps
    .filter((g) => g.atM > lo && g.atM < hi && g.type !== "discontinuity")
    .map((g) => ({ type: "Feature", properties: { type: g.type }, geometry: { type: "LineString", coordinates: [g.start, g.end] } }));
  const stops = plan.nights.map((n) => ({
    type: "Feature",
    properties: { label: String(n.afterRide), name: n.stop.name ?? "" },
    geometry: { type: "Point", coordinates: [n.stop.lon, n.stop.lat] },
  }));
  return { days: fc(days), gaps: fc(gaps), stops: fc(stops) };
}

function itemFeatures(geo: Geometry, plan: PlanResult, day: number | null) {
  if (day === null) return fc([]);
  const mine = dayItems(plan.items, day);
  const out = [];
  for (const i of [...mine.headsups.shown, ...mine.highlights.shown]) {
    if (i.fromM === null) continue;
    const seg = slice(geo, i.fromM, i.fromM + 1)[0];
    const at = seg?.[0];
    if (!at) continue;
    out.push({ type: "Feature", properties: { kind: i.kind, title: i.title }, geometry: { type: "Point", coordinates: at } });
  }
  return fc(out);
}

function boundsOf(features: FC, day: number | null): LngLatBounds | null {
  const b = new LngLatBounds();
  let any = false;
  for (const f of features.features as { properties: { day: number }; geometry: { coordinates: [number, number][] } }[]) {
    if (day !== null && f.properties.day !== day) continue;
    for (const c of f.geometry.coordinates) {
      b.extend(c);
      any = true;
    }
  }
  return any ? b : null;
}

export function PlanMap({ geometry, plan, selectedDay, onSelectDay, attribution }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const userMoved = useRef(false);
  const trip = useMemo(() => tripFeatures(geometry, plan), [geometry, plan]);
  const items = useMemo(() => itemFeatures(geometry, plan, selectedDay), [geometry, plan, selectedDay]);
  const latest = useRef({ trip, items, selectedDay, onSelectDay });
  latest.current = { trip, items, selectedDay, onSelectDay };

  useEffect(() => {
    if (!container.current) return;
    const initial = boundsOf(latest.current.trip.days, latest.current.selectedDay) ?? boundsOf(latest.current.trip.days, null);
    const m = new MapLibreMap({
      container: container.current,
      style: BASEMAP,
      attributionControl: false,
      ...(initial ? { bounds: initial, fitBoundsOptions: { padding: 40, maxZoom: 12 } } : { center: [10, 43], zoom: 5 }),
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    m.addControl(new AttributionControl({ compact: true, customAttribution: attribution }), "bottom-right");
    // Start with the attribution collapsed to its (i) button; it expands on click.
    const el = container.current;
    const collapse = () => el.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    collapse();
    m.once("load", collapse);
    map.current = m;
    // On a phone the map is created hidden and shown when a day opens: re-frame the selection whenever it resizes,
    // until the rider pans or zooms it themselves.
    const frame = () => {
      if (userMoved.current) return;
      const { trip: t, selectedDay: day } = latest.current;
      const b = boundsOf(t.days, day) ?? boundsOf(t.days, null);
      if (b) m.fitBounds(b, { padding: 40, maxZoom: 13, animate: false });
    };
    m.on("movestart", (e) => {
      if ((e as { originalEvent?: Event }).originalEvent) userMoved.current = true;
    });
    m.on("resize", frame);
    m.once("style.load", () => {
      const { trip: t, items: it } = latest.current;
      m.addSource("route", {
        type: "geojson",
        data: fc(geometry.lines.map((l) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l.coords } }))) as GeoJSONSourceSpecification["data"],
      });
      m.addSource("days", { type: "geojson", data: t.days as GeoJSONSourceSpecification["data"] });
      m.addSource("gaps", { type: "geojson", data: t.gaps as GeoJSONSourceSpecification["data"] });
      m.addSource("stops", { type: "geojson", data: t.stops as GeoJSONSourceSpecification["data"] });
      m.addSource("items", { type: "geojson", data: it as GeoJSONSourceSpecification["data"] });
      m.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#adb5bd", "line-width": 2 } });
      m.addLayer({ id: "days-casing", type: "line", source: "days", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 7 } });
      m.addLayer({
        id: "days",
        type: "line",
        source: "days",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["match", ["get", "odd"], 1, "#1c7ed6", "#0c8599"], "line-width": 4 },
      });
      m.addLayer({
        id: "day-selected",
        type: "line",
        source: "days",
        filter: ["==", ["get", "day"], latest.current.selectedDay ?? -1],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#f08c00", "line-width": 6 },
      });
      m.addLayer({
        id: "gaps",
        type: "line",
        source: "gaps",
        paint: {
          "line-color": ["match", ["get", "type"], "ferry", "#3f51b5", "public_transport", "#7b3294", "#d7301f"],
          "line-width": 2.5,
          "line-dasharray": [1, 2],
        },
      });
      m.addLayer({
        id: "items",
        type: "circle",
        source: "items",
        paint: {
          "circle-radius": 6,
          "circle-color": ["match", ["get", "kind"], "highlight", "#2f9e44", "#e03131"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });
      m.addLayer({ id: "stops", type: "circle", source: "stops", paint: { "circle-radius": 9, "circle-color": "#212529", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
      m.addLayer({
        id: "stop-labels",
        type: "symbol",
        source: "stops",
        layout: { "text-field": ["get", "label"], "text-size": 11, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true },
        paint: { "text-color": "#ffffff" },
      });
      m.on("click", "days", (e) => {
        const f = e.features?.[0];
        if (f) latest.current.onSelectDay(Number(f.properties?.day));
      });
      m.on("mouseenter", "days", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "days", () => (m.getCanvas().style.cursor = ""));
      ready.current = true;
    });
    return () => {
      ready.current = false;
      m.remove();
      map.current = null;
    };
    // The map is created once per route geometry; later changes go through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    (m.getSource("days") as GeoJSONSource | undefined)?.setData(trip.days as GeoJSONSourceSpecification["data"] & object);
    (m.getSource("gaps") as GeoJSONSource | undefined)?.setData(trip.gaps as GeoJSONSourceSpecification["data"] & object);
    (m.getSource("stops") as GeoJSONSource | undefined)?.setData(trip.stops as GeoJSONSourceSpecification["data"] & object);
  }, [trip]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    (m.getSource("items") as GeoJSONSource | undefined)?.setData(items as GeoJSONSourceSpecification["data"] & object);
  }, [items]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    userMoved.current = false; // a new selection frames the map again
    const apply = () => {
      if (m.getLayer("day-selected")) m.setFilter("day-selected", ["==", ["get", "day"], selectedDay ?? -1]);
      const b = boundsOf(trip.days, selectedDay) ?? boundsOf(trip.days, null);
      if (b) m.fitBounds(b, { padding: 40, maxZoom: 13, duration: 400 });
    };
    if (ready.current) apply();
    else m.once("style.load", apply);
  }, [selectedDay, trip]);

  return <div className="plan-map" ref={container} />;
}
