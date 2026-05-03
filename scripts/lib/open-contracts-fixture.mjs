import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const fixtureReportRunId = "demo-run";

export const defaultInitialQuestions = [
  {
    questionId: "works-in-government",
    questionText: "I work in the government.",
    responseKind: "yes-no-skip"
  }
];

export async function createOpenContractsFixtureProject(options) {
  const projectRoot = options.projectRoot;
  const projectName = options.projectName ?? "Open Contracts Fixture";
  const projectSlug = options.projectSlug ?? "open-contracts-fixture";
  const description =
    options.description ?? "Synthetic no-LLM fixture for statement, vote, attestation, and site contracts.";
  const goals = options.goals ?? ["Exercise the open artifact contracts without model calls."];
  const initialQuestions = options.initialQuestions ?? defaultInitialQuestions;

  await rm(projectRoot, { recursive: true, force: true });

  for (const directory of [
    "data/raw",
    "data/normalized",
    "data/opinions/fixture-opinions-run",
    "prompts",
    "runs/demo-run/reductions",
    "runs/demo-run/clusters",
    "runs/demo-run/hierarchies",
    "runs/demo-run/perspectives",
    "reports/demo-run"
  ]) {
    await mkdir(path.join(projectRoot, directory), { recursive: true });
  }

  await writeFile(
    path.join(projectRoot, "broadly.yaml"),
    `schemaVersion: 1
project:
  name: ${yamlString(projectName)}
  slug: ${yamlString(projectSlug)}
  description: ${yamlString(description)}
  goals:
${goals.map((goal) => `    - ${yamlString(goal)}`).join("\n")}
models:
  - name: local-text
    provider: openai
    modelId: fixture-text
    region: local
  - name: local-embedding
    provider: openai
    modelId: fixture-embedding
    region: local
dataset:
  path: ./data/raw/source.csv
  format: csv
review_model: local-text
qa_model: local-text
questions:
  - What should the city prioritize?
opinionExtractions:
  - name: fixture-opinions
    model: local-text
    prompt: prompts/opinion-extraction.md
analysisViews:
  - name: fixture-view
    title: Fixture View
    sourceExtraction: fixture-opinions
    embeddingModel: local-embedding
    analysisModel: local-text
    prompts:
      clusterLabeling: prompts/analysis-cluster-labeling.md
      semanticMerge: prompts/analysis-semantic-merge.md
      viewSummary: prompts/analysis-perspective-summary.md
    reduction:
      method: umap
      dimensions: 2
    clustering:
      count: 2
      mergeStrategy: semantic
    mode: balanced
report:
  reportDir: reports
  primaryView: fixture-view
voting:
${renderInitialQuestionsYaml(initialQuestions)}
`,
    "utf8"
  );

  await writeFile(path.join(projectRoot, "broadly.log"), "", "utf8");
  await writeFile(
    path.join(projectRoot, "data/raw/source.csv"),
    "id,comment\n1,Keep parks easy to reach.\n2,Tell us what changed without jargon.\n",
    "utf8"
  );
  await writeJson(projectRoot, "data/normalized/ingest-manifest.json", {
    createdAt: "2026-01-01T00:00:00.000Z",
    source: { sourceFileSha256: "fixture-source" },
    output: { recordsWritten: 2 }
  });
  await writeJson(projectRoot, "data/opinions/fixture-opinions-run/manifest.json", {
    createdAt: "2026-01-01T00:00:00.000Z",
    model: { name: "local-text", provider: "openai", region: "local", modelId: "fixture-text" },
    input: { recordsAttempted: 2 },
    output: { recordsWritten: 2, opinionsWritten: 2, failedRecords: 0 }
  });

  for (const prompt of [
    "opinion-extraction.md",
    "analysis-cluster-labeling.md",
    "analysis-semantic-merge.md",
    "analysis-perspective-summary.md"
  ]) {
    await writeFile(path.join(projectRoot, "prompts", prompt), `Fixture prompt: ${prompt}\n`, "utf8");
  }

  await writeJson(projectRoot, "runs/demo-run/manifest.json", {
    runId: fixtureReportRunId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    input: {
      opinionRunId: "fixture-opinions-run",
      opinionsSelected: 2,
      prompts: {
        clusterLabeling: { path: "prompts/analysis-cluster-labeling.md" },
        semanticMerge: { path: "prompts/analysis-semantic-merge.md" },
        perspectiveSummary: { path: "prompts/analysis-perspective-summary.md" }
      }
    },
    output: {
      reductionsReady: 1,
      clusterArtifactsWritten: 1,
      perspectiveArtifactsWritten: 1
    }
  });
  await writeJson(projectRoot, "runs/demo-run/reductions/fixture.json", { status: "ready", points: [] });
  await writeJson(projectRoot, "runs/demo-run/clusters/fixture.json", { status: "ready", clusters: [] });
  await writeJson(projectRoot, "runs/demo-run/hierarchies/fixture.json", { status: "ready", themes: [] });
  await writeJson(projectRoot, "runs/demo-run/perspectives/fixture.json", {
    status: "ready",
    viewName: "fixture-view"
  });
  await writeJson(projectRoot, "reports/demo-run/report-bundle.json", {
    reportId: fixtureReportRunId,
    createdAt: "2026-01-01T00:00:00.000Z",
    analysisRunId: fixtureReportRunId,
    projectName,
    questions: ["What should the city prioritize?"],
    primaryViewId: "fixture-view",
    views: [
      {
        viewId: "fixture-view",
        title: "Fixture View",
        summary: "Residents want everyday public spaces to be easy to use and easy to understand.",
        themes: [
          {
            themeId: "theme-1",
            label: "Accessible public spaces",
            summary: "Residents want parks, libraries, and gathering places to stay easy to reach.",
            clusterIds: ["cluster-1"]
          }
        ],
        clusters: [
          {
            clusterId: "cluster-1",
            label: "Nearby public amenities",
            summary: "Residents want essential public amenities to remain close to daily routines.",
            evidenceQuotes: [
              {
                quoteId: "quote-1",
                sourceId: "opinion-1",
                excerpt: "Keep parks easy to reach."
              }
            ]
          },
          {
            clusterId: "cluster-2",
            label: "Plain-language updates",
            summary: "Residents want project updates to be written in plain language.",
            evidenceQuotes: [
              {
                quoteId: "quote-2",
                sourceId: "opinion-2",
                excerpt: "Tell us what changed without jargon."
              }
            ]
          }
        ]
      }
    ]
  });
}

async function writeJson(projectRoot, relativePath, value) {
  await writeFile(path.join(projectRoot, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function renderInitialQuestionsYaml(initialQuestions) {
  if (initialQuestions.length === 0) {
    return "  initialQuestions: []";
  }

  return [
    "  initialQuestions:",
    ...initialQuestions.flatMap((question) => [
      `    - questionId: ${yamlString(question.questionId)}`,
      `      questionText: ${yamlString(question.questionText)}`,
      `      responseKind: ${yamlString(question.responseKind ?? "yes-no-skip")}`
    ])
  ].join("\n");
}

function yamlString(value) {
  return JSON.stringify(value);
}
