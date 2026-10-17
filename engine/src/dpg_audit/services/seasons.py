"""Month-by-month opening (D18): 12 letters, January first.

o = open, p = partly (the season starts or ends that month: open on some days, closed for a week or more),
c = closed, ? = unknown. Only `c` removes a place from a month's coverage.
"""

from datetime import date, datetime, timedelta

from opening_hours import OpeningHours, State

UNKNOWN = "?" * 12
OPEN = "o" * 12
_SUMMER = {6, 7, 8}
SEASON_BREAK = timedelta(days=7)
"""A closed stretch at least this long inside an otherwise open month marks a season boundary."""


def _month_bounds(year: int, month: int) -> tuple[datetime, datetime]:
    start = datetime(year, month, 1)
    end = datetime(year + 1, 1, 1) if month == 12 else datetime(year, month + 1, 1)
    return start, end


def _month_code(oh: OpeningHours, start: datetime, end: datetime) -> str:
    has_open = has_unknown = long_closed = False
    for interval in oh.intervals(start, end):
        begin, finish, state = interval[0], interval[1] or end, interval[2]
        if state == State.OPEN:
            has_open = True
        elif state == State.UNKNOWN:
            has_unknown = True
        elif finish - begin >= SEASON_BREAK:
            long_closed = True
        if has_open and long_closed:
            return "p"
    return "o" if has_open else "?" if has_unknown else "c"


def evaluate(expression: str, year: int) -> str:
    """Month codes for an OSM `opening_hours` value; unparseable values give all-unknown."""
    try:
        oh = OpeningHours(expression)
    except Exception:  # the parser raises its own error types; any failure means "unknown"
        return UNKNOWN
    out = []
    for month in range(1, 13):
        try:
            out.append(_month_code(oh, *_month_bounds(year, month)))
        except Exception:
            out.append("?")
    return "".join(out)


DAY_WINDOW = (8, 20)
"""A day counts as open when the place is open at some time between these hours."""


def day_codes(expression: str, year: int) -> str | None:
    """One letter per day of `year` (o open, c closed, ? unknown) for an OSM `opening_hours` value, judged over the
    daytime window, for Plan's "open on that date" heads-ups (11.6). None when nothing is known.

    Public holidays (PH rules) depend on the region, which the parser isn't given, so the planner treats a holiday as
    unknown for places whose hours mention PH."""
    try:
        oh = OpeningHours(expression)
        start, end = datetime(year, 1, 1), datetime(year + 1, 1, 1)
        days = (date(year + 1, 1, 1) - date(year, 1, 1)).days
        state = [""] * days
        for interval in oh.intervals(start, end):
            begin, finish, st = interval[0], interval[1] or end, interval[2]
            d, last = begin.date(), (finish - timedelta(microseconds=1)).date()
            while d <= last and d.year == year:
                w0 = datetime(d.year, d.month, d.day, DAY_WINDOW[0])
                w1 = datetime(d.year, d.month, d.day, DAY_WINDOW[1])
                if begin < w1 and finish > w0:
                    i = (d - date(year, 1, 1)).days
                    if st == State.OPEN:
                        state[i] = "o"
                    elif st == State.UNKNOWN and state[i] != "o":
                        state[i] = "?"
                d += timedelta(days=1)
    except Exception:  # unparseable or failing values mean "unknown"
        return None
    codes = "".join(s or "c" for s in state)
    return None if set(codes) == {"?"} else codes


def month_codes(tags: dict[str, str], year: int) -> str:
    """Opening by month from `opening_hours`, else `seasonal`; unknown when neither says anything."""
    expression = tags.get("opening_hours")
    if expression:
        return evaluate(expression, year)
    seasonal = tags.get("seasonal")
    if seasonal == "no":
        return OPEN
    if seasonal == "summer":
        return "".join("o" if m in _SUMMER else "?" for m in range(1, 13))
    return UNKNOWN


def never_open(codes: str) -> bool:
    """Known closed in every month (e.g. `opening_hours=off`): not a usable service at all."""
    return codes == "c" * 12


def season_known(codes: str) -> bool:
    return codes != UNKNOWN
