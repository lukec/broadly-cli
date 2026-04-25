# Vancouver Pulse Bluesky Spike

Date: 2026-04-25

## Findings

- The City of Vancouver is on Bluesky as `cityofvancouver.bsky.social`.
- The account resolves to DID `did:plc:7brixalgia3ruluej43s5hyb`.
- The profile display name is `City of Vancouver ` and its description is `Official #CityofVancouver account`.
- The public profile and actor search APIs work without credentials.
- Post search works from `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts`.
- The documented public AppView host, `https://public.api.bsky.app`, returned `403` for post search in this spike. The scraper therefore defaults to `https://api.bsky.app`.

## Local Project

The local spike project is:

```bash
projects/vancouver-pulse/
```

The current scrape writes:

```bash
projects/vancouver-pulse/data/raw/bluesky-vancouver-pulse.csv
projects/vancouver-pulse/data/raw/bluesky-vancouver-pulse-manifest.json
```

The CSV can be ingested through the normal Broadly tabular ingest path. The initial 30-day scrape collected 168 unique posts and normalized 168 records.

## API Notes

- Actor lookup: <https://docs.bsky.app/docs/api/app-bsky-actor-search-actors>
- Post search: <https://docs.bsky.app/docs/api/app-bsky-feed-search-posts>

## Refresh Commands

From the repository root:

```bash
node packages/cli/dist/index.js scrape bluesky \
  --project projects/vancouver-pulse \
  --since-days 30 \
  --limit 500

node packages/cli/dist/index.js ingest \
  projects/vancouver-pulse/data/raw/bluesky-vancouver-pulse.csv \
  --project projects/vancouver-pulse
```

For a periodic job, use a smaller overlap window such as `--since-days 7`. The scraper merges by Bluesky post URI, so overlapping runs update counts and avoid duplicate rows.

The raw CSV retains engagement counts. The `vancouver-pulse` project config excludes those mutable count fields from ingest so periodic re-ingests do not create duplicate normalized records when only engagement counts changed.

## Default Queries

The scraper uses these default queries:

- `"City of Vancouver"`
- `cityofvancouver`
- `"Vancouver city hall"`
- `"Vancouver City Council"`
- `CityofVancouver`

The search endpoint rejects some query shapes such as a bare `@handle` or hashtag-only query with guidance to use the firehose or Jetstream. The `cityofvancouver` query is the practical search fallback for posts that typed the official handle.
