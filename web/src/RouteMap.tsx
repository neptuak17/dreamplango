import type { Finding, Place, UserPlace } from "@dpg/contracts";
import {
  AttributionControl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type GeoJSONSourceSpecification,
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
} from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { PathCollection, RideProps } from "./api";
import { distanceLabel, MONTHS, monthState, SERVICE_STYLE, seasonLabel } from "./services";
import { DEVELOPMENT, km, SEVERITY } from "./status";

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

const EMPTY = { type: "FeatureCollection" as const, features: [] };
const STATUS_LAYERS = ["route-signed", "route-unsigned"];

interface Props {
  path: PathCollection;
  /** Route coloured by an audit layer; null shows the EuroVelo status colouring. */
  overlay: { type: "FeatureCollection"; features: unknown[] } | null;
  findings: Finding[];
  places: Place[];
  /** Month (0-11) used to describe opening in place popups; null = any month. */
  month: number | null;
  /** The "what's ahead" position, drawn as a marker. */
  marker: [number, number] | null;
  attribution: string[];
  selectedSection: number | null;
  /** Sections to highlight and frame instead (a Dream stretch). */
  highlight?: number[] | null;
  selectedFinding: string | null;
  selectedPlace: string | null;
  /** A click on the route line: the section and the clicked point. */
  onClickRoute: (section: number, lngLat: [number, number]) => void;
  onClickEmpty: () => void;
  onSelectFinding: (id: string) => void;
  onSelectPlace: (id: string | null) => void;
  /** Reported after every zoom change (used to thin places). */
  onZoom?: (zoom: number) => void;
  /** Waypoints from the rider's own file (D24), drawn in their own style. */
  userPlaces?: UserPlace[];
}

function userPlacesGeoJSON(places: UserPlace[]) {
  return {
    type: "FeatureCollection" as const,
    features: places.map((p) => ({
      type: "Feature" as const,
      properties: { id: p.id },
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
    })),
  };
}

function userPlacePopup(p: UserPlace): HTMLElement {
  const root = document.createElement("div");
  root.className = "place-popup";
  line(root, p.name ?? "Unnamed waypoint", "pp-title");
  line(root, `your waypoint · ${p.kind.replaceAll("_", " ")} · km ${km(p.at_m, 1)}`, "pp-sub");
  if (p.offset_m >= 100) line(root, `${distanceLabel(p.offset_m)} from the route (straight line)`);
  if (p.note) line(root, p.note, "pp-note");
  line(root, "From your own file: private, and never counted in the audit's figures.", "pp-src");
  return root;
}

function placesGeoJSON(places: Place[]) {
  return {
    type: "FeatureCollection" as const,
    features: places.map((p) => ({
      type: "Feature" as const,
      properties: { id: p.id, color: SERVICE_STYLE[p.service]?.color ?? "#495057", counts: p.counts },
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
    })),
  };
}

function markerGeoJSON(marker: [number, number] | null) {
  return {
    type: "FeatureCollection" as const,
    features: marker ? [{ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: marker } }] : [],
  };
}

function line(parent: HTMLElement, text: string, className?: string) {
  const el = document.createElement("div");
  el.textContent = text;
  if (className) el.className = className;
  parent.appendChild(el);
  return el;
}

/** Popup content built with textContent: names and notes come from open data and must not be parsed as HTML. */
function placePopup(p: Place, month: number | null): HTMLElement {
  const root = document.createElement("div");
  root.className = "place-popup";
  line(root, p.name ?? `Unnamed ${p.kind.replaceAll("_", " ")}`, "pp-title");
  line(root, `${p.service.replaceAll("_", " ")} · ${p.kind.replaceAll("_", " ")} · km ${km(p.access_at_m, 1)}`, "pp-sub");
  const access = p.access_m === null ? "no route found by bike" : `${distanceLabel(p.access_m)} off route`;
  const time = p.access_min !== null ? `, ~${Math.round(p.access_min)} min` : "";
  const climb = p.climb_m ? `, +${p.climb_m} m` : "";
  line(root, `${access}${time}${climb}${p.counts ? "" : " (beyond the counting limit)"}`);
  const state = monthState(p, month);
  const season = seasonLabel(p.months);
  const when = month === null ? "" : `${MONTHS[month]}: ${state === "partly" ? "season starts or ends this month" : state}`;
  line(root, [when, season ? `season ${season}` : "no published season"].filter(Boolean).join(" · "));
  if (p.opening_hours) line(root, p.opening_hours, "pp-mono");
  const d = p.detail as Record<string, unknown>;
  if (p.service === "station") {
    line(root, `Bikes: ${String(d.bikes ?? "unknown")} (${String(d.bike_confidence ?? "low")} confidence)`, "pp-strong");
    if (d.bike_note) line(root, String(d.bike_note), "pp-note");
  }
  if (d.temporarily_closed) line(root, "Overture marks this place as temporarily closed.", "pp-note");
  if (typeof d.website === "string" && /^https?:\/\//.test(d.website)) {
    const a = document.createElement("a");
    a.href = d.website;
    a.textContent = "website";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    root.appendChild(a);
  }
  line(root, `${p.sources.join(", ")} · ${p.confidence} confidence`, "pp-src");
  return root;
}

/** The sections to frame and highlight: a Dream stretch, else the selected section, else none (whole route). */
function focusOf(p: { highlight?: number[] | null; selectedSection: number | null }): number[] | undefined {
  if (p.highlight?.length) return p.highlight;
  return p.selectedSection !== null ? [p.selectedSection] : undefined;
}

function boundsOf(path: PathCollection, sections?: number[]): LngLatBounds | null {
  const bounds = new LngLatBounds();
  let any = false;
  for (const f of path.features) {
    if (f.properties.kind !== "ride") continue;
    if (sections !== undefined && !sections.includes(f.properties.section)) continue;
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
  const popup = useRef<Popup | null>(null);
  const ready = useRef(false);
  /** Set once the rider pans or zooms; until then the map keeps re-framing the route. */
  const userMoved = useRef(false);
  const latest = useRef(props);
  latest.current = props;

  // Create the map once per route geometry.
  useEffect(() => {
    if (!container.current) return;
    // Open directly on the selected section (or the whole route) so no tiles are fetched for a throwaway view.
    const initial = boundsOf(props.path, focusOf(latest.current)) ?? boundsOf(props.path);
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
    map.current = m;

    // Keep the route framed while the page settles (and when the window or panels resize), until the rider
    // pans or zooms the map themselves.
    userMoved.current = false;
    const frame = () => {
      if (userMoved.current) return;
      const b = boundsOf(props.path, focusOf(latest.current)) ?? boundsOf(props.path);
      if (b) m.fitBounds(b, { padding: 48, maxZoom: 12, animate: false });
    };
    m.on("movestart", (e) => {
      if ((e as { originalEvent?: Event }).originalEvent) userMoved.current = true;
    });
    m.once("load", () => {
      collapse();
      frame();
    });
    // MapLibre tracks its container's size itself; re-frame after it has resized.
    m.on("resize", frame);
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
      const overlay = latest.current.overlay;
      m.addSource("overlay", { type: "geojson", data: (overlay ?? EMPTY) as GeoJSONSourceSpecification["data"] });
      m.addLayer({
        id: "overlay-line",
        type: "line",
        source: "overlay",
        layout: { "line-cap": "butt", "line-join": "round", visibility: overlay ? "visible" : "none" },
        paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 6] },
      });
      if (overlay) for (const id of STATUS_LAYERS) m.setLayoutProperty(id, "visibility", "none");
      m.addLayer({
        id: "gaps",
        type: "line",
        source: "route",
        filter: ["==", ["get", "kind"], "gap"],
        paint: {
          "line-color": ["match", ["get", "gap_type"], "ferry", "#3f51b5", "public_transport", "#7b3294",
            "missing", "#d7301f", "#495057"],
          "line-width": 1.8,
          "line-dasharray": [1, 2.5],
        },
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
      m.addSource("places", { type: "geojson", data: placesGeoJSON(latest.current.places) });
      m.addLayer({
        id: "places-selected",
        type: "circle",
        source: "places",
        filter: ["==", ["get", "id"], ""],
        paint: { "circle-radius": 11, "circle-color": "#1c7ed6", "circle-opacity": 0.3 },
      });
      m.addLayer({
        id: "places",
        type: "circle",
        source: "places",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 2.5, 13, 6],
          "circle-color": ["get", "color"],
          "circle-opacity": ["case", ["get", "counts"], 1, 0.35],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 7, 0.5, 13, 1.5],
        },
      });
      m.addSource("user-places", { type: "geojson", data: userPlacesGeoJSON(latest.current.userPlaces ?? []) });
      m.addLayer({
        id: "user-places",
        type: "circle",
        source: "user-places",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 4, 13, 7],
          "circle-color": "#ffffff",
          "circle-stroke-color": "#7048e8",
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 7, 2, 13, 3],
        },
      });
      m.addSource("ahead", { type: "geojson", data: markerGeoJSON(latest.current.marker) });
      m.addLayer({
        id: "ahead",
        type: "circle",
        source: "ahead",
        paint: { "circle-radius": 8, "circle-color": "#ffffff", "circle-stroke-color": "#1c7ed6", "circle-stroke-width": 4 },
      });

      const clickable = ["user-places", "places", "findings", "overlay-line", "route-signed", "route-unsigned"];
      for (const layer of clickable) {
        m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
      }
      m.on("click", (e) => {
        const hits = m.queryRenderedFeatures(e.point, { layers: clickable.filter((id) => m.getLayer(id)) });
        const hit = hits[0];
        if (!hit) return latest.current.onClickEmpty();
        if (hit.layer.id === "user-places") {
          const p = latest.current.userPlaces?.find((x) => x.id === String(hit.properties.id));
          if (p) new Popup({ offset: 10 }).setLngLat([p.lon, p.lat]).setDOMContent(userPlacePopup(p)).addTo(m);
        } else if (hit.layer.id === "places") latest.current.onSelectPlace(String(hit.properties.id));
        else if (hit.layer.id === "findings") latest.current.onSelectFinding(String(hit.properties.id));
        else latest.current.onClickRoute(Number((hit.properties as RideProps).section), [e.lngLat.lng, e.lngLat.lat]);
      });

      m.on("zoomend", () => latest.current.onZoom?.(m.getZoom()));
      latest.current.onZoom?.(m.getZoom());

      ready.current = true;
      const focus = focusOf(latest.current);
      if (focus) m.setFilter("route-selected", ["in", ["get", "section"], ["literal", focus]]);
    });

    return () => {
      ready.current = false;
      const open = popup.current;
      popup.current = null;
      open?.remove();
      m.remove();
      map.current = null;
    };
    // Rebuilt only when the route itself changes; other props are applied by the effects below.
  }, [props.path]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    (m.getSource("places") as GeoJSONSource | undefined)?.setData(placesGeoJSON(props.places));
  }, [props.places]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    (m.getSource("user-places") as GeoJSONSource | undefined)?.setData(userPlacesGeoJSON(props.userPlaces ?? []));
  }, [props.userPlaces]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    (m.getSource("ahead") as GeoJSONSource | undefined)?.setData(markerGeoJSON(props.marker));
  }, [props.marker]);

  useEffect(() => {
    const m = map.current;
    const old = popup.current;
    popup.current = null; // before remove(): its close event must not clear the new selection
    old?.remove();
    if (!m || !ready.current) return;
    m.setFilter("places-selected", ["==", ["get", "id"], props.selectedPlace ?? ""]);
    const p = props.places.find((x) => x.id === props.selectedPlace);
    if (!p) return;
    const pop = new Popup({ closeButton: true, maxWidth: "300px", offset: 10 })
      .setLngLat([p.lon, p.lat])
      .setDOMContent(placePopup(p, props.month))
      .addTo(m);
    pop.on("close", () => {
      if (popup.current === pop) latest.current.onSelectPlace(null);
    });
    popup.current = pop;
    if (!m.getBounds().contains([p.lon, p.lat])) m.easeTo({ center: [p.lon, p.lat] });
  }, [props.selectedPlace, props.places, props.month]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    (m.getSource("findings") as GeoJSONSource | undefined)?.setData(findingsGeoJSON(props.findings));
  }, [props.findings]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const overlay = props.overlay;
    (m.getSource("overlay") as GeoJSONSource | undefined)?.setData(
      (overlay ?? EMPTY) as Parameters<GeoJSONSource["setData"]>[0],
    );
    m.setLayoutProperty("overlay-line", "visibility", overlay ? "visible" : "none");
    for (const id of STATUS_LAYERS) m.setLayoutProperty(id, "visibility", overlay ? "none" : "visible");
  }, [props.overlay]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const focus = focusOf(props);
    m.setFilter("route-selected", ["in", ["get", "section"], ["literal", focus ?? []]]);
    if (focus && props.selectedFinding === null) {
      const b = boundsOf(props.path, focus);
      if (b) {
        userMoved.current = false; // a newly chosen section stays framed through later resizes
        m.fitBounds(b, { padding: 64, maxZoom: 12 });
      }
    }
    // The highlight array is rebuilt on every render; its contents are what matter.
  }, [props.selectedSection, props.highlight?.join(","), props.selectedFinding, props.path]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current || props.selectedFinding === null) return;
    const f = props.findings.find((x) => x.id === props.selectedFinding);
    if (f?.position) m.flyTo({ center: f.position, zoom: Math.max(m.getZoom(), 10) });
  }, [props.selectedFinding, props.findings]);

  return <div className="map" ref={container} />;
}
