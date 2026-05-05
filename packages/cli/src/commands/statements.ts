import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig } from "@broadly/config";
import {
  resolveProjectPaths,
  resolveStatementRunPaths,
  sha256Hex,
  type ProjectPaths
} from "@broadly/core";
import type {
  AnalysisViewReport,
  ReportBundle,
  Statement,
  StatementBank,
  StatementEvidenceRef,
  StatementGenerationProvenance,
  StatementModerationStatus,
  StatementQaCheck,
  StatementQaResult,
  StatementQaScorecard,
  StatementReviewArtifact,
  StatementRunManifest,
  StatementVisibilityStatus,
  ThemeSummary
} from "@broadly/report-model";

import {
  artifactExists,
  createTimestampRunId,
  hashFile,
  listJsonArtifactPaths,
  readCurrentRunId,
  readJsonArtifact,
  toProjectRelativePath,
  writeCurrentRunId,
  writeJsonArtifact
} from "../projectArtifacts.js";
import { withProjectActionLog } from "../projectLog.js";
import { resolveCommandProjectRoot } from "./projectDashboard.js";

export interface StatementGenerateCommandOptions {
  project?: string;
  run?: string;
  fromReport?: boolean;
}

export interface StatementQaCommandOptions {
  project?: string;
  run?: string;
}

export interface StatementReviewCommandOptions {
  project?: string;
  run?: string;
  statement?: string;
  status?: string;
  text?: string;
  note?: string;
  accept?: string[];
  reject?: string[];
  exportAccepted?: boolean;
}

export interface LoadedStatementBank {
  bank: StatementBank;
  statementRunId: string;
  statementRunPaths: ReturnType<typeof resolveStatementRunPaths>;
  reviewByStatementId: Map<string, StatementReviewArtifact>;
  statements: Statement[];
}

const STATEMENT_GENERATION_PROMPT = [
  "Generate short, neutral, evidence-grounded statements suitable for agree/disagree/pass voting.",
  "Use extracted opinions referenced by highlighted report clusters first.",
  "Preserve evidence references to the report, cluster, theme, opinion, and source excerpt.",
  "Prefer the participant's extracted opinion text over theme or cluster descriptions.",
  "Keep generated statements pending until local review accepts them."
].join("\n");

const STATEMENT_GENERATOR_ID = "deterministic-evidence-opinions-v2";

const MODERATION_STATUS_VALUES = [
  "pending",
  "accepted",
  "rejected",
  "hidden_from_public",
  "excluded_from_analysis"
] as const;

const VISIBILITY_STATUS_VALUES = ["private", "admin_only", "public"] as const;

export async function generateStatements(options: StatementGenerateCommandOptions): Promise<void> {
  if (options.fromReport !== true) {
    throw new Error("Only --from-report statement generation is implemented.");
  }

  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "statements generate",
    details: {
      run: options.run ?? "(latest)",
      fromReport: true
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

      const reportBundleSha256 = await hashFile(reportBundlePath);
      const promptSha256 = sha256Hex(STATEMENT_GENERATION_PROMPT);
      const compatibleRun = await findCompatibleStatementRun(projectPaths.statementsDir, {
        analysisRunId: reportBundle.analysisRunId,
        sourceReportSha256: reportBundleSha256,
        promptSha256
      });

      if (compatibleRun !== null) {
        await writeCurrentRunId(projectPaths.statementsCurrentRunPath, compatibleRun.statementRunId);
        process.stdout.write(
          [
            `Reused statement bank for ${projectRoot}`,
            "",
            `Statement run: ${compatibleRun.statementRunId}`,
            `Statements: ${compatibleRun.statementsWritten}`,
            `Bank: ${toProjectRelativePath(projectRoot, compatibleRun.statementBankPath)}`
          ].join("\n") + "\n"
        );
        return;
      }

      const statementRunId = createTimestampRunId("statements", reportBundle.analysisRunId);
      const statementRunPaths = resolveStatementRunPaths(projectRoot, statementRunId);
      const createdAt = new Date().toISOString();
      const provenance: StatementGenerationProvenance = {
        generatedAt: createdAt,
        method: "deterministic-report-highlights",
        analysisRunId: reportBundle.analysisRunId,
        reportId: reportBundle.reportId,
        reportBundlePath,
        reportBundleSha256,
        prompt: {
          promptId: STATEMENT_GENERATOR_ID,
          sha256: promptSha256
        },
        model: {
          provider: "local",
          modelId: STATEMENT_GENERATOR_ID
        }
      };
      const opinionArtifacts = await loadOpinionArtifactsForAnalysisRun(
        projectPaths,
        reportBundle.analysisRunId
      );
      const { statements, duplicateCount, failures } = buildStatementsFromReport(
        reportBundle,
        reportBundlePath,
        provenance,
        createdAt,
        opinionArtifacts
      );
      const bank: StatementBank = {
        statementBankId: `bank-${sha256Hex(`${statementRunId}:${reportBundleSha256}`).slice(0, 16)}`,
        statementRunId,
        createdAt,
        projectName: config.project.name,
        analysisRunId: reportBundle.analysisRunId,
        reportId: reportBundle.reportId,
        sourceReportPath: reportBundlePath,
        generationProvenance: provenance,
        statements,
        counts: {
          total: statements.length,
          byModerationStatus: countStatementsByStatus(statements),
          duplicates: duplicateCount
        }
      };
      const manifest: StatementRunManifest = {
        statementRunId,
        createdAt,
        updatedAt: createdAt,
        status: failures.length === 0 ? "completed" : "completed-with-failures",
        fingerprint: {
          sourceReportSha256: reportBundleSha256,
          promptSha256,
          analysisRunId: reportBundle.analysisRunId,
          generator: STATEMENT_GENERATOR_ID
        },
        input: {
          analysisRunId: reportBundle.analysisRunId,
          reportBundlePath,
          reportBundleSha256
        },
        output: {
          statementBankPath: statementRunPaths.statementBankPath,
          statementsDir: statementRunPaths.statementsDir,
          statementsGenerated: statements.length + duplicateCount,
          statementsWritten: statements.length,
          duplicateStatements: duplicateCount,
          failedStatements: failures.length
        },
        failures
      };

      await mkdir(statementRunPaths.statementsDir, { recursive: true });
      await writeJsonArtifact(statementRunPaths.statementBankPath, bank);
      await writeJsonArtifact(statementRunPaths.manifestPath, manifest);

      for (const statement of statements) {
        await writeJsonArtifact(
          path.join(statementRunPaths.statementsDir, `${statement.statementId}.json`),
          statement
        );
      }

      await writeCurrentRunId(projectPaths.statementsCurrentRunPath, statementRunId);

      process.stdout.write(
        [
          `Generated statement bank for ${projectRoot}`,
          "",
          `Analysis run: ${reportBundle.analysisRunId}`,
          `Statement run: ${statementRunId}`,
          `Statements written: ${statements.length}`,
          `Duplicates flagged: ${duplicateCount}`,
          `Bank: ${toProjectRelativePath(projectRoot, statementRunPaths.statementBankPath)}`
        ].join("\n") + "\n"
      );
    }
  });
}

export async function runStatementQa(options: StatementQaCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "statements qa",
    details: {
      run: options.run ?? "(current)"
    },
    action: async () => {
      const loaded = await loadStatementBankWithReviews(projectRoot, options.run);
      const qaRunId = createTimestampRunId("qa");
      const qaRootDir = path.join(loaded.statementRunPaths.qaDir, qaRunId);
      const qaStatementsDir = path.join(qaRootDir, "statements");
      const createdAt = new Date().toISOString();
      const results = loaded.statements.map((statement) => scoreStatementQa(statement, loaded.statements));
      const scorecard: StatementQaScorecard = {
        qaRunId,
        statementRunId: loaded.statementRunId,
        createdAt,
        statementCount: loaded.statements.length,
        totals: {
          pass: results.filter((result) => result.overallStatus === "pass").length,
          warning: results.filter((result) => result.overallStatus === "warning").length,
          fail: results.filter((result) => result.overallStatus === "fail").length
        },
        results
      };
      const manifest = {
        qaRunId,
        statementRunId: loaded.statementRunId,
        createdAt,
        updatedAt: createdAt,
        status: scorecard.totals.fail === 0 ? "completed" : "completed-with-failures",
        input: {
          statementBankPath: loaded.statementRunPaths.statementBankPath,
          statementCount: loaded.statements.length
        },
        output: {
          qaDir: qaRootDir,
          scorecardPath: path.join(qaRootDir, "scorecard.json"),
          statementResultCount: results.length
        }
      };

      await mkdir(qaStatementsDir, { recursive: true });
      await writeJsonArtifact(path.join(qaRootDir, "manifest.json"), manifest);
      await writeJsonArtifact(path.join(qaRootDir, "scorecard.json"), scorecard);

      for (const result of results) {
        await writeJsonArtifact(path.join(qaStatementsDir, `${result.statementId}.json`), result);
      }

      await writeCurrentRunId(path.join(loaded.statementRunPaths.qaDir, "current-run.txt"), qaRunId);

      process.stdout.write(
        [
          `Statement QA completed for ${projectRoot}`,
          "",
          `Statement run: ${loaded.statementRunId}`,
          `QA run: ${qaRunId}`,
          `Pass: ${scorecard.totals.pass}`,
          `Warning: ${scorecard.totals.warning}`,
          `Fail: ${scorecard.totals.fail}`,
          `Scorecard: ${toProjectRelativePath(projectRoot, path.join(qaRootDir, "scorecard.json"))}`
        ].join("\n") + "\n"
      );
    }
  });
}

export async function reviewStatements(options: StatementReviewCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "statements review",
    details: {
      run: options.run ?? "(current)",
      statement: options.statement ?? null,
      status: options.status ?? null,
      exportAccepted: options.exportAccepted === true
    },
    action: async () => {
      const loaded = await loadStatementBankWithReviews(projectRoot, options.run);
      const updates: Array<{ statementId: string; status: StatementModerationStatus }> = [];

      for (const statementId of options.accept ?? []) {
        updates.push({ statementId, status: "accepted" });
      }

      for (const statementId of options.reject ?? []) {
        updates.push({ statementId, status: "rejected" });
      }

      if (options.status !== undefined || options.text !== undefined) {
        if (options.statement === undefined) {
          throw new Error("--statement is required when --status or --text is provided.");
        }

        if (options.status !== undefined && !isStatementModerationStatus(options.status)) {
          throw new Error(`Unsupported statement status '${options.status}'.`);
        }

        updates.push({
          statementId: options.statement,
          status: options.status === undefined ? "pending" : options.status
        });
      }

      const changedStatementIds = new Set<string>();

      for (const update of updates) {
        const statement = loaded.statements.find((item) => item.statementId === update.statementId);

        if (statement === undefined) {
          throw new Error(`Statement '${update.statementId}' was not found.`);
        }

        await writeStatementReviewArtifact(loaded.statementRunPaths.reviewDir, {
          statementId: update.statementId,
          updatedAt: new Date().toISOString(),
          actor: {
            type: "human",
            name: "local-admin"
          },
          moderationStatus: update.status,
          visibilityStatus: update.status === "accepted" ? "public" : statement.visibilityStatus,
          ...(options.text === undefined || update.statementId !== options.statement
            ? {}
            : { statementText: options.text }),
          ...(options.note === undefined ? {} : { note: options.note })
        });
        changedStatementIds.add(update.statementId);
      }

      const reloaded =
        changedStatementIds.size === 0 ? loaded : await loadStatementBankWithReviews(projectRoot, loaded.statementRunId);
      const shouldExport = options.exportAccepted === true || changedStatementIds.size > 0;
      const acceptedExportPath =
        shouldExport === true ? await exportAcceptedStatements(projectRoot, reloaded) : null;
      const summary = summarizeStatementStatuses(reloaded.statements);

      process.stdout.write(
        [
          `Statement review state for ${projectRoot}`,
          "",
          `Statement run: ${reloaded.statementRunId}`,
          `Changed statements: ${changedStatementIds.size}`,
          `Pending: ${summary.pending}`,
          `Accepted: ${summary.accepted}`,
          `Rejected: ${summary.rejected}`,
          `Hidden: ${summary.hidden_from_public}`,
          `Excluded: ${summary.excluded_from_analysis}`,
          ...(acceptedExportPath === null
            ? []
            : [`Accepted export: ${toProjectRelativePath(projectRoot, acceptedExportPath)}`])
        ].join("\n") + "\n"
      );
    }
  });
}

export async function loadStatementBankWithReviews(
  projectRoot: string,
  requestedStatementRunId?: string
): Promise<LoadedStatementBank> {
  const projectPaths = resolveProjectPaths(projectRoot);
  const statementRunId =
    requestedStatementRunId ??
    (await readCurrentRunId(projectPaths.statementsCurrentRunPath)) ??
    (await findLatestStatementRunId(projectPaths.statementsDir));

  if (statementRunId === null) {
    throw new Error("No statement bank was found. Run broadly statements generate --from-report first.");
  }

  const statementRunPaths = resolveStatementRunPaths(projectRoot, statementRunId);
  const bank = await readJsonArtifact<StatementBank>(statementRunPaths.statementBankPath);

  if (bank === null) {
    throw new Error(`Statement bank '${statementRunId}' was not found.`);
  }

  const reviewByStatementId = await loadStatementReviews(statementRunPaths.reviewDir);
  const statements = bank.statements.map((statement) =>
    applyReviewToStatement(statement, reviewByStatementId.get(statement.statementId))
  );

  return {
    bank,
    statementRunId,
    statementRunPaths,
    reviewByStatementId,
    statements
  };
}

export async function findLatestStatementRunId(statementsDir: string): Promise<string | null> {
  const entries = await readdir(statementsDir, { withFileTypes: true }).catch(() => []);
  const runs: Array<{ runId: string; createdAt: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifest = await readJsonArtifact<{ createdAt?: string }>(
      path.join(statementsDir, entry.name, "manifest.json")
    );

    if (manifest?.createdAt !== undefined) {
      runs.push({ runId: entry.name, createdAt: manifest.createdAt });
    }
  }

  runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return runs[0]?.runId ?? null;
}

export async function exportAcceptedStatements(
  projectRoot: string,
  loaded: LoadedStatementBank
): Promise<string> {
  const acceptedStatements = loaded.statements.filter(
    (statement) =>
      statement.moderationStatus === "accepted" &&
      statement.duplicateOfStatementId === undefined &&
      statement.visibilityStatus !== "private"
  );
  const exportBank: StatementBank = {
    ...loaded.bank,
    statements: acceptedStatements,
    counts: {
      total: acceptedStatements.length,
      byModerationStatus: countStatementsByStatus(acceptedStatements),
      duplicates: 0
    }
  };

  await writeJsonArtifact(loaded.statementRunPaths.acceptedStatementsPath, exportBank);
  return loaded.statementRunPaths.acceptedStatementsPath;
}

export function applyReviewToStatement(
  statement: Statement,
  review: StatementReviewArtifact | undefined
): Statement {
  if (review === undefined) {
    return statement;
  }

  return {
    ...statement,
    statementText: review.statementText ?? statement.statementText,
    moderationStatus: review.moderationStatus,
    visibilityStatus: review.visibilityStatus ?? statement.visibilityStatus
  };
}

function buildStatementsFromReport(
  reportBundle: ReportBundle,
  reportBundlePath: string,
  provenance: StatementGenerationProvenance,
  createdAt: string,
  opinionArtifacts: Map<string, LoadedOpinionArtifact>
): {
  statements: Statement[];
  duplicateCount: number;
  failures: Array<{ source: string; message: string }>;
} {
  const candidateStatements: Statement[] = [];
  const failures: Array<{ source: string; message: string }> = [];

  for (const view of reportBundle.views) {
    const themesByClusterId = groupThemesByClusterId(view.themes ?? []);

    for (const cluster of view.clusters) {
      if (cluster.evidenceQuotes.length === 0) {
        failures.push({
          source: `view:${view.viewId}:cluster:${cluster.clusterId}`,
          message: "Cluster had no evidence quotes to turn into votable statements."
        });
        continue;
      }

      for (const quote of cluster.evidenceQuotes) {
        const opinion = opinionArtifacts.get(quote.sourceId);
        const statementText = buildVotableStatementText(opinion?.opinionText ?? quote.excerpt);

        if (statementText === null) {
          failures.push({
            source: `view:${view.viewId}:cluster:${cluster.clusterId}:quote:${quote.quoteId}`,
            message: "Evidence quote did not contain enough claim text to form a statement."
          });
          continue;
        }

        candidateStatements.push(
          createStatement({
            reportBundle,
            reportBundlePath,
            view,
            themes: themesByClusterId.get(cluster.clusterId) ?? [],
            cluster,
            quote,
            statementText,
            createdAt,
            provenance,
            ...(opinion === undefined ? {} : { opinion }),
            rationale:
              opinion === undefined
                ? "Generated from a report evidence quote because no extracted opinion artifact was available."
                : "Generated from an extracted opinion referenced by a highlighted report cluster."
          })
        );
      }
    }
  }

  const statements: Statement[] = [];
  let duplicateCount = 0;

  for (const statement of candidateStatements) {
    const duplicateOf = findDuplicateStatement(statement, statements);

    if (duplicateOf !== null) {
      duplicateCount += 1;
      statements.push({
        ...statement,
        duplicateOfStatementId: duplicateOf.statementId
      });
      continue;
    }

    statements.push(statement);
  }

  return {
    statements,
    duplicateCount,
    failures
  };
}

function createStatement(options: {
  reportBundle: ReportBundle;
  reportBundlePath: string;
  view: AnalysisViewReport;
  themes?: ThemeSummary[];
  cluster?: AnalysisViewReport["clusters"][number];
  quote?: AnalysisViewReport["clusters"][number]["evidenceQuotes"][number];
  opinion?: LoadedOpinionArtifact;
  statementText: string;
  createdAt: string;
  provenance: StatementGenerationProvenance;
  rationale: string;
}): Statement {
  const sourceClusterIds =
    options.cluster === undefined ? [] : [options.cluster.clusterId];
  const sourceThemeIds = options.themes?.map((theme) => theme.themeId) ?? [];
  const evidenceRefs = buildEvidenceRefs({
    reportBundle: options.reportBundle,
    reportBundlePath: options.reportBundlePath,
    view: options.view,
    themes: options.themes ?? [],
    ...(options.cluster === undefined ? {} : { cluster: options.cluster }),
    ...(options.quote === undefined ? {} : { quote: options.quote }),
    ...(options.opinion === undefined ? {} : { opinion: options.opinion })
  });
  const sourceOpinionIds = [
    ...new Set(
      evidenceRefs
        .map((ref) => ref.opinionId)
        .filter((opinionId): opinionId is string => opinionId !== undefined)
    )
  ];
  const statementId = `stmt-${sha256Hex(
    JSON.stringify({
      text: normalizeStatementText(options.statementText),
      viewId: options.view.viewId,
      sourceClusterIds,
      sourceThemeIds,
      analysisRunId: options.reportBundle.analysisRunId
    })
  ).slice(0, 16)}`;

  return {
    statementId,
    statementText: options.statementText,
    statementKind: options.opinion === undefined ? "synthesized" : "extracted",
    moderationStatus: "pending",
    visibilityStatus: "admin_only",
    sourceOpinionIds,
    sourceClusterIds,
    sourceThemeIds,
    evidenceRefs,
    generationRationale: options.rationale,
    createdAt: options.createdAt,
    provenance: options.provenance
  };
}

function buildEvidenceRefs(options: {
  reportBundle: ReportBundle;
  reportBundlePath: string;
  view: AnalysisViewReport;
  themes?: ThemeSummary[];
  cluster?: AnalysisViewReport["clusters"][number];
  quote?: AnalysisViewReport["clusters"][number]["evidenceQuotes"][number];
  opinion?: LoadedOpinionArtifact;
}): StatementEvidenceRef[] {
  const refs: StatementEvidenceRef[] = [
    {
      refId: `report:${options.reportBundle.reportId}`,
      refType: "report",
      analysisRunId: options.reportBundle.analysisRunId,
      reportId: options.reportBundle.reportId,
      artifactPath: options.reportBundlePath
    },
    {
      refId: `view:${options.view.viewId}`,
      refType: "view",
      analysisRunId: options.reportBundle.analysisRunId,
      reportId: options.reportBundle.reportId,
      viewId: options.view.viewId,
      artifactPath: options.reportBundlePath
    }
  ];

  for (const theme of options.themes ?? []) {
    refs.push({
      refId: `theme:${options.view.viewId}:${theme.themeId}`,
      refType: "theme",
      analysisRunId: options.reportBundle.analysisRunId,
      reportId: options.reportBundle.reportId,
      viewId: options.view.viewId,
      themeId: theme.themeId,
      artifactPath: options.reportBundlePath,
      excerpt: theme.summary
    });
  }

  if (options.cluster !== undefined) {
    refs.push({
      refId: `cluster:${options.view.viewId}:${options.cluster.clusterId}`,
      refType: "cluster",
      analysisRunId: options.reportBundle.analysisRunId,
      reportId: options.reportBundle.reportId,
      viewId: options.view.viewId,
      clusterId: options.cluster.clusterId,
      artifactPath: options.reportBundlePath,
      excerpt: options.cluster.summary
    });
  }

  if (options.quote !== undefined) {
    refs.push({
      refId: `opinion:${options.quote.sourceId}:${options.quote.quoteId}`,
      refType: "opinion",
      analysisRunId: options.reportBundle.analysisRunId,
      reportId: options.reportBundle.reportId,
      viewId: options.view.viewId,
      opinionId: options.quote.sourceId,
      sourceId: options.opinion?.sourceId ?? options.quote.sourceId,
      quoteId: options.quote.quoteId,
      artifactPath: options.opinion?.artifactPath ?? options.reportBundlePath,
      excerpt: options.opinion?.excerpt ?? options.quote.excerpt,
      ...(options.cluster === undefined ? {} : { clusterId: options.cluster.clusterId })
    });
  }

  return refs;
}

interface LoadedOpinionArtifact {
  opinionId: string;
  sourceId?: string;
  opinionText?: string;
  excerpt?: string;
  artifactPath: string;
}

interface AnalysisRunManifestWithOpinionInput {
  input?: {
    opinionRunId?: string;
    opinionsDir?: string;
    groups?: Array<{
      opinionRunId?: string;
      opinionsDir?: string;
    }>;
  };
}

async function loadOpinionArtifactsForAnalysisRun(
  projectPaths: ProjectPaths,
  analysisRunId: string
): Promise<Map<string, LoadedOpinionArtifact>> {
  const manifest = await readJsonArtifact<AnalysisRunManifestWithOpinionInput>(
    path.join(projectPaths.runsDir, analysisRunId, "manifest.json")
  );
  const opinionDirs = new Set<string>();

  for (const opinionDir of [
    manifest?.input?.opinionsDir,
    ...(manifest?.input?.groups ?? []).map((group) => group.opinionsDir)
  ]) {
    if (opinionDir !== undefined) {
      opinionDirs.add(resolveOpinionInputPath(projectPaths.rootDir, opinionDir));
    }
  }

  if (manifest?.input?.opinionRunId !== undefined && opinionDirs.size === 0) {
    opinionDirs.add(
      path.join(projectPaths.dataDir, "opinions", manifest.input.opinionRunId, "opinions")
    );
  }

  const opinions = new Map<string, LoadedOpinionArtifact>();

  for (const opinionDir of opinionDirs) {
    const entries = await readdir(opinionDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const artifactPath = path.join(opinionDir, entry.name);
      const opinion = await readJsonArtifact<Omit<LoadedOpinionArtifact, "artifactPath">>(
        artifactPath
      );

      if (opinion?.opinionId !== undefined) {
        opinions.set(opinion.opinionId, {
          ...opinion,
          artifactPath
        });
      }
    }
  }

  return opinions;
}

function resolveOpinionInputPath(projectRoot: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(projectRoot, inputPath);
}

function groupThemesByClusterId(themes: ThemeSummary[]): Map<string, ThemeSummary[]> {
  const themesByClusterId = new Map<string, ThemeSummary[]>();

  for (const theme of themes) {
    for (const clusterId of theme.clusterIds) {
      const existing = themesByClusterId.get(clusterId) ?? [];
      existing.push(theme);
      themesByClusterId.set(clusterId, existing);
    }
  }

  return themesByClusterId;
}

function buildVotableStatementText(value: string | undefined): string | null {
  const baseText = firstSentence(cleanStatementText(value ?? ""));

  if (baseText === null || countWords(baseText) < 3) {
    return null;
  }

  return ensureSentence(baseText);
}

function firstSentence(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const match = trimmed.match(/^(.+?[.!?])(\s|$)/);
  const sentence = match?.[1] ?? trimmed;

  return sentence.length === 0 ? null : sentence;
}

function cleanStatementText(value: string): string {
  return value
    .replace(/\u0092/g, "'")
    .replace(/\u0093|\u0094/g, '"')
    .replace(/\u0096|\u0097/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureSentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function findDuplicateStatement(statement: Statement, priorStatements: Statement[]): Statement | null {
  const normalized = normalizeStatementText(statement.statementText);

  for (const priorStatement of priorStatements) {
    const priorNormalized = normalizeStatementText(priorStatement.statementText);

    if (
      normalized === priorNormalized ||
      tokenSimilarity(normalized, priorNormalized) >= 0.92
    ) {
      return priorStatement;
    }
  }

  return null;
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;

  return intersection / union;
}

function normalizeStatementText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countStatementsByStatus(
  statements: Statement[]
): Record<StatementModerationStatus, number> {
  const counts: Record<StatementModerationStatus, number> = {
    pending: 0,
    accepted: 0,
    rejected: 0,
    hidden_from_public: 0,
    excluded_from_analysis: 0
  };

  for (const statement of statements) {
    counts[statement.moderationStatus] += 1;
  }

  return counts;
}

function scoreStatementQa(statement: Statement, allStatements: Statement[]): StatementQaResult {
  const checks: StatementQaCheck[] = [
    scoreEvidenceSupport(statement),
    scoreNeutralWording(statement),
    scoreSingleClaimClarity(statement),
    scoreDuplicateRisk(statement, allStatements),
    scoreScopeFit(statement),
    scoreComprehensibility(statement),
    scoreVoteUsefulness(statement)
  ];
  const overallScore = Math.round(
    checks.reduce((total, check) => total + check.score, 0) / checks.length
  );
  const overallStatus =
    checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "warning")
        ? "warning"
        : "pass";

  return {
    statementId: statement.statementId,
    statementText: statement.statementText,
    checks,
    overallStatus,
    overallScore
  };
}

function scoreEvidenceSupport(statement: Statement): StatementQaCheck {
  const quoteRefs = statement.evidenceRefs.filter(
    (ref) => ref.refType === "opinion" && (ref.excerpt?.trim().length ?? 0) > 0
  );

  if (quoteRefs.length > 0) {
    return qaCheck("evidence-support", "pass", 100, "Statement has representative opinion evidence.");
  }

  if (statement.evidenceRefs.length > 0) {
    return qaCheck("evidence-support", "warning", 65, "Statement links to report evidence but no source quote.");
  }

  return qaCheck("evidence-support", "fail", 0, "Statement has no evidence references.");
}

function scoreNeutralWording(statement: Statement): StatementQaCheck {
  const loadedTerms = ["obviously", "clearly", "must", "never", "always", "everyone", "no one"];
  const normalized = normalizeStatementText(statement.statementText);
  const matchedTerm = loadedTerms.find((term) => normalized.includes(term));

  if (matchedTerm === undefined) {
    return qaCheck("neutral-wording", "pass", 100, "No obvious loaded wording was detected.");
  }

  return qaCheck("neutral-wording", "warning", 55, `Potentially loaded wording: ${matchedTerm}.`);
}

function scoreSingleClaimClarity(statement: Statement): StatementQaCheck {
  const wordCount = countWords(statement.statementText);
  const conjunctionCount = (statement.statementText.match(/\b(and|but|while|although)\b/gi) ?? []).length;

  if (wordCount <= 28 && conjunctionCount <= 1) {
    return qaCheck("single-claim-clarity", "pass", 100, "Statement is concise enough for a single vote.");
  }

  if (wordCount <= 42 && conjunctionCount <= 2) {
    return qaCheck("single-claim-clarity", "warning", 65, "Statement may combine more than one claim.");
  }

  return qaCheck("single-claim-clarity", "fail", 25, "Statement is too broad or compound for one vote.");
}

function scoreDuplicateRisk(statement: Statement, allStatements: Statement[]): StatementQaCheck {
  if (statement.duplicateOfStatementId !== undefined) {
    return qaCheck(
      "duplicate-risk",
      "fail",
      20,
      `Statement was flagged as a duplicate of ${statement.duplicateOfStatementId}.`
    );
  }

  const normalized = normalizeStatementText(statement.statementText);
  const duplicates = allStatements.filter(
    (candidate) =>
      candidate.statementId !== statement.statementId &&
      tokenSimilarity(normalized, normalizeStatementText(candidate.statementText)) >= 0.92
  );

  if (duplicates.length === 0) {
    return qaCheck("duplicate-risk", "pass", 100, "No near duplicate was detected.");
  }

  return qaCheck("duplicate-risk", "warning", 60, "A near duplicate may exist in the bank.");
}

function scoreScopeFit(statement: Statement): StatementQaCheck {
  const wordCount = countWords(statement.statementText);

  if (wordCount >= 6 && wordCount <= 35) {
    return qaCheck("scope-fit", "pass", 100, "Statement length is suitable for voting.");
  }

  if (wordCount >= 4 && wordCount <= 45) {
    return qaCheck("scope-fit", "warning", 65, "Statement length is marginal for voting.");
  }

  return qaCheck("scope-fit", "fail", 30, "Statement is too short or too long for this sandbox.");
}

function scoreComprehensibility(statement: Statement): StatementQaCheck {
  const words = statement.statementText.match(/[A-Za-z0-9]+/g) ?? [];
  const averageWordLength =
    words.length === 0
      ? 0
      : words.reduce((total, word) => total + word.length, 0) / words.length;

  if (averageWordLength <= 7.5) {
    return qaCheck(
      "participant-comprehensibility",
      "pass",
      100,
      "Statement uses mostly short words."
    );
  }

  if (averageWordLength <= 9) {
    return qaCheck(
      "participant-comprehensibility",
      "warning",
      65,
      "Statement may need simpler wording."
    );
  }

  return qaCheck(
    "participant-comprehensibility",
    "fail",
    35,
    "Statement wording is likely too dense for quick voting."
  );
}

function scoreVoteUsefulness(statement: Statement): StatementQaCheck {
  const text = statement.statementText.trim();

  if (text.endsWith("?")) {
    return qaCheck("vote-usefulness", "fail", 20, "Questions are not suitable agree/disagree statements.");
  }

  if (/\b(and\/or|various|several things)\b/i.test(text)) {
    return qaCheck("vote-usefulness", "warning", 60, "Statement may be too vague for agree/disagree voting.");
  }

  return qaCheck("vote-usefulness", "pass", 100, "Statement can be voted on with agree/disagree/pass.");
}

function qaCheck(
  dimension: StatementQaCheck["dimension"],
  status: StatementQaCheck["status"],
  score: number,
  rationale: string
): StatementQaCheck {
  return {
    dimension,
    status,
    score,
    rationale
  };
}

function countWords(value: string): number {
  return value.match(/[A-Za-z0-9]+/g)?.length ?? 0;
}

export async function writeStatementReviewArtifact(
  reviewDir: string,
  review: StatementReviewArtifact
): Promise<void> {
  await writeJsonArtifact(path.join(reviewDir, `${review.statementId}.json`), review);
}

async function loadStatementReviews(
  reviewDir: string
): Promise<Map<string, StatementReviewArtifact>> {
  const reviewPaths = await listJsonArtifactPaths(reviewDir);
  const reviews = new Map<string, StatementReviewArtifact>();

  for (const reviewPath of reviewPaths) {
    const review = await readJsonArtifact<StatementReviewArtifact>(reviewPath);

    if (review?.statementId !== undefined) {
      reviews.set(review.statementId, review);
    }
  }

  return reviews;
}

async function findCompatibleStatementRun(
  statementsDir: string,
  fingerprint: {
    analysisRunId: string;
    sourceReportSha256: string;
    promptSha256: string;
  }
): Promise<{
  statementRunId: string;
  statementBankPath: string;
  statementsWritten: number;
} | null> {
  const entries = await readdir(statementsDir, { withFileTypes: true }).catch(() => []);
  const matches: Array<{
    statementRunId: string;
    createdAt: string;
    statementBankPath: string;
    statementsWritten: number;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(statementsDir, entry.name, "manifest.json");
    const manifest = await readJsonArtifact<StatementRunManifest>(manifestPath);
    const statementBankPath = path.join(statementsDir, entry.name, "statement-bank.json");

    if (
      manifest?.fingerprint.analysisRunId === fingerprint.analysisRunId &&
      manifest.fingerprint.sourceReportSha256 === fingerprint.sourceReportSha256 &&
      manifest.fingerprint.promptSha256 === fingerprint.promptSha256 &&
      (await artifactExists(statementBankPath))
    ) {
      matches.push({
        statementRunId: entry.name,
        createdAt: manifest.createdAt,
        statementBankPath,
        statementsWritten: manifest.output.statementsWritten
      });
    }
  }

  matches.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return matches[0] ?? null;
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

function isStatementModerationStatus(value: string): value is StatementModerationStatus {
  return (MODERATION_STATUS_VALUES as readonly string[]).includes(value);
}

export function isStatementVisibilityStatus(value: string): value is StatementVisibilityStatus {
  return (VISIBILITY_STATUS_VALUES as readonly string[]).includes(value);
}

function summarizeStatementStatuses(
  statements: Statement[]
): Record<StatementModerationStatus, number> {
  return countStatementsByStatus(statements);
}
