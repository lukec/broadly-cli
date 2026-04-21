# PLAN

This document is the implementation-facing version of Broad Listener's `v0` local-first plan.

Canonical strategy context still lives in the sibling wiki:

- `/Users/lukec/src/broadly`
- `/Users/lukec/src/broadly/strategy/18-local-first-implementation-plan.md`
- `/Users/lukec/src/broadly/product/09-roadmap.md`

This file exists so work in this repo stays aligned with that plan without needing to reread the wiki for every coding session.

## Mission

Build a local-first TypeScript CLI that can:

1. initialize a Broadly project
2. ingest a real consultation dataset
3. preprocess comments into extracted opinion units
4. run map-oriented analysis with a small perspective-search loop
5. generate a local report bundle and view it in `broadly web` with evidence drill-down

The first proof target is narrow:

> given a real consultation corpus and guiding questions, produce a useful, legible, evidence-linked report with more than one defensible interpretation of the data

## Product Boundary For `v0`

Included:

- local CLI workflow
- project YAML config
- content-addressed local artifacts
- tabular and freeform-text dataset ingest
- extracted opinion units as the primary analysis object
- Bedrock-backed inference
- map-first analysis pipeline
- a small alternate-perspective search space
- local JSON report output rendered through `broadly web`
- timing and provenance capture

Deferred:

- hosted multi-tenant SaaS
- PDF-heavy source packs
- statement voting
- participant accounts
- CRM and follow-up
- connectors
- multilingual support

## Primary User

The default user is:

- a municipal engagement lead

That means the output should optimize for:

- usefulness
- relevance to guiding questions
- legible narrative
- inspectable evidence path

## Core Design Rules

### 1. Preserve Raw Source Records

Raw dataset content should stay immutable and inspectable.

### 2. Analyze Extracted Opinion Units

The main analysis object should be the extracted opinion unit, not only the whole source comment.

For raw consultation corpora, the ingest target should therefore be:

1. raw imported row
2. normalized source record
3. extracted opinion units or claims
4. later, optional derived statements for voting workflows

### 3. Keep Provenance Explicit

Artifacts should preserve:

- source hash
- prompt identifiers
- model identifiers
- timing
- upstream dependencies

### 4. Keep The Core Pipeline Portable

Core packages should be runnable both:

- locally from the CLI
- later in on-demand AWS workers

### 5. Stay Narrow

If a feature does not help prove the local analysis-and-report loop, it is probably out of scope for now.

## Repo Workstreams

### Phase 0: Project Skeleton

Goal:

- create the workspace and contracts that all later work depends on

Deliverables:

- monorepo structure
- package boundaries
- `broadly init`
- `broadly.yaml` schema
- project directory layout
- Bedrock wrapper boundary

Exit:

- a project can be initialized and configured reproducibly

Current status:

- complete for `v0`

### Phase 1: Ingest And Opinion Extraction

Goal:

- turn a tabular consultation dataset into normalized source records and extracted opinion units

Deliverables:

- ingest command
- CSV and TSV support first
- row hashing
- normalized source JSON output
- extraction prompt contract
- opinion-unit JSON output

Exit:

- one benchmark corpus can be ingested into inspectable opinion-unit artifacts

Current status:

- working on a real benchmark corpus
- ingest, normalization, opinion extraction, resume, archive, and cache boundaries are in place
- model/provider registry is in place for Bedrock, Google Cloud, and OpenAI

### Phase 2: Map Pipeline And Evidence Report

Goal:

- produce a first useful map-backed report artifact

Deliverables:

- embedding generation
- dimensionality reduction with a narrow first search space:
  - `umap`
  - `pacmap`
- clustering with a narrow first search space:
  - two cluster counts per run
- basic cluster labels
- brief narrative summary
- report bundle rendered through `broadly web`
- evidence drill-down from summary to source

Exit:

- one dataset produces a locally viewable report that is genuinely useful

Current status:

- embeddings are implemented and cached
- `umap` is implemented
- `pacmap` is implemented via a Python wrapper
- two cluster counts per run are implemented
- LLM-based cluster labeling, perspective summaries, and semantic higher-level theme merging are implemented
- report viewing in `broadly web` is implemented with scatterplots, cluster/theme exploration, and source-opinion drill-down
- remaining work is mainly report clarity, perspective switching, and overall usefulness

### Phase 3: Perspective Search

Goal:

- prove that multiple candidate readings are more useful than one brittle summary

Initial search axes:

- dimensionality reduction method:
  - `umap`
  - `pacmap`
- cluster count:
  - two configured values per project
- synthesis stance:
  - `balanced`
  - `dissent`

Notes:

- keep the first search space intentionally small so runs remain legible and comparable
- do not add a separate `consensus` synthesis mode in `v0`; the balanced pass should already surface clear areas of agreement where they exist

Deliverables:

- candidate perspective generation
- per-perspective scoring
- primary plus alternate perspectives
- comparison view or comparison output

Exit:

- one run produces meaningful alternate perspectives with visible tradeoffs

Current status:

- `balanced` and `dissent` perspectives are implemented
- report output can render multiple perspectives
- explicit per-perspective scoring is still missing
- comparison between alternative analyses or runs is still thin
- this phase is only partially complete

### Phase 4: Evaluation Harness

Goal:

- make the workflow repeatable across benchmark corpora

Deliverables:

- repeatable benchmark project configs
- run manifests
- timing capture
- comparison against official findings where available
- lightweight review checklist

Exit:

- runs can be compared on usefulness, relevance, and legibility

Current status:

- run manifests, timing capture, and project logging are implemented
- evaluation against official findings is not yet implemented
- lightweight human review tooling is not yet implemented
- cross-run benchmark comparison is not yet implemented

### Phase 5: Hosted Extraction

Goal:

- productize the proven local loop, not speculate ahead of it

Deliverables:

- separate local orchestration from reusable core pipeline
- move artifacts and orchestration into AWS-managed services
- preserve the same analysis contracts

Exit:

- hosted work is packaging of a proven loop

## Benchmark Strategy

Start with a very small benchmark set:

- one messier Canadian federal or provincial consultation corpus
- one richer international municipal corpus such as York

The goal is not benchmark breadth yet. The goal is to repeatedly run the same workflow against two credible but different corpora and learn where the pipeline breaks or becomes useful.

## Local Artifact Model

Expected project shape:

```text
project/
  broadly.yaml
  data/
    raw/
    normalized/
    opinions/
    embeddings/
  llm-cache/
  runs/
    <run-id>/
      manifest.json
      reductions/
      clusters/
      hierarchies/
      perspectives/
  reports/
    <run-id>/
      report-bundle.json
  archive/
```

This structure should remain the source of truth for local runs.

## Import Target Model

When Broadly imports a raw dataset, it should not map directly into a Pol.is-style `comment` or `statement` object unless the source system is already fundamentally vote-oriented.

Working rule:

- use a Pol.is-style import target for Pol.is conversations and other vote-native systems
- use a TTTC-style import target for raw consultation corpora, spreadsheets, exports, and report-adjacent source rows

For `v0`, the default import target for tabular corpora should be a normalized source record with explicit provenance and raw-row preservation.

### Normalized Source Record

The default ingest target should include:

- `sourceId`
- optional `submittedAt`
- optional `author`
- `body.rawText`
- optional translated text and subject fields
- imported annotations such as legacy theme labels
- explicit provenance
- general metadata
- full `rawRow`

The main implementation principle is:

- preserve source truth at ingest
- do not collapse imported annotations into Broadly's own analysis truth

Imported labels such as theme, sub-theme, commitment, or source-system categories should remain imported annotations unless and until Broadly's own analysis pipeline chooses to compare against them explicitly.

## OpenGov 2017 Mapping

The first concrete ingest target is:

- `/Users/lukec/src/broadly-cli/data/opengov-2017/engagement-compilation.csv`

This corpus is a good `v0` benchmark because it is a real mixed-source consultation export and already contains legacy labels, translation columns, and source/channel variation.

### Encoding

Import this file as:

- `cp1252`

Do not assume UTF-8. The French text decodes correctly under `cp1252`.

### Important Dataset Reality

This file appears to have:

- no reliable timestamp field
- no reliable person-level author field

So the importer should:

- leave `submittedAt` unset
- leave `author` unset or mark it as unknown
- treat `Source` as source type or channel, not as author identity

### Column Mapping

Recommended mapping for the first importer:

- `provenance.externalId` <- `ID`
- `provenance.sourceRowNumber` <- `Row/Ligne`
- `provenance.sourceType` <- `Source`
- `provenance.event` <- `Event / Événement`
- `provenance.prompt` <- `Context/Prompt / Contexte/Message-guide`
- `body.rawText` <- `Comment, Question or Idea (In source language)`
- `body.translatedText` <- `Comment, Question or Idea translation if available`
- `body.subject` <- `Subject`
- `body.translatedSubject` <- `Subject translation if available`
- `body.sourceLanguage` <- `Source Language`
- `annotations.theme` <- `Theme`
- `annotations.subTheme` <- `Sub-theme`
- `annotations.workingCommitment` <- `Working Commitment`
- `annotations.votes` <- `Votes`
- `annotations.quotable` <- `Quotable`
- `metadata` <- all remaining columns
- `rawRow` <- the full original CSV row

### Immediate Import Policy

For this corpus:

- preserve all imported theme and sub-theme labels as annotations
- do not treat imported `Theme` or `Sub-theme` as canonical Broadly `analysis_topic`
- do not treat imported `Votes` as Pol.is-style vote events
- keep the full row so future sessions can reinterpret the source if needed

## Expected CLI Surface

Near-term commands:

1. `broadly init`
2. `broadly ingest`
3. `broadly opinions`
4. `broadly report`
5. `broadly analysis`
6. `broadly web`
7. `broadly compare` later

Current working surface is broader than the initial bootstrap plan. The immediate implementation focus is now on:

1. improving report clarity and perspective switching
2. improving analysis quality and evaluation
3. adding cross-run comparison and benchmark review

## Acceptance Criteria

`v0` is successful if these claims become plausibly true:

- Luke finds the output genuinely useful
- the report answers the guiding questions well enough to think with
- the narrative is legible to a municipal engagement lead
- findings can be traced back to source evidence
- the workflow can show more than one defensible reading of the same corpus
- the system can roughly match official findings where available while surfacing defensible novel structure

## Immediate Next Steps

### Cost Framing

For near-term planning, use this rule:

- cheap = reuse existing local artifacts and avoid new paid model calls
- medium = limited model calls on a filtered subset
- expensive = corpus-wide or frontier-model reruns

The next implementation slices should favor cheap permutations and cheap scoring first, then spend model budget only on the most promising or suspicious cases.

### Analysis Quality Track

1. Add a two-stage cluster repair loop
   - cheap pass:
     - use embedding-space signals to flag suspicious members
     - candidate signals:
       - far from cluster centroid
       - much closer to another cluster centroid
       - low assignment margin between top candidate clusters
       - tiny or diffuse clusters
   - expensive pass:
     - send only flagged opinions to an LLM
     - ask for:
       - `fit | borderline | outlier`
       - best existing destination cluster from a short candidate list, or leave as-is
   - record full provenance:
     - original cluster
     - review verdict
     - reassignment target if any
     - rationale
     - model, prompt, and timestamp

2. Add a visible filtering layer plus admin web UI
   - build an admin view with:
     - table view of comments and opinions
     - per-record drill-down with related source comment, extracted opinions, and metadata
     - toggles for visible status flags
     - filtering by those flags
   - initial visible statuses should include:
     - `included`
     - `excluded-non-substantive`
     - `excluded-off-topic`
     - `excluded-admin`
     - `excluded-duplicate`
   - add an admin config page that decides which statuses are included in downstream analysis and in report visualization
   - all exclusions must remain visible, inspectable, and reversible

3. Expand cheap analysis search and cheap scoring
   - generate as many cheap candidate analysis variants as feasible before expensive synthesis
   - cheap axes should include:
     - reduction method
     - cluster count
     - random seed
     - local reassignment heuristics
   - cheap scoring should include:
     - cohesion / separation style signals
     - outlier rate
     - cluster size distribution
     - cluster stability across seeds and related runs
   - use those scores to choose a smaller handful of interesting candidate analysis versions for report generation and deeper review

4. Add duplicate collapse
   - detect exact duplicates and near-duplicates
   - keep duplicate handling visible and reversible
   - ensure duplicate collapse does not destroy provenance back to raw source records

5. Add a transparent topicality and substance screen
   - define a visible screen for:
     - on-topic substantive opinions
     - adjacent or weakly related opinions
     - off-topic opinions
     - non-substantive praise, logistics, or filler
   - decide whether this screen belongs:
     - before clustering
     - as an analyst-admin review layer
     - or as a hybrid workflow
   - keep this legitimacy-oriented:
     - excluded items remain reviewable
     - reasons stay explicit
     - analyst overrides remain auditable

6. Add cluster stability scoring
   - compare cluster membership under:
     - different seeds
     - different cluster counts
     - different reducers
   - surface stable versus brittle clusters in analysis scoring and report provenance

### UI And Comparison Follow-On

1. Continue tightening report usability
   - clearer perspective switching at the top of the report
   - stronger explanation of what differs between perspectives
   - more legible cluster and theme navigation
   - better expression of why a highlighted set of clusters was selected over the alternatives

2. Improve candidate-analysis comparison
   - per-analysis scoring
   - side-by-side comparison view/output
   - clearer explanation of which cheap knobs differ between candidate analyses

3. Continue benchmark and evaluation work
   - compare Broadly outputs with official summaries for benchmark corpora
   - add lightweight review checklists and evaluation notes

## Session Notes Worth Preserving

Recent implementation decisions that future sessions should assume unless explicitly changed:

- the first import target for raw corpora is TTTC-like, not Pol.is-like
- the core ingest object is a normalized source record with provenance and `rawRow`
- author and timestamp are important fields when available, but must remain optional
- imported labels from a source dataset should remain annotations, not be upgraded automatically into Broadly analysis truth
- `engagement-compilation.csv` should be treated as a benchmark corpus for the first importer
- paid-for LLM outputs are durable assets and should be archived, not casually deleted
- semantic theme merging should use real LLM output or fail cleanly, not heuristic fake themes

## Change Discipline

When this repo changes product assumptions, write the durable reasoning back into the wiki at `/Users/lukec/src/broadly`.

This repo should contain implementation truth.
The sibling wiki should contain product and strategy truth.
