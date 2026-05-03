import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createOpenContractsFixtureProject,
  fixtureReportRunId
} from "./lib/open-contracts-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.join(repoRoot, "projects", "open-contracts-demo");
const cliPath = path.join(repoRoot, "packages", "cli", "dist", "index.js");
const projectArg = path.relative(repoRoot, projectRoot);
const cliArg = path.relative(repoRoot, cliPath);

console.log("Broadly NEXT demo");
console.log("=================");
console.log("");
console.log("This creates an ignored no-LLM project and runs the open-contract workflow end to end.");
console.log(`Project: ${projectArg}`);

await runStep("Build the CLI workspace", "npm", ["run", "build"], { cwd: repoRoot });

printSection("Create the synthetic no-LLM project");
console.log(`Resetting ${projectArg}`);
await createOpenContractsFixtureProject({
  projectRoot,
  projectName: "Open Contracts Demo",
  projectSlug: "open-contracts-demo",
  description: "Synthetic no-LLM demo for the NEXT.md open contract workflow.",
  goals: [
    "Exercise statement generation, review, voting, attestation, and static report output.",
    "Show ordered initial voting questions before statement voting."
  ],
  initialQuestions: [
    {
      questionId: "works-in-government",
      questionText: "I work in the government.",
      responseKind: "yes-no-skip"
    },
    {
      questionId: "submitted-public-feedback-before",
      questionText: "I have submitted feedback to a public consultation before.",
      responseKind: "yes-no-skip"
    }
  ]
});

await runCliStep("Generate a statement bank from the report bundle", [
  "statements",
  "generate",
  "--project",
  projectRoot,
  "--from-report",
  "--run",
  fixtureReportRunId
]);

const statementRunId = (await readFile(path.join(projectRoot, "statements", "current-run.txt"), "utf8")).trim();
const statementBankPath = path.join(projectRoot, "statements", statementRunId, "statement-bank.json");
const statementBank = JSON.parse(await readFile(statementBankPath, "utf8"));
const reviewableStatements = statementBank.statements.filter(
  (statement) => statement.duplicateOfStatementId === undefined
);

if (reviewableStatements.length === 0) {
  throw new Error("The demo statement bank did not contain any non-duplicate statements to review.");
}

await runCliStep("Accept generated statements and export the public accepted bank", [
  "statements",
  "review",
  "--project",
  projectRoot,
  ...reviewableStatements.flatMap((statement) => ["--accept", statement.statementId]),
  "--export-accepted"
]);

await runCliStep("Run statement QA", ["statements", "qa", "--project", projectRoot]);
await runCliStep("Initialize the local voting round", [
  "vote",
  "init",
  "--project",
  projectRoot,
  "--statements",
  path.join("statements", statementRunId, "statement-bank.json")
]);
await runCliStep("Seed deterministic initial-question answers and statement votes", [
  "vote",
  "seed",
  "--project",
  projectRoot,
  "--participants",
  "9"
]);
await runCliStep("Analyze the vote round", ["vote", "analyze", "--project", projectRoot]);
await runCliStep("Export vote CSV/JSON artifacts", ["vote", "export", "--project", projectRoot]);
await runCliStep("Attach vote results back to the report artifacts", [
  "vote",
  "report",
  "--project",
  projectRoot
]);
await runCliStep("Attest the report artifacts", [
  "attest",
  "report",
  "--project",
  projectRoot,
  "--run",
  fixtureReportRunId
]);
await runCliStep("Attest the statement artifacts", [
  "attest",
  "statements",
  "--project",
  projectRoot,
  "--run",
  statementRunId
]);
await runCliStep("Verify local attestation manifests", ["verify", "--project", projectRoot]);
await runCliStep("Build the static report site", [
  "report",
  "site",
  "--project",
  projectRoot,
  "--run",
  fixtureReportRunId
]);

const voteRoundId = (await readFile(path.join(projectRoot, "votes", "current-round.txt"), "utf8")).trim();
const qaRunId = (
  await readFile(path.join(projectRoot, "statements", statementRunId, "qa", "current-run.txt"), "utf8")
).trim();

printSection("Demo artifacts");
for (const [label, artifactPath] of [
  ["Project config", path.join(projectRoot, "broadly.yaml")],
  ["Report bundle", path.join(projectRoot, "reports", fixtureReportRunId, "report-bundle.json")],
  ["Statement bank", statementBankPath],
  [
    "Accepted statements",
    path.join(projectRoot, "statements", statementRunId, "accepted-statements.json")
  ],
  [
    "Statement QA scorecard",
    path.join(projectRoot, "statements", statementRunId, "qa", qaRunId, "scorecard.json")
  ],
  ["Vote round manifest", path.join(projectRoot, "votes", voteRoundId, "manifest.json")],
  ["Reaction events", path.join(projectRoot, "votes", voteRoundId, "reaction-events.jsonl")],
  ["Vote summary", path.join(projectRoot, "votes", voteRoundId, "summary.json")],
  [
    "Initial question CSV",
    path.join(projectRoot, "votes", voteRoundId, "exports", "initial-question-results.csv")
  ],
  [
    "Statement results CSV",
    path.join(projectRoot, "votes", voteRoundId, "exports", "statement-results.csv")
  ],
  ["Report vote summary", path.join(projectRoot, "reports", fixtureReportRunId, "vote-summary.json")],
  [
    "Report attestation",
    path.join(projectRoot, "attestations", "reports", `${fixtureReportRunId}.attestation.json`)
  ],
  [
    "Statement attestation",
    path.join(projectRoot, "attestations", "statements", `${statementRunId}.attestation.json`)
  ],
  ["Static site", path.join(projectRoot, "reports", fixtureReportRunId, "site", "index.html")]
]) {
  console.log(`- ${label}: ${path.relative(repoRoot, artifactPath)}`);
}

printSection("Optional browser checks");
console.log(`Voting UI: node ${cliArg} vote web --project ${projectArg} --port 4320`);
console.log("Open http://127.0.0.1:4320 and confirm the initial questions appear before statements.");
console.log(`Project UI: node ${cliArg} web --project ${projectArg} --port 4310`);
console.log("Open http://127.0.0.1:4310 and check the Statements and report voting summary views.");
console.log(`Static site: open ${path.join(projectRoot, "reports", fixtureReportRunId, "site", "index.html")}`);

function printSection(title) {
  console.log("");
  console.log(`## ${title}`);
}

async function runCliStep(title, args) {
  await runStep(title, process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    displayCommand: `node ${formatArg(cliPath)} ${args.map(formatArg).join(" ")}`
  });
}

async function runStep(title, command, args, options = {}) {
  printSection(title);
  console.log(`$ ${options.displayCommand ?? [command, ...args].map(formatArg).join(" ")}`);

  await new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: options.cwd ?? repoRoot, stdio: "inherit" }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });

    child.on("error", reject);
  });
}

function formatArg(value) {
  const normalized = String(value);
  const displayValue =
    normalized === cliPath
      ? cliArg
      : normalized === projectRoot
        ? projectArg
        : normalized.startsWith(`${repoRoot}${path.sep}`)
          ? path.relative(repoRoot, normalized)
          : normalized;

  return /[\s"'$]/.test(displayValue) ? JSON.stringify(displayValue) : displayValue;
}
