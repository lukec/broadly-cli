# Broadly CLI

Open-source local-first CLI and analysis harness for Broad Listener.

This repository is the implementation workspace for **Phase 0** of the Broad Listener plan: prove the analysis loop on real consultation corpora before productizing it as a hosted listening studio.

The current goal is narrow:

> Given a real consultation dataset and a set of guiding questions, generate a useful, evidence-linked, locally viewable report with more than one defensible interpretation of the data.

The strategy context for this repo lives in the sibling wiki at `/Users/lukec/src/broadly`.

## Status

Early scaffold.

Phase 0 priorities:

- local-first project initialization
- YAML-based project config
- content-addressed local artifact layout
- Bedrock-backed preprocessing and analysis wrappers
- future package boundaries for ingest, pipeline, report model, and report site

Not in scope yet:

- hosted multi-tenant infrastructure
- PDFs and report-pack ingestion
- statement voting
- participant accounts
- multilingual support

## Repository Layout

- `packages/cli`
  user-facing CLI entrypoint and commands
- `packages/config`
  project config schema and YAML serialization
- `packages/core`
  shared types, hashing, provenance, and filesystem helpers
- `packages/ingest`
  dataset import and normalization package boundary
- `packages/pipeline`
  extraction, embeddings, clustering, and perspective-search boundary
- `packages/report-model`
  report bundle and evidence model boundary
- `packages/report-site`
  static report-site rendering boundary
- `infra/terraform`
  future hosted infrastructure modules

## Getting Started

Requirements:

- Node.js `20+`
- npm `10+`

Install dependencies:

```bash
npm install
```

Build the workspace:

```bash
npm run build
```

Initialize a local project:

```bash
node packages/cli/dist/index.js init my-first-project
```

The command prompts for:

- project name
- project description
- project goals

You can skip prompts with CLI args:

```bash
node packages/cli/dist/index.js init my-first-project \
  --name "My First Project" \
  --description "Neighborhood mobility feedback analysis" \
  --goal "Identify the main concerns in the corpus" \
  --goal "Surface areas of agreement and disagreement"
```

That creates:

- `projects/my-first-project/broadly.yaml`
- `data/raw`
- `data/normalized`
- `data/opinions`
- `runs`
- `reports`

## Open Source Intent

This repo is intended to become the open implementation surface for Broad Listener's local CLI, evidence pipeline, report model, and report viewer.

It is being set up so the same core packages can later run:

- locally during research and benchmarking
- in a hosted AWS environment with on-demand execution

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
