"""Resumable, verified downloads into the raw data area."""

import hashlib
from pathlib import Path

import httpx

from dpg_audit.config import user_agent


def file_digest(path: Path, algorithm: str = "sha256") -> str:
    h = hashlib.new(algorithm)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, target: Path, *, expected_md5: str | None = None, quiet: bool = False) -> Path:
    """Download `url` to `target` (resuming a partial `.part` file) and optionally verify an MD5."""
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    offset = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": user_agent()}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    with (
        httpx.Client(timeout=httpx.Timeout(60.0, read=300.0), follow_redirects=True) as client,
        client.stream("GET", url, headers=headers) as resp,
    ):
        if resp.status_code != 416:  # 416: the partial file is already complete
            resp.raise_for_status()
            if offset and resp.status_code != 206:
                offset = 0  # server ignored the range: start again
            total = int(resp.headers.get("content-length", 0)) + offset
            done = offset
            next_report = done + (1 << 28)
            with open(part, "ab" if offset else "wb") as f:
                for chunk in resp.iter_bytes(1 << 20):
                    f.write(chunk)
                    done += len(chunk)
                    if not quiet and done >= next_report:
                        print(f"  {target.name}: {done / 1e9:.2f}/{total / 1e9:.2f} GB", flush=True)
                        next_report = done + (1 << 28)
    if expected_md5 and file_digest(part, "md5") != expected_md5.lower():
        part.unlink()
        raise RuntimeError(f"MD5 mismatch for {url}; partial file removed, please retry")
    part.replace(target)
    return target


def fetch_text(url: str) -> str:
    with httpx.Client(timeout=60.0, follow_redirects=True, headers={"User-Agent": user_agent()}) as client:
        resp = client.get(url)
        resp.raise_for_status()
        return resp.text
