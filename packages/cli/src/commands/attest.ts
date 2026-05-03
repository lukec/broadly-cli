import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig, type BroadlyProjectConfig } from "@broadly/config";
import {
  resolveAttestationPaths,
  resolveProjectPaths,
  resolveStatementRunPaths,
  type ProjectPaths
} from "@broadly/core";
import type {
  AttestationArtifactRecord,
  AttestationManifest,
  ReportBundle,
  StatementBank
} from "@broadly/report-model";

import {
  artifactExists,
  createTimestampRunId,
  hashFile,
  listJsonArtifactPaths,
  readCurrentRunId,
  readJsonArtifact,
  toProjectRelativePath,
  writeJsonArtifact
} from "../projectArtifacts.js";
import { withProjectActionLog } from "../projectLog.js";
import { resolveCommandProjectRoot } from "./projectDashboard.js";
import { findLatestStatementRunId } from "./statements.js";

export interface AttestCommandOptions {
  project?: string;
  run?: string;
}

export interface VerifyCommandOptions {
  project?: string;
  manifest?: string;
}

interface AnalysisManifestForAttestation {
  input?: {
    opinionRunId?: string;
    groups?: Array<{ opinionRunId?: string }>;
    prompts?: Record<string, { path?: string; sha256?: string } | undefined>;
  };
}

export async function attestReport(options: AttestCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "attest report",
    details: {
      run: options.run ?? "(latest)"
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = parseProjectConfig(await readFile(projectPaths.configPath, "utf8"));
      const reportRunId = options.run ?? (await findLatestReportRunId(projectPaths.reportsDir));

      if (reportRunId === null) {
        throw new Error("No report bundle was found. Run broadly report first.");
      }

      const reportBundlePath = path.join(projectPaths.reportsDir, reportRunId, "report-bundle.json");
      const reportBundle = await readJsonArtifact<ReportBundle>(reportBundlePath);

      if (reportBundle === null) {
        throw new Error(`Report bundle '${reportBundlePath}' could not be read.`);
      }

      const manifest = await buildReportAttestation(projectRoot, projectPaths, config, reportBundlePath, reportBundle);
      const outputPath = path.join(
        resolveAttestationPaths(projectRoot).reportsDir,
        `${reportRunId}.attestation.json`
      );

      await writeJsonArtifact(outputPath, manifest);

      process.stdout.write(
        [
          `Wrote report attestation for ${projectRoot}`,
          "",
          `Report: ${reportRunId}`,
          `Artifacts: ${manifest.artifacts.length}`,
          `Manifest: ${toProjectRelativePath(projectRoot, outputPath)}`
        ].join("\n") + "\n"
      );
    }
  });
}

export async function attestStatements(options: AttestCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "attest statements",
    details: {
      run: options.run ?? "(current)"
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = parseProjectConfig(await readFile(projectPaths.configPath, "utf8"));
      const statementRunId =
        options.run ??
        (await readCurrentRunId(projectPaths.statementsCurrentRunPath)) ??
        (await findLatestStatementRunId(projectPaths.statementsDir));

      if (statementRunId === null) {
        throw new Error("No statement bank was found. Run broadly statements generate --from-report first.");
      }

      const statementRunPaths = resolveStatementRunPaths(projectRoot, statementRunId);
      const statementBank = await readJsonArtifact<StatementBank>(statementRunPaths.statementBankPath);

      if (statementBank === null) {
        throw new Error(`Statement bank '${statementRunId}' could not be read.`);
      }

      const manifest = await buildStatementAttestation(
        projectRoot,
        projectPaths,
        config,
        statementRunPaths.statementBankPath,
        statementBank
      );
      const outputPath = path.join(
        resolveAttestationPaths(projectRoot).statementsDir,
        `${statementRunId}.attestation.json`
      );

      await writeJsonArtifact(outputPath, manifest);

      process.stdout.write(
        [
          `Wrote statement attestation for ${projectRoot}`,
          "",
          `Statement run: ${statementRunId}`,
          `Artifacts: ${manifest.artifacts.length}`,
          `Manifest: ${toProjectRelativePath(projectRoot, outputPath)}`
        ].join("\n") + "\n"
      );
    }
  });
}

export async function verifyArtifacts(options: VerifyCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "verify",
    details: {
      manifest: options.manifest ?? "(all attestations)"
    },
    action: async () => {
      const manifestPaths =
        options.manifest === undefined
          ? await listAttestationManifestPaths(resolveAttestationPaths(projectRoot).rootDir)
          : [await resolveInputPath(projectRoot, options.manifest)];

      if (manifestPaths.length === 0) {
        throw new Error("No attestation manifests were found. Run broadly attest report or broadly attest statements first.");
      }

      const results = [];

      for (const manifestPath of manifestPaths) {
        const manifest = await readJsonArtifact<AttestationManifest>(manifestPath);

        if (manifest === null) {
          results.push({
            manifestPath,
            checked: 0,
            failures: [`Manifest could not be parsed: ${manifestPath}`]
          });
          continue;
        }

        results.push(await verifyAttestationManifest(projectRoot, manifestPath, manifest));
      }

      const failureCount = results.reduce((total, result) => total + result.failures.length, 0);
      const checkedCount = results.reduce((total, result) => total + result.checked, 0);
      const lines = [
        `Verified attestation artifacts for ${projectRoot}`,
        "",
        `Manifests: ${results.length}`,
        `Artifacts checked: ${checkedCount}`,
        `Failures: ${failureCount}`,
        ...results.flatMap((result) =>
          result.failures.length === 0
            ? [`OK ${toProjectRelativePath(projectRoot, result.manifestPath)}`]
            : [
                `FAIL ${toProjectRelativePath(projectRoot, result.manifestPath)}`,
                ...result.failures.map((failure) => `  ${failure}`)
              ]
        )
      ];

      process.stdout.write(`${lines.join("\n")}\n`);

      if (failureCount > 0) {
        throw new Error("Verification failed.");
      }
    }
  });
}

async function buildReportAttestation(
  projectRoot: string,
  projectPaths: ProjectPaths,
  config: BroadlyProjectConfig,
  reportBundlePath: string,
  reportBundle: ReportBundle
): Promise<AttestationManifest> {
  const analysisManifestPath = path.join(projectPaths.runsDir, reportBundle.analysisRunId, "manifest.json");
  const analysisManifest = await readJsonArtifact<AnalysisManifestForAttestation>(analysisManifestPath);
  const artifactRecords: AttestationArtifactRecord[] = [];

  await addArtifactRecord(projectRoot, artifactRecords, "report-bundle", reportBundlePath, true);
  await addArtifactRecord(projectRoot, artifactRecords, "analysis-manifest", analysisManifestPath, true);
  await addSourceAndIngestRecords(projectRoot, projectPaths, config, artifactRecords);
  await addOpinionManifestRecords(projectRoot, projectPaths, analysisManifest, artifactRecords);
  await addPromptRecords(projectRoot, analysisManifest, artifactRecords);
  await addGeneratedAnalysisRecords(projectRoot, projectPaths, reportBundle.analysisRunId, artifactRecords);

  return {
    attestationId: createTimestampRunId("attest-report", reportBundle.reportId),
    createdAt: new Date().toISOString(),
    subject: {
      kind: "report",
      reportId: reportBundle.reportId,
      analysisRunId: reportBundle.analysisRunId
    },
    codeVersion: await readPackageVersion(),
    publicationTimestamp: new Date().toISOString(),
    modelRefs: config.models.map((model) => ({
      alias: model.name,
      provider: model.provider,
      modelId: model.modelId,
      region: model.region
    })),
    artifacts: dedupeArtifactRecords(artifactRecords)
  };
}

async function buildStatementAttestation(
  projectRoot: string,
  projectPaths: ProjectPaths,
  config: BroadlyProjectConfig,
  statementBankPath: string,
  statementBank: StatementBank
): Promise<AttestationManifest> {
  const analysisManifestPath = path.join(projectPaths.runsDir, statementBank.analysisRunId, "manifest.json");
  const analysisManifest = await readJsonArtifact<AnalysisManifestForAttestation>(analysisManifestPath);
  const artifactRecords: AttestationArtifactRecord[] = [];
  const statementRunPaths = resolveStatementRunPaths(projectRoot, statementBank.statementRunId);

  await addArtifactRecord(projectRoot, artifactRecords, "statement-bank", statementBankPath, true);
  await addArtifactRecord(projectRoot, artifactRecords, "analysis-manifest", analysisManifestPath, true);
  await addSourceAndIngestRecords(projectRoot, projectPaths, config, artifactRecords);
  await addOpinionManifestRecords(projectRoot, projectPaths, analysisManifest, artifactRecords);
  await addPromptRecords(projectRoot, analysisManifest, artifactRecords);

  if (statementBank.sourceReportPath.length > 0) {
    await addArtifactRecord(projectRoot, artifactRecords, "report-bundle", statementBank.sourceReportPath, true);
  }

  for (const statementPath of await listJsonArtifactPaths(statementRunPaths.statementsDir)) {
    await addArtifactRecord(projectRoot, artifactRecords, "generated-artifact", statementPath, true);
  }

  return {
    attestationId: createTimestampRunId("attest-statements", statementBank.statementRunId),
    createdAt: new Date().toISOString(),
    subject: {
      kind: "statements",
      statementRunId: statementBank.statementRunId,
      analysisRunId: statementBank.analysisRunId
    },
    codeVersion: await readPackageVersion(),
    publicationTimestamp: new Date().toISOString(),
    modelRefs: config.models.map((model) => ({
      alias: model.name,
      provider: model.provider,
      modelId: model.modelId,
      region: model.region
    })),
    artifacts: dedupeArtifactRecords(artifactRecords)
  };
}

async function addSourceAndIngestRecords(
  projectRoot: string,
  projectPaths: ProjectPaths,
  config: BroadlyProjectConfig,
  artifactRecords: AttestationArtifactRecord[]
): Promise<void> {
  const datasetPath = resolveProjectPath(projectRoot, config.dataset.path);
  await addArtifactRecord(projectRoot, artifactRecords, "source-dataset", datasetPath, false);
  await addArtifactRecord(
    projectRoot,
    artifactRecords,
    "ingest-manifest",
    path.join(projectPaths.dataDir, "normalized", "ingest-manifest.json"),
    false
  );
}

async function addOpinionManifestRecords(
  projectRoot: string,
  projectPaths: ProjectPaths,
  analysisManifest: AnalysisManifestForAttestation | null,
  artifactRecords: AttestationArtifactRecord[]
): Promise<void> {
  for (const opinionRunId of collectOpinionRunIds(analysisManifest)) {
    await addArtifactRecord(
      projectRoot,
      artifactRecords,
      "opinion-manifest",
      path.join(projectPaths.dataDir, "opinions", opinionRunId, "manifest.json"),
      true
    );
  }
}

async function addPromptRecords(
  projectRoot: string,
  analysisManifest: AnalysisManifestForAttestation | null,
  artifactRecords: AttestationArtifactRecord[]
): Promise<void> {
  const promptPaths = Object.values(analysisManifest?.input?.prompts ?? {})
    .map((prompt) => prompt?.path)
    .filter((promptPath): promptPath is string => promptPath !== undefined);

  for (const promptPath of promptPaths) {
    await addArtifactRecord(projectRoot, artifactRecords, "prompt", promptPath, false);
  }
}

async function addGeneratedAnalysisRecords(
  projectRoot: string,
  projectPaths: ProjectPaths,
  analysisRunId: string,
  artifactRecords: AttestationArtifactRecord[]
): Promise<void> {
  const runDir = path.join(projectPaths.runsDir, analysisRunId);
  const generatedDirs = ["reductions", "clusters", "hierarchies", "perspectives"];

  for (const generatedDir of generatedDirs) {
    for (const artifactPath of await listJsonArtifactPaths(path.join(runDir, generatedDir))) {
      await addArtifactRecord(projectRoot, artifactRecords, "generated-artifact", artifactPath, true);
    }
  }
}

async function addArtifactRecord(
  projectRoot: string,
  artifactRecords: AttestationArtifactRecord[],
  artifactKind: AttestationArtifactRecord["artifactKind"],
  artifactPath: string,
  required: boolean
): Promise<void> {
  const resolvedPath = path.isAbsolute(artifactPath)
    ? artifactPath
    : resolveProjectPath(projectRoot, artifactPath);

  if ((await artifactExists(resolvedPath)) === false) {
    if (required) {
      artifactRecords.push({
        artifactId: `${artifactKind}:${shaPath(projectRoot, resolvedPath)}`,
        artifactKind,
        path: toProjectRelativePath(projectRoot, resolvedPath),
        sha256: "",
        required
      });
    }
    return;
  }

  artifactRecords.push({
    artifactId: `${artifactKind}:${shaPath(projectRoot, resolvedPath)}`,
    artifactKind,
    path: toProjectRelativePath(projectRoot, resolvedPath),
    sha256: await hashFile(resolvedPath),
    required
  });
}

async function verifyAttestationManifest(
  projectRoot: string,
  manifestPath: string,
  manifest: AttestationManifest
): Promise<{
  manifestPath: string;
  checked: number;
  failures: string[];
}> {
  const failures: string[] = [];
  let checked = 0;

  for (const artifact of manifest.artifacts) {
    const artifactPath = resolveProjectPath(projectRoot, artifact.path);

    if ((await artifactExists(artifactPath)) === false) {
      if (artifact.required) {
        failures.push(`Missing required artifact: ${artifact.path}`);
      }
      continue;
    }

    checked += 1;
    const currentSha256 = await hashFile(artifactPath);

    if (currentSha256 !== artifact.sha256) {
      failures.push(`Hash mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${currentSha256}`);
    }
  }

  return {
    manifestPath,
    checked,
    failures
  };
}

function collectOpinionRunIds(analysisManifest: AnalysisManifestForAttestation | null): string[] {
  const ids = new Set<string>();

  if (analysisManifest?.input?.opinionRunId !== undefined) {
    ids.add(analysisManifest.input.opinionRunId);
  }

  for (const group of analysisManifest?.input?.groups ?? []) {
    if (group.opinionRunId !== undefined) {
      ids.add(group.opinionRunId);
    }
  }

  return [...ids];
}

function dedupeArtifactRecords(records: AttestationArtifactRecord[]): AttestationArtifactRecord[] {
  const byPath = new Map<string, AttestationArtifactRecord>();

  for (const record of records) {
    byPath.set(record.path, record);
  }

  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function listAttestationManifestPaths(attestationsDir: string): Promise<string[]> {
  const entries = await readdir(attestationsDir, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    paths.push(...(await listJsonArtifactPaths(path.join(attestationsDir, entry.name))));
  }

  return paths.filter((manifestPath) => manifestPath.endsWith(".attestation.json")).sort();
}

async function findLatestReportRunId(reportsDir: string): Promise<string | null> {
  const entries = await readdir(reportsDir, { withFileTypes: true }).catch(() => []);
  const runs: Array<{ runId: string; createdAt: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const reportBundle = await readJsonArtifact<ReportBundle>(
      path.join(reportsDir, entry.name, "report-bundle.json")
    );

    if (reportBundle?.createdAt !== undefined) {
      runs.push({
        runId: entry.name,
        createdAt: reportBundle.createdAt
      });
    }
  }

  runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return runs[0]?.runId ?? null;
}

async function resolveInputPath(projectRoot: string, inputPath: string): Promise<string> {
  const projectRelativePath = resolveProjectPath(projectRoot, inputPath);

  if (await artifactExists(projectRelativePath)) {
    return projectRelativePath;
  }

  const cwdRelativePath = path.resolve(inputPath);

  if (await artifactExists(cwdRelativePath)) {
    return cwdRelativePath;
  }

  return projectRelativePath;
}

function resolveProjectPath(projectRoot: string, artifactPath: string): string {
  if (path.isAbsolute(artifactPath)) {
    return artifactPath;
  }

  const normalized = artifactPath.startsWith("./") ? artifactPath.slice(2) : artifactPath;
  return path.resolve(projectRoot, normalized);
}

function shaPath(projectRoot: string, artifactPath: string): string {
  return toProjectRelativePath(projectRoot, artifactPath).replace(/[^a-zA-Z0-9.-]+/g, "-");
}

async function readPackageVersion(): Promise<string> {
  const packageJson = await readJsonArtifact<{ version?: string }>(path.resolve("package.json"));
  return packageJson?.version ?? "0.1.0";
}
