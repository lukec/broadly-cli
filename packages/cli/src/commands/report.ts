import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig, type BroadlyProjectConfig } from "@broadly/config";
import { resolveProjectPaths } from "@broadly/core";
import type { ReportBundle } from "@broadly/report-model";
import { readCurrentRunId } from "../projectArtifacts.js";
import { withProjectActionLog } from "../projectLog.js";

export interface ReportCommandOptions {
  project?: string;
  run?: string;
}

interface ClusterArtifact {
  clusters?: Array<{
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
  }>;
}

interface AnalysisManifest {
  runId?: string;
  createdAt?: string;
  input?: {
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
  };
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
            ?.themes?.map((theme) => ({
              themeId: String(theme.themeId ?? "unknown"),
              label: theme.themeLabel ?? "Theme",
              summary: theme.themeSummary ?? "",
              clusterIds: (theme.clusterIds ?? []).map((clusterId) => String(clusterId))
            }));

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
