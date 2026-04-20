# QA Plan

## Goal

Implement `broadly qa` as a run-attached criticism command for Broadly report outputs.

The command should:

- inspect an existing analysis run and its published report bundle
- write durable QA artifacts beside that run
- compute a visible scorecard instead of hiding everything behind one number
- stay compatible with the repo's local-first, inspectable-artifact model

This plan assumes `broadly qa` is a review step after `broadly analysis` and usually after `broadly report`.

## Proposed Command Shape

Initial command surface:

```bash
broadly qa --project <project> --run <analysis-run-id>
```

Recommended defaults:

- `--project` defaults to the nearest `broadly.yaml`
- `--run` defaults to `runs/current-run.txt`, then latest analysis run
- report bundle is read from `reports/<run-id>/report-bundle.json` when present
- judge model for later phases defaults to `qa_model`, with `--model <alias>` as an override
- when no `--phase` flags are provided, Broadly should treat all currently implemented phases as enabled candidates
- when no `--phase` flags are provided, Broadly should prompt before each phase and require `y` or `Y` to proceed
- this prompt-first behavior is important because later phases spend tokens and should default to saving cost

Recommended later options:

- `--phase <name>` to run only one QA phase
- `--model <alias>` to choose a frontier judge model
- `--sample-size <n>` for cluster or report review sampling
- `--sample-percent <percent>` for percentage-based review sampling
- `--qa-all` to review all eligible items and disable sampling
- `--resume` to continue an incomplete QA run

Sampling resolution for model-assisted phases:

1. `--qa-all` overrides all sampling limits
2. otherwise use explicit CLI sampling options when present
3. otherwise use configured defaults
4. if no explicit sampling options are present and `--qa-all` is not set, semantic QA should sample by default rather than reviewing every eligible item

`--qa-all` is intended for gold-standard benchmark passes where cost is acceptable and we want the most complete possible criticism artifact set.

## Artifact Model

QA should be append-only because later phases will include paid model judgments.

Recommended layout:

```text
runs/<analysis-run-id>/
  qa/
    current-run.txt
    <qa-run-id>/
      manifest.json
      scorecard.json
      provenance-check.json
      provenance-failures.jsonl
      clusters/
      themes/
      perspectives/
      report/
      cross-run/
```

Why this shape:

- it keeps QA attached to the analysis run it criticizes
- it preserves durable model-assisted review outputs
- it leaves room for multiple QA passes with different prompts or judge models

The QA manifest should include:

- `qaRunId`
- `analysisRunId`
- `reportBundlePath`
- `createdAt`
- `updatedAt`
- `status`
- `fingerprint`
- `input`
- `output`

The fingerprint should include:

- analysis run id
- report bundle hash if present
- selected phases
- judge model alias if used
- QA prompt hashes once prompts exist
- sample settings, including whether `qaAll` was enabled

## Package Boundaries

Keep the first implementation narrow:

- `packages/cli`
  command orchestration, file loading, output writing, terminal summary
- `packages/pipeline`
  QA artifact interfaces and pure evaluation helpers once the shapes stabilize
- `packages/config`
  add optional `qa_model` so projects can pin a separate judge model
- `packages/report-model`
  no immediate changes required

This avoids creating a new package before the workflow proves itself, while still leaving a clean path to move reusable QA types out of the CLI.

## Project Config

Add a top-level optional project config field:

```yaml
qa_model: my-frontier-judge
```

Intent:

- keep QA-model choice explicit at the project level
- let benchmark and test datasets use a stronger frontier model than the main analysis path
- avoid coupling report criticism quality to whatever model was cheapest or fastest for generation

Recommended resolution order:

1. `--model <alias>` when explicitly passed to `broadly qa`
2. `qa_model` from `broadly.yaml`
3. fallback to `analysis_model` only for backward compatibility

If a model-assisted QA phase is requested and none of those resolve, the command should fail with a clear message.

Recommended later QA config additions:

```yaml
qa_model: my-frontier-judge
qa:
  defaultSamplePercent: 20
  maxSampleSizePerCluster: 25
```

`--qa-all` should always override these defaults.

## Phase 1 In Detail

### Objective

Ship a real `broadly qa` command that performs deterministic structural QA with no model calls.

This phase should answer:

- are the run and report artifacts internally consistent?
- do report quotes, opinions, normalized records, and source paths line up?
- do we have enough structural integrity to trust later semantic QA?

### Why Phase 1 Comes First

If the evidence chain is broken, semantic scoring is not trustworthy.

This phase is also:

- cheap to run
- easy to verify
- valuable immediately
- compatible with the repo's preference for inspectable local artifacts

### Scope

Phase 1 includes:

- new `broadly qa` CLI command
- project config support for `qa_model`
- analysis run discovery
- optional report-bundle discovery
- QA run directory creation
- deterministic provenance and consistency checks
- initial scorecard and manifest writing
- concise terminal summary

Phase 1 does not include:

- frontier-model judgments
- new prompt files
- semantic cluster-fit scoring
- perspective or report narrative critique
- web UI integration

Because Phase 1 is deterministic and non-sampled, `--qa-all` is not functionally needed yet. The flag becomes active when Phase 2 introduces model-assisted sampling.

### Inputs

The command should read:

- `broadly.yaml`
- `runs/<run-id>/manifest.json`
- `runs/<run-id>/clusters/*.json`
- `runs/<run-id>/hierarchies/*.json`
- `runs/<run-id>/perspectives/*.json`
- `reports/<run-id>/report-bundle.json` if present
- opinion artifacts under `data/opinions/<opinion-run-id>/opinions/`
- normalized records via opinion provenance pointers
- raw import files via normalized and opinion provenance pointers where available

The critical source of truth for opinion provenance is the analysis manifest's `input.opinionRunId`.

### Checks

Phase 1 should implement these checks first.

#### Run integrity

- analysis manifest exists and parses
- referenced subdirectories exist
- cluster, hierarchy, and perspective JSON files parse
- report bundle, if present, matches the same analysis run id

#### Cluster integrity

- every representative opinion id resolves to a real opinion artifact
- every cluster member opinion id resolves to a real opinion artifact
- representative opinions are consistent with member assignments where applicable

#### Perspective integrity

- every highlighted cluster id resolves to a real cluster in the referenced cluster artifact
- `chosenClusterArtifactPath` exists when present
- report bundle perspectives map cleanly to perspective artifacts

#### Evidence integrity

- every opinion artifact has a readable `normalizedRecordPath`
- every normalized record path exists
- `sourceContentSha256` matches expectations where it can be checked
- quoted excerpts from report evidence appear in the linked opinion text or excerpt
- source import path exists when present

#### Soft consistency warnings

- cluster summaries with zero representative opinions
- perspectives with zero highlights
- themes that reference missing cluster ids
- report bundle missing even though analysis artifacts exist

### Output Artifacts

Phase 1 should write:

```text
runs/<analysis-run-id>/qa/<qa-run-id>/
  manifest.json
  scorecard.json
  provenance-check.json
  provenance-failures.jsonl
```

Suggested initial shapes:

`manifest.json`

- run metadata
- selected phases: `["provenance"]`
- status: `running` | `completed` | `completed-with-failures`
- requested sampling settings, even if unused in Phase 1
- counts for files checked, failures, warnings

`provenance-check.json`

- totals by check family
- severity counts
- per-artifact summary
- paths to failure logs

`provenance-failures.jsonl`

- one record per failure or warning
- fields: `severity`, `kind`, `path`, `message`, `context`

`scorecard.json`

- `provenanceIntegrity`
- placeholder entries for later dimensions with status `not-scored-yet`

Recommended scorecard shape:

```json
{
  "qaRunId": "qa-2026-04-16T17-00-00-000Z",
  "analysisRunId": "analysis-...",
  "overall": {
    "status": "partial",
    "score": null
  },
  "dimensions": {
    "provenanceIntegrity": {
      "status": "scored",
      "score": 96,
      "warnings": 3,
      "errors": 2
    },
    "clusterMembershipQuality": {
      "status": "not-scored-yet"
    },
    "clusterThemeSupport": {
      "status": "not-scored-yet"
    },
    "perspectiveFidelity": {
      "status": "not-scored-yet"
    },
    "reportCoverage": {
      "status": "not-scored-yet"
    }
  }
}
```

### Scoring Rules

Phase 1 should score only `provenanceIntegrity`.

Recommended formula:

```text
provenance_integrity =
  100
  - 20 * fatal_failures
  - 8 * errors
  - 2 * warnings
```

With floor at `0`.

Severity guidance:

- `fatal`
  missing analysis manifest, unreadable run structure, report bundle points to another run
- `error`
  missing opinion artifact, missing normalized record, missing cluster reference
- `warning`
  excerpt mismatch, empty representative evidence, missing optional report bundle

Do not compute a final overall QA score yet. Mark the scorecard as `partial`.

### CLI Behavior

Phase 1 terminal output should stay short and useful.

Example:

```text
QA run: qa-2026-04-16T17-00-00-000Z
Analysis run: analysis-openai-...
Phase: provenance
Files checked: 482
Fatal: 0
Errors: 2
Warnings: 5
Scorecard: runs/<run-id>/qa/<qa-run-id>/scorecard.json
```

Exit-code policy:

- exit `0` when QA completed with only warnings
- exit non-zero when fatal failures exist
- consider exit non-zero for errors as well if the command is later used in automation

### Implementation Slice

Recommended file changes for Phase 1:

- `packages/cli/src/commands/qa.ts`
  new command implementation
- `packages/cli/src/index.ts`
  register `broadly qa`
- `packages/config/src/index.ts`
  add optional `qa_model` to the project schema
- `packages/pipeline/src/index.ts`
  add `QaManifest`, `QaScorecard`, `QaIssue`, and provenance result interfaces

Keep Phase 1 out of `packages/report-site`.

### Suggested Internal Structure

Inside `packages/cli/src/commands/qa.ts`, keep the first cut simple:

1. resolve project root and target analysis run
2. load project config and resolve `qa_model` metadata if present
3. resolve or create QA run directory
4. load manifest, clusters, hierarchies, perspectives, and optional report bundle
5. load opinion artifacts for the manifest's opinion run
6. run deterministic checks and accumulate issues
7. compute provenance score
8. write manifest, scorecard, and failure log
9. print summary and set exit code

Use `withProjectActionLog` so QA activity lands in `broadly.log`.

### Verification

Phase 1 verification should include:

- `npm run build`
- run `broadly qa` against a healthy analysis run
- run `broadly qa` against a deliberately damaged throwaway run and confirm failures are detected

Suggested manual test cases:

- remove one opinion artifact referenced by a cluster
- change a report bundle `analysisRunId`
- corrupt one `chosenClusterArtifactPath`
- point one opinion at a missing normalized record

### Exit Criteria

Phase 1 is done when:

- `broadly qa` exists and runs locally
- it writes a durable QA run with manifest and scorecard
- it catches broken provenance and broken report references
- it produces a trustworthy structural gate before semantic QA begins

## Subsequent Phases: Executive Summary

### Phase 2: Cluster Membership QA

Add semantic cluster-fit review.

Main work:

- add judge prompt(s) and use resolved `qa_model`
- sample opinions per cluster unless `--qa-all` is set
- combine frontier-model fit judgments with embedding and neighbor signals
- write cluster-level membership artifacts and outlier lists
- score `clusterMembershipQuality`

Primary output:

- `clusters/<cluster-id>-membership.json`
- `clusters/<cluster-id>-outliers.json`

Why this phase matters:

- it directly tests whether the cluster contents make sense
- it gives the first real semantic quality score for the report

`--qa-all` behavior in this phase:

- review every eligible opinion in every scored cluster
- still preserve deterministic traversal order so reruns are comparable
- write larger artifact sets rather than collapsing results into only sampled summaries
- print a clear cost warning before running if model calls are required

Default non-`--qa-all` behavior in this phase:

- sample cluster members by default
- use explicit `--sample-size` / `--sample-percent` when provided
- otherwise prefer a bounded default sample so broad QA passes do not silently explode in cost
- show progress as clusters are reviewed so long-running judge passes do not look hung

### Phase 3: Cluster Theme Support And Merge Review

Add review of what the clusters claim to be about.

Main work:

- judge whether source comments support each cluster label and summary
- judge whether higher-level themes over-merge distinct clusters
- add `clusterThemeSupport` and `themeMergeQuality` dimensions
- preserve exact review packets and model outputs

Primary output:

- `clusters/<cluster-id>-theme-support.json`
- `themes/<theme-id>-merge-review.json`

Why this phase matters:

- a cluster can be internally tight but still badly labeled
- a report can become misleading at the higher theme layer even if lower clusters are decent

`--qa-all` behavior in this phase:

- review all eligible source comments for theme-support checks where feasible
- review all theme merges in the run, not only a sampled subset
- allow cluster-level exhaustive review even if report-level review remains summarized

Default non-`--qa-all` behavior in this phase:

- sample source opinions per cluster for theme-support review
- keep theme-merge review bounded by the selected themes in scope
- show explicit progress output or progress bars for both cluster theme-support review and theme merge review
- do not leave the CLI looking idle while model-assisted review is running

### Phase 4: Perspective And Report QA

Move from cluster quality to report quality.

Main work:

- judge whether perspective summaries are faithful to their highlighted clusters
- judge whether the report answers guiding questions
- score evidence coverage, dissent visibility, and report coverage
- write perspective and report review artifacts

Primary output:

- `perspectives/<perspective-id>-review.json`
- `report/report-review.json`

Why this phase matters:

- this is where `broadly qa` starts answering whether the report is actually useful to a reader, not just structurally valid

`--qa-all` behavior in this phase:

- review every perspective in the run
- review every highlighted cluster reference in those perspectives
- expand report-evidence checks to all available report quotes, not only a sample

### Phase 5: Cross-Run Robustness And Surfacing

Add comparison and operational usefulness.

Main work:

- compare the current run with nearby runs
- score stability of major clusters, themes, and conclusions
- surface latest QA summary in `broadly status`
- later, add QA readouts to the local web viewer

Primary output:

- `cross-run/nearby-run-comparison.json`

Why this phase matters:

- it separates strong results from brittle ones
- it makes QA usable for run selection rather than only post-hoc diagnosis

### Phase 6: Benchmarks And Human Review Hooks

Make the system credible beyond one project.

Main work:

- compare Broadly outputs with official findings where benchmark corpora exist
- add manual reviewer notes beside model judgments
- track disagreement between judges and humans
- calibrate score bands such as `high confidence` and `needs review`

Why this phase matters:

- it turns QA from an internal convenience feature into a real evaluation discipline

## Recommended Implementation Order

1. Phase 1 structural gate
2. Phase 2 cluster membership QA
3. Phase 3 theme support and merge review
4. Phase 4 perspective and report QA
5. Phase 5 cross-run robustness and surfacing
6. Phase 6 benchmark and human review support

This order keeps the system honest:

- first verify the evidence chain
- then judge cluster contents
- then judge cluster claims
- then judge report narratives
- then judge stability across runs

## Recommendation

`broadly qa` should begin as a structural gate plus durable scorecard writer, not as a giant all-at-once frontier-model workflow.

## Current Status

As of the current implementation:

- Phase 1 structural gate is implemented
- Phase 2 cluster membership review is implemented
- Phase 3 cluster theme-support and merge review is implemented
- default no-flag QA should be a prompted, opt-in walk through all currently implemented phases
- semantic QA should stay sampled-by-default unless `--qa-all` is explicitly requested
- long-running semantic phases should show progress clearly so users can tell the tool is still working

Phase 1 is the right first slice because it creates:

- a real command
- a durable artifact model
- a trustworthy precondition for later semantic QA

Once that foundation exists, the later phases can add model-assisted criticism without turning the QA layer into an opaque black box.

When semantic QA arrives, `--qa-all` should be the explicit exhaustive mode for benchmark and gold-standard passes. It should trade time and cost for coverage, and it should be preserved in the QA manifest so those runs can be compared separately from ordinary sampled QA runs.
