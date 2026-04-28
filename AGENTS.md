# AGENTS.md

This repository is the **implementation repo** for Broad Listener's open-source local CLI and report pipeline.

It is intentionally separate from the sibling wiki at `../broadly`, which remains the canonical product and strategy knowledge base.

If you are an agent working here, optimize for:

- clean package boundaries
- inspectable local artifacts
- reproducible project setup
- long-term portability from local runs to on-demand AWS execution

## Dev notes

- always make clean, documented, discrete commits
- commit and push your work when you're done

## First Orientation

Start with:

1. [README.md](./README.md)
2. this file
3. the most relevant package README or source files
4. the sibling wiki when product context matters:
   - `../broadly/index.md`
   - `../broadly/strategy/18-local-first-implementation-plan.md`
   - `../broadly/product/09-roadmap.md`

Do not treat this repo as the place to rediscover product strategy from scratch. The sister repo wiki exists for that.

## Broader Context

When implementation work needs broader context about the problem domain, product thesis, municipal use case, or prior strategy decisions, read from the sibling wiki at:

- `../broadly`

Especially useful pages include:

- `../broadly/index.md`
- `../broadly/product/01-product-overview.md`
- `../broadly/product/03-core-workflows.md`
- `../broadly/market/11-demo-datasets-and-public-corpora.md`
- `../broadly/strategy/15-explanation-search-and-perspectives.md`
- `../broadly/strategy/18-local-first-implementation-plan.md`

Use that repo for broader domain understanding. Use this repo for implementation truth.

## Repo Purpose

This repo should initially cover the `v0` proving stage:

- local-first CLI
- project YAML setup
- content-addressed local artifact model
- tabular dataset ingest
- preprocessing into extracted opinion units
- map-oriented analysis pipeline
- alternate-perspective generation
- local static report site

This repo is not yet the hosted SaaS product.

## Repository Layout

- `packages/core`
  shared types, hashing, provenance, path helpers
- `packages/config`
  project config schema and YAML serialization
- `packages/cli`
  user-facing commands
- `packages/ingest`
  dataset import and normalization boundary
- `packages/pipeline`
  extraction, embeddings, clustering, summarization, perspective-search boundary
- `packages/report-model`
  report bundle and evidence object boundary
- `packages/report-site`
  static report rendering boundary
- `infra/terraform`
  future hosted infrastructure modules

## Working Rules

### 1. Keep The Wiki And Code Separate

- implementation lives here
- durable product reasoning lives in `../broadly`

If code changes product assumptions, update the wiki in a separate pass rather than stuffing strategy prose into source comments.

### 2. Favor Reusable Package Boundaries

The same core pipeline should later be runnable:

- locally from the CLI
- remotely in hosted workers

So avoid baking local shell assumptions directly into core packages.

### 3. Preserve Provenance Early

Prefer designs that keep:

- raw source content immutable
- extracted opinion units tied back to source records
- prompt/model/version metadata explicit
- run timing explicit

### 3a. Treat LLM Outputs As Durable Assets

Paid-for LLM outputs are not scratch data.

Agents working in this repo should assume:

- LLM-generated artifacts should be durable and reusable by default
- destructive deletion of generated artifacts is exceptional, not normal workflow
- runs should be append-only or archived, not casually replaced
- if a workflow needs a "fresh" start, prefer archiving old outputs over deleting them
- if a response can be reused safely by fingerprint, it should be cached and reused

Do not archive or replace generated runs in an active project unless the user explicitly asks for that exact action.

When testing, avoid spending user money unnecessarily:

- prefer compatibility checks and resume paths over rerunning paid steps
- prefer a dedicated throwaway test project for CLI smoke tests
- do not use the main working project as a test sandbox when LLM calls are involved

Shared cacheable LLM outputs should live outside project-specific data when that improves reuse.
The expected direction for this repo is a separate `llm-cache/` area for fingerprinted reusable responses.

### 4. Default To Narrow, Real Implementations

Do not add large placeholder frameworks just to look complete.

Good:

- a real `init` command
- a real config schema
- a real artifact layout

Bad:

- large abstract systems with no working path through them

### 5. Keep Phase 0 Scope Tight

Avoid pulling in:

- multi-tenant SaaS concerns
- PDF ingestion
- participant CRM
- live-room workflow
- multilingual surfaces

unless explicitly requested.

## Editing Guidance

- Prefer ASCII unless the file already uses Unicode.
- Keep comments sparse and useful.
- Preserve a clean workspace layout.
- Do not commit generated project artifacts, datasets, or `node_modules`.
- Prefer small, composable files over giant utility dumps.

## Verification

When you add or change code, verify at the repo level when practical:

- `npm run build`

Add narrower package-level checks later as the codebase grows.

## Default Principle

This repo should grow like a serious open-source implementation project, not like a scratchpad.

When in doubt:

- keep source records immutable
- keep derived records explicit
- keep LLM-generated artifacts durable
- prefer archive-over-delete for generated runs
- test in a throwaway project, not the user's active corpus
- keep package boundaries clean
- keep product reasoning in the wiki
