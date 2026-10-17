import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./maplibre-worker";
import "./styles.css";
import { App } from "./App";
import { RiderApp } from "./rider/RiderApp";

// /plan is the rider view (M4): apart from the audit viewer, which is ours (D43).
const rider = window.location.pathname.startsWith("/plan");

createRoot(document.getElementById("root")!).render(<StrictMode>{rider ? <RiderApp /> : <App />}</StrictMode>);
