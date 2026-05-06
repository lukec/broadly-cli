import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { type BroadlyProjectConfig } from "@broadly/config";
import { resolveProjectPaths } from "@broadly/core";
import { readCurrentRunId } from "../projectArtifacts.js";

export type PipelineStep = "ingest" | "opinions" | "analysis" | "report";
export type StepStatus = "ready" | "active" | "pending";

export interface OpinionRunSummary {
  runId: string;
  manifestPath: string;
  createdAt: string;
  modelLabel: string;
  recordsAttempted: number;
  recordsWritten: number;
  opinionsWritten: number;
  failedRecords: number;
}

export interface IngestSummary {
  manifestPath: string | null;
  rawFileCount: number;
  normalizedRecordCount: number;
  sourcePath: string;
  format: string;
  encoding: string | null;
  delimiter: string | null;
  idColumn: string | null;
  latestImport: {
    createdAt: string;
    recordsWritten: number;
    sourceFileSha256: string;
  } | null;
}

export interface AnalysisRunSummary {
  runId: string;
  manifestPath: string;
  backend: "vector" | "hybrid-taxonomy";
  createdAt: string;
  updatedAt: string;
  status: string;
  opinionsSelected: number;
  embeddingModelLabel: string;
  reductionMethods: string[];
  clusterCounts: number[];
  viewNames: string[];
  embeddingsReady: number;
  failedOpinions: number;
  reductionsReady: number;
  reductionsUnavailable: number;
  reductionsFailed: number;
  clusterArtifactsWritten: number;
  clusterArtifactsFailed: number;
  perspectiveArtifactsWritten: number;
  categoryCount?: number;
  subgroupCount?: number;
  assignmentCount?: number;
  outOfScopeCount?: number;
}

export interface AnalysisSummary {
  runCount: number;
  runs: AnalysisRunSummary[];
}

export interface ReportSummary {
  reportDir: string;
  primaryView: string;
  fileCount: number;
  files: string[];
}

export interface ProjectDashboardData {
  projectRoot: string;
  config: BroadlyProjectConfig;
  ingest: IngestSummary;
  opinionRuns: OpinionRunSummary[];
  analysis: AnalysisSummary;
  report: ReportSummary;
  liveReloadEnabled: boolean;
}

export interface PipelineStepSummary {
  step: PipelineStep;
  title: string;
  href: string;
  status: StepStatus;
  summary: string;
  detail: string;
}

export async function loadProjectDashboard(
  projectRoot: string,
  config: BroadlyProjectConfig,
  liveReloadEnabled: boolean
): Promise<ProjectDashboardData> {
  const projectPaths = resolveProjectPaths(projectRoot);
  const ingest = await loadIngestSummary(projectPaths, config);
  const currentOpinionRunId = await readCurrentRunId(projectPaths.opinionsCurrentRunPath);
  const opinionRuns = prioritizeCurrentRun(
    await loadOpinionRuns(path.join(projectPaths.dataDir, "opinions")),
    currentOpinionRunId
  );
  const analysis = await loadAnalysisSummary(projectPaths);
  const report = await loadReportSummary(projectPaths, config);

  return {
    projectRoot,
    config,
    ingest,
    opinionRuns,
    analysis,
    report,
    liveReloadEnabled
  };
}

export function buildPipelineSteps(data: ProjectDashboardData): PipelineStepSummary[] {
  const latestOpinionRun = data.opinionRuns[0];
  const latestAnalysisRun = data.analysis.runs[0];
  const ingestStarted = data.ingest.normalizedRecordCount > 0;
  const ingestReady = data.ingest.normalizedRecordCount > 10;
  const opinionsStarted = (latestOpinionRun?.recordsAttempted ?? 0) > 0;
  const opinionsReady =
    latestOpinionRun !== undefined &&
    data.ingest.normalizedRecordCount > 0 &&
    latestOpinionRun.recordsWritten >= data.ingest.normalizedRecordCount &&
    latestOpinionRun.failedRecords === 0;
  const analysisStarted = data.opinionRuns.length > 0;
  const analysisReady =
    latestAnalysisRun !== undefined && isAnalysisRunComplete(latestAnalysisRun);
  const reportStarted = analysisReady;
  const reportReady = data.report.fileCount > 0;

  return [
    {
      step: "ingest",
      title: "Ingest Comments",
      href: "/pipeline/ingest",
      status: ingestReady ? "ready" : ingestStarted ? "active" : "pending",
      summary: ingestReady
        ? `${data.ingest.normalizedRecordCount} normalized records are available.`
        : ingestStarted
          ? `${data.ingest.normalizedRecordCount} normalized records ingested so far.`
          : "Register a dataset and materialize normalized comment records.",
      detail: `${data.ingest.rawFileCount} raw file(s) · source ${data.ingest.format.toUpperCase()}`
    },
    {
      step: "opinions",
      title: "Extract Opinions",
      href: "/pipeline/opinions",
      status:
        opinionsReady
          ? "ready"
          : (latestOpinionRun?.recordsWritten ?? 0) > 0 || opinionsStarted
            ? "active"
            : "pending",
      summary: opinionsReady
        ? `${latestOpinionRun.recordsWritten} records processed in the latest run.`
        : (latestOpinionRun?.recordsWritten ?? 0) > 0 || opinionsStarted
          ? `${latestOpinionRun?.recordsWritten ?? 0} of ${data.ingest.normalizedRecordCount} records processed in the latest run.`
          : "Run one or more models to extract opinion units from normalized records.",
      detail:
        opinionsReady || (latestOpinionRun?.recordsWritten ?? 0) > 0 || opinionsStarted
          ? `Latest run ${latestOpinionRun?.runId ?? "unknown"}`
          : "Waiting for first opinions run"
    },
    {
      step: "analysis",
      title: "Perform Analysis",
      href: "/pipeline/analysis",
      status: analysisReady ? "ready" : analysisStarted ? "active" : "pending",
      summary: analysisReady
        ? `Latest run ${latestAnalysisRun.runId} completed all configured analysis outputs.`
        : latestAnalysisRun !== undefined
          ? describePartialAnalysisSummary(latestAnalysisRun)
          : analysisStarted
            ? "Opinion extraction exists, but no analysis run has completed yet."
          : "Cluster, synthesize, and explore the extracted opinion corpus.",
      detail:
        latestAnalysisRun !== undefined
          ? describeAnalysisRunDetail(latestAnalysisRun)
          : analysisStarted
            ? "Awaiting first analysis run"
            : "No analysis artifacts yet"
    },
    {
      step: "report",
      title: "Create Report",
      href: "/pipeline/report",
      status: reportReady ? "ready" : reportStarted ? "active" : "pending",
      summary: reportReady
        ? `${data.report.fileCount} report artifact(s) found.`
        : reportStarted
          ? "Analysis artifacts exist; report output has not been published yet."
          : "Publish an inspectable report bundle from the analysis outputs.",
      detail: reportReady
        ? `Primary view ${data.report.primaryView}`
        : reportStarted
          ? `Ready to publish from ${data.analysis.runCount} analysis run(s)`
          : "No report output yet"
    }
  ];
}

export function stageStatusLabel(status: StepStatus): string {
  switch (status) {
    case "ready":
      return "Complete";
    case "active":
      return "In Progress";
    case "pending":
      return "Pending";
  }
}

export function resolveRegisteredModelLabel(
  config: BroadlyProjectConfig,
  aliasOrId: string
): string {
  const registeredModel = config.models.find((model) => model.name === aliasOrId);

  if (registeredModel === undefined) {
    return aliasOrId;
  }

  return `${registeredModel.name} (${registeredModel.provider} · ${registeredModel.region} · ${registeredModel.modelId})`;
}

export function describeOpinionRunStatus(data: ProjectDashboardData): {
  label: string;
  processedSummary: string;
  detail: string;
} {
  const totalRecords = data.ingest.normalizedRecordCount;
  const latestRun = data.opinionRuns[0];

  if (totalRecords === 0) {
    return {
      label: "Pending",
      processedSummary: "0 / 0",
      detail: "No normalized records are available yet."
    };
  }

  if (latestRun === undefined) {
    return {
      label: "Not Started",
      processedSummary: `0 / ${totalRecords}`,
      detail: "No opinion extraction run has been recorded yet."
    };
  }

  if (latestRun.recordsAttempted < totalRecords) {
    return {
      label: "In Progress",
      processedSummary: `${latestRun.recordsWritten} / ${totalRecords}`,
      detail: "The latest extraction run processed only part of the normalized corpus."
    };
  }

  if (latestRun.recordsWritten < latestRun.recordsAttempted) {
    return {
      label: "In Progress",
      processedSummary: `${latestRun.recordsWritten} / ${totalRecords}`,
      detail: "The latest extraction run is still writing opinion artifacts."
    };
  }

  if (latestRun.failedRecords > 0) {
    return {
      label: "Completed with Failures",
      processedSummary: `${latestRun.recordsWritten} / ${totalRecords}`,
      detail: `${latestRun.failedRecords} record(s) failed during the latest extraction run.`
    };
  }

  return {
    label: "Complete",
    processedSummary: `${latestRun.recordsWritten} / ${totalRecords}`,
    detail: "The latest extraction run covered the full normalized corpus."
  };
}

export async function resolveCommandProjectRoot(project: string | undefined): Promise<string> {
  if (project !== undefined) {
    return resolveProjectRoot(project);
  }

  let currentDirectory = process.cwd();

  while (true) {
    if (await fileExists(path.join(currentDirectory, "broadly.yaml"))) {
      return currentDirectory;
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      throw new Error(
        "Could not find broadly.yaml from the current directory. Run the command inside a project or pass --project."
      );
    }

    currentDirectory = parentDirectory;
  }
}

async function loadIngestSummary(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  config: BroadlyProjectConfig
): Promise<IngestSummary> {
  const manifestPath = path.join(projectPaths.dataDir, "normalized", "ingest-manifest.json");
  const manifest = await readJsonFile<{
    createdAt?: string;
    source?: { sourceFileSha256?: string };
    output?: { recordsWritten?: number };
  }>(manifestPath);

  return {
    manifestPath: manifest === null ? null : manifestPath,
    rawFileCount: await countFiles(path.join(projectPaths.dataDir, "raw")),
    normalizedRecordCount: await countJsonFiles(path.join(projectPaths.dataDir, "normalized"), [
      "ingest-manifest.json"
    ]),
    sourcePath: config.dataset.path,
    format: config.dataset.format,
    encoding: config.dataset.encoding ?? null,
    delimiter: config.dataset.delimiter ?? null,
    idColumn: config.dataset.idColumn ?? null,
    latestImport:
      manifest?.createdAt !== undefined &&
      manifest.output?.recordsWritten !== undefined &&
      manifest.source?.sourceFileSha256 !== undefined
        ? {
            createdAt: manifest.createdAt,
            recordsWritten: manifest.output.recordsWritten,
            sourceFileSha256: manifest.source.sourceFileSha256
          }
        : null
  };
}

async function loadAnalysisSummary(
  projectPaths: ReturnType<typeof resolveProjectPaths>
): Promise<AnalysisSummary> {
  const runs = [
    ...(await loadAnalysisRuns(projectPaths.runsDir)),
    ...(await loadHybridAnalysisRuns(projectPaths.taxonomiesDir))
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    runCount: runs.length,
    runs
  };
}

async function loadAnalysisRuns(runsDir: string): Promise<AnalysisRunSummary[]> {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs: AnalysisRunSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(runsDir, entry.name, "manifest.json");
    const manifest = await readJsonFile<{
      createdAt?: string;
      updatedAt?: string;
      status?: string;
      input?: {
        opinionsSelected?: number;
        embeddingModel?: { name?: string; provider?: string; region?: string; modelId?: string };
        reductionMethods?: string[];
        clusterCounts?: number[];
        synthesisModes?: string[];
        views?: Array<{ name?: string }>;
      };
      output?: {
        embeddingsReady?: number;
        failedOpinions?: number;
        reductionsReady?: number;
        reductionsUnavailable?: number;
        reductionsFailed?: number;
        clusterArtifactsWritten?: number;
        clusterArtifactsFailed?: number;
        perspectiveArtifactsWritten?: number;
      };
    }>(manifestPath);

    if (manifest?.createdAt === undefined) {
      continue;
    }

    const embeddingModel = manifest.input?.embeddingModel;
    const embeddingModelLabel =
      embeddingModel === undefined
        ? "unknown"
        : `${embeddingModel.name ?? "unknown"} (${embeddingModel.provider ?? "unknown"} · ${embeddingModel.region ?? "unknown"} · ${embeddingModel.modelId ?? "unknown"})`;

    runs.push({
      runId: entry.name,
      manifestPath,
      backend: "vector",
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt ?? manifest.createdAt,
      status: manifest.status ?? "unknown",
      opinionsSelected: manifest.input?.opinionsSelected ?? 0,
      embeddingModelLabel,
      reductionMethods: manifest.input?.reductionMethods ?? [],
      clusterCounts: manifest.input?.clusterCounts ?? [],
      viewNames:
        manifest.input?.views?.map((view) => view?.name).filter((value): value is string => typeof value === "string") ??
        manifest.input?.synthesisModes ??
        [],
      embeddingsReady: manifest.output?.embeddingsReady ?? 0,
      failedOpinions: manifest.output?.failedOpinions ?? 0,
      reductionsReady: manifest.output?.reductionsReady ?? 0,
      reductionsUnavailable: manifest.output?.reductionsUnavailable ?? 0,
      reductionsFailed: manifest.output?.reductionsFailed ?? 0,
      clusterArtifactsWritten: manifest.output?.clusterArtifactsWritten ?? 0,
      clusterArtifactsFailed: manifest.output?.clusterArtifactsFailed ?? 0,
      perspectiveArtifactsWritten: manifest.output?.perspectiveArtifactsWritten ?? 0
    });
  }

  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function loadHybridAnalysisRuns(taxonomiesDir: string): Promise<AnalysisRunSummary[]> {
  const entries = await readdir(taxonomiesDir, { withFileTypes: true }).catch(() => []);
  const runs: AnalysisRunSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(taxonomiesDir, entry.name, "manifest.json");
    const manifest = await readJsonFile<{
      createdAt?: string;
      updatedAt?: string;
      status?: string;
      model?: { provider?: string; modelId?: string; reasoningEffort?: string };
      input?: { opinionsSelected?: number };
    }>(manifestPath);
    const taxonomy = await readJsonFile<{
      categories?: unknown[];
      themes?: unknown[];
    }>(path.join(taxonomiesDir, entry.name, "taxonomy.json"));
    const assignmentSummary = await readJsonFile<{
      assignmentCount?: number;
      outOfScopeCount?: number;
    }>(path.join(taxonomiesDir, entry.name, "assignment-summary.json"));

    if (manifest?.createdAt === undefined) {
      continue;
    }

    runs.push({
      runId: entry.name,
      manifestPath,
      backend: "hybrid-taxonomy",
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt ?? manifest.createdAt,
      status: manifest.status ?? "unknown",
      opinionsSelected: manifest.input?.opinionsSelected ?? assignmentSummary?.assignmentCount ?? 0,
      embeddingModelLabel: `hybrid-taxonomy (${manifest.model?.provider ?? "unknown"} · ${manifest.model?.modelId ?? "unknown"} · ${manifest.model?.reasoningEffort ?? "unknown"} reasoning)`,
      reductionMethods: ["taxonomy layout"],
      clusterCounts: [],
      viewNames: ["hybrid-taxonomy"],
      embeddingsReady: 0,
      failedOpinions: 0,
      reductionsReady: 1,
      reductionsUnavailable: 0,
      reductionsFailed: 0,
      clusterArtifactsWritten: taxonomy === null ? 0 : 1,
      clusterArtifactsFailed: 0,
      perspectiveArtifactsWritten: assignmentSummary === null ? 0 : 1,
      categoryCount: taxonomy?.categories?.length ?? 0,
      subgroupCount: taxonomy?.themes?.length ?? 0,
      assignmentCount: assignmentSummary?.assignmentCount ?? 0,
      outOfScopeCount: assignmentSummary?.outOfScopeCount ?? 0
    });
  }

  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function prioritizeCurrentRun<T extends { runId: string }>(runs: T[], currentRunId: string | null): T[] {
  if (currentRunId === null) {
    return runs;
  }

  const currentIndex = runs.findIndex((run) => run.runId === currentRunId);

  if (currentIndex <= 0) {
    return runs;
  }

  const currentRun = runs[currentIndex];

  if (currentRun === undefined) {
    return runs;
  }

  return [currentRun, ...runs.slice(0, currentIndex), ...runs.slice(currentIndex + 1)];
}

function expectedReductionCount(run: AnalysisRunSummary): number {
  return run.reductionMethods.length;
}

function expectedClusterArtifactCount(run: AnalysisRunSummary): number {
  return run.viewNames.length;
}

function expectedPerspectiveArtifactCount(run: AnalysisRunSummary): number {
  return run.viewNames.length;
}

function isAnalysisRunComplete(run: AnalysisRunSummary): boolean {
  if (run.backend === "hybrid-taxonomy") {
    return (
      run.status === "ready" &&
      (run.assignmentCount ?? 0) > 0 &&
      (run.categoryCount ?? 0) > 0 &&
      (run.subgroupCount ?? 0) > 0
    );
  }

  return (
    run.status === "completed" &&
    run.opinionsSelected > 0 &&
    run.failedOpinions === 0 &&
    run.embeddingsReady >= run.opinionsSelected &&
    run.reductionsReady >= expectedReductionCount(run) &&
    run.reductionsUnavailable === 0 &&
    run.reductionsFailed === 0 &&
    run.clusterArtifactsWritten >= expectedClusterArtifactCount(run) &&
    run.clusterArtifactsFailed === 0 &&
    run.perspectiveArtifactsWritten >= expectedPerspectiveArtifactCount(run)
  );
}

function describePartialAnalysisSummary(run: AnalysisRunSummary): string {
  if (run.status === "running") {
    return `Latest run ${run.runId} is still in progress.`;
  }

  if (run.status === "completed-with-failures") {
    return `Latest run ${run.runId} completed with failures or missing outputs.`;
  }

  return `Latest run ${run.runId} is only partially complete.`;
}

function describeAnalysisRunDetail(run: AnalysisRunSummary): string {
  if (run.backend === "hybrid-taxonomy") {
    return [
      `status ${run.status}`,
      `${run.categoryCount ?? 0} categories`,
      `${run.subgroupCount ?? 0} subgroups`,
      `${run.assignmentCount ?? 0} assignments`
    ].join(" · ");
  }

  return [
    `status ${run.status}`,
    `reductions ${run.reductionsReady}/${expectedReductionCount(run)}`,
    `clusters ${run.clusterArtifactsWritten}/${expectedClusterArtifactCount(run)}`,
    `perspectives ${run.perspectiveArtifactsWritten}/${expectedPerspectiveArtifactCount(run)}`
  ].join(" · ");
}

async function loadReportSummary(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  config: BroadlyProjectConfig
): Promise<ReportSummary> {
  const files = await listEntries(projectPaths.reportsDir);

  return {
    reportDir: config.report.reportDir,
    primaryView: config.report.primaryView,
    fileCount: files.length,
    files: files.slice(0, 24)
  };
}

async function loadOpinionRuns(opinionsDir: string): Promise<OpinionRunSummary[]> {
  const entries = await readdir(opinionsDir, { withFileTypes: true }).catch(() => []);
  const runs: OpinionRunSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(opinionsDir, entry.name, "manifest.json");

    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        createdAt: string;
        model: { name: string; provider: string; region: string; modelId: string };
        input: { recordsAttempted: number };
        output: { recordsWritten?: number; opinionsWritten: number; failedRecords: number };
      };

      runs.push({
        runId: entry.name,
        manifestPath,
        createdAt: manifest.createdAt,
        modelLabel: `${manifest.model.name} (${manifest.model.provider} · ${manifest.model.region} · ${manifest.model.modelId})`,
        recordsAttempted: manifest.input.recordsAttempted,
        recordsWritten: manifest.output.recordsWritten ?? manifest.input.recordsAttempted,
        opinionsWritten: manifest.output.opinionsWritten,
        failedRecords: manifest.output.failedRecords
      });
    } catch {
      continue;
    }
  }

  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function resolveProjectRoot(project: string): string {
  const normalizedProject = path.normalize(project);

  if (path.isAbsolute(normalizedProject)) {
    return normalizedProject;
  }

  const [firstSegment] = normalizedProject.split(path.sep).filter(Boolean);

  if (firstSegment === "projects") {
    return path.resolve(normalizedProject);
  }

  return path.resolve("projects", normalizedProject);
}

async function countFiles(directoryPath: string): Promise<number> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".")).length;
}

async function countJsonFiles(directoryPath: string, excludedNames: string[] = []): Promise<number> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  const excluded = new Set(excludedNames);

  return entries.filter(
    (entry) =>
      entry.isFile() &&
      !entry.name.startsWith(".") &&
      entry.name.endsWith(".json") &&
      !excluded.has(entry.name)
  ).length;
}

async function listEntries(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  const items = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => {
        const entryPath = path.join(directoryPath, entry.name);
        const entryStat = await stat(entryPath).catch(() => null);

        return {
          name: entry.name,
          mtimeMs: entryStat?.mtimeMs ?? 0
        };
      })
  );

  return items
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    .map((item) => item.name);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
