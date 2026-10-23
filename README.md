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
| `updater/update.py` | Weekly updater (RSS + Claude with web search) |
| `.github/workflows/weekly-update.yml` | Runs the updater every Monday and commits changed data |

## Run locally

```bash
python -m http.server 8790
```

Then open http://localhost:8790. Opening `index.html` directly from disk won't work, because the browser
blocks `fetch` of the JSON files.

## Weekly update

1. The updater reads the RSS feeds of offshoreWIND.biz, Offshore Energy, reNEWS, Ocean Energy Resources,
   Transformer Magazine, Splash247, MarineLink and WindpowerNL. It keeps the last 8 days of items that
   mention substations, topsides, converter platforms, the big 2 GW programmes or the main yards.
2. It sends those items and the current dataset to Claude (`claude-opus-5-5`). Claude reads the
   articles, searches the web for news the feeds missed, and returns a JSON change set.
3. The updater validates the change set before writing anything. Each change needs a source URL, a known
   status and existing yard IDs. Invalid items are rejected and listed in the changelog.

Manual run:

```bash
python updater/update.py --dry-run   # show proposed changes only
python updater/update.py             # apply them
```

To automate it, push this folder to a GitHub repo, add an `ANTHROPIC_API_KEY` repository secret, and
enable GitHub Pages on the main branch. Each weekly data commit then redeploys the site automatically.

## Data confidence

Each platform has a `confidence` value of `high`, `medium` or `low`. Low means a yard or status was
inferred or is unconfirmed, for example the TenneT platforms reassigned from Petrofac to Hitachi Energy
and L&T. The list marks these as "unverified", and the updater is told to try to resolve them.
