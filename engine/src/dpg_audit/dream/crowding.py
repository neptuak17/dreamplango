"""Crowding inputs per country and month: school and public holidays (OpenHolidays API) and tourist nights
(Eurostat `tour_occ_nim`). Countries a source doesn't cover get None, never a guess (D37)."""

import json
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx

from dpg_audit.config import user_agent
from dpg_audit.models import Licence, SourceSnapshot

OPENHOLIDAYS = "https://openholidaysapi.org"
EUROSTAT = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/tour_occ_nim"
EUROSTAT_GEO = {"GR": "EL"}  # Eurostat's code for Greece

OH_LICENCE = Licence(
    id="OpenHolidays", name="OpenHolidays API open data (licence terms to confirm before launch)", url=OPENHOLIDAYS
)
EUROSTAT_LICENCE = Licence(
    id="Eurostat-reuse",
    name="Eurostat copyright notice: reuse authorised, with acknowledgement",
    url="https://ec.europa.eu/eurostat/about-us/policies/copyright",
)


@dataclass
class CountryCrowding:
    school_days: list[float | None]
    school_year: int | None
    public_holidays: list[float | None]
    public_year: int | None
    tourism_index: list[float | None]
    tourism_years: str | None


NONE12: list[float | None] = [None] * 12
SUMMER_GAP = {6, 7, 8, 9}
"""Months whose school holidays OpenHolidays does not record (summer breaks)."""


class CrowdingSource:
    def __init__(self, cache: Path, season_year: int):
        self.cache = cache
        self.year = season_year
        self.client = httpx.Client(timeout=60, headers={"User-Agent": user_agent()})
        self.files: dict[str, list[Path]] = {"openholidays": [], "eurostat": []}

    def close(self) -> None:
        self.client.close()

    def _get_json(self, url: str, params: dict, name: str, group: str) -> object:
        path = self.cache / group / name
        if not path.exists():
            resp = self.client.get(url, params=params)
            resp.raise_for_status()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(resp.text, encoding="utf-8")
        self.files[group].append(path)
        return json.loads(path.read_text(encoding="utf-8"))

    # --- OpenHolidays ---------------------------------------------------------------------------------------

    def _oh(self, endpoint: str, cc: str, year: int | None = None) -> list[dict]:
        params: dict = {"countryIsoCode": cc, "languageIsoCode": "EN"}
        name = f"{endpoint.lower()}-{cc}.json"
        if year is not None:
            params.update(validFrom=f"{year}-01-01", validTo=f"{year}-12-31")
            name = f"{endpoint.lower()}-{cc}-{year}.json"
        data = self._get_json(f"{OPENHOLIDAYS}/{endpoint}", params, name, "openholidays")
        return data if isinstance(data, list) else []

    def covered(self) -> set[str]:
        data = self._get_json(f"{OPENHOLIDAYS}/Countries", {"languageIsoCode": "EN"}, "countries.json", "openholidays")
        return {c["isoCode"] for c in data} if isinstance(data, list) else set()

    def _latest(self, endpoint: str, cc: str) -> tuple[list[dict], int | None]:
        """Entries from the latest published year up to the season year (the year is reported, never hidden)."""
        for year in (self.year, self.year - 1, self.year - 2):
            entries = self._oh(endpoint, cc, year)
            if entries:
                return entries, year
        return [], None

    def school(self, cc: str) -> tuple[list[float | None], int | None]:
        """Share of the country's top-level regions on school holiday, per month.

        OpenHolidays does not record summer school breaks (only markers such as "End of lessons"), so June to
        September are reported as no data rather than as "no holidays" (D37)."""
        entries, year = self._latest("SchoolHolidays", cc)
        if year is None:
            return NONE12, None
        entries = [h for h in entries if not any("lessons" in n.get("text", "").lower() for n in h.get("name", []))]
        regions = {s["code"] for s in self._oh("Subdivisions", cc)}
        seen = {
            "-".join(s["code"].split("-")[:2])
            for h in entries
            if not h.get("nationwide")
            for s in h.get("subdivisions", [])
        }
        if seen and not regions & seen:
            regions = seen  # school calendars may use their own zones (e.g. France): count those instead
        regions = regions or {"ALL"}
        on: dict[date, set[str]] = {}
        for h in entries:
            start, end = date.fromisoformat(h["startDate"]), date.fromisoformat(h["endDate"])
            codes = (
                {"ALL"}
                if h.get("nationwide") or not h.get("subdivisions")
                else {"-".join(s["code"].split("-")[:2]) for s in h["subdivisions"]}
            )
            d = max(start, date(year, 1, 1))
            while d <= min(end, date(year, 12, 31)):
                on.setdefault(d, set()).update(codes)
                d += timedelta(days=1)
        out: list[float | None] = []
        for month in range(1, 13):
            if month in SUMMER_GAP:
                out.append(None)
                continue
            d = date(year, month, 1)
            shares = []
            while d.month == month:
                codes = on.get(d, set())
                shares.append(1.0 if "ALL" in codes else len(codes & regions) / len(regions))
                d += timedelta(days=1)
            out.append(round(sum(shares) / len(shares), 3))
        return out, year

    def public(self, cc: str) -> tuple[list[float | None], int | None]:
        """Nationwide public holidays per month, from the latest published year up to the season year."""
        entries, year = self._latest("PublicHolidays", cc)
        if year is None:
            return NONE12, None
        counts = [0] * 12
        for h in entries:
            if h.get("nationwide"):
                counts[date.fromisoformat(h["startDate"]).month - 1] += 1
        return [float(c) for c in counts], year

    # --- Eurostat -------------------------------------------------------------------------------------------

    def tourism(self, cc: str, since_year: int = 2022) -> tuple[list[float | None], str | None]:
        """Tourist nights in each month against that year's monthly average, averaged over complete years."""
        geo = EUROSTAT_GEO.get(cc, cc)
        params = {
            "format": "JSON",
            "lang": "EN",
            "unit": "NR",
            "c_resid": "TOTAL",
            "nace_r2": "I551-I553",
            "geo": geo,
            "sinceTimePeriod": f"{since_year}-01",
        }
        try:
            d = self._get_json(EUROSTAT, params, f"tour_occ_nim-{geo}-{since_year}.json", "eurostat")
        except httpx.HTTPStatusError:
            return NONE12, None
        values = d.get("value") or {}  # type: ignore[union-attr]
        if not values:
            return NONE12, None
        ids, sizes = d["id"], d["size"]  # type: ignore[index]
        t = ids.index("time")
        stride = 1
        for s in sizes[t + 1 :]:
            stride *= s
        series: dict[tuple[int, int], float] = {}
        for period, idx in d["dimension"]["time"]["category"]["index"].items():  # type: ignore[index]
            v = values.get(str(idx * stride))
            if v is not None:
                series[(int(period[:4]), int(period[5:7]))] = float(v)
        years = sorted({y for y, m in series if all((y, mm) in series for mm in range(1, 13))})
        if not years:
            return NONE12, None
        index = [0.0] * 12
        for y in years:
            mean = sum(series[(y, mm)] for mm in range(1, 13)) / 12
            for mm in range(1, 13):
                index[mm - 1] += series[(y, mm)] / mean / len(years)
        return [round(x, 3) for x in index], f"{years[0]}–{years[-1]}"

    # --- combined -------------------------------------------------------------------------------------------

    def country(self, cc: str | None, covered: set[str]) -> CountryCrowding:
        if cc is None:
            return CountryCrowding(NONE12, None, NONE12, None, NONE12, None)
        school, school_year = self.school(cc) if cc in covered else (NONE12, None)
        public, public_year = self.public(cc) if cc in covered else (NONE12, None)
        tourism, tourism_years = self.tourism(cc)
        return CountryCrowding(school, school_year, public, public_year, tourism, tourism_years)

    def snapshots(self, data_dir: Path) -> list[SourceSnapshot]:
        out = []
        now = datetime.now(UTC)
        for group, licence, title, url, attribution in (
            (
                "openholidays",
                OH_LICENCE,
                "OpenHolidays API: school and public holidays",
                OPENHOLIDAYS,
                "Holidays: OpenHolidays API (openholidaysapi.org)",
            ),
            (
                "eurostat",
                EUROSTAT_LICENCE,
                "Eurostat tour_occ_nim: nights at tourist accommodation, monthly",
                EUROSTAT,
                "Tourism statistics: © European Union, Eurostat (tour_occ_nim)",
            ),
        ):
            files = sorted(set(self.files[group]))
            if not files:
                continue
            out.append(
                SourceSnapshot(
                    id=group,
                    title=f"{title} ({len(files)} responses)",
                    url=url,
                    retrieved_at=datetime.fromtimestamp(max(f.stat().st_mtime for f in files), UTC) if files else now,
                    file=(self.cache / group).relative_to(data_dir).as_posix(),
                    sha256="n/a (cached API responses)",
                    bytes=sum(f.stat().st_size for f in files),
                    licence=licence,
                    attribution=attribution,
                )
            )
        return out
