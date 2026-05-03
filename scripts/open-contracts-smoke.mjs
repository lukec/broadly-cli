import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.join(repoRoot, "projects", "open-contracts-fixture");
const cliPath = path.join(repoRoot, "packages", "cli", "dist", "index.js");

await run("npm", ["run", "build"], repoRoot);
await createFixtureProject();

await run(process.execPath, [
  cliPath,
  "statements",
  "generate",
  "--project",
  projectRoot,
  "--from-report",
  "--run",
  "demo-run"
]);

const statementRunId = (await readFile(path.join(projectRoot, "statements", "current-run.txt"), "utf8")).trim();
const statementBank = JSON.parse(
  await readFile(path.join(projectRoot, "statements", statementRunId, "statement-bank.json"), "utf8")
);
const acceptArgs = statementBank.statements.flatMap((statement) => ["--accept", statement.statementId]);

await run(process.execPath, [
  cliPath,
  "statements",
  "review",
  "--project",
  projectRoot,
  ...acceptArgs,
  "--export-accepted"
]);
await run(process.execPath, [cliPath, "statements", "qa", "--project", projectRoot]);
await run(process.execPath, [
  cliPath,
  "vote",
  "init",
  "--project",
  projectRoot,
  "--statements",
  path.join("statements", statementRunId, "statement-bank.json")
]);
await run(process.execPath, [cliPath, "vote", "seed", "--project", projectRoot, "--participants", "6"]);
await run(process.execPath, [cliPath, "vote", "analyze", "--project", projectRoot]);
await run(process.execPath, [cliPath, "vote", "export", "--project", projectRoot]);
await run(process.execPath, [cliPath, "vote", "report", "--project", projectRoot]);
await run(process.execPath, [cliPath, "attest", "report", "--project", projectRoot, "--run", "demo-run"]);
await run(process.execPath, [
  cliPath,
  "attest",
  "statements",
  "--project",
  projectRoot,
  "--run",
  statementRunId
]);
await run(process.execPath, [cliPath, "verify", "--project", projectRoot]);
await run(process.execPath, [cliPath, "report", "site", "--project", projectRoot, "--run", "demo-run"]);

console.log(`\nFixture complete: ${path.join(projectRoot, "reports", "demo-run", "site", "index.html")}`);

async function createFixtureProject() {
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
  name: Open Contracts Fixture
  slug: open-contracts-fixture
  description: Synthetic no-LLM fixture for statement, vote, attestation, and site contracts.
  goals:
    - Exercise the open artifact contracts without model calls.
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
`,
    "utf8"
  );

  await writeFile(path.join(projectRoot, "broadly.log"), "", "utf8");
  await writeFile(path.join(projectRoot, "data/raw/source.csv"), "id,comment\n1,Keep parks easy to reach.\n", "utf8");
  await writeJson("data/normalized/ingest-manifest.json", {
    createdAt: "2026-01-01T00:00:00.000Z",
    source: { sourceFileSha256: "fixture-source" },
    output: { recordsWritten: 2 }
  });
  await writeJson("data/opinions/fixture-opinions-run/manifest.json", {
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

  await writeJson("runs/demo-run/manifest.json", {
    runId: "demo-run",
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
  await writeJson("runs/demo-run/reductions/fixture.json", { status: "ready", points: [] });
  await writeJson("runs/demo-run/clusters/fixture.json", { status: "ready", clusters: [] });
  await writeJson("runs/demo-run/hierarchies/fixture.json", { status: "ready", themes: [] });
  await writeJson("runs/demo-run/perspectives/fixture.json", { status: "ready", viewName: "fixture-view" });
  await writeJson("reports/demo-run/report-bundle.json", {
    reportId: "demo-run",
    createdAt: "2026-01-01T00:00:00.000Z",
    analysisRunId: "demo-run",
    projectName: "Open Contracts Fixture",
    questions: ["What should the city prioritize?"],
    primaryViewId: "fixture-view",
    views: [
      {
        viewId: "fixture-view",
        title: "Fixture View",
        summary: "Residents want everyday public spaces to be easy to use.",
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

async function writeJson(relativePath, value) {
  await writeFile(path.join(projectRoot, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function run(command, args, cwd = repoRoot) {
  await new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, stdio: "inherit" }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });

    child.on("error", reject);
  });
}
