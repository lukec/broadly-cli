import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenContractsFixtureProject } from "./lib/open-contracts-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.join(repoRoot, "projects", "open-contracts-fixture");
const cliPath = path.join(repoRoot, "packages", "cli", "dist", "index.js");

await run("npm", ["run", "build"], repoRoot);
await createOpenContractsFixtureProject({ projectRoot });

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
