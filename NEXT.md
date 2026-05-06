# NEXT

This document lists the next open-source implementation threads for `broadly-cli`.

The current repo can ingest a CSV/TSV corpus, extract opinion units, run map-oriented analysis, generate perspectives, produce a report bundle, run QA, and inspect the result in `broadly web`.

The next work should extend that proof loop into open public contracts:

```text
source data -> opinions -> analysis/report -> statements -> votes -> updated analysis/report
```

## Working Rule

After each phase is implemented, update `SPEC.md` in the same change.

`SPEC.md` should remain the status-oriented implementation spec. Do not describe planned behavior there until the phase is actually working.

For each completed phase, update at least:

- package boundaries, if a package gains responsibility
- local project layout, if new artifact directories are added
- project config contract, if `broadly.yaml` changes
- CLI surface, if commands are added
- artifact shapes and provenance notes
- current gaps and sharp edges
- verification instructions, if new smoke tests or workflows exist

## Open-Source Boundary

The broad product strategy is:

> open the evidence pipeline, keep acquisition, governance, and managed operations closed

These phases should stay on the open side of that line.

Good open-source targets:

- data contracts
- statement and vote schemas
- local reference workflows
- report and statement attestation
- deterministic report/site compilation
- evidence drill-down and verification tooling

Avoid pulling in closed-product concerns:

- hosted identity
- participant CRM
- spam and abuse operations
- production moderation consoles
- cross-customer analytics
- managed connector operations
- proprietary perspective-ranking and merge orchestration

## Phase 0: Hybrid Taxonomy Foundation

Goal:

- make the authoritative analysis layer a relevance-filtered, two-tier
  taxonomy-and-assignment system, with maps as exploratory navigation surfaces

Build:

```bash
broadly analysis --strategy hybrid-taxonomy
```

Inputs:

- reviewed opinion artifacts
- the review analysis inclusion boundary
- project framing questions
- existing embedding neighborhoods, graph surfaces, or vector clusters when
  available

Outputs:

```text
project/
  taxonomies/
    <taxonomy-run-id>/
      manifest.json
      inputs/
      schemas/
      prompts/
      taxonomy.json
      assignments.jsonl
      assignment-summary.json
      qa/
        false-friends.json
```

Implementation notes:

- the project questions define the default relevance boundary
- comments or opinions marked `excluded-off-topic` stay preserved in review
  artifacts but are excluded from primary taxonomy, summaries, and maps by
  default
- review config can include off-topic statuses for intentionally open-ended
  projects
- use embeddings and graph surfaces for neighborhoods, duplicate detection,
  outlier surfacing, and scatterplot coordinates
- use a frontier model for the top-level category and subgroup taxonomy design
- use lower-cost cached model calls for bulk assignment when the taxonomy is
  stable enough
- target 3-6 top-level categories and 2-8 subgroup themes per category, while
  allowing an unbalanced tree
- record primary category, primary subgroup theme, secondary subgroup themes,
  confidence, rationale, evidence quote, uncertainty flag, and false-friend
  boundary checks for each assignment
- split broad inclusion buckets through subgroups rather than adding report
  role labels
- defer official benchmark recall QA, vector-versus-taxonomy comparison, and
  special small-theme promotion rules until they are needed by a specific
  benchmark or report

Exit criteria:

- `hybrid-taxonomy` produces durable taxonomy and assignment artifacts without
  overwriting the vector `runs/` pipeline
- false-friend QA checks assignment leakage against theme exclusion rules
- primary report generation can consume the taxonomy layer without pulling
  off-topic comments into the main analysis
- scatterplot/report UI can drill from a top-level category into its subgroup
  opinion space
- `SPEC.md` documents the implemented command, artifacts, and relevance
  boundary

## Phase 1: Statement Bank Contract

Goal:

- define the durable artifact shape for votable statements derived from reports, clusters, themes, and opinions

Build:

- `@broadly/core` or `@broadly/report-model` types for:
  - `Statement`
  - `StatementBank`
  - `StatementEvidenceRef`
  - `StatementGenerationProvenance`
  - `StatementModerationStatus`
- a local artifact location:

```text
project/
  statements/
    <statement-run-id>/
      manifest.json
      statement-bank.json
      statements/
        <statement-id>.json
    current-run.txt
```

Suggested statement fields:

- `statementId`
- `statementText`
- `statementKind`
  - `extracted`
  - `synthesized`
  - `seed`
  - `manual`
- `moderationStatus`
  - `pending`
  - `accepted`
  - `rejected`
  - `hidden_from_public`
  - `excluded_from_analysis`
- `visibilityStatus`
  - `private`
  - `admin_only`
  - `public`
- `sourceOpinionIds`
- `sourceClusterIds`
- `sourceThemeIds`
- `evidenceRefs`
- `generationRationale`
- `duplicateOfStatementId`
- `createdAt`
- `provenance`

Exit criteria:

- statement bank schema is implemented and exported from a package
- artifact paths are defined in shared project helpers
- no LLM call is required yet
- `npm run build` passes
- `SPEC.md` documents the new contract

## Phase 2: Report-To-Statement Generation

Goal:

- generate a pending statement bank from an existing report bundle and analysis artifacts

Build:

```bash
broadly statements generate --from-report
```

Inputs:

- `reports/<analysis-run-id>/report-bundle.json`
- `runs/<analysis-run-id>/clusters/*.json`
- `runs/<analysis-run-id>/hierarchies/*.json`
- `runs/<analysis-run-id>/perspectives/*.json`
- extracted opinion artifacts

Outputs:

- `statements/<statement-run-id>/statement-bank.json`
- one JSON file per generated statement
- `manifest.json` with prompt hash, model id, source report hash, analysis run id, and generation counts

Implementation notes:

- start with one command and one prompt
- generate statements from highlighted clusters and themes first
- keep all generated statements as `pending`
- preserve evidence links back to the report, cluster, opinion, and source excerpt
- dedupe obvious exact or near-exact duplicates deterministically before model-assisted dedupe

Exit criteria:

- a completed report can produce a statement bank
- each statement has evidence provenance
- failed or partial statement generations are reflected in the manifest
- reruns reuse compatible outputs where practical
- `SPEC.md` documents the command and artifacts

## Phase 3: Statement QA And Review

Goal:

- decide whether generated statements are crisp, fair, evidence-grounded, and worth asking people to vote on

Build:

```bash
broadly statements qa
broadly statements review
```

QA dimensions:

- evidence support
- neutral wording
- single-claim clarity
- duplicate risk
- too broad / too narrow
- likely participant comprehensibility
- usefulness of an `agree` / `disagree` / `pass` vote

Artifacts:

```text
project/
  statements/
    <statement-run-id>/
      qa/
        <qa-run-id>/
          manifest.json
          scorecard.json
          statements/
            <statement-id>.json
      review/
        statements/
          <statement-id>.json
```

Web UI:

- add statement bank view to `broadly web`
- show pending / accepted / rejected statements
- show evidence refs and generation rationale
- allow basic status edits

Exit criteria:

- reviewer can accept/reject/edit the generated statement set locally
- QA results are inspectable and linked to statement ids
- accepted statements can be exported separately from pending/rejected statements
- `SPEC.md` documents statement QA and review behavior

## Phase 4: Local Voting Sandbox

Goal:

- create a small local reference implementation for Pol.is-style voting without turning this repo into the hosted participant product

Build:

```bash
broadly vote init --statements statements/<statement-run-id>/statement-bank.json
broadly vote web
broadly vote export
```

Open contracts:

- `ReactionEvent`
- `ReactionState`
- vote export format
- statement export format

Reaction values:

- `agree`
- `disagree`
- `pass`

Artifact layout:

```text
project/
  votes/
    <vote-round-id>/
      manifest.json
      statements.json
      reaction-events.jsonl
      reaction-state.json
      exports/
```

Scope:

- local-only voting surface
- no accounts
- no email
- no CRM
- no hosted anti-abuse system
- simple anonymous or named-local participant ids
- clear warning that this is a reference sandbox, not production civic infrastructure

Exit criteria:

- accepted statements can be loaded into a local voting round
- local participants can vote `agree`, `disagree`, or `pass`
- votes are stored as append-only reaction events
- latest reaction state can be exported
- `SPEC.md` documents the sandbox and its intentional limits

## Phase 5: Vote Results Re-Ingest And Round-Trip Analysis

Goal:

- prove the loop from report-derived statements to vote data and back into analysis

Build:

```bash
broadly vote analyze
broadly vote report
```

Initial outputs:

- statement-level vote totals
- agreement / disagreement / pass rates
- high-consensus statements
- high-contention statements
- low-confidence or low-participation statements
- bridge-candidate placeholders if enough data exists later

Do not overbuild:

- no full Pol.is math is required in the first pass
- no participant clustering is required until there is enough synthetic or real vote data to justify it
- no hosted identity or spam resistance

Useful next step after the first pass:

- import or generate synthetic vote matrices so the local analysis can be exercised before real users exist

Exit criteria:

- vote results can be summarized locally
- vote summaries can reference original statement evidence
- the report view can show a "follow-up voting round" section
- `SPEC.md` documents vote analysis and report integration

## Phase 6: Signed Report And Statement Attestation

Goal:

- make published report and statement artifacts independently verifiable

Build:

```bash
broadly attest report
broadly attest statements
broadly verify
```

Attestation manifest should include:

- report bundle hash
- statement bank hash, when relevant
- source dataset hash or hashes
- normalized ingest manifest hash
- opinion extraction run id and manifest hash
- analysis run id and manifest hash
- prompt paths and prompt hashes
- model provider/model ids
- code version or package version
- generated artifact hashes
- publication timestamp

Implementation notes:

- start with unsigned hash manifests if that is faster
- then add signing once the manifest shape is stable
- verification should work offline against local artifacts

Exit criteria:

- a report bundle can be hashed and verified
- a statement bank can be hashed and verified
- verification failures point to the missing or changed artifact
- `SPEC.md` documents attestation and verification

## Phase 7: Static Report Site Publisher

Goal:

- turn the local report bundle into a self-contained static site that can be shared without running `broadly web`

Build:

```bash
broadly report site
```

Inputs:

- `report-bundle.json`
- analysis artifacts needed for maps and drill-down
- optional statement bank
- optional vote round summary
- optional attestation manifest

Outputs:

```text
project/
  reports/
    <analysis-run-id>/
      site/
        index.html
        assets/
        data/
```

Site should include:

- overview
- guiding questions
- primary perspective
- alternate perspectives
- theme and cluster exploration
- evidence drill-down
- methodology and provenance
- generated statement bank, if present
- vote results section, if present
- attestation/verification metadata, if present

Exit criteria:

- the generated site can be opened directly from disk
- no CLI server is required for report review
- site data remains traceable to source artifacts
- `SPEC.md` documents static site generation

## Phase 8: Documentation And Developer Path

Goal:

- make the new open contracts understandable to contributors

Build:

- README updates for the new workflow
- concise docs for:
  - statement bank format
  - reaction event format
  - attestation manifest
  - local voting sandbox limitations
- one small fixture or synthetic project path that exercises:
  - report generation
  - statement generation
  - statement QA
  - local voting
  - vote analysis
  - attestation
  - static site export

Exit criteria:

- a contributor can understand the end-to-end open pipeline without reading source code first
- `npm run build` passes
- any fixture workflow avoids accidental paid LLM calls unless explicitly opted in
- `SPEC.md` is current

## Recommended Order

Implement in this order:

1. statement bank contract
2. report-to-statement generation
3. statement QA and review
4. local voting sandbox
5. vote results re-ingest and round-trip analysis
6. signed report and statement attestation
7. static report site publisher
8. documentation and developer path

This keeps the work consecutive and avoids building participant-facing surfaces before the evidence-backed statement contract is solid.
