import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  getOpinionExtractionConfig,
  parseProjectConfig,
  type AnalysisViewConfig,
  type BroadlyProjectConfig
} from "@broadly/config";
import {
  resolveProjectPaths,
  sha256Hex,
  type ReviewConfig,
  type ReviewStatus
} from "@broadly/core";
import { UMAP } from "umap-js";
import { kmeans } from "ml-kmeans";

import {
  runEmbeddingWithModel,
  runTextPromptWithModel,
  type RegisteredModel
} from "../modelRuntime.js";
import {
  readCurrentRunId,
  writeCurrentRunId
} from "../projectArtifacts.js";
import { withProjectActionLog } from "../projectLog.js";
import {
  ensureProjectReviewState,
  loadCommentReview,
  loadOpinionReview,
  resolveEffectiveOpinionReviewStatus
} from "../reviewState.js";

const execFile = promisify(execFileCallback);

export interface AnalysisCommandOptions {
  project?: string;
  embeddingModel?: string;
  limit?: number;
  offset?: number;
  evaluateReducers?: boolean;
  evaluateClusteringSurfaces?: boolean;
  evaluateGraphBuilders?: boolean;
  promoteGraphSurface?: string | boolean;
  run?: string;
  neighborK?: number;
}

interface OpinionArtifact {
  opinionId: string;
  opinionText: string;
  excerpt?: string;
  sourceId: string;
  sourceContentSha256: string;
  provenance?: {
    normalizedRecordPath?: string;
    sourceImportPath?: string;
    sourceFileSha256?: string;
    sourceRowNumber?: number;
    externalId?: string;
  };
}

interface EmbeddingArtifact {
  createdAt: string;
  opinionId: string;
  sourceId: string;
  sourceContentSha256: string;
  opinionTextSha256: string;
  model: RegisteredModel;
  dimensions: number;
  vector: number[];
  provenance: {
    opinionArtifactPath: string;
    opinionRunId: string;
    normalizedRecordPath?: string;
    sourceImportPath?: string;
    sourceFileSha256?: string;
    sourceRowNumber?: number;
    externalId?: string;
  };
}

interface ReductionPoint {
  opinionId: string;
  x: number;
  y: number;
}

interface ReductionArtifact {
  createdAt: string;
  method: string;
  dimensions: 2;
  status: "ready" | "unavailable" | "failed";
  message?: string;
  pointCount: number;
  points: ReductionPoint[];
}

class PacmapUnavailableError extends Error {}

interface ClusterMember {
  opinionId: string;
  clusterId: number;
  x: number;
  y: number;
}

interface ClusterSummary {
  clusterId: number;
  size: number;
  centroid: [number, number];
  label: string;
  topTerms: string[];
  summary: string;
  representativeOpinions: Array<{
    opinionId: string;
    opinionText: string;
    excerpt?: string;
  }>;
}

interface ClusterArtifact {
  createdAt: string;
  method: string;
  requestedClusterCount: number;
  effectiveClusterCount: number;
  status: "ready" | "skipped" | "failed";
  message?: string;
  sourceReductionPath: string;
  labeling: {
    method: "llm-cluster-labeling" | "heuristic-fallback";
    model?: RegisteredModel;
    stopReason?: string | null;
    prompt?: {
      path: string;
      sha256: string;
    };
    rawText?: string;
    error?: string;
    createdAt: string;
  };
  members: ClusterMember[];
  clusters: ClusterSummary[];
  experimental?: {
    kind: "graph-surface";
    sourceSurfaceId: string;
    sourceSurfacePath: string;
    sourceGraphEvaluationPath: string;
    displayReductionPath: string;
    graphSurfaceLabel: string;
    embeddingNeighborPurityAtK?: number | null;
    embeddingSilhouette?: number | null;
    excludedClusterIds?: number[];
  };
}

const ANALYSIS_META_TOKENS = new Set([
  "cluster",
  "clusters",
  "comment",
  "comments",
  "concern",
  "concerns",
  "feedback",
  "group",
  "grouped",
  "grouping",
  "groups",
  "include",
  "includes",
  "including",
  "issue",
  "issues",
  "opinion",
  "opinions",
  "perspective",
  "perspectives",
  "shared",
  "theme",
  "themes",
  "topic",
  "topics",
  "view",
  "views",
  "viewpoint",
  "viewpoints"
]);

interface PerspectivePlanArtifact {
  createdAt: string;
  viewName?: string;
  viewTitle?: string;
  mode: string;
  status: "ready" | "unavailable";
  chosenClusterArtifactPath?: string;
  chosenReductionMethod?: string;
  chosenClusterCount?: number;
  synthesis: {
    method: "llm-perspective-summary" | "heuristic-fallback";
    model?: RegisteredModel;
    stopReason?: string | null;
    prompt?: {
      path: string;
      sha256: string;
    };
    rawText?: string;
    error?: string;
    createdAt: string;
  };
  title?: string;
  summary?: string;
  highlights: Array<{
    clusterId: number;
    label: string;
    size: number;
    summary: string;
    representativeOpinions: Array<{
      opinionId: string;
      opinionText: string;
      excerpt?: string;
    }>;
  }>;
  rationale: string;
  experimental?: {
    kind: "graph-surface";
    sourceSurfaceId: string;
    excludedClusterIds?: number[];
  };
}

interface ClusterHierarchyArtifact {
  createdAt: string;
  method: string;
  sourceClusterArtifactPath: string;
  higherClusterCount: number;
  lowerClusterCount: number;
  status: "ready" | "failed";
  merge: {
    method: "llm-semantic-merge";
    model?: RegisteredModel;
    stopReason?: string | null;
    prompt?: {
      path: string;
      sha256: string;
    };
    rawText?: string;
    error?: string;
    createdAt: string;
  };
  themes: Array<{
    themeId: number;
    themeLabel: string;
    themeSummary: string;
    clusterIds: number[];
    subthemes?: Array<{
      subthemeId: string;
      clusterId: number;
      label: string;
      summary: string;
      size: number;
    }>;
    mergeRationale: string;
  }>;
  higherToLower: Array<{
    higherClusterId: number;
    higherLabel: string;
    lowerClusterIds: number[];
  }>;
  lowerToHigher: Array<{
    lowerClusterId: number;
    lowerLabel: string;
    higherClusterId: number;
    higherLabel: string;
    mergeRationale: string;
  }>;
  experimental?: {
    kind: "graph-surface";
    sourceSurfaceId: string;
    excludedClusterIds: number[];
    exclusionReason: string;
  };
}

interface ReducerEvaluationArtifact {
  createdAt: string;
  runId: string;
  method: "reducer-evaluation-v1";
  parameters: {
    neighborK: number;
    silhouetteMaxPoints: number;
  };
  source: {
    manifestPath: string;
    embeddingsDirs: string[];
    reductionsDir: string;
    clustersDir: string;
  };
  corpus: {
    embeddingCount: number;
    reductionCount: number;
    readyReductionCount: number;
    clusterArtifactCount: number;
    comparableOpinionCount: number;
  };
  reductions: ReductionEvaluationSummary[];
  clusters: ClusterEvaluationSummary[];
  clusterAgreement: ClusterAgreementSummary[];
  observations: string[];
}

interface ReductionEvaluationSummary {
  method: string;
  artifactPath: string;
  status: ReductionArtifact["status"];
  pointCount: number;
  comparableOpinionCount: number;
  neighborRecallAtK: {
    k: number;
    mean: number | null;
    median: number | null;
  };
  projection: ProjectionDiagnostics;
}

interface ProjectionDiagnostics {
  finiteCoordinateRate: number;
  xRange: number;
  yRange: number;
  area: number;
  duplicateCoordinateCount: number;
  duplicateCoordinateRate: number;
  maxDistanceFromCentroid: number;
  outlierCount: number;
  outlierRate: number;
}

interface ClusterEvaluationSummary {
  viewName: string;
  method: string;
  artifactPath: string;
  status: ClusterArtifact["status"];
  requestedClusterCount: number;
  effectiveClusterCount: number;
  memberCount: number;
  comparableOpinionCount: number;
  singletonClusterCount: number;
  largestClusterSize: number;
  largestClusterShare: number;
  embeddingNeighborPurityAtK: number | null;
  projectionNeighborPurityAtK: number | null;
  projectionSilhouette: number | null;
  embeddingSilhouette: number | null;
}

interface ClusterAgreementSummary {
  leftViewName: string;
  rightViewName: string;
  leftMethod: string;
  rightMethod: string;
  comparableOpinionCount: number;
  adjustedRandIndex: number | null;
}

interface ClusteringSurfaceEvaluationArtifact {
  createdAt: string;
  runId: string;
  method: "clustering-surface-evaluation-v1";
  parameters: {
    neighborK: number;
    silhouetteMaxPoints: number;
  };
  source: {
    manifestPath: string;
    embeddingsDirs: string[];
    reductionsDir: string;
    clustersDir: string;
  };
  corpus: {
    embeddingCount: number;
    clusterArtifactCount: number;
    embeddingSurfaceCount: number;
    projectionSurfaceCount: number;
    comparableOpinionCount: number;
  };
  surfaces: ClusteringSurfaceSummary[];
  comparisons: ClusteringSurfaceComparisonSummary[];
  observations: string[];
}

interface ClusteringSurfaceSummary {
  surfaceId: string;
  surfaceKind: "embedding" | "projection" | "graph";
  label: string;
  method: string;
  status: "ready" | "skipped" | "failed";
  viewName?: string;
  requestedClusterCount: number;
  effectiveClusterCount: number;
  memberCount: number;
  comparableOpinionCount: number;
  singletonClusterCount: number;
  largestClusterSize: number;
  largestClusterShare: number;
  embeddingNeighborPurityAtK: number | null;
  embeddingSilhouette: number | null;
}

interface ClusteringSurfaceComparisonSummary {
  leftSurfaceId: string;
  rightSurfaceId: string;
  leftLabel: string;
  rightLabel: string;
  comparableOpinionCount: number;
  adjustedRandIndex: number | null;
  largestMembershipShifts: MembershipShiftSummary[];
}

interface MembershipShiftSummary {
  sourceClusterId: number;
  sourceClusterSize: number;
  fragmentationRate: number;
  topDestinationClusters: Array<{
    clusterId: number;
    count: number;
    share: number;
  }>;
}

interface ClusteringSurfaceWorkingSet {
  summary: ClusteringSurfaceSummary;
  clusterById: Map<string, number>;
}

interface GraphSurfaceAssignmentArtifact {
  surface: ClusteringSurfaceSummary;
  assignments: Array<{
    opinionId: string;
    clusterId: number;
  }>;
}

interface GraphBuilderEvaluationArtifact {
  createdAt: string;
  runId: string;
  method: "graph-builder-evaluation-v1";
  parameters: {
    neighborK: number;
    graphNeighborKs: number[];
    silhouetteMaxPoints: number;
  };
  source: {
    manifestPath: string;
    embeddingsDirs: string[];
    reductionsDir: string;
    clustersDir: string;
    graphsDir: string;
    graphSurfacesDir: string;
  };
  corpus: {
    embeddingCount: number;
    graphCount: number;
    graphSurfaceCount: number;
    embeddingSurfaceCount: number;
    projectionSurfaceCount: number;
    comparableOpinionCount: number;
  };
  graphs: GraphBuilderSummary[];
  surfaces: ClusteringSurfaceSummary[];
  comparisons: ClusteringSurfaceComparisonSummary[];
  observations: string[];
}

interface GraphBuilderSummary {
  graphId: string;
  method: "plain-knn" | "mutual-knn" | "mutual-knn-repaired" | "shared-neighbor";
  label: string;
  neighborK: number;
  nodeCount: number;
  edgeCount: number;
  density: number;
  isolatedNodeCount: number;
  averageWeightedDegree: number;
  baseGraphId?: string;
  repairedEdgeCount?: number;
  repairStrategy?: string;
}

interface GraphBuilderArtifact {
  graphId: string;
  method: GraphBuilderSummary["method"];
  label: string;
  neighborK: number;
  opinionIds: string[];
  adjacency: Map<string, Map<string, number>>;
  summary: GraphBuilderSummary;
}

interface AnalysisRunManifest {
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "completed-with-failures";
  fingerprint: AnalysisRunFingerprint;
  input: {
    opinionRunId: string;
    opinionRunDir: string;
    opinionsDir: string;
    opinionsSelected: number;
    review: {
      configPath: string;
      configSha256: string;
      includeCommentStatuses: ReviewStatus[];
      includeOpinionStatuses: ReviewStatus[];
      totalOpinionsAvailable: number;
      selectedOpinions: number;
      excludedOpinions: number;
      excludedByStatus: ReviewStatusCounts;
    };
    offset?: number;
    limit?: number;
    extractionModel: RegisteredModel;
    embeddingModel: RegisteredModel;
    analysisModel: RegisteredModel;
    prompts: {
      clusterLabeling: {
        path: string;
        sha256: string;
      };
      perspectiveSummary: {
        path: string;
        sha256: string;
      };
      semanticMerge: {
        path: string;
        sha256: string;
      };
    };
    reductionMethods: string[];
    clusterCounts: number[];
    mergeStrategy: string;
    synthesisModes: string[];
    views?: Array<{
      name: string;
      title?: string;
      mode: string;
      reductionMethod: string;
      clusterCount: number;
      sourceExtraction: string;
      analysisModel?: string;
    }>;
    groups?: Array<{
      sourceExtraction: string;
      opinionRunId: string;
      opinionRunDir: string;
      opinionsDir: string;
      opinionsSelected: number;
      review: {
        totalOpinionsAvailable: number;
        selectedOpinions: number;
        excludedOpinions: number;
        excludedByStatus: ReviewStatusCounts;
      };
      extractionModel: RegisteredModel;
      embeddingModel: RegisteredModel;
      embeddingsDir: string;
      viewNames: string[];
    }>;
  };
  output: {
    embeddingsDir: string;
    reductionsDir: string;
    clustersDir: string;
    hierarchiesDir: string;
    perspectivesDir: string;
    embeddingsReady: number;
    embeddingsGenerated: number;
    embeddingsReused: number;
    failedOpinions: number;
    reductionsReady: number;
    reductionsUnavailable: number;
    reductionsFailed: number;
    clusterArtifactsWritten: number;
    clusterArtifactsFailed: number;
    labelArtifactsFailed: number;
    hierarchyArtifactsWritten: number;
    hierarchyArtifactsFailed: number;
    perspectiveArtifactsWritten: number;
  };
}

interface AnalysisRunFingerprint {
  opinionRunId: string;
  selectedOpinionIdsSha256: string;
  groupsSha256?: string;
  reviewConfigSha256: string;
  embeddingModel: string;
  analysisModel: string;
  viewsSha256: string;
  clusterLabelingPromptSha256: string;
  perspectiveSummaryPromptSha256: string;
  semanticMergePromptSha256: string;
  reductionMethods: string[];
  clusterCounts: number[];
  mergeStrategy: string;
  synthesisModes: string[];
}

interface EmbeddingRunManifest {
  createdAt: string;
  updatedAt: string;
  opinionRunId: string;
  embeddingModel: RegisteredModel;
  input: {
    opinionsDir: string;
    opinionsSelected: number;
    offset?: number;
    limit?: number;
  };
  output: {
    embeddingsDir: string;
    manifestPath: string;
    embeddingsReady: number;
    embeddingsGenerated: number;
    embeddingsReused: number;
    failedOpinions: number;
  };
}

interface ResolvedAnalysisView {
  view: AnalysisViewConfig;
  analysisModel: RegisteredModel;
  prompts: {
    clusterLabeling: {
      path: string;
      template: string;
      sha256: string;
    };
    perspectiveSummary: {
      path: string;
      template: string;
      sha256: string;
    };
    semanticMerge: {
      path: string;
      template: string;
      sha256: string;
    };
  };
}

interface AnalysisViewGroup {
  key: string;
  sourceExtraction: ReturnType<typeof getOpinionExtractionConfig>;
  extractionModel: RegisteredModel;
  embeddingModel: RegisteredModel;
  views: ResolvedAnalysisView[];
  opinionRunId: string;
  opinionsRunDir: string;
  opinionsDir: string;
  selectedOpinionPaths: string[];
  review: {
    totalOpinionCount: number;
    selectedOpinionCount: number;
    excludedOpinionCount: number;
    effectiveStatusCounts: Record<ReviewStatus, number>;
  };
  embeddingsDir: string;
  embeddingsManifestPath: string;
}

type ReviewStatusCounts = Record<ReviewStatus, number>;

function isGraphSurfacePromotionRequested(value: string | boolean | undefined): boolean {
  return value !== undefined && value !== false;
}

export async function runAnalysis(options: AnalysisCommandOptions): Promise<void> {
  if (
    options.evaluateReducers === true ||
    options.evaluateClusteringSurfaces === true ||
    options.evaluateGraphBuilders === true ||
    isGraphSurfacePromotionRequested(options.promoteGraphSurface)
  ) {
    if (options.evaluateReducers === true) {
      await evaluateAnalysisReducers(options);
    }

    if (options.evaluateClusteringSurfaces === true) {
      await evaluateAnalysisClusteringSurfaces(options);
    }

    if (options.evaluateGraphBuilders === true) {
      await evaluateAnalysisGraphBuilders(options);
    }

    if (isGraphSurfacePromotionRequested(options.promoteGraphSurface)) {
      await promoteAnalysisGraphSurface(options);
    }

    return;
  }

  const projectRoot = await resolveCommandProjectRoot(options.project);
  await withProjectActionLog({
    projectRoot,
    command: "analysis",
    details: {
      embeddingModel: options.embeddingModel ?? "(configured)",
      limit: options.limit,
      offset: options.offset
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = await loadProjectConfig(projectPaths.configPath);
      const reviewConfig = await ensureProjectReviewState(projectPaths);
      const reviewConfigSha256 = sha256Hex(JSON.stringify(reviewConfig));
      const analysisViews = resolveConfiguredAnalysisViews(config, options.embeddingModel);
      const firstView = analysisViews[0];

      if (firstView === undefined) {
        throw new Error("No analysis views were selected.");
      }

      const resolvedViews = await Promise.all(
        analysisViews.map(async (view) => {
          const clusterLabelingPromptPath = path.join(projectRoot, view.prompts.clusterLabeling);
          const perspectiveSummaryPromptPath = path.join(projectRoot, view.prompts.viewSummary);
          const semanticMergePromptPath = path.join(projectRoot, view.prompts.semanticMerge);
          const clusterLabelingPrompt = await readFile(clusterLabelingPromptPath, "utf8");
          const perspectiveSummaryPrompt = await readFile(perspectiveSummaryPromptPath, "utf8");
          const semanticMergePrompt = await readFile(semanticMergePromptPath, "utf8");

          return {
            view,
            analysisModel: resolveAnalysisModelForView(config, view),
            prompts: {
              clusterLabeling: {
                path: clusterLabelingPromptPath,
                template: clusterLabelingPrompt,
                sha256: sha256Hex(clusterLabelingPrompt)
              },
              perspectiveSummary: {
                path: perspectiveSummaryPromptPath,
                template: perspectiveSummaryPrompt,
                sha256: sha256Hex(perspectiveSummaryPrompt)
              },
              semanticMerge: {
                path: semanticMergePromptPath,
                template: semanticMergePrompt,
                sha256: sha256Hex(semanticMergePrompt)
              }
            }
          };
        })
      );
      const currentOpinionRunId = await readCurrentRunId(projectPaths.opinionsCurrentRunPath);
      const offset = options.offset ?? 0;
      const analysisGroups = await resolveAnalysisViewGroups({
        config,
        projectPaths,
        projectRoot,
        reviewConfig,
        resolvedViews,
        currentOpinionRunId,
        offset,
        ...(options.limit === undefined ? {} : { limit: options.limit })
      });
      const firstGroup = analysisGroups[0];

      if (firstGroup === undefined) {
        throw new Error("No analysis groups could be resolved from the configured views.");
      }

      const latestOpinionRun = { runId: firstGroup.opinionRunId };
      const embeddingModel = firstGroup.embeddingModel;
      const extractionModel = firstGroup.extractionModel;
      const analysisModel = firstGroup.views[0]?.analysisModel ?? resolveConfiguredAnalysisModel(config, analysisViews);
      const selectedOpinionPaths = firstGroup.selectedOpinionPaths;
      const embeddingsDir = firstGroup.embeddingsDir;
      const embeddingsManifestPath = firstGroup.embeddingsManifestPath;
      const reviewTotals = analysisGroups.reduce(
        (summary, group) => ({
          totalOpinionCount: summary.totalOpinionCount + group.review.totalOpinionCount,
          selectedOpinionCount: summary.selectedOpinionCount + group.review.selectedOpinionCount,
          excludedOpinionCount: summary.excludedOpinionCount + group.review.excludedOpinionCount,
          excludedByStatus: mergeReviewStatusCounts(
            summary.excludedByStatus,
            extractExcludedReviewStatusCounts(group.review.effectiveStatusCounts)
          )
        }),
        {
          totalOpinionCount: 0,
          selectedOpinionCount: 0,
          excludedOpinionCount: 0,
          excludedByStatus: createEmptyReviewStatusCounts()
        }
      );
      const fingerprint = buildAnalysisRunFingerprint({
        opinionRunId: firstGroup.opinionRunId,
        selectedOpinionPaths: analysisGroups.flatMap((group) => group.selectedOpinionPaths),
        reviewConfigSha256,
        embeddingModel,
        analysisModel,
        clusterLabelingPromptSha256: resolvedViews[0]?.prompts.clusterLabeling.sha256 ?? "",
        perspectiveSummaryPromptSha256: resolvedViews[0]?.prompts.perspectiveSummary.sha256 ?? "",
        semanticMergePromptSha256: resolvedViews[0]?.prompts.semanticMerge.sha256 ?? "",
        reductionMethods: uniqueList(analysisViews.map((view) => view.reduction.method)),
        clusterCounts: uniqueNumberList(analysisViews.map((view) => view.clustering.count)),
        mergeStrategy: uniqueList(analysisViews.map((view) => view.clustering.mergeStrategy)).join(","),
        synthesisModes: analysisViews.map((view) => view.name),
        groupsSha256: sha256Hex(
          JSON.stringify(
            analysisGroups.map((group) => ({
              sourceExtraction: group.sourceExtraction.name,
              opinionRunId: group.opinionRunId,
              embeddingModel: group.embeddingModel.name,
              selectedOpinionIds: group.selectedOpinionPaths
                .map((item) => path.basename(item, ".json"))
                .sort(),
              views: group.views.map((view) => view.view.name).sort()
            }))
          )
        ),
        viewsSha256: sha256Hex(
          JSON.stringify(
            resolvedViews.map((item) => ({
              name: item.view.name,
              title: item.view.title,
              sourceExtraction: item.view.sourceExtraction,
              embeddingModel: item.view.embeddingModel,
              analysisModel: item.analysisModel.name,
              clusterLabelingPromptSha256: item.prompts.clusterLabeling.sha256,
              perspectiveSummaryPromptSha256: item.prompts.perspectiveSummary.sha256,
              semanticMergePromptSha256: item.prompts.semanticMerge.sha256,
              reductionMethod: item.view.reduction.method,
              clusterCount: item.view.clustering.count,
              mergeStrategy: item.view.clustering.mergeStrategy,
              mode: item.view.mode
            }))
          )
        )
      });
      const currentAnalysisRunId = await readCurrentRunId(projectPaths.analysisCurrentRunPath);
      const compatibleRun =
        (currentAnalysisRunId === null
          ? null
          : await findCompatibleAnalysisRunById(projectPaths.runsDir, currentAnalysisRunId, fingerprint)) ??
        (await findLatestCompatibleAnalysisRun(projectPaths.runsDir, fingerprint));
      const analysisRunId = compatibleRun?.runId ?? createAnalysisRunId(embeddingModel.name);
      const analysisRunDir = path.join(projectPaths.runsDir, analysisRunId);
      const reductionsDir = path.join(analysisRunDir, "reductions");
      const clustersDir = path.join(analysisRunDir, "clusters");
      const hierarchiesDir = path.join(analysisRunDir, "hierarchies");
      const perspectivesDir = path.join(analysisRunDir, "perspectives");
      const analysisManifestPath = path.join(analysisRunDir, "manifest.json");
      const createdAt = compatibleRun?.createdAt ?? new Date().toISOString();
      const autoResumed = compatibleRun !== null;

      await mkdir(embeddingsDir, { recursive: true });
      await mkdir(reductionsDir, { recursive: true });
      await mkdir(clustersDir, { recursive: true });
      await mkdir(hierarchiesDir, { recursive: true });
      await mkdir(perspectivesDir, { recursive: true });
      await writeCurrentRunId(projectPaths.analysisCurrentRunPath, analysisRunId);

      let embeddingsReady = 0;
      let embeddingsGenerated = 0;
      let embeddingsReused = 0;
      let failedOpinions = 0;
      let processedOpinions = 0;
      let reductionsReady = 0;
      let reductionsUnavailable = 0;
      let reductionsFailed = 0;
      let clusterArtifactsWritten = 0;
      let clusterArtifactsFailed = 0;
      let labelArtifactsFailed = 0;
      let hierarchyArtifactsWritten = 0;
      let hierarchyArtifactsFailed = 0;
      let perspectiveArtifactsWritten = 0;
      let reductionsGenerated = 0;
      let reductionsReused = 0;
      let clustersGenerated = 0;
      let clustersReused = 0;
      let labelsGenerated = 0;
      let labelsReused = 0;
      let perspectivesGenerated = 0;
      let perspectivesReused = 0;

      process.stdout.write(renderAnalysisIntro({
        projectRoot,
        projectConfigPath: projectPaths.configPath,
        autoResumed,
        analysisRunId,
        latestOpinionRunId: latestOpinionRun.runId,
        extractionModel,
        embeddingModel,
        analysisModel,
        opinionsSelected: reviewTotals.selectedOpinionCount,
        reviewConfig,
        reviewTotals,
        offset,
        ...(options.limit === undefined ? {} : { limit: options.limit })
      }));

      const checkpointEmbeddingsManifest = async (): Promise<void> => {
        for (const group of analysisGroups) {
          const manifest: EmbeddingRunManifest = {
            createdAt,
            updatedAt: new Date().toISOString(),
            opinionRunId: group.opinionRunId,
            embeddingModel: group.embeddingModel,
            input: {
              opinionsDir: group.opinionsDir,
              opinionsSelected: group.selectedOpinionPaths.length,
              ...(offset > 0 ? { offset } : {}),
              ...(options.limit === undefined ? {} : { limit: options.limit })
            },
            output: {
              embeddingsDir: group.embeddingsDir,
              manifestPath: group.embeddingsManifestPath,
              embeddingsReady,
              embeddingsGenerated,
              embeddingsReused,
              failedOpinions
            }
          };

          await mkdir(group.embeddingsDir, { recursive: true });
          await writeJsonFile(group.embeddingsManifestPath, manifest);
        }
      };

      const checkpointAnalysisManifest = async (
        status: AnalysisRunManifest["status"]
      ): Promise<void> => {
        const manifest: AnalysisRunManifest = {
          runId: analysisRunId,
          createdAt,
          updatedAt: new Date().toISOString(),
          status,
          fingerprint,
          input: {
            opinionRunId: latestOpinionRun.runId,
            opinionRunDir: firstGroup.opinionsRunDir,
            opinionsDir: firstGroup.opinionsDir,
            opinionsSelected: reviewTotals.selectedOpinionCount,
            review: {
              configPath: projectPaths.reviewConfigPath,
              configSha256: reviewConfigSha256,
              includeCommentStatuses: [...reviewConfig.analysis.includeCommentStatuses],
              includeOpinionStatuses: [...reviewConfig.analysis.includeOpinionStatuses],
              totalOpinionsAvailable: reviewTotals.totalOpinionCount,
              selectedOpinions: reviewTotals.selectedOpinionCount,
              excludedOpinions: reviewTotals.excludedOpinionCount,
              excludedByStatus: reviewTotals.excludedByStatus
            },
            ...(offset > 0 ? { offset } : {}),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            extractionModel,
            embeddingModel,
            analysisModel,
            prompts: {
              clusterLabeling: {
                path: resolvedViews[0]?.prompts.clusterLabeling.path ?? "",
                sha256: resolvedViews[0]?.prompts.clusterLabeling.sha256 ?? ""
              },
              perspectiveSummary: {
                path: resolvedViews[0]?.prompts.perspectiveSummary.path ?? "",
                sha256: resolvedViews[0]?.prompts.perspectiveSummary.sha256 ?? ""
              },
              semanticMerge: {
                path: resolvedViews[0]?.prompts.semanticMerge.path ?? "",
                sha256: resolvedViews[0]?.prompts.semanticMerge.sha256 ?? ""
              }
            },
            reductionMethods: uniqueList(analysisViews.map((view) => view.reduction.method)),
            clusterCounts: uniqueNumberList(analysisViews.map((view) => view.clustering.count)),
            mergeStrategy: uniqueList(
              analysisViews.map((view) => view.clustering.mergeStrategy)
            ).join(","),
            synthesisModes: analysisViews.map((view) => view.name),
            views: analysisViews.map((view) => ({
              name: view.name,
              ...(view.title === undefined ? {} : { title: view.title }),
              mode: view.mode,
              reductionMethod: view.reduction.method,
              clusterCount: view.clustering.count,
              sourceExtraction: view.sourceExtraction,
              analysisModel:
                resolvedViews.find((item) => item.view.name === view.name)?.analysisModel.name ?? "unknown"
            })),
            groups: analysisGroups.map((group) => ({
              sourceExtraction: group.sourceExtraction.name,
              opinionRunId: group.opinionRunId,
              opinionRunDir: group.opinionsRunDir,
              opinionsDir: group.opinionsDir,
              opinionsSelected: group.selectedOpinionPaths.length,
              review: {
              totalOpinionsAvailable: group.review.totalOpinionCount,
              selectedOpinions: group.review.selectedOpinionCount,
              excludedOpinions: group.review.excludedOpinionCount,
              excludedByStatus: extractExcludedReviewStatusCounts(
                group.review.effectiveStatusCounts
              )
            },
              extractionModel: group.extractionModel,
              embeddingModel: group.embeddingModel,
              embeddingsDir: group.embeddingsDir,
              viewNames: group.views.map((view) => view.view.name)
            }))
          },
          output: {
            embeddingsDir,
            reductionsDir,
            clustersDir,
            hierarchiesDir,
            perspectivesDir,
            embeddingsReady,
            embeddingsGenerated,
            embeddingsReused,
            failedOpinions,
            reductionsReady,
            reductionsUnavailable,
            reductionsFailed,
            clusterArtifactsWritten,
            clusterArtifactsFailed,
            labelArtifactsFailed,
            hierarchyArtifactsWritten,
            hierarchyArtifactsFailed,
            perspectiveArtifactsWritten
          }
        };

        await writeJsonFile(analysisManifestPath, manifest);
      };

      await checkpointEmbeddingsManifest();
      await checkpointAnalysisManifest("running");

      process.stdout.write(color.section("Embeddings") + "\n");
      const totalSelectedOpinionCount = analysisGroups.reduce(
        (sum, group) => sum + group.selectedOpinionPaths.length,
        0
      );
      const progress = createEmbeddingProgressReporter(totalSelectedOpinionCount);
      const successfulEmbeddingsByGroup = new Map<string, Array<{
        opinion: OpinionArtifact;
        embedding: EmbeddingArtifact;
        embeddingPath: string;
      }>>();

      for (const group of analysisGroups) {
        const successfulEmbeddings: Array<{
          opinion: OpinionArtifact;
          embedding: EmbeddingArtifact;
          embeddingPath: string;
        }> = [];

        for (const opinionPath of group.selectedOpinionPaths) {
          const opinion = await readJsonFile<OpinionArtifact>(opinionPath);

          if (
            opinion === null ||
            typeof opinion.opinionId !== "string" ||
            typeof opinion.opinionText !== "string" ||
            typeof opinion.sourceId !== "string" ||
            typeof opinion.sourceContentSha256 !== "string"
          ) {
            failedOpinions += 1;
            processedOpinions += 1;
            progress.tick({
              processedOpinions,
              embeddingsGenerated,
              embeddingsReused,
              failedOpinions
            });

            if (processedOpinions % 10 === 0 || processedOpinions === totalSelectedOpinionCount) {
              await checkpointEmbeddingsManifest();
              await checkpointAnalysisManifest("running");
            }

            process.stdout.write(
              `${formatDetailLine(
                "Skipped",
                `Invalid opinion artifact ${toPortableRelativePath(projectRoot, opinionPath)}`
              )}\n`
            );
            continue;
          }

          const embeddingPath = path.join(group.embeddingsDir, `${opinion.opinionId}.json`);
          const existingEmbedding = await readJsonFile<EmbeddingArtifact>(embeddingPath);

          if (
            existingEmbedding !== null &&
            isUsableEmbeddingArtifact(existingEmbedding, opinion, group.embeddingModel)
          ) {
            embeddingsReady += 1;
            embeddingsReused += 1;
            processedOpinions += 1;
            successfulEmbeddings.push({
              opinion,
              embedding: existingEmbedding,
              embeddingPath
            });
            progress.tick({
              processedOpinions,
              embeddingsGenerated,
              embeddingsReused,
              failedOpinions
            });

            if (processedOpinions % 10 === 0 || processedOpinions === totalSelectedOpinionCount) {
              await checkpointEmbeddingsManifest();
              await checkpointAnalysisManifest("running");
            }

            continue;
          }

          try {
            const vector = await runEmbeddingWithModel({
              model: group.embeddingModel,
              input: opinion.opinionText,
              projectRoot
            });
            const artifact: EmbeddingArtifact = {
              createdAt: new Date().toISOString(),
              opinionId: opinion.opinionId,
              sourceId: opinion.sourceId,
              sourceContentSha256: opinion.sourceContentSha256,
              opinionTextSha256: sha256Hex(opinion.opinionText),
              model: group.embeddingModel,
              dimensions: vector.length,
              vector,
              provenance: {
                opinionArtifactPath: opinionPath,
                opinionRunId: group.opinionRunId,
                ...(opinion.provenance?.normalizedRecordPath === undefined
                  ? {}
                  : { normalizedRecordPath: opinion.provenance.normalizedRecordPath }),
                ...(opinion.provenance?.sourceImportPath === undefined
                  ? {}
                  : { sourceImportPath: opinion.provenance.sourceImportPath }),
                ...(opinion.provenance?.sourceFileSha256 === undefined
                  ? {}
                  : { sourceFileSha256: opinion.provenance.sourceFileSha256 }),
                ...(opinion.provenance?.sourceRowNumber === undefined
                  ? {}
                  : { sourceRowNumber: opinion.provenance.sourceRowNumber }),
                ...(opinion.provenance?.externalId === undefined
                  ? {}
                  : { externalId: opinion.provenance.externalId })
              }
            };

            await writeJsonFile(embeddingPath, artifact);
            embeddingsReady += 1;
            embeddingsGenerated += 1;
            successfulEmbeddings.push({
              opinion,
              embedding: artifact,
              embeddingPath
            });
          } catch {
            failedOpinions += 1;
          }

          processedOpinions += 1;
          progress.tick({
            processedOpinions,
            embeddingsGenerated,
            embeddingsReused,
            failedOpinions
          });

          if (processedOpinions % 10 === 0 || processedOpinions === totalSelectedOpinionCount) {
            await checkpointEmbeddingsManifest();
            await checkpointAnalysisManifest("running");
          }
        }

        successfulEmbeddingsByGroup.set(group.key, successfulEmbeddings);
      }

      progress.finish();
      await checkpointEmbeddingsManifest();
      process.stdout.write(
        `${formatDetailLine("Summary", `${embeddingsReady} ready · ${embeddingsGenerated} generated · ${embeddingsReused} reused · ${failedOpinions} failed`)}\n\n`
      );
      const opinionArtifactById = new Map<string, OpinionArtifact>();

      for (const groupEmbeddings of successfulEmbeddingsByGroup.values()) {
        for (const item of groupEmbeddings) {
          opinionArtifactById.set(item.opinion.opinionId, item.opinion);
        }
      }

      process.stdout.write(color.section("Reductions") + "\n");
      const reductionArtifacts: Array<{
        groupKey: string;
        method: string;
        path: string;
        artifact: ReductionArtifact;
      }> = [];

      for (const group of analysisGroups) {
        const successfulEmbeddings = successfulEmbeddingsByGroup.get(group.key) ?? [];
        const reductionMethods = uniqueList(group.views.map((view) => view.view.reduction.method));

        for (const method of reductionMethods) {
          const artifactPath = path.join(reductionsDir, `${group.sourceExtraction.name}--${group.embeddingModel.name}--${method}.json`);
          const existingArtifact = await readJsonFile<ReductionArtifact>(artifactPath);
          const reusedExistingArtifact =
            existingArtifact !== null && existingArtifact.method === method;
          const artifact =
            existingArtifact !== null && existingArtifact.method === method
              ? existingArtifact
              : await buildReductionArtifact(method, successfulEmbeddings, `${analysisRunId}:${group.key}`);

          if (reusedExistingArtifact) {
            reductionsReused += 1;
          } else {
            reductionsGenerated += 1;
            await writeJsonFile(artifactPath, artifact);
          }
          reductionArtifacts.push({ groupKey: group.key, method, path: artifactPath, artifact });

          if (artifact.status === "ready") {
            reductionsReady += 1;
          } else if (artifact.status === "unavailable") {
            reductionsUnavailable += 1;
          } else {
            reductionsFailed += 1;
          }

          process.stdout.write(
            `${formatDetailLine(`${group.sourceExtraction.name}/${group.embeddingModel.name}/${method}`, `${reductionStatusLabel(artifact)} · ${reusedExistingArtifact ? "reused" : "generated"}`)}\n`
          );
        }
      }

      process.stdout.write("\n");

      await checkpointAnalysisManifest("running");

      process.stdout.write(color.section("Clusters") + "\n");
      const clusterArtifactEntries: Array<{
        groupKey: string;
        view: AnalysisViewConfig;
        resolvedView: ResolvedAnalysisView;
        path: string;
        artifact: ClusterArtifact;
      }> = [];

      for (const resolvedView of resolvedViews) {
        const group = analysisGroups.find(
          (item) =>
            item.sourceExtraction.name === resolvedView.view.sourceExtraction &&
            item.embeddingModel.name === resolvedView.view.embeddingModel
        );
        if (group === undefined) {
          continue;
        }
        const reduction = reductionArtifacts.find(
          (item) =>
            item.groupKey === group.key && item.method === resolvedView.view.reduction.method
        );

        if (reduction === undefined || reduction.artifact.status !== "ready") {
          continue;
        }

        const clusterArtifactPath = path.join(clustersDir, `${resolvedView.view.name}.json`);
        const existingArtifact = await readJsonFile<ClusterArtifact>(clusterArtifactPath);
        const reusedExistingCluster =
          existingArtifact !== null &&
          existingArtifact.method === reduction.method &&
          existingArtifact.requestedClusterCount === resolvedView.view.clustering.count;
        const clusterArtifact =
          existingArtifact !== null &&
          existingArtifact.method === reduction.method &&
          existingArtifact.requestedClusterCount === resolvedView.view.clustering.count
            ? existingArtifact
            : buildClusterArtifact(
                reduction.artifact,
                reduction.path,
                resolvedView.view.clustering.count,
                analysisRunId,
                opinionArtifactById
              );

        if (reusedExistingCluster) {
          clustersReused += 1;
        } else {
          clustersGenerated += 1;
          await writeJsonFile(clusterArtifactPath, clusterArtifact);
        }

        clusterArtifactEntries.push({
          groupKey: group.key,
          view: resolvedView.view,
          resolvedView,
          path: clusterArtifactPath,
          artifact: clusterArtifact
        });

        if (clusterArtifact.status === "ready") {
          clusterArtifactsWritten += 1;
        } else {
          clusterArtifactsFailed += 1;
        }

        process.stdout.write(
          `${formatDetailLine(`${resolvedView.view.name}`, `${clusterArtifact.status === "ready" ? `${clusterArtifact.clusters.length} clusters` : clusterArtifact.message ?? clusterArtifact.status} · ${reusedExistingCluster ? "reused" : "generated"}`)}\n`
        );
      }

      process.stdout.write("\n");
      await checkpointAnalysisManifest("running");

      process.stdout.write(color.section("Labeling") + "\n");
      const labeledClusterArtifacts: Array<{ view: AnalysisViewConfig; resolvedView: typeof resolvedViews[number]; path: string; artifact: ClusterArtifact }> = [];
      const readyClusterArtifactCount = clusterArtifactEntries.filter(
        (item) => item.artifact.status === "ready"
      ).length;
      const labelingProgress = createStageProgressReporter("clusters", readyClusterArtifactCount);
      let labeledClusterArtifactsProcessed = 0;
      let labeledClusterArtifactsFailed = 0;

      for (const clusterArtifactEntry of clusterArtifactEntries) {
        const existingArtifact = clusterArtifactEntry.artifact;

        if (existingArtifact.status !== "ready") {
          continue;
        }

        const labeledArtifact =
          existingArtifact.labeling.method === "llm-cluster-labeling"
            ? existingArtifact
            : await labelClusterArtifactWithLlm({
                artifact: existingArtifact,
                artifactPath: clusterArtifactEntry.path,
                analysisModel: clusterArtifactEntry.resolvedView.analysisModel,
                projectRoot,
                promptPath: clusterArtifactEntry.resolvedView.prompts.clusterLabeling.path,
                promptSha256: clusterArtifactEntry.resolvedView.prompts.clusterLabeling.sha256,
                promptTemplate: clusterArtifactEntry.resolvedView.prompts.clusterLabeling.template
              });

        const reusedExistingLabel = labeledArtifact === existingArtifact;
        if (reusedExistingLabel) {
          labelsReused += 1;
        } else {
          labelsGenerated += 1;
          await writeJsonFile(clusterArtifactEntry.path, labeledArtifact);
        }
        if (labeledArtifact.labeling.method === "llm-cluster-labeling") {
          labeledClusterArtifacts.push({
            view: clusterArtifactEntry.view,
            resolvedView: clusterArtifactEntry.resolvedView,
            path: clusterArtifactEntry.path,
            artifact: labeledArtifact
          });
        } else {
          labeledClusterArtifactsFailed += 1;
          labelArtifactsFailed += 1;
        }
        labeledClusterArtifactsProcessed += 1;
        labelingProgress.tick({
          processed: labeledClusterArtifactsProcessed,
          generated: labelsGenerated,
          reused: labelsReused,
          failed: labeledClusterArtifactsFailed
        });
      }

      labelingProgress.finish();
      process.stdout.write(
        `${formatDetailLine("Summary", `${labeledClusterArtifacts.length} ready · ${labelsGenerated} generated · ${labelsReused} reused${labeledClusterArtifactsFailed === 0 ? "" : ` · ${labeledClusterArtifactsFailed} failed`}`)}\n`
      );
      process.stdout.write("\n");
      await checkpointAnalysisManifest("running");

      process.stdout.write(color.section("Hierarchy") + "\n");
      process.stdout.write(
        `${formatDetailLine("Merge strategy", uniqueList(analysisViews.map((view) => view.clustering.mergeStrategy)).join(", "))}\n`
      );
      const hierarchyProgress = createStageProgressReporter(
        "views",
        labeledClusterArtifacts.length
      );
      let hierarchyArtifactsProcessed = 0;
      for (const { view, resolvedView, path: clusterArtifactPath, artifact } of labeledClusterArtifacts) {
        const hierarchyArtifact = await buildSemanticHierarchyArtifact({
          artifact,
          artifactPath: clusterArtifactPath,
          analysisModel: resolvedView.analysisModel,
          projectRoot,
          promptPath: resolvedView.prompts.semanticMerge.path,
          promptSha256: resolvedView.prompts.semanticMerge.sha256,
          promptTemplate: resolvedView.prompts.semanticMerge.template
        });
        const hierarchyPath = path.join(hierarchiesDir, `${view.name}.json`);
        await writeJsonFile(hierarchyPath, hierarchyArtifact);
        hierarchyArtifactsWritten += 1;
        if (hierarchyArtifact.status === "failed") {
          hierarchyArtifactsFailed += 1;
        }
        hierarchyArtifactsProcessed += 1;
        hierarchyProgress.tick({
          processed: hierarchyArtifactsProcessed,
          generated: hierarchyArtifactsWritten,
          reused: 0,
          failed: hierarchyArtifactsFailed
        });
      }

      hierarchyProgress.finish();
      if (hierarchyArtifactsWritten === 0) {
        process.stdout.write(`${formatDetailLine("Status", "No compatible multi-level cluster hierarchy to write.")}\n`);
      } else {
        process.stdout.write(
          `${formatDetailLine("Summary", `${hierarchyArtifactsProcessed} semantic merge map(s) written`)}\n`
        );
      }
      process.stdout.write("\n");

      await checkpointAnalysisManifest("running");

      process.stdout.write(color.section("Views") + "\n");
      for (const resolvedView of resolvedViews) {
        const view = resolvedView.view;
        const perspectivePath = path.join(perspectivesDir, `${view.name}.json`);
        const existingPerspective = await readJsonFile<PerspectivePlanArtifact>(perspectivePath);
        const reusedExistingPerspective =
          existingPerspective !== null &&
          existingPerspective.status === "ready" &&
          existingPerspective.synthesis.method === "llm-perspective-summary" &&
          existingPerspective.viewName === view.name;
        const perspectiveArtifact =
          existingPerspective !== null &&
          existingPerspective.status === "ready" &&
          existingPerspective.synthesis.method === "llm-perspective-summary" &&
          existingPerspective.viewName === view.name
            ? existingPerspective
            : await buildPerspectivePlanArtifact(
                view,
                clusterArtifactEntries
                  .filter((entry) => entry.view.name === view.name)
                  .map((entry) => entry.path),
                {
                  analysisModel: resolvedView.analysisModel,
                  projectRoot,
                  promptPath: resolvedView.prompts.perspectiveSummary.path,
                  promptSha256: resolvedView.prompts.perspectiveSummary.sha256,
                  promptTemplate: resolvedView.prompts.perspectiveSummary.template,
                  guidingQuestions: config.questions
                }
              );
        if (reusedExistingPerspective) {
          perspectivesReused += 1;
        } else {
          perspectivesGenerated += 1;
          await writeJsonFile(perspectivePath, perspectiveArtifact);
        }
        perspectiveArtifactsWritten += 1;
        process.stdout.write(
          `${formatDetailLine(view.name, `${perspectiveArtifact.summary === undefined ? perspectiveArtifact.status : perspectiveArtifact.title ?? "ready"} · ${reusedExistingPerspective ? "reused" : "generated"}`)}\n`
        );
      }

      const finalStatus =
        failedOpinions > 0 ||
        reductionsFailed > 0 ||
        clusterArtifactsFailed > 0 ||
        labelArtifactsFailed > 0 ||
        hierarchyArtifactsFailed > 0
          ? "completed-with-failures"
          : "completed";

      await checkpointAnalysisManifest(finalStatus);

      const reductionSummary = reductionArtifacts
        .map((reduction) =>
          reduction.artifact.status === "ready"
            ? `${reduction.method}: ready`
            : `${reduction.method}: ${reduction.artifact.status}${reduction.artifact.message === undefined ? "" : ` (${reduction.artifact.message})`}`
        )
        .join("; ");

      const lines = [
        color.heading("Broadly Analysis"),
        color.muted(rule("=")),
        formatDetailLine("Project", projectRoot),
        formatDetailLine("Run", analysisRunId),
        formatDetailLine("Opinion Run", latestOpinionRun.runId),
        formatDetailLine("Embedding", `${embeddingModel.name} (${embeddingModel.provider} · ${embeddingModel.region} · ${embeddingModel.modelId})`),
        formatDetailLine("Analysis", `${analysisModel.name} (${analysisModel.provider} · ${analysisModel.region} · ${analysisModel.modelId})`),
        formatDetailLine("Selection", `${reviewTotals.selectedOpinionCount} opinions${offset > 0 ? ` · offset ${offset}` : ""}${options.limit === undefined ? "" : ` · limit ${options.limit}`}`),
        formatDetailLine(
          "Review",
          `comments=${formatIncludedReviewStatuses(reviewConfig.analysis.includeCommentStatuses)} · opinions=${formatIncludedReviewStatuses(reviewConfig.analysis.includeOpinionStatuses)}`
        ),
        formatDetailLine(
          "Filtered",
          `${reviewTotals.excludedOpinionCount} excluded of ${reviewTotals.totalOpinionCount} total · ${formatExcludedReviewStatusCounts(reviewTotals.excludedByStatus)}`
        ),
        formatDetailLine("Resume", autoResumed ? "Compatible existing run reused" : "Fresh analysis run"),
        formatDetailLine("Embeddings", `${embeddingsReady} ready · ${embeddingsGenerated} generated · ${embeddingsReused} reused · ${failedOpinions} failed`),
        formatDetailLine("Reductions", reductionSummary === "" ? "none" : `${reductionSummary} · ${reductionsGenerated} generated · ${reductionsReused} reused`),
        formatDetailLine("Clusters", `${clusterArtifactsWritten} total · ${clustersGenerated} generated · ${clustersReused} reused${clusterArtifactsFailed === 0 ? "" : ` · ${clusterArtifactsFailed} failed`}`),
        formatDetailLine("Labels", `${labelsGenerated} generated · ${labelsReused} reused${labelArtifactsFailed === 0 ? "" : ` · ${labelArtifactsFailed} failed`}`),
        formatDetailLine("Hierarchies", `${hierarchyArtifactsWritten} total${hierarchyArtifactsFailed === 0 ? "" : ` · ${hierarchyArtifactsFailed} failed`}`),
        formatDetailLine("Perspectives", `${perspectiveArtifactsWritten} total · ${perspectivesGenerated} generated · ${perspectivesReused} reused`),
        formatDetailLine("Manifest", toPortableRelativePath(projectRoot, analysisManifestPath))
      ];

      process.stdout.write(`\n${lines.join("\n")}\n`);
    }
  });
}

const DEFAULT_REDUCER_EVALUATION_NEIGHBOR_K = 10;
const REDUCER_EVALUATION_SILHOUETTE_MAX_POINTS = 1500;
const GRAPH_REMAINDER_CLUSTER_SHARE_THRESHOLD = 0.4;

async function evaluateAnalysisReducers(options: AnalysisCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const neighborK = options.neighborK ?? DEFAULT_REDUCER_EVALUATION_NEIGHBOR_K;

  await withProjectActionLog({
    projectRoot,
    command: "analysis evaluate-reducers",
    details: {
      run: options.run ?? "(current/latest)",
      neighborK
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const resolvedRun = await resolveReducerEvaluationRun(projectPaths, options.run);
      const manifestPath = path.join(resolvedRun.runDir, "manifest.json");
      const manifest = await readJsonFile<AnalysisRunManifest>(manifestPath);

      if (manifest === null) {
        throw new Error(`Analysis run '${resolvedRun.runId}' does not have a readable manifest.`);
      }

      const reductionsDir = manifest.output.reductionsDir || path.join(resolvedRun.runDir, "reductions");
      const clustersDir = manifest.output.clustersDir || path.join(resolvedRun.runDir, "clusters");
      const embeddingsDirs = resolveReducerEvaluationEmbeddingDirs(manifest);
      const embeddingsById = await loadReducerEvaluationEmbeddings(embeddingsDirs);
      const reductions = await loadReducerEvaluationReductions(reductionsDir);
      const clusters = await loadReducerEvaluationClusters(clustersDir);
      const reductionSummaries = reductions.map((entry) =>
        evaluateReductionArtifact(entry, embeddingsById, neighborK)
      );
      const clusterSummaries = clusters.map((entry) =>
        evaluateClusterArtifact(entry, embeddingsById, neighborK)
      );
      const clusterAgreement = evaluateClusterAgreement(clusters);
      const comparableOpinionIds = new Set<string>();

      for (const reduction of reductions) {
        if (reduction.artifact.status !== "ready") {
          continue;
        }

        for (const point of reduction.artifact.points) {
          if (embeddingsById.has(point.opinionId)) {
            comparableOpinionIds.add(point.opinionId);
          }
        }
      }

      const summary: ReducerEvaluationArtifact = {
        createdAt: new Date().toISOString(),
        runId: resolvedRun.runId,
        method: "reducer-evaluation-v1",
        parameters: {
          neighborK,
          silhouetteMaxPoints: REDUCER_EVALUATION_SILHOUETTE_MAX_POINTS
        },
        source: {
          manifestPath,
          embeddingsDirs,
          reductionsDir,
          clustersDir
        },
        corpus: {
          embeddingCount: embeddingsById.size,
          reductionCount: reductions.length,
          readyReductionCount: reductions.filter((entry) => entry.artifact.status === "ready").length,
          clusterArtifactCount: clusters.length,
          comparableOpinionCount: comparableOpinionIds.size
        },
        reductions: reductionSummaries,
        clusters: clusterSummaries,
        clusterAgreement,
        observations: []
      };

      summary.observations = buildReducerEvaluationObservations(summary);

      const outputPath = path.join(resolvedRun.runDir, "reducer-eval", "summary.json");
      await writeJsonFile(outputPath, summary);

      process.stdout.write(renderReducerEvaluationConsoleSummary(projectRoot, outputPath, summary));
    }
  });
}

async function resolveReducerEvaluationRun(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  explicitRunId: string | undefined
): Promise<{ runId: string; runDir: string }> {
  if (explicitRunId !== undefined) {
    const explicitRunDir = path.join(projectPaths.runsDir, explicitRunId);
    const manifest = await readJsonFile<AnalysisRunManifest>(path.join(explicitRunDir, "manifest.json"));

    if (manifest === null) {
      throw new Error(`Analysis run '${explicitRunId}' was not found or has no manifest.`);
    }

    return {
      runId: explicitRunId,
      runDir: explicitRunDir
    };
  }

  const currentRunId = await readCurrentRunId(projectPaths.analysisCurrentRunPath);

  if (currentRunId !== null) {
    const currentRunDir = path.join(projectPaths.runsDir, currentRunId);
    const manifest = await readJsonFile<AnalysisRunManifest>(path.join(currentRunDir, "manifest.json"));

    if (manifest !== null) {
      return {
        runId: currentRunId,
        runDir: currentRunDir
      };
    }
  }

  const entries = await readdir(projectPaths.runsDir, { withFileTypes: true }).catch(() => []);
  const runs: Array<{ runId: string; runDir: string; createdAt: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runDir = path.join(projectPaths.runsDir, entry.name);
    const manifest = await readJsonFile<{ createdAt?: string }>(path.join(runDir, "manifest.json"));

    if (manifest?.createdAt !== undefined) {
      runs.push({
        runId: entry.name,
        runDir,
        createdAt: manifest.createdAt
      });
    }
  }

  runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const latest = runs[0];

  if (latest === undefined) {
    throw new Error("No analysis runs were found. Run broadly analysis first.");
  }

  return {
    runId: latest.runId,
    runDir: latest.runDir
  };
}

function resolveReducerEvaluationEmbeddingDirs(manifest: AnalysisRunManifest): string[] {
  const groupDirs = (manifest.input.groups ?? [])
    .map((group) => group.embeddingsDir)
    .filter((value) => value.trim().length > 0);
  const dirs = groupDirs.length === 0 ? [manifest.output.embeddingsDir] : groupDirs;
  return uniqueList(dirs.filter((value) => value.trim().length > 0));
}

async function loadReducerEvaluationEmbeddings(
  embeddingsDirs: string[]
): Promise<Map<string, EmbeddingArtifact>> {
  const embeddingsById = new Map<string, EmbeddingArtifact>();

  for (const embeddingsDir of embeddingsDirs) {
    const entries = await readdir(embeddingsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "manifest.json") {
        continue;
      }

      const artifact = await readJsonFile<EmbeddingArtifact>(path.join(embeddingsDir, entry.name));

      if (isReducerEvaluationEmbeddingArtifact(artifact)) {
        embeddingsById.set(artifact.opinionId, artifact);
      }
    }
  }

  return embeddingsById;
}

function isReducerEvaluationEmbeddingArtifact(
  artifact: EmbeddingArtifact | null
): artifact is EmbeddingArtifact {
  return (
    artifact !== null &&
    typeof artifact.opinionId === "string" &&
    artifact.opinionId.length > 0 &&
    Array.isArray(artifact.vector) &&
    artifact.vector.length > 0 &&
    artifact.vector.every((value) => Number.isFinite(value))
  );
}

async function loadReducerEvaluationReductions(
  reductionsDir: string
): Promise<Array<{ artifactPath: string; artifact: ReductionArtifact }>> {
  const entries = await readdir(reductionsDir, { withFileTypes: true }).catch(() => []);
  const reductions: Array<{ artifactPath: string; artifact: ReductionArtifact }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const artifactPath = path.join(reductionsDir, entry.name);
    const artifact = await readJsonFile<ReductionArtifact>(artifactPath);

    if (artifact !== null && typeof artifact.method === "string") {
      reductions.push({ artifactPath, artifact });
    }
  }

  return reductions.sort((left, right) => left.artifactPath.localeCompare(right.artifactPath));
}

async function loadReducerEvaluationClusters(
  clustersDir: string
): Promise<Array<{ viewName: string; artifactPath: string; artifact: ClusterArtifact }>> {
  const entries = await readdir(clustersDir, { withFileTypes: true }).catch(() => []);
  const clusters: Array<{ viewName: string; artifactPath: string; artifact: ClusterArtifact }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const artifactPath = path.join(clustersDir, entry.name);
    const artifact = await readJsonFile<ClusterArtifact>(artifactPath);

    if (artifact !== null && typeof artifact.method === "string") {
      clusters.push({
        viewName: path.basename(entry.name, ".json"),
        artifactPath,
        artifact
      });
    }
  }

  return clusters.sort((left, right) => left.viewName.localeCompare(right.viewName));
}

function evaluateReductionArtifact(
  entry: { artifactPath: string; artifact: ReductionArtifact },
  embeddingsById: Map<string, EmbeddingArtifact>,
  neighborK: number
): ReductionEvaluationSummary {
  const points = entry.artifact.points ?? [];
  const comparableOpinionIds = sortedUnique(
    points
      .filter((point) => embeddingsById.has(point.opinionId))
      .map((point) => point.opinionId)
  );
  const effectiveK = Math.min(neighborK, Math.max(0, comparableOpinionIds.length - 1));
  const pointById = new Map(points.map((point) => [point.opinionId, point]));
  const neighborRecallAtK =
    entry.artifact.status !== "ready" || effectiveK === 0
      ? { k: effectiveK, mean: null, median: null }
      : calculateNeighborRecallAtK({
          baseNeighbors: buildEmbeddingNeighborIndex(comparableOpinionIds, embeddingsById, effectiveK),
          candidateNeighbors: buildProjectionNeighborIndex(comparableOpinionIds, pointById, effectiveK),
          k: effectiveK
        });

  return {
    method: entry.artifact.method,
    artifactPath: entry.artifactPath,
    status: entry.artifact.status,
    pointCount: points.length,
    comparableOpinionCount: comparableOpinionIds.length,
    neighborRecallAtK,
    projection: computeProjectionDiagnostics(points)
  };
}

function evaluateClusterArtifact(
  entry: { viewName: string; artifactPath: string; artifact: ClusterArtifact },
  embeddingsById: Map<string, EmbeddingArtifact>,
  neighborK: number
): ClusterEvaluationSummary {
  const members = (entry.artifact.members ?? []).filter(
    (member) =>
      typeof member.opinionId === "string" &&
      Number.isFinite(member.clusterId) &&
      Number.isFinite(member.x) &&
      Number.isFinite(member.y) &&
      embeddingsById.has(member.opinionId)
  );
  const comparableOpinionIds = sortedUnique(members.map((member) => member.opinionId));
  const effectiveK = Math.min(neighborK, Math.max(0, comparableOpinionIds.length - 1));
  const memberById = new Map(members.map((member) => [member.opinionId, member]));
  const clusterById = new Map(members.map((member) => [member.opinionId, member.clusterId]));
  const clusterSizes = new Map<number, number>();

  for (const member of members) {
    clusterSizes.set(member.clusterId, (clusterSizes.get(member.clusterId) ?? 0) + 1);
  }

  const largestClusterSize = Math.max(0, ...clusterSizes.values());
  const singletonClusterCount = [...clusterSizes.values()].filter((value) => value === 1).length;
  const embeddingNeighborIndex =
    effectiveK === 0
      ? new Map<string, string[]>()
      : buildEmbeddingNeighborIndex(comparableOpinionIds, embeddingsById, effectiveK);
  const projectionNeighborIndex =
    effectiveK === 0
      ? new Map<string, string[]>()
      : buildProjectionNeighborIndex(comparableOpinionIds, memberById, effectiveK);

  return {
    viewName: entry.viewName,
    method: entry.artifact.method,
    artifactPath: entry.artifactPath,
    status: entry.artifact.status,
    requestedClusterCount: entry.artifact.requestedClusterCount,
    effectiveClusterCount: entry.artifact.effectiveClusterCount,
    memberCount: entry.artifact.members.length,
    comparableOpinionCount: comparableOpinionIds.length,
    singletonClusterCount,
    largestClusterSize,
    largestClusterShare: roundMetric(safeRatio(largestClusterSize, Math.max(1, members.length))),
    embeddingNeighborPurityAtK: calculateNeighborPurityAtK(embeddingNeighborIndex, clusterById),
    projectionNeighborPurityAtK: calculateNeighborPurityAtK(projectionNeighborIndex, clusterById),
    projectionSilhouette: computeAverageSilhouette(
      comparableOpinionIds,
      clusterById,
      (leftId, rightId) => {
        const left = memberById.get(leftId);
        const right = memberById.get(rightId);

        if (left === undefined || right === undefined) {
          return Number.POSITIVE_INFINITY;
        }

        return Math.hypot(left.x - right.x, left.y - right.y);
      }
    ),
    embeddingSilhouette: computeAverageSilhouette(
      comparableOpinionIds,
      clusterById,
      (leftId, rightId) => {
        const left = embeddingsById.get(leftId);
        const right = embeddingsById.get(rightId);

        if (left === undefined || right === undefined) {
          return Number.POSITIVE_INFINITY;
        }

        return cosineDistance(left.vector, right.vector);
      }
    )
  };
}

function evaluateClusterAgreement(
  entries: Array<{ viewName: string; artifactPath: string; artifact: ClusterArtifact }>
): ClusterAgreementSummary[] {
  const comparisons: ClusterAgreementSummary[] = [];

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];

      if (left === undefined || right === undefined) {
        continue;
      }

      const leftLabels = new Map(left.artifact.members.map((member) => [member.opinionId, member.clusterId]));
      const rightLabels = new Map(right.artifact.members.map((member) => [member.opinionId, member.clusterId]));
      const commonIds = [...leftLabels.keys()].filter((opinionId) => rightLabels.has(opinionId));

      comparisons.push({
        leftViewName: left.viewName,
        rightViewName: right.viewName,
        leftMethod: left.artifact.method,
        rightMethod: right.artifact.method,
        comparableOpinionCount: commonIds.length,
        adjustedRandIndex: computeAdjustedRandIndex(commonIds, leftLabels, rightLabels)
      });
    }
  }

  return comparisons.sort(
    (left, right) =>
      (right.adjustedRandIndex ?? -1) - (left.adjustedRandIndex ?? -1) ||
      left.leftViewName.localeCompare(right.leftViewName) ||
      left.rightViewName.localeCompare(right.rightViewName)
  );
}

function calculateNeighborRecallAtK(options: {
  baseNeighbors: Map<string, string[]>;
  candidateNeighbors: Map<string, string[]>;
  k: number;
}): { k: number; mean: number | null; median: number | null } {
  const recalls: number[] = [];

  for (const [opinionId, baseNeighbors] of options.baseNeighbors.entries()) {
    const candidateNeighbors = options.candidateNeighbors.get(opinionId);

    if (candidateNeighbors === undefined || baseNeighbors.length === 0) {
      continue;
    }

    const candidateSet = new Set(candidateNeighbors);
    const overlap = baseNeighbors.filter((neighborId) => candidateSet.has(neighborId)).length;
    recalls.push(overlap / Math.min(options.k, baseNeighbors.length));
  }

  return {
    k: options.k,
    mean: roundNullable(mean(recalls)),
    median: roundNullable(median(recalls))
  };
}

function buildEmbeddingNeighborIndex(
  opinionIds: string[],
  embeddingsById: Map<string, EmbeddingArtifact>,
  neighborK: number
): Map<string, string[]> {
  return buildNeighborIndex(opinionIds, neighborK, (leftId, rightId) => {
    const left = embeddingsById.get(leftId);
    const right = embeddingsById.get(rightId);

    if (left === undefined || right === undefined) {
      return Number.POSITIVE_INFINITY;
    }

    return cosineDistance(left.vector, right.vector);
  });
}

function buildProjectionNeighborIndex(
  opinionIds: string[],
  pointById: Map<string, { x: number; y: number }>,
  neighborK: number
): Map<string, string[]> {
  return buildNeighborIndex(opinionIds, neighborK, (leftId, rightId) => {
    const left = pointById.get(leftId);
    const right = pointById.get(rightId);

    if (left === undefined || right === undefined) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.hypot(left.x - right.x, left.y - right.y);
  });
}

function buildNeighborIndex(
  opinionIds: string[],
  neighborK: number,
  distanceForPair: (leftId: string, rightId: string) => number
): Map<string, string[]> {
  const neighborsById = new Map<string, string[]>();

  for (const opinionId of opinionIds) {
    const neighbors = opinionIds
      .filter((candidateId) => candidateId !== opinionId)
      .map((candidateId) => ({
        opinionId: candidateId,
        distance: distanceForPair(opinionId, candidateId)
      }))
      .filter((candidate) => Number.isFinite(candidate.distance))
      .sort(
        (left, right) =>
          left.distance - right.distance || left.opinionId.localeCompare(right.opinionId)
      )
      .slice(0, neighborK)
      .map((candidate) => candidate.opinionId);

    neighborsById.set(opinionId, neighbors);
  }

  return neighborsById;
}

function computeProjectionDiagnostics(points: ReductionPoint[]): ProjectionDiagnostics {
  const finitePoints = points.filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
  );

  if (finitePoints.length === 0) {
    return {
      finiteCoordinateRate: 0,
      xRange: 0,
      yRange: 0,
      area: 0,
      duplicateCoordinateCount: 0,
      duplicateCoordinateRate: 0,
      maxDistanceFromCentroid: 0,
      outlierCount: 0,
      outlierRate: 0
    };
  }

  const xValues = finitePoints.map((point) => point.x);
  const yValues = finitePoints.map((point) => point.y);
  const xRange = Math.max(...xValues) - Math.min(...xValues);
  const yRange = Math.max(...yValues) - Math.min(...yValues);
  const centroid = [
    xValues.reduce((sum, value) => sum + value, 0) / xValues.length,
    yValues.reduce((sum, value) => sum + value, 0) / yValues.length
  ] as const;
  const distances = finitePoints
    .map((point) => Math.hypot(point.x - centroid[0], point.y - centroid[1]))
    .sort((left, right) => left - right);
  const q1 = quantile(distances, 0.25) ?? 0;
  const q3 = quantile(distances, 0.75) ?? 0;
  const outlierThreshold = q3 + 3 * Math.max(0, q3 - q1);
  const outlierCount = distances.filter((distance) => distance > outlierThreshold).length;
  const coordinateCounts = new Map<string, number>();

  for (const point of finitePoints) {
    const coordinateKey = `${point.x.toFixed(6)}:${point.y.toFixed(6)}`;
    coordinateCounts.set(coordinateKey, (coordinateCounts.get(coordinateKey) ?? 0) + 1);
  }

  const duplicateCoordinateCount = [...coordinateCounts.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count - 1, 0);

  return {
    finiteCoordinateRate: roundMetric(safeRatio(finitePoints.length, Math.max(1, points.length))),
    xRange: roundMetric(xRange),
    yRange: roundMetric(yRange),
    area: roundMetric(xRange * yRange),
    duplicateCoordinateCount,
    duplicateCoordinateRate: roundMetric(safeRatio(duplicateCoordinateCount, finitePoints.length)),
    maxDistanceFromCentroid: roundMetric(Math.max(...distances)),
    outlierCount,
    outlierRate: roundMetric(safeRatio(outlierCount, finitePoints.length))
  };
}

function calculateNeighborPurityAtK(
  neighborIndex: Map<string, string[]>,
  clusterById: Map<string, number>
): number | null {
  const purities: number[] = [];

  for (const [opinionId, neighbors] of neighborIndex.entries()) {
    const clusterId = clusterById.get(opinionId);

    if (clusterId === undefined || neighbors.length === 0) {
      continue;
    }

    const sameClusterCount = neighbors.filter((neighborId) => clusterById.get(neighborId) === clusterId).length;
    purities.push(sameClusterCount / neighbors.length);
  }

  return roundNullable(mean(purities));
}

function computeAverageSilhouette(
  opinionIds: string[],
  clusterById: Map<string, number>,
  distanceForPair: (leftId: string, rightId: string) => number
): number | null {
  if (
    opinionIds.length < 2 ||
    opinionIds.length > REDUCER_EVALUATION_SILHOUETTE_MAX_POINTS
  ) {
    return null;
  }

  const idsByCluster = new Map<number, string[]>();

  for (const opinionId of opinionIds) {
    const clusterId = clusterById.get(opinionId);

    if (clusterId === undefined) {
      continue;
    }

    const group = idsByCluster.get(clusterId) ?? [];
    group.push(opinionId);
    idsByCluster.set(clusterId, group);
  }

  if (idsByCluster.size < 2) {
    return null;
  }

  const silhouettes: number[] = [];

  for (const opinionId of opinionIds) {
    const clusterId = clusterById.get(opinionId);
    const sameClusterIds = clusterId === undefined ? undefined : idsByCluster.get(clusterId);

    if (clusterId === undefined || sameClusterIds === undefined) {
      continue;
    }

    const sameNeighborIds = sameClusterIds.filter((candidateId) => candidateId !== opinionId);
    const withinDistance = averageDistance(opinionId, sameNeighborIds, distanceForPair) ?? 0;
    let nearestOtherClusterDistance = Number.POSITIVE_INFINITY;

    for (const [otherClusterId, otherIds] of idsByCluster.entries()) {
      if (otherClusterId === clusterId) {
        continue;
      }

      const otherDistance = averageDistance(opinionId, otherIds, distanceForPair);

      if (otherDistance !== null) {
        nearestOtherClusterDistance = Math.min(nearestOtherClusterDistance, otherDistance);
      }
    }

    if (!Number.isFinite(nearestOtherClusterDistance)) {
      continue;
    }

    const denominator = Math.max(withinDistance, nearestOtherClusterDistance);
    silhouettes.push(
      denominator === 0 ? 0 : (nearestOtherClusterDistance - withinDistance) / denominator
    );
  }

  return roundNullable(mean(silhouettes));
}

function averageDistance(
  opinionId: string,
  otherIds: string[],
  distanceForPair: (leftId: string, rightId: string) => number
): number | null {
  const distances = otherIds
    .map((otherId) => distanceForPair(opinionId, otherId))
    .filter((distance) => Number.isFinite(distance));

  return mean(distances);
}

function computeAdjustedRandIndex(
  opinionIds: string[],
  leftLabels: Map<string, number>,
  rightLabels: Map<string, number>
): number | null {
  if (opinionIds.length < 2) {
    return null;
  }

  const contingency = new Map<string, number>();
  const leftCounts = new Map<number, number>();
  const rightCounts = new Map<number, number>();

  for (const opinionId of opinionIds) {
    const leftLabel = leftLabels.get(opinionId);
    const rightLabel = rightLabels.get(opinionId);

    if (leftLabel === undefined || rightLabel === undefined) {
      continue;
    }

    contingency.set(`${leftLabel}:${rightLabel}`, (contingency.get(`${leftLabel}:${rightLabel}`) ?? 0) + 1);
    leftCounts.set(leftLabel, (leftCounts.get(leftLabel) ?? 0) + 1);
    rightCounts.set(rightLabel, (rightCounts.get(rightLabel) ?? 0) + 1);
  }

  const comparableCount = [...leftCounts.values()].reduce((sum, value) => sum + value, 0);
  const totalPairs = chooseTwo(comparableCount);

  if (totalPairs === 0) {
    return null;
  }

  const contingencyPairs = [...contingency.values()].reduce(
    (sum, value) => sum + chooseTwo(value),
    0
  );
  const leftPairs = [...leftCounts.values()].reduce((sum, value) => sum + chooseTwo(value), 0);
  const rightPairs = [...rightCounts.values()].reduce((sum, value) => sum + chooseTwo(value), 0);
  const expectedPairs = (leftPairs * rightPairs) / totalPairs;
  const maxPairs = (leftPairs + rightPairs) / 2;
  const denominator = maxPairs - expectedPairs;

  if (denominator === 0) {
    return contingencyPairs === maxPairs ? 1 : 0;
  }

  return roundMetric((contingencyPairs - expectedPairs) / denominator);
}

function buildReducerEvaluationObservations(summary: ReducerEvaluationArtifact): string[] {
  const observations: string[] = [];
  const readyReductions = summary.reductions.filter(
    (item) => item.status === "ready" && item.neighborRecallAtK.mean !== null
  );
  const bestReduction = [...readyReductions].sort(
    (left, right) =>
      (right.neighborRecallAtK.mean ?? -1) - (left.neighborRecallAtK.mean ?? -1)
  )[0];
  const weakestReduction = [...readyReductions].sort(
    (left, right) =>
      (left.neighborRecallAtK.mean ?? 1) - (right.neighborRecallAtK.mean ?? 1)
  )[0];

  if (bestReduction !== undefined) {
    observations.push(
      `${bestReduction.method} had the strongest local-neighbor preservation among evaluated reductions at recall@${bestReduction.neighborRecallAtK.k}=${formatMetric(bestReduction.neighborRecallAtK.mean)}.`
    );
  }

  if (
    bestReduction !== undefined &&
    weakestReduction !== undefined &&
    bestReduction.method !== weakestReduction.method
  ) {
    observations.push(
      `${weakestReduction.method} was weakest on local-neighbor preservation at recall@${weakestReduction.neighborRecallAtK.k}=${formatMetric(weakestReduction.neighborRecallAtK.mean)}.`
    );
  }

  const collapsedReductions = summary.reductions.filter(
    (item) =>
      item.status === "ready" &&
      (item.projection.xRange === 0 ||
        item.projection.yRange === 0 ||
        item.projection.duplicateCoordinateRate > 0.05)
  );

  if (collapsedReductions.length > 0) {
    observations.push(
      `Potential projection collapse detected in ${collapsedReductions.map((item) => item.method).join(", ")}.`
    );
  }

  const outlierHeavyReductions = summary.reductions.filter(
    (item) => item.status === "ready" && item.projection.outlierRate > 0.05
  );

  if (outlierHeavyReductions.length > 0) {
    observations.push(
      `Projection outliers exceeded 5% in ${outlierHeavyReductions
        .map((item) => `${item.method} (${formatMetric(item.projection.outlierRate)})`)
        .join(", ")}.`
    );
  }

  const bestCluster = [...summary.clusters]
    .filter((item) => item.embeddingNeighborPurityAtK !== null)
    .sort(
      (left, right) =>
        (right.embeddingNeighborPurityAtK ?? -1) - (left.embeddingNeighborPurityAtK ?? -1)
    )[0];

  if (bestCluster !== undefined) {
    observations.push(
      `${bestCluster.viewName} had the strongest embedding-neighbor cluster purity at ${formatMetric(bestCluster.embeddingNeighborPurityAtK)}.`
    );
  }

  const lowAgreement = summary.clusterAgreement.filter(
    (item) => item.adjustedRandIndex !== null && item.adjustedRandIndex < 0.35
  );

  if (lowAgreement.length > 0) {
    observations.push(
      `${lowAgreement.length} cluster comparison(s) had low adjusted Rand agreement, which means reducer or cluster-count choices materially change group membership.`
    );
  }

  return observations;
}

function renderReducerEvaluationConsoleSummary(
  projectRoot: string,
  outputPath: string,
  summary: ReducerEvaluationArtifact
): string {
  const lines = [
    color.heading("Broadly Reducer Evaluation"),
    color.muted(rule("=")),
    formatDetailLine("Project", projectRoot),
    formatDetailLine("Run", summary.runId),
    formatDetailLine(
      "Corpus",
      `${summary.corpus.comparableOpinionCount} comparable opinions · ${summary.corpus.embeddingCount} embeddings`
    ),
    formatDetailLine(
      "Artifacts",
      `${summary.corpus.readyReductionCount}/${summary.corpus.reductionCount} ready reductions · ${summary.corpus.clusterArtifactCount} cluster artifacts`
    ),
    ...summary.reductions.map((reduction) =>
      formatDetailLine(
        reduction.method,
        reduction.status === "ready"
          ? `recall@${reduction.neighborRecallAtK.k} ${formatMetric(reduction.neighborRecallAtK.mean)} · ${reduction.comparableOpinionCount} comparable`
          : reduction.status
      )
    ),
    ...summary.clusters.map((cluster) =>
      formatDetailLine(
        cluster.viewName,
        `purity ${formatMetric(cluster.embeddingNeighborPurityAtK)} · silhouette ${formatMetric(cluster.embeddingSilhouette)} · largest ${formatMetric(cluster.largestClusterShare)}`
      )
    ),
    ...summary.observations.map((observation) => formatDetailLine("Note", observation)),
    formatDetailLine("Output", toPortableRelativePath(projectRoot, outputPath))
  ];

  return `\n${lines.join("\n")}\n`;
}

async function evaluateAnalysisClusteringSurfaces(
  options: AnalysisCommandOptions
): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const neighborK = options.neighborK ?? DEFAULT_REDUCER_EVALUATION_NEIGHBOR_K;

  await withProjectActionLog({
    projectRoot,
    command: "analysis evaluate-clustering-surfaces",
    details: {
      run: options.run ?? "(current/latest)",
      neighborK
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const resolvedRun = await resolveReducerEvaluationRun(projectPaths, options.run);
      const manifestPath = path.join(resolvedRun.runDir, "manifest.json");
      const manifest = await readJsonFile<AnalysisRunManifest>(manifestPath);

      if (manifest === null) {
        throw new Error(`Analysis run '${resolvedRun.runId}' does not have a readable manifest.`);
      }

      const reductionsDir = manifest.output.reductionsDir || path.join(resolvedRun.runDir, "reductions");
      const clustersDir = manifest.output.clustersDir || path.join(resolvedRun.runDir, "clusters");
      const embeddingsDirs = resolveReducerEvaluationEmbeddingDirs(manifest);
      const embeddingsById = await loadReducerEvaluationEmbeddings(embeddingsDirs);
      const clusterEntries = await loadReducerEvaluationClusters(clustersDir);
      const comparableOpinionIds = sortedUnique([...embeddingsById.keys()]);
      const clusterCounts = uniqueNumberList(
        clusterEntries
          .map((entry) => entry.artifact.requestedClusterCount)
          .filter((value) => Number.isFinite(value) && value > 0)
      );
      const embeddingSurfaces = clusterCounts.map((clusterCount) =>
        buildEmbeddingClusteringSurface({
          runId: resolvedRun.runId,
          clusterCount,
          opinionIds: comparableOpinionIds,
          embeddingsById,
          neighborK
        })
      );
      const projectionSurfaces = clusterEntries.map((entry) =>
        buildProjectionClusteringSurface(entry, embeddingsById, neighborK)
      );
      const surfaces = [...embeddingSurfaces, ...projectionSurfaces];
      const comparisons = compareClusteringSurfaces(surfaces);
      const surfaceOpinionIds = new Set<string>();

      for (const surface of surfaces) {
        for (const opinionId of surface.clusterById.keys()) {
          surfaceOpinionIds.add(opinionId);
        }
      }

      const summary: ClusteringSurfaceEvaluationArtifact = {
        createdAt: new Date().toISOString(),
        runId: resolvedRun.runId,
        method: "clustering-surface-evaluation-v1",
        parameters: {
          neighborK,
          silhouetteMaxPoints: REDUCER_EVALUATION_SILHOUETTE_MAX_POINTS
        },
        source: {
          manifestPath,
          embeddingsDirs,
          reductionsDir,
          clustersDir
        },
        corpus: {
          embeddingCount: embeddingsById.size,
          clusterArtifactCount: clusterEntries.length,
          embeddingSurfaceCount: embeddingSurfaces.length,
          projectionSurfaceCount: projectionSurfaces.length,
          comparableOpinionCount: surfaceOpinionIds.size
        },
        surfaces: surfaces.map((surface) => surface.summary),
        comparisons,
        observations: []
      };

      summary.observations = buildClusteringSurfaceObservations(summary);

      const outputPath = path.join(resolvedRun.runDir, "cluster-surface-eval", "summary.json");
      await writeJsonFile(outputPath, summary);

      process.stdout.write(renderClusteringSurfaceConsoleSummary(projectRoot, outputPath, summary));
    }
  });
}

function buildEmbeddingClusteringSurface(options: {
  runId: string;
  clusterCount: number;
  opinionIds: string[];
  embeddingsById: Map<string, EmbeddingArtifact>;
  neighborK: number;
}): ClusteringSurfaceWorkingSet {
  const usableOpinionIds = options.opinionIds.filter((opinionId) =>
    options.embeddingsById.has(opinionId)
  );
  const effectiveClusterCount = Math.max(
    1,
    Math.min(options.clusterCount, usableOpinionIds.length)
  );
  const clusterById = new Map<string, number>();

  if (usableOpinionIds.length === 1) {
    const onlyOpinionId = usableOpinionIds[0];

    if (onlyOpinionId !== undefined) {
      clusterById.set(onlyOpinionId, 0);
    }
  } else if (usableOpinionIds.length > 1) {
    const vectors = usableOpinionIds.map((opinionId) => options.embeddingsById.get(opinionId)?.vector ?? []);
    const result = kmeans(vectors, effectiveClusterCount, {
      seed: positiveIntegerSeed(`embedding-surface:${options.runId}:k${options.clusterCount}`),
      initialization: "kmeans++",
      maxIterations: 100
    });

    usableOpinionIds.forEach((opinionId, index) => {
      clusterById.set(opinionId, result.clusters[index] ?? 0);
    });
  }

  const surfaceId = `embedding-k${options.clusterCount}`;

  return {
    summary: summarizeClusteringSurface({
      surfaceId,
      surfaceKind: "embedding",
      label: `Embedding k=${options.clusterCount}`,
      method: "embedding-kmeans",
      status: usableOpinionIds.length === 0 ? "failed" : "ready",
      requestedClusterCount: options.clusterCount,
      effectiveClusterCount,
      clusterById,
      embeddingsById: options.embeddingsById,
      neighborK: options.neighborK
    }),
    clusterById
  };
}

function buildProjectionClusteringSurface(
  entry: { viewName: string; artifactPath: string; artifact: ClusterArtifact },
  embeddingsById: Map<string, EmbeddingArtifact>,
  neighborK: number
): ClusteringSurfaceWorkingSet {
  const clusterById = new Map<string, number>();

  for (const member of entry.artifact.members ?? []) {
    if (
      typeof member.opinionId === "string" &&
      Number.isFinite(member.clusterId) &&
      embeddingsById.has(member.opinionId)
    ) {
      clusterById.set(member.opinionId, member.clusterId);
    }
  }

  return {
    summary: summarizeClusteringSurface({
      surfaceId: `projection-${entry.viewName}`,
      surfaceKind: "projection",
      label: entry.viewName,
      method: entry.artifact.method,
      status: entry.artifact.status,
      viewName: entry.viewName,
      requestedClusterCount: entry.artifact.requestedClusterCount,
      effectiveClusterCount: entry.artifact.effectiveClusterCount,
      clusterById,
      embeddingsById,
      neighborK
    }),
    clusterById
  };
}

function summarizeClusteringSurface(options: {
  surfaceId: string;
  surfaceKind: "embedding" | "projection" | "graph";
  label: string;
  method: string;
  status: "ready" | "skipped" | "failed";
  viewName?: string;
  requestedClusterCount: number;
  effectiveClusterCount: number;
  clusterById: Map<string, number>;
  embeddingsById: Map<string, EmbeddingArtifact>;
  neighborK: number;
}): ClusteringSurfaceSummary {
  const opinionIds = sortedUnique([...options.clusterById.keys()]);
  const effectiveK = Math.min(options.neighborK, Math.max(0, opinionIds.length - 1));
  const clusterSizes = new Map<number, number>();

  for (const clusterId of options.clusterById.values()) {
    clusterSizes.set(clusterId, (clusterSizes.get(clusterId) ?? 0) + 1);
  }

  const largestClusterSize = Math.max(0, ...clusterSizes.values());
  const singletonClusterCount = [...clusterSizes.values()].filter((value) => value === 1).length;
  const embeddingNeighborIndex =
    effectiveK === 0
      ? new Map<string, string[]>()
      : buildEmbeddingNeighborIndex(opinionIds, options.embeddingsById, effectiveK);

  return {
    surfaceId: options.surfaceId,
    surfaceKind: options.surfaceKind,
    label: options.label,
    method: options.method,
    status: options.status,
    ...(options.viewName === undefined ? {} : { viewName: options.viewName }),
    requestedClusterCount: options.requestedClusterCount,
    effectiveClusterCount: options.effectiveClusterCount,
    memberCount: options.clusterById.size,
    comparableOpinionCount: opinionIds.length,
    singletonClusterCount,
    largestClusterSize,
    largestClusterShare: roundMetric(safeRatio(largestClusterSize, Math.max(1, opinionIds.length))),
    embeddingNeighborPurityAtK: calculateNeighborPurityAtK(
      embeddingNeighborIndex,
      options.clusterById
    ),
    embeddingSilhouette: computeAverageSilhouette(
      opinionIds,
      options.clusterById,
      (leftId, rightId) => {
        const left = options.embeddingsById.get(leftId);
        const right = options.embeddingsById.get(rightId);

        if (left === undefined || right === undefined) {
          return Number.POSITIVE_INFINITY;
        }

        return cosineDistance(left.vector, right.vector);
      }
    )
  };
}

function compareClusteringSurfaces(
  surfaces: ClusteringSurfaceWorkingSet[]
): ClusteringSurfaceComparisonSummary[] {
  const comparisons: ClusteringSurfaceComparisonSummary[] = [];

  for (let leftIndex = 0; leftIndex < surfaces.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < surfaces.length; rightIndex += 1) {
      const left = surfaces[leftIndex];
      const right = surfaces[rightIndex];

      if (left === undefined || right === undefined) {
        continue;
      }

      const commonIds = [...left.clusterById.keys()].filter((opinionId) =>
        right.clusterById.has(opinionId)
      );

      comparisons.push({
        leftSurfaceId: left.summary.surfaceId,
        rightSurfaceId: right.summary.surfaceId,
        leftLabel: left.summary.label,
        rightLabel: right.summary.label,
        comparableOpinionCount: commonIds.length,
        adjustedRandIndex: computeAdjustedRandIndex(
          commonIds,
          left.clusterById,
          right.clusterById
        ),
        largestMembershipShifts: computeLargestMembershipShifts(
          commonIds,
          left.clusterById,
          right.clusterById
        )
      });
    }
  }

  return comparisons.sort(
    (left, right) =>
      (right.adjustedRandIndex ?? -1) - (left.adjustedRandIndex ?? -1) ||
      left.leftLabel.localeCompare(right.leftLabel) ||
      left.rightLabel.localeCompare(right.rightLabel)
  );
}

function computeLargestMembershipShifts(
  opinionIds: string[],
  leftClusterById: Map<string, number>,
  rightClusterById: Map<string, number>
): MembershipShiftSummary[] {
  const rightCountsByLeftCluster = new Map<number, Map<number, number>>();

  for (const opinionId of opinionIds) {
    const leftClusterId = leftClusterById.get(opinionId);
    const rightClusterId = rightClusterById.get(opinionId);

    if (leftClusterId === undefined || rightClusterId === undefined) {
      continue;
    }

    const rightCounts = rightCountsByLeftCluster.get(leftClusterId) ?? new Map<number, number>();
    rightCounts.set(rightClusterId, (rightCounts.get(rightClusterId) ?? 0) + 1);
    rightCountsByLeftCluster.set(leftClusterId, rightCounts);
  }

  return [...rightCountsByLeftCluster.entries()]
    .map(([sourceClusterId, rightCounts]) => {
      const sourceClusterSize = [...rightCounts.values()].reduce((sum, value) => sum + value, 0);
      const topDestinationClusters = [...rightCounts.entries()]
        .map(([clusterId, count]) => ({
          clusterId,
          count,
          share: roundMetric(safeRatio(count, sourceClusterSize))
        }))
        .sort((left, right) => right.count - left.count || left.clusterId - right.clusterId)
        .slice(0, 4);
      const topShare = topDestinationClusters[0]?.share ?? 0;

      return {
        sourceClusterId,
        sourceClusterSize,
        fragmentationRate: roundMetric(1 - topShare),
        topDestinationClusters
      };
    })
    .sort(
      (left, right) =>
        right.fragmentationRate - left.fragmentationRate ||
        right.sourceClusterSize - left.sourceClusterSize ||
        left.sourceClusterId - right.sourceClusterId
    )
    .slice(0, 5);
}

function buildClusteringSurfaceObservations(
  summary: ClusteringSurfaceEvaluationArtifact
): string[] {
  const observations: string[] = [];
  const surfaceById = new Map(summary.surfaces.map((surface) => [surface.surfaceId, surface]));
  const surfacesWithPurity = summary.surfaces.filter(
    (surface) => surface.embeddingNeighborPurityAtK !== null
  );
  const bestSurface = [...surfacesWithPurity].sort(
    (left, right) =>
      (right.embeddingNeighborPurityAtK ?? -1) - (left.embeddingNeighborPurityAtK ?? -1)
  )[0];

  if (bestSurface !== undefined) {
    observations.push(
      `${bestSurface.label} had the strongest embedding-neighbor purity at ${formatMetric(bestSurface.embeddingNeighborPurityAtK)}.`
    );
  }

  const sameCountEmbeddingComparisons = summary.comparisons.filter(
    (comparison) => {
      const left = surfaceById.get(comparison.leftSurfaceId);
      const right = surfaceById.get(comparison.rightSurfaceId);

      return (
        left !== undefined &&
        right !== undefined &&
        left.surfaceKind !== right.surfaceKind &&
        left.requestedClusterCount === right.requestedClusterCount
      );
    }
  );
  const lowAgreementComparisons = sameCountEmbeddingComparisons.filter(
    (comparison) => comparison.adjustedRandIndex !== null && comparison.adjustedRandIndex < 0.5
  );

  if (lowAgreementComparisons.length > 0) {
    observations.push(
      `${lowAgreementComparisons.length} embedding-vs-projection comparison(s) with matching cluster counts had ARI below 0.5, so clustering surface materially changes membership.`
    );
  }

  const bestEmbeddingSurface = [...summary.surfaces]
    .filter(
      (surface) =>
        surface.surfaceKind === "embedding" && surface.embeddingNeighborPurityAtK !== null
    )
    .sort(
      (left, right) =>
        (right.embeddingNeighborPurityAtK ?? -1) - (left.embeddingNeighborPurityAtK ?? -1)
    )[0];
  const bestProjectionSurface = [...summary.surfaces]
    .filter(
      (surface) =>
        surface.surfaceKind === "projection" && surface.embeddingNeighborPurityAtK !== null
    )
    .sort(
      (left, right) =>
        (right.embeddingNeighborPurityAtK ?? -1) - (left.embeddingNeighborPurityAtK ?? -1)
    )[0];

  if (bestEmbeddingSurface !== undefined && bestProjectionSurface !== undefined) {
    const embeddingPurity = bestEmbeddingSurface.embeddingNeighborPurityAtK ?? 0;
    const projectionPurity = bestProjectionSurface.embeddingNeighborPurityAtK ?? 0;

    observations.push(
      embeddingPurity >= projectionPurity
        ? `Best embedding-space clustering beat the best projection-space clustering on embedding-neighbor purity (${formatMetric(embeddingPurity)} vs ${formatMetric(projectionPurity)}).`
        : `Best projection-space clustering beat the best embedding-space clustering on embedding-neighbor purity (${formatMetric(projectionPurity)} vs ${formatMetric(embeddingPurity)}).`
    );
  }

  return observations;
}

function renderClusteringSurfaceConsoleSummary(
  projectRoot: string,
  outputPath: string,
  summary: ClusteringSurfaceEvaluationArtifact
): string {
  const surfaceById = new Map(summary.surfaces.map((surface) => [surface.surfaceId, surface]));
  const lines = [
    color.heading("Broadly Clustering Surface Evaluation"),
    color.muted(rule("=")),
    formatDetailLine("Project", projectRoot),
    formatDetailLine("Run", summary.runId),
    formatDetailLine(
      "Corpus",
      `${summary.corpus.comparableOpinionCount} comparable opinions · ${summary.corpus.embeddingCount} embeddings`
    ),
    formatDetailLine(
      "Surfaces",
      `${summary.corpus.embeddingSurfaceCount} embedding · ${summary.corpus.projectionSurfaceCount} projection`
    ),
    ...summary.surfaces.map((surface) =>
      formatDetailLine(
        surface.label,
        `${surface.method} · k=${surface.effectiveClusterCount} · purity ${formatMetric(surface.embeddingNeighborPurityAtK)} · silhouette ${formatMetric(surface.embeddingSilhouette)}`
      )
    ),
    ...summary.comparisons
      .filter(
        (comparison) => {
          const left = surfaceById.get(comparison.leftSurfaceId);
          const right = surfaceById.get(comparison.rightSurfaceId);

          return (
            left !== undefined &&
            right !== undefined &&
            left.surfaceKind !== right.surfaceKind &&
            left.requestedClusterCount === right.requestedClusterCount
          );
        }
      )
      .slice(0, 5)
      .map((comparison) =>
        formatDetailLine(
          "Compare",
          `${comparison.leftLabel} vs ${comparison.rightLabel}: ARI ${formatMetric(comparison.adjustedRandIndex)}`
        )
      ),
    ...summary.observations.map((observation) => formatDetailLine("Note", observation)),
    formatDetailLine("Output", toPortableRelativePath(projectRoot, outputPath))
  ];

  return `\n${lines.join("\n")}\n`;
}

async function evaluateAnalysisGraphBuilders(options: AnalysisCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const neighborK = options.neighborK ?? DEFAULT_REDUCER_EVALUATION_NEIGHBOR_K;

  await withProjectActionLog({
    projectRoot,
    command: "analysis evaluate-graph-builders",
    details: {
      run: options.run ?? "(current/latest)",
      neighborK
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const resolvedRun = await resolveReducerEvaluationRun(projectPaths, options.run);
      const manifestPath = path.join(resolvedRun.runDir, "manifest.json");
      const manifest = await readJsonFile<AnalysisRunManifest>(manifestPath);

      if (manifest === null) {
        throw new Error(`Analysis run '${resolvedRun.runId}' does not have a readable manifest.`);
      }

      const reductionsDir = manifest.output.reductionsDir || path.join(resolvedRun.runDir, "reductions");
      const clustersDir = manifest.output.clustersDir || path.join(resolvedRun.runDir, "clusters");
      const embeddingsDirs = resolveReducerEvaluationEmbeddingDirs(manifest);
      const embeddingsById = await loadReducerEvaluationEmbeddings(embeddingsDirs);
      const clusterEntries = await loadReducerEvaluationClusters(clustersDir);
      const comparableOpinionIds = sortedUnique([...embeddingsById.keys()]);
      const clusterCounts = uniqueNumberList(
        clusterEntries
          .map((entry) => entry.artifact.requestedClusterCount)
          .filter((value) => Number.isFinite(value) && value > 0)
      );
      const graphNeighborKs = resolveGraphNeighborKs(neighborK, comparableOpinionIds.length);
      const graphArtifacts = buildGraphBuilderArtifacts({
        opinionIds: comparableOpinionIds,
        embeddingsById,
        graphNeighborKs
      });
      const graphSurfaces = graphArtifacts.flatMap((graph) =>
        clusterCounts.map((clusterCount) =>
          buildGraphClusteringSurface({
            graph,
            clusterCount,
            embeddingsById,
            neighborK,
            runId: resolvedRun.runId
          })
        )
      );
      const embeddingSurfaces = clusterCounts.map((clusterCount) =>
        buildEmbeddingClusteringSurface({
          runId: resolvedRun.runId,
          clusterCount,
          opinionIds: comparableOpinionIds,
          embeddingsById,
          neighborK
        })
      );
      const projectionSurfaces = clusterEntries.map((entry) =>
        buildProjectionClusteringSurface(entry, embeddingsById, neighborK)
      );
      const surfaces = [...embeddingSurfaces, ...projectionSurfaces, ...graphSurfaces];
      const comparisons = compareClusteringSurfaces(surfaces);
      const surfaceOpinionIds = new Set<string>();
      const graphEvalDir = path.join(resolvedRun.runDir, "graph-eval");
      const graphsDir = path.join(graphEvalDir, "graphs");
      const graphSurfacesDir = path.join(graphEvalDir, "surfaces");

      for (const surface of surfaces) {
        for (const opinionId of surface.clusterById.keys()) {
          surfaceOpinionIds.add(opinionId);
        }
      }

      for (const graph of graphArtifacts) {
        await writeJsonFile(
          path.join(graphsDir, `${graph.graphId}.json`),
          serializeGraphBuilderArtifact(graph)
        );
      }

      for (const surface of graphSurfaces) {
        await writeJsonFile(
          path.join(graphSurfacesDir, `${surface.summary.surfaceId}.json`),
          serializeClusteringSurfaceAssignments(surface)
        );
      }

      const summary: GraphBuilderEvaluationArtifact = {
        createdAt: new Date().toISOString(),
        runId: resolvedRun.runId,
        method: "graph-builder-evaluation-v1",
        parameters: {
          neighborK,
          graphNeighborKs,
          silhouetteMaxPoints: REDUCER_EVALUATION_SILHOUETTE_MAX_POINTS
        },
        source: {
          manifestPath,
          embeddingsDirs,
          reductionsDir,
          clustersDir,
          graphsDir,
          graphSurfacesDir
        },
        corpus: {
          embeddingCount: embeddingsById.size,
          graphCount: graphArtifacts.length,
          graphSurfaceCount: graphSurfaces.length,
          embeddingSurfaceCount: embeddingSurfaces.length,
          projectionSurfaceCount: projectionSurfaces.length,
          comparableOpinionCount: surfaceOpinionIds.size
        },
        graphs: graphArtifacts.map((graph) => graph.summary),
        surfaces: surfaces.map((surface) => surface.summary),
        comparisons,
        observations: []
      };

      summary.observations = buildGraphBuilderObservations(summary);

      const outputPath = path.join(graphEvalDir, "summary.json");
      await writeJsonFile(outputPath, summary);

      process.stdout.write(renderGraphBuilderConsoleSummary(projectRoot, outputPath, summary));
    }
  });
}

async function promoteAnalysisGraphSurface(options: AnalysisCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const requestedSurfaceId = resolveRequestedGraphSurfaceId(options.promoteGraphSurface);

  await withProjectActionLog({
    projectRoot,
    command: "analysis promote-graph-surface",
    details: {
      run: options.run ?? "(current/latest)",
      surface: requestedSurfaceId ?? "(best repaired mutual-kNN)"
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = await loadProjectConfig(projectPaths.configPath);
      const templateView = resolveGraphPromotionTemplateView(config);
      const analysisModel = resolveAnalysisModelForView(config, templateView);
      const prompts = await loadResolvedAnalysisPrompts(projectRoot, templateView);
      const resolvedRun = await resolveReducerEvaluationRun(projectPaths, options.run);
      const runDir = resolvedRun.runDir;
      const manifestPath = path.join(runDir, "manifest.json");
      const manifest = await readJsonFile<AnalysisRunManifest>(manifestPath);

      if (manifest === null) {
        throw new Error(`Analysis run '${resolvedRun.runId}' does not have a readable manifest.`);
      }

      const graphEvaluationPath = path.join(runDir, "graph-eval", "summary.json");
      const graphEvaluation = await readJsonFile<GraphBuilderEvaluationArtifact>(graphEvaluationPath);

      if (graphEvaluation === null) {
        throw new Error(
          `Analysis run '${resolvedRun.runId}' does not have graph diagnostics. Run broadly analysis --evaluate-graph-builders first.`
        );
      }

      const surface = selectGraphSurfaceForPromotion(graphEvaluation, requestedSurfaceId);
      const graphSurfacesDir =
        graphEvaluation.source.graphSurfacesDir || path.join(runDir, "graph-eval", "surfaces");
      const surfacePath = path.join(graphSurfacesDir, `${surface.surfaceId}.json`);
      const surfaceAssignments = await readJsonFile<GraphSurfaceAssignmentArtifact>(surfacePath);

      if (surfaceAssignments === null) {
        throw new Error(`Graph surface assignment artifact was not found: ${surfacePath}`);
      }

      const reductionsDir = manifest.output.reductionsDir || path.join(runDir, "reductions");
      const reductions = await loadReducerEvaluationReductions(reductionsDir);
      const displayReduction = selectDisplayReductionForGraphPromotion(
        reductions,
        templateView.reduction.method
      );
      const opinionsById = await loadAnalysisRunOpinionArtifacts(manifest);
      const viewName = promotedGraphViewName(surface.surfaceId);
      const viewTitle = "Semantic Neighborhood View";
      const promotedView: AnalysisViewConfig = {
        ...templateView,
        name: viewName,
        title: viewTitle,
        clustering: {
          ...templateView.clustering,
          count: surface.effectiveClusterCount || surface.requestedClusterCount
        },
        mode: "balanced"
      };
      const clustersDir = manifest.output.clustersDir || path.join(runDir, "clusters");
      const hierarchiesDir = manifest.output.hierarchiesDir || path.join(runDir, "hierarchies");
      const perspectivesDir = manifest.output.perspectivesDir || path.join(runDir, "perspectives");
      const clusterArtifactPath = path.join(clustersDir, `${viewName}.json`);
      const hierarchyPath = path.join(hierarchiesDir, `${viewName}.json`);
      const perspectivePath = path.join(perspectivesDir, `${viewName}.json`);
      const existingClusterArtifact = await readJsonFile<ClusterArtifact>(clusterArtifactPath);
      const reusableClusterArtifact =
        existingClusterArtifact?.experimental?.kind === "graph-surface" &&
        existingClusterArtifact.experimental.sourceSurfaceId === surface.surfaceId
          ? existingClusterArtifact
          : null;
      let clusterArtifact =
        reusableClusterArtifact ??
        buildGraphSurfaceClusterArtifact({
          surface,
          surfacePath,
          sourceGraphEvaluationPath: graphEvaluationPath,
          assignments: surfaceAssignments.assignments,
          displayReduction: displayReduction.artifact,
          displayReductionPath: displayReduction.artifactPath,
          opinionsById
        });
      const normalizedClusterArtifact = normalizeGraphRemainderClusterLabels(clusterArtifact);

      await mkdir(clustersDir, { recursive: true });
      await mkdir(hierarchiesDir, { recursive: true });
      await mkdir(perspectivesDir, { recursive: true });

      if (reusableClusterArtifact === null || normalizedClusterArtifact !== clusterArtifact) {
        clusterArtifact = normalizedClusterArtifact;
        await writeJsonFile(clusterArtifactPath, clusterArtifact);
      }

      const rawLabeledClusterArtifact =
        clusterArtifact.labeling.method === "llm-cluster-labeling"
          ? clusterArtifact
          : await labelClusterArtifactWithLlm({
              artifact: clusterArtifact,
              artifactPath: clusterArtifactPath,
              analysisModel,
              projectRoot,
              promptPath: prompts.clusterLabeling.path,
              promptSha256: prompts.clusterLabeling.sha256,
              promptTemplate: prompts.clusterLabeling.template
            });
      const labeledClusterArtifact = normalizeGraphRemainderClusterLabels(rawLabeledClusterArtifact);
      const labelReused = labeledClusterArtifact === clusterArtifact;

      if (!labelReused) {
        await writeJsonFile(clusterArtifactPath, labeledClusterArtifact);
      }

      const existingHierarchy = await readJsonFile<ClusterHierarchyArtifact>(hierarchyPath);
      const hierarchyArtifact =
        existingHierarchy !== null &&
        existingHierarchy.status === "ready" &&
        existingHierarchy.sourceClusterArtifactPath === clusterArtifactPath &&
        hierarchyMatchesGraphRemainderPolicy(existingHierarchy, labeledClusterArtifact)
          ? existingHierarchy
          : await buildSemanticHierarchyArtifact({
              artifact: labeledClusterArtifact,
              artifactPath: clusterArtifactPath,
              analysisModel,
              projectRoot,
              promptPath: prompts.semanticMerge.path,
              promptSha256: prompts.semanticMerge.sha256,
              promptTemplate: prompts.semanticMerge.template
            });
      const hierarchyReused = hierarchyArtifact === existingHierarchy;

      if (!hierarchyReused) {
        await writeJsonFile(hierarchyPath, hierarchyArtifact);
      }

      const existingPerspective = await readJsonFile<PerspectivePlanArtifact>(perspectivePath);
      const perspectiveArtifact =
        existingPerspective !== null &&
        existingPerspective.status === "ready" &&
        existingPerspective.synthesis.method === "llm-perspective-summary" &&
        existingPerspective.viewName === viewName &&
        existingPerspective.viewTitle === viewTitle &&
        perspectiveMatchesGraphRemainderPolicy(existingPerspective, labeledClusterArtifact)
          ? existingPerspective
          : await buildPerspectivePlanArtifact(promotedView, [clusterArtifactPath], {
              analysisModel,
              projectRoot,
              promptPath: prompts.perspectiveSummary.path,
              promptSha256: prompts.perspectiveSummary.sha256,
              promptTemplate: prompts.perspectiveSummary.template,
              guidingQuestions: config.questions
            });
      const perspectiveReused = perspectiveArtifact === existingPerspective;

      if (!perspectiveReused) {
        await writeJsonFile(perspectivePath, perspectiveArtifact);
      }

      await updateManifestForPromotedGraphView({
        manifestPath,
        viewName,
        viewTitle,
        view: promotedView,
        analysisModel,
        clustersDir,
        hierarchiesDir,
        perspectivesDir
      });

      process.stdout.write(
        renderGraphSurfacePromotionConsoleSummary({
          projectRoot,
          runId: resolvedRun.runId,
          surface,
          viewName,
          clusterArtifactPath,
          hierarchyPath,
          perspectivePath,
          labeledClusterArtifact,
          hierarchyArtifact,
          perspectiveArtifact,
          labelReused,
          hierarchyReused,
          perspectiveReused
        })
      );
    }
  });
}

function resolveRequestedGraphSurfaceId(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveGraphPromotionTemplateView(config: BroadlyProjectConfig): AnalysisViewConfig {
  const primaryView =
    config.analysisViews.find((view) => view.name === config.report.primaryView) ??
    config.analysisViews[0];

  if (primaryView === undefined) {
    throw new Error("No analysis views are configured in broadly.yaml.");
  }

  return primaryView;
}

async function loadResolvedAnalysisPrompts(
  projectRoot: string,
  view: AnalysisViewConfig
): Promise<ResolvedAnalysisView["prompts"]> {
  const clusterLabelingPromptPath = path.join(projectRoot, view.prompts.clusterLabeling);
  const perspectiveSummaryPromptPath = path.join(projectRoot, view.prompts.viewSummary);
  const semanticMergePromptPath = path.join(projectRoot, view.prompts.semanticMerge);
  const [clusterLabelingPrompt, perspectiveSummaryPrompt, semanticMergePrompt] =
    await Promise.all([
      readFile(clusterLabelingPromptPath, "utf8"),
      readFile(perspectiveSummaryPromptPath, "utf8"),
      readFile(semanticMergePromptPath, "utf8")
    ]);

  return {
    clusterLabeling: {
      path: clusterLabelingPromptPath,
      template: clusterLabelingPrompt,
      sha256: sha256Hex(clusterLabelingPrompt)
    },
    perspectiveSummary: {
      path: perspectiveSummaryPromptPath,
      template: perspectiveSummaryPrompt,
      sha256: sha256Hex(perspectiveSummaryPrompt)
    },
    semanticMerge: {
      path: semanticMergePromptPath,
      template: semanticMergePrompt,
      sha256: sha256Hex(semanticMergePrompt)
    }
  };
}

function selectGraphSurfaceForPromotion(
  graphEvaluation: GraphBuilderEvaluationArtifact,
  requestedSurfaceId: string | undefined
): ClusteringSurfaceSummary {
  const graphSurfaces = graphEvaluation.surfaces.filter(
    (surface) => surface.surfaceKind === "graph" && surface.status === "ready"
  );

  if (requestedSurfaceId !== undefined) {
    const requestedSurface = graphSurfaces.find(
      (surface) => surface.surfaceId === requestedSurfaceId
    );

    if (requestedSurface === undefined) {
      throw new Error(`Graph surface '${requestedSurfaceId}' was not found in graph-eval/summary.json.`);
    }

    return requestedSurface;
  }

  const repairedMutualSurfaces = graphSurfaces.filter((surface) =>
    surface.surfaceId.includes("mutual-knn-repaired")
  );
  const candidateSurfaces =
    repairedMutualSurfaces.length === 0 ? graphSurfaces : repairedMutualSurfaces;
  const selected = [...candidateSurfaces].sort(
    (left, right) =>
      (right.embeddingNeighborPurityAtK ?? -1) - (left.embeddingNeighborPurityAtK ?? -1) ||
      (right.embeddingSilhouette ?? -1) - (left.embeddingSilhouette ?? -1) ||
      left.surfaceId.localeCompare(right.surfaceId)
  )[0];

  if (selected === undefined) {
    throw new Error("No ready graph surfaces were available to promote.");
  }

  return selected;
}

function selectDisplayReductionForGraphPromotion(
  reductions: Array<{ artifactPath: string; artifact: ReductionArtifact }>,
  preferredMethod: string
): { artifactPath: string; artifact: ReductionArtifact } {
  const readyReductions = reductions.filter((entry) => entry.artifact.status === "ready");
  const selected =
    readyReductions.find((entry) => entry.artifact.method === preferredMethod) ??
    readyReductions.find((entry) => entry.artifact.method === "umap") ??
    readyReductions[0];

  if (selected === undefined) {
    throw new Error("No ready reduction artifact was available for graph view display coordinates.");
  }

  return selected;
}

async function loadAnalysisRunOpinionArtifacts(
  manifest: AnalysisRunManifest
): Promise<Map<string, OpinionArtifact>> {
  const opinionDirs = uniqueList(
    [
      manifest.input.opinionsDir,
      ...(manifest.input.groups ?? []).map((group) => group.opinionsDir)
    ].filter((value) => value.trim().length > 0)
  );
  const opinionsById = new Map<string, OpinionArtifact>();

  for (const opinionsDir of opinionDirs) {
    const opinionPaths = await listOpinionArtifactPaths(opinionsDir);

    for (const opinionPath of opinionPaths) {
      const opinion = await readJsonFile<OpinionArtifact>(opinionPath);

      if (
        opinion !== null &&
        typeof opinion.opinionId === "string" &&
        typeof opinion.opinionText === "string"
      ) {
        opinionsById.set(opinion.opinionId, opinion);
      }
    }
  }

  return opinionsById;
}

function promotedGraphViewName(surfaceId: string): string {
  return `experimental-${surfaceId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function findGraphRemainderClusterIds(artifact: ClusterArtifact): number[] {
  if (artifact.experimental?.kind !== "graph-surface") {
    return [];
  }

  const totalMembers = Math.max(1, artifact.members.length);
  return artifact.clusters
    .filter((cluster) => cluster.size / totalMembers >= GRAPH_REMAINDER_CLUSTER_SHARE_THRESHOLD)
    .map((cluster) => cluster.clusterId)
    .sort((left, right) => left - right);
}

function normalizeGraphRemainderClusterLabels(artifact: ClusterArtifact): ClusterArtifact {
  if (artifact.experimental?.kind !== "graph-surface") {
    return artifact;
  }

  const remainderClusterIds = findGraphRemainderClusterIds(artifact);
  const remainderSet = new Set(remainderClusterIds);
  const method =
    artifact.method === "semantic-neighborhood-kmeans"
      ? artifact.method
      : "semantic-neighborhood-kmeans";
  const clusters = artifact.clusters.map((cluster) => {
    if (!remainderSet.has(cluster.clusterId)) {
      return cluster;
    }

    const label = "Mixed General Remainder";
    const summary =
      "This broad remainder contains mixed or general opinions that were not captured by the smaller semantic-neighborhood clusters. Treat it as material to inspect or recluster, not as one coherent report theme.";

    if (cluster.label === label && cluster.summary === summary) {
      return cluster;
    }

    return {
      ...cluster,
      label,
      summary
    };
  });

  if (
    artifact.method === method &&
    arraysEqual(artifact.experimental.excludedClusterIds ?? [], remainderClusterIds) &&
    clusters.every((cluster, index) => cluster === artifact.clusters[index])
  ) {
    return artifact;
  }

  return {
    ...artifact,
    method,
    clusters,
    experimental: {
      ...artifact.experimental,
      excludedClusterIds: remainderClusterIds
    }
  };
}

function hierarchyMatchesGraphRemainderPolicy(
  hierarchy: ClusterHierarchyArtifact,
  artifact: ClusterArtifact
): boolean {
  const excludedClusterIds = findGraphRemainderClusterIds(artifact);

  if (excludedClusterIds.length === 0) {
    return true;
  }

  const excludedClusterIdSet = new Set(excludedClusterIds);
  return (
    arraysEqual(hierarchy.experimental?.excludedClusterIds ?? [], excludedClusterIds) &&
    hierarchy.themes.every((theme) =>
      theme.clusterIds.every((clusterId) => !excludedClusterIdSet.has(clusterId))
    )
  );
}

function perspectiveMatchesGraphRemainderPolicy(
  perspective: PerspectivePlanArtifact,
  artifact: ClusterArtifact
): boolean {
  const excludedClusterIds = findGraphRemainderClusterIds(artifact);

  if (excludedClusterIds.length === 0) {
    return true;
  }

  const excludedClusterIdSet = new Set(excludedClusterIds);
  return (
    arraysEqual(perspective.experimental?.excludedClusterIds ?? [], excludedClusterIds) &&
    perspective.highlights.every((highlight) => !excludedClusterIdSet.has(highlight.clusterId))
  );
}

function graphRemainderExclusionMetadata(
  artifact: ClusterArtifact
): ClusterHierarchyArtifact["experimental"] | undefined {
  if (artifact.experimental?.kind !== "graph-surface") {
    return undefined;
  }

  const excludedClusterIds = findGraphRemainderClusterIds(artifact);

  if (excludedClusterIds.length === 0) {
    return undefined;
  }

  return {
    kind: "graph-surface",
    sourceSurfaceId: artifact.experimental.sourceSurfaceId,
    excludedClusterIds,
    exclusionReason: `Clusters at or above ${Math.round(
      GRAPH_REMAINDER_CLUSTER_SHARE_THRESHOLD * 100
    )}% of graph assignments are treated as broad mixed remainders and held out of semantic themes and highlights.`
  };
}

function buildSemanticThemeArtifact(artifact: ClusterArtifact): {
  artifact: ClusterArtifact;
  experimental?: ClusterHierarchyArtifact["experimental"];
} {
  const experimental = graphRemainderExclusionMetadata(artifact);

  if (experimental === undefined) {
    return { artifact };
  }

  const excludedClusterIdSet = new Set(experimental.excludedClusterIds);
  const clusters = artifact.clusters.filter(
    (cluster) => !excludedClusterIdSet.has(cluster.clusterId)
  );

  return {
    artifact: {
      ...artifact,
      effectiveClusterCount: clusters.length,
      clusters
    },
    experimental
  };
}

function arraysEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildGraphSurfaceClusterArtifact(options: {
  surface: ClusteringSurfaceSummary;
  surfacePath: string;
  sourceGraphEvaluationPath: string;
  assignments: Array<{ opinionId: string; clusterId: number }>;
  displayReduction: ReductionArtifact;
  displayReductionPath: string;
  opinionsById: Map<string, OpinionArtifact>;
}): ClusterArtifact {
  const createdAt = new Date().toISOString();
  const pointByOpinionId = new Map(
    options.displayReduction.points.map((point) => [point.opinionId, point])
  );
  const members = options.assignments
    .map((assignment) => {
      const point = pointByOpinionId.get(assignment.opinionId);

      if (point === undefined) {
        return null;
      }

      return {
        opinionId: assignment.opinionId,
        clusterId: assignment.clusterId,
        x: point.x,
        y: point.y
      };
    })
    .filter((value): value is ClusterMember => value !== null);

  if (members.length === 0) {
    return {
      createdAt,
      method: "semantic-neighborhood-kmeans",
      requestedClusterCount: options.surface.requestedClusterCount,
      effectiveClusterCount: 0,
      status: "skipped",
      message: "No graph surface assignments had display coordinates.",
      sourceReductionPath: options.displayReductionPath,
      labeling: {
        method: "heuristic-fallback",
        createdAt
      },
      members: [],
      clusters: [],
      experimental: {
        kind: "graph-surface",
        sourceSurfaceId: options.surface.surfaceId,
        sourceSurfacePath: options.surfacePath,
        sourceGraphEvaluationPath: options.sourceGraphEvaluationPath,
        displayReductionPath: options.displayReductionPath,
        graphSurfaceLabel: options.surface.label,
        embeddingNeighborPurityAtK: options.surface.embeddingNeighborPurityAtK,
        embeddingSilhouette: options.surface.embeddingSilhouette
      }
    };
  }

  const clusterMap = new Map<number, ClusterMember[]>();

  for (const member of members) {
    const group = clusterMap.get(member.clusterId) ?? [];
    group.push(member);
    clusterMap.set(member.clusterId, group);
  }

  const clusters = [...clusterMap.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([clusterId, group]) => {
      const centroid = computeCentroid(group);
      const summary = summarizeCluster(group, centroid, options.opinionsById, clusterId);

      return {
        clusterId,
        size: group.length,
        centroid,
        label: summary.label,
        topTerms: summary.topTerms,
        summary: summary.summary,
        representativeOpinions: summary.representativeOpinions
      };
    });

  return {
    createdAt,
    method: "semantic-neighborhood-kmeans",
    requestedClusterCount: options.surface.requestedClusterCount,
    effectiveClusterCount: clusters.length,
    status: "ready",
    sourceReductionPath: options.displayReductionPath,
    labeling: {
      method: "heuristic-fallback",
      createdAt
    },
    members,
    clusters,
    experimental: {
      kind: "graph-surface",
      sourceSurfaceId: options.surface.surfaceId,
      sourceSurfacePath: options.surfacePath,
      sourceGraphEvaluationPath: options.sourceGraphEvaluationPath,
      displayReductionPath: options.displayReductionPath,
      graphSurfaceLabel: options.surface.label,
      embeddingNeighborPurityAtK: options.surface.embeddingNeighborPurityAtK,
      embeddingSilhouette: options.surface.embeddingSilhouette
    }
  };
}

async function updateManifestForPromotedGraphView(options: {
  manifestPath: string;
  viewName: string;
  viewTitle: string;
  view: AnalysisViewConfig;
  analysisModel: RegisteredModel;
  clustersDir: string;
  hierarchiesDir: string;
  perspectivesDir: string;
}): Promise<void> {
  const manifest = await readJsonFile<AnalysisRunManifest>(options.manifestPath);

  if (manifest === null) {
    return;
  }

  const existingViews = manifest.input.views ?? [];
  manifest.updatedAt = new Date().toISOString();
  manifest.input.synthesisModes = uniqueList([
    ...manifest.input.synthesisModes,
    options.viewName
  ]);
  manifest.input.views = [
    ...existingViews.filter((view) => view.name !== options.viewName),
    {
      name: options.viewName,
      title: options.viewTitle,
      mode: options.view.mode,
      reductionMethod: "experimental-graph-surface",
      clusterCount: options.view.clustering.count,
      sourceExtraction: options.view.sourceExtraction,
      analysisModel: options.analysisModel.name
    }
  ].sort((left, right) => left.name.localeCompare(right.name));
  manifest.output.clusterArtifactsWritten = await countJsonArtifacts(options.clustersDir);
  manifest.output.hierarchyArtifactsWritten = await countJsonArtifacts(options.hierarchiesDir);
  manifest.output.perspectiveArtifactsWritten = await countJsonArtifacts(options.perspectivesDir);

  await writeJsonFile(options.manifestPath, manifest);
}

async function countJsonArtifacts(directoryPath: string): Promise<number> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
}

function renderGraphSurfacePromotionConsoleSummary(options: {
  projectRoot: string;
  runId: string;
  surface: ClusteringSurfaceSummary;
  viewName: string;
  clusterArtifactPath: string;
  hierarchyPath: string;
  perspectivePath: string;
  labeledClusterArtifact: ClusterArtifact;
  hierarchyArtifact: ClusterHierarchyArtifact;
  perspectiveArtifact: PerspectivePlanArtifact;
  labelReused: boolean;
  hierarchyReused: boolean;
  perspectiveReused: boolean;
}): string {
  const lines = [
    color.heading("Broadly Semantic Neighborhood View"),
    color.muted(rule("=")),
    formatDetailLine("Project", options.projectRoot),
    formatDetailLine("Run", options.runId),
    formatDetailLine("View", options.viewName),
    formatDetailLine("Surface", options.surface.label),
    formatDetailLine("Purity", formatMetric(options.surface.embeddingNeighborPurityAtK)),
    formatDetailLine("Silhouette", formatMetric(options.surface.embeddingSilhouette)),
    formatDetailLine(
      "Clusters",
      `${options.labeledClusterArtifact.clusters.length} clusters · ${options.labeledClusterArtifact.members.length} assignments`
    ),
    formatDetailLine(
      "Labels",
      `${options.labeledClusterArtifact.labeling.method}${options.labelReused ? " · reused" : " · generated"}`
    ),
    formatDetailLine(
      "Hierarchy",
      `${options.hierarchyArtifact.status}${options.hierarchyReused ? " · reused" : " · generated"}`
    ),
    formatDetailLine(
      "Perspective",
      `${options.perspectiveArtifact.status}${options.perspectiveReused ? " · reused" : " · generated"}`
    ),
    formatDetailLine("Cluster artifact", toPortableRelativePath(options.projectRoot, options.clusterArtifactPath)),
    formatDetailLine("Hierarchy", toPortableRelativePath(options.projectRoot, options.hierarchyPath)),
    formatDetailLine("Perspective", toPortableRelativePath(options.projectRoot, options.perspectivePath))
  ];

  return `\n${lines.join("\n")}\n`;
}

function buildGraphBuilderArtifacts(options: {
  opinionIds: string[];
  embeddingsById: Map<string, EmbeddingArtifact>;
  graphNeighborKs: number[];
}): GraphBuilderArtifact[] {
  return options.graphNeighborKs.flatMap((graphNeighborK) => {
    const neighborCandidates = buildEmbeddingNeighborCandidates(
      options.opinionIds,
      options.embeddingsById,
      graphNeighborK
    );

    return [
      buildPlainKnnGraph(options.opinionIds, neighborCandidates, graphNeighborK),
      buildMutualKnnGraph(options.opinionIds, neighborCandidates, graphNeighborK),
      buildRepairedMutualKnnGraph(options.opinionIds, neighborCandidates, graphNeighborK),
      buildSharedNeighborGraph(options.opinionIds, neighborCandidates, graphNeighborK)
    ];
  });
}

function resolveGraphNeighborKs(anchorNeighborK: number, opinionCount: number): number[] {
  const maxNeighborK = Math.max(0, opinionCount - 1);

  if (maxNeighborK === 0) {
    return [];
  }

  return uniqueNumberList(
    [6, 8, anchorNeighborK, 12, 15, 20]
      .map((value) => Math.min(value, maxNeighborK))
      .filter((value) => value > 0)
  );
}

function buildEmbeddingNeighborCandidates(
  opinionIds: string[],
  embeddingsById: Map<string, EmbeddingArtifact>,
  neighborK: number
): Map<string, Array<{ opinionId: string; distance: number; weight: number }>> {
  const candidatesById = new Map<string, Array<{ opinionId: string; distance: number; weight: number }>>();

  for (const opinionId of opinionIds) {
    const embedding = embeddingsById.get(opinionId);

    if (embedding === undefined) {
      candidatesById.set(opinionId, []);
      continue;
    }

    const candidates = opinionIds
      .filter((candidateId) => candidateId !== opinionId)
      .map((candidateId) => {
        const candidateEmbedding = embeddingsById.get(candidateId);
        const distance =
          candidateEmbedding === undefined
            ? Number.POSITIVE_INFINITY
            : cosineDistance(embedding.vector, candidateEmbedding.vector);

        return {
          opinionId: candidateId,
          distance,
          weight: cosineDistanceToGraphWeight(distance)
        };
      })
      .filter((candidate) => Number.isFinite(candidate.distance))
      .sort(
        (left, right) =>
          left.distance - right.distance || left.opinionId.localeCompare(right.opinionId)
      )
      .slice(0, neighborK);

    candidatesById.set(opinionId, candidates);
  }

  return candidatesById;
}

function buildPlainKnnGraph(
  opinionIds: string[],
  neighborCandidates: Map<string, Array<{ opinionId: string; weight: number }>>,
  neighborK: number
): GraphBuilderArtifact {
  const adjacency = createEmptyGraphAdjacency(opinionIds);

  for (const [opinionId, candidates] of neighborCandidates.entries()) {
    for (const candidate of candidates) {
      addUndirectedGraphEdge(adjacency, opinionId, candidate.opinionId, candidate.weight);
    }
  }

  return finalizeGraphBuilderArtifact({
    graphId: `plain-knn-k${neighborK}`,
    method: "plain-knn",
    label: `Plain kNN graph k=${neighborK}`,
    neighborK,
    opinionIds,
    adjacency
  });
}

function buildMutualKnnGraph(
  opinionIds: string[],
  neighborCandidates: Map<string, Array<{ opinionId: string; weight: number }>>,
  neighborK: number
): GraphBuilderArtifact {
  const adjacency = createEmptyGraphAdjacency(opinionIds);
  const neighborSets = new Map(
    [...neighborCandidates.entries()].map(([opinionId, candidates]) => [
      opinionId,
      new Set(candidates.map((candidate) => candidate.opinionId))
    ])
  );

  for (const [opinionId, candidates] of neighborCandidates.entries()) {
    for (const candidate of candidates) {
      if (neighborSets.get(candidate.opinionId)?.has(opinionId) === true) {
        addUndirectedGraphEdge(adjacency, opinionId, candidate.opinionId, candidate.weight);
      }
    }
  }

  return finalizeGraphBuilderArtifact({
    graphId: `mutual-knn-k${neighborK}`,
    method: "mutual-knn",
    label: `Mutual kNN graph k=${neighborK}`,
    neighborK,
    opinionIds,
    adjacency
  });
}

function buildRepairedMutualKnnGraph(
  opinionIds: string[],
  neighborCandidates: Map<string, Array<{ opinionId: string; weight: number }>>,
  neighborK: number
): GraphBuilderArtifact {
  const baseGraph = buildMutualKnnGraph(opinionIds, neighborCandidates, neighborK);
  const adjacency = cloneGraphAdjacency(baseGraph.adjacency);
  const baseEdgeCount = countGraphEdges(adjacency);

  for (const opinionId of opinionIds) {
    const edges = adjacency.get(opinionId);

    if (edges === undefined || edges.size > 0) {
      continue;
    }

    const nearestCandidate = neighborCandidates.get(opinionId)?.[0];

    if (nearestCandidate !== undefined) {
      addUndirectedGraphEdge(
        adjacency,
        opinionId,
        nearestCandidate.opinionId,
        nearestCandidate.weight
      );
    }
  }

  return finalizeGraphBuilderArtifact({
    graphId: `mutual-knn-repaired-k${neighborK}`,
    method: "mutual-knn-repaired",
    label: `Repaired mutual kNN graph k=${neighborK}`,
    neighborK,
    opinionIds,
    adjacency,
    baseGraphId: baseGraph.graphId,
    repairedEdgeCount: countGraphEdges(adjacency) - baseEdgeCount,
    repairStrategy: "nearest-neighbor backfill for isolated nodes"
  });
}

function buildSharedNeighborGraph(
  opinionIds: string[],
  neighborCandidates: Map<string, Array<{ opinionId: string; weight: number }>>,
  neighborK: number
): GraphBuilderArtifact {
  const adjacency = createEmptyGraphAdjacency(opinionIds);
  const neighborSets = new Map(
    [...neighborCandidates.entries()].map(([opinionId, candidates]) => [
      opinionId,
      new Set(candidates.map((candidate) => candidate.opinionId))
    ])
  );
  const directWeights = new Map<string, number>();

  for (const [opinionId, candidates] of neighborCandidates.entries()) {
    for (const candidate of candidates) {
      directWeights.set(
        graphEdgeKey(opinionId, candidate.opinionId),
        Math.max(directWeights.get(graphEdgeKey(opinionId, candidate.opinionId)) ?? 0, candidate.weight)
      );
    }
  }

  for (let leftIndex = 0; leftIndex < opinionIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < opinionIds.length; rightIndex += 1) {
      const leftId = opinionIds[leftIndex];
      const rightId = opinionIds[rightIndex];

      if (leftId === undefined || rightId === undefined) {
        continue;
      }

      const leftNeighbors = neighborSets.get(leftId) ?? new Set<string>();
      const rightNeighbors = neighborSets.get(rightId) ?? new Set<string>();
      const sharedCount = countSetIntersection(leftNeighbors, rightNeighbors);
      const sharedUnionCount = leftNeighbors.size + rightNeighbors.size - sharedCount;
      const sharedWeight = sharedUnionCount === 0 ? 0 : sharedCount / sharedUnionCount;
      const directWeight = directWeights.get(graphEdgeKey(leftId, rightId)) ?? 0;
      const weight = sharedWeight + directWeight * 0.25;

      if (weight > 0) {
        addUndirectedGraphEdge(adjacency, leftId, rightId, weight);
      }
    }
  }

  return finalizeGraphBuilderArtifact({
    graphId: `shared-neighbor-k${neighborK}`,
    method: "shared-neighbor",
    label: `Shared-neighbor weighted graph k=${neighborK}`,
    neighborK,
    opinionIds,
    adjacency
  });
}

function createEmptyGraphAdjacency(opinionIds: string[]): Map<string, Map<string, number>> {
  return new Map(opinionIds.map((opinionId) => [opinionId, new Map<string, number>()]));
}

function addUndirectedGraphEdge(
  adjacency: Map<string, Map<string, number>>,
  leftId: string,
  rightId: string,
  weight: number
): void {
  if (leftId === rightId || !Number.isFinite(weight) || weight <= 0) {
    return;
  }

  const leftEdges = adjacency.get(leftId);
  const rightEdges = adjacency.get(rightId);

  if (leftEdges === undefined || rightEdges === undefined) {
    return;
  }

  leftEdges.set(rightId, Math.max(leftEdges.get(rightId) ?? 0, weight));
  rightEdges.set(leftId, Math.max(rightEdges.get(leftId) ?? 0, weight));
}

function cloneGraphAdjacency(
  adjacency: Map<string, Map<string, number>>
): Map<string, Map<string, number>> {
  return new Map(
    [...adjacency.entries()].map(([opinionId, edges]) => [opinionId, new Map(edges)])
  );
}

function countGraphEdges(adjacency: Map<string, Map<string, number>>): number {
  return [...adjacency.values()].reduce((sum, edges) => sum + edges.size, 0) / 2;
}

function finalizeGraphBuilderArtifact(options: {
  graphId: string;
  method: GraphBuilderSummary["method"];
  label: string;
  neighborK: number;
  opinionIds: string[];
  adjacency: Map<string, Map<string, number>>;
  baseGraphId?: string;
  repairedEdgeCount?: number;
  repairStrategy?: string;
}): GraphBuilderArtifact {
  const edgeCount = countGraphEdges(options.adjacency);
  const possibleEdgeCount = chooseTwo(options.opinionIds.length);
  const weightedDegreeSum = [...options.adjacency.values()].reduce(
    (sum, edges) =>
      sum + [...edges.values()].reduce((edgeSum, weight) => edgeSum + weight, 0),
    0
  );
  const summary: GraphBuilderSummary = {
    graphId: options.graphId,
    method: options.method,
    label: options.label,
    neighborK: options.neighborK,
    nodeCount: options.opinionIds.length,
    edgeCount,
    density: roundMetric(safeRatio(edgeCount, possibleEdgeCount)),
    isolatedNodeCount: [...options.adjacency.values()].filter((edges) => edges.size === 0).length,
    averageWeightedDegree: roundMetric(safeRatio(weightedDegreeSum, Math.max(1, options.opinionIds.length))),
    ...(options.baseGraphId === undefined ? {} : { baseGraphId: options.baseGraphId }),
    ...(options.repairedEdgeCount === undefined ? {} : { repairedEdgeCount: options.repairedEdgeCount }),
    ...(options.repairStrategy === undefined ? {} : { repairStrategy: options.repairStrategy })
  };

  return {
    graphId: options.graphId,
    method: options.method,
    label: options.label,
    neighborK: options.neighborK,
    opinionIds: [...options.opinionIds],
    adjacency: options.adjacency,
    summary
  };
}

function buildGraphClusteringSurface(options: {
  graph: GraphBuilderArtifact;
  clusterCount: number;
  embeddingsById: Map<string, EmbeddingArtifact>;
  neighborK: number;
  runId: string;
}): ClusteringSurfaceWorkingSet {
  const opinionIds = options.graph.opinionIds.filter((opinionId) =>
    options.embeddingsById.has(opinionId)
  );
  const effectiveClusterCount = Math.max(1, Math.min(options.clusterCount, opinionIds.length));
  const clusterById = new Map<string, number>();

  if (opinionIds.length === 1) {
    const onlyOpinionId = opinionIds[0];

    if (onlyOpinionId !== undefined) {
      clusterById.set(onlyOpinionId, 0);
    }
  } else if (opinionIds.length > 1) {
    const vectors = buildGraphFeatureVectors(opinionIds, options.graph.adjacency);
    const result = kmeans(vectors, effectiveClusterCount, {
      seed: positiveIntegerSeed(
        `graph-surface:${options.runId}:${options.graph.graphId}:k${options.clusterCount}`
      ),
      initialization: "kmeans++",
      maxIterations: 100
    });

    opinionIds.forEach((opinionId, index) => {
      clusterById.set(opinionId, result.clusters[index] ?? 0);
    });
  }

  return {
    summary: summarizeClusteringSurface({
      surfaceId: `graph-${options.graph.graphId}-k${options.clusterCount}`,
      surfaceKind: "graph",
      label: `${options.graph.label}, clusters=${options.clusterCount}`,
      method: "graph-adjacency-kmeans",
      status: opinionIds.length === 0 ? "failed" : "ready",
      requestedClusterCount: options.clusterCount,
      effectiveClusterCount,
      clusterById,
      embeddingsById: options.embeddingsById,
      neighborK: options.neighborK
    }),
    clusterById
  };
}

function buildGraphFeatureVectors(
  opinionIds: string[],
  adjacency: Map<string, Map<string, number>>
): number[][] {
  const indexByOpinionId = new Map(opinionIds.map((opinionId, index) => [opinionId, index]));

  return opinionIds.map((opinionId, rowIndex) => {
    const vector = new Array(opinionIds.length).fill(0) as number[];
    vector[rowIndex] = 1;

    for (const [neighborId, weight] of adjacency.get(opinionId)?.entries() ?? []) {
      const neighborIndex = indexByOpinionId.get(neighborId);

      if (neighborIndex !== undefined) {
        vector[neighborIndex] = weight;
      }
    }

    return vector;
  });
}

function serializeGraphBuilderArtifact(graph: GraphBuilderArtifact): {
  graphId: string;
  method: GraphBuilderSummary["method"];
  label: string;
  neighborK: number;
  summary: GraphBuilderSummary;
  nodes: string[];
  edges: Array<{ leftOpinionId: string; rightOpinionId: string; weight: number }>;
} {
  const edges: Array<{ leftOpinionId: string; rightOpinionId: string; weight: number }> = [];

  for (const [leftOpinionId, neighbors] of graph.adjacency.entries()) {
    for (const [rightOpinionId, weight] of neighbors.entries()) {
      if (leftOpinionId < rightOpinionId) {
        edges.push({
          leftOpinionId,
          rightOpinionId,
          weight: roundMetric(weight)
        });
      }
    }
  }

  edges.sort(
    (left, right) =>
      left.leftOpinionId.localeCompare(right.leftOpinionId) ||
      left.rightOpinionId.localeCompare(right.rightOpinionId)
  );

  return {
    graphId: graph.graphId,
    method: graph.method,
    label: graph.label,
    neighborK: graph.neighborK,
    summary: graph.summary,
    nodes: [...graph.opinionIds],
    edges
  };
}

function serializeClusteringSurfaceAssignments(surface: ClusteringSurfaceWorkingSet): {
  surface: ClusteringSurfaceSummary;
  assignments: Array<{ opinionId: string; clusterId: number }>;
} {
  return {
    surface: surface.summary,
    assignments: [...surface.clusterById.entries()]
      .map(([opinionId, clusterId]) => ({
        opinionId,
        clusterId
      }))
      .sort(
        (left, right) =>
          left.clusterId - right.clusterId || left.opinionId.localeCompare(right.opinionId)
      )
  };
}

function buildGraphBuilderObservations(summary: GraphBuilderEvaluationArtifact): string[] {
  const observations: string[] = [];
  const graphSurfaces = summary.surfaces.filter(
    (surface) => surface.surfaceKind === "graph" && surface.embeddingNeighborPurityAtK !== null
  );
  const bestGraphSurface = [...graphSurfaces].sort(
    (left, right) =>
      (right.embeddingNeighborPurityAtK ?? -1) - (left.embeddingNeighborPurityAtK ?? -1)
  )[0];
  const nonGraphSurfaces = summary.surfaces.filter(
    (surface) => surface.surfaceKind !== "graph" && surface.embeddingNeighborPurityAtK !== null
  );
  const bestNonGraphSurface = [...nonGraphSurfaces].sort(
    (left, right) =>
      (right.embeddingNeighborPurityAtK ?? -1) - (left.embeddingNeighborPurityAtK ?? -1)
  )[0];

  if (bestGraphSurface !== undefined) {
    observations.push(
      `${bestGraphSurface.label} was the strongest graph clustering surface at embedding-neighbor purity ${formatMetric(bestGraphSurface.embeddingNeighborPurityAtK)}.`
    );
  }

  if (bestGraphSurface !== undefined && bestNonGraphSurface !== undefined) {
    const graphPurity = bestGraphSurface.embeddingNeighborPurityAtK ?? 0;
    const baselinePurity = bestNonGraphSurface.embeddingNeighborPurityAtK ?? 0;

    observations.push(
      graphPurity > baselinePurity
        ? `Best graph clustering beat the best existing non-graph surface (${formatMetric(graphPurity)} vs ${formatMetric(baselinePurity)}).`
        : `Best graph clustering did not beat the best existing non-graph surface (${formatMetric(graphPurity)} vs ${formatMetric(baselinePurity)}).`
    );
  }

  const disconnectedGraphs = summary.graphs.filter((graph) => graph.isolatedNodeCount > 0);

  if (disconnectedGraphs.length > 0) {
    const previewLabels = disconnectedGraphs
      .slice(0, 6)
      .map((graph) => graph.label)
      .join(", ");
    const remainingCount = disconnectedGraphs.length - Math.min(6, disconnectedGraphs.length);

    observations.push(
      `${previewLabels}${remainingCount > 0 ? `, and ${remainingCount} more` : ""} produced isolated nodes; this can make graph clustering brittle.`
    );
  }

  const repairedGraphs = summary.graphs.filter((graph) => graph.method === "mutual-knn-repaired");

  if (repairedGraphs.length > 0) {
    const repairedWithoutIsolates = repairedGraphs.filter((graph) => graph.isolatedNodeCount === 0).length;
    const repairedEdgeCount = repairedGraphs.reduce(
      (sum, graph) => sum + (graph.repairedEdgeCount ?? 0),
      0
    );

    observations.push(
      `Repaired mutual kNN removed isolated nodes in ${repairedWithoutIsolates} of ${repairedGraphs.length} graph-k settings by adding ${repairedEdgeCount} nearest-neighbor backfill edge(s).`
    );
  }

  const surfaceById = new Map(summary.surfaces.map((surface) => [surface.surfaceId, surface]));
  const lowAgreementGraphComparisons = summary.comparisons.filter((comparison) => {
    const left = surfaceById.get(comparison.leftSurfaceId);
    const right = surfaceById.get(comparison.rightSurfaceId);

    return (
      left !== undefined &&
      right !== undefined &&
      (left.surfaceKind === "graph" || right.surfaceKind === "graph") &&
      left.surfaceKind !== right.surfaceKind &&
      left.requestedClusterCount === right.requestedClusterCount &&
      comparison.adjustedRandIndex !== null &&
      comparison.adjustedRandIndex < 0.5
    );
  });

  if (lowAgreementGraphComparisons.length > 0) {
    observations.push(
      `${lowAgreementGraphComparisons.length} graph-vs-baseline comparison(s) with matching cluster counts had ARI below 0.5.`
    );
  }

  return observations;
}

function renderGraphBuilderConsoleSummary(
  projectRoot: string,
  outputPath: string,
  summary: GraphBuilderEvaluationArtifact
): string {
  const surfaceById = new Map(summary.surfaces.map((surface) => [surface.surfaceId, surface]));
  const graphSurfaces = summary.surfaces.filter((surface) => surface.surfaceKind === "graph");
  const disconnectedGraphCount = summary.graphs.filter((graph) => graph.isolatedNodeCount > 0).length;
  const repairedGraphs = summary.graphs.filter((graph) => graph.method === "mutual-knn-repaired");
  const topGraphSurfaces = [...graphSurfaces]
    .sort(
      (left, right) =>
        (right.embeddingNeighborPurityAtK ?? -1) - (left.embeddingNeighborPurityAtK ?? -1) ||
        (right.embeddingSilhouette ?? -1) - (left.embeddingSilhouette ?? -1) ||
        left.label.localeCompare(right.label)
    )
    .slice(0, 10);
  const graphComparisons = summary.comparisons.filter((comparison) => {
    const left = surfaceById.get(comparison.leftSurfaceId);
    const right = surfaceById.get(comparison.rightSurfaceId);

    return (
      left !== undefined &&
      right !== undefined &&
      (left.surfaceKind === "graph" || right.surfaceKind === "graph") &&
      left.surfaceKind !== right.surfaceKind &&
      left.requestedClusterCount === right.requestedClusterCount
    );
  });
  const lines = [
    color.heading("Broadly Graph Builder Evaluation"),
    color.muted(rule("=")),
    formatDetailLine("Project", projectRoot),
    formatDetailLine("Run", summary.runId),
    formatDetailLine(
      "Corpus",
      `${summary.corpus.comparableOpinionCount} comparable opinions · ${summary.corpus.embeddingCount} embeddings`
    ),
    formatDetailLine(
      "Graphs",
      `${summary.corpus.graphCount} builders · ${summary.corpus.graphSurfaceCount} graph surfaces`
    ),
    formatDetailLine(
      "Graph k sweep",
      summary.parameters.graphNeighborKs.length === 0
        ? "(none)"
        : summary.parameters.graphNeighborKs.join(", ")
    ),
    formatDetailLine("Isolated variants", `${disconnectedGraphCount} of ${summary.graphs.length}`),
    ...repairedGraphs.map((graph) =>
      formatDetailLine(
        graph.label,
        `${graph.edgeCount} edges · density ${formatMetric(graph.density)} · isolated ${graph.isolatedNodeCount} · repaired edges ${graph.repairedEdgeCount ?? 0}`
      )
    ),
    ...topGraphSurfaces.map((surface) =>
      formatDetailLine(
        surface.label,
        `purity ${formatMetric(surface.embeddingNeighborPurityAtK)} · silhouette ${formatMetric(surface.embeddingSilhouette)}`
      )
    ),
    ...graphComparisons.slice(0, 6).map((comparison) =>
      formatDetailLine(
        "Compare",
        `${comparison.leftLabel} vs ${comparison.rightLabel}: ARI ${formatMetric(comparison.adjustedRandIndex)}`
      )
    ),
    ...summary.observations.map((observation) => formatDetailLine("Note", observation)),
    formatDetailLine("Output", toPortableRelativePath(projectRoot, outputPath))
  ];

  return `\n${lines.join("\n")}\n`;
}

function cosineDistanceToGraphWeight(distance: number): number {
  return Number.isFinite(distance) ? 1 / (1 + Math.max(0, distance)) : 0;
}

function graphEdgeKey(leftId: string, rightId: string): string {
  return leftId < rightId ? `${leftId}:${rightId}` : `${rightId}:${leftId}`;
}

function countSetIntersection<T>(left: Set<T>, right: Set<T>): number {
  let count = 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];

  for (const value of smaller) {
    if (larger.has(value)) {
      count += 1;
    }
  }

  return count;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[midpoint] ?? null;
  }

  const left = sorted[midpoint - 1];
  const right = sorted[midpoint];

  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function quantile(values: number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }

  if (values.length === 1) {
    return values[0] ?? null;
  }

  const position = (values.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = values[lowerIndex];
  const upper = values[upperIndex];

  if (lower === undefined || upper === undefined) {
    return null;
  }

  return lower + (upper - lower) * (position - lowerIndex);
}

function chooseTwo(value: number): number {
  return value < 2 ? 0 : (value * (value - 1)) / 2;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function roundNullable(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : roundMetric(value);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function resolveConfiguredEmbeddingModel(
  config: BroadlyProjectConfig,
  explicitModelAlias: string | undefined,
  analysisViews: AnalysisViewConfig[]
): RegisteredModel {
  const configuredAlias = explicitModelAlias ?? analysisViews[0]?.embeddingModel;

  if (configuredAlias === undefined || configuredAlias.trim().length === 0) {
    throw new Error(
      "No embedding model is configured. Set embeddingModel on the configured analysis views or pass --embedding-model."
    );
  }

  return resolveModel(config, configuredAlias);
}

function resolveConfiguredExtractionModel(
  config: BroadlyProjectConfig,
  analysisViews: AnalysisViewConfig[]
): RegisteredModel {
  const firstView = analysisViews[0];

  if (firstView === undefined) {
    throw new Error("No analysis views are configured in broadly.yaml.");
  }

  const extraction = getOpinionExtractionConfig(config, firstView.sourceExtraction);
  const configuredAlias = extraction.model;

  if (configuredAlias === undefined || configuredAlias.trim().length === 0) {
    throw new Error(
      "No opinion extraction model is configured for the selected analysis views."
    );
  }

  return resolveModel(config, configuredAlias);
}

function resolveConfiguredAnalysisModel(
  config: BroadlyProjectConfig,
  analysisViews: AnalysisViewConfig[]
): RegisteredModel {
  const configuredAlias = analysisViews[0]?.analysisModel ?? resolveConfiguredExtractionModel(config, analysisViews).name;

  if (configuredAlias === undefined || configuredAlias.trim().length === 0) {
    throw new Error(
      "No analysis model is configured for the selected analysis views."
    );
  }

  return resolveModel(config, configuredAlias);
}

function resolveModel(config: BroadlyProjectConfig, alias: string): RegisteredModel {
  const model = config.models.find((item) => item.name === alias);

  if (model === undefined) {
    throw new Error(`No model alias named '${alias}' is registered in this project.`);
  }

  return model;
}

function resolveConfiguredAnalysisViews(
  config: BroadlyProjectConfig,
  explicitEmbeddingModelAlias: string | undefined
): AnalysisViewConfig[] {
  if (config.analysisViews.length === 0) {
    throw new Error("No analysis views are configured in broadly.yaml.");
  }

  const views =
    explicitEmbeddingModelAlias === undefined
      ? config.analysisViews
      : config.analysisViews.filter((view) => view.embeddingModel === explicitEmbeddingModelAlias);

  if (views.length === 0) {
    throw new Error(
      `No configured analysis views use embedding model '${explicitEmbeddingModelAlias}'.`
    );
  }

  return views;
}

function resolveAnalysisModelForView(
  config: BroadlyProjectConfig,
  view: AnalysisViewConfig
): RegisteredModel {
  return resolveModel(
    config,
    view.analysisModel ?? getOpinionExtractionConfig(config, view.sourceExtraction).model
  );
}

async function resolveAnalysisViewGroups(options: {
  config: BroadlyProjectConfig;
  projectPaths: ReturnType<typeof resolveProjectPaths>;
  projectRoot: string;
  reviewConfig: ReviewConfig;
  resolvedViews: ResolvedAnalysisView[];
  currentOpinionRunId: string | null;
  offset: number;
  limit?: number;
}): Promise<AnalysisViewGroup[]> {
  const groupedViews = new Map<string, ResolvedAnalysisView[]>();

  for (const resolvedView of options.resolvedViews) {
    const key = `${resolvedView.view.sourceExtraction}::${resolvedView.view.embeddingModel}`;
    const existing = groupedViews.get(key) ?? [];
    existing.push(resolvedView);
    groupedViews.set(key, existing);
  }

  const groups: AnalysisViewGroup[] = [];

  for (const [key, views] of groupedViews.entries()) {
    const firstView = views[0];

    if (firstView === undefined) {
      continue;
    }

    const sourceExtraction = getOpinionExtractionConfig(options.config, firstView.view.sourceExtraction);
    const extractionModel = resolveModel(options.config, sourceExtraction.model);
    const embeddingModel = resolveModel(options.config, firstView.view.embeddingModel);
    const latestOpinionRun =
      (options.currentOpinionRunId === null
        ? null
        : await findOpinionRunById(
            path.join(options.projectPaths.dataDir, "opinions"),
            options.currentOpinionRunId,
            sourceExtraction.name,
            extractionModel
          )) ??
      (await findLatestOpinionRunForModel(
        path.join(options.projectPaths.dataDir, "opinions"),
        sourceExtraction.name,
        extractionModel
      ));

    if (latestOpinionRun === null) {
      throw new Error(
        `No opinion run found for extraction '${sourceExtraction.name}' using model '${extractionModel.name}'. Run broadly opinions first.`
      );
    }

    const opinionsRunDir = path.join(options.projectPaths.dataDir, "opinions", latestOpinionRun.runId);
    const opinionsDir = path.join(opinionsRunDir, "opinions");
    const allOpinionPaths = await listOpinionArtifactPaths(opinionsDir);
    const effectiveStatusCounts = createEmptyReviewStatusCounts();
    const filteredOpinionPaths: string[] = [];

    for (const opinionPath of allOpinionPaths) {
      const opinionId = path.basename(opinionPath, ".json");
      const opinionArtifact = await readJsonFile<OpinionArtifact>(opinionPath);

      if (opinionArtifact === null || typeof opinionArtifact.sourceId !== "string") {
        effectiveStatusCounts.included += 1;
        filteredOpinionPaths.push(opinionPath);
        continue;
      }

      const [commentReview, opinionReview] = await Promise.all([
        loadCommentReview(options.projectPaths, opinionArtifact.sourceId),
        loadOpinionReview(options.projectPaths, opinionId)
      ]);
      const resolvedReview = resolveEffectiveOpinionReviewStatus({
        commentReview,
        opinionReview
      });

      effectiveStatusCounts[resolvedReview.status] += 1;

      if (
        countIncludedReviewStatuses(
          options.reviewConfig,
          resolvedReview.source,
          resolvedReview.status
        )
      ) {
        filteredOpinionPaths.push(opinionPath);
      }
    }

    const selectedOpinionPaths = filteredOpinionPaths.slice(
      options.offset,
      options.limit === undefined ? undefined : options.offset + options.limit
    );
    const embeddingsDir = path.join(
      options.projectPaths.dataDir,
      "embeddings",
      sourceExtraction.name,
      embeddingModel.name
    );

    groups.push({
      key,
      sourceExtraction,
      extractionModel,
      embeddingModel,
      views,
      opinionRunId: latestOpinionRun.runId,
      opinionsRunDir,
      opinionsDir,
      selectedOpinionPaths,
      review: {
        totalOpinionCount: allOpinionPaths.length,
        selectedOpinionCount: selectedOpinionPaths.length,
        excludedOpinionCount: allOpinionPaths.length - filteredOpinionPaths.length,
        effectiveStatusCounts
      },
      embeddingsDir,
      embeddingsManifestPath: path.join(embeddingsDir, "manifest.json")
    });
  }

  return groups.sort((left, right) => left.key.localeCompare(right.key));
}

function createAnalysisRunId(embeddingModelName: string): string {
  return `${formatRunTimestamp(new Date())}-${embeddingModelName}`;
}

function buildDefaultViewTitle(view: AnalysisViewConfig): string {
  if (view.reduction.method === "pacmap") {
    return view.mode === "dissent" ? "Dissenting PaCMAP View" : "PaCMAP Comparison View";
  }

  return view.mode === "dissent" ? "Dissenting Viewpoints" : "Balanced Overview";
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumberList(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function createEmptyReviewStatusCounts(): ReviewStatusCounts {
  return {
    included: 0,
    "excluded-non-substantive": 0,
    "excluded-off-topic": 0,
    "excluded-admin": 0,
    "excluded-duplicate": 0
  };
}

function mergeReviewStatusCounts(
  left: ReviewStatusCounts,
  right: ReviewStatusCounts
): ReviewStatusCounts {
  const merged = createEmptyReviewStatusCounts();

  for (const key of Object.keys(merged) as ReviewStatus[]) {
    merged[key] = (left[key] ?? 0) + (right[key] ?? 0);
  }

  return merged;
}

function extractExcludedReviewStatusCounts(counts: ReviewStatusCounts): ReviewStatusCounts {
  return {
    included: 0,
    "excluded-non-substantive": counts["excluded-non-substantive"] ?? 0,
    "excluded-off-topic": counts["excluded-off-topic"] ?? 0,
    "excluded-admin": counts["excluded-admin"] ?? 0,
    "excluded-duplicate": counts["excluded-duplicate"] ?? 0
  };
}

function formatExcludedReviewStatusCounts(counts: ReviewStatusCounts): string {
  const parts = (Object.entries(counts) as Array<[ReviewStatus, number]>)
    .filter(([status, count]) => status !== "included" && count > 0)
    .map(([status, count]) => `${status}=${count}`);

  return parts.length === 0 ? "none" : parts.join(" · ");
}

function formatIncludedReviewStatuses(statuses: ReviewStatus[]): string {
  return statuses.length === 0 ? "none" : statuses.join(", ");
}

function countIncludedReviewStatuses(
  reviewConfig: ReviewConfig,
  effectiveStatusSource: "default" | "comment" | "opinion",
  status: ReviewStatus
): boolean {
  if (effectiveStatusSource === "comment") {
    return reviewConfig.analysis.includeCommentStatuses.includes(status);
  }

  return reviewConfig.analysis.includeOpinionStatuses.includes(status);
}

function formatRunTimestamp(value: Date): string {
  return [
    `${value.getFullYear()}-${padRunTimestampPart(value.getMonth() + 1)}-${padRunTimestampPart(value.getDate())}`,
    `${padRunTimestampPart(value.getHours())}-${padRunTimestampPart(value.getMinutes())}-${padRunTimestampPart(value.getSeconds())}-${padRunTimestampPart(value.getMilliseconds(), 3)}`
  ].join("_");
}

function padRunTimestampPart(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

async function buildReductionArtifact(
  method: string,
  items: Array<{ opinion: OpinionArtifact; embedding: EmbeddingArtifact }>,
  runId: string
): Promise<ReductionArtifact> {
  const createdAt = new Date().toISOString();

  if (items.length === 0) {
    return {
      createdAt,
      method,
      dimensions: 2,
      status: "failed",
      message: "No usable embeddings were available for reduction.",
      pointCount: 0,
      points: []
    };
  }

  if (method !== "umap" && method !== "pacmap") {
    return {
      createdAt,
      method,
      dimensions: 2,
      status: "failed",
      message: `Unsupported reduction method '${method}'.`,
      pointCount: 0,
      points: []
    };
  }

  const embeddingVectors = items.map((item) => item.embedding.vector);

  try {
    const coordinates =
      items.length <= 2
        ? buildTrivialReductionPoints(items.length)
        : method === "umap"
          ? reduceWithUmap(embeddingVectors, runId)
          : await reduceWithPacmap(
              items.map((item) => item.opinion.opinionId),
              embeddingVectors,
              runId
            );

    return {
      createdAt,
      method,
      dimensions: 2,
      status: "ready",
      pointCount: items.length,
      points: items.map((item, index) => {
        const coordinate = coordinates[index];

        if (coordinate === undefined || coordinate.length < 2) {
          throw new Error(`Reduction '${method}' returned incomplete coordinates.`);
        }

        return {
          opinionId: item.opinion.opinionId,
          x: coordinate[0] ?? 0,
          y: coordinate[1] ?? 0
        };
      })
    };
  } catch (error) {
    return {
      createdAt,
      method,
      dimensions: 2,
      status: error instanceof PacmapUnavailableError ? "unavailable" : "failed",
      message: error instanceof Error ? error.message : String(error),
      pointCount: 0,
      points: []
    };
  }
}

function reduceWithUmap(vectors: number[][], runId: string): number[][] {
  const reducer = new UMAP({
    nComponents: 2,
    nNeighbors: Math.max(2, Math.min(15, vectors.length - 1)),
    minDist: 0.1,
    distanceFn: cosineDistance,
    random: createSeededRandom(`umap:${runId}`)
  });

  return reducer.fit(vectors);
}

async function reduceWithPacmap(
  opinionIds: string[],
  vectors: number[][],
  runId: string
): Promise<number[][]> {
  const workDir = await mkdirTemporaryPacmapDir();
  const inputPath = path.join(workDir, "input.json");
  const outputPath = path.join(workDir, "output.json");
  const scriptPath = resolvePacmapWrapperScriptPath();
  const nNeighbors = Math.max(2, Math.min(15, vectors.length - 1));
  const randomState = positiveIntegerSeed(`pacmap:${runId}`);

  try {
    await writeFile(
      inputPath,
      `${JSON.stringify(
        {
          opinionIds,
          vectors,
          nNeighbors,
          mnRatio: 0.5,
          fpRatio: 2.0,
          distance: "angular",
          randomState,
          applyPca: true
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await execPacmapWrapper(scriptPath, inputPath, outputPath);

    const output = JSON.parse(await readFile(outputPath, "utf8")) as {
      points?: Array<{ opinionId?: string; x?: number; y?: number }>;
    };
    const pointByOpinionId = new Map(
      (output.points ?? [])
        .filter(
          (point): point is { opinionId: string; x: number; y: number } =>
            typeof point.opinionId === "string" &&
            typeof point.x === "number" &&
            typeof point.y === "number"
        )
        .map((point) => [point.opinionId, [point.x, point.y] as [number, number]])
    );

    return opinionIds.map((opinionId) => {
      const point = pointByOpinionId.get(opinionId);

      if (point === undefined) {
        throw new Error(`PaCMAP output did not include coordinates for opinion '${opinionId}'.`);
      }

      return point;
    });
  } finally {
    await removeDirectory(workDir);
  }
}

async function execPacmapWrapper(
  scriptPath: string,
  inputPath: string,
  outputPath: string
): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const pythonCandidates = [
    path.join(repoRoot, ".venv-pacmap", "bin", "python"),
    "python3",
    "python"
  ];
  let lastError: Error | null = null;

  for (const executable of pythonCandidates) {
    try {
      await execFile(executable, [scriptPath, inputPath, outputPath], {
        maxBuffer: 10 * 1024 * 1024
      });
      return;
    } catch (error) {
      if (isMissingExecutableError(error)) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }

      const stderr = readExecStderr(error);
      if (
        stderr.includes("MISSING_MODULE:pacmap") ||
        stderr.includes("MISSING_MODULE:numpy")
      ) {
        throw new PacmapUnavailableError(
          "PaCMAP requires Python with the `pacmap` and `numpy` packages installed. Try `python3 -m pip install pacmap numpy`."
        );
      }

      throw new Error(
        `PaCMAP wrapper failed: ${stderr.length === 0 ? error instanceof Error ? error.message : String(error) : stderr}`
      );
    }
  }

  throw new PacmapUnavailableError(
    `Could not find a usable Python interpreter. Tried ${pythonCandidates.join(", ")}.`
  );
}

async function mkdirTemporaryPacmapDir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(os.tmpdir(), "broadly-pacmap-"));
}

async function removeDirectory(directoryPath: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(directoryPath, { recursive: true, force: true });
}

function resolvePacmapWrapperScriptPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../scripts/pacmap_reduce.py"
  );
}

function isMissingExecutableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function readExecStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const stderr = (error as { stderr?: string | Buffer }).stderr;
  if (typeof stderr === "string") {
    return stderr.trim();
  }
  if (stderr instanceof Buffer) {
    return stderr.toString("utf8").trim();
  }

  return error instanceof Error ? error.message : String(error);
}

function buildTrivialReductionPoints(count: number): number[][] {
  if (count <= 0) {
    return [];
  }

  if (count === 1) {
    return [[0, 0]];
  }

  return [
    [-0.5, 0],
    [0.5, 0]
  ];
}

function cosineDistance(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 1;
  }

  return 1 - dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function buildClusterArtifact(
  reduction: ReductionArtifact,
  sourceReductionPath: string,
  requestedClusterCount: number,
  runId: string,
  opinionsById: Map<string, OpinionArtifact>
): ClusterArtifact {
  const createdAt = new Date().toISOString();

  if (reduction.points.length === 0) {
    return {
      createdAt,
      method: reduction.method,
      requestedClusterCount,
      effectiveClusterCount: 0,
      status: "skipped",
      message: "No reduced points were available for clustering.",
      sourceReductionPath,
      labeling: {
        method: "heuristic-fallback",
        createdAt
      },
      members: [],
      clusters: []
    };
  }

  if (reduction.points.length === 1) {
    const firstPoint = reduction.points[0];

    if (firstPoint === undefined) {
      throw new Error("Expected one reduced point but none were present.");
    }

    const summary = summarizeClusterLabel([firstPoint.opinionId], opinionsById, 0);

    return {
      createdAt,
      method: reduction.method,
      requestedClusterCount,
      effectiveClusterCount: 1,
      status: "ready",
      sourceReductionPath,
      labeling: {
        method: "heuristic-fallback",
        createdAt
      },
      members: [
        {
          opinionId: firstPoint.opinionId,
          clusterId: 0,
          x: firstPoint.x,
          y: firstPoint.y
        }
      ],
      clusters: [
        {
          clusterId: 0,
          size: 1,
          centroid: [firstPoint.x, firstPoint.y],
          label: summary.label,
          topTerms: summary.topTerms,
          summary: summary.summary,
          representativeOpinions: summary.representativeOpinions
        }
      ]
    };
  }

  const effectiveClusterCount = Math.max(
    1,
    Math.min(requestedClusterCount, reduction.points.length)
  );
  const data = reduction.points.map((point) => [point.x, point.y]);

  try {
    const result = kmeans(data, effectiveClusterCount, {
      seed: positiveIntegerSeed(`kmeans:${runId}:${reduction.method}:k${requestedClusterCount}`),
      initialization: "kmeans++",
      maxIterations: 100
    });
    const members = reduction.points.map((point, index) => ({
      opinionId: point.opinionId,
      clusterId: result.clusters[index] ?? 0,
      x: point.x,
      y: point.y
    }));
    const clusterMap = new Map<number, ClusterMember[]>();

    for (const member of members) {
      const group = clusterMap.get(member.clusterId) ?? [];
      group.push(member);
      clusterMap.set(member.clusterId, group);
    }

    const clusters = [...clusterMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([clusterId, group]) => {
        const centroid = computeCentroid(group);
        const summary = summarizeCluster(
          group,
          centroid,
          opinionsById,
          clusterId
        );

        return {
          clusterId,
          size: group.length,
          centroid,
          label: summary.label,
          topTerms: summary.topTerms,
          summary: summary.summary,
          representativeOpinions: summary.representativeOpinions
        };
      });

    return {
      createdAt,
      method: reduction.method,
      requestedClusterCount,
      effectiveClusterCount,
      status: "ready",
      sourceReductionPath,
      labeling: {
        method: "heuristic-fallback",
        createdAt
      },
      members,
      clusters
    };
  } catch (error) {
    return {
      createdAt,
      method: reduction.method,
      requestedClusterCount,
      effectiveClusterCount,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      sourceReductionPath,
      labeling: {
        method: "heuristic-fallback",
        createdAt,
        error: error instanceof Error ? error.message : String(error)
      },
      members: [],
      clusters: []
    };
  }
}

async function buildPerspectivePlanArtifact(
  view: AnalysisViewConfig,
  clusterArtifactPaths: string[],
  options: {
    analysisModel: RegisteredModel;
    projectRoot: string;
    promptPath: string;
    promptSha256: string;
    promptTemplate: string;
    guidingQuestions: string[];
  }
): Promise<PerspectivePlanArtifact> {
  const createdAt = new Date().toISOString();
  const clusterArtifacts = (
    await Promise.all(
      clusterArtifactPaths.map(async (artifactPath) => ({
        artifactPath,
        artifact: await readJsonFile<ClusterArtifact>(artifactPath)
      }))
    )
  )
    .filter(
      (item): item is { artifactPath: string; artifact: ClusterArtifact } =>
        item.artifact !== null &&
        item.artifact.status === "ready" &&
        item.artifact.labeling.method === "llm-cluster-labeling"
    )
    .sort((a, b) => {
      if (a.artifact.method !== b.artifact.method) {
        return a.artifact.method.localeCompare(b.artifact.method);
      }

      return a.artifact.requestedClusterCount - b.artifact.requestedClusterCount;
    });

  if (clusterArtifacts.length === 0) {
    return {
      createdAt,
      viewName: view.name,
      ...(view.title === undefined ? {} : { viewTitle: view.title }),
      mode: view.mode,
      status: "unavailable",
      synthesis: {
        method: "heuristic-fallback",
        createdAt
      },
      title: view.title ?? buildDefaultViewTitle(view),
      summary: "No cluster highlights were available for this view.",
      highlights: [],
      rationale: "No ready cluster artifacts were available to plan this view."
    };
  }

  const chosen =
    clusterArtifacts.find(
      (item) =>
        item.artifact.method === view.reduction.method &&
        item.artifact.requestedClusterCount === view.clustering.count
    ) ??
    clusterArtifacts[0];

  if (chosen === undefined) {
    return {
      createdAt,
      viewName: view.name,
      ...(view.title === undefined ? {} : { viewTitle: view.title }),
      mode: view.mode,
      status: "unavailable",
      synthesis: {
        method: "heuristic-fallback",
        createdAt
      },
      title: view.title ?? buildDefaultViewTitle(view),
      summary: "No cluster highlights were available for this view.",
      highlights: [],
      rationale: "No ready cluster artifacts were available to plan this view."
    };
  }

  const graphExperiment = chosen.artifact.experimental;
  const excludedClusterIds = findGraphRemainderClusterIds(chosen.artifact);
  const excludedClusterIdSet = new Set(excludedClusterIds);
  const highlightCandidates =
    excludedClusterIds.length === 0
      ? chosen.artifact.clusters
      : chosen.artifact.clusters.filter(
          (cluster) => !excludedClusterIdSet.has(cluster.clusterId)
        );
  const highlights = [...highlightCandidates]
    .sort((left, right) =>
      view.mode === "dissent"
        ? left.size - right.size || left.clusterId - right.clusterId
        : right.size - left.size || left.clusterId - right.clusterId
    )
    .slice(0, 4)
    .map((cluster) => ({
      clusterId: cluster.clusterId,
      label: cluster.label,
      size: cluster.size,
      summary: cluster.summary,
      representativeOpinions: cluster.representativeOpinions
    }));
  const title = view.title ?? buildDefaultViewTitle(view);
  const summary =
    highlights.length === 0
      ? "No cluster highlights were available for this view."
      : graphExperiment !== undefined
        ? `This semantic-neighborhood perspective uses repaired mutual-kNN graph membership instead of projection-space cluster membership. It foregrounds ${highlights
            .slice(0, 3)
            .map((item) => item.label)
            .join(", ")}.`
      : view.mode === "dissent"
        ? `This perspective looks for narrower or minority clusters that could be drowned out in a broad summary. It foregrounds ${highlights
            .slice(0, 3)
            .map((item) => item.label)
            .join(", ")}.`
        : view.reduction.method === "pacmap"
          ? `This perspective uses the PaCMAP reduction to provide an alternate map of the same opinion set. It foregrounds ${highlights
              .slice(0, 3)
              .map((item) => item.label)
              .join(", ")}.`
        : `This perspective favors the larger clusters in the map and uses them as the primary reading of the corpus. It foregrounds ${highlights
            .slice(0, 3)
            .map((item) => item.label)
            .join(", ")}.`;

  const heuristicPerspective: PerspectivePlanArtifact = {
    createdAt,
    viewName: view.name,
    ...(view.title === undefined ? {} : { viewTitle: view.title }),
    mode: view.mode,
    status: "ready",
    synthesis: {
      method: "heuristic-fallback",
      createdAt
    },
    chosenClusterArtifactPath: chosen.artifactPath,
    chosenReductionMethod: chosen.artifact.method,
    chosenClusterCount: chosen.artifact.effectiveClusterCount,
    title,
    summary,
    highlights,
    rationale:
      graphExperiment !== undefined
        ? `Use ${graphExperiment.graphSurfaceLabel} as a semantic-neighborhood view because it preserves local embedding neighborhoods while using ${path.basename(graphExperiment.displayReductionPath)} only for display coordinates.${
            excludedClusterIds.length === 0
              ? ""
              : ` Mixed/general remainder clusters (${excludedClusterIds
                  .map((clusterId) => `#${clusterId}`)
                  .join(", ")}) are held out of highlights and semantic themes.`
          }`
        : view.mode === "dissent"
        ? "Prefer the higher cluster count to preserve narrower pockets of disagreement and minority viewpoints."
        : view.reduction.method === "pacmap"
          ? "Prefer the PaCMAP reduction with the broader cluster count so the report can compare a second map geometry against the primary UMAP view."
        : "Prefer the lower cluster count to produce a broader reading that should still surface strong consensus where it exists.",
    ...(graphExperiment === undefined
      ? {}
      : {
          experimental: {
            kind: "graph-surface",
            sourceSurfaceId: graphExperiment.sourceSurfaceId,
            ...(excludedClusterIds.length === 0 ? {} : { excludedClusterIds })
          }
        })
  };

  return summarizePerspectiveWithLlm(heuristicPerspective, chosen.artifact, options);
}

async function labelClusterArtifactWithLlm(options: {
  artifact: ClusterArtifact;
  artifactPath: string;
  analysisModel: RegisteredModel;
  projectRoot: string;
  promptPath: string;
  promptSha256: string;
  promptTemplate: string;
}): Promise<ClusterArtifact> {
  const prompt = buildClusterLabelingPrompt(options.promptTemplate, options.artifact);
  const attemptCount = 3;
  let latestRawText = "";
  let latestStopReason: string | null = null;
  let latestError = "Cluster labeling did not produce a valid response.";

  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    try {
      const result = await runTextPromptWithModel({
        model: options.analysisModel,
        prompt:
          attempt === 1
            ? prompt
            : buildClusterLabelingRetryPrompt(prompt, latestRawText, latestError),
        maxOutputTokens: 8192,
        projectRoot: options.projectRoot,
        temperature: 0
      });
      latestRawText = result.text;
      latestStopReason = result.stopReason;
      const parsed = parseClusterLabelingResponse(result.text, options.artifact);
      const updatedClusters = options.artifact.clusters.map((cluster) => {
        const llmCluster = parsed.get(cluster.clusterId);

        if (llmCluster === undefined) {
          return cluster;
        }

        return {
          ...cluster,
          label: llmCluster.nameplate,
          summary: llmCluster.description
        };
      });

      return {
        ...options.artifact,
        labeling: {
          method: "llm-cluster-labeling",
          model: options.analysisModel,
          stopReason: result.stopReason,
          prompt: {
            path: options.promptPath,
            sha256: options.promptSha256
          },
          rawText: result.text,
          createdAt: new Date().toISOString()
        },
        clusters: updatedClusters
      };
    } catch (error) {
      latestError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ...options.artifact,
    labeling: {
      method: "heuristic-fallback",
      model: options.analysisModel,
      stopReason: latestStopReason,
      prompt: {
        path: options.promptPath,
        sha256: options.promptSha256
      },
      ...(latestRawText === "" ? {} : { rawText: latestRawText }),
      error: `Cluster labeling failed after ${attemptCount} attempts. ${latestError}`,
      createdAt: new Date().toISOString()
    }
  };
}

async function summarizePerspectiveWithLlm(
  heuristicPerspective: PerspectivePlanArtifact,
  clusterArtifact: ClusterArtifact,
  options: {
    analysisModel: RegisteredModel;
    projectRoot: string;
    promptPath: string;
    promptSha256: string;
    promptTemplate: string;
    guidingQuestions: string[];
  }
): Promise<PerspectivePlanArtifact> {
  const prompt = buildPerspectiveSummaryPrompt(
    options.promptTemplate,
    heuristicPerspective,
    clusterArtifact,
    options.guidingQuestions
  );

  try {
    const result = await runTextPromptWithModel({
      model: options.analysisModel,
      prompt,
      maxOutputTokens: 4096,
      projectRoot: options.projectRoot,
      temperature: 0
    });
    const parsed = parsePerspectiveSummaryResponse(result.text);

    return {
      ...heuristicPerspective,
      synthesis: {
        method: "llm-perspective-summary",
        model: options.analysisModel,
        stopReason: result.stopReason,
        prompt: {
          path: options.promptPath,
          sha256: options.promptSha256
        },
        rawText: result.text,
        createdAt: new Date().toISOString()
      },
      title: parsed.title,
      summary: parsed.summary
    };
  } catch (error) {
    return {
      ...heuristicPerspective,
      synthesis: {
        method: "heuristic-fallback",
        model: options.analysisModel,
        stopReason: null,
        prompt: {
          path: options.promptPath,
          sha256: options.promptSha256
        },
        error: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      }
    };
  }
}

function buildClusterLabelingPrompt(
  promptTemplate: string,
  artifact: ClusterArtifact
): string {
  const clusterBlocks = artifact.clusters
    .map(
      (cluster) => `Cluster-ID: ${cluster.clusterId}
Opinion-Count: ${cluster.size}
Representative-Opinions:
${cluster.representativeOpinions
  .map(
    (opinion, index) =>
      `${index + 1}. ${opinion.opinionText}${opinion.excerpt === undefined ? "" : `\n   Excerpt: ${opinion.excerpt}`}`
  )
  .join("\n")}
`
    )
    .join("\n");

  return `${promptTemplate.trim()}

## Cluster batch

Method: ${artifact.method}
Requested cluster count: ${artifact.requestedClusterCount}
Effective cluster count: ${artifact.effectiveClusterCount}

${clusterBlocks}`.trim();
}

function buildPerspectiveSummaryPrompt(
  promptTemplate: string,
  perspective: PerspectivePlanArtifact,
  clusterArtifact: ClusterArtifact,
  guidingQuestions: string[]
): string {
  const highlights = perspective.highlights
    .map(
      (highlight) => `Cluster-ID: ${highlight.clusterId}
Label: ${highlight.label}
Opinion-Count: ${highlight.size}
Description: ${highlight.summary}
Representative-Opinions:
${(highlight.representativeOpinions ?? [])
  .map((opinion, index) => `${index + 1}. ${opinion.opinionText}`)
  .join("\n")}`
    )
    .join("\n\n");

  return `${promptTemplate.trim()}

## Guiding questions

${guidingQuestions.map((question) => `- ${question}`).join("\n")}

## Perspective mode

Mode: ${perspective.mode}
Reduction: ${perspective.chosenReductionMethod ?? clusterArtifact.method}
Cluster count: ${perspective.chosenClusterCount ?? clusterArtifact.effectiveClusterCount}
Selection rationale: ${perspective.rationale}

## Highlighted clusters

${highlights}`.trim();
}

function parseClusterLabelingResponse(
  responseText: string,
  artifact: ClusterArtifact
): Map<number, { nameplate: string; description: string }> {
  const blocks = splitHeaderBlocks(responseText);
  const labeledClusters = new Map<number, { nameplate: string; description: string }>();
  const expectedClusterIds = new Set(artifact.clusters.map((cluster) => cluster.clusterId));
  const seenClusterIds = new Set<number>();
  const clusterById = new Map(
    artifact.clusters.map((cluster) => [cluster.clusterId, cluster] as const)
  );

  for (const block of blocks) {
    const clusterId = parseIntegerHeader(block, "Cluster-ID");
    const nameplate = readHeaderValue(block, "Nameplate");
    const description = readHeaderValue(block, "Description");

    if (clusterId === null || nameplate === null || description === null) {
      continue;
    }

    const cluster = clusterById.get(clusterId);

    if (cluster === undefined) {
      throw new Error(`Model response referenced unexpected Cluster-ID ${clusterId}.`);
    }

    if (seenClusterIds.has(clusterId)) {
      throw new Error(`Model response labeled Cluster-ID ${clusterId} more than once.`);
    }

    const evidenceTokens = collectClusterEvidenceTokens(cluster);

    validateShortGroundedLabel({
      label: nameplate,
      evidenceTokens,
      contextLabel: `Cluster-ID ${clusterId} nameplate`
    });
    validateGroundedSummaryText({
      text: description,
      evidenceTokens,
      contextLabel: `Cluster-ID ${clusterId} description`,
      allowMetaLeadIn: true
    });

    seenClusterIds.add(clusterId);
    labeledClusters.set(clusterId, {
      nameplate: normalizeWhitespace(nameplate),
      description: normalizeWhitespace(description)
    });
  }

  if (labeledClusters.size === 0) {
    throw new Error(
      "Model response did not match the required analysis cluster labeling format."
    );
  }

  if (seenClusterIds.size !== expectedClusterIds.size) {
    throw new Error(
      `Model response labeled ${seenClusterIds.size} of ${expectedClusterIds.size} clusters.`
    );
  }

  return labeledClusters;
}

function parsePerspectiveSummaryResponse(
  responseText: string
): { title: string; summary: string } {
  const lines = sanitizeHeaderResponseLines(responseText);
  const title = readSingleHeader(lines, "Title");
  const summary = readSingleHeader(lines, "Summary");

  if (title === null || summary === null) {
    throw new Error(
      "Model response did not match the required analysis perspective summary format."
    );
  }

  return { title, summary };
}

async function buildSemanticHierarchyArtifact(options: {
  artifact: ClusterArtifact;
  artifactPath: string;
  analysisModel: RegisteredModel;
  projectRoot: string;
  promptPath: string;
  promptSha256: string;
  promptTemplate: string;
}): Promise<ClusterHierarchyArtifact> {
  if (options.artifact.status !== "ready" || options.artifact.clusters.length === 0) {
    const experimental = graphRemainderExclusionMetadata(options.artifact);
    return {
      createdAt: new Date().toISOString(),
      method: options.artifact.method,
      sourceClusterArtifactPath: options.artifactPath,
      higherClusterCount: 0,
      lowerClusterCount: options.artifact.effectiveClusterCount,
      status: "failed",
      merge: {
        method: "llm-semantic-merge",
        error: "No ready clusters were available for semantic merge.",
        createdAt: new Date().toISOString()
      },
      themes: [],
      higherToLower: [],
      lowerToHigher: [],
      ...(experimental === undefined ? {} : { experimental })
    };
  }

  const semanticThemeArtifact = buildSemanticThemeArtifact(options.artifact);

  if (semanticThemeArtifact.artifact.clusters.length === 0) {
    return {
      createdAt: new Date().toISOString(),
      method: options.artifact.method,
      sourceClusterArtifactPath: options.artifactPath,
      higherClusterCount: 0,
      lowerClusterCount: 0,
      status: "failed",
      merge: {
        method: "llm-semantic-merge",
        error: "No ready non-remainder clusters were available for semantic merge.",
        createdAt: new Date().toISOString()
      },
      themes: [],
      higherToLower: [],
      lowerToHigher: [],
      ...(semanticThemeArtifact.experimental === undefined
        ? {}
        : { experimental: semanticThemeArtifact.experimental })
    };
  }

  const prompt = buildSemanticMergePrompt(options.promptTemplate, semanticThemeArtifact.artifact);
  const attemptCount = 4;
  let latestRawText = "";
  let latestStopReason: string | null = null;
  let latestError = "Semantic merge did not produce a valid response.";

  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    try {
      const retryPrompt =
        attempt === 1
          ? prompt
          : isThemeLabelValidationError(latestError)
            ? buildSemanticMergeLabelRepairPrompt(prompt, latestRawText, latestError)
            : buildSemanticMergeRetryPrompt(prompt, latestRawText, latestError);
      const result = await runTextPromptWithModel({
        model: options.analysisModel,
        prompt: retryPrompt,
        maxOutputTokens: 8192,
        projectRoot: options.projectRoot,
        temperature: 0
      });
      latestRawText = result.text;
      latestStopReason = result.stopReason;
      const parsedThemes = parseSemanticMergeResponse(result.text, semanticThemeArtifact.artifact);
      return finalizeSemanticHierarchyArtifact({
        artifact: semanticThemeArtifact.artifact,
        artifactPath: options.artifactPath,
        themes: parsedThemes,
        merge: {
          method: "llm-semantic-merge",
          model: options.analysisModel,
          stopReason: result.stopReason,
          prompt: {
            path: options.promptPath,
            sha256: options.promptSha256
          },
          rawText: result.text,
          createdAt: new Date().toISOString()
        },
        ...(semanticThemeArtifact.experimental === undefined
          ? {}
          : { experimental: semanticThemeArtifact.experimental })
      });
    } catch (error) {
      latestError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    createdAt: new Date().toISOString(),
    method: options.artifact.method,
    sourceClusterArtifactPath: options.artifactPath,
    higherClusterCount: 0,
    lowerClusterCount: semanticThemeArtifact.artifact.effectiveClusterCount,
    status: "failed",
    merge: {
      method: "llm-semantic-merge",
      model: options.analysisModel,
      stopReason: latestStopReason,
      prompt: {
        path: options.promptPath,
        sha256: options.promptSha256
      },
      error: `Semantic merge failed after ${attemptCount} attempts. ${latestError}`,
      ...(latestRawText === "" ? {} : { rawText: latestRawText }),
      createdAt: new Date().toISOString()
    },
    themes: [],
    higherToLower: [],
    lowerToHigher: [],
    ...(semanticThemeArtifact.experimental === undefined
      ? {}
      : { experimental: semanticThemeArtifact.experimental })
  };
}

function finalizeSemanticHierarchyArtifact(options: {
  artifact: ClusterArtifact;
  artifactPath: string;
  themes: Array<{
    themeId: number;
    themeLabel: string;
    themeSummary: string;
    clusterIds: number[];
    subthemes?: Array<{
      subthemeId: string;
      clusterId: number;
      label: string;
      summary: string;
      size: number;
    }>;
    mergeRationale: string;
  }>;
  merge: ClusterHierarchyArtifact["merge"];
  experimental?: ClusterHierarchyArtifact["experimental"];
}): ClusterHierarchyArtifact {
  const clusterById = new Map(options.artifact.clusters.map((cluster) => [cluster.clusterId, cluster] as const));
  const lowerToHigher = options.themes.flatMap((theme) =>
    theme.clusterIds
      .map((clusterId) => {
        const cluster = clusterById.get(clusterId);

        if (cluster === undefined) {
          return null;
        }

        return {
          lowerClusterId: cluster.clusterId,
          lowerLabel: cluster.label,
          higherClusterId: theme.themeId,
          higherLabel: theme.themeLabel,
          mergeRationale: theme.mergeRationale
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null)
  );

  const themes = options.themes.map((theme) => ({
    ...theme,
    subthemes: theme.clusterIds
      .map((clusterId) => {
        const cluster = clusterById.get(clusterId);

        if (cluster === undefined) {
          return null;
        }

        return {
          subthemeId: `${theme.themeId}.${cluster.clusterId}`,
          clusterId: cluster.clusterId,
          label: cluster.label,
          summary: cluster.summary,
          size: cluster.size
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null)
  }));

  const higherToLower = themes.map((theme) => ({
    higherClusterId: theme.themeId,
    higherLabel: theme.themeLabel,
    lowerClusterIds: [...theme.clusterIds].sort((left, right) => left - right)
  }));

  return {
    createdAt: new Date().toISOString(),
    method: options.artifact.method,
    sourceClusterArtifactPath: options.artifactPath,
    higherClusterCount: themes.length,
    lowerClusterCount: options.artifact.effectiveClusterCount,
    status: "ready",
    merge: options.merge,
    themes,
    higherToLower,
    lowerToHigher,
    ...(options.experimental === undefined ? {} : { experimental: options.experimental })
  };
}

function buildSemanticMergePrompt(
  promptTemplate: string,
  artifact: ClusterArtifact
): string {
  const clusterBlocks = artifact.clusters
    .map(
      (cluster) => `Cluster-ID: ${cluster.clusterId}
Label: ${cluster.label}
Opinion-Count: ${cluster.size}
Top-Terms: ${cluster.topTerms.join(" | ")}
Description: ${cluster.summary}
Representative-Opinions:
${cluster.representativeOpinions
  .map((opinion, index) => `${index + 1}. ${opinion.opinionText}`)
  .join("\n")}`
    )
    .join("\n\n");

  return `${promptTemplate.trim()}

## Cluster batch

Method: ${artifact.method}
Requested cluster count: ${artifact.requestedClusterCount}
Effective cluster count: ${artifact.effectiveClusterCount}

${clusterBlocks}`.trim();
}

function parseSemanticMergeResponse(
  responseText: string,
  artifact: ClusterArtifact
): Array<{
  themeId: number;
  themeLabel: string;
  themeSummary: string;
  clusterIds: number[];
  mergeRationale: string;
}> {
  const blocks = splitHeaderBlocks(responseText);
  const themes: Array<{
    themeId: number;
    themeLabel: string;
    themeSummary: string;
    clusterIds: number[];
    mergeRationale: string;
  }> = [];
  const seenClusterIds = new Set<number>();
  const expectedClusterIds = new Set(artifact.clusters.map((cluster) => cluster.clusterId));
  const clusterById = new Map(
    artifact.clusters.map((cluster) => [cluster.clusterId, cluster] as const)
  );

  for (const block of blocks) {
    const themeId = parseIntegerHeader(block, "Theme-ID");
    const themeLabel = readHeaderValue(block, "Theme-Label");
    const themeSummary = readHeaderValue(block, "Theme-Summary");
    const mergeRationale = readHeaderValue(block, "Merge-Rationale");
    const clusterIds = parseIntegerListHeader(block, "Cluster-IDs");

    if (
      themeId === null ||
      themeLabel === null ||
      themeSummary === null ||
      mergeRationale === null ||
      clusterIds.length === 0
    ) {
      continue;
    }

    for (const clusterId of clusterIds) {
      if (!expectedClusterIds.has(clusterId) || seenClusterIds.has(clusterId)) {
        throw new Error("Model response did not assign clusters exactly once.");
      }
      seenClusterIds.add(clusterId);
    }

    const evidenceTokens = new Set<string>();
    for (const clusterId of clusterIds) {
      const cluster = clusterById.get(clusterId);

      if (cluster === undefined) {
        continue;
      }

      for (const token of collectClusterEvidenceTokens(cluster)) {
        evidenceTokens.add(token);
      }
    }

    validateShortGroundedLabel({
      label: themeLabel,
      evidenceTokens,
      contextLabel: `Theme-ID ${themeId} label`
    });
    validateGroundedSummaryText({
      text: themeSummary,
      evidenceTokens,
      contextLabel: `Theme-ID ${themeId} summary`,
      allowMetaLeadIn: true
    });
    validateGroundedSummaryText({
      text: mergeRationale,
      evidenceTokens,
      contextLabel: `Theme-ID ${themeId} merge rationale`,
      allowMetaLeadIn: false
    });

    themes.push({
      themeId,
      themeLabel: normalizeWhitespace(themeLabel),
      themeSummary: normalizeWhitespace(themeSummary),
      clusterIds,
      mergeRationale: normalizeWhitespace(mergeRationale)
    });
  }

  if (themes.length === 0 || seenClusterIds.size !== expectedClusterIds.size) {
    throw new Error("Model response did not match the required semantic merge format.");
  }

  return themes.sort((left, right) => left.themeId - right.themeId);
}

function buildSemanticMergeRetryPrompt(
  originalPrompt: string,
  previousResponseText: string,
  parseError: string
): string {
  return `${originalPrompt}

## Retry instructions

Your previous response did not satisfy the required output contract.

Validation error: ${parseError}

Return the full answer again from scratch.
- Use only the required headers.
- Assign every cluster exactly once.
- Favor leaving clusters separate over forcing a weak merge.
- Use natural-language labels, not bags of keywords or comma-separated token lists.
- Keep Theme-Label values concise noun phrases, ideally 2-6 words.
- Do not use commas, pipes, or semicolons inside Theme-Label values.
- Do not add commentary before or after the theme blocks.

## Previous invalid response

${previousResponseText}`.trim();
}

function buildSemanticMergeLabelRepairPrompt(
  originalPrompt: string,
  previousResponseText: string,
  parseError: string
): string {
  return `${originalPrompt}

## Targeted repair instructions

Your previous response was close, but one or more Theme-Label values failed validation.

Validation error: ${parseError}

Return the full answer again from scratch.
- Preserve the same cluster assignments unless absolutely necessary to satisfy the contract.
- Rewrite any weak Theme-Label values into concise natural noun phrases.
- Theme-Label values must not contain commas, pipes, or semicolons.
- Theme-Label values should read like report headings, not keyword bags.
- Keep Theme-Summary and Merge-Rationale grounded in the provided cluster evidence.
- Do not add commentary before or after the theme blocks.

## Previous invalid response

${previousResponseText}`.trim();
}

function isThemeLabelValidationError(message: string): boolean {
  return /^Theme-ID \d+ label\b/i.test(message);
}

function parseIntegerListHeader(lines: string[], headerName: string): number[] {
  const rawValue = readHeaderValue(lines, headerName);

  if (rawValue === null) {
    return [];
  }

  return rawValue
    .split(/[|,]/)
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value));
}

function buildClusterLabelingRetryPrompt(
  originalPrompt: string,
  previousResponseText: string,
  parseError: string
): string {
  return `${originalPrompt}

## Retry instructions

Your previous response did not satisfy the required output contract.

Validation error: ${parseError}

Return the full answer again from scratch.
- Label every cluster exactly once.
- Use natural-language noun phrases, not keyword lists.
- Do not use commas, pipes, or semicolons inside Nameplate values.
- Ground the label and description in the provided evidence.
- Do not add commentary before or after the cluster blocks.

## Previous invalid response

${previousResponseText}`.trim();
}

function collectClusterEvidenceTokens(cluster: ClusterSummary): Set<string> {
  const tokens = new Set<string>();
  const addText = (value: string | undefined): void => {
    if (value === undefined) {
      return;
    }

    for (const token of tokenize(value)) {
      if (!ANALYSIS_META_TOKENS.has(token)) {
        tokens.add(token);
      }
    }
  };

  for (const term of cluster.topTerms) {
    addText(term);
  }

  addText(cluster.label);
  addText(cluster.summary);

  for (const opinion of cluster.representativeOpinions) {
    addText(opinion.opinionText);
    addText(opinion.excerpt);
  }

  return tokens;
}

function validateShortGroundedLabel(options: {
  label: string;
  evidenceTokens: Set<string>;
  contextLabel: string;
}): void {
  const normalized = normalizeWhitespace(options.label);

  if (normalized.length < 4) {
    throw new Error(`${options.contextLabel} was too short.`);
  }

  if (normalized.length > 80) {
    throw new Error(`${options.contextLabel} was too long.`);
  }

  if (/[,;|]/.test(normalized)) {
    throw new Error(`${options.contextLabel} must be a natural label, not a token list.`);
  }

  if (normalized.split(/\s+/).length > 8) {
    throw new Error(`${options.contextLabel} should stay concise.`);
  }

  if (/^(other|misc(?:ellaneous)?|general|various|mixed|several|different)\b/i.test(normalized)) {
    throw new Error(`${options.contextLabel} was too generic.`);
  }

  const informativeTokens = extractInformativeTokens(normalized);
  if (informativeTokens.length === 0) {
    throw new Error(`${options.contextLabel} did not contain informative terms.`);
  }

  if (informativeTokens.every((token) => token.length <= 3)) {
    throw new Error(`${options.contextLabel} was not grounded in meaningful words.`);
  }

  if (informativeTokens.every((token) => ANALYSIS_META_TOKENS.has(token))) {
    throw new Error(`${options.contextLabel} was generic metadata rather than a topic label.`);
  }

  const overlap = countTokenOverlap(informativeTokens, options.evidenceTokens);
  if (overlap === 0 && informativeTokens.length === 1 && (informativeTokens[0]?.length ?? 0) <= 4) {
    throw new Error(`${options.contextLabel} was too thin to stand as a defensible label.`);
  }
}

function validateGroundedSummaryText(options: {
  text: string;
  evidenceTokens: Set<string>;
  contextLabel: string;
  allowMetaLeadIn: boolean;
}): void {
  const normalized = normalizeWhitespace(options.text);

  if (normalized.length < 24) {
    throw new Error(`${options.contextLabel} was too short.`);
  }

  if (normalized.length > 280) {
    throw new Error(`${options.contextLabel} was too long.`);
  }

  const informativeTokens = extractInformativeTokens(normalized);
  if (informativeTokens.length < 2) {
    throw new Error(`${options.contextLabel} did not contain enough informative language.`);
  }

  if (
    /^this (cluster|theme) groups\b/i.test(normalized) &&
    options.allowMetaLeadIn === false
  ) {
    throw new Error(`${options.contextLabel} should explain the shared issue directly.`);
  }

  if (
    /(?:cluster|theme) (?:groups|includes?) (?:clusters|opinions?)/i.test(normalized) &&
    countTokenOverlap(informativeTokens, options.evidenceTokens) < 2
  ) {
    throw new Error(`${options.contextLabel} was generic boilerplate.`);
  }

  if (countTokenOverlap(informativeTokens, options.evidenceTokens) === 0) {
    throw new Error(`${options.contextLabel} was not grounded in the supplied evidence.`);
  }
}

function extractInformativeTokens(text: string): string[] {
  return tokenize(text).filter((token) => !ANALYSIS_META_TOKENS.has(token));
}

function countTokenOverlap(tokens: Iterable<string>, evidenceTokens: Set<string>): number {
  let overlap = 0;

  for (const token of tokens) {
    if (evidenceTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenOverlapScore(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  let overlap = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function splitHeaderBlocks(responseText: string): string[][] {
  const lines = sanitizeHeaderResponseLines(responseText);
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.length === 0) {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current);
  }

  return blocks;
}

function sanitizeHeaderResponseLines(responseText: string): string[] {
  return responseText
    .replace(/```[a-z]*\s*/gi, "")
    .replace(/```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim());
}

function parseIntegerHeader(lines: string[], headerName: string): number | null {
  const rawValue = readHeaderValue(lines, headerName);

  if (rawValue === null) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function readHeaderValue(lines: string[], headerName: string): string | null {
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9- ]+):\s*(.*)$/);

    if (match === null) {
      continue;
    }

    if (normalizeHeaderName(match[1] ?? "") === normalizeHeaderName(headerName)) {
      return match[2]?.trim() ?? "";
    }
  }

  return null;
}

function readSingleHeader(lines: string[], headerName: string): string | null {
  return readHeaderValue(lines, headerName);
}

function normalizeHeaderName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function computeCentroid(group: ClusterMember[]): [number, number] {
  const sum = group.reduce(
    (accumulator, member) => {
      accumulator.x += member.x;
      accumulator.y += member.y;
      return accumulator;
    },
    { x: 0, y: 0 }
  );

  return [sum.x / group.length, sum.y / group.length];
}

function summarizeCluster(
  group: ClusterMember[],
  centroid: [number, number],
  opinionsById: Map<string, OpinionArtifact>,
  clusterId: number
): {
  label: string;
  topTerms: string[];
  summary: string;
  representativeOpinions: Array<{
    opinionId: string;
    opinionText: string;
    excerpt?: string;
  }>;
} {
  const representativeOpinions = group
    .map((member) => ({
      member,
      opinion: opinionsById.get(member.opinionId)
    }))
    .filter(
      (
        item
      ): item is {
        member: ClusterMember;
        opinion: OpinionArtifact;
      } => item.opinion !== undefined
    )
    .sort(
      (left, right) =>
        distanceToCentroid(left.member, centroid) - distanceToCentroid(right.member, centroid)
    )
    .slice(0, 3)
    .map((item) => ({
      opinionId: item.opinion.opinionId,
      opinionText: item.opinion.opinionText,
      ...(item.opinion.excerpt === undefined ? {} : { excerpt: item.opinion.excerpt })
    }));

  const texts = group
    .map((member) => opinionsById.get(member.opinionId)?.opinionText)
    .filter((value): value is string => value !== undefined);
  const topTerms = extractTopTerms(texts);
  const label =
    topTerms.length === 0
      ? `Cluster ${clusterId + 1}`
      : topTerms.slice(0, 3).map(toTitleCase).join(", ");
  const summary =
    representativeOpinions.length === 0
      ? `This cluster groups opinions around ${label.toLowerCase()}.`
      : `This cluster groups opinions around ${label.toLowerCase()}. Representative opinions include ${representativeOpinions
          .slice(0, 2)
          .map((item) => `"${truncateText(item.opinionText, 90)}"`)
          .join(" and ")}.`;

  return {
    label,
    topTerms,
    summary,
    representativeOpinions
  };
}

function summarizeClusterLabel(
  opinionIds: string[],
  opinionsById: Map<string, OpinionArtifact>,
  clusterId: number
): {
  label: string;
  topTerms: string[];
  summary: string;
  representativeOpinions: Array<{
    opinionId: string;
    opinionText: string;
    excerpt?: string;
  }>;
} {
  const representativeOpinions = opinionIds
    .map((opinionId) => opinionsById.get(opinionId))
    .filter((value): value is OpinionArtifact => value !== undefined)
    .slice(0, 3)
    .map((item) => ({
      opinionId: item.opinionId,
      opinionText: item.opinionText,
      ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt })
    }));
  const topTerms = extractTopTerms(representativeOpinions.map((item) => item.opinionText));
  const label =
    topTerms.length === 0
      ? `Cluster ${clusterId + 1}`
      : topTerms.slice(0, 3).map(toTitleCase).join(", ");
  const summary =
    representativeOpinions.length === 0
      ? `This cluster groups opinions around ${label.toLowerCase()}.`
      : `This cluster groups opinions around ${label.toLowerCase()}. Representative opinions include "${truncateText(
          representativeOpinions[0]?.opinionText ?? "",
          90
        )}".`;

  return {
    label,
    topTerms,
    summary,
    representativeOpinions
  };
}

function extractTopTerms(texts: string[]): string[] {
  const counts = new Map<string, number>();

  for (const text of texts) {
    const seenInText = new Set<string>();

    for (const token of tokenize(text)) {
      if (seenInText.has(token)) {
        continue;
      }

      seenInText.add(token);
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([term]) => term);
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  return matches.filter(
    (token) =>
      token.length >= 3 &&
      !COMMON_STOPWORDS.has(token) &&
      !/^\d+$/.test(token)
  );
}

function distanceToCentroid(member: ClusterMember, centroid: [number, number]): number {
  return Math.hypot(member.x - centroid[0], member.y - centroid[1]);
}

function toTitleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

const COMMON_STOPWORDS = new Set([
  "and",
  "about",
  "answer",
  "after",
  "all",
  "any",
  "again",
  "against",
  "also",
  "are",
  "around",
  "being",
  "because",
  "been",
  "between",
  "both",
  "can",
  "canada",
  "current",
  "currently",
  "could",
  "data",
  "default",
  "does",
  "dont",
  "even",
  "every",
  "first",
  "get",
  "gets",
  "gov",
  "government",
  "from",
  "for",
  "have",
  "hard",
  "how",
  "implemented",
  "into",
  "its",
  "like",
  "make",
  "made",
  "more",
  "need",
  "needs",
  "not",
  "open",
  "only",
  "other",
  "our",
  "out",
  "people",
  "public",
  "really",
  "regarding",
  "result",
  "sets",
  "should",
  "some",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
  "too",
  "understand",
  "used",
  "using",
  "want",
  "wants",
  "what",
  "why",
  "would",
  "with",
  "work",
  "your"
]);

function createSeededRandom(seedInput: string): () => number {
  let state = positiveIntegerSeed(seedInput);

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function positiveIntegerSeed(seedInput: string): number {
  let value = 0;

  for (const character of seedInput) {
    value = Math.imul(31, value) + character.charCodeAt(0);
    value |= 0;
  }

  return Math.abs(value) + 1;
}

function buildAnalysisRunFingerprint(options: {
  opinionRunId: string;
  selectedOpinionPaths: string[];
  embeddingModel: RegisteredModel;
  analysisModel: RegisteredModel;
  groupsSha256?: string;
  reviewConfigSha256: string;
  viewsSha256: string;
  clusterLabelingPromptSha256: string;
  perspectiveSummaryPromptSha256: string;
  semanticMergePromptSha256: string;
  reductionMethods: string[];
  clusterCounts: number[];
  mergeStrategy: string;
  synthesisModes: string[];
}): AnalysisRunFingerprint {
  const selectedOpinionIdsSha256 = sha256Hex(
    options.selectedOpinionPaths
      .map((opinionPath) => path.basename(opinionPath, ".json"))
      .sort()
      .join("\n")
  );

  return {
    opinionRunId: options.opinionRunId,
    selectedOpinionIdsSha256,
    reviewConfigSha256: options.reviewConfigSha256,
    embeddingModel: modelFingerprintValue(options.embeddingModel),
    analysisModel: modelFingerprintValue(options.analysisModel),
    viewsSha256: options.viewsSha256,
    clusterLabelingPromptSha256: options.clusterLabelingPromptSha256,
    perspectiveSummaryPromptSha256: options.perspectiveSummaryPromptSha256,
    semanticMergePromptSha256: options.semanticMergePromptSha256,
    reductionMethods: [...options.reductionMethods],
    clusterCounts: [...options.clusterCounts],
    mergeStrategy: options.mergeStrategy,
    synthesisModes: [...options.synthesisModes]
  };
}

function modelFingerprintValue(model: RegisteredModel): string {
  return `${model.name}|${model.provider}|${model.region}|${model.modelId}`;
}

async function findLatestCompatibleAnalysisRun(
  runsDir: string,
  fingerprint: AnalysisRunFingerprint
): Promise<{ runId: string; createdAt: string } | null> {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const matches: Array<{ runId: string; createdAt: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifest = await readJsonFile<{
      createdAt?: string;
      fingerprint?: AnalysisRunFingerprint;
    }>(path.join(runsDir, entry.name, "manifest.json"));

    if (
      manifest?.createdAt !== undefined &&
      manifest.fingerprint !== undefined &&
      JSON.stringify(manifest.fingerprint) === JSON.stringify(fingerprint)
    ) {
      matches.push({
        runId: entry.name,
        createdAt: manifest.createdAt
      });
    }
  }

  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matches[0] ?? null;
}

async function findCompatibleAnalysisRunById(
  runsDir: string,
  runId: string,
  fingerprint: AnalysisRunFingerprint
): Promise<{ runId: string; createdAt: string } | null> {
  const manifest = await readJsonFile<{
    createdAt?: string;
    fingerprint?: AnalysisRunFingerprint;
  }>(path.join(runsDir, runId, "manifest.json"));

  if (
    manifest?.createdAt === undefined ||
    manifest.fingerprint === undefined ||
    JSON.stringify(manifest.fingerprint) !== JSON.stringify(fingerprint)
  ) {
    return null;
  }

  return {
    runId,
    createdAt: manifest.createdAt
  };
}

function renderAnalysisIntro(options: {
  projectRoot: string;
  projectConfigPath: string;
  autoResumed: boolean;
  analysisRunId: string;
  latestOpinionRunId: string;
  extractionModel: RegisteredModel;
  embeddingModel: RegisteredModel;
  analysisModel: RegisteredModel;
  opinionsSelected: number;
  reviewConfig: ReviewConfig;
  reviewTotals: {
    totalOpinionCount: number;
    selectedOpinionCount: number;
    excludedOpinionCount: number;
    excludedByStatus: ReviewStatusCounts;
  };
  offset: number;
  limit?: number;
}): string {
  const lines = [
    color.heading("Broadly Analysis"),
    color.muted(rule("=")),
    formatDetailLine("Config", options.projectConfigPath),
    formatDetailLine("Project", options.projectRoot),
    formatDetailLine("Run", options.analysisRunId),
    formatDetailLine("Opinion Run", options.latestOpinionRunId),
    formatDetailLine(
      "Models",
      `extract ${options.extractionModel.name} · embed ${options.embeddingModel.name} · analyze ${options.analysisModel.name}`
    ),
    formatDetailLine(
      "Selection",
      `${options.opinionsSelected} opinions${options.offset > 0 ? ` · offset ${options.offset}` : ""}${options.limit === undefined ? "" : ` · limit ${options.limit}`}`
    ),
    formatDetailLine(
      "Review",
      `comments=${formatIncludedReviewStatuses(options.reviewConfig.analysis.includeCommentStatuses)} · opinions=${formatIncludedReviewStatuses(options.reviewConfig.analysis.includeOpinionStatuses)}`
    ),
    formatDetailLine(
      "Filtered",
      `${options.reviewTotals.excludedOpinionCount} excluded of ${options.reviewTotals.totalOpinionCount} total · ${formatExcludedReviewStatusCounts(options.reviewTotals.excludedByStatus)}`
    ),
    formatDetailLine(
      "Resume",
      options.autoResumed
        ? "Compatible existing analysis run found. Reusing completed work."
        : "No compatible run found. Starting a fresh analysis run."
    ),
    ""
  ];

  return `${lines.join("\n")}\n`;
}

function reductionStatusLabel(artifact: ReductionArtifact): string {
  if (artifact.status === "ready") {
    return `${artifact.pointCount} points ready`;
  }

  return artifact.message === undefined ? artifact.status : `${artifact.status}: ${artifact.message}`;
}

function formatDetailLine(label: string, value: string): string {
  return `  ${color.label(label.padEnd(10))} ${value}`;
}

function rule(character: string): string {
  const width = process.stdout.columns ?? 72;
  return character.repeat(Math.max(24, Math.min(width, 72)));
}

const color = {
  heading: (value: string) => applyAnsi(value, ["1", "36"]),
  label: (value: string) => applyAnsi(value, ["1", "34"]),
  muted: (value: string) => applyAnsi(value, ["2", "37"]),
  section: (value: string) => applyAnsi(`  ${value}`, ["1", "35"])
};

function applyAnsi(value: string, codes: string[]): string {
  if (!process.stdout.isTTY) {
    return value;
  }

  return `\u001B[${codes.join(";")}m${value}\u001B[0m`;
}

function createEmbeddingProgressReporter(totalOpinions: number): {
  tick(values: {
    processedOpinions: number;
    embeddingsGenerated: number;
    embeddingsReused: number;
    failedOpinions: number;
  }): void;
  finish(): void;
} {
  if (totalOpinions <= 0) {
    return {
      tick() {
        // No-op.
      },
      finish() {
        // No-op.
      }
    };
  }

  let lastRenderedLength = 0;
  let lastPlainLogCount = 0;

  const render = (values: {
    processedOpinions: number;
    embeddingsGenerated: number;
    embeddingsReused: number;
    failedOpinions: number;
  }): void => {
    if (process.stdout.isTTY) {
      const width = 24;
      const ratio = Math.min(values.processedOpinions / totalOpinions, 1);
      const filled = Math.round(width * ratio);
      const bar = `${"=".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}`;
      const line =
        `Progress [${bar}] ${values.processedOpinions}/${totalOpinions}` +
        ` generated=${values.embeddingsGenerated}` +
        ` reused=${values.embeddingsReused}` +
        ` failed=${values.failedOpinions}`;
      const paddedLine =
        line.length < lastRenderedLength
          ? `${line}${" ".repeat(lastRenderedLength - line.length)}`
          : line;

      process.stdout.write(`\r${paddedLine}`);
      lastRenderedLength = paddedLine.length;
      return;
    }

    const shouldLog =
      values.processedOpinions === totalOpinions ||
      values.processedOpinions === 1 ||
      values.processedOpinions >= lastPlainLogCount + 250;

    if (shouldLog) {
      process.stdout.write(
        `Processed ${values.processedOpinions}/${totalOpinions} opinions; generated=${values.embeddingsGenerated}; reused=${values.embeddingsReused}; failed=${values.failedOpinions}\n`
      );
      lastPlainLogCount = values.processedOpinions;
    }
  };

  return {
    tick(values): void {
      render(values);
    },
    finish(): void {
      if (process.stdout.isTTY && lastRenderedLength > 0) {
        process.stdout.write("\n");
      }
    }
  };
}

function createStageProgressReporter(
  unitLabel: string,
  totalItems: number
): {
  tick(values: {
    processed: number;
    generated: number;
    reused: number;
    failed: number;
  }): void;
  finish(): void;
} {
  if (totalItems <= 0) {
    return {
      tick() {
        // No-op.
      },
      finish() {
        // No-op.
      }
    };
  }

  let lastRenderedLength = 0;
  let lastPlainLogCount = 0;

  const render = (values: {
    processed: number;
    generated: number;
    reused: number;
    failed: number;
  }): void => {
    if (process.stdout.isTTY) {
      const width = 24;
      const ratio = Math.min(values.processed / totalItems, 1);
      const filled = Math.round(width * ratio);
      const bar = `${"=".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}`;
      const line =
        `Progress [${bar}] ${values.processed}/${totalItems} ${unitLabel}` +
        ` generated=${values.generated}` +
        ` reused=${values.reused}` +
        ` failed=${values.failed}`;
      const paddedLine =
        line.length < lastRenderedLength
          ? `${line}${" ".repeat(lastRenderedLength - line.length)}`
          : line;

      process.stdout.write(`\r${paddedLine}`);
      lastRenderedLength = paddedLine.length;
      return;
    }

    const shouldLog =
      values.processed === totalItems ||
      values.processed === 1 ||
      values.processed >= lastPlainLogCount + 25;

    if (shouldLog) {
      process.stdout.write(
        `Processed ${values.processed}/${totalItems} ${unitLabel}; generated=${values.generated}; reused=${values.reused}; failed=${values.failed}\n`
      );
      lastPlainLogCount = values.processed;
    }
  };

  return {
    tick(values): void {
      render(values);
    },
    finish(): void {
      if (process.stdout.isTTY && lastRenderedLength > 0) {
        process.stdout.write("\n");
      }
    }
  };
}

async function findLatestOpinionRunForModel(
  opinionsRootDir: string,
  extractionName: string,
  model: RegisteredModel
): Promise<{ runId: string; createdAt: string } | null> {
  const entries = await readdir(opinionsRootDir, { withFileTypes: true }).catch(() => []);
  const matchingRuns: Array<{ runId: string; createdAt: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(opinionsRootDir, entry.name, "manifest.json");
    const manifest = await readJsonFile<{
      createdAt?: string;
      extraction?: { name?: string };
      model?: { name?: string; provider?: string; region?: string; modelId?: string };
    }>(manifestPath);

    if (
      manifest?.createdAt !== undefined &&
      manifest.extraction?.name === extractionName &&
      manifest.model?.name === model.name &&
      manifest.model?.provider === model.provider &&
      manifest.model?.region === model.region &&
      manifest.model?.modelId === model.modelId
    ) {
      matchingRuns.push({
        runId: entry.name,
        createdAt: manifest.createdAt
      });
    }
  }

  matchingRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matchingRuns[0] ?? null;
}

async function findOpinionRunById(
  opinionsRootDir: string,
  runId: string,
  extractionName: string,
  model: RegisteredModel
): Promise<{ runId: string; createdAt: string } | null> {
  const manifest = await readJsonFile<{
    createdAt?: string;
    extraction?: { name?: string };
    model?: { name?: string; provider?: string; region?: string; modelId?: string };
  }>(path.join(opinionsRootDir, runId, "manifest.json"));

  if (
    manifest?.createdAt === undefined ||
    manifest.extraction?.name !== extractionName ||
    manifest.model?.name !== model.name ||
    manifest.model?.provider !== model.provider ||
    manifest.model?.region !== model.region ||
    manifest.model?.modelId !== model.modelId
  ) {
    return null;
  }

  return {
    runId,
    createdAt: manifest.createdAt
  };
}

async function listOpinionArtifactPaths(opinionsDir: string): Promise<string[]> {
  const entries = await readdir(opinionsDir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(opinionsDir, entry.name))
    .sort();
}

function isUsableEmbeddingArtifact(
  artifact: EmbeddingArtifact | null,
  opinion: OpinionArtifact,
  embeddingModel: RegisteredModel
): boolean {
  return (
    artifact !== null &&
    artifact.opinionId === opinion.opinionId &&
    artifact.model.name === embeddingModel.name &&
    artifact.model.provider === embeddingModel.provider &&
    artifact.model.region === embeddingModel.region &&
    artifact.model.modelId === embeddingModel.modelId &&
    Array.isArray(artifact.vector) &&
    artifact.vector.length > 0 &&
    artifact.vector.every((value) => typeof value === "number")
  );
}

async function loadProjectConfig(configPath: string): Promise<BroadlyProjectConfig> {
  const source = await readFile(configPath, "utf8");
  return parseProjectConfig(source);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
