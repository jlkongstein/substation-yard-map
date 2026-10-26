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
| `data/platforms.json` | Platforms: status, yards and roles, contractor, capacity, weight, dates, installation `site` (lat/lon), sources |
| `sea.js` | Sea-lane network used to draw the likely sailing route from yard(s) to installation site |
| `data/meta.json` | Last-updated date and the weekly changelog shown under "What's new" |
| `data/news_seen.json` | Articles already scanned, so weekly runs don't repeat them |
| `updater/news_scan.py` | Free weekly news scan (RSS + name matching, no AI, standard library only) |
| `updater/check_data.py` | Duplicate guard: merges repeated news, blocks duplicate platforms/yards |
| `updater/apply.py` | Confirms or dismisses a suggested status change |
| `.github/workflows/weekly-update.yml` | Runs the scan every Monday, commits data, opens a GitHub issue |
| `.github/workflows/apply-change.yml` | "Apply status change" form for accepting suggestions |

## Run locally

```bash
python -m http.server 8790
```

Then open http://localhost:8790. Opening `index.html` directly from disk won't work, because the browser
blocks `fetch` of the JSON files.

## Weekly news scan and monthly deep search (free)

Both run on GitHub Actions, which is free for public repositories, and need no API keys.

**Every Monday (05:00 UTC)**, `updater/news_scan.py`:

1. Reads the latest articles from eight sources: offshoreWIND.biz, Offshore Energy, Renewables Now,
   OE Digital, Recharge, Windpower Monthly, MarineLink and offshorewindfarmprojects.com. Sites with an
   RSS feed are read from the feed. For the others, it reads the article links on their news pages. The
   list is `SOURCES` in `updater/news_scan.py`.
2. Opens **every** new article and reads it in full, not just the headline, so a mention buried in an
   article about something else still counts. About 150–250 articles a week, a few minutes per run.
3. Attaches an article to a platform when the platform is named in it and the article is about the
   substation itself (substation, topside, converter platform, HVDC…). News about turbines, monopiles
   or power deals for the same wind farm is ignored. Installed platforms are out of scope.
4. If a headline uses milestone wording about the substation ("first steel", "rolled out", "sets sail",
   "installed"…), the platform gets a **suggested** status. The site shows it as "possible update", but
   the status doesn't change until you confirm it.
5. Opens a GitHub issue (you get it by email) listing suggested status changes, news added to platforms,
   and relevant offshore articles that matched no platform, which may be new projects or yards.

**On the 1st of each month (06:00 UTC)**, a **deep search** also goes through 6 months of the sites'
archives, using the sitemaps they publish for search engines (Renewables Now, Windpower Monthly,
Recharge, MarineLink). It looks for article addresses naming a tracked platform, yard or substation
term, then opens those articles. You can also run it by hand: **Actions → Weekly news scan → Run
workflow**, then set "Deep search: months" (e.g. 12) and optionally tick "Re-check articles".

What the scans can't reach:
- Sites' own search pages put their results in with JavaScript, so they can't be read.
- offshoreWIND.biz, Offshore Energy and offshorewindfarmprojects.com publish no article sitemaps, so for
  them only their feeds or news pages are read (about 1–3 weeks back).
- Recharge and Windpower Monthly are partly paywalled, so only the free part of each article is read.
- OE Digital sometimes refuses automated readers. The scan identifies itself honestly and never tries to
  get around such blocks.

**Confirming a suggestion:** on GitHub, go to **Actions → Apply status change → Run workflow**. Enter
the platform id from the issue and choose *Accept suggestion*, *Dismiss suggestion* or a specific
status.

**New platforms or yards:** edit `data/platforms.json` or `data/yards.json` directly on GitHub, using
the pencil icon. Copy an existing entry as a template.

Manual run: `python updater/news_scan.py --dry-run` prints the report without changing anything.
`--rescan` re-checks articles already scanned before. `--archive-months 6` adds the deep search.

## Duplicate guard

`updater/check_data.py` runs before every data commit: the weekly scan, the deep search and
"Apply status change". It also runs whenever someone edits files in `data/` directly on GitHub.

- **Repeated news is merged automatically.** This covers the same address (ignoring http/www,
  trailing slashes and tracking codes), the same headline, and the same story from another outlet
  within 3 days, recognised by shared distinctive words. The extra copy is kept as an "also reported
  by" link, so nothing is lost. Repeated changelog lines are merged too.
- **A possible duplicate platform or yard stops the run.** Examples: a reused id, the same name
  twice, the same project at the same site and yard, or two yards of one company within 1.5 km.
  Nothing is committed and GitHub emails you, because only a person can decide whether it's really
  one platform. Sister platforms of one project, such as two converter links, are not flagged.

Run it yourself with `python updater/check_data.py` (report only) or `--fix`.

## Installation sites and sailing routes

Each platform has a `site` with an approximate position of the wind-farm or grid-connection area.
When you select a platform, the map marks that site and draws the likely voyage: steel or module yard,
then fabrication yard, then outfitting yard, then the site. The route is the shortest path through a
network of shipping lanes and straits in `sea.js`. Voyages from Asia or the Gulf to Europe are assumed
to go round the Cape of Good Hope, avoiding the Red Sea. Routes are calculated in the browser, so they
follow automatically whenever a platform's yards or site change.

## Data confidence

Each platform has a `confidence` value of `high`, `medium` or `low`. Low means a yard or status was
inferred or is unconfirmed, for example the TenneT platforms reassigned from Petrofac to Hitachi Energy
and L&T. The list marks these as "unverified".
