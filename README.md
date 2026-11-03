# مِرصد (Mirsad)

The Mirsad prototype, wired to real news. A small Node server pulls the outlets' RSS/Atom feeds, groups items that report the same story across outlets, and serves them to the app at `/api/stories`.

```sh
npm install
npm run check-feeds   # which feed URLs in feeds.json actually work
npm start             # http://localhost:8787
npm test
```

## Publishing it as a website (GitHub Pages)

The site needs no server. `.github/workflows/publish.yml` runs every 30 minutes (and on every push to `main`): it runs the tests, then `npm run build:static`, which fetches every feed and writes `dist/index.html` plus `dist/stories.json`, then publishes `dist/` to GitHub Pages.

- **Which feeds work:** open the latest run under the repo's **Actions** tab. Its summary lists every feed with ✓ or ✗.
- **If every feed fails,** the build stops and the previous version stays online.
- **One-time setup:** in the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
- **Keep it running:** GitHub pauses scheduled jobs in repos with no activity for 60 days. Any push, or re-enabling the workflow in the Actions tab, restarts it.

## How it fits together

```
feeds.json ──► lib/aggregate.js ──► lib/parse.js          RSS 2.0 / RDF / Atom, windows-1256, HTML cleanup
                 │                  lib/corroborate.js    clustering + reliability
                 ▼
            server.js  GET /api/stories   {generatedAt, stories[], sources[]}
                       GET /api/health    per-feed status
                       GET /*             public/index.html (the app)
```

- **Caching:** results are cached for 5 minutes (`CACHE_TTL_SECONDS`). The app's refresh button sends `?refresh=1`, which bypasses the cache but never refetches more than once a minute (`MIN_REFETCH_SECONDS`).
- **Failures:** a broken feed never breaks the response. It shows up in `sources[]` with `ok: false` and is logged.
- **Other settings:** `PORT` (default 8787) and `FEEDS_FILE`.

## How reliability is assigned

| Level | Rule |
|---|---|
| مؤكد (confirmed) | 2+ different outlets published matching headlines within 48h |
| مرجّح (likely) | a single outlet, nothing matching elsewhere yet |
| غير مؤكد (unverified) | the wording hedges ("أنباء عن", "غير مؤكدة", "شائعات"…) |
| إشاعة (rumor) | not produced. It needs a source (social accounts) the server doesn't fetch yet |

Matching compares headline keywords, weighting rare words more, after Arabic normalization and stripping of articles and prefixes. Role words like "وزير" or "رئيس" are ignored. Each item is compared only with a cluster's first item, so look-alike stories don't chain together. It deliberately leans towards **not** merging, because a wrong "confirmed" is worse than a missed one. The app shows the reasons for each rating and states that the rating is automatic.

## Known limits

- **Feed URLs are unverified.** They were written without network access to the sites. Run `npm run check-feeds` and fix or remove any that fail. Outlets with no working feed just produce no stories.
- **Country = the outlet's country,** not where the event happened.
- **No translation.** English and French feeds (Times of Israel, L'Orient, TelQuel) appear in their original language and are labeled as such. Adding translation would mean an LLM call in `buildStories`, setting `translated: true`.
- **No denial check.** Confirmed means "corroborated", not "fact-checked". The app's definition of confirmed also mentions "no denial", which isn't checked.
- **Social accounts aren't fetched.** The settings screen still lets you add them, but they produce no stories.
- **Behind a proxy:** Node's `fetch` ignores `HTTPS_PROXY` unless you run with `NODE_USE_ENV_PROXY=1`.
