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
5. generate a local static report site with evidence drill-down

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
- local static report output
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

- scaffolded

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

### Phase 2: Map Pipeline And Evidence Report

Goal:

- produce a first useful map-backed report artifact

Deliverables:

- embedding generation
- dimensionality reduction
- clustering
- basic cluster labels
- brief narrative summary
- local static report site
- evidence drill-down from summary to source

Exit:

- one dataset produces a locally viewable report that is genuinely useful

### Phase 3: Perspective Search

Goal:

- prove that multiple candidate readings are more useful than one brittle summary

Initial search axes:

- cluster count
- dimensionality reduction variant or settings
- synthesis stance: balanced, consensus, dissent

Deliverables:

- candidate perspective generation
- per-perspective scoring
- primary plus alternate perspectives
- comparison view or comparison output

Exit:

- one run produces meaningful alternate perspectives with visible tradeoffs

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
  runs/
    <run-id>/
      manifest.json
      timings.json
      perspectives/
      report-bundle.json
  reports/
    <run-id>/
      site/
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
3. `broadly run`
4. `broadly report`
5. `broadly compare`

Only `init` exists today. The next implementation priority is `ingest`.

## Acceptance Criteria

`v0` is successful if these claims become plausibly true:

- Luke finds the output genuinely useful
- the report answers the guiding questions well enough to think with
- the narrative is legible to a municipal engagement lead
- findings can be traced back to source evidence
- the workflow can show more than one defensible reading of the same corpus
- the system can roughly match official findings where available while surfacing defensible novel structure

## Immediate Next Steps

1. Implement `broadly ingest`.
2. Implement CSV decoding with explicit encoding support, starting with `cp1252`.
3. Persist `rawRow` JSON blobs and normalized source-record JSON blobs separately.
4. Define the extracted opinion-unit format.
5. Add a Bedrock client boundary for extraction tasks.
6. Create a real project config for `data/opengov-2017/engagement-compilation.csv`.
7. Persist ingest outputs into `data/raw`, `data/normalized`, and later `data/opinions`.

## Session Notes Worth Preserving

Recent implementation decisions that future sessions should assume unless explicitly changed:

- the first import target for raw corpora is TTTC-like, not Pol.is-like
- the core ingest object is a normalized source record with provenance and `rawRow`
- author and timestamp are important fields when available, but must remain optional
- imported labels from a source dataset should remain annotations, not be upgraded automatically into Broadly analysis truth
- `engagement-compilation.csv` should be treated as a benchmark corpus for the first importer

## Change Discipline

When this repo changes product assumptions, write the durable reasoning back into the wiki at `/Users/lukec/src/broadly`.

This repo should contain implementation truth.
The sibling wiki should contain product and strategy truth.
