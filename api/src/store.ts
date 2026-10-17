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
  places: "places.json",
  services: "services.json",
  dream: "dream.json",
  user_places: "user_places.json",
} as const;

export type BundleFile = keyof typeof BUNDLE_FILES;

export interface BundleStore {
  /** Every public network/route pair that has a current bundle. Private routes are never listed (D25). */
  routes(): Promise<{ network: string; ref: string }[]>;
  /** Whether the route is private (a rider's own route, D25): served only by its id, never cached publicly. */
  isPrivate(network: string, ref: string): Promise<boolean>;
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

/** Where private bundles live, apart from public ones (D25). Never a network name. */
export const PRIVATE_DIR = "private";

export class FsBundleStore implements BundleStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "bundles");
  }

  /** The route's folder: public bundles under bundles/<network>/<ref>, private ones under bundles/private/. */
  private async locate(network: string, ref: string): Promise<{ dir: string; current: string; isPrivate: boolean } | null> {
    const candidates: [string, boolean][] = [
      [join(this.root, network, ref), false],
      [join(this.root, PRIVATE_DIR, network, ref), true],
    ];
    for (const [dir, isPrivate] of candidates) {
      const text = await readOrNull(join(dir, "current.json"));
      if (text !== null) return { dir, current: (JSON.parse(text) as CurrentPointer).run_id, isPrivate };
    }
    return null;
  }

  async routes() {
    const out: { network: string; ref: string }[] = [];
    for (const network of await dirs(this.root)) {
      if (network === PRIVATE_DIR) continue;
      for (const ref of await dirs(join(this.root, network))) {
        if ((await readOrNull(join(this.root, network, ref, "current.json"))) !== null) out.push({ network, ref });
      }
    }
    return out;
  }

  async isPrivate(network: string, ref: string) {
    return (await this.locate(network, ref))?.isPrivate ?? false;
  }

  async currentRun(network: string, ref: string) {
    return (await this.locate(network, ref))?.current ?? null;
  }

  async readFile(network: string, ref: string, runId: string, file: BundleFile) {
    const route = await this.locate(network, ref);
    return route === null ? null : readOrNull(join(route.dir, runId, BUNDLE_FILES[file]));
  }
}

export async function readManifest(store: BundleStore, network: string, ref: string, runId: string) {
  const text = await store.readFile(network, ref, runId, "manifest");
  return text === null ? null : (JSON.parse(text) as BundleManifest);
}
