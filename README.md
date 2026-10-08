# CineMetrics v2: Movie Comparison Dashboard with Backend + Database

Node.js + SQLite. **No npm install needed** (zero dependencies). Requires Node >= 22.13.

## Run locally
    node server.js          # http://localhost:3000
    PORT=8080 ADMIN_TOKEN=mysecret node server.js

## What is stored (SQLite, file: data/cinemetrics.db)
- `catalog`: 106 films (from `catalog.csv`) searchable by name; reloaded from the CSV on every start
- `films`: title, year, genre, director, budget, gross, scores, reviews (JSON), source (seed / pool / custom)
- `comparisons` + `comparison_films`: every saved comparison (saved history, shareable as /?c=ID)

## REST API
| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/health | status + film count |
| GET | /api/films | all films |
| POST | /api/films | add custom film (validated) |
| GET | /api/catalog/search?q= | typeahead over the full catalog |
| POST | /api/catalog/import | bulk-add films `{films:[...]}` (admin token if set) |
| POST | /api/films/lookup | add a film by name `{name}`: searches the catalog, then TMDB if `TMDB_KEY` is set; 404 if unknown, 409 if several match |
| DELETE | /api/films/:id | remove a non-seed film (admin token if set) |
| DELETE | /api/films | remove all non-seed films (admin token if set) |
| POST | /api/comparisons | save a chosen comparison `{ids:[..]}` |
| GET | /api/comparisons, /api/comparisons/:id | history / one comparison |

## Deploy
The SQLite file needs a persistent disk, so use a host with a volume:
- **Render / Railway / Fly.io:** create a Web Service from this folder (Dockerfile included), start command `node server.js`, mount a persistent disk at `/app/data` (or set `DB_PATH`), set `ADMIN_TOKEN`.
- **Docker:** `docker build -t cinemetrics . && docker run -p 3000:3000 -v cm-data:/app/data -e ADMIN_TOKEN=secret cinemetrics`
- **VPS:** `node server.js` behind nginx/Caddy (HTTPS), run with pm2 or systemd.
- Static hosts (Netlify/GitHub Pages) also work: serve `public/index.html` only. The page detects there is no backend and falls back to browser storage.

## Security notes
Inputs are validated and use parameterised SQL; user text is HTML-escaped in the UI; static paths are confined to `public/`. Set `ADMIN_TOKEN` so strangers cannot reset the shared database. No rate limiting is included; put the app behind your host's proxy limits for public use.

## Getting more films (three ways)
1. **Import button (easiest):** click **Import films (CSV)** on the page and choose a file. With the backend running, the films go into the shared database catalog (up to 50,000 per file; requires `ADMIN_TOKEN` if you set one). Without a backend they are kept in that browser only.
   - Columns needed: `title`, `budget`, `gross` (or `revenue`). Optional: `year` (or `release_date`), `genre(s)`, `director`, `imdb` (or `vote_average`), `rt`, `metacritic`, `audience`, `runtime`, `oscars`.
   - Comma, tab or pipe separated. Budget and gross above 100,000 are treated as dollars and converted to $M. Missing scores are estimated from the rating; films without a budget above 0 are skipped.
   - Public datasets with these columns exist (for example the TMDB 5000 movies dataset on Kaggle). I haven't verified a specific download, so check its terms and columns first.
2. **Edit `catalog.csv`** (`title|year|genre|director|budget $M|gross $M|imdb|rt|metacritic|audience|runtime|oscars`) and restart. For the offline page, also update the `CSV` constant in `public/index.html`.
3. **Live lookup of any film:** get a free key at themoviedb.org and run `TMDB_KEY=yourkey node server.js`. Names not in the catalog are fetched from TMDB and stored. TMDB supplies title, year, genre, director, budget, revenue, runtime, its own vote average and up to 8 real user reviews (trimmed to 400 characters) that feed the text analytics; the RT / Metacritic / audience fields are estimated from that vote average and Oscars are set to 0. Films with no budget or revenue on TMDB are rejected.

Typeahead uses `GET /api/catalog/search?q=` so it stays fast with thousands of films. Bulk import API: `POST /api/catalog/import {films:[...]}`.
Catalog figures I entered were typed from memory and are approximate. Verify anything you present as fact.

## Deploy on Render (free plan, one click config)
1. Push this folder to GitHub. 2. On render.com choose **New > Blueprint**, pick the repo (it reads `render.yaml`). 3. Paste your `TMDB_KEY` when asked. 4. Open the `onrender.com` address. On the free plan the service sleeps after inactivity and the database resets on restart (the catalog reloads from `catalog.csv`). A paid plan plus a disk (see `render.yaml`) keeps added films and saved comparisons.
