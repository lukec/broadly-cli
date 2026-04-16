# Broadly CLI

Open-source local-first CLI and analysis harness for Broad Listener.

This repository is the implementation workspace for **Phase 0** of the Broad Listener plan: prove the analysis loop on real consultation corpora before productizing it as a hosted listening studio.

The current goal is narrow:

> Given a real consultation dataset and a set of analysis questions, generate a useful, evidence-linked, locally viewable report with more than one defensible interpretation of the data.

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
- Python `3.10+` if you want to run `pacmap` reductions

Install dependencies:

```bash
npm install
```

Build the workspace:

```bash
npm run build
```

Optional: enable the `pacmap` reduction backend in a repo-local virtual environment:

```bash
python3 -m venv .venv-pacmap
.venv-pacmap/bin/python -m pip install pacmap numpy
```

Broadly will automatically prefer `./.venv-pacmap/bin/python` when running `pacmap` reductions.

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
- `archive`
- `llm-cache`
- `prompts`
- `runs`
- `reports`

Register a tabular data source from inside the project directory:

```bash
cd projects/my-first-project
node ../../packages/cli/dist/index.js ingest ../../data/opengov-2017/engagement-compilation.csv
```

That command:

- copies the source file into the project's `data/raw`
- updates `broadly.yaml` to point at the copied raw file plus detected low-level file settings
- writes one normalized JSON artifact per non-empty row under `data/normalized`
- writes `data/normalized/ingest-manifest.json` with source provenance and ingest metadata
- names each JSON file with the SHA-256 hash of the row's flattened `contentText`

Register model aliases for the project:

```bash
node ../../packages/cli/dist/index.js models add
```

The `models` command currently supports:

- Bedrock
- Google Cloud

During `models add`, Broadly prompts for the provider, the provider model name, and your project alias for that model. It then checks whether local credentials are available. If credentials are missing, it tells you what to fix and asks you to rerun:
It also prompts for the model region, which is stored in the project config and used later at execution time.

```bash
node ../../packages/cli/dist/index.js models check
```

Run a simple prompt against one model alias:

```bash
node ../../packages/cli/dist/index.js llm --model text-main "Tell me a joke"
```

Or run the same prompt against all registered models in parallel:

```bash
node ../../packages/cli/dist/index.js llm --all-models "Tell me a joke"
```

Extract opinion artifacts from the normalized records:

```bash
node ../../packages/cli/dist/index.js extract-opinions
```

By default, Broadly reuses a compatible opinion-extraction run if the model, prompt, and ingest fingerprint still match.
If you want to move older opinion runs out of the way before starting fresh:

```bash
node ../../packages/cli/dist/index.js extract-opinions --archive
```

Opinion extraction:

- reads each normalized JSON record from `data/normalized`
- writes one configured extraction batch under `data/opinions/<run-id>/`
- keeps a `data/opinions/current-run.txt` pointer for downstream commands
- archives older runs into `archive/opinions/` when you use `--archive`
- caches model responses under `llm-cache/` so compatible reruns do not spend tokens again

The project config now declares:

- `questions`
- `opinionExtractions`
- `analysisViews`
- `report.primaryView`

So `broadly opinions`, `broadly analysis`, and `broadly report` can follow the named extraction and view specs from `broadly.yaml` instead of relying on a single implicit default model.

Projects also include `prompts/`, which is intended to hold reusable prompt files for stages such as opinion extraction.
New projects start with:

- `prompts/opinion-extraction.md`
- `prompts/analysis-cluster-labeling.md`
- `prompts/analysis-perspective-summary.md`

Check the current project state from the terminal:

```bash
node ../../packages/cli/dist/index.js status
```

Or open the local web overview:

```bash
node ../../packages/cli/dist/index.js web
```

## Open Source Intent

This repo is intended to become the open implementation surface for Broad Listener's local CLI, evidence pipeline, report model, and report viewer.

It is being set up so the same core packages can later run:

- locally during research and benchmarking
- in a hosted AWS environment with on-demand execution

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
