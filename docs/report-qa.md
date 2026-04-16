# Report QA

## Purpose

This document proposes a practical quality-assurance framework for evaluating the end result of a Broadly report run.

The goal is not to pretend there is one perfect scalar truth about a report. The goal is to:

- preserve inspectable criticism artifacts
- use frontier models where semantic judgment is genuinely useful
- produce a reasonable scorecard for a report run
- make it easy to see why a run is strong or weak

This fits the current Broadly direction of keeping multiple criticism axes visible rather than collapsing everything too early into one opaque number.

## Core Principle

A report should be judged from the bottom up:

1. do opinions actually fit the cluster they were assigned to?
2. do the source comments actually support the claimed cluster theme?
3. do higher-level themes really unify the clusters they merge?
4. do perspective summaries faithfully reflect the cluster evidence?
5. does the report answer the guiding questions with adequate coverage and evidence?

A final run score can exist, but it should be derived from visible component scores.

## Recommended QA Phases

### Phase 1: Evidence And Provenance Sanity

Before semantic judging, verify the mechanical basics:

- every report quote points to a real opinion artifact
- every opinion artifact points to a real normalized record
- every normalized record points to a real source import
- quoted excerpts actually appear in the source text
- cluster and perspective artifacts are internally consistent with the run manifest

This should be mostly deterministic. If this phase fails, semantic scores should be treated as suspect.

Suggested outputs:

- `runs/<run-id>/qa/provenance-check.json`
- `runs/<run-id>/qa/provenance-failures.jsonl`

### Phase 2: Opinion-To-Cluster Fit

This is the first major semantic QA step.

Question:

> Given the cluster label, summary, and nearby opinions, does this opinion actually belong in this cluster?

This directly addresses the user's first two concerns.

### Signals

- embedding affinity to cluster centroid
- distance from nearest same-cluster neighbors
- distance from nearest alternate-cluster neighbors
- frontier-model judgment of thematic fit
- frontier-model judgment of whether the item is an outlier, borderline member, or strong member

### Frontier-model review packet

For each sampled opinion, provide:

- cluster label
- cluster summary
- 5 to 10 representative opinions from the same cluster
- 3 nearest opinions from neighboring clusters
- the candidate opinion

Ask the model for structured output such as:

- `verdict`: `strong-fit` | `weak-fit` | `misfit`
- `fit_score`: 0 to 1
- `better_cluster_candidate`: optional cluster id
- `reason`

### Practical scoring

For each opinion:

- `semantic_fit_score`
- `geometric_fit_score`
- `neighbor_agreement_score`

Example combined score:

```text
opinion_fit =
  0.50 * semantic_fit_score +
  0.30 * geometric_fit_score +
  0.20 * neighbor_agreement_score
```

Use this both to score the cluster and to flag suspect opinions for review.

### Cluster-level outputs

- mean opinion fit
- median opinion fit
- percent of strong-fit opinions
- percent of weak-fit opinions
- percent of misfits
- top outliers

Suggested artifacts:

- `runs/<run-id>/qa/clusters/<cluster-id>-membership.json`
- `runs/<run-id>/qa/clusters/<cluster-id>-outliers.json`

### Phase 3: Cluster Theme Support

Question:

> If we read the actual source comments behind this cluster, do they really support the claimed label and summary?

This is slightly different from Phase 2. Phase 2 checks whether items belong together. Phase 3 checks whether the cluster description is a faithful claim about them.

### Signals

- frontier-model judgment of label accuracy
- frontier-model judgment of summary fidelity
- specificity score for the label
- contradiction rate inside the cluster
- proportion of sampled source comments that clearly support the claimed theme

### Review packet

For each cluster, provide:

- cluster label
- cluster summary
- top terms
- representative opinions
- a stratified sample of source comments from the cluster

Ask:

- does the label name the real shared concern?
- is the summary supported by the sample?
- is the label too vague, too broad, or misleading?
- what fraction of sampled comments clearly support the theme?

### Useful sub-scores

- `theme_support_precision`
- `label_specificity`
- `summary_fidelity`
- `internal_contradiction_penalty`

This phase should produce a cluster score that is understandable by a human reviewer, not just a model trace.

### Phase 4: Theme-Merge Defensibility

For runs that merge lower-level clusters into higher-level themes:

Question:

> Do these clusters belong together semantically, or are we over-merging adjacent but distinct issues?

### Signals

- frontier-model merge judgment over the member clusters
- label and summary similarity
- overlap in representative evidence
- centroid proximity as a weak supporting signal only

### Sub-scores

- `merge_defensibility`
- `theme_coherence`
- `over_merge_risk`

This is important because a report can have decent lower-level clusters but still become misleading at the theme layer.

### Phase 5: Perspective And Narrative Fidelity

Question:

> Does each perspective summary fairly describe the clusters it highlights, and does it make a real tradeoff rather than just paraphrasing the same story?

This phase evaluates the perspective artifacts, not only the clusters.

### Signals

- faithfulness of the perspective summary to highlighted clusters
- relevance to guiding questions
- evidence coverage across major clusters
- dissent visibility
- novelty relative to other perspectives in the same run

### Frontier-model checks

For each perspective:

- does the summary overclaim beyond the evidence?
- which clusters materially support the summary?
- what important tension is omitted?
- how different is this perspective from the others?

### Sub-scores

- `guiding_question_relevance`
- `summary_faithfulness`
- `evidence_coverage`
- `dissent_visibility`
- `perspective_distinctiveness`

This gives a real basis for selecting a primary perspective instead of choosing one by taste.

### Phase 6: Report-Level Coverage And Usability

Question:

> As an end artifact, is this report useful, grounded, and sufficiently complete?

This phase should judge the report bundle and rendered site as a product artifact.

### Signals

- whether guiding questions are actually answered
- whether major issue areas in the corpus are represented
- whether evidence links are sufficient
- whether small but important minority concerns survive
- whether the report is easy to inspect and criticize

### Suggested report-level sub-scores

- `question_answering_quality`
- `coverage_of_major_issues`
- `minority_concern_preservation`
- `evidence_traceability`
- `report_legibility`

### Phase 7: Cross-Run Robustness

A single report can look good and still be fragile.

Question:

> If we vary nearby settings, do the important structures survive?

Compare the current run against nearby runs that change:

- cluster count
- reducer
- synthesis mode
- prompt version
- model version

### Signals

- stability of major clusters
- stability of major themes
- stability of high-level conclusions
- sensitivity of minority concerns

### Sub-scores

- `cluster_stability`
- `theme_stability`
- `narrative_stability`
- `minority_stability`

This should not punish useful alternate perspectives. It should punish brittle results that vanish under minor nearby changes.

## Recommended Scorecard

Do not lead with one number internally. Lead with a scorecard.

Suggested top-level dimensions:

- `provenance_integrity`
- `cluster_membership_quality`
- `cluster_theme_support`
- `theme_merge_quality`
- `perspective_fidelity`
- `report_coverage`
- `report_legibility`
- `cross_run_robustness`

Each top-level dimension should be 0 to 100 and backed by inspectable raw judgments.

## Recommended Final Run Score

If we want one report-run score for sorting or comparison, use a weighted score built from the scorecard:

```text
report_run_score =
  0.10 * provenance_integrity +
  0.22 * cluster_membership_quality +
  0.18 * cluster_theme_support +
  0.08 * theme_merge_quality +
  0.17 * perspective_fidelity +
  0.15 * report_coverage +
  0.05 * report_legibility +
  0.05 * cross_run_robustness
```

This weighting keeps the center of gravity on whether the report is semantically grounded in the underlying opinions.

For early `v0`, it is reasonable to mark some dimensions as `not-scored-yet` and compute the score from only the available weighted dimensions.

## Sampling Strategy

We should not always ask a frontier model to reread the entire corpus.

Recommended approach:

- small clusters: review all opinions
- medium clusters: stratified sample plus automatic outlier review
- large clusters: sample by centroid proximity, edge cases, and suspected outliers

Suggested cluster sample slices:

- strongest members near centroid
- borderline members near decision boundary
- semantic outliers
- source comments from different parts of the cluster

This reduces cost while still finding failure modes.

## Judge Design

Use frontier models as critics, not as hidden replacement pipeline stages.

Recommended guardrails:

- require structured JSON outputs
- include the exact evidence packet used for judgment
- preserve judge prompt, model, and timestamp
- use at least two independent judge passes for high-value benchmark runs
- separate scoring prompts from generation prompts when practical

For important benchmark corpora, it is reasonable to run:

- one strict judge prompt focused on fidelity
- one broader judge prompt focused on usefulness and omissions

Disagreement between judges is itself a useful QA signal.

## Artifact Model

QA should produce durable artifacts under the run, not just terminal output.

Suggested layout:

```text
runs/<run-id>/
  qa/
    manifest.json
    scorecard.json
    provenance-check.json
    clusters/
      <cluster-id>-membership.json
      <cluster-id>-theme-support.json
    themes/
      <theme-id>-merge-review.json
    perspectives/
      <perspective-id>-review.json
    report/
      report-review.json
    cross-run/
      nearby-run-comparison.json
```

This fits the repo's bias toward inspectable local artifacts and durable model outputs.

## Recommended First Implementation Slice

The first useful slice should stay narrow.

Implement first:

1. provenance sanity checks
2. cluster membership QA
3. cluster theme-support QA
4. perspective summary fidelity QA
5. run-level scorecard output

This would already answer the most important question:

> does this report rest on clusters that are actually defensible?

## Concrete First Metrics

If we want a minimal first version, start with these:

- `cluster_membership_quality`
  mean opinion fit across reviewed opinions
- `cluster_theme_support`
  fraction of sampled source comments that clearly support the claimed cluster theme
- `perspective_fidelity`
  judge score for whether perspective summary is supported by highlighted clusters
- `report_coverage`
  judge score for whether the report addresses the guiding questions and covers major issue areas

That is enough to produce an early report QA score without pretending we have solved the full evaluation problem.

## Additional Ideas For Later Phases

- benchmark against official consultation findings where available
- compare two runs side by side and score what changed
- detect unsupported narrative claims at sentence level in summaries
- measure quote diversity so one loud source does not dominate a cluster
- score whether minority concerns are preserved rather than absorbed into majoritarian themes
- add human review checkpoints for benchmark corpora and store reviewer notes beside model judgments
- measure perspective redundancy so alternate perspectives are genuinely different
- add calibration bands such as `high confidence`, `mixed evidence`, and `needs review`

## Recommendation

Broadly should treat report QA as a multi-stage criticism pipeline attached to each run.

The most important early move is not a sophisticated single score. It is a durable scorecard that starts at the cluster level:

- do these opinions belong together?
- do the source comments support the claimed theme?
- do the summaries stay faithful to the evidence?

If those questions are answered well, a report-level score becomes much more meaningful.
