# DreamPlanGo

Route audits and Dream–Plan–Go trip support for long-distance cycle routes, starting with EuroVelo 8. Design, decisions and roadmap: [docs/DESIGN.md](docs/DESIGN.md).

**Status:** milestone M0 (foundations) is done. The engine ingests the official EV8 GPX into an Audit Bundle, a local API serves it, and a web viewer shows sections, development status, data-quality findings and the elevation profile.

## Layout

| Path | What |
|---|---|
| `engine/` | Python Route Audit Engine (`dpg` CLI), managed with uv |
| `api/` | TypeScript HTTP API (Hono). Runs on Node now, Cloudflare Workers later |
| `web/` | Prototype viewer (Vite + React + MapLibre) |
| `packages/contracts/` | TypeScript types generated from `schemas/` |
| `schemas/` | JSON Schema of the bundle format (generated from the engine's models) |
| `docs/` | Design, data-licence register, notes |
| `data/` | Raw downloads and bundles (git-ignored) |

## Prerequisites

- Python 3.12+ and [uv](https://docs.astral.sh/uv/) **on your PATH**. On Windows, install it from a normal PowerShell window with `python -m pip install --user uv`, then run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\add-uv-to-path.ps1` (add `-DryRun` to preview). Per-user installs made from inside the Claude desktop app land in that app's private AppData and aren't visible to other programs.
- Node.js 24+ (npm 11+).
- From milestone M1: WSL2 (Ubuntu 24.04) and Docker. See [docs/setup/wsl-and-docker.md](docs/setup/wsl-and-docker.md).

## First run

```bash
npm install
(cd engine && uv sync)
npm run fetch:ev8      # download the official EV8 GPX into data/raw/
npm run ingest:ev8     # build an Audit Bundle into data/bundles/
npm run dev            # API on http://127.0.0.1:8787, viewer on http://localhost:5173
```

## Other tasks

| Command | Does |
|---|---|
| `npm test` | Engine tests (pytest + hypothesis) and API tests (vitest) |
| `npm run typecheck` | TypeScript checks for all workspaces |
| `npm run engine:lint` | ruff |
| `npm run contracts` | Re-export the JSON Schema and regenerate `packages/contracts` after changing engine models |
| `uv run --project engine dpg inspect <file.gpx>` | Summarise any GPX file |

## Data attribution

Bundles contain information from EuroVelo GPX tracks downloaded from www.EuroVelo.com, made available under the Open Database License (ODbL). See [docs/DATA-LICENSES.md](docs/DATA-LICENSES.md). EuroVelo® is a registered trademark of the European Cyclists' Federation. This project is not affiliated with or endorsed by ECF.
