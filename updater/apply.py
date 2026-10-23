"""Confirm or dismiss a suggested status change (run by the "Apply status change" workflow).

    python updater/apply.py <platform-id> "Accept suggestion" | "Dismiss suggestion" | <status> [--note TEXT] [--url URL]
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from news_scan import CHANGELOG_KEEP, STATUSES, load, save


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("platform_id")
    ap.add_argument("action")
    ap.add_argument("--note", default="")
    ap.add_argument("--url", default="")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    platforms, meta = load("platforms.json"), load("meta.json")
    p = next((x for x in platforms if x["id"] == args.platform_id.strip()), None)
    if not p:
        print(f"Unknown platform id '{args.platform_id}'. Ids are listed in data/platforms.json and the weekly issue.")
        return 1

    sug = p.get("suggested")
    today = dt.date.today().isoformat()
    if args.action == "Dismiss suggestion":
        if not sug:
            print("No suggestion to dismiss.")
            return 1
        p.pop("suggested")
        description = f"Dismissed suggested status {sug['status']}"
        url = sug["url"]
    else:
        new = sug["status"] if args.action == "Accept suggestion" and sug else args.action
        if new not in STATUSES:
            print(f"'{args.action}' needs a pending suggestion, or pick an explicit status.")
            return 1
        url = args.url or (sug["url"] if sug else "")
        description = f"Status {p['status']} → {new}" + (f" ({args.note})" if args.note else "")
        p["status"] = new
        p.pop("suggested", None)
        if url and url not in {s["url"] for s in p.get("sources", [])}:
            p.setdefault("sources", []).append({"date": today, "title": args.note or f"Status: {new}", "url": url})

    if args.note:
        p["notes"] = (p.get("notes", "") + f" {today}: {args.note}").strip()
    p["updated"] = today
    entry = {"date": today, "summary": f"Manual update: {p['name']}", "changes": [{"id": p["id"], "description": description, "url": url or None}]}
    meta["last_updated"] = today
    meta["changelog"] = ([entry] + meta.get("changelog", []))[:CHANGELOG_KEEP]
    save("platforms.json", platforms)
    save("meta.json", meta)
    print(f"{p['name']}: {description}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
