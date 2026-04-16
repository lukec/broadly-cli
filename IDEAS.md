# IDEAS

This file captures implementation and research ideas that are promising but not on the immediate critical path.

## Smarter Dimensional Reduction

The current map pipeline reduces high-dimensional opinion embeddings into two dimensions and then clusters on that 2D layout.
That is useful for legibility, but it likely throws away structure that matters for broad listening.

Potential areas for innovation:

- Task-aware reduction
  Preserve dimensions that matter for public reasoning, not just generic semantic similarity.
  Candidate signals:
  - topic
  - support vs opposition
  - policy mechanism
  - stakeholder type
  - implementation vs principle concerns

- Multi-view reduction
  Instead of a single canonical 2D map, generate several purposeful maps:
  - broad thematic similarity
  - support/opposition separation
  - implementation vs principle concerns
  - municipal actionability / feasibility

- LLM-assisted structure before reduction
  Extract additional structured signals per opinion and combine them with embeddings before reducing.
  Candidate signals:
  - stance polarity
  - target institution
  - concern type
  - urgency
  - perceived harm
  - feasibility

- Guiding-question-aware reduction
  Bias the reduction process toward preserving distinctions that matter for the project’s guiding questions.
  Example:
  if the guiding question is about disagreement, preserve disagreement boundaries more strongly than broad topical similarity.

- Hierarchical / explorable maps
  Use a coarse 2D overview first, then generate local remaps inside dense clusters.
  This may preserve more structure than forcing the whole corpus into one map.

## First Research Track: Stance-Augmented Reduction

One concrete experiment:

- Baseline
  embeddings -> UMAP(2D) -> KMeans

- Experimental
  embeddings + one extra LLM-derived stance/conflict signal -> UMAP(2D) -> KMeans

Questions to answer:

- Does it better separate support and opposition?
- Does it improve dissent-oriented perspectives?
- Does it make the map more useful to a human reviewer?

This is directly motivated by a weakness called out in the Broad Listening book:
embedding-based maps often fail to separate support and opposition within the same topic.

## Reducer Evaluation Harness

Do not build this immediately, but it is a strong next research support tool.

Purpose:

- compare reducers on the same opinion slice and embedding set
- judge map usefulness without pretending exact coordinates are "correct"

Possible command:

- `broadly analysis --evaluate-reducers`

What it would do:

- take one fixed opinion slice and embedding model
- run multiple reducers with fixed seeds, e.g. `umap` and later `pacmap`
- optionally run each reducer several times with different seeds
- compute comparison metrics
- write one comparison bundle under `runs/<run-id>/reducer-eval/`
- expose a comparison view in the web UI

What it should measure:

- local-neighbor preservation
  Compare each opinion’s nearest neighbors in embedding space vs 2D space.

- cluster stability
  Re-run reduction + clustering and compare how much memberships change.

- map spread / collapse checks
  Detect degenerate outputs such as collapsed clouds, NaNs, or extreme outliers.

- human review hooks
  Show cluster labels, summaries, and representative opinions side by side.

The goal is not to prove a reducer is mathematically "correct."
The goal is to determine whether it is stable, legible, and useful for broad listening.

## Report UI Track

The report surface needs to make Broadly's unique perspective easier to understand and compare across runs.
This is especially important if reviewers need to evaluate multiple report versions side by side.

Immediate design and UX directions:

- Stronger report narrative structure
  Move beyond a raw artifact dump and present:
  - overview
  - primary perspective
  - alternate perspective
  - cluster atlas
  - evidence explorer

- Interactive scatterplot
  Make the map useful as a navigation device, not just an illustration.
  Candidate interactions:
  - hover cluster
  - click cluster
  - highlight representative opinions
  - filter by perspective
  - link map points back to the report narrative

- Better cluster label system
  Use persistent color and label treatment so clusters are recognizable across the whole report.
  Candidate elements:
  - cluster chips
  - color-coded cluster cards
  - lower-level vs higher-level labels
  - "why this cluster matters" framing

- Report comparison support
  Make it easier to compare multiple report versions.
  Candidate features:
  - compare two runs side by side
  - show what changed in clusters or perspectives
  - show prompt/model/reduction provenance clearly

Success criteria:

- a reviewer can explain the report's unique point of view in under two minutes
- two report versions are easy to compare without reading raw JSON
- cluster and evidence navigation feel obvious

## Analysis Track

The analysis layer should improve both the semantic quality of grouping and the quality of the map itself.

Immediate analysis directions:

- Semantic higher-level merging
  Merge smaller clusters into larger themes using semantic evidence, not just geometric proximity.
  Candidate signals:
  - cluster summaries
  - representative opinions
  - cluster label similarity
  - cluster embedding similarity
  - LLM judgments over candidate merges

- Preserve dissent pockets
  Analysis should not wash out small but meaningful dissent clusters just because they are numerically small.
  Broadly should explicitly prefer outputs where dissent remains inspectable.

- Reducer experimentation
  Continue with:
  - umap
  - pacmap later
  - stance-augmented or question-aware reducers later

- Scatterplot quality scoring
  Add explicit evaluation signals for whether the map is useful:
  - local-neighbor preservation
  - cluster stability
  - dissent separation
  - human usefulness scoring

- Alternative hierarchy strategies
  Compare:
  - centroid-based merging
  - Ward-style merging
  - semantic merge over summaries
  - semantic merge over representative opinions

Success criteria:

- lower-level clusters feel semantically coherent
- higher-level themes read clearly in reports
- small but important dissent pockets survive
- reducer choices can be compared with evidence rather than taste

## Near-Term Execution Order

Recommended next implementation slices:

1. Report cluster atlas with consistent labels and colors
2. Interactive scatterplot with selected-cluster state
3. Semantic higher-level cluster merge artifacts
4. Render merged themes in the report
5. Reducer scoring harness
6. Broader reducer experimentation

## First Concrete Analysis Research Slice

The highest-value near-term analysis improvement is semantic cluster merge.

Practical shape:

- keep lower-level clusters as explicit artifacts
- generate merge candidates for nearby or semantically similar clusters
- ask the analysis model whether clusters should be merged into a higher-level theme
- record rationale and provenance for each merge decision
- produce a higher-level theme layer without destroying lower-level cluster evidence

This keeps the analysis inspectable while moving beyond purely geometric merging.
