"""Weekly updater for the Substation Yard Map.

1. Pulls recent items from offshore-wind news RSS feeds and keeps those that mention
   substations / topsides / converter platforms.
2. Hands those candidates plus the current dataset to Claude, which reads the articles,
   runs its own web searches for anything the feeds missed, and returns a JSON change set.
3. Validates the change set and applies it to data/platforms.json, data/yards.json and
   data/meta.json (changelog).

Usage:
    python updater/update.py            # apply changes
    python updater/update.py --dry-run  # print the change set, write nothing

Needs ANTHROPIC_API_KEY (or an `ant auth login` profile).
"""

from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import anthropic

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MODEL = "claude-opus-5-5"
STATUSES = ["Contracted", "Fabrication", "Outfitting", "Sailed away", "Installed"]
TYPES = ["HVDC converter", "AC substation"]
CHANGELOG_KEEP = 60

FEEDS = [
    "https://www.offshorewind.biz/feed/",
    "https://www.offshore-energy.biz/feed/",
    "https://renews.biz/rss/",
    "https://ocean-energyresources.com/feed/",
    "https://transformer-magazine.com/feed/",
    "https://splash247.com/feed/",
    "https://www.marinelink.com/news/rss",
    "https://windpowernl.com/feed/",
]

# Deliberately broad: a false positive costs a few tokens, a miss costs a stale map.
KEYWORDS = re.compile(
    r"substation|topside|converter (?:platform|station)|\bOSS\b|\bOSP\b|\bHVDC\b|"
    r"\b2 ?GW platform|sail[- ]?away|load[- ]?out|roll[- ]?out|steel[- ]cut|first steel|"
    r"BalWin|LanWin|BorWin|DolWin|Nederwiek|IJmuiden Ver|Doordewind|Ostwind|"
    r"Seatrium|Aibel|Dragados|McDermott|Drydocks World|Smulders|HSM Offshore|Semco|Bladt|"
    r"PTSC|MMHE|Larsen|L&T|Chantiers de l.Atlantique|Navantia|Harland|Heerema Fabrication|"
    r"Hitachi Energy|Siemens Energy|GE Vernova|NSORe|Neptun Werft|Meyer Werft",
    re.IGNORECASE,
)

SYSTEM = """You maintain a dataset of offshore wind substation and converter-platform TOPSIDES and the yards \
where they are fabricated, assembled, outfitted or commissioned. Jackets matter only as a secondary yard role.

Each week you receive the current dataset and a list of candidate news items. Your job:
- Read the candidate articles that look relevant (web_fetch) and search the web (web_search) for further news \
from the review window: contract awards, steel cuts, roll-outs, load-outs, sail-aways, installations, yard \
changes, delays, cancellations. Check trade press (offshorewind.biz, reNEWS, Offshore Engineer/OE Digital, \
Riviera, Windtech, Ocean Energy Resources, HVDC World) and yard/TSO newsrooms (TenneT, Amprion, 50Hertz, RTE, \
Seatrium, Aibel, Dragados, McDermott, Drydocks World, Smulders, Semco, PTSC, L&T, Chantiers de l'Atlantique).
- Also try to resolve platforms marked confidence "low" if the news lets you.
- Only report a change when a source you actually read supports it. Every change needs a source URL.
- When unsure whether something is new, include it with a cautious description rather than leaving it out; \
a human reviews the changelog.
- Do not invent coordinates for well-known yards wrongly: give your best known lat/lon for new yards.

Finish with ONE JSON object inside <result></result> tags and nothing after it. Schema:
{
  "summary": "one or two sentences on this week's news",
  "platform_updates": [
    {"id": "<existing platform id>",
     "set": {<only fields that change; allowed: status, sailaway, cod, capacity_mw, topside_t, epc, notes, confidence, yards>},
     "description": "what changed, one sentence",
     "source": {"date": "YYYY-MM-DD", "title": "...", "url": "https://..."}}
  ],
  "new_platforms": [
    {"id": "kebab-case-id", "name": "...", "project": "...", "client": "...", "site_country": "...",
     "type": "HVDC converter" | "AC substation", "capacity_mw": number|null, "topside_t": number|null,
     "epc": "...", "yards": [{"yard": "<yard id>", "role": "Topside fabrication" | "Outfitting & commissioning" | "Jacket" | ...}],
     "status": one of %s, "sailaway": string|null, "cod": number|null,
     "confidence": "high"|"medium"|"low", "notes": "...",
     "sources": [{"date": "YYYY-MM-DD", "title": "...", "url": "https://..."}]}
  ],
  "new_yards": [
    {"id": "kebab-case-id", "name": "...", "operator": "...", "city": "...", "country": "...",
     "lat": number, "lon": number, "kind": "topside" | "jacket", "notes": "..."}
  ]
}
"yards" in a platform update replaces the whole list. Status meanings: Contracted (awarded, no steel cut), \
Fabrication (steel cut / under construction), Outfitting (structure complete, equipment and commissioning \
in yard), Sailed away (left the yard), Installed (set down offshore). Empty arrays are fine.""" % json.dumps(STATUSES)


def load(name: str):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def save(name: str, obj) -> None:
    (DATA / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ---------- RSS ----------

def _text(el, tag):
    found = el.find(tag)
    return (found.text or "").strip() if found is not None and found.text else ""


def fetch_feed(url: str, since: dt.datetime) -> list[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (oss-yard-map updater)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        root = ET.fromstring(resp.read())
    items = []
    for it in root.iter("item"):
        title, link = _text(it, "title"), _text(it, "link")
        desc = re.sub(r"<[^>]+>", " ", _text(it, "description"))
        desc = re.sub(r"\s+", " ", desc)[:400]
        pub = _text(it, "pubDate")
        try:
            when = email.utils.parsedate_to_datetime(pub)
        except (TypeError, ValueError):
            when = None
        if when and when.astimezone(dt.timezone.utc) < since:
            continue
        if KEYWORDS.search(f"{title} {desc}"):
            items.append({"title": title, "url": link, "date": when.date().isoformat() if when else None, "summary": desc})
    return items


def gather_candidates(days: int) -> tuple[list[dict], list[str]]:
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    seen, out, errors = set(), [], []
    for url in FEEDS:
        try:
            for item in fetch_feed(url, since):
                if item["url"] not in seen:
                    seen.add(item["url"])
                    out.append(item)
        except Exception as exc:  # one dead feed must not stop the run
            errors.append(f"{url}: {exc}")
    return out, errors


# ---------- Claude ----------

def compact_dataset(platforms, yards) -> str:
    rows = []
    for p in platforms:
        latest = max((s.get("date") or "" for s in p.get("sources", [])), default="")
        rows.append({
            "id": p["id"], "name": p["name"], "client": p["client"], "type": p["type"], "status": p["status"],
            "yards": p["yards"], "epc": p.get("epc"), "sailaway": p.get("sailaway"), "cod": p.get("cod"),
            "confidence": p.get("confidence"), "latest_source": latest,
            "known_urls": [s["url"] for s in p.get("sources", [])],
        })
    yard_rows = [{"id": y["id"], "name": y["name"], "country": y["country"], "kind": y["kind"]} for y in yards]
    return json.dumps({"platforms": rows, "yards": yard_rows}, ensure_ascii=False)


def ask_claude(platforms, yards, candidates, days: int) -> tuple[dict, str]:
    client = anthropic.Anthropic()
    today = dt.date.today().isoformat()
    user = (
        f"Today is {today}. Review window: the last {days} days.\n\n"
        f"<dataset>\n{compact_dataset(platforms, yards)}\n</dataset>\n\n"
        f"<candidate_news>\n{json.dumps(candidates, ensure_ascii=False, indent=1)}\n</candidate_news>\n\n"
        "Check the candidates, search for anything they missed, and return the change set."
    )
    tools = [
        {"type": "web_search_20260209", "name": "web_search", "max_uses": 25},
        {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 30},
    ]
    messages = [{"role": "user", "content": user}]

    for _ in range(8):  # resume server-tool loops that pause
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=64000,
            system=SYSTEM,
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            tools=tools,
            messages=messages,
        ) as stream:
            response = stream.get_final_message()
        if response.stop_reason == "pause_turn":
            # Re-send the paused turn so the server resumes it; keep earlier paused content too.
            if messages[-1]["role"] == "assistant":
                messages[-1]["content"] = list(messages[-1]["content"]) + list(response.content)
            else:
                messages.append({"role": "assistant", "content": list(response.content)})
            continue
        break
    else:
        raise RuntimeError("Claude kept pausing; giving up this week.")

    if response.stop_reason == "refusal":
        raise RuntimeError(f"Request declined: {response.stop_details}")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Response hit max_tokens before finishing.")

    text = "".join(b.text for b in response.content if b.type == "text")
    m = re.search(r"<result>\s*(\{.*\})\s*</result>", text, re.DOTALL)
    if not m:
        raise RuntimeError(f"No <result> JSON in response:\n{text[-2000:]}")
    return json.loads(m.group(1)), text


# ---------- validation & apply ----------

ALLOWED_SET = {"status", "sailaway", "cod", "capacity_mw", "topside_t", "epc", "notes", "confidence", "yards"}
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def valid_source(s) -> bool:
    return isinstance(s, dict) and str(s.get("url", "")).startswith("http") and s.get("title")


def apply_changes(result: dict, platforms: list, yards: list) -> tuple[list[dict], list[str]]:
    """Mutates platforms/yards in place. Returns (changelog changes, rejected-item notes)."""
    today = dt.date.today().isoformat()
    by_id = {p["id"]: p for p in platforms}
    yard_ids = {y["id"] for y in yards}
    changes, rejected = [], []

    for y in result.get("new_yards", []):
        ok = (SLUG.match(str(y.get("id", ""))) and y["id"] not in yard_ids
              and isinstance(y.get("lat"), (int, float)) and isinstance(y.get("lon"), (int, float))
              and -90 <= y["lat"] <= 90 and -180 <= y["lon"] <= 180 and y.get("name"))
        if not ok:
            rejected.append(f"new yard {y.get('id')}: invalid or duplicate")
            continue
        y.setdefault("kind", "topside")
        yards.append({k: y.get(k) for k in ["id", "name", "operator", "city", "country", "lat", "lon", "kind", "notes"]})
        yard_ids.add(y["id"])
        changes.append({"id": y["id"], "description": f"New yard added: {y['name']} ({y.get('country')})", "url": None})

    def yards_ok(lst):
        return isinstance(lst, list) and lst and all(r.get("yard") in yard_ids and r.get("role") for r in lst)

    for u in result.get("platform_updates", []):
        p = by_id.get(u.get("id"))
        src = u.get("source")
        fields = {k: v for k, v in (u.get("set") or {}).items() if k in ALLOWED_SET}
        if not p or not valid_source(src) or not fields:
            rejected.append(f"update {u.get('id')}: unknown id, no source, or nothing to set")
            continue
        if "status" in fields and fields["status"] not in STATUSES:
            rejected.append(f"update {p['id']}: bad status {fields['status']}")
            continue
        if "yards" in fields and not yards_ok(fields["yards"]):
            rejected.append(f"update {p['id']}: yard list references unknown yards")
            continue
        p.update(fields)
        if src["url"] not in {s["url"] for s in p.get("sources", [])}:
            p.setdefault("sources", []).append({"date": src.get("date"), "title": src["title"], "url": src["url"]})
        p["updated"] = today
        changes.append({"id": p["id"], "description": u.get("description", ""), "url": src["url"]})

    for n in result.get("new_platforms", []):
        srcs = [s for s in n.get("sources", []) if valid_source(s)]
        if (not SLUG.match(str(n.get("id", ""))) or n["id"] in by_id or not srcs
                or n.get("status") not in STATUSES or n.get("type") not in TYPES or not yards_ok(n.get("yards"))):
            rejected.append(f"new platform {n.get('id')}: invalid, duplicate, unsourced or unknown yard")
            continue
        n["sources"] = srcs
        n["updated"] = today
        n.setdefault("confidence", "medium")
        platforms.append(n)
        by_id[n["id"]] = n
        changes.append({"id": n["id"], "description": f"New platform added ({n['status']})", "url": srcs[0]["url"]})

    return changes, rejected


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--days", type=int, default=8, help="news window (default 8, so weekly runs overlap)")
    args = ap.parse_args()

    platforms, yards, meta = load("platforms.json"), load("yards.json"), load("meta.json")
    candidates, feed_errors = gather_candidates(args.days)
    print(f"{len(candidates)} candidate news items from RSS")
    for e in feed_errors:
        print(f"  feed error: {e}")

    result, _ = ask_claude(platforms, yards, candidates, args.days)
    if args.dry_run:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    changes, rejected = apply_changes(result, platforms, yards)
    for r in rejected:
        print(f"  rejected: {r}")

    today = dt.date.today().isoformat()
    meta["last_updated"] = today
    entry = {"date": today, "summary": result.get("summary", ""), "changes": changes}
    if rejected:
        entry["rejected"] = rejected
    meta["changelog"] = ([entry] + meta.get("changelog", []))[:CHANGELOG_KEEP]

    save("platforms.json", platforms)
    save("yards.json", yards)
    save("meta.json", meta)
    print(f"Applied {len(changes)} change(s), rejected {len(rejected)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
