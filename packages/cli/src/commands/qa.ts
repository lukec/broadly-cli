import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig } from "@broadly/config";
import { resolveProjectPaths, sha256Hex } from "@broadly/core";
import { readCurrentRunId, writeCurrentRunId } from "../projectArtifacts.js";
import { withProjectActionLog } from "../projectLog.js";
import { resolveCommandProjectRoot } from "./projectDashboard.js";

export interface QaCommandOptions {
  project?: string;
  run?: string;
}

interface IssueRecord {
  phase: "phase1-structural";
  severity: "error" | "warning";
  category:
    | "run-integrity"
    | "cluster-integrity"
    | "view-integrity"
    | "evidence-integrity"
    | "soft-consistency";
  code: string;
  message: string;
  artifactPath?: string;
  details?: Record<string, unknown>;
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
    phases: string[];
  };
  input: {
    analysisManifestPath: string;
    reportBundlePath: string | null;
    phases: string[];
    qaModel?: string;
  };
  output: {
    qaDir: string;
    manifestPath: string;
    scorecardPath: string;
    provenanceCheckPath: string;
    provenanceFailuresPath: string;
    issueCount: number;
    errorCount: number;
    warningCount: number;
  };
}

interface ScorecardCategory {
  checks: number;
  passed: number;
  errors: number;
  warnings: number;
  score: number;
}

interface Scorecard {
  qaRunId: string;
  analysisRunId: string;
  createdAt: string;
  categories: Record<
    "runIntegrity" | "clusterIntegrity" | "viewIntegrity" | "evidenceIntegrity" | "softConsistency",
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
    representativeOpinions?: Array<{ opinionId?: string }>;
    summary?: string;
  }>;
}

interface LoadedHierarchyArtifact {
  status?: string;
  sourceClusterArtifactPath?: string;
  themes?: Array<{ clusterIds?: Array<string | number> }>;
}

interface LoadedViewArtifact {
  viewName?: string;
  mode?: string;
  chosenClusterArtifactPath?: string;
  highlights?: Array<{ clusterId?: number | string }>;
}

interface LoadedReportBundle {
  analysisRunId?: string;
  views?: Array<{ viewId?: string; clusters?: Array<{ clusterId?: string; evidenceQuotes?: Array<{ sourceId?: string; excerpt?: string }> }> }>;
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

export async function runQa(options: QaCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  await withProjectActionLog({
    projectRoot,
    command: "qa",
    details: {
      run: options.run ?? "(current-or-latest)"
    },
    action: async () => {
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

      const qaRootDir = path.join(analysisRunDir, "qa");
      const qaRunId = createQaRunId();
      const qaDir = path.join(qaRootDir, qaRunId);
      const currentRunPointerPath = path.join(qaRootDir, "current-run.txt");
      const manifestPath = path.join(qaDir, "manifest.json");
      const scorecardPath = path.join(qaDir, "scorecard.json");
      const provenanceCheckPath = path.join(qaDir, "provenance-check.json");
      const provenanceFailuresPath = path.join(qaDir, "provenance-failures.jsonl");

      await mkdir(qaDir, { recursive: true });
      await writeCurrentRunId(currentRunPointerPath, qaRunId);

      const issues: IssueRecord[] = [];
      const addIssue = (issue: IssueRecord): void => {
        issues.push(issue);
      };

      await writeQaManifest({
        manifestPath,
        qaRunId,
        analysisRunId,
        analysisManifestPath,
        analysisManifestSha256: sha256Hex(analysisManifestSource),
        reportBundleSha256: reportBundleSource === null ? null : sha256Hex(reportBundleSource),
        reportBundlePath: reportBundleSource === null ? null : reportBundlePath,
        qaDir,
        scorecardPath,
        provenanceCheckPath,
        provenanceFailuresPath,
        status: "running",
        ...(config.qa_model === undefined ? {} : { qaModel: config.qa_model }),
        issueCount: 0,
        errorCount: 0,
        warningCount: 0
      });

      const clustersDir = path.join(analysisRunDir, "clusters");
      const hierarchiesDir = path.join(analysisRunDir, "hierarchies");
      const viewsDir = path.join(analysisRunDir, "perspectives");

      const clusterArtifacts = await loadJsonArtifacts<LoadedClusterArtifact>(clustersDir);
      const hierarchyArtifacts = await loadJsonArtifacts<LoadedHierarchyArtifact>(hierarchiesDir);
      const viewArtifacts = await loadJsonArtifacts<LoadedViewArtifact>(viewsDir);

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

      const opinionRunIds = collectOpinionRunIds(analysisManifest.input);
      const opinionArtifacts = await loadOpinionArtifacts(projectPaths.dataDir, opinionRunIds);
      const clusterArtifactByPath = new Map(clusterArtifacts.map((item) => [item.path, item.artifact] as const));

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

      const scorecard = buildScorecard(qaRunId, analysisRunId, issues);
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

      await writeQaManifest({
        manifestPath,
        qaRunId,
        analysisRunId,
        analysisManifestPath,
        analysisManifestSha256: sha256Hex(analysisManifestSource),
        reportBundleSha256: reportBundleSource === null ? null : sha256Hex(reportBundleSource),
        reportBundlePath: reportBundleSource === null ? null : reportBundlePath,
        qaDir,
        scorecardPath,
        provenanceCheckPath,
        provenanceFailuresPath,
        status: scorecard.status,
        ...(config.qa_model === undefined ? {} : { qaModel: config.qa_model }),
        issueCount: issues.length,
        errorCount: provenanceCheck.errorCount,
        warningCount: provenanceCheck.warningCount
      });

      const lines = [
        "Broadly QA",
        "",
        `Analysis run: ${analysisRunId}`,
        `QA run: ${qaRunId}`,
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

function checkRunIntegrity(options: {
  analysisRunId: string;
  analysisRunDir: string;
  analysisManifest: LoadedAnalysisManifest;
  reportBundle: LoadedReportBundle | null;
  reportBundlePath: string | null;
  clusterArtifacts: Array<{ path: string; artifact: LoadedClusterArtifact }>;
  hierarchyArtifacts: Array<{ path: string; artifact: LoadedHierarchyArtifact }>;
  viewArtifacts: Array<{ path: string; artifact: LoadedViewArtifact }>;
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
  clusterArtifacts: Array<{ path: string; artifact: LoadedClusterArtifact }>;
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
  viewArtifacts: Array<{ path: string; artifact: LoadedViewArtifact }>;
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
  clusterArtifacts: Array<{ path: string; artifact: LoadedClusterArtifact }>;
  hierarchyArtifacts: Array<{ path: string; artifact: LoadedHierarchyArtifact }>;
  viewArtifacts: Array<{ path: string; artifact: LoadedViewArtifact }>;
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
  issues: IssueRecord[]
): Scorecard {
  const categories = {
    runIntegrity: scoreCategory(issues, "run-integrity"),
    clusterIntegrity: scoreCategory(issues, "cluster-integrity"),
    viewIntegrity: scoreCategory(issues, "view-integrity"),
    evidenceIntegrity: scoreCategory(issues, "evidence-integrity"),
    softConsistency: scoreCategory(issues, "soft-consistency")
  };

  const totals = Object.values(categories).reduce(
    (accumulator, category) => ({
      checks: accumulator.checks + category.checks,
      passed: accumulator.passed + category.passed,
      errors: accumulator.errors + category.errors,
      warnings: accumulator.warnings + category.warnings,
      score: 0
    }),
    { checks: 0, passed: 0, errors: 0, warnings: 0, score: 0 }
  );
  const score = totals.checks === 0 ? 100 : Math.max(0, Math.round((totals.passed / totals.checks) * 100));

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

function scoreCategory(
  issues: IssueRecord[],
  category: IssueRecord["category"]
): ScorecardCategory {
  const categoryIssues = issues.filter((issue) => issue.category === category);
  const errors = categoryIssues.filter((issue) => issue.severity === "error").length;
  const warnings = categoryIssues.filter((issue) => issue.severity === "warning").length;
  const checks = Math.max(1, errors + warnings + 1);
  const passed = Math.max(0, checks - errors - warnings);
  const score = Math.max(0, Math.round((passed / checks) * 100));

  return {
    checks,
    passed,
    errors,
    warnings,
    score
  };
}

async function writeQaManifest(options: {
  manifestPath: string;
  qaRunId: string;
  analysisRunId: string;
  analysisManifestPath: string;
  analysisManifestSha256: string;
  reportBundleSha256: string | null;
  reportBundlePath: string | null;
  qaDir: string;
  scorecardPath: string;
  provenanceCheckPath: string;
  provenanceFailuresPath: string;
  status: QaRunManifest["status"];
  qaModel?: string;
  issueCount: number;
  errorCount: number;
  warningCount: number;
}): Promise<void> {
  const manifest: QaRunManifest = {
    qaRunId: options.qaRunId,
    analysisRunId: options.analysisRunId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: options.status,
    fingerprint: {
      analysisRunId: options.analysisRunId,
      analysisManifestSha256: options.analysisManifestSha256,
      reportBundleSha256: options.reportBundleSha256,
      phases: ["phase1-structural"]
    },
    input: {
      analysisManifestPath: options.analysisManifestPath,
      reportBundlePath: options.reportBundlePath,
      phases: ["phase1-structural"],
      ...(options.qaModel === undefined ? {} : { qaModel: options.qaModel })
    },
    output: {
      qaDir: options.qaDir,
      manifestPath: options.manifestPath,
      scorecardPath: options.scorecardPath,
      provenanceCheckPath: options.provenanceCheckPath,
      provenanceFailuresPath: options.provenanceFailuresPath,
      issueCount: options.issueCount,
      errorCount: options.errorCount,
      warningCount: options.warningCount
    }
  };

  await writeFile(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function loadJsonArtifacts<T>(
  directoryPath: string
): Promise<Array<{ path: string; artifact: T }>> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  const artifacts: Array<{ path: string; artifact: T }> = [];

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
      // Skip unreadable artifacts in Phase 1; the missing parse will show up via artifact count/absence.
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
