# Broadly CLI

Open-source local-first CLI for structured analysis of public-input and consultation datasets.

This repository is a standalone experiment in local-first qualitative analysis.
It is designed to ingest tabular feedback data, turn records into inspectable opinion artifacts, run clustering and synthesis steps, and produce a local report you can review in the browser.

The goal is narrow:

> Given a real consultation dataset and a set of analysis questions, generate a useful, evidence-linked, locally viewable report with more than one defensible interpretation of the data.

## Status

Active experimental CLI.

Current priorities:

- local-first project initialization
- YAML-based project config
- content-addressed local artifact layout
- inspectable ingest, extraction, and analysis artifacts
- reusable package boundaries for ingest, pipeline, report model, and report site

Not in scope yet:

- PDFs and report-pack ingestion
- hosted multi-tenant infrastructure
- multilingual support
- workflow features unrelated to the local analysis loop

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
broadly init my-first-project
```

The command prompts for:

- project name
- project description
- project goals

You can skip prompts with CLI args:

```bash
broadly init my-first-project \
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
broadly ingest ../../data/opengov-2017/engagement-compilation.csv
```

That command:

- copies the source file into the project's `data/raw`
- updates `broadly.yaml` to point at the copied raw file plus detected low-level file settings
- writes one normalized JSON artifact per non-empty row under `data/normalized`
- writes `data/normalized/ingest-manifest.json` with source provenance and ingest metadata
- names each JSON file with the SHA-256 hash of the row's flattened `contentText`

Register model aliases for the project:

```bash
broadly models add
```

The `models` command currently supports:

- Bedrock
- Google Cloud

During `models add`, Broadly prompts for the provider, the provider model name, and your project alias for that model. It then checks whether local credentials are available. If credentials are missing, it tells you what to fix and asks you to rerun:
It also prompts for the model region, which is stored in the project config and used later at execution time.

```bash
broadly models check
```

Run a simple prompt against one model alias:

```bash
broadly llm --model text-main "Tell me a joke"
```

Or run the same prompt against all registered models in parallel:

```bash
broadly llm --all-models "Tell me a joke"
```

Extract opinion artifacts from the normalized records:

```bash
broadly extract-opinions
```

By default, Broadly reuses a compatible opinion-extraction run if the model, prompt, and ingest fingerprint still match.
If you want to move older opinion runs out of the way before starting fresh:

```bash
broadly extract-opinions --archive
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

Projects also include `prompts/`, which is intended to hold reusable prompt files for stages such as opinion extraction and analysis.
New projects start with:

- `prompts/opinion-extraction.md`
- `prompts/analysis-cluster-labeling.md`
- `prompts/analysis-perspective-summary.md`

Check the current project state from the terminal:

```bash
broadly status
```

`broadly status` mirrors the overview shown by `broadly web`, including the main
pipeline stages and their current state.
The analysis stage is only shown as complete when the latest analysis run has
produced all configured reductions, clustering outputs, and perspectives.

Run the frontier-model hybrid taxonomy backend over the selected opinion run:

```bash
broadly analysis --strategy hybrid-taxonomy --project opengov2017
```

This path uses `codex exec` with `gpt-5.5` and medium reasoning by default.
It writes durable taxonomy artifacts under `taxonomies/<run-id>/` and updates
`taxonomies/current-run.txt`. The `broadly web` Theme Taxonomy page shows the
taxonomy-native map by default, with a vector overlay available for comparison
against the normal reducer coordinates.
Use `--dry-run` to prepare schemas, batches, and manifests without spending
Codex quota.

Or open the local web overview:

```bash
broadly web
```

The web view is a local inspection surface for the same project state and artifacts used by the CLI.

Generate and review votable statements from a completed report:

```bash
broadly statements generate --from-report
broadly statements qa
broadly statements review --accept <statement-id> --export-accepted
```

Run the local voting sandbox:

```bash
broadly vote init --statements statements/<statement-run-id>/statement-bank.json
broadly vote web
broadly vote analyze
broadly vote report
```

Projects can define `voting.initialQuestions` in `broadly.yaml`. Every local
participant is asked those yes/no/skip questions before statement voting.

Publish verifiable and static artifacts:

```bash
broadly attest report
broadly attest statements
broadly verify
broadly report site
```

Contract docs:

- [Statement bank format](./docs/statement-bank-format.md)
- [Reaction event format](./docs/reaction-event-format.md)
- [Attestation manifest](./docs/attestation-manifest.md)
- [Local voting sandbox](./docs/local-voting-sandbox.md)

Run the no-LLM open-contract smoke workflow:

```bash
npm run smoke:open-contracts
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
