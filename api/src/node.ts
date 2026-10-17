/** Node entry point for local development on the laptop. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { FsBundleStore } from "./store";

// Optional repo-root .env (see .env.example), e.g. to read bundles from the Ubuntu (WSL) filesystem.
const envFile = resolve(import.meta.dirname, "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const dataDir = resolve(process.env.DPG_DATA_DIR ?? resolve(import.meta.dirname, "../../data"));
const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "127.0.0.1";

const app = createApp(new FsBundleStore(dataDir));

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Kilometrica API on http://${hostname}:${info.port} (data: ${dataDir})`);
});
