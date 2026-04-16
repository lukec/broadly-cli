import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig, type BroadlyProjectConfig } from "@broadly/config";
import { resolveProjectPaths, sha256Hex } from "@broadly/core";
import { type RegisteredModel, runTextPromptWithModel } from "../modelRuntime.js";
import { readCurrentRunId, writeCurrentRunId } from "../projectArtifacts.js";
import { withProjectActionLog } from "../projectLog.js";
import { resolveCommandProjectRoot } from "./projectDashboard.js";

type QaPhase =
  | "phase1-structural"
  | "phase2-cluster-membership"
  | "phase3-theme-support";

type IssueCategory =
  | "run-integrity"
  | "cluster-integrity"
  | "view-integrity"
  | "evidence-integrity"
  | "soft-consistency"
  | "cluster-membership-quality"
  | "cluster-theme-support"
  | "theme-merge-quality";

type ClusterMembershipVerdict = "fit" | "borderline" | "outlier";
type ClusterMembershipConfidence = "high" | "medium" | "low";
type ClusterThemeSupportVerdict = "supported" | "mixed" | "unsupported";
type ThemeMergeVerdict = "coherent" | "borderline" | "overmerged";

export interface QaCommandOptions {
  project?: string;
  run?: string;
  phase?: string[];
  model?: string;
  sampleSize?: number;
  samplePercent?: number;
  qaAll?: boolean;
  view?: string[];
  clusterLimit?: number;
  themeLimit?: number;
}

interface IssueRecord {
  phase: QaPhase;
  severity: "error" | "warning";
  category: IssueCategory;
  code: string;
  message: string;
  artifactPath?: string;
  details?: Record<string, unknown>;
}

interface QaSamplingConfig {
  qaAll: boolean;
  sampleSize: number | null;
  samplePercent: number | null;
  viewFilter: string[];
  clusterLimit: number | null;
  themeLimit: number | null;
}

interface QaRunManifest {
  qaRunId: string;
  analysisRunId: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "completed-with-failures";
  fingerprint: {
    analysisRunId: string;
    analysisManifestSha256: string;
    reportBundleSha256: string | null;
    phases: QaPhase[];
    qaModelAlias: string | null;
    qaModelFingerprint: string | null;
    clusterMembershipPromptSha256: string | null;
    clusterThemeSupportPromptSha256: string | null;
    themeMergeReviewPromptSha256: string | null;
    sampling: QaSamplingConfig;
  };
  input: {
    analysisManifestPath: string;
    reportBundlePath: string | null;
    phases: QaPhase[];
    qaModel?: string;
    sampling: QaSamplingConfig;
    prompts: {
      clusterMembership: {
        path: string | null;
        sha256: string | null;
      };
      clusterThemeSupport: {
        path: string | null;
        sha256: string | null;
      };
      themeMergeReview: {
        path: string | null;
        sha256: string | null;
      };
    };
  };
  output: {
    qaDir: string;
    manifestPath: string;
    scorecardPath: string;
    provenanceCheckPath: string;
    provenanceFailuresPath: string;
    clusterMembershipDir: string;
    themeReviewDir: string;
    issueCount: number;
    errorCount: number;
    warningCount: number;
    clusterMembershipArtifacts: number;
    clusterOutlierArtifacts: number;
    clusterThemeSupportArtifacts: number;
    themeMergeReviewArtifacts: number;
  };
}

interface ScorecardCategory {
  status: "scored" | "not-run";
  checks: number;
  passed: number;
  errors: number;
  warnings: number;
  score: number | null;
}

interface Scorecard {
  qaRunId: string;
  analysisRunId: string;
  createdAt: string;
  categories: Record<
    | "runIntegrity"
    | "clusterIntegrity"
    | "viewIntegrity"
    | "evidenceIntegrity"
    | "softConsistency"
    | "clusterMembershipQuality"
    | "clusterThemeSupport"
    | "themeMergeQuality",
    ScorecardCategory
  >;
  totals: {
    checks: number;
    passed: number;
    errors: number;
    warnings: number;
    score: number;
  };
  status: "completed" | "completed-with-failures";
}

interface ProvenanceCheckArtifact {
  qaRunId: string;
  analysisRunId: string;
  createdAt: string;
  reportBundlePath: string | null;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  artifactCounts: {
    clusterArtifacts: number;
    hierarchyArtifacts: number;
    viewArtifacts: number;
    reportViews: number;
    opinionArtifacts: number;
  };
  issues: IssueRecord[];
}

interface ClusterMembershipReviewArtifact {
  viewName: string;
  clusterId: number;
  clusterLabel: string;
  clusterSummary: string;
  clusterArtifactPath: string;
  qaModel: {
    name: string;
    provider: string;
    modelId: string;
    region: string;
  };
  prompt: {
    path: string | null;
    sha256: string;
  };
  sampling: {
    clusterSize: number;
    qaAll: boolean;
    sampleSize: number | null;
    samplePercent: number | null;
    sampledOpinionCount: number;
  };
  totals: {
    reviewed: number;
    fit: number;
    borderline: number;
    outlier: number;
    score: number;
  };
  reviews: ClusterMembershipReviewRecord[];
}

interface ClusterMembershipReviewRecord {
  opinionId: string;
  opinionText: string;
  excerpt: string | null;
  verdict: ClusterMembershipVerdict;
  confidence: ClusterMembershipConfidence;
  rationale: string;
  rawText: string;
  stopReason: string | null;
}

interface ClusterMembershipOutlierArtifact {
  viewName: string;
  clusterId: number;
  clusterLabel: string;
  clusterArtifactPath: string;
  outliers: ClusterMembershipReviewRecord[];
}

interface ClusterMembershipSummary {
  artifactsWritten: number;
  outlierArtifactsWritten: number;
  reviewed: number;
  fit: number;
  borderline: number;
  outlier: number;
}

interface ClusterThemeSupportReviewArtifact {
  viewName: string;
  clusterId: number;
  clusterLabel: string;
  clusterSummary: string;
  clusterArtifactPath: string;
  qaModel: {
    name: string;
    provider: string;
    modelId: string;
    region: string;
  };
  prompt: {
    path: string | null;
    sha256: string;
  };
  sampling: {
    clusterSize: number;
    qaAll: boolean;
    sampleSize: number | null;
    samplePercent: number | null;
    sampledOpinionCount: number;
  };
  verdict: ClusterThemeSupportVerdict;
  confidence: ClusterMembershipConfidence;
  rationale: string;
  rawText: string;
  stopReason: string | null;
  sampledOpinions: Array<{ opinionId: string; opinionText: string; excerpt: string | null }>;
}

interface ThemeMergeReviewArtifact {
  viewName: string;
  themeId: number | string;
  themeLabel: string;
  themeSummary: string;
  hierarchyArtifactPath: string;
  qaModel: {
    name: string;
    provider: string;
    modelId: string;
    region: string;
  };
  prompt: {
    path: string | null;
    sha256: string;
  };
  verdict: ThemeMergeVerdict;
  confidence: ClusterMembershipConfidence;
  rationale: string;
  rawText: string;
  stopReason: string | null;
  clusterIds: Array<number | string>;
}

interface ThemeSupportSummary {
  clusterThemeSupportArtifacts: number;
  themeMergeReviewArtifacts: number;
  supported: number;
  mixed: number;
  unsupported: number;
  coherent: number;
  borderline: number;
  overmerged: number;
}

interface LoadedAnalysisManifest {
  runId?: string;
  analysisRunId?: string;
  createdAt?: string;
  input?: {
    opinionRunId?: string;
    groups?: Array<{ opinionRunId?: string }>;
  };
}

interface LoadedClusterArtifact {
  status?: string;
  members?: Array<{ opinionId?: string; clusterId?: number }>;
  clusters?: Array<{
    clusterId?: number;
    size?: number;
    label?: string;
    summary?: string;
    topTerms?: string[];
    representativeOpinions?: Array<{ opinionId?: string; opinionText?: string; excerpt?: string }>;
  }>;
}

interface LoadedHierarchyArtifact {
  status?: string;
  sourceClusterArtifactPath?: string;
  themes?: Array<{
    themeId?: number | string;
    themeLabel?: string;
    themeSummary?: string;
    clusterIds?: Array<string | number>;
    mergeRationale?: string;
  }>;
}

interface LoadedViewArtifact {
  viewName?: string;
  mode?: string;
  chosenClusterArtifactPath?: string;
  highlights?: Array<{ clusterId?: number | string }>;
}

interface LoadedReportBundle {
  analysisRunId?: string;
  views?: Array<{
    viewId?: string;
    clusters?: Array<{ clusterId?: string; evidenceQuotes?: Array<{ sourceId?: string; excerpt?: string }> }>;
  }>;
}

interface LoadedOpinionArtifact {
  opinionId?: string;
  opinionText?: string;
  excerpt?: string;
  sourceContentSha256?: string;
  provenance?: {
    normalizedRecordPath?: string;
    sourceImportPath?: string;
  };
}

interface LoadedNormalizedRecord {
  contentSha256?: string;
}

interface JsonArtifact<T> {
  path: string;
  artifact: T;
}

interface ClusterSelectionTarget {
  viewName: string;
  clusterArtifactPath: string;
  clusterArtifact: LoadedClusterArtifact;
  cluster: NonNullable<LoadedClusterArtifact["clusters"]>[number];
}

export async function runQa(options: QaCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  await withProjectActionLog({
    projectRoot,
    command: "qa",
    details: {
      run: options.run ?? "(current-or-latest)",
      phases: resolveQaPhases(options.phase).join(", ")
    },
    action: async () => {
      const phases = resolveQaPhases(options.phase);
      const sampling = resolveSamplingConfig(options);
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = parseProjectConfig(await readFile(projectPaths.configPath, "utf8"));
      const analysisRunId =
        options.run ??
        (await readCurrentRunId(projectPaths.analysisCurrentRunPath)) ??
        (await findLatestAnalysisRun(projectPaths.runsDir));

      if (analysisRunId === null) {
        throw new Error("No analysis runs were found. Run broadly analysis first.");
      }

      const analysisRunDir = path.join(projectPaths.runsDir, analysisRunId);
      const analysisManifestPath = path.join(analysisRunDir, "manifest.json");
      const analysisManifestSource = await readFile(analysisManifestPath, "utf8");
      const analysisManifest = JSON.parse(analysisManifestSource) as LoadedAnalysisManifest;
      const reportBundlePath = path.join(projectPaths.reportsDir, analysisRunId, "report-bundle.json");
      const reportBundleSource = await readFile(reportBundlePath, "utf8").catch(() => null);
      const reportBundle =
        reportBundleSource === null ? null : (JSON.parse(reportBundleSource) as LoadedReportBundle);

      const clusterMembershipPrompt = await resolveClusterMembershipPrompt(projectPaths.promptsDir);
      const clusterThemeSupportPrompt = await resolveClusterThemeSupportPrompt(projectPaths.promptsDir);
      const themeMergeReviewPrompt = await resolveThemeMergeReviewPrompt(projectPaths.promptsDir);
      const qaModel =
        phases.includes("phase2-cluster-membership") === false &&
        phases.includes("phase3-theme-support") === false
          ? null
          : resolveQaModel(config, options.model);

      const qaRootDir = path.join(analysisRunDir, "qa");
      const qaRunId = createQaRunId();
      const qaDir = path.join(qaRootDir, qaRunId);
      const currentRunPointerPath = path.join(qaRootDir, "current-run.txt");
      const manifestPath = path.join(qaDir, "manifest.json");
      const scorecardPath = path.join(qaDir, "scorecard.json");
      const provenanceCheckPath = path.join(qaDir, "provenance-check.json");
      const provenanceFailuresPath = path.join(qaDir, "provenance-failures.jsonl");
      const clusterMembershipDir = path.join(qaDir, "clusters");
      const themeReviewDir = path.join(qaDir, "themes");

      await mkdir(qaDir, { recursive: true });
      await mkdir(clusterMembershipDir, { recursive: true });
      await mkdir(themeReviewDir, { recursive: true });
      await writeCurrentRunId(currentRunPointerPath, qaRunId);

      const issues: IssueRecord[] = [];
      const addIssue = (issue: IssueRecord): void => {
        issues.push(issue);
      };

      await writeQaManifest(
        manifestPath,
        buildQaManifest({
          qaRunId,
          analysisRunId,
          analysisManifestPath,
          manifestPath,
          analysisManifestSha256: sha256Hex(analysisManifestSource),
          reportBundlePath: reportBundleSource === null ? null : reportBundlePath,
          reportBundleSha256: reportBundleSource === null ? null : sha256Hex(reportBundleSource),
          phases,
          qaModel,
          sampling,
          clusterMembershipPrompt,
          clusterThemeSupportPrompt,
          themeMergeReviewPrompt,
          status: "running",
          qaDir,
          scorecardPath,
          provenanceCheckPath,
          provenanceFailuresPath,
          clusterMembershipDir,
          themeReviewDir,
          issueCount: 0,
          errorCount: 0,
          warningCount: 0,
          clusterMembershipArtifacts: 0,
          clusterOutlierArtifacts: 0,
          clusterThemeSupportArtifacts: 0,
          themeMergeReviewArtifacts: 0
        })
      );

      const clustersDir = path.join(analysisRunDir, "clusters");
      const hierarchiesDir = path.join(analysisRunDir, "hierarchies");
      const viewsDir = path.join(analysisRunDir, "perspectives");

      const clusterArtifacts = await loadJsonArtifacts<LoadedClusterArtifact>(clustersDir);
      const hierarchyArtifacts = await loadJsonArtifacts<LoadedHierarchyArtifact>(hierarchiesDir);
      const viewArtifacts = await loadJsonArtifacts<LoadedViewArtifact>(viewsDir);
      const clusterArtifactByPath = new Map(clusterArtifacts.map((item) => [item.path, item.artifact] as const));

      const opinionRunIds = collectOpinionRunIds(analysisManifest.input);
      const opinionArtifacts = await loadOpinionArtifacts(projectPaths.dataDir, opinionRunIds);

      if (phases.includes("phase1-structural")) {
        checkRunIntegrity({
          analysisRunId,
          analysisRunDir,
          analysisManifest,
          reportBundle,
          reportBundlePath: reportBundleSource === null ? null : reportBundlePath,
          clusterArtifacts,
          hierarchyArtifacts,
          viewArtifacts,
          addIssue
        });

        checkClusterIntegrity({
          clusterArtifacts,
          opinionArtifacts,
          addIssue
        });

        checkViewIntegrity({
          viewArtifacts,
          clusterArtifactByPath,
          reportBundle,
          addIssue
        });

        await checkEvidenceIntegrity({
          reportBundle,
          opinionArtifacts,
          addIssue
        });

        checkSoftWarnings({
          clusterArtifacts,
          hierarchyArtifacts,
          viewArtifacts,
          reportBundle,
          clusterArtifactByPath,
          addIssue
        });
      }

      const clusterMembershipSummary =
        qaModel === null || phases.includes("phase2-cluster-membership") === false
          ? null
          : await runClusterMembershipPhase({
              projectRoot,
              qaModel,
              clusterMembershipPrompt,
              viewArtifacts,
              clusterArtifactByPath,
              opinionArtifacts,
              clusterMembershipDir,
              sampling,
              addIssue
            });
      const themeSupportSummary =
        qaModel === null || phases.includes("phase3-theme-support") === false
          ? null
          : await runThemeSupportPhase({
              projectRoot,
              qaModel,
              clusterThemeSupportPrompt,
              themeMergeReviewPrompt,
              viewArtifacts,
              hierarchyArtifacts,
              clusterArtifactByPath,
              opinionArtifacts,
              themeReviewDir,
              sampling,
              addIssue
            });

      const scorecard = buildScorecard(
        qaRunId,
        analysisRunId,
        phases,
        issues,
        clusterMembershipSummary,
        themeSupportSummary
      );
      const provenanceCheck: ProvenanceCheckArtifact = {
        qaRunId,
        analysisRunId,
        createdAt: new Date().toISOString(),
        reportBundlePath: reportBundleSource === null ? null : reportBundlePath,
        issueCount: issues.length,
        errorCount: issues.filter((issue) => issue.severity === "error").length,
        warningCount: issues.filter((issue) => issue.severity === "warning").length,
        artifactCounts: {
          clusterArtifacts: clusterArtifacts.length,
          hierarchyArtifacts: hierarchyArtifacts.length,
          viewArtifacts: viewArtifacts.length,
          reportViews: reportBundle?.views?.length ?? 0,
          opinionArtifacts: opinionArtifacts.size
        },
        issues
      };

      await writeFile(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
      await writeFile(provenanceCheckPath, `${JSON.stringify(provenanceCheck, null, 2)}\n`, "utf8");
      await writeFile(
        provenanceFailuresPath,
        issues.map((issue) => JSON.stringify(issue)).join("\n") + (issues.length > 0 ? "\n" : ""),
        "utf8"
      );

      await writeQaManifest(
        manifestPath,
        buildQaManifest({
          qaRunId,
          analysisRunId,
          analysisManifestPath,
          manifestPath,
          analysisManifestSha256: sha256Hex(analysisManifestSource),
          reportBundlePath: reportBundleSource === null ? null : reportBundlePath,
          reportBundleSha256: reportBundleSource === null ? null : sha256Hex(reportBundleSource),
          phases,
          qaModel,
          sampling,
          clusterMembershipPrompt,
          clusterThemeSupportPrompt,
          themeMergeReviewPrompt,
          status: scorecard.status,
          qaDir,
          scorecardPath,
          provenanceCheckPath,
          provenanceFailuresPath,
          clusterMembershipDir,
          themeReviewDir,
          issueCount: issues.length,
          errorCount: provenanceCheck.errorCount,
          warningCount: provenanceCheck.warningCount,
          clusterMembershipArtifacts: clusterMembershipSummary?.artifactsWritten ?? 0,
          clusterOutlierArtifacts: clusterMembershipSummary?.outlierArtifactsWritten ?? 0,
          clusterThemeSupportArtifacts: themeSupportSummary?.clusterThemeSupportArtifacts ?? 0,
          themeMergeReviewArtifacts: themeSupportSummary?.themeMergeReviewArtifacts ?? 0
        })
      );

      const lines = [
        "Broadly QA",
        "",
        `Analysis run: ${analysisRunId}`,
        `QA run: ${qaRunId}`,
        `Phases: ${phases.join(", ")}`,
        ...(qaModel === null ? [] : [`Judge model: ${formatModelLabel(qaModel)}`]),
        ...(phases.includes("phase2-cluster-membership")
          ? [
              `Sampling: ${formatSamplingLabel(sampling)}`,
              `Cluster membership reviews: ${clusterMembershipSummary?.reviewed ?? 0}`
            ]
          : []),
        ...(phases.includes("phase3-theme-support")
          ? [
              `Theme support reviews: ${themeSupportSummary?.clusterThemeSupportArtifacts ?? 0} clusters · ${themeSupportSummary?.themeMergeReviewArtifacts ?? 0} themes`
            ]
          : []),
        `Status: ${scorecard.status}`,
        `Checks: ${scorecard.totals.checks}`,
        `Errors: ${scorecard.totals.errors}`,
        `Warnings: ${scorecard.totals.warnings}`,
        `Score: ${scorecard.totals.score}`,
        `Manifest: ${toPortableRelativePath(projectRoot, manifestPath)}`,
        `Scorecard: ${toPortableRelativePath(projectRoot, scorecardPath)}`,
        `Provenance check: ${toPortableRelativePath(projectRoot, provenanceCheckPath)}`,
        `Failures: ${toPortableRelativePath(projectRoot, provenanceFailuresPath)}`
      ];

      process.stdout.write(`${lines.join("\n")}\n`);
    }
  });
}

async function runClusterMembershipPhase(options: {
  projectRoot: string;
  qaModel: RegisteredModel;
  clusterMembershipPrompt: { path: string | null; source: string; sha256: string };
  viewArtifacts: Array<JsonArtifact<LoadedViewArtifact>>;
  clusterArtifactByPath: Map<string, LoadedClusterArtifact>;
  opinionArtifacts: Map<string, LoadedOpinionArtifact>;
  clusterMembershipDir: string;
  sampling: QaSamplingConfig;
  addIssue: (issue: IssueRecord) => void;
}): Promise<ClusterMembershipSummary> {
  const selectionTargets = buildClusterSelectionTargets({
    viewArtifacts: options.viewArtifacts,
    clusterArtifactByPath: options.clusterArtifactByPath,
    sampling: options.sampling
  });
  const summary: ClusterMembershipSummary = {
    artifactsWritten: 0,
    outlierArtifactsWritten: 0,
    reviewed: 0,
    fit: 0,
    borderline: 0,
    outlier: 0
  };

  if (selectionTargets.length === 0) {
    options.addIssue({
      phase: "phase2-cluster-membership",
      severity: "warning",
      category: "cluster-membership-quality",
      code: "no-clusters-selected",
      message: "No clusters were eligible for cluster-membership QA."
    });
    return summary;
  }

  process.stdout.write(`\nCluster membership QA\n`);

  for (const [index, target] of selectionTargets.entries()) {
    const memberOpinions = (target.clusterArtifact.members ?? [])
      .filter(
        (member) =>
          member.clusterId === target.cluster.clusterId &&
          typeof member.opinionId === "string" &&
          options.opinionArtifacts.has(member.opinionId)
      )
      .map((member) => options.opinionArtifacts.get(member.opinionId as string) as LoadedOpinionArtifact)
      .filter((opinion): opinion is LoadedOpinionArtifact & { opinionId: string; opinionText: string } => {
        return typeof opinion.opinionId === "string" && typeof opinion.opinionText === "string";
      });

    const sampledOpinions = sampleOpinionsForCluster(memberOpinions, options.sampling);
    const reviews: ClusterMembershipReviewRecord[] = [];

    for (const opinion of sampledOpinions) {
      const prompt = buildClusterMembershipPrompt({
        instructions: options.clusterMembershipPrompt.source,
        viewName: target.viewName,
        cluster: target.cluster,
        opinion
      });

      try {
        const result = await runMembershipReview({
          model: options.qaModel,
          prompt,
          projectRoot: options.projectRoot
        });
        reviews.push({
          opinionId: opinion.opinionId,
          opinionText: opinion.opinionText,
          excerpt: opinion.excerpt ?? null,
          verdict: result.verdict,
          confidence: result.confidence,
          rationale: result.rationale,
          rawText: result.rawText,
          stopReason: result.stopReason
        });
      } catch (error) {
        options.addIssue({
          phase: "phase2-cluster-membership",
          severity: "warning",
          category: "cluster-membership-quality",
          code: "cluster-membership-review-failed",
          message: `Cluster membership review failed for opinion '${opinion.opinionId}' in view '${target.viewName}' cluster '${String(target.cluster.clusterId ?? "unknown")}'.`,
          artifactPath: target.clusterArtifactPath,
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }

    const fit = reviews.filter((review) => review.verdict === "fit").length;
    const borderline = reviews.filter((review) => review.verdict === "borderline").length;
    const outlier = reviews.filter((review) => review.verdict === "outlier").length;
    const score =
      reviews.length === 0 ? 0 : Math.round(((fit + borderline * 0.5) / reviews.length) * 100);

    const membershipArtifact: ClusterMembershipReviewArtifact = {
      viewName: target.viewName,
      clusterId: target.cluster.clusterId ?? -1,
      clusterLabel: target.cluster.label ?? `Cluster ${String(target.cluster.clusterId ?? "unknown")}`,
      clusterSummary: target.cluster.summary ?? "",
      clusterArtifactPath: target.clusterArtifactPath,
      qaModel: {
        name: options.qaModel.name,
        provider: options.qaModel.provider,
        modelId: options.qaModel.modelId,
        region: options.qaModel.region
      },
      prompt: {
        path: options.clusterMembershipPrompt.path,
        sha256: options.clusterMembershipPrompt.sha256
      },
      sampling: {
        clusterSize: memberOpinions.length,
        qaAll: options.sampling.qaAll,
        sampleSize: options.sampling.sampleSize,
        samplePercent: options.sampling.samplePercent,
        sampledOpinionCount: reviews.length
      },
      totals: {
        reviewed: reviews.length,
        fit,
        borderline,
        outlier,
        score
      },
      reviews
    };

    const membershipArtifactPath = path.join(
      options.clusterMembershipDir,
      `${target.viewName}--cluster-${String(target.cluster.clusterId ?? "unknown")}-membership.json`
    );
    const outliersArtifactPath = path.join(
      options.clusterMembershipDir,
      `${target.viewName}--cluster-${String(target.cluster.clusterId ?? "unknown")}-outliers.json`
    );

    await writeFile(membershipArtifactPath, `${JSON.stringify(membershipArtifact, null, 2)}\n`, "utf8");
    await writeFile(
      outliersArtifactPath,
      `${JSON.stringify(
        {
          viewName: target.viewName,
          clusterId: target.cluster.clusterId ?? -1,
          clusterLabel: membershipArtifact.clusterLabel,
          clusterArtifactPath: target.clusterArtifactPath,
          outliers: reviews.filter((review) => review.verdict === "outlier")
        } satisfies ClusterMembershipOutlierArtifact,
        null,
        2
      )}\n`,
      "utf8"
    );

    summary.artifactsWritten += 1;
    summary.outlierArtifactsWritten += 1;
    summary.reviewed += reviews.length;
    summary.fit += fit;
    summary.borderline += borderline;
    summary.outlier += outlier;

    process.stdout.write(
      `  ${String(index + 1).padStart(2, "0")}/${String(selectionTargets.length).padStart(2, "0")} ` +
        `${target.viewName} · cluster ${String(target.cluster.clusterId ?? "unknown")} · reviewed=${reviews.length} · score=${score}\n`
    );
  }

  return summary;
}

async function runThemeSupportPhase(options: {
  projectRoot: string;
  qaModel: RegisteredModel;
  clusterThemeSupportPrompt: { path: string | null; source: string; sha256: string };
  themeMergeReviewPrompt: { path: string | null; source: string; sha256: string };
  viewArtifacts: Array<JsonArtifact<LoadedViewArtifact>>;
  hierarchyArtifacts: Array<JsonArtifact<LoadedHierarchyArtifact>>;
  clusterArtifactByPath: Map<string, LoadedClusterArtifact>;
  opinionArtifacts: Map<string, LoadedOpinionArtifact>;
  themeReviewDir: string;
  sampling: QaSamplingConfig;
  addIssue: (issue: IssueRecord) => void;
}): Promise<ThemeSupportSummary> {
  const summary: ThemeSupportSummary = {
    clusterThemeSupportArtifacts: 0,
    themeMergeReviewArtifacts: 0,
    supported: 0,
    mixed: 0,
    unsupported: 0,
    coherent: 0,
    borderline: 0,
    overmerged: 0
  };
  const viewArtifactByName = new Map(
    options.viewArtifacts.map((item) => [item.artifact.viewName ?? item.artifact.mode ?? path.basename(item.path, ".json"), item] as const)
  );
  const selectedViewNames = [...viewArtifactByName.keys()]
    .filter((viewName) =>
      options.sampling.viewFilter.length === 0 || options.sampling.viewFilter.includes(viewName)
    )
    .sort((left, right) => left.localeCompare(right));

  if (selectedViewNames.length === 0) {
    options.addIssue({
      phase: "phase3-theme-support",
      severity: "warning",
      category: "cluster-theme-support",
      code: "no-views-selected",
      message: "No views were eligible for theme-support QA."
    });
    return summary;
  }

  process.stdout.write(`\nTheme support QA\n`);

  for (const viewName of selectedViewNames) {
    const viewArtifact = viewArtifactByName.get(viewName);

    if (viewArtifact === undefined || typeof viewArtifact.artifact.chosenClusterArtifactPath !== "string") {
      continue;
    }

    const clusterArtifact = options.clusterArtifactByPath.get(viewArtifact.artifact.chosenClusterArtifactPath);

    if (clusterArtifact === undefined) {
      continue;
    }

    const clusterTargets = (clusterArtifact.clusters ?? [])
      .filter((cluster): cluster is NonNullable<LoadedClusterArtifact["clusters"]>[number] & { clusterId: number } => typeof cluster.clusterId === "number")
      .sort((left, right) => left.clusterId - right.clusterId)
      .slice(0, options.sampling.clusterLimit ?? Number.MAX_SAFE_INTEGER);

    for (const cluster of clusterTargets) {
      const memberOpinions = (clusterArtifact.members ?? [])
        .filter(
          (member) =>
            member.clusterId === cluster.clusterId &&
            typeof member.opinionId === "string" &&
            options.opinionArtifacts.has(member.opinionId)
        )
        .map((member) => options.opinionArtifacts.get(member.opinionId as string) as LoadedOpinionArtifact)
        .filter((opinion): opinion is LoadedOpinionArtifact & { opinionId: string; opinionText: string } => {
          return typeof opinion.opinionId === "string" && typeof opinion.opinionText === "string";
        });
      const sampledOpinions = sampleOpinionsForCluster(memberOpinions, options.sampling);
      const prompt = buildClusterThemeSupportPrompt({
        instructions: options.clusterThemeSupportPrompt.source,
        viewName,
        cluster,
        sampledOpinions
      });

      try {
        const review = await runStructuredQaReview({
          model: options.qaModel,
          prompt,
          projectRoot: options.projectRoot,
          allowedVerdicts: ["supported", "mixed", "unsupported"]
        });
        const artifactPath = path.join(
          options.themeReviewDir,
          `${viewName}--cluster-${cluster.clusterId}-theme-support.json`
        );
        const artifact: ClusterThemeSupportReviewArtifact = {
          viewName,
          clusterId: cluster.clusterId,
          clusterLabel: cluster.label ?? `Cluster ${cluster.clusterId}`,
          clusterSummary: cluster.summary ?? "",
          clusterArtifactPath: viewArtifact.artifact.chosenClusterArtifactPath,
          qaModel: {
            name: options.qaModel.name,
            provider: options.qaModel.provider,
            modelId: options.qaModel.modelId,
            region: options.qaModel.region
          },
          prompt: {
            path: options.clusterThemeSupportPrompt.path,
            sha256: options.clusterThemeSupportPrompt.sha256
          },
          sampling: {
            clusterSize: memberOpinions.length,
            qaAll: options.sampling.qaAll,
            sampleSize: options.sampling.sampleSize,
            samplePercent: options.sampling.samplePercent,
            sampledOpinionCount: sampledOpinions.length
          },
          verdict: review.verdict as ClusterThemeSupportVerdict,
          confidence: review.confidence,
          rationale: review.rationale,
          rawText: review.rawText,
          stopReason: review.stopReason,
          sampledOpinions: sampledOpinions.map((opinion) => ({
            opinionId: opinion.opinionId,
            opinionText: opinion.opinionText,
            excerpt: opinion.excerpt ?? null
          }))
        };
        await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
        summary.clusterThemeSupportArtifacts += 1;
        summary[review.verdict as "supported" | "mixed" | "unsupported"] += 1;
      } catch (error) {
        options.addIssue({
          phase: "phase3-theme-support",
          severity: "warning",
          category: "cluster-theme-support",
          code: "cluster-theme-support-review-failed",
          message: `Theme-support review failed for view '${viewName}' cluster '${cluster.clusterId}'.`,
          artifactPath: viewArtifact.artifact.chosenClusterArtifactPath,
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }

  const hierarchyItems = options.hierarchyArtifacts
    .filter((item) => {
      const viewName = path.basename(item.path, ".json");
      return options.sampling.viewFilter.length === 0 || options.sampling.viewFilter.includes(viewName);
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const hierarchyItem of hierarchyItems) {
    const viewName = path.basename(hierarchyItem.path, ".json");
    const clusterArtifact =
      typeof hierarchyItem.artifact.sourceClusterArtifactPath === "string"
        ? options.clusterArtifactByPath.get(hierarchyItem.artifact.sourceClusterArtifactPath)
        : undefined;
    const themes = [...(hierarchyItem.artifact.themes ?? [])].slice(
      0,
      options.sampling.themeLimit ?? Number.MAX_SAFE_INTEGER
    );

    for (const theme of themes) {
      const prompt = buildThemeMergeReviewPrompt({
        instructions: options.themeMergeReviewPrompt.source,
        viewName,
        theme,
        clusterArtifact
      });

      try {
        const review = await runStructuredQaReview({
          model: options.qaModel,
          prompt,
          projectRoot: options.projectRoot,
          allowedVerdicts: ["coherent", "borderline", "overmerged"]
        });
        const artifactPath = path.join(
          options.themeReviewDir,
          `${viewName}--theme-${String(theme.themeId ?? "unknown")}-merge-review.json`
        );
        const artifact: ThemeMergeReviewArtifact = {
          viewName,
          themeId: theme.themeId ?? "unknown",
          themeLabel: theme.themeLabel ?? "(missing)",
          themeSummary: theme.themeSummary ?? "",
          hierarchyArtifactPath: hierarchyItem.path,
          qaModel: {
            name: options.qaModel.name,
            provider: options.qaModel.provider,
            modelId: options.qaModel.modelId,
            region: options.qaModel.region
          },
          prompt: {
            path: options.themeMergeReviewPrompt.path,
            sha256: options.themeMergeReviewPrompt.sha256
          },
          verdict: review.verdict as ThemeMergeVerdict,
          confidence: review.confidence,
          rationale: review.rationale,
          rawText: review.rawText,
          stopReason: review.stopReason,
          clusterIds: theme.clusterIds ?? []
        };
        await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
        summary.themeMergeReviewArtifacts += 1;
        summary[review.verdict as "coherent" | "borderline" | "overmerged"] += 1;
      } catch (error) {
        options.addIssue({
          phase: "phase3-theme-support",
          severity: "warning",
          category: "theme-merge-quality",
          code: "theme-merge-review-failed",
          message: `Theme-merge review failed for view '${viewName}' theme '${String(theme.themeId ?? "unknown")}'.`,
          artifactPath: hierarchyItem.path,
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }

  return summary;
}

function buildClusterSelectionTargets(options: {
  viewArtifacts: Array<JsonArtifact<LoadedViewArtifact>>;
  clusterArtifactByPath: Map<string, LoadedClusterArtifact>;
  sampling: QaSamplingConfig;
}): ClusterSelectionTarget[] {
  const targets: ClusterSelectionTarget[] = [];

  for (const item of options.viewArtifacts) {
    const viewName = item.artifact.viewName ?? item.artifact.mode ?? path.basename(item.path, ".json");

    if (
      options.sampling.viewFilter.length > 0 &&
      options.sampling.viewFilter.includes(viewName) === false
    ) {
      continue;
    }

    if (typeof item.artifact.chosenClusterArtifactPath !== "string") {
      continue;
    }

    const clusterArtifact = options.clusterArtifactByPath.get(item.artifact.chosenClusterArtifactPath);

    if (clusterArtifact === undefined) {
      continue;
    }

    for (const cluster of clusterArtifact.clusters ?? []) {
      if (typeof cluster.clusterId !== "number") {
        continue;
      }

      targets.push({
        viewName,
        clusterArtifactPath: item.artifact.chosenClusterArtifactPath,
        clusterArtifact,
        cluster
      });
    }
  }

  targets.sort((left, right) => {
    const viewComparison = left.viewName.localeCompare(right.viewName);
    if (viewComparison !== 0) {
      return viewComparison;
    }

    return (left.cluster.clusterId ?? 0) - (right.cluster.clusterId ?? 0);
  });

  if (options.sampling.clusterLimit !== null) {
    return targets.slice(0, options.sampling.clusterLimit);
  }

  return targets;
}

function sampleOpinionsForCluster(
  opinions: Array<LoadedOpinionArtifact & { opinionId: string; opinionText: string }>,
  sampling: QaSamplingConfig
): Array<LoadedOpinionArtifact & { opinionId: string; opinionText: string }> {
  const sorted = [...opinions].sort((left, right) => left.opinionId.localeCompare(right.opinionId));

  if (sampling.qaAll) {
    return sorted;
  }

  let desiredCount = 5;

  if (sampling.sampleSize !== null) {
    desiredCount = sampling.sampleSize;
  } else if (sampling.samplePercent !== null) {
    desiredCount = Math.max(1, Math.ceil((sorted.length * sampling.samplePercent) / 100));
  }

  return sorted.slice(0, Math.max(1, Math.min(sorted.length, desiredCount)));
}

async function runMembershipReview(options: {
  model: RegisteredModel;
  prompt: string;
  projectRoot: string;
}): Promise<{
  verdict: ClusterMembershipVerdict;
  confidence: ClusterMembershipConfidence;
  rationale: string;
  rawText: string;
  stopReason: string | null;
}> {
  return runStructuredQaReview({
    model: options.model,
    prompt: options.prompt,
    projectRoot: options.projectRoot,
    allowedVerdicts: ["fit", "borderline", "outlier"]
  }) as Promise<{
    verdict: ClusterMembershipVerdict;
    confidence: ClusterMembershipConfidence;
    rationale: string;
    rawText: string;
    stopReason: string | null;
  }>;
}

async function runStructuredQaReview(options: {
  model: RegisteredModel;
  prompt: string;
  projectRoot: string;
  allowedVerdicts: string[];
}): Promise<{
  verdict: string;
  confidence: ClusterMembershipConfidence;
  rationale: string;
  rawText: string;
  stopReason: string | null;
}> {
  let latestText = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? options.prompt
        : `${options.prompt}\n\nReminder: Return only the three required header lines: Verdict, Confidence, Rationale.`;
    const result = await runTextPromptWithModel({
      model: options.model,
      prompt,
      maxOutputTokens: 250,
      projectRoot: options.projectRoot,
      temperature: 0
    });
    latestText = result.text;
    const parsed = parseHeaderVerdictResponse(result.text, options.allowedVerdicts);

    if (parsed !== null) {
      return {
        ...parsed,
        rawText: result.text,
        stopReason: result.stopReason
      };
    }
  }

  throw new Error(`Model response did not match the required QA format.\n\n${latestText}`);
}

function parseHeaderVerdictResponse(
  source: string
  ,
  allowedVerdicts: string[]
): {
  verdict: string;
  confidence: ClusterMembershipConfidence;
  rationale: string;
} | null {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const values = new Map<string, string>();

  for (const line of lines) {
    const match = line.match(/^([A-Za-z -]+)\s*:\s*(.*)$/);

    if (match === null) {
      continue;
    }

    const rawKey = match[1];
    const rawValue = match[2];

    if (rawKey === undefined || rawValue === undefined) {
      continue;
    }

    const key = rawKey.toLowerCase().replace(/[^a-z]+/g, "");
    values.set(key, rawValue.trim());
  }

  const verdictValue = values.get("verdict")?.toLowerCase();
  const confidenceValue = values.get("confidence")?.toLowerCase();
  const rationale = values.get("rationale")?.trim();

  if (
    verdictValue === undefined ||
    allowedVerdicts.includes(verdictValue) === false ||
    (confidenceValue !== "high" && confidenceValue !== "medium" && confidenceValue !== "low")
  ) {
    return null;
  }

  return {
    verdict: verdictValue,
    confidence: confidenceValue,
    rationale: rationale === undefined || rationale.length === 0 ? "No rationale provided." : rationale
  };
}

function buildClusterMembershipPrompt(options: {
  instructions: string;
  viewName: string;
  cluster: NonNullable<LoadedClusterArtifact["clusters"]>[number];
  opinion: LoadedOpinionArtifact & { opinionId: string; opinionText: string };
}): string {
  const representativeBlock = (options.cluster.representativeOpinions ?? [])
    .map((item, index) =>
      [
        `Representative-${index + 1}-Opinion-ID: ${item.opinionId ?? "unknown"}`,
        `Representative-${index + 1}-Opinion-Text: ${item.opinionText ?? "(missing)"}`,
        `Representative-${index + 1}-Excerpt: ${item.excerpt ?? "(missing)"}`
      ].join("\n")
    )
    .join("\n\n");

  return [
    options.instructions.trim(),
    "",
    "## Cluster Under Review",
    `View-Name: ${options.viewName}`,
    `Cluster-ID: ${String(options.cluster.clusterId ?? "unknown")}`,
    `Cluster-Label: ${options.cluster.label ?? "(missing)"}`,
    `Cluster-Summary: ${options.cluster.summary ?? "(missing)"}`,
    `Cluster-Top-Terms: ${(options.cluster.topTerms ?? []).join(" | ") || "(none)"}`,
    "",
    "## Representative Opinions",
    representativeBlock.length === 0 ? "(none)" : representativeBlock,
    "",
    "## Candidate Opinion",
    `Opinion-ID: ${options.opinion.opinionId}`,
    `Opinion-Text: ${options.opinion.opinionText}`,
    `Opinion-Excerpt: ${options.opinion.excerpt ?? "(none)"}`,
    "",
    "## Task",
    "Judge whether the candidate opinion belongs inside this cluster."
  ].join("\n");
}

function buildClusterThemeSupportPrompt(options: {
  instructions: string;
  viewName: string;
  cluster: NonNullable<LoadedClusterArtifact["clusters"]>[number];
  sampledOpinions: Array<LoadedOpinionArtifact & { opinionId: string; opinionText: string }>;
}): string {
  const sampledBlock = options.sampledOpinions
    .map((opinion, index) =>
      [
        `Sampled-${index + 1}-Opinion-ID: ${opinion.opinionId}`,
        `Sampled-${index + 1}-Opinion-Text: ${opinion.opinionText}`,
        `Sampled-${index + 1}-Opinion-Excerpt: ${opinion.excerpt ?? "(none)"}`
      ].join("\n")
    )
    .join("\n\n");

  return [
    options.instructions.trim(),
    "",
    "## Cluster Under Review",
    `View-Name: ${options.viewName}`,
    `Cluster-ID: ${String(options.cluster.clusterId ?? "unknown")}`,
    `Cluster-Label: ${options.cluster.label ?? "(missing)"}`,
    `Cluster-Summary: ${options.cluster.summary ?? "(missing)"}`,
    `Cluster-Top-Terms: ${(options.cluster.topTerms ?? []).join(" | ") || "(none)"}`,
    "",
    "## Sampled Source Opinions",
    sampledBlock.length === 0 ? "(none)" : sampledBlock
  ].join("\n");
}

function buildThemeMergeReviewPrompt(options: {
  instructions: string;
  viewName: string;
  theme: NonNullable<LoadedHierarchyArtifact["themes"]>[number];
  clusterArtifact: LoadedClusterArtifact | undefined;
}): string {
  const clusterIds = options.theme.clusterIds ?? [];
  const referencedClusters = clusterIds
    .map((clusterId) =>
      (options.clusterArtifact?.clusters ?? []).find(
        (cluster) => String(cluster.clusterId ?? "unknown") === String(clusterId)
      )
    )
    .filter((cluster): cluster is NonNullable<LoadedClusterArtifact["clusters"]>[number] => cluster !== undefined);
  const clusterBlock = referencedClusters
    .map((cluster) =>
      [
        `Cluster-ID: ${String(cluster.clusterId ?? "unknown")}`,
        `Cluster-Label: ${cluster.label ?? "(missing)"}`,
        `Cluster-Summary: ${cluster.summary ?? "(missing)"}`
      ].join("\n")
    )
    .join("\n\n");

  return [
    options.instructions.trim(),
    "",
    "## Theme Under Review",
    `View-Name: ${options.viewName}`,
    `Theme-ID: ${String(options.theme.themeId ?? "unknown")}`,
    `Theme-Label: ${options.theme.themeLabel ?? "(missing)"}`,
    `Theme-Summary: ${options.theme.themeSummary ?? "(missing)"}`,
    `Theme-Cluster-IDs: ${clusterIds.map(String).join(" | ") || "(none)"}`,
    `Theme-Merge-Rationale: ${options.theme.mergeRationale ?? "(missing)"}`,
    "",
    "## Included Clusters",
    clusterBlock.length === 0 ? "(none)" : clusterBlock
  ].join("\n");
}

function checkRunIntegrity(options: {
  analysisRunId: string;
  analysisRunDir: string;
  analysisManifest: LoadedAnalysisManifest;
  reportBundle: LoadedReportBundle | null;
  reportBundlePath: string | null;
  clusterArtifacts: Array<JsonArtifact<LoadedClusterArtifact>>;
  hierarchyArtifacts: Array<JsonArtifact<LoadedHierarchyArtifact>>;
  viewArtifacts: Array<JsonArtifact<LoadedViewArtifact>>;
  addIssue: (issue: IssueRecord) => void;
}): void {
  if ((options.analysisManifest.runId ?? options.analysisManifest.analysisRunId) !== options.analysisRunId) {
    options.addIssue({
      phase: "phase1-structural",
      severity: "error",
      category: "run-integrity",
      code: "analysis-run-id-mismatch",
      message: "Analysis manifest does not match the selected analysis run id."
    });
  }

  if (options.clusterArtifacts.length === 0) {
    options.addIssue({
      phase: "phase1-structural",
      severity: "error",
      category: "run-integrity",
      code: "missing-cluster-artifacts",
      message: "No cluster artifacts were found for this analysis run."
    });
  }

  if (options.viewArtifacts.length === 0) {
    options.addIssue({
      phase: "phase1-structural",
      severity: "error",
      category: "run-integrity",
      code: "missing-view-artifacts",
      message: "No view artifacts were found for this analysis run."
    });
  }

  if (options.reportBundlePath !== null && options.reportBundle?.analysisRunId !== options.analysisRunId) {
    options.addIssue({
      phase: "phase1-structural",
      severity: "error",
      category: "run-integrity",
      code: "report-analysis-run-mismatch",
      message: "Report bundle analysisRunId does not match the selected analysis run.",
      artifactPath: options.reportBundlePath
    });
  }

  if (options.reportBundlePath === null) {
    options.addIssue({
      phase: "phase1-structural",
      severity: "warning",
      category: "soft-consistency",
      code: "missing-report-bundle",
      message: "No report bundle exists for this analysis run."
    });
  }
}

function checkClusterIntegrity(options: {
  clusterArtifacts: Array<JsonArtifact<LoadedClusterArtifact>>;
  opinionArtifacts: Map<string, LoadedOpinionArtifact>;
  addIssue: (issue: IssueRecord) => void;
}): void {
  for (const { path: artifactPath, artifact } of options.clusterArtifacts) {
    for (const member of artifact.members ?? []) {
      if (member.opinionId === undefined || options.opinionArtifacts.has(member.opinionId) === false) {
        options.addIssue({
          phase: "phase1-structural",
          severity: "error",
          category: "cluster-integrity",
          code: "missing-cluster-member-opinion",
          message: `Cluster member opinion '${member.opinionId ?? "unknown"}' could not be resolved.`,
          artifactPath
        });
      }
    }

    for (const cluster of artifact.clusters ?? []) {
      const memberOpinionIds = new Set(
        (artifact.members ?? [])
          .filter((member) => member.clusterId === cluster.clusterId && member.opinionId !== undefined)
          .map((member) => member.opinionId as string)
      );

      for (const representative of cluster.representativeOpinions ?? []) {
        if (
          representative.opinionId === undefined ||
          options.opinionArtifacts.has(representative.opinionId) === false
        ) {
          options.addIssue({
            phase: "phase1-structural",
            severity: "error",
            category: "cluster-integrity",
            code: "missing-representative-opinion",
            message: `Representative opinion '${representative.opinionId ?? "unknown"}' could not be resolved.`,
            artifactPath
          });
          continue;
        }

        if (memberOpinionIds.size > 0 && memberOpinionIds.has(representative.opinionId) === false) {
          options.addIssue({
            phase: "phase1-structural",
            severity: "warning",
            category: "cluster-integrity",
            code: "representative-opinion-not-member",
            message: `Representative opinion '${representative.opinionId}' is not present in the cluster member assignments.`,
            artifactPath
          });
        }
      }
    }
  }
}

function checkViewIntegrity(options: {
  viewArtifacts: Array<JsonArtifact<LoadedViewArtifact>>;
  clusterArtifactByPath: Map<string, LoadedClusterArtifact>;
  reportBundle: LoadedReportBundle | null;
  addIssue: (issue: IssueRecord) => void;
}): void {
  const viewArtifactByName = new Map(
    options.viewArtifacts.map((item) => [item.artifact.viewName ?? item.artifact.mode ?? "", item] as const)
  );

  for (const { path: artifactPath, artifact } of options.viewArtifacts) {
    if (artifact.chosenClusterArtifactPath === undefined) {
      options.addIssue({
        phase: "phase1-structural",
        severity: "warning",
        category: "view-integrity",
        code: "missing-chosen-cluster-artifact-path",
        message: "View artifact does not declare a chosenClusterArtifactPath.",
        artifactPath
      });
      continue;
    }

    const chosenClusterArtifact = options.clusterArtifactByPath.get(artifact.chosenClusterArtifactPath);

    if (chosenClusterArtifact === undefined) {
      options.addIssue({
        phase: "phase1-structural",
        severity: "error",
        category: "view-integrity",
        code: "missing-chosen-cluster-artifact",
        message: "View artifact references a missing chosenClusterArtifactPath.",
        artifactPath
      });
      continue;
    }

    const knownClusterIds = new Set(
      (chosenClusterArtifact.clusters ?? [])
        .map((cluster) => cluster.clusterId)
        .filter((value): value is number => typeof value === "number")
        .map(String)
    );

    for (const highlight of artifact.highlights ?? []) {
      const clusterId = String(highlight.clusterId ?? "unknown");

      if (knownClusterIds.has(clusterId) === false) {
        options.addIssue({
          phase: "phase1-structural",
          severity: "error",
          category: "view-integrity",
          code: "missing-highlighted-cluster",
          message: `Highlighted cluster '${clusterId}' does not exist in the chosen cluster artifact.`,
          artifactPath
        });
      }
    }
  }

  for (const reportView of options.reportBundle?.views ?? []) {
    const viewId = reportView.viewId ?? "";

    if (viewArtifactByName.has(viewId) === false) {
      options.addIssue({
        phase: "phase1-structural",
        severity: "error",
        category: "view-integrity",
        code: "report-view-missing-artifact",
        message: `Report view '${viewId}' does not map to a view artifact.`
      });
    }
  }
}

async function checkEvidenceIntegrity(options: {
  reportBundle: LoadedReportBundle | null;
  opinionArtifacts: Map<string, LoadedOpinionArtifact>;
  addIssue: (issue: IssueRecord) => void;
}): Promise<void> {
  for (const [opinionId, opinion] of options.opinionArtifacts.entries()) {
    if (opinion.provenance?.normalizedRecordPath === undefined) {
      options.addIssue({
        phase: "phase1-structural",
        severity: "error",
        category: "evidence-integrity",
        code: "missing-normalized-record-path",
        message: `Opinion '${opinionId}' is missing normalizedRecordPath provenance.`
      });
      continue;
    }

    const normalizedRecordSource = await readFile(opinion.provenance.normalizedRecordPath, "utf8").catch(() => null);

    if (normalizedRecordSource === null) {
      options.addIssue({
        phase: "phase1-structural",
        severity: "error",
        category: "evidence-integrity",
        code: "missing-normalized-record",
        message: `Opinion '${opinionId}' points to a missing normalized record.`,
        artifactPath: opinion.provenance.normalizedRecordPath
      });
      continue;
    }

    const normalizedRecord = JSON.parse(normalizedRecordSource) as LoadedNormalizedRecord;

    if (
      opinion.sourceContentSha256 !== undefined &&
      normalizedRecord.contentSha256 !== undefined &&
      opinion.sourceContentSha256 !== normalizedRecord.contentSha256
    ) {
      options.addIssue({
        phase: "phase1-structural",
        severity: "error",
        category: "evidence-integrity",
        code: "source-content-sha-mismatch",
        message: `Opinion '${opinionId}' does not match the normalized record content SHA.`,
        artifactPath: opinion.provenance.normalizedRecordPath
      });
    }

    if (opinion.provenance.sourceImportPath !== undefined) {
      const importExists = await fileExists(opinion.provenance.sourceImportPath);

      if (importExists === false) {
        options.addIssue({
          phase: "phase1-structural",
          severity: "error",
          category: "evidence-integrity",
          code: "missing-source-import",
          message: `Opinion '${opinionId}' points to a missing source import path.`,
          artifactPath: opinion.provenance.sourceImportPath
        });
      }
    }
  }

  for (const view of options.reportBundle?.views ?? []) {
    for (const cluster of view.clusters ?? []) {
      for (const quote of cluster.evidenceQuotes ?? []) {
        const opinion = quote.sourceId === undefined ? undefined : options.opinionArtifacts.get(quote.sourceId);

        if (opinion === undefined) {
          options.addIssue({
            phase: "phase1-structural",
            severity: "error",
            category: "evidence-integrity",
            code: "missing-report-evidence-opinion",
            message: `Report evidence quote points to missing opinion '${quote.sourceId ?? "unknown"}'.`
          });
          continue;
        }

        const excerpt = quote.excerpt?.trim() ?? "";
        const opinionText = opinion.opinionText ?? "";
        const opinionExcerpt = opinion.excerpt ?? "";
        const excerptFound =
          excerpt.length === 0 ||
          opinionText.includes(excerpt) ||
          opinionExcerpt.includes(excerpt);

        if (excerptFound === false) {
          options.addIssue({
            phase: "phase1-structural",
            severity: "warning",
            category: "evidence-integrity",
            code: "report-excerpt-not-found",
            message: `Report quote excerpt for opinion '${quote.sourceId ?? "unknown"}' was not found in the opinion text or excerpt.`
          });
        }
      }
    }
  }
}

function checkSoftWarnings(options: {
  clusterArtifacts: Array<JsonArtifact<LoadedClusterArtifact>>;
  hierarchyArtifacts: Array<JsonArtifact<LoadedHierarchyArtifact>>;
  viewArtifacts: Array<JsonArtifact<LoadedViewArtifact>>;
  reportBundle: LoadedReportBundle | null;
  clusterArtifactByPath: Map<string, LoadedClusterArtifact>;
  addIssue: (issue: IssueRecord) => void;
}): void {
  for (const { path: artifactPath, artifact } of options.clusterArtifacts) {
    for (const cluster of artifact.clusters ?? []) {
      if ((cluster.representativeOpinions?.length ?? 0) === 0) {
        options.addIssue({
          phase: "phase1-structural",
          severity: "warning",
          category: "soft-consistency",
          code: "cluster-without-representatives",
          message: `Cluster '${cluster.clusterId ?? "unknown"}' has no representative opinions.`,
          artifactPath
        });
      }
    }
  }

  for (const { path: artifactPath, artifact } of options.viewArtifacts) {
    if ((artifact.highlights?.length ?? 0) === 0) {
      options.addIssue({
        phase: "phase1-structural",
        severity: "warning",
        category: "soft-consistency",
        code: "view-without-highlights",
        message: `View '${artifact.viewName ?? artifact.mode ?? "unknown"}' has zero highlights.`,
        artifactPath
      });
    }
  }

  for (const { path: artifactPath, artifact } of options.hierarchyArtifacts) {
    const sourceClusterArtifact =
      artifact.sourceClusterArtifactPath === undefined
        ? undefined
        : options.clusterArtifactByPath.get(artifact.sourceClusterArtifactPath);
    const clusterIds = new Set(
      (sourceClusterArtifact?.clusters ?? [])
        .map((cluster) => cluster.clusterId)
        .filter((value): value is number => typeof value === "number")
        .map(String)
    );

    for (const theme of artifact.themes ?? []) {
      for (const clusterId of theme.clusterIds ?? []) {
        if (clusterIds.has(String(clusterId)) === false) {
          options.addIssue({
            phase: "phase1-structural",
            severity: "warning",
            category: "soft-consistency",
            code: "theme-references-missing-cluster",
            message: `Theme references missing cluster '${String(clusterId)}'.`,
            artifactPath
          });
        }
      }
    }
  }
}

function buildScorecard(
  qaRunId: string,
  analysisRunId: string,
  phases: QaPhase[],
  issues: IssueRecord[],
  clusterMembershipSummary: ClusterMembershipSummary | null,
  themeSupportSummary: ThemeSupportSummary | null
): Scorecard {
  const categories: Scorecard["categories"] = {
    runIntegrity: buildIssueBackedCategory(phases, issues, "phase1-structural", "run-integrity"),
    clusterIntegrity: buildIssueBackedCategory(phases, issues, "phase1-structural", "cluster-integrity"),
    viewIntegrity: buildIssueBackedCategory(phases, issues, "phase1-structural", "view-integrity"),
    evidenceIntegrity: buildIssueBackedCategory(phases, issues, "phase1-structural", "evidence-integrity"),
    softConsistency: buildIssueBackedCategory(phases, issues, "phase1-structural", "soft-consistency"),
    clusterMembershipQuality:
      phases.includes("phase2-cluster-membership") && clusterMembershipSummary !== null
        ? buildClusterMembershipCategory(clusterMembershipSummary, issues)
        : createNotRunCategory(),
    clusterThemeSupport:
      phases.includes("phase3-theme-support") && themeSupportSummary !== null
        ? buildClusterThemeSupportCategory(themeSupportSummary, issues)
        : createNotRunCategory(),
    themeMergeQuality:
      phases.includes("phase3-theme-support") && themeSupportSummary !== null
        ? buildThemeMergeCategory(themeSupportSummary, issues)
        : createNotRunCategory()
  };

  const activeCategories = Object.values(categories).filter((category) => category.status === "scored");
  const totals = activeCategories.reduce(
    (accumulator, category) => ({
      checks: accumulator.checks + category.checks,
      passed: accumulator.passed + category.passed,
      errors: accumulator.errors + category.errors,
      warnings: accumulator.warnings + category.warnings,
      score: 0
    }),
    { checks: 0, passed: 0, errors: 0, warnings: 0, score: 0 }
  );
  const score =
    activeCategories.length === 0
      ? 0
      : Math.round(
          activeCategories.reduce((sum, category) => sum + (category.score ?? 0), 0) /
            activeCategories.length
        );

  return {
    qaRunId,
    analysisRunId,
    createdAt: new Date().toISOString(),
    categories,
    totals: {
      ...totals,
      score
    },
    status: totals.errors > 0 ? "completed-with-failures" : "completed"
  };
}

function buildIssueBackedCategory(
  phases: QaPhase[],
  issues: IssueRecord[],
  phase: QaPhase,
  category: IssueCategory
): ScorecardCategory {
  if (phases.includes(phase) === false) {
    return createNotRunCategory();
  }

  const categoryIssues = issues.filter((issue) => issue.phase === phase && issue.category === category);
  const errors = categoryIssues.filter((issue) => issue.severity === "error").length;
  const warnings = categoryIssues.filter((issue) => issue.severity === "warning").length;
  const checks = Math.max(1, errors + warnings + 1);
  const passed = Math.max(0, checks - errors - warnings);
  const score = Math.max(0, Math.round((passed / checks) * 100));

  return {
    status: "scored",
    checks,
    passed,
    errors,
    warnings,
    score
  };
}

function buildClusterMembershipCategory(
  summary: ClusterMembershipSummary,
  issues: IssueRecord[]
): ScorecardCategory {
  const categoryIssues = issues.filter((issue) => issue.category === "cluster-membership-quality");
  const warnings = categoryIssues.filter((issue) => issue.severity === "warning").length;
  const errors = categoryIssues.filter((issue) => issue.severity === "error").length;
  const checks = summary.reviewed;
  const passed = summary.fit + summary.borderline;
  const score =
    summary.reviewed === 0
      ? 0
      : Math.round(((summary.fit + summary.borderline * 0.5) / summary.reviewed) * 100);

  return {
    status: "scored",
    checks,
    passed,
    errors,
    warnings,
    score
  };
}

function buildClusterThemeSupportCategory(
  summary: ThemeSupportSummary,
  issues: IssueRecord[]
): ScorecardCategory {
  const categoryIssues = issues.filter((issue) => issue.category === "cluster-theme-support");
  const warnings = categoryIssues.filter((issue) => issue.severity === "warning").length;
  const errors = categoryIssues.filter((issue) => issue.severity === "error").length;
  const checks = summary.supported + summary.mixed + summary.unsupported;
  const passed = summary.supported + summary.mixed;
  const score =
    checks === 0 ? 0 : Math.round(((summary.supported + summary.mixed * 0.5) / checks) * 100);

  return {
    status: "scored",
    checks,
    passed,
    errors,
    warnings,
    score
  };
}

function buildThemeMergeCategory(
  summary: ThemeSupportSummary,
  issues: IssueRecord[]
): ScorecardCategory {
  const categoryIssues = issues.filter((issue) => issue.category === "theme-merge-quality");
  const warnings = categoryIssues.filter((issue) => issue.severity === "warning").length;
  const errors = categoryIssues.filter((issue) => issue.severity === "error").length;
  const checks = summary.coherent + summary.borderline + summary.overmerged;
  const passed = summary.coherent + summary.borderline;
  const score =
    checks === 0 ? 0 : Math.round(((summary.coherent + summary.borderline * 0.5) / checks) * 100);

  return {
    status: "scored",
    checks,
    passed,
    errors,
    warnings,
    score
  };
}

function createNotRunCategory(): ScorecardCategory {
  return {
    status: "not-run",
    checks: 0,
    passed: 0,
    errors: 0,
    warnings: 0,
    score: null
  };
}

function buildQaManifest(options: {
  qaRunId: string;
  analysisRunId: string;
  analysisManifestPath: string;
  analysisManifestSha256: string;
  reportBundlePath: string | null;
  reportBundleSha256: string | null;
  phases: QaPhase[];
  qaModel: RegisteredModel | null;
  sampling: QaSamplingConfig;
  clusterMembershipPrompt: { path: string | null; source: string; sha256: string };
  clusterThemeSupportPrompt: { path: string | null; source: string; sha256: string };
  themeMergeReviewPrompt: { path: string | null; source: string; sha256: string };
  status: QaRunManifest["status"];
  qaDir: string;
  manifestPath: string;
  scorecardPath: string;
  provenanceCheckPath: string;
  provenanceFailuresPath: string;
  clusterMembershipDir: string;
  themeReviewDir: string;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  clusterMembershipArtifacts: number;
  clusterOutlierArtifacts: number;
  clusterThemeSupportArtifacts: number;
  themeMergeReviewArtifacts: number;
}): QaRunManifest {
  const timestamp = new Date().toISOString();

  return {
    qaRunId: options.qaRunId,
    analysisRunId: options.analysisRunId,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: options.status,
    fingerprint: {
      analysisRunId: options.analysisRunId,
      analysisManifestSha256: options.analysisManifestSha256,
      reportBundleSha256: options.reportBundleSha256,
      phases: options.phases,
      qaModelAlias: options.qaModel?.name ?? null,
      qaModelFingerprint: options.qaModel === null ? null : modelFingerprintValue(options.qaModel),
      clusterMembershipPromptSha256:
        options.phases.includes("phase2-cluster-membership") ? options.clusterMembershipPrompt.sha256 : null,
      clusterThemeSupportPromptSha256:
        options.phases.includes("phase3-theme-support") ? options.clusterThemeSupportPrompt.sha256 : null,
      themeMergeReviewPromptSha256:
        options.phases.includes("phase3-theme-support") ? options.themeMergeReviewPrompt.sha256 : null,
      sampling: options.sampling
    },
    input: {
      analysisManifestPath: options.analysisManifestPath,
      reportBundlePath: options.reportBundlePath,
      phases: options.phases,
      ...(options.qaModel === null ? {} : { qaModel: options.qaModel.name }),
      sampling: options.sampling,
      prompts: {
        clusterMembership: {
          path:
            options.phases.includes("phase2-cluster-membership") === false
              ? null
              : options.clusterMembershipPrompt.path,
          sha256:
            options.phases.includes("phase2-cluster-membership") === false
              ? null
              : options.clusterMembershipPrompt.sha256
        },
        clusterThemeSupport: {
          path:
            options.phases.includes("phase3-theme-support") === false
              ? null
              : options.clusterThemeSupportPrompt.path,
          sha256:
            options.phases.includes("phase3-theme-support") === false
              ? null
              : options.clusterThemeSupportPrompt.sha256
        },
        themeMergeReview: {
          path:
            options.phases.includes("phase3-theme-support") === false
              ? null
              : options.themeMergeReviewPrompt.path,
          sha256:
            options.phases.includes("phase3-theme-support") === false
              ? null
              : options.themeMergeReviewPrompt.sha256
        }
      }
    },
    output: {
      qaDir: options.qaDir,
      manifestPath: options.manifestPath,
      scorecardPath: options.scorecardPath,
      provenanceCheckPath: options.provenanceCheckPath,
      provenanceFailuresPath: options.provenanceFailuresPath,
      clusterMembershipDir: options.clusterMembershipDir,
      themeReviewDir: options.themeReviewDir,
      issueCount: options.issueCount,
      errorCount: options.errorCount,
      warningCount: options.warningCount,
      clusterMembershipArtifacts: options.clusterMembershipArtifacts,
      clusterOutlierArtifacts: options.clusterOutlierArtifacts,
      clusterThemeSupportArtifacts: options.clusterThemeSupportArtifacts,
      themeMergeReviewArtifacts: options.themeMergeReviewArtifacts
    }
  };
}

async function writeQaManifest(filePath: string, manifest: QaRunManifest): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function loadJsonArtifacts<T>(
  directoryPath: string
): Promise<Array<JsonArtifact<T>>> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  const artifacts: Array<JsonArtifact<T>> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const artifactPath = path.join(directoryPath, entry.name);
    const source = await readFile(artifactPath, "utf8").catch(() => null);

    if (source === null) {
      continue;
    }

    try {
      artifacts.push({
        path: artifactPath,
        artifact: JSON.parse(source) as T
      });
    } catch {
      continue;
    }
  }

  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

async function loadOpinionArtifacts(
  dataDir: string,
  opinionRunIds: string[]
): Promise<Map<string, LoadedOpinionArtifact>> {
  const opinions = new Map<string, LoadedOpinionArtifact>();

  for (const opinionRunId of opinionRunIds) {
    const opinionsDir = path.join(dataDir, "opinions", opinionRunId, "opinions");
    const entries = await readdir(opinionsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const artifactPath = path.join(opinionsDir, entry.name);
      const source = await readFile(artifactPath, "utf8").catch(() => null);

      if (source === null) {
        continue;
      }

      try {
        const artifact = JSON.parse(source) as LoadedOpinionArtifact;

        if (artifact.opinionId !== undefined) {
          opinions.set(artifact.opinionId, artifact);
        }
      } catch {
        continue;
      }
    }
  }

  return opinions;
}

function collectOpinionRunIds(
  input:
    | {
        opinionRunId?: string;
        groups?: Array<{ opinionRunId?: string }>;
      }
    | undefined
): string[] {
  const ids = new Set<string>();

  if (input?.opinionRunId !== undefined) {
    ids.add(input.opinionRunId);
  }

  for (const group of input?.groups ?? []) {
    if (group.opinionRunId !== undefined) {
      ids.add(group.opinionRunId);
    }
  }

  return [...ids];
}

async function findLatestAnalysisRun(runsDir: string): Promise<string | null> {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs: Array<{ name: string; createdAt: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifest = await readJsonFile<LoadedAnalysisManifest>(
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

async function resolveClusterMembershipPrompt(promptsDir: string): Promise<{
  path: string | null;
  source: string;
  sha256: string;
}> {
  const filePath = path.join(promptsDir, "qa-cluster-membership.md");
  const source = await readFile(filePath, "utf8").catch(() => createDefaultClusterMembershipPrompt());

  return {
    path: (await fileExists(filePath)) ? filePath : null,
    source,
    sha256: sha256Hex(source)
  };
}

async function resolveClusterThemeSupportPrompt(promptsDir: string): Promise<{
  path: string | null;
  source: string;
  sha256: string;
}> {
  const filePath = path.join(promptsDir, "qa-cluster-theme-support.md");
  const source = await readFile(filePath, "utf8").catch(() => createDefaultClusterThemeSupportPrompt());

  return {
    path: (await fileExists(filePath)) ? filePath : null,
    source,
    sha256: sha256Hex(source)
  };
}

async function resolveThemeMergeReviewPrompt(promptsDir: string): Promise<{
  path: string | null;
  source: string;
  sha256: string;
}> {
  const filePath = path.join(promptsDir, "qa-theme-merge-review.md");
  const source = await readFile(filePath, "utf8").catch(() => createDefaultThemeMergeReviewPrompt());

  return {
    path: (await fileExists(filePath)) ? filePath : null,
    source,
    sha256: sha256Hex(source)
  };
}

function createDefaultClusterMembershipPrompt(): string {
  return `# QA Cluster Membership Prompt

You are reviewing whether a candidate opinion truly belongs in a labeled opinion cluster.

Use the cluster label, summary, top terms, and representative opinions as your evidence base.
Judge only the candidate opinion shown in the prompt.

## Rules

- Return plain text only using the exact header format below.
- Do not wrap the response in code fences.
- Use \`fit\` when the opinion clearly belongs in the cluster.
- Use \`borderline\` when the opinion is adjacent or partially relevant but not a strong example.
- Use \`outlier\` when the opinion does not really belong in the cluster.
- Keep the rationale short and concrete.

## Output format

\`\`\`text
Verdict: fit | borderline | outlier
Confidence: high | medium | low
Rationale: One or two sentences explaining the judgment
\`\`\`
`;
}

function createDefaultClusterThemeSupportPrompt(): string {
  return `# QA Cluster Theme Support Prompt

You are reviewing whether a cluster's label and summary are actually supported by sampled source opinions from that cluster.

## Rules

- Return plain text only using the exact header format below.
- Do not wrap the response in code fences.
- Use \`supported\` when the sampled opinions clearly justify the label and summary.
- Use \`mixed\` when the cluster theme is partly supported but too broad, too narrow, or not well-centered.
- Use \`unsupported\` when the label and summary do not match the sampled opinions well.
- Keep the rationale brief and concrete.

## Output format

\`\`\`text
Verdict: supported | mixed | unsupported
Confidence: high | medium | low
Rationale: One or two sentences explaining the judgment
\`\`\`
`;
}

function createDefaultThemeMergeReviewPrompt(): string {
  return `# QA Theme Merge Review Prompt

You are reviewing whether a higher-level theme groups lower-level clusters in a semantically coherent way.

## Rules

- Return plain text only using the exact header format below.
- Do not wrap the response in code fences.
- Use \`coherent\` when the grouped clusters clearly belong together.
- Use \`borderline\` when the grouping is mostly plausible but somewhat over-broad or fuzzy.
- Use \`overmerged\` when materially distinct clusters were grouped together.
- Keep the rationale brief and concrete.

## Output format

\`\`\`text
Verdict: coherent | borderline | overmerged
Confidence: high | medium | low
Rationale: One or two sentences explaining the judgment
\`\`\`
`;
}

function resolveQaPhases(values: string[] | undefined): QaPhase[] {
  if (values === undefined || values.length === 0) {
    return ["phase1-structural"];
  }

  const phases = new Set<QaPhase>();

  for (const value of values) {
    const normalized = value.trim().toLowerCase();

    if (
      normalized === "phase1" ||
      normalized === "structural" ||
      normalized === "phase1-structural"
    ) {
      phases.add("phase1-structural");
      continue;
    }

    if (
      normalized === "phase2" ||
      normalized === "cluster-membership" ||
      normalized === "phase2-cluster-membership"
    ) {
      phases.add("phase2-cluster-membership");
      continue;
    }

    if (
      normalized === "phase3" ||
      normalized === "theme-support" ||
      normalized === "phase3-theme-support"
    ) {
      phases.add("phase3-theme-support");
      continue;
    }

    throw new Error(`Unknown QA phase '${value}'. Supported values: structural, cluster-membership, theme-support.`);
  }

  return [...phases];
}

function resolveSamplingConfig(options: QaCommandOptions): QaSamplingConfig {
  if (options.qaAll === true) {
    return {
      qaAll: true,
      sampleSize: null,
      samplePercent: null,
      viewFilter: options.view ?? [],
      clusterLimit: options.clusterLimit ?? null,
      themeLimit: options.themeLimit ?? null
    };
  }

  return {
    qaAll: false,
    sampleSize: options.sampleSize ?? null,
    samplePercent: options.samplePercent ?? null,
    viewFilter: options.view ?? [],
    clusterLimit: options.clusterLimit ?? null,
    themeLimit: options.themeLimit ?? null
  };
}

function resolveQaModel(
  config: BroadlyProjectConfig,
  explicitModelAlias: string | undefined
): RegisteredModel {
  const alias = explicitModelAlias ?? config.qa_model;

  if (alias === undefined) {
    throw new Error(
      "No QA model is configured. Set qa_model in broadly.yaml or pass --model <alias>."
    );
  }

  const model = config.models.find((item) => item.name === alias);

  if (model === undefined) {
    throw new Error(`QA model '${alias}' is not registered in broadly.yaml.`);
  }

  return model;
}

function modelFingerprintValue(model: RegisteredModel): string {
  return JSON.stringify({
    name: model.name,
    provider: model.provider,
    modelId: model.modelId,
    region: model.region
  });
}

function formatModelLabel(model: RegisteredModel): string {
  return `${model.name} (${model.provider} · ${model.region} · ${model.modelId})`;
}

function formatSamplingLabel(sampling: QaSamplingConfig): string {
  if (sampling.qaAll) {
    return "all opinions in every selected cluster";
  }

  const parts: string[] = [];

  if (sampling.sampleSize !== null) {
    parts.push(`${sampling.sampleSize} per cluster`);
  } else if (sampling.samplePercent !== null) {
    parts.push(`${sampling.samplePercent}% per cluster`);
  } else {
    parts.push("5 per cluster");
  }

  if (sampling.viewFilter.length > 0) {
    parts.push(`views=${sampling.viewFilter.join(",")}`);
  }

  if (sampling.clusterLimit !== null) {
    parts.push(`cluster-limit=${sampling.clusterLimit}`);
  }

  if (sampling.themeLimit !== null) {
    parts.push(`theme-limit=${sampling.themeLimit}`);
  }

  return parts.join(" · ");
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
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function createQaRunId(): string {
  const value = new Date();
  return [
    `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`,
    `${String(value.getHours()).padStart(2, "0")}-${String(value.getMinutes()).padStart(2, "0")}-${String(value.getSeconds()).padStart(2, "0")}-${String(value.getMilliseconds()).padStart(3, "0")}`
  ].join("_");
}

function toPortableRelativePath(projectRoot: string, absolutePath: string): string {
  const relativePath = path.relative(projectRoot, absolutePath);
  return relativePath === "" ? "." : `./${relativePath.split(path.sep).join("/")}`;
}
