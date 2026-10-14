/**
 * MapLibre 6 ships its worker as a separate ES module. Bundle it with Vite (`?worker&url`) and point MapLibre at
 * the emitted file, so the worker loads both from the dev server and from a production build.
 */
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
