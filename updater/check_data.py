"""Duplicate guard for the Substation Yard Map data.

Runs before every data commit (weekly scan, deep search, status changes, and any push touching
data/). It has two kinds of findings:

* Fixed automatically (with --fix): the same news story stored twice on a platform - same address
  (ignoring http/www/trailing slash/tracking parameters), same headline, or the same story from
  another outlet within a few days. The duplicate is folded into the first copy as an "also" link,
  so nothing is lost. Repeated lines in the changelog are merged the same way.
* Blocking (exit code 1, nothing gets committed): a platform or yard that looks like it is in the
  data twice - same id, same name/alias, or the same project at the same site; a yard at (almost)
  the same spot as another yard of the same company. These need a human decision.

Usage:
    python updater/check_data.py          # report only
    python updater/check_data.py --fix    # also fix the safe cases and save
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from news_scan import fold, load, platform_aliases, save, story_key  # noqa: E402

# Words that say little about which story an article is (shared by most substation news).
GENERIC = set("""a an and as at by for from in into of on or the to with its it is are was be new first second third
offshore wind farm farms project projects substation substations platform platforms topside topsides converter station
stations hvdc gw mw kv power grid connection contract contracts awarded awards wins win signs starts start begins
completes complete installed installs installation sails sail set sets away en route news update video
says said will has have after over more up out north sea baltic german germany dutch uk us""".split())


def norm_url(url: str) -> str:
    u = re.sub(r"^https?://(www\.)?", "", url.strip().lower())
    base, _, query = u.partition("?")
    keep = sorted(q for q in query.split("&") if q and not q.startswith("utm_"))
    return base.rstrip("/") + ("?" + "&".join(keep) if keep else "")


def tokens(title: str) -> set[str]:
    words = re.findall(r"[a-z0-9]+", fold(title))
    return {w.rstrip("s") for w in words if w not in GENERIC and len(w) > 2}


def days_apart(a: str | None, b: str | None) -> float:
    """Days between two dates; a month-only date ("2026-06") counts as anywhere in that month."""
    def span(d):
        if not d:
            return None
        if re.fullmatch(r"\d{4}-\d{2}", d[:7]) and len(d) < 10:
            first = dt.date.fromisoformat(d[:7] + "-01")
            last = (first.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
            return first, last
        try:
            x = dt.date.fromisoformat(d[:10])
            return x, x
        except ValueError:
            return None
    sa, sb = span(a), span(b)
    if not sa or not sb:
        return math.inf
    if sa[1] < sb[0]:
        return (sb[0] - sa[1]).days
    if sb[1] < sa[0]:
        return (sa[0] - sb[1]).days
    return 0


def same_story(a: dict, b: dict) -> bool:
    if norm_url(a["url"]) == norm_url(b["url"]) or story_key(a["title"]) == story_key(b["title"]):
        return True
    # Same story from another outlet: published within 3 days and sharing at least two distinctive
    # words, e.g. "Nexans ... LanWin2" on offshoreWIND.biz and on offshorewindfarmprojects.com.
    if days_apart(a.get("date"), b.get("date")) <= 3:
        shared = tokens(a["title"]) & tokens(b["title"])
        return len(shared) >= 2
    return False


def merge_sources(sources: list[dict]) -> tuple[list[dict], int]:
    kept: list[dict] = []
    merged = 0
    for s in sources:
        twin = next((k for k in kept if same_story(k, s)), None)
        if twin is None:
            kept.append(s)
            continue
        merged += 1
        if norm_url(twin["url"]) != norm_url(s["url"]):
            also = twin.setdefault("also", [])
            if all(norm_url(x["url"]) != norm_url(s["url"]) for x in also):
                also.append({"title": s["title"], "url": s["url"], "date": s.get("date")})
        for extra in s.get("also", []):
            if all(norm_url(x["url"]) != norm_url(extra["url"]) for x in twin.get("also", [])):
                twin.setdefault("also", []).append(extra)
    return kept, merged


def km(a, b) -> float:
    R, rad = 6371, math.pi / 180
    h = (math.sin((b[0] - a[0]) * rad / 2) ** 2
         + math.cos(a[0] * rad) * math.cos(b[0] * rad) * math.sin((b[1] - a[1]) * rad / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


def check(platforms, yards, meta, fix: bool):
    problems, fixed = [], []

    # --- platforms ---
    seen_ids = {}
    for p in platforms:
        if p["id"] in seen_ids:
            problems.append(f"Platform id '{p['id']}' is used twice.")
        seen_ids[p["id"]] = p
    names, flagged = {}, set()
    for p in platforms:
        for n in {story_key(x) for x in platform_aliases(p) + [p["name"]]}:
            other = names.get(n)
            # Sister platforms of one project share the project alias (e.g. both Hornsea 3 links); only
            # flag a shared *name*, or a shared alias when the two also stand at the same site.
            if other and other["id"] != p["id"]:
                same_name = story_key(other["name"]) == story_key(p["name"])
                same_site = (p.get("site") and other.get("site")
                             and km((p["site"]["lat"], p["site"]["lon"]), (other["site"]["lat"], other["site"]["lon"])) < 3)
                pair = tuple(sorted((other["id"], p["id"])))
                if pair not in flagged and (same_name or (same_site and set(r["yard"] for r in p["yards"]) & set(r["yard"] for r in other["yards"]))):
                    flagged.add(pair)
                    problems.append(f"Platforms '{other['id']}' and '{p['id']}' look like the same platform "
                                    f"(shared name '{n}'{', same site and yard' if same_site else ''}).")
            names.setdefault(n, p)

    # --- yards ---
    yids, ynames = set(), {}
    for y in yards:
        if y["id"] in yids:
            problems.append(f"Yard id '{y['id']}' is used twice.")
        yids.add(y["id"])
        k = story_key(y["name"])
        if k in ynames:
            problems.append(f"Yards '{ynames[k]}' and '{y['id']}' have the same name.")
        ynames[k] = y["id"]
    for i, a in enumerate(yards):
        for b in yards[i + 1:]:
            if km((a["lat"], a["lon"]), (b["lat"], b["lon"])) < 1.5 and story_key(a["operator"]) == story_key(b["operator"]):
                problems.append(f"Yards '{a['id']}' and '{b['id']}' are the same company within 1.5 km - probably one yard.")
    for p in platforms:
        for r in p["yards"]:
            if r["yard"] not in yids:
                problems.append(f"Platform '{p['id']}' refers to unknown yard '{r['yard']}'.")

    # --- news per platform (safe to fix) ---
    for p in platforms:
        merged_list, n = merge_sources(p.get("sources", []))
        if n:
            fixed.append(f"{p['id']}: merged {n} duplicate news item(s)")
            if fix:
                p["sources"] = merged_list

    # --- changelog (safe to fix) ---
    for e in meta.get("changelog", []):
        out = []
        for c in e.get("changes", []):
            ids = c.get("ids") or [c.get("id")]
            twin = next((o for o in out if (c.get("url") and o.get("url") and norm_url(o["url"]) == norm_url(c["url"]))
                         or story_key(o["description"]) == story_key(c["description"])), None)
            if twin:
                twin["ids"] += [i for i in ids if i not in twin["ids"]]
                fixed.append(f"changelog {e['date']}: merged a repeated line")
            else:
                out.append({**{k: v for k, v in c.items() if k != "id"}, "ids": list(ids)})
        if fix:
            e["changes"] = out
    return problems, fixed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    platforms, yards, meta = load("platforms.json"), load("yards.json"), load("meta.json")
    problems, fixed = check(platforms, yards, meta, args.fix)
    for f in fixed:
        print(("fixed: " if args.fix else "would fix: ") + f)
    if args.fix and fixed:
        save("platforms.json", platforms)
        save("meta.json", meta)
    for p in problems:
        print("DUPLICATE: " + p)
    if problems:
        print(f"\n{len(problems)} possible duplicate(s) need a decision - data was not committed.")
        return 1
    print("No duplicate platforms or yards.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
