import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig, type BroadlyProjectConfig } from "@broadly/config";
import { resolveProjectPaths, sha256Hex } from "@broadly/core";
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

export interface AnalysisCommandOptions {
  project?: string;
  embeddingModel?: string;
  limit?: number;
  offset?: number;
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
}

interface PerspectivePlanArtifact {
  createdAt: string;
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
    hierarchyArtifactsWritten: number;
    perspectiveArtifactsWritten: number;
  };
}

interface AnalysisRunFingerprint {
  opinionRunId: string;
  selectedOpinionIdsSha256: string;
  embeddingModel: string;
  analysisModel: string;
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

export async function runAnalysis(options: AnalysisCommandOptions): Promise<void> {
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
      const embeddingModel = resolveConfiguredEmbeddingModel(config, options.embeddingModel);
      const extractionModel = resolveConfiguredExtractionModel(config);
      const analysisModel = resolveConfiguredAnalysisModel(config);
      const clusterLabelingPromptPath = path.join(
        projectPaths.promptsDir,
        "analysis-cluster-labeling.md"
      );
      const perspectiveSummaryPromptPath = path.join(
        projectPaths.promptsDir,
        "analysis-perspective-summary.md"
      );
      const semanticMergePromptPath = path.join(
        projectPaths.promptsDir,
        "analysis-semantic-merge.md"
      );
      const clusterLabelingPrompt = await readFile(clusterLabelingPromptPath, "utf8");
      const perspectiveSummaryPrompt = await readFile(perspectiveSummaryPromptPath, "utf8");
      const semanticMergePrompt = await readFile(semanticMergePromptPath, "utf8");
      const clusterLabelingPromptSha256 = sha256Hex(clusterLabelingPrompt);
      const perspectiveSummaryPromptSha256 = sha256Hex(perspectiveSummaryPrompt);
      const semanticMergePromptSha256 = sha256Hex(semanticMergePrompt);
      const currentOpinionRunId = await readCurrentRunId(projectPaths.opinionsCurrentRunPath);
      const latestOpinionRun =
        (currentOpinionRunId === null
          ? null
          : await findOpinionRunById(
              path.join(projectPaths.dataDir, "opinions"),
              currentOpinionRunId,
              extractionModel
            )) ??
        (await findLatestOpinionRunForModel(
          path.join(projectPaths.dataDir, "opinions"),
          extractionModel
        ));

      if (latestOpinionRun === null) {
        throw new Error(
          `No opinion run found for extraction model '${extractionModel.name}'. Run broadly opinions first.`
        );
      }

      const opinionsRunDir = path.join(projectPaths.dataDir, "opinions", latestOpinionRun.runId);
      const opinionsDir = path.join(opinionsRunDir, "opinions");
      const allOpinionPaths = await listOpinionArtifactPaths(opinionsDir);
      const offset = options.offset ?? 0;
      const selectedOpinionPaths = allOpinionPaths.slice(
        offset,
        options.limit === undefined ? undefined : offset + options.limit
      );
      const embeddingsDir = path.join(projectPaths.dataDir, "embeddings", embeddingModel.name);
      const embeddingsManifestPath = path.join(embeddingsDir, "manifest.json");
      const fingerprint = buildAnalysisRunFingerprint({
        opinionRunId: latestOpinionRun.runId,
        selectedOpinionPaths,
        embeddingModel,
        analysisModel,
        clusterLabelingPromptSha256,
        perspectiveSummaryPromptSha256,
        semanticMergePromptSha256,
        reductionMethods: config.analysis.reductionMethods,
        clusterCounts: config.analysis.clusterCounts,
        mergeStrategy: config.analysis.mergeStrategy,
        synthesisModes: config.analysis.synthesisModes
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
      let hierarchyArtifactsWritten = 0;
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
        opinionsSelected: selectedOpinionPaths.length,
        offset,
        ...(options.limit === undefined ? {} : { limit: options.limit })
      }));

      const checkpointEmbeddingsManifest = async (): Promise<void> => {
        const manifest: EmbeddingRunManifest = {
          createdAt,
          updatedAt: new Date().toISOString(),
          opinionRunId: latestOpinionRun.runId,
          embeddingModel,
          input: {
            opinionsDir,
            opinionsSelected: selectedOpinionPaths.length,
            ...(offset > 0 ? { offset } : {}),
            ...(options.limit === undefined ? {} : { limit: options.limit })
          },
          output: {
            embeddingsDir,
            manifestPath: embeddingsManifestPath,
            embeddingsReady,
            embeddingsGenerated,
            embeddingsReused,
            failedOpinions
          }
        };

        await writeJsonFile(embeddingsManifestPath, manifest);
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
            opinionRunDir: opinionsRunDir,
            opinionsDir,
            opinionsSelected: selectedOpinionPaths.length,
            ...(offset > 0 ? { offset } : {}),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            extractionModel,
            embeddingModel,
            analysisModel,
            prompts: {
              clusterLabeling: {
                path: clusterLabelingPromptPath,
                sha256: clusterLabelingPromptSha256
              },
              perspectiveSummary: {
                path: perspectiveSummaryPromptPath,
                sha256: perspectiveSummaryPromptSha256
              },
              semanticMerge: {
                path: semanticMergePromptPath,
                sha256: semanticMergePromptSha256
              }
            },
            reductionMethods: config.analysis.reductionMethods,
            clusterCounts: config.analysis.clusterCounts,
            mergeStrategy: config.analysis.mergeStrategy,
            synthesisModes: config.analysis.synthesisModes
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
            hierarchyArtifactsWritten,
            perspectiveArtifactsWritten
          }
        };

        await writeJsonFile(analysisManifestPath, manifest);
      };

      await checkpointEmbeddingsManifest();
      await checkpointAnalysisManifest("running");

      process.stdout.write(color.section("Embeddings") + "\n");
      const progress = createEmbeddingProgressReporter(selectedOpinionPaths.length);
      const successfulEmbeddings: Array<{
        opinion: OpinionArtifact;
        embedding: EmbeddingArtifact;
        embeddingPath: string;
      }> = [];

      for (const opinionPath of selectedOpinionPaths) {
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

          if (
            processedOpinions % 10 === 0 ||
            processedOpinions === selectedOpinionPaths.length
          ) {
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

        const embeddingPath = path.join(embeddingsDir, `${opinion.opinionId}.json`);
        const existingEmbedding = await readJsonFile<EmbeddingArtifact>(embeddingPath);

        if (
          existingEmbedding !== null &&
          isUsableEmbeddingArtifact(existingEmbedding, opinion, embeddingModel)
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

          if (
            processedOpinions % 10 === 0 ||
            processedOpinions === selectedOpinionPaths.length
          ) {
            await checkpointEmbeddingsManifest();
            await checkpointAnalysisManifest("running");
          }

          continue;
        }

        try {
          const vector = await runEmbeddingWithModel({
            model: embeddingModel,
            input: opinion.opinionText,
            projectRoot
          });
          const artifact: EmbeddingArtifact = {
            createdAt: new Date().toISOString(),
            opinionId: opinion.opinionId,
            sourceId: opinion.sourceId,
            sourceContentSha256: opinion.sourceContentSha256,
            opinionTextSha256: sha256Hex(opinion.opinionText),
            model: embeddingModel,
            dimensions: vector.length,
            vector,
            provenance: {
              opinionArtifactPath: opinionPath,
              opinionRunId: latestOpinionRun.runId,
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

        if (
          processedOpinions % 10 === 0 ||
          processedOpinions === selectedOpinionPaths.length
        ) {
          await checkpointEmbeddingsManifest();
          await checkpointAnalysisManifest("running");
        }
      }

      progress.finish();
      await checkpointEmbeddingsManifest();
      process.stdout.write(
        `${formatDetailLine("Summary", `${embeddingsReady} ready · ${embeddingsGenerated} generated · ${embeddingsReused} reused · ${failedOpinions} failed`)}\n\n`
      );
      const opinionArtifactById = new Map<string, OpinionArtifact>(
        successfulEmbeddings.map((item) => [item.opinion.opinionId, item.opinion])
      );

      process.stdout.write(color.section("Reductions") + "\n");
      const reductionArtifacts: Array<{ method: string; path: string; artifact: ReductionArtifact }> = [];

      for (const method of config.analysis.reductionMethods) {
        const artifactPath = path.join(reductionsDir, `${method}.json`);
        const existingArtifact = await readJsonFile<ReductionArtifact>(artifactPath);
        const reusedExistingArtifact =
          existingArtifact !== null && existingArtifact.method === method;
        const artifact =
          existingArtifact !== null && existingArtifact.method === method
            ? existingArtifact
            : await buildReductionArtifact(method, successfulEmbeddings, analysisRunId);

        if (reusedExistingArtifact) {
          reductionsReused += 1;
        } else {
          reductionsGenerated += 1;
          await writeJsonFile(artifactPath, artifact);
        }
        reductionArtifacts.push({ method, path: artifactPath, artifact });

        if (artifact.status === "ready") {
          reductionsReady += 1;
        } else if (artifact.status === "unavailable") {
          reductionsUnavailable += 1;
        } else {
          reductionsFailed += 1;
        }

        process.stdout.write(
          `${formatDetailLine(method, `${reductionStatusLabel(artifact)} · ${reusedExistingArtifact ? "reused" : "generated"}`)}\n`
        );
      }

      process.stdout.write("\n");

      await checkpointAnalysisManifest("running");

      process.stdout.write(color.section("Clusters") + "\n");
      const clusterArtifactPaths: string[] = [];

      for (const reduction of reductionArtifacts) {
        if (reduction.artifact.status !== "ready") {
          continue;
        }

        for (const requestedClusterCount of config.analysis.clusterCounts) {
          const clusterArtifactPath = path.join(
            clustersDir,
            `${reduction.method}-k${requestedClusterCount}.json`
          );
          const existingArtifact = await readJsonFile<ClusterArtifact>(clusterArtifactPath);
          const reusedExistingCluster =
            existingArtifact !== null &&
            existingArtifact.method === reduction.method &&
            existingArtifact.requestedClusterCount === requestedClusterCount;
          const clusterArtifact =
            existingArtifact !== null &&
            existingArtifact.method === reduction.method &&
            existingArtifact.requestedClusterCount === requestedClusterCount
              ? existingArtifact
              : buildClusterArtifact(
                  reduction.artifact,
                  reduction.path,
                  requestedClusterCount,
                  analysisRunId,
                  opinionArtifactById
                );

          if (reusedExistingCluster) {
            clustersReused += 1;
          } else {
            clustersGenerated += 1;
            await writeJsonFile(clusterArtifactPath, clusterArtifact);
          }
          clusterArtifactPaths.push(clusterArtifactPath);

          if (clusterArtifact.status === "ready") {
            clusterArtifactsWritten += 1;
          } else {
            clusterArtifactsFailed += 1;
          }

          process.stdout.write(
            `${formatDetailLine(`${reduction.method} k=${requestedClusterCount}`, `${clusterArtifact.status === "ready" ? `${clusterArtifact.clusters.length} clusters` : clusterArtifact.message ?? clusterArtifact.status} · ${reusedExistingCluster ? "reused" : "generated"}`)}\n`
          );
        }
      }

      process.stdout.write("\n");
      await checkpointAnalysisManifest("running");

      process.stdout.write(color.section("Labeling") + "\n");
      const labeledClusterArtifacts: Array<{ path: string; artifact: ClusterArtifact }> = [];
      const labelableClusterArtifactPaths = await Promise.all(
        clusterArtifactPaths.map(async (clusterArtifactPath) => ({
          path: clusterArtifactPath,
          artifact: await readJsonFile<ClusterArtifact>(clusterArtifactPath)
        }))
      );
      const readyClusterArtifactCount = labelableClusterArtifactPaths.filter(
        (item) => item.artifact !== null && item.artifact.status === "ready"
      ).length;
      const labelingProgress = createStageProgressReporter("clusters", readyClusterArtifactCount);
      let labeledClusterArtifactsProcessed = 0;

      for (const clusterArtifactPath of clusterArtifactPaths) {
        const existingArtifact = await readJsonFile<ClusterArtifact>(clusterArtifactPath);

        if (existingArtifact === null || existingArtifact.status !== "ready") {
          continue;
        }

        const labeledArtifact =
          existingArtifact.labeling.method === "llm-cluster-labeling"
            ? existingArtifact
            : await labelClusterArtifactWithLlm({
                artifact: existingArtifact,
                artifactPath: clusterArtifactPath,
                analysisModel,
                projectRoot,
                promptPath: clusterLabelingPromptPath,
                promptSha256: clusterLabelingPromptSha256,
                promptTemplate: clusterLabelingPrompt
              });

        const reusedExistingLabel = labeledArtifact === existingArtifact;
        if (reusedExistingLabel) {
          labelsReused += 1;
        } else {
          labelsGenerated += 1;
          await writeJsonFile(clusterArtifactPath, labeledArtifact);
        }
        labeledClusterArtifacts.push({
          path: clusterArtifactPath,
          artifact: labeledArtifact
        });
        labeledClusterArtifactsProcessed += 1;
        labelingProgress.tick({
          processed: labeledClusterArtifactsProcessed,
          generated: labelsGenerated,
          reused: labelsReused,
          failed: 0
        });
      }

      labelingProgress.finish();
      process.stdout.write(
        `${formatDetailLine("Summary", `${labeledClusterArtifactsProcessed} labeled · ${labelsGenerated} generated · ${labelsReused} reused`)}\n`
      );
      process.stdout.write("\n");
      await checkpointAnalysisManifest("running");

      process.stdout.write(color.section("Hierarchy") + "\n");
      process.stdout.write(
        `${formatDetailLine("Merge strategy", config.analysis.mergeStrategy)}\n`
      );
      const hierarchyProgress = createStageProgressReporter(
        "cluster maps",
        labeledClusterArtifacts.length
      );
      let hierarchyArtifactsProcessed = 0;
      for (const { path: clusterArtifactPath, artifact } of labeledClusterArtifacts) {
        const hierarchyArtifact = await buildSemanticHierarchyArtifact({
          artifact,
          artifactPath: clusterArtifactPath,
          analysisModel,
          projectRoot,
          promptPath: semanticMergePromptPath,
          promptSha256: semanticMergePromptSha256,
          promptTemplate: semanticMergePrompt
        });
        const hierarchyPath = path.join(
          hierarchiesDir,
          `semantic-${hierarchyArtifact.method}-k${hierarchyArtifact.lowerClusterCount}.json`
        );
        await writeJsonFile(hierarchyPath, hierarchyArtifact);
        hierarchyArtifactsWritten += 1;
        hierarchyArtifactsProcessed += 1;
        hierarchyProgress.tick({
          processed: hierarchyArtifactsProcessed,
          generated: hierarchyArtifactsWritten,
          reused: 0,
          failed: hierarchyArtifact.status === "failed" ? 1 : 0
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

      process.stdout.write(color.section("Perspectives") + "\n");
      for (const mode of config.analysis.synthesisModes) {
        const perspectivePath = path.join(perspectivesDir, `${mode}.json`);
        const existingPerspective = await readJsonFile<PerspectivePlanArtifact>(perspectivePath);
        const reusedExistingPerspective =
          existingPerspective !== null &&
          existingPerspective.status === "ready" &&
          existingPerspective.synthesis.method === "llm-perspective-summary";
        const perspectiveArtifact =
          existingPerspective !== null &&
          existingPerspective.status === "ready" &&
          existingPerspective.synthesis.method === "llm-perspective-summary"
            ? existingPerspective
            : await buildPerspectivePlanArtifact(
                mode,
                config.analysis.clusterCounts,
                clusterArtifactPaths,
                {
                  analysisModel,
                  projectRoot,
                  promptPath: perspectiveSummaryPromptPath,
                  promptSha256: perspectiveSummaryPromptSha256,
                  promptTemplate: perspectiveSummaryPrompt,
                  guidingQuestions: config.guidingQuestions
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
          `${formatDetailLine(mode, `${perspectiveArtifact.summary === undefined ? perspectiveArtifact.status : perspectiveArtifact.title ?? "ready"} · ${reusedExistingPerspective ? "reused" : "generated"}`)}\n`
        );
      }

      const finalStatus =
        failedOpinions > 0 || reductionsFailed > 0 || clusterArtifactsFailed > 0
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
        formatDetailLine("Selection", `${selectedOpinionPaths.length} opinions${offset > 0 ? ` · offset ${offset}` : ""}${options.limit === undefined ? "" : ` · limit ${options.limit}`}`),
        formatDetailLine("Resume", autoResumed ? "Compatible existing run reused" : "Fresh analysis run"),
        formatDetailLine("Embeddings", `${embeddingsReady} ready · ${embeddingsGenerated} generated · ${embeddingsReused} reused · ${failedOpinions} failed`),
        formatDetailLine("Reductions", reductionSummary === "" ? "none" : `${reductionSummary} · ${reductionsGenerated} generated · ${reductionsReused} reused`),
        formatDetailLine("Clusters", `${clusterArtifactsWritten} total · ${clustersGenerated} generated · ${clustersReused} reused`),
        formatDetailLine("Labels", `${labelsGenerated} generated · ${labelsReused} reused`),
        formatDetailLine("Hierarchies", String(hierarchyArtifactsWritten)),
        formatDetailLine("Perspectives", `${perspectiveArtifactsWritten} total · ${perspectivesGenerated} generated · ${perspectivesReused} reused`),
        formatDetailLine("Manifest", toPortableRelativePath(projectRoot, analysisManifestPath))
      ];

      process.stdout.write(`\n${lines.join("\n")}\n`);
    }
  });
}

function resolveConfiguredEmbeddingModel(
  config: BroadlyProjectConfig,
  explicitModelAlias: string | undefined
): RegisteredModel {
  const configuredAlias =
    explicitModelAlias ??
    config.default_embedding_model ??
    config.analysis.embeddingModel;

  if (configuredAlias === undefined || configuredAlias.trim().length === 0) {
    throw new Error(
      "No embedding model is configured. Set default_embedding_model in broadly.yaml or pass --embedding-model."
    );
  }

  return resolveModel(config, configuredAlias);
}

function resolveConfiguredExtractionModel(config: BroadlyProjectConfig): RegisteredModel {
  const configuredAlias =
    config.default_opinion_extraction_model ??
    config.analysis.extractionModel;

  if (configuredAlias === undefined || configuredAlias.trim().length === 0) {
    throw new Error(
      "No opinion extraction model is configured. Set default_opinion_extraction_model in broadly.yaml before running broadly analysis."
    );
  }

  return resolveModel(config, configuredAlias);
}

function resolveConfiguredAnalysisModel(config: BroadlyProjectConfig): RegisteredModel {
  const configuredAlias =
    config.analysis_model ??
    config.default_opinion_extraction_model ??
    config.analysis.extractionModel;

  if (configuredAlias === undefined || configuredAlias.trim().length === 0) {
    throw new Error(
      "No analysis model is configured. Set analysis_model in broadly.yaml or configure a default opinion extraction model."
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

function createAnalysisRunId(embeddingModelName: string): string {
  return `${formatRunTimestamp(new Date())}-${embeddingModelName}`;
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

  if (method === "pacmap") {
    return {
      createdAt,
      method,
      dimensions: 2,
      status: "unavailable",
      message: "PaCMAP is planned in the analysis search space but is not implemented in this Node runtime yet.",
      pointCount: 0,
      points: []
    };
  }

  if (method !== "umap") {
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
      items.length <= 2 ? buildTrivialReductionPoints(items.length) : reduceWithUmap(embeddingVectors, runId);

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
      status: "failed",
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
  mode: string,
  clusterCounts: number[],
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
        item.artifact !== null && item.artifact.status === "ready"
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
      mode,
      status: "unavailable",
      synthesis: {
        method: "heuristic-fallback",
        createdAt
      },
      title: mode === "dissent" ? "Dissenting Viewpoints" : "Balanced Overview",
      summary: "No cluster highlights were available for this perspective.",
      highlights: [],
      rationale: "No ready cluster artifacts were available to plan this perspective."
    };
  }

  const preferredRequestedCount =
    mode === "dissent"
      ? Math.max(...clusterCounts)
      : Math.min(...clusterCounts);
  const chosen =
    clusterArtifacts.find(
      (item) => item.artifact.requestedClusterCount === preferredRequestedCount
    ) ?? clusterArtifacts[0];

  if (chosen === undefined) {
    return {
      createdAt,
      mode,
      status: "unavailable",
      synthesis: {
        method: "heuristic-fallback",
        createdAt
      },
      title: mode === "dissent" ? "Dissenting Viewpoints" : "Balanced Overview",
      summary: "No cluster highlights were available for this perspective.",
      highlights: [],
      rationale: "No ready cluster artifacts were available to plan this perspective."
    };
  }

  const highlights = [...chosen.artifact.clusters]
    .sort((left, right) =>
      mode === "dissent"
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
  const title =
    mode === "dissent" ? "Dissenting Viewpoints" : "Balanced Overview";
  const summary =
    highlights.length === 0
      ? "No cluster highlights were available for this perspective."
      : mode === "dissent"
        ? `This perspective looks for narrower or minority clusters that could be drowned out in a broad summary. It foregrounds ${highlights
            .slice(0, 3)
            .map((item) => item.label)
            .join(", ")}.`
        : `This perspective favors the larger clusters in the map and uses them as the primary reading of the corpus. It foregrounds ${highlights
            .slice(0, 3)
            .map((item) => item.label)
            .join(", ")}.`;

  const heuristicPerspective: PerspectivePlanArtifact = {
    createdAt,
    mode,
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
      mode === "dissent"
        ? "Prefer the higher cluster count to preserve narrower pockets of disagreement and minority viewpoints."
        : "Prefer the lower cluster count to produce a broader reading that should still surface strong consensus where it exists."
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

  try {
    const result = await runTextPromptWithModel({
      model: options.analysisModel,
      prompt,
      maxOutputTokens: 4096,
      projectRoot: options.projectRoot,
      temperature: 0
    });
    const parsed = parseClusterLabelingResponse(result.text);
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
    return {
      ...options.artifact,
      labeling: {
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
  responseText: string
): Map<number, { nameplate: string; description: string }> {
  const blocks = splitHeaderBlocks(responseText);
  const labeledClusters = new Map<number, { nameplate: string; description: string }>();

  for (const block of blocks) {
    const clusterId = parseIntegerHeader(block, "Cluster-ID");
    const nameplate = readHeaderValue(block, "Nameplate");
    const description = readHeaderValue(block, "Description");

    if (clusterId === null || nameplate === null || description === null) {
      continue;
    }

    labeledClusters.set(clusterId, {
      nameplate,
      description
    });
  }

  if (labeledClusters.size === 0) {
    throw new Error(
      "Model response did not match the required analysis cluster labeling format."
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
      lowerToHigher: []
    };
  }

  const prompt = buildSemanticMergePrompt(options.promptTemplate, options.artifact);
  const attemptCount = 3;
  let latestRawText = "";
  let latestStopReason: string | null = null;
  let latestError = "Semantic merge did not produce a valid response.";

  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    try {
      const result = await runTextPromptWithModel({
        model: options.analysisModel,
        prompt:
          attempt === 1
            ? prompt
            : buildSemanticMergeRetryPrompt(prompt, latestRawText, latestError),
        maxOutputTokens: 4096,
        projectRoot: options.projectRoot,
        temperature: 0
      });
      latestRawText = result.text;
      latestStopReason = result.stopReason;
      const parsedThemes = parseSemanticMergeResponse(result.text, options.artifact);
      return finalizeSemanticHierarchyArtifact({
        artifact: options.artifact,
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
        }
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
    lowerClusterCount: options.artifact.effectiveClusterCount,
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
    lowerToHigher: []
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
    mergeRationale: string;
  }>;
  merge: ClusterHierarchyArtifact["merge"];
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

  const higherToLower = options.themes.map((theme) => ({
    higherClusterId: theme.themeId,
    higherLabel: theme.themeLabel,
    lowerClusterIds: [...theme.clusterIds].sort((left, right) => left - right)
  }));

  return {
    createdAt: new Date().toISOString(),
    method: options.artifact.method,
    sourceClusterArtifactPath: options.artifactPath,
    higherClusterCount: options.themes.length,
    lowerClusterCount: options.artifact.effectiveClusterCount,
    status: "ready",
    merge: options.merge,
    themes: options.themes,
    higherToLower,
    lowerToHigher
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

    themes.push({
      themeId,
      themeLabel,
      themeSummary,
      clusterIds,
      mergeRationale
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
- Do not add commentary before or after the theme blocks.

## Previous invalid response

${previousResponseText}`.trim();
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
    embeddingModel: modelFingerprintValue(options.embeddingModel),
    analysisModel: modelFingerprintValue(options.analysisModel),
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
      model?: { name?: string; provider?: string; region?: string; modelId?: string };
    }>(manifestPath);

    if (
      manifest?.createdAt !== undefined &&
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
  model: RegisteredModel
): Promise<{ runId: string; createdAt: string } | null> {
  const manifest = await readJsonFile<{
    createdAt?: string;
    model?: { name?: string; provider?: string; region?: string; modelId?: string };
  }>(path.join(opinionsRootDir, runId, "manifest.json"));

  if (
    manifest?.createdAt === undefined ||
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
