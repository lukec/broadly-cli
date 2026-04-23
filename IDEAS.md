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

## MAPLE-Inspired Research Track

The MAPLE paper suggests a useful reframing:
the next improvement may not be "pick a better 2D reducer," but "learn or repair a better neighborhood graph before 2D layout."

Why this is interesting for Broadly:

- Public-comment embeddings likely contain noisy local neighborhoods
  Comments can be multi-issue, stance-mixed, or semantically adjacent while opposing each other.
  A better local-neighbor graph may matter more than swapping UMAP for PaCMAP.

- Minority and dissent pockets may depend on local graph quality
  If the neighborhood graph is wrong, small but meaningful pockets can get absorbed into broader thematic clouds.

- This fits Broadly's explanation-search framing
  A neighborhood graph can be treated as another candidate explanation of corpus structure, criticized and compared like any other perspective artifact.

- This also fits the semantic-opinion-basis direction
  Learned semantic signals could help repair neighborhood structure before layout rather than only after clustering.

Important constraint:

- MAPLE was not evaluated on public consultation text
  Treat it as a research direction to test against Broadly benchmark corpora, not as a method to adopt on faith.

Possible next steps:

- Cheap: add neighborhood-fidelity diagnostics
  Extend the reducer evaluation harness to measure:
  - nearest-neighbor preservation from embedding space into 2D
  - minority-cluster survival
  - support/opposition separation where labels exist
  - stability across seeds and nearby settings

- Cheap: compare clustering surfaces explicitly
  Measure the difference between clustering on:
  - original embedding vectors
  - learned or repaired neighborhood graphs later
  - 2D coordinates
  Broadly should avoid accidentally treating map layout as the authoritative semantic surface.

- Medium: add a pre-reduction graph-builder boundary
  Instead of reducer selection only, introduce an experimental step:
  embeddings -> neighborhood graph builder -> 2D reducer
  Early graph-builder variants could include:
  - plain kNN baseline
  - mutual-kNN filtering
  - shared-neighbor weighting
  - question-aware edge reweighting
  - stance-aware edge reweighting

- Medium: try semantic graph repair before layout
  Use existing or cheaply derived signals to reweight local neighborhoods:
  - stance polarity
  - support vs opposition
  - target institution
  - concern type
  - feasibility / implementation orientation
  This would be a Broadly-native approximation of the MAPLE idea before trying a full algorithm port.

- Medium: benchmark graph variants on canonical corpora
  Use the same opinion slice, embeddings, and prompts across variants.
  Judge results with both metrics and report-review outputs:
  - cluster coherence
  - dissent visibility
  - evidence legibility
  - human preference in side-by-side report review

- Medium: connect graph quality to report usefulness
  Do not stop at prettier maps.
  Track whether graph changes improve:
  - cluster labels
  - theme merges
  - alternate perspectives
  - reviewer confidence in the final report

- Expensive: port or reimplement a MAPLE-like method
  Only do this after the evaluation harness exists and simpler graph-repair variants show promise on consultation corpora.

Practical recommendation:

- First build the harness and graph-builder seam
- then test Broadly-specific graph repair ideas
- only then consider direct MAPLE implementation

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

## Quality Cost Ladder

When discussing future quality work, use this framing:

- cheap
  No new paid model calls.
  Reuse existing opinion artifacts, embeddings, and local analysis outputs.

- medium
  Some model calls, but only on a targeted subset such as flagged clusters or suspicious opinions.

- expensive
  Corpus-wide reruns, multiple frontier-model passes, or broad benchmark sweeps that burn materially more credits.

## Medium-Cost Quality Ideas

These ideas are promising, but should land after the cheap repair and filtering layers.

- LLM review only for flagged cluster members
  After cheap outlier detection, ask a model whether a suspicious opinion is:
  - `fit`
  - `borderline`
  - `outlier`
  and whether it belongs in one of a few candidate destination clusters.

- LLM-assisted topicality and substance screening
  Apply a model to opinions that look ambiguous and classify them into:
  - on-topic
  - adjacent
  - off-topic
  - non-substantive
  This should complement, not replace, visible analyst review.

- Re-embedding with alternate embedding models
  Keep opinion extraction fixed and compare how different embedding models affect cluster purity, stability, and theme quality.

- Split broad clusters after QA
  When a cluster repeatedly scores poorly or shows many borderline members, use a targeted repair pass to split it rather than only relabeling it.

- Budget routing driven by cheap metrics
  Use cheap signals such as stability, outlier rate, and cohesion to decide where limited LLM budget is worth spending.

- Human-in-the-loop adjudication tools
  Add analyst tools that let a human confirm or reject machine-proposed repairs while preserving durable provenance and auditability.

## Expensive Quality Ideas

These are worth preserving, but should wait until the cheaper search-and-repair loop is in place.

- Re-run opinion extraction with multiple models
  Compare cheaper and frontier extraction models on the same source corpus to see how much downstream analysis quality actually changes.

- Frontier-model review over all cluster members
  Instead of reviewing only flagged items, run a high-end model over every cluster member to judge fit and propose reassignments.

- Full candidate-analysis judging with a frontier model
  Generate many candidate analyses and then use a frontier model to compare them, rank them, and justify which ones deserve report treatment.

- Multi-model benchmark sweeps
  Compare several combinations of:
  - opinion extraction model
  - embedding model
  - reducer
  - clustering settings
  - merge strategy
  against benchmark corpora and official findings.

- Full-corpus QA passes
  Run exhaustive review over cluster membership, cluster labels, and theme merges rather than sampling.

## Additional Future Analysis Ideas

- Uncertain / unplaced bucket
  Instead of forcing every opinion into a cluster, allow some opinions to remain explicitly unplaced when the assignment is weak or disputed.
  This may improve cluster purity and legitimacy, especially for odd or mixed comments.

- Support-signal handling for non-substantive praise
  Not every short comment is useless.
  Some comments may be weak for clustering but still useful as a support or satisfaction signal.
  Broadly may eventually want to distinguish:
  - substantive policy opinions
  - endorsements
  - praise
  - logistics

- Multiple reducer seeds as a first-class signal
  Rather than treating seed changes as implementation noise, use them as evidence about whether a pattern is robust or brittle.

- Local clusterer variants beyond the current default
  Once the cheap scoring harness exists, compare alternate local clustering heuristics without paying for new model calls.
