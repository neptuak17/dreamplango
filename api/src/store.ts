/**
 * Read access to Audit Bundles. The filesystem store serves the laptop setup; an R2-backed store with the same
 * interface replaces it on Cloudflare.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BundleManifest, CurrentPointer } from "@dpg/contracts";

export const BUNDLE_FILES = {
  manifest: "manifest.json",
  path: "path.geojson",
  sections: "sections.json",
  findings: "findings.json",
  profile: "profile.json",
  events: "events.json",
  minor: "minor.json",
  scores: "scores.json",
} as const;

export type BundleFile = keyof typeof BUNDLE_FILES;

export interface BundleStore {
  /** Every network/route pair that has a current bundle. */
  routes(): Promise<{ network: string; ref: string }[]>;
  /** Run id of the route's current bundle, or null if the route has none. */
  currentRun(network: string, ref: string): Promise<string | null>;
  /** Raw text of one bundle file, or null if missing. */
  readFile(network: string, ref: string, runId: string, file: BundleFile): Promise<string | null>;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function dirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export class FsBundleStore implements BundleStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "bundles");
  }

  async routes() {
    const out: { network: string; ref: string }[] = [];
    for (const network of await dirs(this.root)) {
      for (const ref of await dirs(join(this.root, network))) {
        if ((await this.currentRun(network, ref)) !== null) out.push({ network, ref });
      }
    }
    return out;
  }

  async currentRun(network: string, ref: string) {
    const text = await readOrNull(join(this.root, network, ref, "current.json"));
    return text === null ? null : (JSON.parse(text) as CurrentPointer).run_id;
  }

  async readFile(network: string, ref: string, runId: string, file: BundleFile) {
    return readOrNull(join(this.root, network, ref, runId, BUNDLE_FILES[file]));
  }
}

export async function readManifest(store: BundleStore, network: string, ref: string, runId: string) {
  const text = await store.readFile(network, ref, runId, "manifest");
  return text === null ? null : (JSON.parse(text) as BundleManifest);
}
