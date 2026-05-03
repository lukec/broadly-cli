# Broadly CLI Implementation Spec

This file describes the implementation currently present in this repository.
It is a status-oriented implementation spec, not the Broad Listener product
roadmap. Product and strategy context remain in the sibling `../broadly` wiki.

## Purpose

`broadly-cli` is a local-first TypeScript CLI and artifact pipeline for
turning public-input datasets into inspectable opinion, analysis, and report
artifacts.

The current proof loop is:

1. initialize a local project
2. ingest a tabular dataset
3. configure the fields to analyze
4. register local model aliases
5. review and filter comments/opinions
6. extract opinion units
7. generate embeddings, reductions, clusters, themes, and perspectives
8. generate a report bundle
9. inspect the project, report, and review state in `broadly web`

The implementation is still a local workbench. It is not a hosted SaaS product.

## Runtime And Build

- Runtime: Node.js `20.11+`
- Package manager: npm workspaces
- Module format: ESM
- Language: TypeScript
- Build: `npm run build`, which runs `tsc -b`
- Optional reduction backend: Python `3.10+` with `pacmap` and `numpy`

The CLI package exposes the `broadly` executable from
`packages/cli/dist/index.js`.

## Package Boundaries

The repo is a workspace under `packages/*`.

| Package | Current responsibility |
| --- | --- |
| `@broadly/core` | Hashing, project path layout, artifact/run types, review status contracts, and shared paths for statements, votes, and attestations. |
| `@broadly/config` | `broadly.yaml` schema, YAML parse/serialize helpers, starter config generation, and cross-reference validation. |
| `@broadly/ingest` | CSV/TSV source import, delimiter detection, raw file copy, normalized record creation, field-map derived fields, and ingest manifests. |
| `@broadly/pipeline` | Early pipeline boundary and pass-through opinion-unit extraction helper. The richer LLM extraction and map analysis flow currently lives in `packages/cli`. |
| `@broadly/report-model` | TypeScript interfaces for report bundles, views, clusters, evidence quotes, themes, review boundary summaries, statement banks, vote rounds, and attestation manifests. |
| `@broadly/report-site` | Static HTML renderer for report bundles plus optional statement, vote, and attestation data. The active local UI is served by `packages/cli/src/commands/web.ts`. |
| `@broadly/cli` | User-facing commands, model runtime adapters, orchestration, local web server, review/admin UI, analysis, QA, and report bundle generation. |

The package split is ahead of the implementation in a few places. The code is
organized for future portability, but the CLI still owns most orchestration.

## Local Project Layout

`broadly init <project>` creates projects under `./projects/<project>` unless
an explicit path is supplied. The default layout is:

```text
project/
  broadly.yaml
  broadly.log
  data/
    raw/
    normalized/
      ingest-manifest.json
      <content-sha256>.json
    opinions/
      current-run.txt
      <opinion-run-id>/
        manifest.json
        records/
          <source-id>.json
        opinions/
          <opinion-id>.json
    embeddings/
      <extraction-name>/
        <embedding-model-name>/
          manifest.json
          <opinion-id>.json
    review/
      config.json
      comments/
      opinions/
      suggestions/
        comments/
        opinions/
  archive/
    opinions/
    analysis/
  llm-cache/
    text/
  prompts/
  runs/
    current-run.txt
    <analysis-run-id>/
      manifest.json
      reductions/
      clusters/
      hierarchies/
      perspectives/
      qa/
        current-run.txt
        <qa-run-id>/
          manifest.json
          scorecard.json
          provenance-check.json
          provenance-failures.jsonl
          clusters/
          themes/
  reports/
    <analysis-run-id>/
      report-bundle.json
      vote-summary.json
      site/
        index.html
        assets/
        data/
          report-bundle.json
          statements.json
          vote-summary.json
          attestation.json
          analysis/
            manifest.json
            reductions/
            clusters/
            hierarchies/
            perspectives/
  statements/
    current-run.txt
    <statement-run-id>/
      manifest.json
      statement-bank.json
      statements/
        <statement-id>.json
      qa/
      review/
        statements/
      accepted-statements.json
  votes/
    current-round.txt
    <vote-round-id>/
      manifest.json
      statements.json
      reaction-events.jsonl
      reaction-state.json
      summary.json
      exports/
  attestations/
    reports/
    statements/
```

Generated project artifacts are intentionally local and inspectable. They are
not meant to be committed to this repo.

## Project Config Contract

`broadly.yaml` is validated by `@broadly/config` with schema version `1`.

Top-level config sections are:

- `project`: name, slug, description, and goals.
- `models`: registered model aliases with provider, provider model id, and region.
- `dataset`: source path, format, encoding, delimiter, optional id column,
  optional allowed fields, and optional field map.
- `review_model`: optional model alias for content review.
- `qa_model`: optional model alias for QA checks.
- `questions`: guiding questions for analysis and report synthesis.
- `opinionExtractions`: named extraction specs with model and prompt path.
- `analysisViews`: named map/report view specs.
- `report`: report directory and primary view.
- `voting`: local voting configuration, currently `initialQuestions`.

The schema validates internal references:

- every opinion extraction must reference a registered model
- every analysis view must reference a configured opinion extraction
- every analysis view must reference a registered embedding model
- optional analysis models must be registered
- `report.primaryView` must match a configured analysis view
- `voting.initialQuestions[*].questionId` values must be unique

Current analysis view options are:

- reduction methods: `umap`, `pacmap`
- reduction dimensions: `2`
- clustering merge strategy: `semantic`
- synthesis modes: `balanced`, `dissent`

Current voting options are:

- `initialQuestions`: ordered yes/no/skip questions that every local voting
  participant must answer before statement voting

The starter config contains placeholder model aliases such as
`my-cheap-text-model`, `my-frontier-text-model`, and `my-embedding-model`.
Users must replace or register those aliases before running model-backed steps.

## CLI Surface

The current command surface is:

| Command | Purpose |
| --- | --- |
| `broadly init` | Create a project layout, starter config, review config, prompt files, and `broadly.log`. |
| `broadly ingest <file>` | Copy a CSV/TSV source into `data/raw`, normalize rows, and update dataset config. |
| `broadly configure dataset [file]` | Inspect dataset headers/samples/stats and configure field maps using an LLM or deterministic heuristics. |
| `broadly models add` | Add or update a project model alias and probe credentials. |
| `broadly models remove [name]` | Remove a project model alias. |
| `broadly models check [name]` | Check local credentials for one or all registered model aliases. |
| `broadly llm <prompt...>` | Run a prompt against one model alias or all aliases. |
| `broadly scrape bluesky` | Scrape recent public Bluesky posts into a project CSV and manifest. |
| `broadly review` | Generate machine review artifacts or suggestions for comments and/or opinions. |
| `broadly opinions` | Run configured LLM opinion extraction specs. |
| `broadly extract-opinions` | Compatibility wrapper around the configured opinion extraction path. |
| `broadly analysis` | Build embeddings, reductions, clusters, semantic hierarchies, and perspective artifacts. |
| `broadly report` | Generate `reports/<run-id>/report-bundle.json` from analysis artifacts. |
| `broadly report site` | Generate a self-contained static HTML report site under `reports/<run-id>/site/`. |
| `broadly qa` | Run structural and model-assisted QA over analysis/report artifacts. |
| `broadly statements generate --from-report` | Generate a pending statement bank from a report bundle and highlighted report evidence. |
| `broadly statements qa` | Run deterministic QA checks over generated statements. |
| `broadly statements review` | Apply local statement review statuses, text edits, and accepted-statement exports. |
| `broadly vote init` | Initialize a local voting round from accepted public statements. |
| `broadly vote web` | Serve the local reference voting sandbox. |
| `broadly vote export` | Export reaction state and statement-level vote results. |
| `broadly vote seed` | Add deterministic synthetic reactions for no-browser smoke testing. |
| `broadly vote analyze` | Summarize a local voting round. |
| `broadly vote report` | Attach a vote summary to the matching report artifacts. |
| `broadly attest report` | Write an unsigned hash manifest for a report bundle and supporting artifacts. |
| `broadly attest statements` | Write an unsigned hash manifest for a statement bank and supporting artifacts. |
| `broadly verify` | Verify local artifacts against one or more attestation manifests. |
| `broadly run` | Run review, opinions, analysis, and report as an end-to-end local pipeline. |
| `broadly status` | Print the same pipeline state used by the web overview. |
| `broadly web` | Serve the local project inspection, report, analysis, and review/admin UI. |

Commands accept `--project` where they need to find a project. Without it, they
walk upward from the current working directory until they find `broadly.yaml`.

## Ingest Implementation

The ingest boundary currently supports delimited tabular files.

Implemented behavior:

- reads the source file as bytes
- tries strict UTF-8 decoding, then falls back to Node `latin1`
- scores delimiter candidates `,`, tab, `;`, and `|`
- de-duplicates blank or repeated headers
- detects a likely id column from common names
- copies the raw source into `data/raw/<source-sha256>.<ext>`
- writes one normalized JSON file per non-empty row
- names normalized records by SHA-256 of rendered `contentText`
- writes `data/normalized/ingest-manifest.json`
- updates `broadly.yaml` with source path, format, encoding, delimiter, and id column

The normalized record shape includes:

- `sourceId`
- `contentSha256`
- `contentText`
- optional `derived` fields such as primary text, context, source label, and language
- `rawRow`
- provenance with import path, original path, source file hash, encoding,
  delimiter, source row number, and optional external id

If `dataset.allowFields` is configured, ingest only keeps matching fields. If
`dataset.fieldMap` is configured, derived fields are built from that map;
otherwise header heuristics choose likely primary text, context, title, source,
translation, and language fields.

Config schema allows more dataset formats than ingest currently implements.
The active importer is CSV/TSV-style delimited text.

## Dataset Configuration

`broadly configure dataset` previews a dataset before ingest or re-ingest.

It builds a local evidence packet containing:

- detected format, delimiter, and encoding
- headers
- row count
- sampled rows
- per-column non-empty counts, max lengths, and sample values

If a model alias is available, the command asks it to classify columns into:

- id
- primary text
- context
- source label
- language
- metadata
- mutable metrics
- excluded fields

The model output is sanitized deterministically. Unknown headers are discarded,
mutable/operational fields are forced out of analysis inputs, and a heuristic
fallback is used if the model call fails or no model is configured.

The command writes `dataset.allowFields` and `dataset.fieldMap` back into
`broadly.yaml`.

## Model Runtime

Registered model providers are:

- `bedrock`
- `google-cloud`
- `openai`

Text generation is routed through:

- AWS Bedrock `ConverseCommand`
- Google Cloud Vertex AI `generateContent`
- OpenAI Responses API

Embeddings are routed through:

- AWS Bedrock embedding models
- Google Cloud embedding models
- OpenAI embeddings API

Credential probing exists for all three providers through `broadly models add`
and `broadly models check`.

Text-generation responses are cached under `llm-cache/text/<cache-key>.json`.
The cache key includes provider, model alias, model id, region, prompt, max
output tokens, and temperature. Embeddings are cached as reusable per-opinion
embedding artifacts under `data/embeddings/<extraction>/<model>/`.

## Review And Inclusion Boundary

Review state is a first-class local artifact layer.

Supported review statuses are:

- `included`
- `excluded-non-substantive`
- `excluded-off-topic`
- `excluded-admin`
- `excluded-duplicate`

`data/review/config.json` stores which comment and opinion statuses should be
included in:

- analysis
- report output
- default web visibility

The default analysis/report boundary includes only `included`. Excluded content
remains on disk and visible in the admin UI.

The current analysis command applies the `analysis` inclusion boundary and
records that boundary in the analysis manifest. The report command carries that
recorded analysis boundary into `report-bundle.json`; it does not perform a
second independent report-time filter yet.

Review artifacts can apply to normalized comments or extracted opinions.
Opinion effective status is resolved from the opinion review plus the
underlying source comment review. Human review artifacts are preserved over
machine updates.

`broadly review` currently combines:

- heuristic duplicate and non-substantive checks
- optional model-backed off-topic/non-substantive screening
- review artifacts for confident exclusions
- suggestion artifacts for lower-confidence machine suggestions
- a review manifest with counts, model/prompt fingerprints, and thresholds

The web admin UI can edit individual comment/opinion review artifacts, perform
bulk status updates, and edit the review config.

## Opinion Extraction

Opinion extraction is driven by `opinionExtractions` in `broadly.yaml`.

Each configured extraction has:

- `name`
- optional `title`
- model alias
- prompt path

`broadly opinions` can run all configured extractions or a selected extraction.
It supports:

- `--model` override
- `--limit`
- `--offset`
- `--archive`
- `--resume`
- `--concurrency`

Run reuse is conservative. The command computes a fingerprint from:

- extraction name
- prompt SHA-256
- ingest manifest SHA-256
- input renderer SHA-256

If a compatible run exists, the command can resume it explicitly or continue it
by default. `--archive` moves prior opinion runs to `archive/opinions/` before
starting fresh. `--archive` and `--resume` are mutually exclusive.

Each opinion run writes:

- `data/opinions/<run-id>/manifest.json`
- `data/opinions/<run-id>/records/<source-id>.json`
- `data/opinions/<run-id>/opinions/<opinion-id>.json`
- `data/opinions/current-run.txt`

Record artifacts retain the raw model response, parsed split decision, split
rationale, and output opinion ids. Opinion artifacts retain:

- opinion id
- source id and source content hash
- opinion text
- supporting excerpt
- source fields
- extraction method
- model
- prompt path and hash
- response stop reason
- provenance back to the normalized record and original source row

The parser expects the starter prompt's header-style response format:

- `Split-Decision`
- `Split-Rationale`
- one or more `Opinion-Text` / `Source-Excerpt` / `Source-Fields` blocks

## Analysis

`broadly analysis` reads configured `analysisViews` and builds an analysis run.

The command groups views by source extraction and embedding model. For each
group it resolves the latest compatible opinion run, filters opinions through
the review config, applies optional offset/limit, and reuses compatible
embedding and run artifacts when possible.

An analysis run writes:

- `runs/<analysis-run-id>/manifest.json`
- `runs/<analysis-run-id>/reductions/*.json`
- `runs/<analysis-run-id>/clusters/*.json`
- `runs/<analysis-run-id>/hierarchies/*.json`
- `runs/<analysis-run-id>/perspectives/*.json`
- `runs/current-run.txt`

The analysis manifest records:

- run status
- fingerprint
- selected opinion counts
- review config hash and inclusion boundary
- extraction, embedding, and analysis models
- prompt paths and prompt hashes
- configured reduction methods, cluster counts, merge strategy, and views
- generated/reused/failed artifact counts

The current analysis stages are:

1. Embeddings
   - one embedding artifact per selected opinion
   - reused when model and opinion text hash still match
2. Reductions
   - `umap` through `umap-js`
   - `pacmap` through `packages/cli/scripts/pacmap_reduce.py`
   - PaCMAP prefers `./.venv-pacmap/bin/python`, then `python3`, then `python`
3. Clustering
   - `ml-kmeans` over 2D reduction points
   - deterministic seed derived from run/method/cluster count
   - representative opinions and top terms are selected for each cluster
4. Cluster labeling
   - LLM cluster labels and summaries using the configured cluster-labeling prompt
   - heuristic fallback exists when labeling fails
5. Semantic hierarchy
   - LLM semantic merge groups lower-level clusters into higher-level themes
   - writes one hierarchy artifact per labeled cluster view
6. Perspectives
   - LLM summary artifacts per configured view
   - includes title, summary, highlighted clusters, and rationale

Configured views are the durable unit for report variants. A view combines:

- source extraction
- embedding model
- optional analysis model
- prompt paths
- reduction method
- cluster count
- merge strategy
- mode (`balanced` or `dissent`)

## Report Bundle

`broadly report` publishes a report bundle from an analysis run.

Inputs:

- `runs/<run-id>/manifest.json`
- `runs/<run-id>/perspectives/*.json`
- `runs/<run-id>/clusters/*.json`
- `runs/<run-id>/hierarchies/*.json`
- `broadly.yaml`

Output:

- `reports/<run-id>/report-bundle.json`

The bundle contains:

- report id and analysis run id
- project name
- guiding questions
- primary view id
- review boundary summary, when available
- one report view per perspective artifact
- optional semantic themes
- highlighted clusters with evidence excerpts

`broadly report site` writes a standalone static site that can be opened from
disk without the local CLI server. It reads `report-bundle.json`, copies the
analysis JSON artifacts needed for drill-down, and includes optional statement
bank, vote summary, and attestation data when present or explicitly supplied.

Static site output:

```text
reports/<analysis-run-id>/site/
  index.html
  assets/
  data/
    report-bundle.json
    statements.json
    vote-summary.json
    attestation.json
    analysis/
      manifest.json
      reductions/
      clusters/
      hierarchies/
      perspectives/
```

The active interactive report reading experience remains `broadly web`, which
renders the bundle together with live local review, analysis, and statement
artifacts.

## Statements

The statement contract is implemented in `@broadly/report-model` and is ready
for command workflows to write local artifacts. A statement bank is a durable
set of votable statements derived from reports, clusters, themes, opinions, or
manual seeds.

Statement artifacts use:

- `Statement`
- `StatementBank`
- `StatementEvidenceRef`
- `StatementGenerationProvenance`
- `StatementModerationStatus`
- `StatementVisibilityStatus`

Statement moderation statuses are:

- `pending`
- `accepted`
- `rejected`
- `hidden_from_public`
- `excluded_from_analysis`

Statement visibility statuses are:

- `private`
- `admin_only`
- `public`

The implemented local artifact location is:

```text
statements/
  <statement-run-id>/
    manifest.json
    statement-bank.json
    statements/
      <statement-id>.json
  current-run.txt
```

The core project helpers expose `resolveStatementRunPaths`,
`resolveVoteRoundPaths`, and `resolveAttestationPaths` so later local and
hosted runners can write the same artifact layout.

`broadly statements generate --from-report` reads:

- `reports/<analysis-run-id>/report-bundle.json`
- highlighted clusters, themes, and evidence quotes already carried in that
  bundle

The first implementation is deterministic and local. It does not spend on a new
LLM call. The command records a generation prompt hash and generator id in the
manifest so a later model-assisted generator can reuse the same artifact shape.

Generation writes:

- `statements/<statement-run-id>/manifest.json`
- `statements/<statement-run-id>/statement-bank.json`
- `statements/<statement-run-id>/statements/<statement-id>.json`
- `statements/current-run.txt`

The manifest records the source report hash, analysis run id, generator id,
prompt hash, generated counts, duplicate counts, and failures. Compatible
reruns reuse the existing statement run and update `current-run.txt`.

All generated statements start as `pending` and `admin_only`. Deterministic
duplicate detection flags exact or high-overlap near duplicates with
`duplicateOfStatementId`.

`broadly statements qa` writes deterministic scorecards under:

```text
statements/<statement-run-id>/qa/<qa-run-id>/
  manifest.json
  scorecard.json
  statements/
    <statement-id>.json
```

Statement QA checks:

- evidence support
- neutral wording
- single-claim clarity
- duplicate risk
- scope fit
- participant comprehensibility
- usefulness for `agree` / `disagree` / `pass`

`broadly statements review` writes human review overlays under:

```text
statements/<statement-run-id>/review/statements/<statement-id>.json
```

It can accept, reject, change moderation status, edit statement text, attach a
note, and export accepted public statements to:

```text
statements/<statement-run-id>/accepted-statements.json
```

The `broadly web` local viewer includes a Statements page that shows pending,
accepted, rejected, hidden, and excluded statements, evidence references,
generation rationale, and basic local status/text edits. Web edits are review
overlays and do not mutate the generated statement bank.

## Local Voting Sandbox

The local voting sandbox is a reference workflow for the open vote contracts. It
is intentionally not a hosted participant product: there are no accounts, email
flows, CRM records, production moderation queues, or anti-abuse operations.

Vote contracts are implemented in `@broadly/report-model`:

- `ReactionEvent`
- `InitialQuestionResponseEvent`
- `ReactionState`
- `VoteInitialQuestion`
- `VoteRoundManifest`
- `VoteRoundSummary`
- `VoteStatementSummary`
- `VoteEvent`

Reaction values are:

- `agree`
- `disagree`
- `pass`

Initial question response values are:

- `yes`
- `no`
- `skip`

`broadly vote init --statements <path>` reads a statement bank or
`accepted-statements.json`, applies local review overlays when the source is a
generated `statement-bank.json`, and initializes a round from accepted
non-private, non-duplicate statements. It snapshots configured
`voting.initialQuestions` into the vote round manifest and reaction state so
later config edits do not rewrite historical rounds.

Voting artifacts live under:

```text
votes/
  <vote-round-id>/
    manifest.json
    statements.json
    reaction-events.jsonl
    reaction-state.json
    summary.json
    exports/
```

`reaction-events.jsonl` is append-only. It stores both statement reactions and
initial-question responses. `reaction-state.json` is the latest derived state by
participant id, initial question id, and statement id.

`broadly vote web` serves a small local form for anonymous or named-local
participant ids. Votes are persisted as reaction events and reflected in the
derived state. If a round has initial questions, each participant must answer
`yes`, `no`, or `skip` for all of them before the page shows statement voting.
The page labels itself as a local reference sandbox, not production civic
infrastructure.

`broadly vote export` writes:

- `exports/reaction-state.json`
- `exports/statements.json`
- `exports/initial-question-results.csv`
- `exports/statement-results.csv`

`broadly vote seed` adds deterministic synthetic initial-question answers and
participant reactions for fixture and smoke testing. It uses the same
append-only event stream and derived reaction state as the local web sandbox.

`broadly vote analyze` writes `summary.json` with initial-question totals,
statement-level totals, agreement/disagreement/pass rates, high-consensus
statements, high-contention statements, low-participation statements, and
bridge-candidate placeholders when enough participants exist for future richer
analysis.

`broadly vote report` copies the current vote summary to:

```text
reports/<analysis-run-id>/vote-summary.json
```

The `broadly web` report view displays that follow-up voting section when the
summary file is present.

## Attestation And Verification

The first attestation implementation uses unsigned hash manifests. It does not
yet manage signing keys. Verification works offline against local artifacts.

Attestation contracts are implemented in `@broadly/report-model`:

- `AttestationManifest`
- `AttestationArtifactRecord`

Attestation manifests live under:

```text
attestations/
  reports/
    <analysis-run-id>.attestation.json
  statements/
    <statement-run-id>.attestation.json
```

`broadly attest report` records hashes for the report bundle, analysis
manifest, ingest manifest when present, source dataset when present, opinion
manifests referenced by the analysis run, prompt files referenced by the
analysis run, and generated analysis artifacts under reductions, clusters,
hierarchies, and perspectives.

`broadly attest statements` records hashes for the statement bank, individual
statement artifacts, source report bundle, analysis manifest, ingest manifest
when present, source dataset when present, opinion manifests, and prompt files.

The manifest also records package version, publication timestamp, subject id,
analysis run id, and registered model references from `broadly.yaml`.

`broadly verify` checks every local attestation manifest by default, or a single
manifest passed with `--manifest`. It reports missing required artifacts and
hash mismatches with the affected artifact paths.

## QA

`broadly qa` runs checks against an analysis run and optional report bundle.

Phases:

- `structural`
- `cluster-membership`
- `theme-support`

Structural QA checks artifact consistency, provenance, cluster assignments,
highlight references, report evidence links, and theme references.

Model-assisted QA can review:

- whether sampled opinions fit their assigned clusters
- whether cluster labels/summaries are supported by sampled opinions
- whether semantic theme merges are coherent or overmerged

QA outputs live under:

```text
runs/<analysis-run-id>/qa/<qa-run-id>/
  manifest.json
  scorecard.json
  provenance-check.json
  provenance-failures.jsonl
  clusters/
  themes/
```

The QA command supports sampling controls such as `--sample-size`,
`--sample-percent`, `--qa-all`, `--view`, `--cluster-limit`, and
`--theme-limit`.

## Web UI And Status

`broadly status` and `broadly web` share the same dashboard loader in
`packages/cli/src/commands/projectDashboard.ts`.

Pipeline stages are:

- ingest
- opinions
- analysis
- report

Stage completion is derived from downstream artifacts, not just from the
existence of a run directory. Analysis is only complete when the latest run has
all expected embeddings, reductions, clusters, and perspectives without
failures.

`broadly web` serves a local inspection UI with:

- project overview
- pipeline state
- ingest preview
- opinion extraction run summaries
- analysis run summaries
- report view with perspective switching
- statement bank review with status and text edits
- follow-up voting summary when `vote-summary.json` is attached to a report
- scatterplots for clustered reductions
- theme and cluster exploration
- cluster detail pages with assigned opinions
- admin views for comments and opinions
- review config editing
- individual and bulk review updates

The server also has a `--watch` mode that reloads browser pages when project
files change.

## Bluesky Scraper

`broadly scrape bluesky` collects public posts from the Bluesky AppView API.

The command:

- resolves configured account handles
- runs one or more search queries
- applies `--since`, `--until`, or `--since-days`
- deduplicates posts by URI
- preserves existing first-seen `scraped_at`
- merges query/account match lists
- writes a CSV under `data/raw/`
- writes a scrape manifest under `data/raw/`

The default target is a Vancouver pulse dataset with City of Vancouver related
queries. The output is intended to be fed back through `broadly configure
dataset` and `broadly ingest`.

## Run Orchestration And Logging

Most project pipeline commands are wrapped in `withProjectActionLog`, which
appends JSONL events to `broadly.log`. `broadly init` also creates the log and
records an initialization event.

Events include:

- timestamp
- start/end/error state
- command
- process id
- cwd
- duration
- details or error message

`broadly run` orchestrates the local proof loop:

1. review, unless `--no-review`
2. opinions, unless `--no-opinions`
3. analysis, unless `--no-analysis`
4. report, unless `--no-report`

The review step is skipped if no review model is configured. It is also skipped
when an existing comment review manifest matches the current normalized corpus,
review model, and prompt hash.

## Current Gaps And Sharp Edges

The implementation is useful but not finished.

- The active analysis pipeline is still mostly in `@broadly/cli`, not in
  `@broadly/pipeline`.
- The static report site is intentionally simple HTML; richer offline maps and
  drill-down interactions can build on the copied JSON data.
- Statement generation is deterministic and report-derived in the first pass;
  it does not yet call a statement-specific LLM prompt.
- Statement QA is heuristic and local. It does not yet use a model judge.
- The local voting sandbox has no identity, spam resistance, participant
  clustering, or full Pol.is math.
- Vote analysis currently reports statement-level summaries only.
- Attestations are unsigned hash manifests. Signing can be added once the
  manifest shape is stable.
- Config accepts dataset formats that the current ingest command does not yet
  import.
- Raw and normalized source artifacts are content-addressed, but not every
  downstream artifact is content-addressed.
- Text LLM responses are cached in `llm-cache/text`; embedding reuse is
  artifact-based under `data/embeddings`, not a shared global LLM cache.
- Analysis run reuse is fingerprint-based, but there is no user-facing
  `analysis --archive` command yet.
- Perspective generation exists, but explicit per-perspective scoring and
  cross-run comparison are still thin.
- Human review/admin workflow exists locally, but there is no hosted workflow or
  account system.
- Infrastructure under `infra/terraform` is only a future placeholder.
- Evaluation against official consultation findings is not implemented.

## Verification

Repo-level verification remains:

```bash
npm run build
```

The no-LLM open-contract smoke workflow is:

```bash
npm run smoke:open-contracts
```

It creates an ignored throwaway project under
`projects/open-contracts-fixture/` and exercises statement generation,
statement QA, accepted-statement export, vote initialization, synthetic vote
seeding, vote analysis/export/report attachment, report and statement
attestation, verification, and static site export.

Use a throwaway Broadly project for smoke tests that could trigger model calls.
Do not use a user's active corpus as a test sandbox when LLM calls are involved.
