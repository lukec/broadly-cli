# Hybrid Taxonomy QA

## Purpose

This note compares the frontier-model hybrid taxonomy for `opengov2017`
against the latest vector report and the Government of Canada benchmark themes.

Hybrid taxonomy run reviewed:

- `projects/opengov2017/taxonomies/hybrid-taxonomy-opengov2017-v2/`
- model: `gpt-5.5`
- reasoning effort: `medium`
- source opinion run: `2026-04-21_19-11-23-636-gemini-flash-opinions-v2`

Vector report reviewed:

- `projects/opengov2017/reports/2026-04-21_19-18-25-390-cohere-embed/report-bundle.json`
- QA scorecard: `projects/opengov2017/runs/2026-04-21_19-18-25-390-cohere-embed/qa/2026-04-21_19-28-41-032/scorecard.json`

## Hybrid Taxonomy Structural QA

| Check | Result | Read |
|---|---:|---|
| Included opinions | 376 | Full reviewed corpus was covered. |
| Top-level categories | 5 | Fits the target range for a public report/navigation tier. |
| Subgroup themes | 22 | Enough detail for drill-down without forcing one flat theme list. |
| Assignments | 376 | Every selected opinion has an assignment. |
| Clear assignments | 241 | 64.1% clear. |
| Partial assignments | 78 | 20.7% partial. |
| Uncertain assignments | 4 | 1.1% uncertain. |
| Out-of-scope assignments | 53 | Preserved in artifacts but excluded from the primary taxonomy map by default. |

Top-level categories:

| Category | Count | Subgroups | Label |
|---|---:|---:|---|
| cat-02 | 76 | 5 | Open Data Infrastructure and Public Value |
| cat-03 | 74 | 4 | Public Engagement and Inclusive Participation |
| cat-01 | 71 | 5 | Transparency, Disclosure, and Rights |
| cat-04 | 61 | 4 | Institutional Capacity and Service Delivery |
| cat-05 | 38 | 4 | Democratic Governance and Boundary Issues |

Largest subgroup themes:

| Theme | Count | Label |
|---|---:|---|
| theme-001 | 29 | Beneficial ownership and anti-corruption registries |
| theme-006 | 28 | Data standards, stewardship, and interoperability |
| theme-012 | 27 | Accessible and representative participation |
| theme-016 | 26 | Public-service culture and implementation capacity |
| theme-007 | 23 | Findability, plain language, and practical access |

## Comparison Against Vector QA

The existing vector run has excellent structural QA but weak semantic QA:

| Vector QA category | Score |
|---|---:|
| run integrity | 100 |
| cluster integrity | 100 |
| view integrity | 100 |
| evidence integrity | 100 |
| soft consistency | 100 |
| cluster membership quality | 65 |
| cluster theme support | 50 |
| theme merge quality | 91 |
| total | 88 |

The key comparison is not total score. The vector total is mostly lifted by
artifact-integrity checks. The meaningful gap is semantic: `cluster membership`
and `cluster theme support` are only moderate.

The hybrid taxonomy directly addresses that weakness by giving every theme:

- inclusion rules
- exclusion rules
- representative opinion IDs
- assignment confidence
- assignment rationale
- explicit uncertainty

## Official Theme Recall

| Government benchmark theme | Hybrid recall | Notes |
|---|---|---|
| Open dialogue and public engagement | Strong | G08 covers participation methods, feedback loops, consultation legitimacy; G07 covers inclusion barriers. |
| Open data, standards, discoverability, digital service convergence | Strong | G03, G04, and G05 split standards, usefulness, and digital access more cleanly than vector themes. |
| Financial transparency and accountability | Partial | G12 exists and is specific, but budget-cycle, estimates, public accounts, and procurement are not separated. |
| Corporate transparency | Strong | G01 is specific, high-count, and closely aligned with beneficial ownership. |
| Access to Information | Strong | G02 isolates ATI law and enforceable disclosure rights from generic access or open-data issues. |
| Healthy democracy | Partial | G14 catches democratic accountability and electoral reform, but not the full official democratic-resilience frame. |
| Feminist and inclusive dialogue | Partial | G07 includes gender, GBA+, accessibility, language, Indigenous identity, and digital divide, but it is overloaded. |
| Reconciliation and open government | Weak/partial | G07 catches Indigenous inclusion, but OCAP/data governance and relationship-based engagement are not first-class. |
| Open science | Missing | No hybrid taxonomy theme clearly targets federal science publications, science professionals, or open-science progress. |
| Open government community | Weak/partial | Some content appears in G09, G11, and G13, but OGP/Open Data Charter/community capacity is not explicit. |

## What The Frontier Backend Does Better

The frontier taxonomy separates several concepts that the vector report tends to blur:

| Vector blur | Hybrid taxonomy separation |
|---|---|
| Generic access problems | G02 ATI rights, G05 findability/service access, G19 legal/procedural complexity |
| Open data as one broad issue | G03 standards/stewardship, G04 usefulness/communication, G06 literacy |
| Engagement as broad participation | G07 who is missing, G08 process legitimacy and feedback loops |
| Accountability as a catch-all | G01 ownership, G12 spending/procurement, G13 commitment tracking, G14 democratic power |
| Digital government as broad modernization | G05 service access, G10 privacy/data rights, G11 technical ecosystems |

This is the main result: the frontier-model taxonomy is not merely prettier
labeling. It preserves policy mechanisms and false friends that vector geometry
does not preserve reliably.

## Where The Frontier Backend Still Fails

G07 is overloaded. It is useful as an assignment bucket, but too broad for
benchmark reporting. It combines accessibility, language, youth, regional
outreach, Indigenous inclusion, gender analysis, migrant inclusion, trusted
intermediaries, and the digital divide. For benchmark reporting, feminist/GBA+
and reconciliation/Indigenous data governance need separate tags or subthemes.

G09 is also broad. Culture, leadership, silos, staffing, training, pilots,
partner mobilization, and intergovernmental coordination may not belong in one
public-facing theme.

G16 and G17 are useful routing buckets for off-core civic input, but they should
be explicitly marked as out-of-scope or adjacent policy input. Otherwise a
report can imply that pensions, healthcare, climate, immigration, firearms, or
affordability comments are open-government findings.

G18 has only three assignments. It may be an important minority signal, but it
should default to a minority-risk note unless more evidence appears.

G20 is an accounting bucket for low-specificity reactions, not a substantive
theme.

## What We Learn

The frontier-model run supports the hybrid direction.

Embeddings and vector clustering are useful for neighborhoods, duplicates,
outliers, and exploratory maps. They are not enough for benchmark-grade theme
construction. The vector report can be structurally valid while still merging
policy mechanisms that should stay distinct.

The frontier-model taxonomy is stronger because it works like an analyst:

- it defines the issue
- it states inclusion and exclusion rules
- it assigns every opinion against those rules
- it records uncertainty
- it preserves small but meaningful minority signals

The hybrid taxonomy should become the target for report generation. Vector maps
should become exploratory evidence surfaces, not the authoritative theme
hierarchy.

## Implementation Implications

The accepted implementation direction from this QA pass is:

1. Add a real `hybrid-taxonomy` strategy: embeddings for neighborhoods and
   outliers, frontier model for taxonomy design, cheaper model for bulk
   assignment, QA repair for weak themes.
2. Keep durable assignment artifacts with primary theme, optional secondary
   themes, confidence, rationale, evidence quote, and uncertainty flag.
3. Do not add official benchmark recall QA as a default product feature.
   Benchmark recall can stay in corpus-specific evaluation notes when useful.
4. Add false-friend QA using each theme's exclusion rules.
5. Do not add theme role labels in the next implementation pass.
6. Do not prioritize vector-cluster-versus-hybrid-assignment comparison in the
   next implementation pass.
7. Do not add a special small-theme promotion rule yet.
8. Split overloaded categories through subgroups rather than role tags. In this
   run, G07 should become a parent category with subgroups for feminist/GBA+,
   accessibility and language, digital divide, and Indigenous governance or
   reconciliation where supported by the evidence.

Two product decisions fall out of this:

- Off-topic comments should be preserved but excluded from primary analysis by
  default. The project questions define the relevance boundary. Review artifacts
  can mark comments or opinions as `excluded-off-topic`, and analysis/report
  config can opt back into those statuses for open-ended projects.
- Larger corpora need a two-tier taxonomy. The top tier should be roughly 3-6
  broad categories. Each category should have roughly 2-8 subgroup themes, with
  an unbalanced tree allowed. Scatterplot views should support drilling into a
  category and seeing the opinion space within that subgrouped area.

## Bottom Line

The hybrid taxonomy run is substantially better than the vector report for
semantic QA and benchmark comparison. It hears the corpus at the policy-mechanism
level, not just at the semantic-neighborhood level.

It still needs subgroup handling and false-friend QA before it can produce a
final public report. The next product step is not to replace embeddings with
Codex. It is to make embeddings feed a hybrid taxonomy-and-assignment
pipeline, then use assignment confidence and false-friend checks to repair the
result.
