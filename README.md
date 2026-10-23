# Substation Yard Map

A static website that maps the yards where offshore wind substation and HVDC converter **topsides** are
fabricated, assembled, outfitted and commissioned. You can pan and zoom the map, click a yard to see its
platforms, click a platform for details and sources, search, sort, and filter by status or type.
Jacket-only yards are hidden by default; there's a checkbox to show them.

## Files

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The site (Leaflet map, no build step) |
| `data/yards.json` | Yards with coordinates |
| `data/platforms.json` | Platforms: status, yards and roles, contractor, capacity, weight, dates, sources |
| `data/meta.json` | Last-updated date and the weekly changelog shown under "What's new" |
| `data/news_seen.json` | Articles already scanned, so weekly runs don't repeat them |
| `updater/news_scan.py` | Free weekly news scan (RSS + name matching, no AI, standard library only) |
| `updater/apply.py` | Confirms or dismisses a suggested status change |
| `.github/workflows/weekly-update.yml` | Runs the scan every Monday, commits data, opens a GitHub issue |
| `.github/workflows/apply-change.yml` | "Apply status change" form for accepting suggestions |

## Run locally

```bash
python -m http.server 8790
```

Then open http://localhost:8790. Opening `index.html` directly from disk won't work, because the browser
blocks `fetch` of the JSON files.

## Weekly news scan (free)

Every Monday at 05:00 UTC, GitHub Actions runs `updater/news_scan.py`. It costs nothing and needs no API keys.

1. It reads the RSS feeds of offshoreWIND.biz, Offshore Energy, reNEWS, Ocean Energy Resources,
   Transformer Magazine, Splash247, MarineLink and WindpowerNL, and keeps new articles that look
   substation-related.
2. It opens each article and matches it to platforms by name. Names come from each platform's `name`
   and `project`, plus an optional `aliases` list, e.g. `["BorWin6", "BorWin kappa"]`.
3. Matched articles are added to the platform's sources and appear under "What's new" on the site.
4. If a headline uses milestone wording such as "first steel", "rolled out", "sets sail" or "installed",
   the platform gets a **suggested** status. The site shows it as "possible update", but the status
   doesn't change until you confirm it.
5. The scan opens a GitHub issue each week (you get it by email) listing:
   - suggested status changes;
   - news added to platforms;
   - relevant offshore articles that matched no platform, which may be new projects or yards.

**Confirming a suggestion:** on GitHub, go to **Actions → Apply status change → Run workflow**. Enter
the platform id from the issue and choose *Accept suggestion*, *Dismiss suggestion* or a specific
status.

**New platforms or yards:** edit `data/platforms.json` or `data/yards.json` directly on GitHub, using
the pencil icon. Copy an existing entry as a template.

Manual run: `python updater/news_scan.py --dry-run` prints the report without changing anything.

## Data confidence

Each platform has a `confidence` value of `high`, `medium` or `low`. Low means a yard or status was
inferred or is unconfirmed, for example the TenneT platforms reassigned from Petrofac to Hitachi Energy
and L&T. The list marks these as "unverified".
