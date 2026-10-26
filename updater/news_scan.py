"""Free weekly news scan for the Substation Yard Map (no AI, standard library only).

1. Pulls the last few days of articles from the news sources in SOURCES (RSS feeds, or the news
   listing pages for sites without a feed) and keeps the ones that look substation-related.
2. Fetches each article and matches it to platforms by name (BalWin4, Nederwiek 2, Zingst, ...).
3. Matched articles are added to the platform's sources. If the headline/summary uses milestone
   wording ("sets sail", "installed", "first steel"...) the platform gets a *suggested* status,
   which is shown on the site but not applied until you confirm it (Actions -> Apply status change).
4. Writes a Markdown report (used as the weekly GitHub issue) listing matches, suggestions and
   relevant articles that matched no platform - candidates for new platforms or yards.

Usage:
    python updater/news_scan.py --report report.md [--days 8] [--dry-run] [--rescan]
"""

from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import html
import json
import re
import sys
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATUSES = ["Contracted", "Fabrication", "Outfitting", "Sailed away", "Installed"]
# Identify honestly. Sites that refuse automated readers (OE Digital currently does) simply yield nothing.
UA = {"User-Agent": "substation-yard-map/1.0 (weekly news scan; +https://github.com/jlkongstein/substation-yard-map)"}
SEEN_KEEP = 3000
CHANGELOG_KEEP = 60

# News sources. "rss" sources are read from their feed; "pages" sources have no usable feed, so the
# article links on their news listing pages are collected (matching "link") and each article's date
# is read from the article itself.
SOURCES = [
    {"name": "offshoreWIND.biz", "rss": ["https://www.offshorewind.biz/feed/"]},
    {"name": "Offshore Energy", "rss": ["https://www.offshore-energy.biz/feed/"]},
    {"name": "Renewables Now", "rss": ["https://renewablesnow.com/feeds/offshore-wind/", "https://renewablesnow.com/feeds/europe/"]},
    {"name": "OE Digital", "pages": ["https://www.oedigital.com/"], "link": r"(?:https://www\.oedigital\.com)?/news/\d+-[a-z0-9-]+"},
    {"name": "Recharge", "pages": ["https://www.rechargenews.com/wind", "https://www.rechargenews.com/latest"],
     "link": r"(?:https://www\.rechargenews\.com)?/[a-z0-9-]+/[a-z0-9-]+/2-1-\d+"},
    {"name": "Windpower Monthly", "rss": ["https://www.windpowermonthly.com/rss/news"]},
    {"name": "MarineLink", "rss": ["https://www.marinelink.com/news/rss", "https://www.marinelink.com/news/rss/offshore-wind"]},
    {"name": "offshorewindfarmprojects.com",
     "pages": ["https://offshorewindfarmprojects.com/", "https://offshorewindfarmprojects.com/europe",
               "https://offshorewindfarmprojects.com/asia-pacific"],
     "link": r"(?:https://offshorewindfarmprojects\.com)?/(?:europe|asia-pacific|americas|north-america|latin-america|middle-east-africa|global)/[a-z0-9-]+"},
]

# Broad first pass on headline + summary: a false positive costs one page fetch, a miss costs a stale map.
CANDIDATE = re.compile(
    r"substation|topside|converter (?:platform|station)|\bOSS\b|\bOSP\b|\bHVDC\b|"
    r"2 ?GW platform|sail[- ]?away|load[- ]?out|roll[- ]?out|steel[- ]cut|first steel|"
    r"BalWin|LanWin|BorWin|DolWin|Nederwiek|IJmuiden Ver|Doordewind|Ostwind|"
    r"Seatrium|Aibel|Dragados|McDermott|Drydocks World|Smulders|HSM Offshore|Semco|Bladt|"
    r"PTSC|MMHE|Larsen|L&T|Chantiers de l.Atlantique|Navantia|Harland|Heerema Fabrication|NSORe|Neptun Werft|Meyer Werft",
    re.IGNORECASE,
)
# Stricter test for listing an unmatched article in the report (keeps the issue short).
CORE = re.compile(r"substation|topside|converter (?:platform|station)|\bOSS\b|\bOSP\b|HVDC platform|offshore platform", re.I)

# Milestone wording in headline/summary -> suggested status. Checked from most to least advanced.
MILESTONES = [
    ("Installed", re.compile(r"\binstall(?:ed|s|ation (?:of|complete))|set[- ]down|lifted (?:into place|onto)|\benergi[sz]ed", re.I)),
    ("Sailed away", re.compile(r"sail[- ]?away|sets? sail|sailed|departs?|departed|en route|leaves? (?:the )?yard|left (?:the )?yard|ship(?:s|ped) (?:out|from)", re.I)),
    ("Outfitting", re.compile(r"roll(?:s|ed)?[- ]?out|load(?:s|ed)?[- ]?out|mechanical completion|topside (?:is )?complete", re.I)),
    ("Fabrication", re.compile(r"steel[- ]cut|first steel|cuts? (?:the )?first|construction (?:starts|begins|kicks off|under way|underway)|starts? (?:work|construction|building|fabrication)|fabrication (?:starts|begins)", re.I)),
    ("Contracted", re.compile(r"\baward|contract|selects?|picks?|signs?|wins?|secures?", re.I)),
]


def load(name: str, default=None):
    path = DATA / name
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save(name: str, obj) -> None:
    (DATA / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def fold(text: str) -> str:
    """Lower-case, ß->ss, strip accents (Bałtyk -> baltyk, Darß -> darss)."""
    text = unicodedata.normalize("NFKD", text.casefold().replace("ł", "l"))
    return "".join(c for c in text if not unicodedata.combining(c))


def story_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", fold(title)).strip()


def get(url: str, timeout: int = 30) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as resp:
        return resp.read()


# ---------- feeds & articles ----------

def _text(el, tag):
    found = el.find(tag)
    return (found.text or "").strip() if found is not None and found.text else ""


def strip_html(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style|nav|aside|footer|header|form|noscript)\b.*?</\1>", " ", raw)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", raw))).strip()


def fetch_feed(url: str, since: dt.datetime) -> list[dict]:
    root = ET.fromstring(get(url))
    items = []
    for it in root.iter("item"):
        title = strip_html(_text(it, "title"))
        summary = strip_html(_text(it, "description"))[:500]
        try:
            when = email.utils.parsedate_to_datetime(_text(it, "pubDate"))
        except (TypeError, ValueError):
            when = None
        if when and when.astimezone(dt.timezone.utc) < since:
            continue
        if CANDIDATE.search(f"{title} {summary}"):
            items.append({"title": title, "url": clean_url(_text(it, "link")), "summary": summary,
                          "date": when.date().isoformat() if when else dt.date.today().isoformat()})
    return items


def fetch_listing(src: dict) -> list[dict]:
    """Article links (with their link text as title) from a source's news listing pages."""
    pattern = re.compile(r'<a\b[^>]*href="(' + src["link"] + r')/?"[^>]*>(.*?)</a>', re.I | re.S)
    base = re.match(r"https?://[^/]+", src["pages"][0]).group(0)
    titles: dict[str, str] = {}
    for page in src["pages"]:
        raw = get(page).decode("utf-8", "replace")
        for href, inner in pattern.findall(raw):
            url = href if href.startswith("http") else base + href
            text = strip_html(inner)
            if len(text) > len(titles.get(url, "")):  # image links have no text; keep the headline link's
                titles[url] = text
    items = []
    for url, title in titles.items():
        if not title:  # fall back to the URL slug
            slug = re.sub(r"/2-1-\d+$|^/news/\d+-", "", url.split("/", 3)[-1]).rsplit("/", 1)[-1]
            title = slug.replace("-", " ").capitalize()
        if CANDIDATE.search(title):
            items.append({"title": title, "url": clean_url(url), "summary": "", "date": None})
    return items


DATE_PATTERNS = [
    r'property="article:published_time"\s+content="([^"]+)"', r'content="([^"]+)"\s+property="article:published_time"',
    r'"datePublished"\s*:\s*"([^"]+)"', r'<time[^>]+datetime="([^"]+)"', r'name="(?:date|pubdate|publish-date)"\s+content="([^"]+)"',
]


def clean_url(url: str) -> str:
    """Drop tracking parameters (utm_*) so the same article isn't stored twice."""
    base, _, query = url.partition("?")
    keep = [q for q in query.split("&") if q and not q.lower().startswith("utm_")]
    return base.rstrip("/") + ("?" + "&".join(keep) if keep else "") if query else url


def page_title(page: str) -> str | None:
    m = re.search(r'property="og:title"\s+content="([^"]+)"', page, re.I) or re.search(r"<title[^>]*>(.*?)</title>", page, re.I | re.S)
    return html.unescape(m.group(1)).split(" | ")[0].strip() if m else None


def article_text(url: str) -> tuple[str, str | None, str | None]:
    """Main text, publication date (YYYY-MM-DD) and headline of an article page; ('', None, None) if refused."""
    try:
        page = get(url, timeout=25).decode("utf-8", "replace")
    except Exception:
        return "", None, None
    date = None
    for pat in DATE_PATTERNS:
        m = re.search(pat, page, re.I)
        if m and re.match(r"\d{4}-\d{2}-\d{2}", m.group(1)):
            date = m.group(1)[:10]
            break
    # Prefer the <article> element so sidebars ("related news") don't create false matches.
    m = re.search(r"(?is)<article\b.*?</article>", page) or re.search(r"(?is)<main\b.*?</main>", page)
    return strip_html(m.group(0) if m else page)[:30000], date, page_title(page)


# ---------- matching ----------

def alias_pattern(alias: str) -> re.Pattern:
    a = fold(alias).strip()
    parts, prev = [], ""
    for ch in a:
        if ch in " -_/":
            if parts and parts[-1] != r"[\s\-]*":
                parts.append(r"[\s\-]*")
        else:
            # Allow "LanWin1" / "LanWin 1" / "LanWin-1".
            if prev and prev.isalpha() != ch.isalpha() and parts[-1] != r"[\s\-]*":
                parts.append(r"[\s\-]*")
            parts.append(re.escape(ch))
        prev = ch if ch not in " -_/" else prev
    return re.compile(r"(?<![a-z0-9])" + "".join(parts) + r"(?![a-z0-9])")


def platform_aliases(p: dict) -> list[str]:
    names = set(p.get("aliases", []))
    for field in ("name", "project"):
        base = re.sub(r"\(.*?\)", " ", p.get(field, ""))
        base = re.sub(r"\b(OSS|converter|HVDC platform|platform)\b", " ", base, flags=re.I)
        for piece in base.split("/"):
            piece = re.sub(r"\s+", " ", piece).strip(" -")
            if len(piece) >= 4:
                names.add(piece)
    return sorted(names)


def build_matchers(platforms: list[dict]) -> dict[str, list[re.Pattern]]:
    return {p["id"]: [alias_pattern(a) for a in platform_aliases(p)] for p in platforms}


def matches(text_folded: str, pats: list[re.Pattern]) -> bool:
    return any(pt.search(text_folded) for pt in pats)


def suggest_status(headline: str, current: str) -> str | None:
    for status, rx in MILESTONES:
        if rx.search(headline):
            # Only suggest moving forward; "Contracted" only for platforms not yet tracked as further.
            if STATUSES.index(status) > STATUSES.index(current):
                return status
            return None
    return None


def yard_mentions(text_folded: str, yards: list[dict]) -> list[str]:
    hits = []
    for y in yards:
        for name in {y["name"], y["operator"]}:
            if len(name) >= 4 and alias_pattern(name.split(" (")[0]).search(text_folded):
                hits.append(y["operator"])
                break
    return sorted(set(hits))


# ---------- main ----------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=8)
    ap.add_argument("--report", default="news-report.md")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--rescan", action="store_true", help="also re-check articles already scanned before")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    platforms, yards, meta = load("platforms.json"), load("yards.json"), load("meta.json")
    seen = load("news_seen.json", [])
    seen_set = set() if args.rescan else set(seen)
    by_id = {p["id"]: p for p in platforms}
    matchers = build_matchers(platforms)
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.days)
    today = dt.date.today().isoformat()

    candidates, feed_errors, stories, per_source = [], [], set(), {}
    for src in SOURCES:
        found = []
        for url in src.get("rss", []) + (["listing"] if "pages" in src else []):
            try:
                found += fetch_listing(src) if url == "listing" else fetch_feed(url, since)
            except Exception as exc:  # one dead source must not stop the run
                feed_errors.append(f"{src['name']} ({url}): {exc}")
        n = 0
        for item in found:
            key = story_key(item["title"])
            # The same press release often appears on several sites under the same headline: keep one.
            if item["url"] and item["url"] not in seen_set and key not in stories:
                stories.add(key)
                candidates.append({**item, "source": src["name"]})
                n += 1
        per_source[src["name"]] = n
    print(f"{len(candidates)} new candidate articles: " + ", ".join(f"{k} {v}" for k, v in per_source.items()))

    matched, suggestions, unmatched, changes = [], [], [], []
    scanned = []
    for art in candidates:
        text, published, headline_on_page = article_text(art["url"])
        if not art["date"]:
            # Listing-page articles: date and clean headline from the article itself; skip ones outside the window.
            if published and published < since.date().isoformat():
                continue
            art["date"] = published or today
            if headline_on_page:
                art["title"] = headline_on_page
        scanned.append(art)
        headline = fold(f"{art['title']} {art['summary']}")
        body = fold(text)
        hits = [pid for pid, pats in matchers.items() if matches(headline, pats) or (body and matches(body, pats))]
        if not hits:
            context = headline + " " + body[:3000]
            # Onshore grid news is common in these feeds; only keep offshore stories.
            if CORE.search(context) and re.search(r"offshore", context):
                unmatched.append({**art, "yards": yard_mentions(headline + " " + body, yards)})
            continue
        matched.append({**art, "platforms": hits})
        added_to = []
        for pid in hits:
            p = by_id[pid]
            known = {s["url"] for s in p.get("sources", [])} | {story_key(s["title"]) for s in p.get("sources", [])}
            if art["url"] not in known and story_key(art["title"]) not in known:
                p.setdefault("sources", []).append({"date": art["date"], "title": art["title"], "url": art["url"], "auto": True})
                added_to.append(pid)
            # Status suggestions only when the platform is named in the headline/summary itself.
            if matches(headline, matchers[pid]):
                s = suggest_status(art["title"] + " " + art["summary"], p["status"])
                if s and (not p.get("suggested") or STATUSES.index(s) > STATUSES.index(p["suggested"]["status"])):
                    p["suggested"] = {"status": s, "date": art["date"], "title": art["title"], "url": art["url"]}
                    suggestions.append({"id": pid, "name": p["name"], "from": p["status"], "to": s, "url": art["url"], "title": art["title"]})
        if added_to:
            # One "What's new" line per article, listing every platform it concerns.
            changes.append({"ids": added_to, "description": f"News: {art['title']}", "url": art["url"]})

    # ---- report (GitHub issue body) ----
    lines = [f"News scan for **{today}**: {len(scanned)} new articles checked, "
             f"{len(matched)} matched to platforms, {len(suggestions)} possible status change(s), "
             f"{len(unmatched)} relevant article(s) not matched to any platform.", "",
             "Sources: " + ", ".join(f"{k} ({v})" for k, v in per_source.items()), ""]
    if suggestions:
        lines += ["## Possible status changes (please confirm)",
                  "To accept or dismiss: **Actions → Apply status change → Run workflow**, enter the platform id and choose a status (or *Dismiss suggestion*).", "",
                  "| Platform id | Current | Suggested | Source |", "|---|---|---|---|"]
        lines += [f"| `{s['id']}` | {s['from']} | **{s['to']}** | [{s['title']}]({s['url']}) |" for s in suggestions]
        lines.append("")
    if matched:
        lines += ["## News added to platforms", ""]
        lines += [f"- {a['date']} [{a['title']}]({a['url']}) ({a['source']}) → " + ", ".join(by_id[i]["name"] for i in a["platforms"]) for a in matched]
        lines.append("")
    if unmatched:
        lines += ["## Relevant articles not matched to any platform",
                  "Possible new platforms, yards or contract awards. Add them by editing `data/platforms.json` / `data/yards.json`.", ""]
        lines += [f"- {a['date']} [{a['title']}]({a['url']}) ({a['source']})" + (f" — mentions {', '.join(a['yards'])}" if a["yards"] else "")
                  + (f"<br><sub>{a['summary'][:220]}</sub>" if a["summary"] else "") for a in unmatched]
        lines.append("")
    if feed_errors:
        lines += ["<details><summary>Feed errors</summary>", ""] + [f"- {e}" for e in feed_errors] + ["", "</details>"]
    report = "\n".join(lines)
    Path(args.report).write_text(report, encoding="utf-8")
    print(report)

    if args.dry_run:
        return 0

    summary = (f"News scan: {len(matched)} article(s) matched to platforms"
               + (f", {len(suggestions)} possible status change(s) awaiting confirmation" if suggestions else "")
               + (f", {len(unmatched)} unmatched relevant article(s)" if unmatched else "") + ".")
    if scanned:
        meta["last_updated"] = today
        meta["changelog"] = ([{"date": today, "summary": summary, "changes": changes}] + meta.get("changelog", []))[:CHANGELOG_KEEP]
    seen = (seen + [c["url"] for c in candidates if c["url"] not in set(seen)])[-SEEN_KEEP:]
    save("platforms.json", platforms)
    save("meta.json", meta)
    save("news_seen.json", seen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
