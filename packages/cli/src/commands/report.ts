import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig, type BroadlyProjectConfig } from "@broadly/config";
import { resolveProjectPaths } from "@broadly/core";
import type {
  AttestationManifest,
  ReportBundle,
  ReportViewPlot,
  StatementBank,
  VoteRoundSummary
} from "@broadly/report-model";
import { renderStaticReportHtml } from "@broadly/report-site";
import { readCurrentRunId } from "../projectArtifacts.js";
import { withProjectActionLog } from "../projectLog.js";
import { findLatestStatementRunId, loadStatementBankWithReviews } from "./statements.js";
import { loadVoteSummaryForReport } from "./vote.js";

export interface ReportCommandOptions {
  project?: string;
  run?: string;
}

export interface ReportSiteCommandOptions {
  project?: string;
  run?: string;
  statements?: string;
  attestation?: string;
}

interface ClusterArtifact {
  method?: string;
  members?: Array<{
    opinionId?: string;
    clusterId?: number;
    x?: number;
    y?: number;
  }>;
  clusters?: Array<{
    clusterId?: number;
    label?: string;
    summary?: string;
    size?: number;
    representativeOpinions?: Array<{
      opinionId?: string;
      excerpt?: string;
      opinionText?: string;
    }>;
  }>;
}

type ClusterArtifactCluster = NonNullable<ClusterArtifact["clusters"]>[number];
type RepresentativeOpinion = NonNullable<
  NonNullable<ClusterArtifactCluster["representativeOpinions"]>[number]
>;

interface PerspectiveArtifact {
  viewName?: string;
  viewTitle?: string;
  mode?: string;
  title?: string;
  summary?: string;
  chosenClusterArtifactPath?: string;
  highlights?: Array<{
    clusterId?: number;
    label?: string;
    summary?: string;
    representativeOpinions?: Array<{
      opinionId?: string;
      excerpt?: string;
      opinionText?: string;
    }>;
  }>;
}

interface SemanticMergeArtifact {
  status?: string;
  sourceClusterArtifactPath?: string;
  themes?: Array<{
    themeId?: number;
    themeLabel?: string;
    themeSummary?: string;
    clusterIds?: number[];
    subthemes?: Array<{
      subthemeId?: string;
      clusterId?: number;
      label?: string;
      summary?: string;
      size?: number;
    }>;
  }>;
}

interface AnalysisManifest {
  runId?: string;
  createdAt?: string;
  input?: {
    opinionRunId?: string;
    opinionsDir?: string;
    review?: {
      configPath?: string;
      configSha256?: string;
      includeCommentStatuses?: string[];
      includeOpinionStatuses?: string[];
      totalOpinionsAvailable?: number;
      selectedOpinions?: number;
      excludedOpinions?: number;
      excludedByStatus?: Record<string, number>;
    };
    groups?: Array<{
      opinionRunId?: string;
      opinionsDir?: string;
    }>;
  };
}

interface LoadedOpinionArtifact {
  opinionId?: string;
  opinionText?: string;
  excerpt?: string;
  sourceId?: string;
}

export async function generateReport(options: ReportCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  await withProjectActionLog({
    projectRoot,
    command: "report",
    details: {
      run: options.run ?? "(latest)"
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = await loadProjectConfig(projectPaths.configPath);
      const runId =
        options.run ??
        (await readCurrentRunId(projectPaths.analysisCurrentRunPath)) ??
        (await findLatestAnalysisRun(projectPaths.runsDir));

      if (runId === null) {
        throw new Error("No analysis runs were found. Run broadly analysis first.");
      }

  const runDir = path.join(projectPaths.runsDir, runId);
  const manifest = await readJsonFile<AnalysisManifest>(path.join(runDir, "manifest.json"));
  const perspectivesDir = path.join(runDir, "perspectives");
  const hierarchiesDir = path.join(runDir, "hierarchies");
  const perspectiveFiles = await readdir(perspectivesDir, { withFileTypes: true }).catch(() => []);
  const hierarchyArtifacts = await loadSemanticMergeArtifacts(hierarchiesDir);
  const opinionLookup = await loadReportOpinionLookup(manifest);
  const views = [];

  for (const entry of perspectiveFiles
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const perspective = await readJsonFile<PerspectiveArtifact>(
      path.join(perspectivesDir, entry.name)
    );

    if (perspective === null || perspective.mode === undefined) {
      continue;
    }

    const chosenClusterArtifact =
      perspective.chosenClusterArtifactPath === undefined
        ? null
        : await readJsonFile<ClusterArtifact>(perspective.chosenClusterArtifactPath);
    const clusterMap = new Map<number, ClusterArtifactCluster>();

    for (const cluster of chosenClusterArtifact?.clusters ?? []) {
      if (typeof cluster?.clusterId === "number") {
        clusterMap.set(cluster.clusterId, cluster);
      }
    }

    const themes =
      perspective.chosenClusterArtifactPath === undefined
        ? undefined
        : hierarchyArtifacts
            .find(
              (artifact) =>
                artifact.sourceClusterArtifactPath === perspective.chosenClusterArtifactPath &&
                artifact.status === "ready"
            )
            ?.themes?.map((theme) => {
              const clusterIds = theme.clusterIds ?? [];
              const subthemes =
                theme.subthemes === undefined
                  ? clusterIds
                      .map((clusterId) => {
                        const cluster = clusterMap.get(clusterId);

                        if (cluster === undefined) {
                          return null;
                        }

                        return {
                          subthemeId: `${theme.themeId ?? "theme"}.${clusterId}`,
                          clusterId: String(clusterId),
                          label: cluster.label ?? `Cluster ${clusterId}`,
                          summary: cluster.summary ?? "",
                          size: cluster.size ?? 0
                        };
                      })
                      .filter((item): item is NonNullable<typeof item> => item !== null)
                  : theme.subthemes.map((subtheme) => ({
                      subthemeId: subtheme.subthemeId ?? `${theme.themeId ?? "theme"}.${subtheme.clusterId ?? "unknown"}`,
                      clusterId: String(subtheme.clusterId ?? "unknown"),
                      label:
                        subtheme.label ??
                        clusterMap.get(subtheme.clusterId ?? -1)?.label ??
                        `Cluster ${subtheme.clusterId ?? "unknown"}`,
                      summary:
                        subtheme.summary ??
                        clusterMap.get(subtheme.clusterId ?? -1)?.summary ??
                        "",
                      size:
                        subtheme.size ??
                        clusterMap.get(subtheme.clusterId ?? -1)?.size ??
                        0
                    }));

              return {
                themeId: String(theme.themeId ?? "unknown"),
                label: theme.themeLabel ?? "Theme",
                summary: theme.themeSummary ?? "",
                clusterIds: clusterIds.map((clusterId) => String(clusterId)),
                subthemes
              };
            });

    const viewId = perspective.viewName ?? perspective.mode;

    if (viewId === undefined) {
      continue;
    }

    views.push({
      viewId,
      title: perspective.viewTitle ?? perspective.title ?? viewId,
      summary: perspective.summary ?? "",
      ...(themes === undefined ? {} : { themes }),
      clusters: (perspective.highlights ?? []).map((highlight) => {
        const fullCluster =
          typeof highlight.clusterId === "number"
            ? clusterMap.get(highlight.clusterId)
            : undefined;

        return {
          clusterId: String(highlight.clusterId ?? "unknown"),
          label: highlight.label ?? fullCluster?.label ?? "Cluster",
          summary: highlight.summary ?? fullCluster?.summary ?? "",
          evidenceQuotes: (highlight.representativeOpinions ?? fullCluster?.representativeOpinions ?? [])
            .slice(0, 3)
            .map((opinion: RepresentativeOpinion, index: number) => ({
              quoteId: `${highlight.clusterId ?? "cluster"}-${index + 1}`,
              sourceId: opinion.opinionId ?? "unknown",
              excerpt: opinion.excerpt ?? opinion.opinionText ?? ""
            }))
        };
      }),
      ...(chosenClusterArtifact === null
        ? {}
        : {
            plot: buildReportViewPlot(
              chosenClusterArtifact,
              new Set((perspective.highlights ?? []).map((highlight) => String(highlight.clusterId ?? "unknown"))),
              opinionLookup
            )
          })
    });
  }

  if (views.length === 0) {
    throw new Error(
      `Analysis run '${runId}' does not contain any view artifacts to report.`
    );
  }

  const reportDir = path.join(projectPaths.reportsDir, runId);
  const bundlePath = path.join(reportDir, "report-bundle.json");
  const reportBundle: ReportBundle = {
    reportId: runId,
    createdAt: new Date().toISOString(),
    analysisRunId: runId,
    projectName: config.project.name,
    questions: config.questions,
    primaryViewId: config.report.primaryView,
    ...(manifest?.input?.review === undefined
      ? {}
      : {
          review: {
            configPath: manifest.input.review.configPath ?? "",
            configSha256: manifest.input.review.configSha256 ?? "",
            includeCommentStatuses: [...(manifest.input.review.includeCommentStatuses ?? [])],
            includeOpinionStatuses: [...(manifest.input.review.includeOpinionStatuses ?? [])],
            totalOpinionsAvailable: manifest.input.review.totalOpinionsAvailable ?? 0,
            includedOpinions: manifest.input.review.selectedOpinions ?? 0,
            excludedOpinions: manifest.input.review.excludedOpinions ?? 0,
            excludedByStatus: { ...(manifest.input.review.excludedByStatus ?? {}) }
          }
        }),
    views
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(bundlePath, `${JSON.stringify(reportBundle, null, 2)}\n`, "utf8");

  const lines = [
    `Generated report for ${projectRoot}`,
    "",
    `Analysis run: ${runId}`,
    `Primary view: ${config.report.primaryView}`,
    ...(reportBundle.review === undefined
      ? []
      : [
          `Review config: ${toPortableRelativePath(projectRoot, reportBundle.review.configPath)}`,
          `Opinion boundary: ${reportBundle.review.includedOpinions} included / ${reportBundle.review.totalOpinionsAvailable} total (${reportBundle.review.excludedOpinions} excluded)`
        ]),
    `Views included: ${views.length}`,
    `Bundle: ${toPortableRelativePath(projectRoot, bundlePath)}`
  ];

      process.stdout.write(`${lines.join("\n")}\n`);
    }
  });
}

export async function generateReportSite(options: ReportSiteCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "report site",
    details: {
      run: options.run ?? "(latest)",
      statements: options.statements ?? "(current matching statement bank)",
      attestation: options.attestation ?? "(matching report attestation)"
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const runId =
        options.run ??
        (await readCurrentRunId(projectPaths.analysisCurrentRunPath)) ??
        (await findLatestReportBundleRun(projectPaths.reportsDir));

      if (runId === null) {
        throw new Error("No report bundle was found. Run broadly report first.");
      }

      const reportDir = path.join(projectPaths.reportsDir, runId);
      const reportBundlePath = path.join(reportDir, "report-bundle.json");
      const reportBundle = await readJsonFile<ReportBundle>(reportBundlePath);

      if (reportBundle === null) {
        throw new Error(`Report bundle '${reportBundlePath}' could not be read.`);
      }

      const statementBank = await loadStatementBankForSite(projectRoot, reportBundle.analysisRunId, options.statements);
      const voteSummary = await loadVoteSummaryForReport(projectPaths.reportsDir, reportBundle.analysisRunId);
      const attestation = await loadAttestationForSite(projectRoot, runId, options.attestation);
      const siteDir = path.join(reportDir, "site");
      const dataDir = path.join(siteDir, "data");
      const assetsDir = path.join(siteDir, "assets");
      const analysisDataDir = path.join(dataDir, "analysis");
      const html = renderStaticReportHtml(reportBundle, {
        statementBank,
        voteSummary,
        attestation
      });

      await mkdir(assetsDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeFile(path.join(siteDir, "index.html"), html, "utf8");
      await writeFile(path.join(assetsDir, ".gitkeep"), "", "utf8");
      await writeFile(
        path.join(dataDir, "report-bundle.json"),
        `${JSON.stringify(reportBundle, null, 2)}\n`,
        "utf8"
      );

      if (statementBank !== null) {
        await writeFile(
          path.join(dataDir, "statements.json"),
          `${JSON.stringify(statementBank, null, 2)}\n`,
          "utf8"
        );
      }

      if (voteSummary !== null) {
        await writeFile(
          path.join(dataDir, "vote-summary.json"),
          `${JSON.stringify(voteSummary, null, 2)}\n`,
          "utf8"
        );
      }

      if (attestation !== null) {
        await writeFile(
          path.join(dataDir, "attestation.json"),
          `${JSON.stringify(attestation, null, 2)}\n`,
          "utf8"
        );
      }

      await copyAnalysisData(projectPaths.runsDir, reportBundle.analysisRunId, analysisDataDir);

      process.stdout.write(
        [
          `Generated static report site for ${projectRoot}`,
          "",
          `Analysis run: ${reportBundle.analysisRunId}`,
          `Site: ${toPortableRelativePath(projectRoot, path.join(siteDir, "index.html"))}`,
          `Data: ${toPortableRelativePath(projectRoot, dataDir)}`
        ].join("\n") + "\n"
      );
    }
  });
}

async function loadProjectConfig(configPath: string): Promise<BroadlyProjectConfig> {
  const source = await readFile(configPath, "utf8");
  return parseProjectConfig(source);
}

async function findLatestAnalysisRun(runsDir: string): Promise<string | null> {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs: Array<{ name: string; createdAt: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifest = await readJsonFile<AnalysisManifest>(
      path.join(runsDir, entry.name, "manifest.json")
    );

    if (manifest?.createdAt !== undefined) {
      runs.push({
        name: entry.name,
        createdAt: manifest.createdAt
      });
    }
  }

  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return runs[0]?.name ?? null;
}

async function findLatestReportBundleRun(reportsDir: string): Promise<string | null> {
  const entries = await readdir(reportsDir, { withFileTypes: true }).catch(() => []);
  const runs: Array<{ name: string; createdAt: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const reportBundle = await readJsonFile<ReportBundle>(
      path.join(reportsDir, entry.name, "report-bundle.json")
    );

    if (reportBundle?.createdAt !== undefined) {
      runs.push({
        name: entry.name,
        createdAt: reportBundle.createdAt
      });
    }
  }

  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return runs[0]?.name ?? null;
}

async function loadStatementBankForSite(
  projectRoot: string,
  analysisRunId: string,
  statementsPath: string | undefined
): Promise<StatementBank | null> {
  if (statementsPath !== undefined) {
    const resolvedPath = await resolveInputPath(projectRoot, statementsPath);
    return readJsonFile<StatementBank>(resolvedPath);
  }

  const projectPaths = resolveProjectPaths(projectRoot);
  const currentStatementRunId = await readCurrentRunId(projectPaths.statementsCurrentRunPath);
  const candidateRunIds = [
    ...(currentStatementRunId === null ? [] : [currentStatementRunId]),
    ...((await findLatestStatementRunId(projectPaths.statementsDir)) === null
      ? []
      : [await findLatestStatementRunId(projectPaths.statementsDir)])
  ];

  for (const statementRunId of [...new Set(candidateRunIds)]) {
    if (statementRunId === null) {
      continue;
    }

    const loaded = await loadStatementBankWithReviews(projectRoot, statementRunId);

    if (loaded.bank.analysisRunId === analysisRunId) {
      return {
        ...loaded.bank,
        statements: loaded.statements
      };
    }
  }

  return null;
}

async function loadAttestationForSite(
  projectRoot: string,
  reportRunId: string,
  attestationPath: string | undefined
): Promise<AttestationManifest | null> {
  const resolvedPath =
    attestationPath === undefined
      ? path.join(resolveProjectPaths(projectRoot).attestationsDir, "reports", `${reportRunId}.attestation.json`)
      : await resolveInputPath(projectRoot, attestationPath);

  return readJsonFile<AttestationManifest>(resolvedPath);
}

async function copyAnalysisData(
  runsDir: string,
  analysisRunId: string,
  outputDir: string
): Promise<void> {
  const runDir = path.join(runsDir, analysisRunId);
  const directories = ["reductions", "clusters", "hierarchies", "perspectives"];

  await mkdir(outputDir, { recursive: true });

  const manifest = await readJsonFile<unknown>(path.join(runDir, "manifest.json"));

  if (manifest !== null) {
    await writeFile(
      path.join(outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
  }

  for (const directory of directories) {
    const sourceDir = path.join(runDir, directory);
    const targetDir = path.join(outputDir, directory);
    const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);

    if (entries.length === 0) {
      continue;
    }

    await mkdir(targetDir, { recursive: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      await writeFile(
        path.join(targetDir, entry.name),
        await readFile(path.join(sourceDir, entry.name), "utf8"),
        "utf8"
      );
    }
  }
}

async function loadReportOpinionLookup(
  manifest: AnalysisManifest | null
): Promise<Record<string, LoadedOpinionArtifact>> {
  const opinionsDirs = uniqueStrings(
    [
      manifest?.input?.opinionsDir,
      ...(manifest?.input?.groups ?? []).map((group) => group.opinionsDir)
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  );
  const lookup: Record<string, LoadedOpinionArtifact> = {};

  for (const opinionsDir of opinionsDirs) {
    const entries = await readdir(opinionsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const artifact = await readJsonFile<LoadedOpinionArtifact>(path.join(opinionsDir, entry.name));

      if (artifact?.opinionId !== undefined) {
        lookup[artifact.opinionId] = artifact;
      }
    }
  }

  return lookup;
}

function buildReportViewPlot(
  artifact: ClusterArtifact,
  highlightedClusterIds: Set<string>,
  opinionLookup: Record<string, LoadedOpinionArtifact>
): ReportViewPlot {
  const clusterById = new Map(
    (artifact.clusters ?? [])
      .filter((cluster) => typeof cluster.clusterId === "number")
      .map((cluster) => [String(cluster.clusterId), cluster] as const)
  );
  const points = (artifact.members ?? [])
    .filter(
      (
        member
      ): member is { opinionId: string; clusterId: number; x: number; y: number } =>
        typeof member.opinionId === "string" &&
        typeof member.clusterId === "number" &&
        typeof member.x === "number" &&
        typeof member.y === "number"
    )
    .map((member) => {
      const opinion = opinionLookup[member.opinionId];
      const clusterId = String(member.clusterId);

      return {
        opinionId: member.opinionId,
        clusterId,
        x: member.x,
        y: member.y,
        ...(opinion?.opinionText === undefined ? {} : { opinionText: opinion.opinionText }),
        ...(opinion?.excerpt === undefined ? {} : { excerpt: opinion.excerpt }),
        ...(opinion?.sourceId === undefined ? {} : { sourceId: opinion.sourceId }),
        ...(highlightedClusterIds.has(clusterId) ? { highlighted: true } : {})
      };
    });

  return {
    method: artifact.method ?? "unknown",
    pointCount: points.length,
    clusters: [...clusterById.entries()]
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([clusterId, cluster]) => ({
        clusterId,
        label: cluster.label ?? `Cluster ${clusterId}`,
        summary: cluster.summary ?? "",
        size:
          typeof cluster.size === "number"
            ? cluster.size
            : points.filter((point) => point.clusterId === clusterId).length,
        ...(highlightedClusterIds.has(clusterId) ? { highlighted: true } : {})
      })),
    points
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function loadSemanticMergeArtifacts(
  hierarchiesDir: string
): Promise<SemanticMergeArtifact[]> {
  const entries = await readdir(hierarchiesDir, { withFileTypes: true }).catch(() => []);
  const artifacts: SemanticMergeArtifact[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const artifact = await readJsonFile<SemanticMergeArtifact>(path.join(hierarchiesDir, entry.name));

    if (artifact !== null) {
      artifacts.push(artifact);
    }
  }

  return artifacts;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function resolveInputPath(projectRoot: string, inputPath: string): Promise<string> {
  const projectRelativePath = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(projectRoot, inputPath);

  if (await fileExists(projectRelativePath)) {
    return projectRelativePath;
  }

  const cwdRelativePath = path.resolve(inputPath);

  if (await fileExists(cwdRelativePath)) {
    return cwdRelativePath;
  }

  return projectRelativePath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandProjectRoot(project: string | undefined): Promise<string> {
  if (project !== undefined) {
    return resolveProjectRoot(project);
  }

  let currentDirectory = process.cwd();

  while (true) {
    try {
      await readFile(path.join(currentDirectory, "broadly.yaml"), "utf8");
      return currentDirectory;
    } catch {
      const parentDirectory = path.dirname(currentDirectory);

      if (parentDirectory === currentDirectory) {
        throw new Error(
          "Could not find broadly.yaml from the current directory. Run the command inside a project or pass --project."
        );
      }

      currentDirectory = parentDirectory;
    }
  }
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

function toPortableRelativePath(fromDirectory: string, toPath: string): string {
  const relativePath = path.relative(fromDirectory, toPath);
  const portablePath = relativePath.split(path.sep).join("/");

  return portablePath.startsWith(".") ? portablePath : `./${portablePath}`;
}
