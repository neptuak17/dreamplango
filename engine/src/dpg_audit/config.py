"""Paths and runtime settings. Everything is overridable by environment variables."""

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def data_dir() -> Path:
    """Root of raw/, cache/, work/ and bundles/. Defaults to <repo>/data."""
    return Path(os.environ.get("DPG_DATA_DIR", REPO_ROOT / "data")).resolve()


def user_agent() -> str:
    """HTTP User-Agent. Set DPG_CONTACT (e.g. an email) for providers that require contact details."""
    from dpg_audit import __version__

    contact = os.environ.get("DPG_CONTACT")
    base = f"DreamPlanGo-prototype/{__version__}"
    return f"{base} ({contact})" if contact else base
