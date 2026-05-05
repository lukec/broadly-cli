import { watch, type FSWatcher } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig } from "@broadly/config";
import {
  REVIEW_STATUS_VALUES,
  resolveProjectPaths,
  type CommentReviewArtifact,
  type CommentReviewSuggestionArtifact,
  type OpinionReviewArtifact,
  type OpinionReviewSuggestionArtifact,
  type ProjectPaths,
  type ReviewConfig,
  type ReviewStatus
} from "@broadly/core";
import {
  getNormalizedCommentDerivedFields,
  getNormalizedCommentPrimaryText,
  type NormalizedCommentRecord
} from "@broadly/ingest";
import type { ReportBundle } from "@broadly/report-model";
import type {
  Statement,
  StatementModerationStatus,
  StatementReviewArtifact,
  StatementVisibilityStatus,
  VoteRoundSummary
} from "@broadly/report-model";

import {
  buildPipelineSteps,
  describeOpinionRunStatus,
  loadProjectDashboard,
  resolveCommandProjectRoot,
  resolveRegisteredModelLabel,
  stageStatusLabel,
  type PipelineStep,
  type ProjectDashboardData,
  type StepStatus
} from "./projectDashboard.js";
import {
  ensureProjectReviewState,
  loadCommentReview,
  loadCommentReviewSuggestion,
  loadOpinionReview,
  loadOpinionReviewSuggestion,
  resolveEffectiveOpinionReviewStatus,
  upsertCommentReview,
  upsertCommentReviewSuggestion,
  upsertOpinionReview,
  upsertOpinionReviewSuggestion,
  writeReviewConfig
} from "../reviewState.js";
import {
  exportAcceptedStatements,
  findLatestStatementRunId,
  isStatementVisibilityStatus,
  loadStatementBankWithReviews,
  writeStatementReviewArtifact,
  type LoadedStatementBank
} from "./statements.js";
import { readCurrentRunId } from "../projectArtifacts.js";
import { loadVoteSummaryForReport } from "./vote.js";

export interface WebCommandOptions {
  project?: string;
  port?: number;
  watch?: boolean;
}

interface AnalysisReductionArtifact {
  createdAt?: string;
  method?: string;
  dimensions?: number;
  status?: string;
  message?: string;
  pointCount?: number;
  points?: Array<{ opinionId?: string; x?: number; y?: number }>;
}

interface AnalysisClusterArtifact {
  createdAt?: string;
  method?: string;
  requestedClusterCount?: number;
  effectiveClusterCount?: number;
  status?: string;
  message?: string;
  sourceReductionPath?: string;
  labeling?: {
    method?: string;
    stopReason?: string | null;
    error?: string;
  };
  members?: Array<{ opinionId?: string; clusterId?: number; x?: number; y?: number }>;
  clusters?: Array<{
    clusterId?: number;
    size?: number;
    centroid?: [number, number];
    label?: string;
    topTerms?: string[];
    summary?: string;
    representativeOpinions?: Array<{
      opinionId?: string;
      opinionText?: string;
      excerpt?: string;
    }>;
  }>;
}

interface AnalysisPerspectiveArtifact {
  createdAt?: string;
  viewName?: string;
  viewTitle?: string;
  mode?: string;
  status?: string;
  synthesis?: {
    method?: string;
    stopReason?: string | null;
    error?: string;
  };
  title?: string;
  summary?: string;
  rationale?: string;
  chosenClusterArtifactPath?: string;
  chosenReductionMethod?: string;
  chosenClusterCount?: number;
  highlights?: Array<{
    clusterId?: number;
    label?: string;
    size?: number;
    summary?: string;
    representativeOpinions?: Array<{
      opinionId?: string;
      opinionText?: string;
      excerpt?: string;
    }>;
  }>;
}

interface AnalysisReducerEvaluationArtifact {
  createdAt?: string;
  runId?: string;
  method?: string;
  parameters?: {
    neighborK?: number;
  };
  corpus?: {
    embeddingCount?: number;
    reductionCount?: number;
    readyReductionCount?: number;
    clusterArtifactCount?: number;
    comparableOpinionCount?: number;
  };
  reductions?: Array<{
    method?: string;
    status?: string;
    pointCount?: number;
    comparableOpinionCount?: number;
    neighborRecallAtK?: {
      k?: number;
      mean?: number | null;
      median?: number | null;
    };
    projection?: {
      finiteCoordinateRate?: number;
      xRange?: number;
      yRange?: number;
      area?: number;
      duplicateCoordinateRate?: number;
      outlierRate?: number;
    };
  }>;
  clusters?: Array<{
    viewName?: string;
    method?: string;
    effectiveClusterCount?: number;
    comparableOpinionCount?: number;
    embeddingNeighborPurityAtK?: number | null;
    projectionNeighborPurityAtK?: number | null;
    embeddingSilhouette?: number | null;
    projectionSilhouette?: number | null;
    largestClusterShare?: number;
  }>;
  clusterAgreement?: Array<{
    leftViewName?: string;
    rightViewName?: string;
    comparableOpinionCount?: number;
    adjustedRandIndex?: number | null;
  }>;
  observations?: string[];
}

interface AnalysisClusteringSurfaceEvaluationArtifact {
  createdAt?: string;
  runId?: string;
  method?: string;
  parameters?: {
    neighborK?: number;
  };
  corpus?: {
    embeddingCount?: number;
    clusterArtifactCount?: number;
    embeddingSurfaceCount?: number;
    projectionSurfaceCount?: number;
    comparableOpinionCount?: number;
  };
  surfaces?: Array<{
    surfaceId?: string;
    surfaceKind?: string;
    label?: string;
    method?: string;
    status?: string;
    requestedClusterCount?: number;
    effectiveClusterCount?: number;
    comparableOpinionCount?: number;
    singletonClusterCount?: number;
    largestClusterShare?: number;
    embeddingNeighborPurityAtK?: number | null;
    embeddingSilhouette?: number | null;
  }>;
  comparisons?: Array<{
    leftSurfaceId?: string;
    rightSurfaceId?: string;
    leftLabel?: string;
    rightLabel?: string;
    comparableOpinionCount?: number;
    adjustedRandIndex?: number | null;
    largestMembershipShifts?: Array<{
      sourceClusterId?: number;
      sourceClusterSize?: number;
      fragmentationRate?: number;
      topDestinationClusters?: Array<{
        clusterId?: number;
        count?: number;
        share?: number;
      }>;
    }>;
  }>;
  observations?: string[];
}

interface LoadedAnalysisRun {
  manifest: {
    runId?: string;
    createdAt?: string;
    updatedAt?: string;
    status?: string;
    input?: {
      opinionRunId?: string;
      opinionsSelected?: number;
      groups?: Array<{
        opinionRunId?: string;
      }>;
      extractionModel?: { name?: string; provider?: string; region?: string; modelId?: string };
      embeddingModel?: { name?: string; provider?: string; region?: string; modelId?: string };
      analysisModel?: { name?: string; provider?: string; region?: string; modelId?: string };
      prompts?: {
        clusterLabeling?: { path?: string; sha256?: string };
        perspectiveSummary?: { path?: string; sha256?: string };
      };
      reductionMethods?: string[];
      clusterCounts?: number[];
      mergeStrategy?: string;
      synthesisModes?: string[];
    };
    output?: {
      embeddingsDir?: string;
      reductionsDir?: string;
      clustersDir?: string;
      perspectivesDir?: string;
      embeddingsReady?: number;
      embeddingsGenerated?: number;
      embeddingsReused?: number;
      failedOpinions?: number;
      reductionsReady?: number;
      reductionsUnavailable?: number;
      reductionsFailed?: number;
      clusterArtifactsWritten?: number;
      clusterArtifactsFailed?: number;
      perspectiveArtifactsWritten?: number;
    };
  };
  reductions: Array<{ path: string; artifact: AnalysisReductionArtifact }>;
  clusters: Array<{ path: string; artifact: AnalysisClusterArtifact }>;
  perspectives: Array<{ path: string; artifact: AnalysisPerspectiveArtifact }>;
  reducerEvaluation: AnalysisReducerEvaluationArtifact | null;
  clusteringSurfaceEvaluation: AnalysisClusteringSurfaceEvaluationArtifact | null;
}

interface LoadedOpinionArtifact {
  opinionId?: string;
  opinionText?: string;
  excerpt?: string;
  sourceId?: string;
  fullComment?: string;
  provenance?: {
    sourceRowNumber?: number;
    externalId?: string;
    normalizedRecordPath?: string;
    sourceImportPath?: string;
  };
}

interface ThemeClusterReference {
  clusterId: string;
  label: string;
}

interface LoadedClusterDetail {
  artifactPath: string;
  artifact: AnalysisClusterArtifact;
  cluster: {
    clusterId?: number;
    size?: number;
    label?: string;
    summary?: string;
    topTerms?: string[];
    representativeOpinions?: Array<{
      opinionId?: string;
      opinionText?: string;
      excerpt?: string;
    }>;
  };
  members: Array<{ opinionId: string; clusterId: number; x: number; y: number }>;
}

interface NormalizedRecordPreview {
  sourceId: string;
  contentSha256: string;
  contentText: string;
  primaryText: string;
  externalId: string | null;
  sourceRowNumber: number | null;
  normalizedRecordPath: string;
}

const INGEST_PREVIEW_PAGE_SIZE = 12;
const ADMIN_CONTENT_PAGE_SIZE = 40;

interface AdminCommentEntry {
  sourceId: string;
  recordPath: string;
  record: NormalizedCommentRecord;
  review: CommentReviewArtifact | null;
  suggestion: CommentReviewSuggestionArtifact | null;
  effectiveStatus: ReviewStatus;
  relatedOpinionIds: string[];
}

interface AdminOpinionEntry {
  opinionId: string;
  artifactPath: string;
  runId: string;
  artifact: LoadedOpinionArtifact;
  sourceRecord: NormalizedCommentRecord | null;
  commentReview: CommentReviewArtifact | null;
  opinionReview: OpinionReviewArtifact | null;
  suggestion: OpinionReviewSuggestionArtifact | null;
  effectiveStatus: ReviewStatus;
  effectiveStatusSource: "default" | "comment" | "opinion";
}

interface AdminCorpus {
  reviewConfig: ReviewConfig;
  comments: AdminCommentEntry[];
  opinions: AdminOpinionEntry[];
}

interface LiveReloadController {
  handleClient(response: ServerResponse): void;
  close(): void;
}

export async function serveProjectWeb(options: WebCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const projectPaths = resolveProjectPaths(projectRoot);
  const config = parseProjectConfig(await readFile(projectPaths.configPath, "utf8"));
  const port = options.port ?? 4310;
  const liveReload = options.watch === true ? createLiveReloadController(projectRoot) : null;

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      const adminDetailMatch = requestUrl.pathname.match(/^\/admin\/(comments|opinions)\/([^/]+)$/);
      const adminReviewPostMatch = requestUrl.pathname.match(
        /^\/admin\/(comments|opinions)\/([^/]+)\/review$/
      );
      const adminSuggestionPostMatch = requestUrl.pathname.match(
        /^\/admin\/(comments|opinions)\/([^/]+)\/suggestion$/
      );
      const statementReviewPostMatch = requestUrl.pathname.match(
        /^\/statements\/([^/]+)\/([^/]+)\/review$/
      );

      if (requestUrl.pathname === "/__broadly_live_reload") {
        if (liveReload === null) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Live reload is not enabled.\n");
          return;
        }

        liveReload.handleClient(response);
        return;
      }

      if (request.method === "POST" && adminReviewPostMatch !== null) {
        const adminCorpus = await loadAdminCorpus(projectPaths);
        const form = await readRequestForm(request);
        const subjectKind = adminReviewPostMatch[1];
        const subjectId = decodeURIComponent(adminReviewPostMatch[2] ?? "");
        const status = parseSubmittedReviewStatus(form.get("status"));
        const reasonCode = normalizeSubmittedText(form.get("reasonCode"), "manual-update");
        const note = normalizeSubmittedText(form.get("note"));
        const nextLocation =
          normalizeSubmittedText(form.get("next")) ||
          `/admin/${subjectKind}/${encodeURIComponent(subjectId)}`;

        if (subjectKind === "comments") {
          const comment = adminCorpus.comments.find((entry) => entry.sourceId === subjectId);

          if (comment === undefined) {
            throw new Error(`Comment '${subjectId}' was not found.`);
          }

          await upsertCommentReview(projectPaths, {
            subjectId,
            status,
            reasonCode,
            note,
            actor: { type: "human", name: "local-admin" },
            normalizedRecordPath: comment.recordPath
          });
        } else {
          const opinion = adminCorpus.opinions.find((entry) => entry.opinionId === subjectId);

          if (opinion === undefined) {
            throw new Error(`Opinion '${subjectId}' was not found.`);
          }

          await upsertOpinionReview(projectPaths, {
            subjectId,
            status,
            reasonCode,
            note,
            actor: { type: "human", name: "local-admin" },
            opinionArtifactPath: opinion.artifactPath,
            sourceId: opinion.artifact.sourceId ?? opinion.sourceRecord?.sourceId ?? "",
            normalizedRecordPath:
              opinion.sourceRecord === null
                ? opinion.opinionReview?.provenance.normalizedRecordPath ??
                  opinion.commentReview?.provenance.normalizedRecordPath ??
                  ""
                : path.join(projectPaths.dataDir, "normalized", `${opinion.sourceRecord.sourceId}.json`)
          });
        }

        redirectResponse(response, nextLocation);
        return;
      }

      if (request.method === "POST" && adminSuggestionPostMatch !== null) {
        const adminCorpus = await loadAdminCorpus(projectPaths);
        const form = await readRequestForm(request);
        const subjectKind = adminSuggestionPostMatch[1];
        const subjectId = decodeURIComponent(adminSuggestionPostMatch[2] ?? "");
        const decision = parseSubmittedSuggestionDecision(form.get("decision"));
        const nextLocation =
          normalizeSubmittedText(form.get("next")) ||
          `/admin/${subjectKind}/${encodeURIComponent(subjectId)}`;

        if (subjectKind === "comments") {
          const comment = adminCorpus.comments.find((entry) => entry.sourceId === subjectId);

          if (comment === undefined) {
            throw new Error(`Comment '${subjectId}' was not found.`);
          }

          await applyCommentSuggestionDecision(projectPaths, comment, decision);
        } else {
          const opinion = adminCorpus.opinions.find((entry) => entry.opinionId === subjectId);

          if (opinion === undefined) {
            throw new Error(`Opinion '${subjectId}' was not found.`);
          }

          await applyOpinionSuggestionDecision(projectPaths, opinion, decision);
        }

        redirectResponse(response, nextLocation);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/admin/content/bulk-review") {
        const adminCorpus = await loadAdminCorpus(projectPaths);
        const form = await readRequestForm(request);
        const kind = form.get("kind") === "comments" ? "comments" : "opinions";
        const selectedIds = [...new Set(form.getAll("selected").map((value) => value.trim()).filter(Boolean))];
        const status = parseSubmittedReviewStatus(form.get("status"));
        const reasonCode = normalizeSubmittedText(form.get("reasonCode"), "manual-bulk-update");
        const note = normalizeSubmittedText(form.get("note"));
        const nextLocation = buildAdminContentHref(
          kind,
          parseSubmittedReviewStatusList(
            form.getAll("activeStatus"),
            `${kind} status filters`
          ),
          0,
          normalizeSubmittedText(form.get("q"))
        );

        if (selectedIds.length === 0) {
          redirectResponse(response, nextLocation);
          return;
        }

        if (kind === "comments") {
          for (const subjectId of selectedIds) {
            const comment = adminCorpus.comments.find((entry) => entry.sourceId === subjectId);

            if (comment === undefined) {
              continue;
            }

            await upsertCommentReview(projectPaths, {
              subjectId,
              status,
              reasonCode,
              note,
              actor: { type: "human", name: "local-admin" },
              normalizedRecordPath: comment.recordPath
            });
          }
        } else {
          for (const subjectId of selectedIds) {
            const opinion = adminCorpus.opinions.find((entry) => entry.opinionId === subjectId);

            if (opinion === undefined) {
              continue;
            }

            await upsertOpinionReview(projectPaths, {
              subjectId,
              status,
              reasonCode,
              note,
              actor: { type: "human", name: "local-admin" },
              opinionArtifactPath: opinion.artifactPath,
              sourceId: opinion.artifact.sourceId ?? opinion.sourceRecord?.sourceId ?? "",
              normalizedRecordPath:
                opinion.sourceRecord === null
                  ? opinion.opinionReview?.provenance.normalizedRecordPath ??
                    opinion.commentReview?.provenance.normalizedRecordPath ??
                    ""
                  : path.join(projectPaths.dataDir, "normalized", `${opinion.sourceRecord.sourceId}.json`)
            });
          }
        }

        redirectResponse(response, nextLocation);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/admin/config") {
        const currentReviewConfig = await ensureProjectReviewState(projectPaths);
        const form = await readRequestForm(request);
        const updatedReviewConfig: ReviewConfig = {
          analysis: {
            includeCommentStatuses: parseSubmittedReviewStatusList(
              form.getAll("analysisIncludeCommentStatuses"),
              "analysis comment statuses"
            ),
            includeOpinionStatuses: parseSubmittedReviewStatusList(
              form.getAll("analysisIncludeOpinionStatuses"),
              "analysis opinion statuses"
            )
          },
          report: {
            includeCommentStatuses: parseSubmittedReviewStatusList(
              form.getAll("reportIncludeCommentStatuses"),
              "report comment statuses"
            ),
            includeOpinionStatuses: parseSubmittedReviewStatusList(
              form.getAll("reportIncludeOpinionStatuses"),
              "report opinion statuses"
            )
          },
          web: {
            defaultVisibleCommentStatuses: parseSubmittedReviewStatusList(
              form.getAll("webDefaultVisibleCommentStatuses"),
              "web comment statuses"
            ),
            defaultVisibleOpinionStatuses: parseSubmittedReviewStatusList(
              form.getAll("webDefaultVisibleOpinionStatuses"),
              "web opinion statuses"
            )
          }
        };

        if (JSON.stringify(updatedReviewConfig) !== JSON.stringify(currentReviewConfig)) {
          await writeReviewConfig(projectPaths, updatedReviewConfig);
        }

        redirectResponse(response, "/admin/config");
        return;
      }

      if (request.method === "POST" && statementReviewPostMatch !== null) {
        const statementRunId = decodeURIComponent(statementReviewPostMatch[1] ?? "");
        const statementId = decodeURIComponent(statementReviewPostMatch[2] ?? "");
        const loaded = await loadStatementBankWithReviews(projectRoot, statementRunId);
        const statement = loaded.statements.find((item) => item.statementId === statementId);

        if (statement === undefined) {
          throw new Error(`Statement '${statementId}' was not found.`);
        }

        const form = await readRequestForm(request);
        const status = parseSubmittedStatementStatus(form.get("status"));
        const visibility = parseSubmittedStatementVisibility(form.get("visibility"));
        const statementText = normalizeSubmittedText(form.get("statementText"));
        const note = normalizeSubmittedText(form.get("note"));
        const review: StatementReviewArtifact = {
          statementId,
          updatedAt: new Date().toISOString(),
          actor: {
            type: "human",
            name: "local-admin"
          },
          moderationStatus: status,
          visibilityStatus: visibility,
          ...(statementText.length === 0 || statementText === statement.statementText
            ? {}
            : { statementText }),
          ...(note.length === 0 ? {} : { note })
        };

        await writeStatementReviewArtifact(loaded.statementRunPaths.reviewDir, review);
        await exportAcceptedStatements(
          projectRoot,
          await loadStatementBankWithReviews(projectRoot, statementRunId)
        );

        redirectResponse(response, `/statements/${encodeURIComponent(statementRunId)}`);
        return;
      }

      const dashboard = await loadProjectDashboard(projectRoot, config, options.watch === true);

      if (requestUrl.pathname === "/admin") {
        const adminCorpus = await loadAdminCorpus(projectPaths);

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderAdminOverviewPage(dashboard, adminCorpus));
        return;
      }

      if (requestUrl.pathname === "/admin/content") {
        const adminCorpus = await loadAdminCorpus(projectPaths);
        const kind = requestUrl.searchParams.get("kind") === "comments" ? "comments" : "opinions";
        const query = normalizeSubmittedText(requestUrl.searchParams.get("q"));
        const statusFilters = resolveReviewStatusFilters(
          requestUrl.searchParams.getAll("status"),
          kind === "comments"
            ? adminCorpus.reviewConfig.web.defaultVisibleCommentStatuses
            : adminCorpus.reviewConfig.web.defaultVisibleOpinionStatuses
        );
        const offset = parseOffset(requestUrl.searchParams.get("offset"));

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          renderAdminContentPage(dashboard, adminCorpus, {
            kind,
            statusFilters,
            query,
            offset,
            limit: ADMIN_CONTENT_PAGE_SIZE
          })
        );
        return;
      }

      if (requestUrl.pathname === "/admin/config") {
        const adminCorpus = await loadAdminCorpus(projectPaths);

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderAdminConfigPage(dashboard, adminCorpus));
        return;
      }

      if (adminDetailMatch !== null) {
        const adminCorpus = await loadAdminCorpus(projectPaths);
        const subjectKind = adminDetailMatch[1];
        const subjectId = decodeURIComponent(adminDetailMatch[2] ?? "");

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          subjectKind === "comments"
            ? renderAdminCommentDetailPage(dashboard, adminCorpus, subjectId)
            : renderAdminOpinionDetailPage(dashboard, adminCorpus, subjectId)
        );
        return;
      }

      if (requestUrl.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderHomePage(dashboard));
        return;
      }

      if (requestUrl.pathname === "/pipeline/ingest") {
        const offset = parseOffset(requestUrl.searchParams.get("offset"));
        const previews = await loadNormalizedRecordPreviews(
          path.join(projectPaths.dataDir, "normalized"),
          offset,
          INGEST_PREVIEW_PAGE_SIZE
        );

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderIngestPage(dashboard, previews, offset, INGEST_PREVIEW_PAGE_SIZE));
        return;
      }

      if (requestUrl.pathname === "/pipeline/opinions") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderOpinionsPage(dashboard));
        return;
      }

      if (requestUrl.pathname === "/pipeline/analysis") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderAnalysisPage(dashboard));
        return;
      }

      if (requestUrl.pathname === "/pipeline/report") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderReportPage(dashboard));
        return;
      }

      if (requestUrl.pathname === "/report") {
        const runId = await findLatestReportRun(projectPaths.reportsDir);

        if (runId === null) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("No report bundle found.\n");
          return;
        }

        const reportBundle = await loadReportBundle(projectPaths.reportsDir, runId);
        const analysisRun = await loadAnalysisRun(projectPaths.runsDir, reportBundle.analysisRunId);
        const voteSummary = await loadVoteSummaryForReport(
          projectPaths.reportsDir,
          reportBundle.analysisRunId
        );
        const opinionLookup = await loadOpinionArtifactLookup(
          path.join(projectPaths.dataDir, "opinions"),
          collectOpinionRunIds(analysisRun.manifest.input)
        );

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          renderPublishedReportPage(
            dashboard,
            runId,
            reportBundle,
            analysisRun,
            opinionLookup,
            voteSummary
          )
        );
        return;
      }

      if (requestUrl.pathname === "/statements") {
        const statementRunId =
          (await readCurrentRunId(projectPaths.statementsCurrentRunPath)) ??
          (await findLatestStatementRunId(projectPaths.statementsDir));

        if (statementRunId === null) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("No statement bank found.\n");
          return;
        }

        const loaded = await loadStatementBankWithReviews(projectRoot, statementRunId);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderStatementsPage(dashboard, loaded));
        return;
      }

      if (requestUrl.pathname.startsWith("/statements/")) {
        const statementRunId = decodeURIComponent(requestUrl.pathname.slice("/statements/".length));
        const loaded = await loadStatementBankWithReviews(projectRoot, statementRunId);

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderStatementsPage(dashboard, loaded));
        return;
      }

      if (requestUrl.pathname.startsWith("/reports/")) {
        const runId = decodeURIComponent(requestUrl.pathname.slice("/reports/".length));
        const reportBundle = await loadReportBundle(projectPaths.reportsDir, runId);
        const analysisRun = await loadAnalysisRun(projectPaths.runsDir, reportBundle.analysisRunId);
        const voteSummary = await loadVoteSummaryForReport(
          projectPaths.reportsDir,
          reportBundle.analysisRunId
        );
        const opinionLookup = await loadOpinionArtifactLookup(
          path.join(projectPaths.dataDir, "opinions"),
          collectOpinionRunIds(analysisRun.manifest.input)
        );

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          renderPublishedReportPage(
            dashboard,
            runId,
            reportBundle,
            analysisRun,
            opinionLookup,
            voteSummary
          )
        );
        return;
      }

      if (requestUrl.pathname.startsWith("/runs/")) {
        const runId = decodeURIComponent(requestUrl.pathname.slice("/runs/".length));
        const run = await loadOpinionRun(path.join(projectPaths.dataDir, "opinions"), runId);

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderRunPage(dashboard, runId, run));
        return;
      }

      if (requestUrl.pathname.startsWith("/analysis-runs/")) {
        const diagnosticsMatch = requestUrl.pathname.match(
          /^\/analysis-runs\/([^/]+)\/diagnostics$/
        );
        const clusterMatch = requestUrl.pathname.match(
          /^\/analysis-runs\/([^/]+)\/clusters\/([^/]+)\/([^/]+)$/
        );

        if (diagnosticsMatch !== null) {
          const runId = decodeURIComponent(diagnosticsMatch[1] ?? "");
          const run = await loadAnalysisRun(projectPaths.runsDir, runId);

          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.end(renderAnalysisDiagnosticsPage(dashboard, runId, run));
          return;
        }

        if (clusterMatch !== null) {
          const runId = decodeURIComponent(clusterMatch[1] ?? "");
          const clusterArtifactName = decodeURIComponent(clusterMatch[2] ?? "");
          const clusterId = decodeURIComponent(clusterMatch[3] ?? "");
          const run = await loadAnalysisRun(projectPaths.runsDir, runId);
          const clusterDetail = loadClusterDetail(run, clusterArtifactName, clusterId);
          const opinionLookup = await loadOpinionArtifactLookup(
            path.join(projectPaths.dataDir, "opinions"),
            collectOpinionRunIds(run.manifest.input)
          );

          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.end(
            renderClusterDetailPage(
              dashboard,
              runId,
              clusterArtifactName,
              clusterDetail,
              opinionLookup
            )
          );
          return;
        }

        const runId = decodeURIComponent(requestUrl.pathname.slice("/analysis-runs/".length));
        const run = await loadAnalysisRun(projectPaths.runsDir, runId);

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderAnalysisRunPage(dashboard, runId, run));
        return;
      }

      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`${message}\n`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  server.on("close", () => {
    liveReload?.close();
  });

  process.stdout.write(
    `Broadly web viewer running for ${projectRoot}\n${options.watch === true ? "Live reload enabled.\n" : ""}\nOpen: http://127.0.0.1:${port}\n`
  );
}

async function loadOpinionRun(
  opinionsDir: string,
  runId: string
): Promise<{
  manifest: unknown;
  records: unknown[];
}> {
  const runDir = path.join(opinionsDir, runId);
  const manifest = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
  const recordsDir = path.join(runDir, "records");
  const recordEntries = await readdir(recordsDir, { withFileTypes: true });
  const records: unknown[] = [];

  for (const entry of recordEntries
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const record = JSON.parse(await readFile(path.join(recordsDir, entry.name), "utf8")) as {
      normalizedRecordPath?: string;
    };
    const sourceRecord =
      typeof record.normalizedRecordPath === "string"
        ? await readJsonFile<NormalizedCommentRecord>(record.normalizedRecordPath)
        : null;

    records.push({
      ...record,
      ...(sourceRecord === null ? {} : { sourceRecord })
    });
  }

  return {
    manifest,
    records
  };
}

async function loadAnalysisRun(
  runsDir: string,
  runId: string
): Promise<LoadedAnalysisRun> {
  const runDir = path.join(runsDir, runId);
  const manifest = await readJsonFile<LoadedAnalysisRun["manifest"]>(
    path.join(runDir, "manifest.json")
  );

  if (manifest === null) {
    throw new Error(`Analysis run '${runId}' was not found.`);
  }

  const reductions = await loadArtifactDirectory<AnalysisReductionArtifact>(
    path.join(runDir, "reductions")
  );
  const clusters = await loadArtifactDirectory<AnalysisClusterArtifact>(
    path.join(runDir, "clusters")
  );
  const perspectives = await loadArtifactDirectory<AnalysisPerspectiveArtifact>(
    path.join(runDir, "perspectives")
  );
  const reducerEvaluation = await readJsonFile<AnalysisReducerEvaluationArtifact>(
    path.join(runDir, "reducer-eval", "summary.json")
  );
  const clusteringSurfaceEvaluation =
    await readJsonFile<AnalysisClusteringSurfaceEvaluationArtifact>(
      path.join(runDir, "cluster-surface-eval", "summary.json")
    );

  return {
    manifest,
    reductions,
    clusters,
    perspectives,
    reducerEvaluation,
    clusteringSurfaceEvaluation
  };
}

async function loadReportBundle(reportsDir: string, runId: string): Promise<ReportBundle> {
  const reportBundle = await readJsonFile<ReportBundle>(
    path.join(reportsDir, runId, "report-bundle.json")
  );

  if (reportBundle === null) {
    throw new Error(`Report '${runId}' was not found.`);
  }

  return reportBundle;
}

async function findLatestReportRun(reportsDir: string): Promise<string | null> {
  const entries = await readdir(reportsDir, { withFileTypes: true }).catch(() => []);
  const runs: Array<{ runId: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const bundlePath = path.join(reportsDir, entry.name, "report-bundle.json");
    const bundle = await readJsonFile<ReportBundle>(bundlePath);

    if (bundle === null) {
      continue;
    }

    const bundleStat = await readFile(bundlePath).then(() => null).catch(() => null);
    void bundleStat;
    const createdAt = Date.parse(bundle.createdAt);
    runs.push({
      runId: entry.name,
      mtimeMs: Number.isNaN(createdAt) ? 0 : createdAt
    });
  }

  runs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.runId.localeCompare(b.runId));
  return runs[0]?.runId ?? null;
}

async function loadOpinionArtifactLookup(
  opinionsRootDir: string,
  opinionRunIds: string[]
): Promise<Record<string, LoadedOpinionArtifact>> {
  if (opinionRunIds.length === 0) {
    return {};
  }

  const lookup: Record<string, LoadedOpinionArtifact> = {};

  for (const opinionRunId of opinionRunIds) {
    const opinionsDir = path.join(opinionsRootDir, opinionRunId, "opinions");
    const entries = await readdir(opinionsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const artifact = await readJsonFile<LoadedOpinionArtifact>(path.join(opinionsDir, entry.name));

      if (artifact?.opinionId !== undefined) {
        const normalizedRecord =
          artifact.provenance?.normalizedRecordPath === undefined
            ? null
            : await readJsonFile<NormalizedCommentRecord>(artifact.provenance.normalizedRecordPath);

        lookup[artifact.opinionId] = {
          ...artifact,
          ...(normalizedRecord === null
            ? {}
            : {
                fullComment: normalizedRecord.contentText
              })
        };
      }
    }
  }

  return lookup;
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

async function loadArtifactDirectory<T>(
  directoryPath: string
): Promise<Array<{ path: string; artifact: T }>> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  const artifacts: Array<{ path: string; artifact: T }> = [];

  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const artifactPath = path.join(directoryPath, entry.name);
    const artifact = await readJsonFile<T>(artifactPath);

    if (artifact !== null) {
      artifacts.push({ path: artifactPath, artifact });
    }
  }

  return artifacts;
}

async function loadNormalizedRecordPreviews(
  normalizedDir: string,
  offset: number,
  limit: number
): Promise<NormalizedRecordPreview[]> {
  const recordPaths = await listNormalizedRecordPaths(normalizedDir);
  const selectedPaths = recordPaths.slice(offset, offset + limit);
  const previews: NormalizedRecordPreview[] = [];

  for (const recordPath of selectedPaths) {
    const record = JSON.parse(await readFile(recordPath, "utf8")) as NormalizedCommentRecord;

    previews.push({
      sourceId: record.sourceId,
      contentSha256: record.contentSha256,
      contentText: record.contentText,
      primaryText: getNormalizedCommentPrimaryText(record),
      externalId: record.provenance.externalId ?? null,
      sourceRowNumber: record.provenance.sourceRowNumber ?? null,
      normalizedRecordPath: recordPath
    });
  }

  return previews;
}

async function loadAdminCorpus(projectPaths: ReturnType<typeof resolveProjectPaths>): Promise<AdminCorpus> {
  const reviewConfig = await ensureProjectReviewState(projectPaths);
  const comments = await loadAdminCommentEntries(projectPaths);
  const opinions = await loadAdminOpinionEntries(projectPaths, comments);
  const opinionIdsBySourceId = new Map<string, string[]>();

  for (const opinion of opinions) {
    const sourceId = opinion.artifact.sourceId;

    if (typeof sourceId !== "string" || sourceId.length === 0) {
      continue;
    }

    const existing = opinionIdsBySourceId.get(sourceId) ?? [];
    existing.push(opinion.opinionId);
    opinionIdsBySourceId.set(sourceId, existing);
  }

  return {
    reviewConfig,
    comments: comments.map((entry) => ({
      ...entry,
      relatedOpinionIds: [...(opinionIdsBySourceId.get(entry.sourceId) ?? [])].sort()
    })),
    opinions
  };
}

async function loadAdminCommentEntries(
  projectPaths: ReturnType<typeof resolveProjectPaths>
): Promise<AdminCommentEntry[]> {
  const recordPaths = await listNormalizedRecordPaths(path.join(projectPaths.dataDir, "normalized"));
  const comments: AdminCommentEntry[] = [];

  for (const recordPath of recordPaths) {
    const record = await readJsonFile<NormalizedCommentRecord>(recordPath);

    if (record === null) {
      continue;
    }

    const review = await loadCommentReview(projectPaths, record.sourceId);
    const suggestion = await loadCommentReviewSuggestion(projectPaths, record.sourceId);

    comments.push({
      sourceId: record.sourceId,
      recordPath,
      record,
      review,
      suggestion,
      effectiveStatus: review?.status ?? "included",
      relatedOpinionIds: []
    });
  }

  return comments.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

async function loadAdminOpinionEntries(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  comments: AdminCommentEntry[]
): Promise<AdminOpinionEntry[]> {
  const opinionsRootDir = path.join(projectPaths.dataDir, "opinions");
  const runEntries = await readdir(opinionsRootDir, { withFileTypes: true }).catch(() => []);
  const sortedRunEntries = runEntries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => right.name.localeCompare(left.name));
  const commentBySourceId = new Map(comments.map((entry) => [entry.sourceId, entry] as const));
  const opinionsById = new Map<string, AdminOpinionEntry>();

  for (const runEntry of sortedRunEntries) {
    const opinionsDir = path.join(opinionsRootDir, runEntry.name, "opinions");
    const opinionEntries = await readdir(opinionsDir, { withFileTypes: true }).catch(() => []);

    for (const opinionEntry of opinionEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const artifactPath = path.join(opinionsDir, opinionEntry.name);
      const artifact = await readJsonFile<LoadedOpinionArtifact>(artifactPath);

      if (artifact?.opinionId === undefined || opinionsById.has(artifact.opinionId)) {
        continue;
      }

      const commentEntry =
        typeof artifact.sourceId === "string" ? commentBySourceId.get(artifact.sourceId) ?? null : null;
      const [commentReview, opinionReview] = await Promise.all([
        typeof artifact.sourceId === "string" && artifact.sourceId.length > 0
          ? loadCommentReview(projectPaths, artifact.sourceId)
          : Promise.resolve(null),
        loadOpinionReview(projectPaths, artifact.opinionId)
      ]);
      const suggestion = await loadOpinionReviewSuggestion(projectPaths, artifact.opinionId);
      const effective = resolveEffectiveOpinionReviewStatus({
        commentReview,
        opinionReview
      });

      opinionsById.set(artifact.opinionId, {
        opinionId: artifact.opinionId,
        artifactPath,
        runId: runEntry.name,
        artifact:
          commentEntry?.record.contentText === undefined
            ? artifact
            : {
                ...artifact,
                fullComment: commentEntry.record.contentText
              },
        sourceRecord: commentEntry?.record ?? null,
        commentReview,
        opinionReview,
        suggestion,
        effectiveStatus: effective.status,
        effectiveStatusSource: effective.source
      });
    }
  }

  return [...opinionsById.values()].sort((left, right) => left.opinionId.localeCompare(right.opinionId));
}

function resolveReviewStatusFilters(
  requestedStatuses: string[],
  defaultStatuses: ReviewStatus[]
): ReviewStatus[] {
  const requested = requestedStatuses.filter(isReviewStatusValue);

  if (requested.length > 0) {
    return [...new Set(requested)];
  }

  return [...new Set(defaultStatuses)];
}

function isReviewStatusValue(value: string): value is ReviewStatus {
  return (REVIEW_STATUS_VALUES as readonly string[]).includes(value);
}

async function readRequestForm(
  request: AsyncIterable<Buffer | string>
): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function redirectResponse(response: ServerResponse, location: string): void {
  response.writeHead(303, { Location: location });
  response.end();
}

type SuggestionDecision = "accept" | "reject";

function parseSubmittedSuggestionDecision(value: string | null): SuggestionDecision {
  if (value === "accept" || value === "reject") {
    return value;
  }

  throw new Error("A valid suggestion decision is required.");
}

async function applyCommentSuggestionDecision(
  projectPaths: ProjectPaths,
  comment: AdminCommentEntry,
  decision: SuggestionDecision
): Promise<void> {
  const suggestion = comment.suggestion;

  if (suggestion === null) {
    throw new Error(`Comment '${comment.sourceId}' has no stored machine suggestion.`);
  }

  if (decision === "accept") {
    await upsertCommentReview(projectPaths, {
      subjectId: comment.sourceId,
      status: suggestion.suggestedStatus,
      reasonCode: suggestion.reasonCode,
      note: buildAcceptedSuggestionReviewNote(suggestion),
      actor: { type: "human", name: "local-admin" },
      normalizedRecordPath: suggestion.provenance.normalizedRecordPath || comment.recordPath
    });
  }

  await upsertCommentReviewSuggestion(projectPaths, {
    subjectId: suggestion.subjectId,
    suggestedStatus: suggestion.suggestedStatus,
    reasonCode: suggestion.reasonCode,
    note: suggestion.note,
    confidence: suggestion.confidence,
    state: decision === "accept" ? "accepted" : "rejected",
    actor: suggestion.actor,
    normalizedRecordPath: suggestion.provenance.normalizedRecordPath || comment.recordPath
  });
}

async function applyOpinionSuggestionDecision(
  projectPaths: ProjectPaths,
  opinion: AdminOpinionEntry,
  decision: SuggestionDecision
): Promise<void> {
  const suggestion = opinion.suggestion;

  if (suggestion === null) {
    throw new Error(`Opinion '${opinion.opinionId}' has no stored machine suggestion.`);
  }

  const opinionArtifactPath =
    suggestion.provenance.opinionArtifactPath || opinion.artifactPath;
  const sourceId = suggestion.provenance.sourceId || resolveOpinionSourceId(opinion);
  const normalizedRecordPath =
    suggestion.provenance.normalizedRecordPath ||
    resolveOpinionNormalizedRecordPath(projectPaths, opinion);

  if (decision === "accept") {
    await upsertOpinionReview(projectPaths, {
      subjectId: opinion.opinionId,
      status: suggestion.suggestedStatus,
      reasonCode: suggestion.reasonCode,
      note: buildAcceptedSuggestionReviewNote(suggestion),
      actor: { type: "human", name: "local-admin" },
      opinionArtifactPath,
      sourceId,
      normalizedRecordPath
    });
  }

  await upsertOpinionReviewSuggestion(projectPaths, {
    subjectId: suggestion.subjectId,
    suggestedStatus: suggestion.suggestedStatus,
    reasonCode: suggestion.reasonCode,
    note: suggestion.note,
    confidence: suggestion.confidence,
    state: decision === "accept" ? "accepted" : "rejected",
    actor: suggestion.actor,
    opinionArtifactPath,
    sourceId,
    normalizedRecordPath
  });
}

function buildAcceptedSuggestionReviewNote(
  suggestion: CommentReviewSuggestionArtifact | OpinionReviewSuggestionArtifact
): string {
  return suggestion.note.length === 0
    ? `Accepted machine suggestion: ${suggestion.reasonCode}`
    : suggestion.note;
}

function resolveOpinionSourceId(opinion: AdminOpinionEntry): string {
  return (
    opinion.artifact.sourceId ??
    opinion.sourceRecord?.sourceId ??
    opinion.opinionReview?.provenance.sourceId ??
    opinion.commentReview?.subjectId ??
    ""
  );
}

function resolveOpinionNormalizedRecordPath(
  projectPaths: ProjectPaths,
  opinion: AdminOpinionEntry
): string {
  if (opinion.sourceRecord !== null) {
    return path.join(projectPaths.dataDir, "normalized", `${opinion.sourceRecord.sourceId}.json`);
  }

  return (
    opinion.opinionReview?.provenance.normalizedRecordPath ??
    opinion.commentReview?.provenance.normalizedRecordPath ??
    ""
  );
}

function parseSubmittedReviewStatus(value: string | null): ReviewStatus {
  if (value !== null && isReviewStatusValue(value)) {
    return value;
  }

  throw new Error("A valid review status is required.");
}

function parseSubmittedStatementStatus(value: string | null): StatementModerationStatus {
  const statuses: StatementModerationStatus[] = [
    "pending",
    "accepted",
    "rejected",
    "hidden_from_public",
    "excluded_from_analysis"
  ];

  if (value !== null && statuses.includes(value as StatementModerationStatus)) {
    return value as StatementModerationStatus;
  }

  throw new Error("A valid statement status is required.");
}

function parseSubmittedStatementVisibility(value: string | null): StatementVisibilityStatus {
  if (value !== null && isStatementVisibilityStatus(value)) {
    return value;
  }

  throw new Error("A valid statement visibility is required.");
}

function parseSubmittedReviewStatusList(values: string[], fieldLabel: string): ReviewStatus[] {
  const statuses = values.filter(isReviewStatusValue);
  const uniqueStatuses = [...new Set(statuses)];

  if (uniqueStatuses.length === 0) {
    throw new Error(`Select at least one status for ${fieldLabel}.`);
  }

  return uniqueStatuses;
}

function normalizeSubmittedText(value: string | null, fallback = ""): string {
  const normalized = value?.trim() ?? "";
  return normalized.length === 0 ? fallback : normalized;
}

function renderHomePage(data: ProjectDashboardData): string {
  const steps = buildPipelineSteps(data);

  return renderPage(
    data,
    "Overview",
    `<main class="shell">
      ${renderHeader(data, "Overview")}
      <section class="panel intro-grid">
        <article class="card feature-card">
          <p class="eyebrow">Project</p>
          <h2>${escapeHtml(data.config.project.name)}</h2>
          <p class="lede">${escapeHtml(data.config.project.description)}</p>
          ${data.config.project.goals.length > 0
            ? `<div class="stack"><p class="section-label">Goals</p>${renderBulletList(data.config.project.goals)}</div>`
            : ""}
        </article>
        <article class="card feature-card">
          <p class="eyebrow">Key Questions</p>
          <h2>What this analysis should answer</h2>
          ${renderBulletList(data.config.questions)}
        </article>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Pipeline</p>
            <h2>Where this project is in the workflow</h2>
          </div>
          <p class="meta">Open any stage to inspect inputs, outputs, and current status.</p>
        </div>
        <div class="pipeline-grid">
          ${steps.map((step) => renderPipelineCard(step)).join("")}
        </div>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Recent Runs</p>
            <h2>Opinion extraction outputs</h2>
          </div>
          <a class="text-link" href="/pipeline/opinions">Open opinions stage</a>
        </div>
        ${data.opinionRuns.length === 0
          ? `<article class="card"><p>No opinion runs yet. Run <code>broadly opinions</code> first.</p></article>`
          : `<section class="grid">
              ${data.opinionRuns
                .slice(0, 4)
                .map(
                  (run) => `<a class="card link-card" href="/runs/${encodeURIComponent(run.runId)}">
                      <p class="eyebrow">${escapeHtml(run.createdAt)}</p>
                      <h3>${escapeHtml(run.runId)}</h3>
                      <p>${escapeHtml(run.modelLabel)}</p>
                      <p class="meta">${run.recordsWritten} / ${run.recordsAttempted} records · ${run.opinionsWritten} opinions · ${run.failedRecords} failures</p>
                    </a>`
                )
                .join("")}
            </section>`}
      </section>
    </main>`
  );
}

function renderAdminOverviewPage(data: ProjectDashboardData, adminCorpus: AdminCorpus): string {
  const commentCounts = summarizeReviewStatuses(
    adminCorpus.comments.map((entry) => entry.effectiveStatus)
  );
  const opinionCounts = summarizeReviewStatuses(
    adminCorpus.opinions.map((entry) => entry.effectiveStatus)
  );

  return renderPage(
    data,
    "Admin Review",
    `<main class="shell">
      ${renderHeader(data, "Admin Review")}
      <section class="panel">
        <article class="card feature-card">
          <p class="eyebrow">Review Layer</p>
          <h2>Visible content controls</h2>
          <p class="lede">Filtering decisions are stored separately from normalized comments and extracted opinions. Nothing here deletes the underlying artifacts.</p>
          <div class="button-row">
            <a class="button-link" href="/admin/content?kind=opinions">Browse opinions</a>
            <a class="button-link button-link-secondary" href="/admin/content?kind=comments">Browse comments</a>
            <a class="button-link button-link-secondary" href="/admin/config">Open review config</a>
          </div>
        </article>
      </section>
      <section class="panel two-up">
        <article class="card">
          <p class="eyebrow">Comments</p>
          <h2>${adminCorpus.comments.length} source comments</h2>
          ${renderReviewStatusSummary("comments", commentCounts)}
        </article>
        <article class="card">
          <p class="eyebrow">Opinions</p>
          <h2>${adminCorpus.opinions.length} extracted opinions</h2>
          ${renderReviewStatusSummary("opinions", opinionCounts)}
        </article>
      </section>
    </main>`
  );
}

function renderAdminContentPage(
  data: ProjectDashboardData,
  adminCorpus: AdminCorpus,
  options: {
    kind: "comments" | "opinions";
    statusFilters: ReviewStatus[];
    query: string;
    offset: number;
    limit: number;
  }
): string {
  const allItems =
    options.kind === "comments"
      ? adminCorpus.comments.filter(
          (entry) =>
            options.statusFilters.includes(entry.effectiveStatus) &&
            matchesAdminCommentQuery(entry, options.query)
        )
      : adminCorpus.opinions.filter(
          (entry) =>
            options.statusFilters.includes(entry.effectiveStatus) &&
            matchesAdminOpinionQuery(entry, options.query)
        );
  const pageItems = allItems.slice(options.offset, options.offset + options.limit);
  const shownStart = allItems.length === 0 ? 0 : options.offset + 1;
  const shownEnd = Math.min(options.offset + pageItems.length, allItems.length);
  const nextOffset = options.offset + pageItems.length;
  const hasMore = nextOffset < allItems.length;

  return renderPage(
    data,
    "Admin Review",
    `<main class="shell">
      ${renderHeader(data, "Admin Review")}
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Content Browser</p>
            <h2>Reviewable corpus</h2>
          </div>
          <p class="meta">Showing ${shownStart}-${shownEnd} of ${allItems.length} ${escapeHtml(options.kind)}</p>
        </div>
        <div class="admin-toolbar">
          <div class="toggle-row">
            ${renderAdminKindToggle(options.kind, options.query)}
          </div>
          <div class="filter-row">
            ${renderReviewFilterLinks("/admin/content", options.kind, options.statusFilters, options.query)}
          </div>
        </div>
        <form class="card admin-search-card" method="get" action="/admin/content">
          <input type="hidden" name="kind" value="${escapeHtmlAttribute(options.kind)}" />
          ${options.statusFilters
            .map(
              (status) =>
                `<input type="hidden" name="status" value="${escapeHtmlAttribute(status)}" />`
            )
            .join("")}
          <div class="form-grid admin-search-grid">
            <label class="field">
              <span>Search</span>
              <input name="q" value="${escapeHtmlAttribute(options.query)}" placeholder="Search text, ids, notes, reason codes..." />
            </label>
            <div class="admin-search-actions">
              <button class="button-link" type="submit">Search</button>
              <a class="button-link button-link-secondary" href="${buildAdminContentHref(options.kind, options.statusFilters, 0)}">Clear</a>
            </div>
          </div>
        </form>
        <form class="card admin-form admin-bulk-form" method="post" action="/admin/content/bulk-review">
          <input type="hidden" name="kind" value="${escapeHtmlAttribute(options.kind)}" />
          <input type="hidden" name="q" value="${escapeHtmlAttribute(options.query)}" />
          ${options.statusFilters
            .map(
              (status) =>
                `<input type="hidden" name="activeStatus" value="${escapeHtmlAttribute(status)}" />`
            )
            .join("")}
          <div class="section-head">
            <div>
              <p class="eyebrow">Bulk Review</p>
              <h3>Apply a status to selected ${escapeHtml(options.kind)}</h3>
            </div>
            <p class="meta">This first slice only changes the items you explicitly select on this page.</p>
          </div>
          <div class="form-grid">
            <label class="field">
              <span>Status</span>
              <select name="status">
                ${renderReviewStatusOptions("included")}
              </select>
            </label>
            <label class="field">
              <span>Reason code</span>
              <input name="reasonCode" value="manual-bulk-update" />
            </label>
          </div>
          <label class="field">
            <span>Note</span>
            <textarea name="note" rows="3" placeholder="Optional note. Required for excluded-admin."></textarea>
          </label>
          ${
            options.kind === "comments"
              ? renderAdminCommentTable(pageItems as AdminCommentEntry[])
              : renderAdminOpinionTable(pageItems as AdminOpinionEntry[])
          }
          <div class="button-row">
            <button class="button-link" type="submit">Apply to selected</button>
          </div>
        </form>
        <div class="load-more-row">
          ${
            hasMore
              ? `<a class="button-link" href="${buildAdminContentHref(options.kind, options.statusFilters, nextOffset, options.query)}">Load more...</a>`
              : `<p class="meta">End of results.</p>`
          }
        </div>
      </section>
    </main>`
  );
}

function renderAdminConfigPage(data: ProjectDashboardData, adminCorpus: AdminCorpus): string {
  return renderPage(
    data,
    "Admin Review",
    `<main class="shell">
      ${renderHeader(data, "Admin Review")}
      <section class="panel">
        <form class="card admin-form" method="post" action="/admin/config">
          <p class="eyebrow">Review Config</p>
          <h2>Included and visible statuses</h2>
          <div class="form-grid">
            <section class="stack">
              <p class="section-label">Analysis: comments</p>
              ${renderReviewStatusCheckboxes(
                "analysisIncludeCommentStatuses",
                adminCorpus.reviewConfig.analysis.includeCommentStatuses
              )}
            </section>
            <section class="stack">
              <p class="section-label">Analysis: opinions</p>
              ${renderReviewStatusCheckboxes(
                "analysisIncludeOpinionStatuses",
                adminCorpus.reviewConfig.analysis.includeOpinionStatuses
              )}
            </section>
            <section class="stack">
              <p class="section-label">Report: comments</p>
              ${renderReviewStatusCheckboxes(
                "reportIncludeCommentStatuses",
                adminCorpus.reviewConfig.report.includeCommentStatuses
              )}
            </section>
            <section class="stack">
              <p class="section-label">Report: opinions</p>
              ${renderReviewStatusCheckboxes(
                "reportIncludeOpinionStatuses",
                adminCorpus.reviewConfig.report.includeOpinionStatuses
              )}
            </section>
            <section class="stack">
              <p class="section-label">Web defaults: comments</p>
              ${renderReviewStatusCheckboxes(
                "webDefaultVisibleCommentStatuses",
                adminCorpus.reviewConfig.web.defaultVisibleCommentStatuses
              )}
            </section>
            <section class="stack">
              <p class="section-label">Web defaults: opinions</p>
              ${renderReviewStatusCheckboxes(
                "webDefaultVisibleOpinionStatuses",
                adminCorpus.reviewConfig.web.defaultVisibleOpinionStatuses
              )}
            </section>
          </div>
          <div class="button-row">
            <button class="button-link" type="submit">Save review config</button>
          </div>
        </form>
      </section>
      <section class="panel">
        <article class="card">
          <p class="eyebrow">Artifact</p>
          <h2>Review config file</h2>
          <p class="meta">${escapeHtml(toPortableRelativePath(data.projectRoot, resolveProjectPaths(data.projectRoot).reviewConfigPath))}</p>
          <p>These lists control what analysis consumes, what reports surface, and what the admin UI shows by default. Every list must contain at least one status.</p>
        </article>
      </section>
    </main>`
  );
}

function renderAdminCommentDetailPage(
  data: ProjectDashboardData,
  adminCorpus: AdminCorpus,
  sourceId: string
): string {
  const comment = adminCorpus.comments.find((entry) => entry.sourceId === sourceId);

  if (comment === undefined) {
    throw new Error(`Comment '${sourceId}' was not found.`);
  }

  const relatedOpinions = adminCorpus.opinions.filter((entry) => entry.artifact.sourceId === sourceId);

  return renderPage(
    data,
    "Admin Review",
    `<main class="shell">
      ${renderHeader(data, "Admin Review")}
      <section class="panel">
        <p class="eyebrow"><a href="/admin/content?kind=comments">Back to comment browser</a></p>
        <div class="section-head">
          <div>
            <p class="eyebrow">Comment</p>
            <h2>${escapeHtml(comment.sourceId)}</h2>
          </div>
          ${renderReviewStatusBadge(comment.effectiveStatus)}
        </div>
        <article class="card">
          ${renderKeyValueList([
            ["Row", String(comment.record.provenance.sourceRowNumber ?? "unknown")],
            ["External ID", comment.record.provenance.externalId ?? "none"],
            ["Artifact", toPortableRelativePath(data.projectRoot, comment.recordPath)],
            ["Related opinions", String(relatedOpinions.length)]
          ])}
          ${renderReviewArtifactSummary(comment.review, "comment")}
          ${renderReviewSuggestionSummary(comment.suggestion, "comment", {
            actionPath: `/admin/comments/${encodeURIComponent(comment.sourceId)}/suggestion`,
            nextPath: `/admin/comments/${encodeURIComponent(comment.sourceId)}`
          })}
          ${
            getNormalizedCommentPrimaryText(comment.record) === comment.record.contentText
              ? ""
              : `<p class="section-label">Primary text</p><pre>${escapeHtml(getNormalizedCommentPrimaryText(comment.record))}</pre>`
          }
          <p class="section-label">Full normalized record</p>
          <pre>${escapeHtml(comment.record.contentText)}</pre>
        </article>
        <form class="card admin-form" method="post" action="/admin/comments/${encodeURIComponent(comment.sourceId)}/review">
          <input type="hidden" name="next" value="/admin/comments/${encodeURIComponent(comment.sourceId)}" />
          <p class="eyebrow">Update Review</p>
          <h3>Comment status</h3>
          <div class="form-grid">
            <label class="field">
              <span>Status</span>
              <select name="status">
                ${renderReviewStatusOptions(comment.review?.status ?? comment.effectiveStatus)}
              </select>
            </label>
            <label class="field">
              <span>Reason code</span>
              <input name="reasonCode" value="${escapeHtmlAttribute(comment.review?.reasonCode ?? "manual-update")}" />
            </label>
          </div>
          <label class="field">
            <span>Note</span>
            <textarea name="note" rows="4" placeholder="Optional note. Required for excluded-admin.">${escapeHtml(comment.review?.note ?? "")}</textarea>
          </label>
          <div class="button-row">
            <button class="button-link" type="submit">Save comment review</button>
          </div>
        </form>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Opinions</p>
            <h2>Derived from this comment</h2>
          </div>
        </div>
        ${
          relatedOpinions.length === 0
            ? `<article class="card"><p>No extracted opinions reference this comment yet.</p></article>`
            : `<section class="grid">
                ${relatedOpinions.map((opinion) => renderAdminOpinionCard(opinion)).join("")}
              </section>`
        }
      </section>
    </main>`
  );
}

function renderAdminOpinionDetailPage(
  data: ProjectDashboardData,
  adminCorpus: AdminCorpus,
  opinionId: string
): string {
  const opinion = adminCorpus.opinions.find((entry) => entry.opinionId === opinionId);

  if (opinion === undefined) {
    throw new Error(`Opinion '${opinionId}' was not found.`);
  }

  return renderPage(
    data,
    "Admin Review",
    `<main class="shell">
      ${renderHeader(data, "Admin Review")}
      <section class="panel">
        <p class="eyebrow"><a href="/admin/content?kind=opinions">Back to opinion browser</a></p>
        <div class="section-head">
          <div>
            <p class="eyebrow">Opinion</p>
            <h2>${escapeHtml(truncateForUi(opinion.artifact.opinionText ?? opinion.opinionId, 120))}</h2>
          </div>
          ${renderReviewStatusBadge(opinion.effectiveStatus)}
        </div>
        <article class="card stack">
          ${renderKeyValueList([
            ["Opinion ID", opinion.opinionId],
            ["Effective source", opinion.effectiveStatusSource],
            ["Opinion artifact", toPortableRelativePath(data.projectRoot, opinion.artifactPath)],
            ["Opinion run", opinion.runId],
            ["Source comment", opinion.artifact.sourceId ?? "unknown"]
          ])}
          ${renderReviewArtifactSummary(opinion.opinionReview, "opinion")}
          ${renderReviewArtifactSummary(opinion.commentReview, "comment")}
          ${renderReviewSuggestionSummary(opinion.suggestion, "opinion", {
            actionPath: `/admin/opinions/${encodeURIComponent(opinion.opinionId)}/suggestion`,
            nextPath: `/admin/opinions/${encodeURIComponent(opinion.opinionId)}`
          })}
          <div class="stack">
            <p class="section-label">Opinion</p>
            <p>${escapeHtml(opinion.artifact.opinionText ?? "")}</p>
          </div>
          <div class="stack">
            <p class="section-label">Excerpt</p>
            <p>${escapeHtml(opinion.artifact.excerpt ?? "")}</p>
          </div>
          <div class="stack">
            <p class="section-label">Full comment</p>
            <pre>${escapeHtml(opinion.sourceRecord?.contentText ?? opinion.artifact.fullComment ?? "Source comment unavailable.")}</pre>
          </div>
        </article>
        <form class="card admin-form" method="post" action="/admin/opinions/${encodeURIComponent(opinion.opinionId)}/review">
          <input type="hidden" name="next" value="/admin/opinions/${encodeURIComponent(opinion.opinionId)}" />
          <p class="eyebrow">Update Review</p>
          <h3>Opinion status</h3>
          <div class="form-grid">
            <label class="field">
              <span>Status</span>
              <select name="status">
                ${renderReviewStatusOptions(opinion.opinionReview?.status ?? opinion.effectiveStatus)}
              </select>
            </label>
            <label class="field">
              <span>Reason code</span>
              <input name="reasonCode" value="${escapeHtmlAttribute(opinion.opinionReview?.reasonCode ?? "manual-update")}" />
            </label>
          </div>
          <label class="field">
            <span>Note</span>
            <textarea name="note" rows="4" placeholder="Optional note. Required for excluded-admin.">${escapeHtml(opinion.opinionReview?.note ?? "")}</textarea>
          </label>
          <div class="button-row">
            <button class="button-link" type="submit">Save opinion review</button>
          </div>
        </form>
      </section>
    </main>`
  );
}

function renderIngestPage(
  data: ProjectDashboardData,
  previews: NormalizedRecordPreview[],
  offset: number,
  limit: number
): string {
  const ingestStep = buildPipelineSteps(data).find((step) => step.step === "ingest");
  const shownStart = data.ingest.normalizedRecordCount === 0 ? 0 : offset + 1;
  const shownEnd = Math.min(offset + previews.length, data.ingest.normalizedRecordCount);
  const nextOffset = offset + previews.length;
  const hasMore = nextOffset < data.ingest.normalizedRecordCount;

  return renderPage(
    data,
    "Ingest Comments",
    `<main class="shell">
      ${renderHeader(data, "Ingest Comments")}
      <section class="panel two-up">
        <article class="card">
          <p class="eyebrow">Dataset</p>
          <h2>Configured source</h2>
          ${renderKeyValueList([
            ["Path", data.ingest.sourcePath],
            ["Format", data.ingest.format],
            ["Encoding", data.ingest.encoding ?? "not set"],
            ["Delimiter", data.ingest.delimiter ?? "not set"],
            ["ID column", data.ingest.idColumn ?? "not set"],
            [
              "Allowed fields",
              data.config.dataset.allowFields === undefined
                ? "all source fields"
                : `${data.config.dataset.allowFields.length} selected`
            ]
          ])}
          ${
            data.config.dataset.allowFields === undefined
              ? ""
              : `<div class="stack"><p class="section-label">Included Fields</p>${renderBulletList(
                  data.config.dataset.allowFields
                )}</div>`
          }
        </article>
        <article class="card">
          <p class="eyebrow">Status</p>
          <h2>${escapeHtml(stageStatusLabel(ingestStep?.status ?? "pending"))}</h2>
          ${renderKeyValueList([
            ["Raw files", String(data.ingest.rawFileCount)],
            ["Normalized records", String(data.ingest.normalizedRecordCount)],
            ["Manifest", data.ingest.manifestPath ?? "not found"],
            ["Imported at", data.ingest.latestImport?.createdAt ?? "not recorded"]
          ])}
        </article>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Artifacts</p>
            <h2>What ingest produced</h2>
          </div>
        </div>
        <section class="grid">
          <article class="card">
            <h3>Raw source snapshot</h3>
            <p class="meta">${data.ingest.latestImport?.sourceFileSha256 ?? "not available"}</p>
          </article>
          <article class="card">
            <h3>Normalized row corpus</h3>
            <p class="meta">${data.ingest.latestImport?.recordsWritten ?? data.ingest.normalizedRecordCount} record artifacts</p>
          </article>
        </section>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Preview</p>
            <h2>Sample normalized records</h2>
          </div>
          <p class="meta">Showing ${shownStart}-${shownEnd} of ${data.ingest.normalizedRecordCount}</p>
        </div>
        ${
          previews.length === 0
            ? `<article class="card"><p>No normalized records are available yet.</p></article>`
            : `<section class="record-list">
                ${previews
                  .map((preview, index) =>
                    renderNormalizedRecordPreview(preview, offset + index + 1, data.projectRoot)
                  )
                  .join("")}
              </section>
              <div class="load-more-row">
                ${
                  hasMore
                    ? `<a class="button-link" href="/pipeline/ingest?offset=${nextOffset}">Load more...</a>`
                    : `<p class="meta">End of preview list.</p>`
                }
              </div>`
        }
      </section>
    </main>`
  );
}

function renderOpinionsPage(data: ProjectDashboardData): string {
  const latestRun = data.opinionRuns[0];
  const extractionModelLabel = latestRun?.modelLabel ?? "See configured opinion extractions";
  const embeddingModelLabel = uniqueLabels(
    data.config.analysisViews.map((view) =>
      resolveRegisteredModelLabel(data.config, view.embeddingModel)
    )
  ).join(", ");
  const opinionsStatus = describeOpinionRunStatus(data);

  return renderPage(
    data,
    "Extract Opinions",
    `<main class="shell">
      ${renderHeader(data, "Extract Opinions")}
      <section class="panel two-up">
        <article class="card">
          <p class="eyebrow">Configured Analysis</p>
          <h2>Current model settings</h2>
          ${renderKeyValueList([
            ["Opinion extraction model", extractionModelLabel],
            ["Embedding model", embeddingModelLabel],
            ["Opinion extractions", data.config.opinionExtractions.map((item) => item.name).join(", ")],
            ["Analysis views", data.config.analysisViews.map((item) => item.name).join(", ")],
            ["Reduction methods", uniqueLabels(data.config.analysisViews.map((item) => item.reduction.method)).join(", ")],
            ["Cluster counts", uniqueLabels(data.config.analysisViews.map((item) => String(item.clustering.count))).join(", ")]
          ])}
        </article>
        <article class="card">
          <p class="eyebrow">Status</p>
          <h2>${escapeHtml(opinionsStatus.label)}</h2>
          ${renderKeyValueList([
            ["Opinion runs", String(data.opinionRuns.length)],
            ["Processed records", opinionsStatus.processedSummary],
            ["Latest run", latestRun?.runId ?? "none"],
            ["Latest model", latestRun?.modelLabel ?? "none"]
          ])}
          <p class="meta">${escapeHtml(opinionsStatus.detail)}</p>
        </article>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Runs</p>
            <h2>Extracted opinion batches</h2>
          </div>
        </div>
        ${data.opinionRuns.length === 0
          ? `<article class="card"><p>No runs yet. Run <code>broadly opinions</code> first.</p></article>`
          : `<section class="grid">
              ${data.opinionRuns
                .map(
                  (run) => `<a class="card link-card" href="/runs/${encodeURIComponent(run.runId)}">
                      <p class="eyebrow">${escapeHtml(run.createdAt)}</p>
                      <h3>${escapeHtml(run.runId)}</h3>
                      <p>${escapeHtml(run.modelLabel)}</p>
                      <p class="meta">${run.recordsWritten} / ${run.recordsAttempted} records · ${run.opinionsWritten} opinions · ${run.failedRecords} failures</p>
                    </a>`
                )
                .join("")}
            </section>`}
      </section>
    </main>`
  );
}

function renderAnalysisPage(data: ProjectDashboardData): string {
  const status = buildPipelineSteps(data).find((step) => step.step === "analysis")?.status ?? "pending";
  const latestRun = data.analysis.runs[0];
  const analysisModelLabel = uniqueLabels(
    data.config.analysisViews.map((view) =>
      resolveRegisteredModelLabel(
        data.config,
        view.analysisModel ??
          data.config.opinionExtractions.find((extraction) => extraction.name === view.sourceExtraction)?.model ??
          "unknown"
      )
    )
  ).join(", ");

  return renderPage(
    data,
    "Perform Analysis",
    `<main class="shell">
      ${renderHeader(data, "Perform Analysis")}
      <section class="panel two-up">
        <article class="card">
          <p class="eyebrow">Status</p>
          <h2>${escapeHtml(stageStatusLabel(status))}</h2>
          <p class="lede">${escapeHtml(describeAnalysisStatus(status, data.analysis.runCount, data.opinionRuns.length))}</p>
        </article>
        <article class="card">
          <p class="eyebrow">Configuration</p>
          <h2>Analysis settings</h2>
          ${renderKeyValueList([
            ["Analysis model", analysisModelLabel],
            [
              "Merge strategy",
              uniqueLabels(data.config.analysisViews.map((view) => view.clustering.mergeStrategy)).join(", ")
            ],
            [
              "Reduction methods",
              `${uniqueLabels(data.config.analysisViews.map((view) => view.reduction.method)).join(", ")} (2d)`
            ],
            ["Cluster counts", uniqueLabels(data.config.analysisViews.map((view) => String(view.clustering.count))).join(", ")],
            ["Analysis views", data.config.analysisViews.map((view) => view.name).join(", ")]
          ])}
        </article>
      </section>
      <section class="panel">
        <article class="card">
          <p class="section-label">Current state</p>
          <p>${escapeHtml(
            data.analysis.runCount > 0
              ? `Found ${data.analysis.runCount} item(s) in runs/. This stage has produced analysis artifacts.`
              : "No analysis artifacts found in runs/ yet. The pipeline has opinion artifacts, but clustering, synthesis, and map-oriented analysis have not been executed."
          )}</p>
        </article>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Runs</p>
            <h2>Analysis artifact sets</h2>
          </div>
          ${
            latestRun === undefined
              ? ""
              : `<p class="meta">Latest run ${escapeHtml(latestRun.runId)}</p>`
          }
        </div>
        ${data.analysis.runs.length === 0
          ? `<article class="card"><p>No analysis runs yet. Run <code>broadly analysis</code> first.</p></article>`
          : `<section class="grid">
              ${data.analysis.runs
                .map(
                  (run) => `<a class="card link-card" href="/analysis-runs/${encodeURIComponent(run.runId)}">
                      <p class="eyebrow">${escapeHtml(run.createdAt)}</p>
                      <h3>${escapeHtml(run.runId)}</h3>
                      <p>${escapeHtml(run.embeddingModelLabel)}</p>
                      <p class="meta">${escapeHtml(run.status)} · reductions ${escapeHtml(run.reductionMethods.join(", "))} · clusters ${escapeHtml(run.clusterCounts.join(", "))}</p>
                    </a>`
                )
                .join("")}
            </section>`}
      </section>
    </main>`
  );
}

function renderReportPage(data: ProjectDashboardData): string {
  const status = buildPipelineSteps(data).find((step) => step.step === "report")?.status ?? "pending";
  const latestReportRunId = data.report.files[0] ?? null;

  return renderPage(
    data,
    "Create Report",
    `<main class="shell">
      ${renderHeader(data, "Create Report")}
      <section class="panel two-up">
        <article class="card">
          <p class="eyebrow">Status</p>
          <h2>${escapeHtml(stageStatusLabel(status))}</h2>
          <p class="lede">${escapeHtml(
            data.report.fileCount > 0
              ? `Found ${data.report.fileCount} file(s) in reports/.`
              : "No report output exists yet."
          )}</p>
        </article>
        <article class="card">
          <p class="eyebrow">Output</p>
          <h2>Report settings</h2>
          ${renderKeyValueList([
            ["Report directory", data.report.reportDir],
            ["Primary view", data.report.primaryView]
          ])}
        </article>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Reports</p>
            <h2>Published report bundles</h2>
          </div>
          ${
            latestReportRunId === null
              ? ""
              : `<a class="text-link" href="/report">Open latest report</a>`
          }
        </div>
        ${data.report.files.length === 0
          ? `<article class="card"><p>No report files yet.</p></article>`
          : `<section class="grid">
              ${data.report.files
                .map(
                  (runId) => `<a class="card link-card" href="/reports/${encodeURIComponent(runId)}">
                      <p class="eyebrow">Report bundle</p>
                      <h3>${escapeHtml(runId)}</h3>
                      <p class="meta">Open the JSON-backed report view for this run.</p>
                    </a>`
                )
                .join("")}
            </section>`}
      </section>
    </main>`
  );
}

function renderStatementsPage(data: ProjectDashboardData, loaded: LoadedStatementBank): string {
  const summary = summarizeWebStatementStatuses(loaded.statements);
  const sortedStatements = [...loaded.statements].sort((left, right) =>
    left.statementId.localeCompare(right.statementId)
  );

  return renderPage(
    data,
    "Statements",
    `<main class="shell">
      ${renderHeader(data, "Statements")}
      <section class="panel two-up">
        <article class="card">
          <p class="eyebrow">Statement Bank</p>
          <h2>${escapeHtml(loaded.statementRunId)}</h2>
          <p class="lede">${escapeHtml(loaded.bank.projectName)}</p>
          ${renderKeyValueList([
            ["Analysis run", loaded.bank.analysisRunId],
            ["Report", loaded.bank.reportId],
            ["Statement bank", toPortableRelativePath(data.projectRoot, loaded.statementRunPaths.statementBankPath)],
            ["Accepted export", toPortableRelativePath(data.projectRoot, loaded.statementRunPaths.acceptedStatementsPath)]
          ])}
        </article>
        <article class="card">
          <p class="eyebrow">Review State</p>
          <h2>${summary.accepted} accepted / ${loaded.statements.length} total</h2>
          <div class="meta-row">
            ${renderStatementStatusBadge("pending", summary.pending)}
            ${renderStatementStatusBadge("accepted", summary.accepted)}
            ${renderStatementStatusBadge("rejected", summary.rejected)}
            ${renderStatementStatusBadge("hidden_from_public", summary.hidden_from_public)}
            ${renderStatementStatusBadge("excluded_from_analysis", summary.excluded_from_analysis)}
          </div>
          <p class="meta">Accepted statements are exported automatically after web edits.</p>
        </article>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Review</p>
            <h2>Generated statements</h2>
          </div>
          <p class="meta">Status edits are local review artifacts under statements/${escapeHtml(loaded.statementRunId)}/review/.</p>
        </div>
        ${
          sortedStatements.length === 0
            ? `<article class="card"><p>No statements found in this bank.</p></article>`
            : `<section class="stack">
                ${sortedStatements
                  .map((statement) => renderStatementReviewCard(data, loaded, statement))
                  .join("")}
              </section>`
        }
      </section>
    </main>`
  );
}

function renderVoteSummarySection(summary: VoteRoundSummary): string {
  const topStatements = summary.statements
    .filter((statement) => statement.totals.total > 0)
    .sort((left, right) => right.totals.total - left.totals.total)
    .slice(0, 6);

  return `<section class="panel">
    <article class="card feature-card">
      <p class="eyebrow">Follow-up Voting Round</p>
      <h2>${escapeHtml(summary.voteRoundId)}</h2>
      ${renderKeyValueList([
        ["Participants", String(summary.participantCount)],
        ["Initial questions", String(summary.initialQuestions.length)],
        ["Statements", String(summary.statementCount)],
        ["High consensus", String(summary.highConsensusStatementIds.length)],
        ["High contention", String(summary.highContentionStatementIds.length)],
        ["Low participation", String(summary.lowParticipationStatementIds.length)]
      ])}
      ${
        summary.initialQuestions.length === 0
          ? ""
          : `<div class="stack">
              <p class="section-label">Initial question results</p>
              ${summary.initialQuestions
                .map(
                  (question) => `<blockquote>
                    yes ${Math.round(question.rates.yes * 100)}%
                    · no ${Math.round(question.rates.no * 100)}%
                    · skip ${Math.round(question.rates.skip * 100)}%
                    <br />${escapeHtml(question.questionText)}
                  </blockquote>`
                )
                .join("")}
            </div>`
      }
      ${
        topStatements.length === 0
          ? `<p class="meta">No reactions have been recorded yet.</p>`
          : `<div class="stack">
              <p class="section-label">Statement results</p>
              ${topStatements
                .map(
                  (statement) => `<blockquote>
                    <strong>${escapeHtml(statement.classification)}</strong>
                    · agree ${Math.round(statement.rates.agree * 100)}%
                    · disagree ${Math.round(statement.rates.disagree * 100)}%
                    · pass ${Math.round(statement.rates.pass * 100)}%
                    <br />${escapeHtml(statement.statementText)}
                  </blockquote>`
                )
                .join("")}
            </div>`
      }
    </article>
  </section>`;
}

function renderPublishedReportPage(
  data: ProjectDashboardData,
  runId: string,
  report: ReportBundle,
  analysisRun: LoadedAnalysisRun,
  opinionLookup: Record<string, LoadedOpinionArtifact>,
  voteSummary: VoteRoundSummary | null
): string {
  const primaryPerspective =
    report.views.find((view) => view.viewId === report.primaryViewId) ?? report.views[0];
  const clusterArtifactByPath = new Map(
    analysisRun.clusters.map((cluster) => [cluster.path, cluster.artifact] as const)
  );
  const perspectiveArtifactByMode = new Map(
    analysisRun.perspectives
      .filter((perspective) => perspective.artifact.viewName !== undefined)
      .map((perspective) => [perspective.artifact.viewName as string, perspective.artifact] as const)
  );
  const perspectiveConfigs = report.views.map((perspective) => {
    const perspectiveArtifact = perspectiveArtifactByMode.get(perspective.viewId);
    const clusterArtifact =
      perspectiveArtifact?.chosenClusterArtifactPath === undefined
        ? undefined
        : clusterArtifactByPath.get(perspectiveArtifact.chosenClusterArtifactPath);

    return {
      perspectiveId: perspective.viewId,
      reductionMethod: perspectiveArtifact?.chosenReductionMethod ?? "unknown",
      clusterCount:
        perspectiveArtifact?.chosenClusterCount === undefined
          ? String(clusterArtifact?.effectiveClusterCount ?? clusterArtifact?.clusters?.length ?? "unknown")
          : String(perspectiveArtifact.chosenClusterCount),
      mergeStrategy: analysisRun.manifest.input?.mergeStrategy ?? "unknown",
      highlightedCount: String(perspective.clusters.length),
      themeCount: String(perspective.themes?.length ?? 0)
    };
  });
  const perspectiveGroupId = `perspectives-${escapeHtmlAttribute(runId)}`;

  return renderPage(
    data,
    "Report",
    `<main class="shell">
      ${renderHeader(data, "Report")}
      <section class="panel report-hero">
        <p class="eyebrow"><a href="/pipeline/report">Back to Create Report</a></p>
        <h2>${escapeHtml(report.projectName)}</h2>
        <p class="lede">${escapeHtml(primaryPerspective?.title ?? report.primaryViewId)}</p>
        <p class="meta">Report ${escapeHtml(runId)} · analysis run ${escapeHtml(report.analysisRunId)} · generated ${escapeHtml(report.createdAt)}</p>
      </section>
      ${
        report.review === undefined
          ? ""
          : `<section class="panel">
              <article class="card feature-card">
                <p class="eyebrow">Review Boundary</p>
                <h2>What evidence this report included</h2>
                <p class="meta">This report reflects the review config that shaped the analysis run. Excluded content still exists in the project; it was just outside the inclusion boundary for this report.</p>
                ${renderKeyValueList([
                  [
                    "Included opinions",
                    `${report.review.includedOpinions} of ${report.review.totalOpinionsAvailable}`
                  ],
                  ["Excluded opinions", String(report.review.excludedOpinions)],
                  [
                    "Included comment statuses",
                    report.review.includeCommentStatuses.join(", ") || "none"
                  ],
                  [
                    "Included opinion statuses",
                    report.review.includeOpinionStatuses.join(", ") || "none"
                  ],
                  [
                    "Review config",
                    toPortableRelativePath(data.projectRoot, report.review.configPath)
                  ]
                ])}
                <div class="stack">
                  <p class="section-label">Excluded by status</p>
                  <div class="meta-chip-row">
                    ${Object.entries(report.review.excludedByStatus)
                      .filter(([, count]) => count > 0)
                      .map(
                        ([status, count]) =>
                          `${renderReviewStatusBadge(status as ReviewStatus)}${renderMetaChip(String(count))}`
                      )
                      .join("") || renderMetaChip("none")}
                  </div>
                </div>
              </article>
            </section>`
      }
      ${voteSummary === null ? "" : renderVoteSummarySection(voteSummary)}
      <section class="panel">
        <article class="card feature-card">
          <p class="eyebrow">Perspectives</p>
          <h2>Analysis views</h2>
          <p class="meta">Switch between the different readings produced from the same opinion set. Each view keeps the same source evidence, but may use a different cluster configuration or emphasis.</p>
          <div class="perspective-switcher" data-perspective-group="${perspectiveGroupId}">
            ${report.views
              .map((perspective) => {
                const config = perspectiveConfigs.find(
                  (item) => item.perspectiveId === perspective.viewId
                );
                const isPrimary = perspective.viewId === report.primaryViewId;

                return `<button type="button" class="perspective-switcher-tab ${isPrimary ? "active" : ""}" data-perspective-target="perspective-${escapeHtmlAttribute(
                  perspective.viewId
                )}">
                    <span class="perspective-switcher-title">${escapeHtml(perspective.title)}</span>
                    <span class="perspective-switcher-meta">${escapeHtml(
                      config === undefined ? "configuration unavailable" : buildPerspectiveFullSummary(config)
                    )}</span>
                  </button>`;
              })
              .join("")}
          </div>
        </article>
      </section>
      ${report.views
        .map(
          (perspective) => {
            const perspectiveArtifact = perspectiveArtifactByMode.get(perspective.viewId);
            const clusterArtifact =
              perspectiveArtifact?.chosenClusterArtifactPath === undefined
                ? undefined
                : clusterArtifactByPath.get(perspectiveArtifact.chosenClusterArtifactPath);
            const highlightedClusterIds = perspective.clusters.map((cluster) => cluster.clusterId);
            const tabGroupId = `tabs-${escapeHtmlAttribute(perspective.viewId)}`;
            const themesTabId = `${tabGroupId}-themes`;
            const highlightedTabId = `${tabGroupId}-highlighted`;
            const allTabId = `${tabGroupId}-all`;
            const perspectiveTabId = `perspective-${escapeHtmlAttribute(perspective.viewId)}`;
            const isPrimary = perspective.viewId === report.primaryViewId;
            const config = perspectiveConfigs.find(
              (item) => item.perspectiveId === perspective.viewId
            );

            return `<section class="panel perspective-panel ${isPrimary ? "active" : ""}" id="${perspectiveTabId}" data-cluster-scope data-perspective-panel="${perspectiveTabId}">
              <div class="section-head">
                <div>
                  <p class="eyebrow">${escapeHtml(perspective.viewId)}</p>
                  <h2>${escapeHtml(perspective.title)}</h2>
                </div>
                ${
                  config === undefined
                    ? ""
                    : `<p class="meta perspective-panel-meta">${escapeHtml(
                        buildPerspectiveFullSummary(config)
                      )}</p>`
                }
              </div>
              <article class="card">
                <p class="lede">${escapeHtml(perspective.summary)}</p>
              </article>
              ${
                clusterArtifact === undefined
                  ? ""
                  : `<article class="card">
                      <div class="section-head">
                        <div>
                          <p class="eyebrow">Scatterplot</p>
                          <h3>Cluster map</h3>
                        </div>
                        <p class="meta">${escapeHtml(clusterArtifact.method ?? "map")} · ${clusterArtifact.effectiveClusterCount ?? clusterArtifact.clusters?.length ?? 0} clusters</p>
                      </div>
                      <p class="meta">This perspective highlights a subset of clusters, but the map below shows the full chosen cluster set so you can inspect what was emphasized and what was left out.</p>
                      ${renderClusterLegend(
                        clusterArtifact,
                        perspectiveArtifact?.chosenClusterArtifactPath ?? "",
                        report.analysisRunId,
                        perspective.viewId,
                        new Set(perspective.clusters.map((cluster) => cluster.clusterId))
                      )}
                      ${renderClusterScatterplot(clusterArtifact, highlightedClusterIds)}
                    </article>`
              }
              <section class="panel" data-tab-group="${tabGroupId}">
                <div class="tab-strip">
                  <button type="button" class="report-subtab active" data-tab-target="${themesTabId}">Themes</button>
                  <button type="button" class="report-subtab" data-tab-target="${highlightedTabId}">Highlighted Clusters</button>
                  <button type="button" class="report-subtab" data-tab-target="${allTabId}">All Clusters</button>
                </div>
                <div class="tab-panel active" data-tab-panel="${themesTabId}">
                  ${
                    perspective.themes === undefined || perspective.themes.length === 0
                      ? `<article class="card"><p class="meta">No higher-level themes are available for this report yet.</p></article>`
                      : `<article class="card">
                          <div class="section-head">
                            <div>
                              <p class="eyebrow">Theme Atlas</p>
                              <h3>Higher-level themes</h3>
                            </div>
                          </div>
                          <section class="theme-grid">
                            ${perspective.themes
                              .map((theme) => {
                                const relatedClusters = resolveThemeClusterReferences(
                                  theme.clusterIds,
                                  clusterArtifact
                                );

                                return `<article class="theme-card" data-theme-clusters="${theme.clusterIds
                                  .map((clusterId) => escapeHtmlAttribute(clusterId))
                                  .join(",")}">
                                    <p class="eyebrow">Theme ${escapeHtml(theme.themeId)}</p>
                                    <h4>${escapeHtml(theme.label)}</h4>
                                    <p>${escapeHtml(theme.summary)}</p>
                                    <div class="stack">
                                      <p class="section-label">Supporting clusters</p>
                                      <ul class="bullets compact-bullets">
                                        ${relatedClusters
                                          .map(
                                            (cluster) =>
                                              `<li><a href="#${clusterAnchorId(
                                                perspective.viewId,
                                                cluster.clusterId
                                              )}" data-cluster-focus="${escapeHtmlAttribute(cluster.clusterId)}" href="${clusterDetailHref(
                                                report.analysisRunId,
                                                perspectiveArtifact?.chosenClusterArtifactPath ?? "",
                                                cluster.clusterId
                                              )}">#${escapeHtml(cluster.clusterId)} ${escapeHtml(cluster.label)}</a></li>`
                                          )
                                          .join("")}
                                      </ul>
                                    </div>
                                  </article>`;
                              })
                              .join("")}
                          </section>
                        </article>`
                  }
                </div>
                <div class="tab-panel" data-tab-panel="${highlightedTabId}">
                  <section class="record-list">
                    ${perspective.clusters
                      .map((cluster, clusterIndex) => {
                        const clusterColor = clusterColorForId(cluster.clusterId);
                        return `<article class="card report-cluster-card highlighted-cluster-card" id="${clusterAnchorId(
                          perspective.viewId,
                          cluster.clusterId
                        )}" style="--cluster-accent:${clusterColor}">
                            <p class="eyebrow">Cluster ${escapeHtml(cluster.clusterId)}</p>
                            <h3><a href="${clusterDetailHref(
                              report.analysisRunId,
                              perspectiveArtifact?.chosenClusterArtifactPath ?? "",
                              cluster.clusterId
                            )}">${escapeHtml(cluster.label)}</a></h3>
                            <p>${escapeHtml(cluster.summary)}</p>
                            <div class="stack">
                              <p class="section-label">Evidence</p>
                              ${cluster.evidenceQuotes.length === 0
                                ? `<p class="meta">No evidence quotes available.</p>`
                                : cluster.evidenceQuotes
                                    .map((quote, quoteIndex) => {
                                      const opinion = opinionLookup[quote.sourceId];
                                      const dialogId = `dialog-${escapeHtmlAttribute(perspective.viewId)}-${clusterIndex}-${quoteIndex}`;
                                      return `<div class="evidence-card">
                                          <blockquote>${escapeHtml(quote.excerpt)}</blockquote>
                                          <div class="evidence-meta">
                                            ${
                                              opinion === undefined
                                                ? `<span></span>`
                                                : `<button type="button" class="text-button" data-dialog-open="${dialogId}">View source opinion</button>`
                                            }
                                          </div>
                                          ${
                                            opinion === undefined
                                              ? ""
                                              : renderOpinionDialog(dialogId, quote.sourceId, opinion, data.projectRoot)
                                          }
                                        </div>`;
                                    })
                                    .join("")}
                            </div>
                          </article>`;
                      })
                      .join("")}
                  </section>
                </div>
                <div class="tab-panel" data-tab-panel="${allTabId}">
                  ${
                    clusterArtifact === undefined
                      ? `<article class="card"><p class="meta">No cluster atlas is available for this perspective.</p></article>`
                      : renderFullClusterAtlas(
                          clusterArtifact,
                          perspective,
                          opinionLookup,
                          data.projectRoot,
                          report.analysisRunId,
                          perspectiveArtifact?.chosenClusterArtifactPath
                        )
                  }
                </div>
              </section>
            </section>`;
          }
        )
        .join("")}
    </main>`
  );
}

function buildPerspectiveFullSummary(config: {
  perspectiveId: string;
  reductionMethod: string;
  clusterCount: string;
  mergeStrategy: string;
  highlightedCount: string;
  themeCount: string;
}): string {
  return [
    config.reductionMethod,
    `k${config.clusterCount}`,
    `${config.mergeStrategy} merge`,
    `${config.highlightedCount} highlighted clusters`,
    `${config.themeCount} themes`
  ].join(" · ");
}

function renderClusterScatterplot(
  artifact: AnalysisClusterArtifact,
  highlightedClusterIds: string[]
): string {
  const members = artifact.members ?? [];

  if (members.length === 0) {
    return `<p class="meta">No plotted cluster members are available.</p>`;
  }

  const width = 760;
  const height = 380;
  const padding = 28;
  const xValues = members.map((member) => member.x ?? 0);
  const yValues = members.map((member) => member.y ?? 0);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const xSpan = maxX - minX || 1;
  const ySpan = maxY - minY || 1;
  const highlighted = new Set(highlightedClusterIds.map((value) => Number(value)).filter(Number.isFinite));

  const points = members
    .map((member) => {
      const clusterId = member.clusterId ?? 0;
      const color = clusterColorForId(String(clusterId));
      const x = padding + (((member.x ?? 0) - minX) / xSpan) * (width - padding * 2);
      const y = height - padding - (((member.y ?? 0) - minY) / ySpan) * (height - padding * 2);
      const isHighlighted = highlighted.size === 0 || highlighted.has(clusterId);

      return `<circle class="plot-point${isHighlighted ? " is-focused" : ""}" data-cluster-id="${escapeHtmlAttribute(String(clusterId))}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${isHighlighted ? "5.4" : "3.2"}" fill="${color}" fill-opacity="${isHighlighted ? "0.88" : "0.22"}" stroke="${isHighlighted ? "rgba(8,38,64,0.45)" : "rgba(8,38,64,0.10)"}" stroke-width="${isHighlighted ? "1.1" : "0.6"}">
          <title>Cluster ${escapeHtml(String(clusterId))} · opinion ${escapeHtml(member.opinionId ?? "")}</title>
        </circle>`;
    })
    .join("");

  return `<div class="plot-shell">
      <svg class="plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="Scatterplot of clustered opinions">
        <rect x="0" y="0" width="${width}" height="${height}" fill="url(#plot-bg)" />
        <defs>
          <linearGradient id="plot-bg" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#fdfefe" />
            <stop offset="100%" stop-color="#f2f7fb" />
          </linearGradient>
        </defs>
        ${points}
      </svg>
    </div>`;
}

function renderClusterLegend(
  clusterArtifact: AnalysisClusterArtifact,
  clusterArtifactPath: string,
  runId: string,
  perspectiveId: string,
  highlightedClusterIds: Set<string>
): string {
  if ((clusterArtifact.clusters?.length ?? 0) === 0) {
    return "";
  }

  return `<div class="cluster-legend">
      ${(clusterArtifact.clusters ?? [])
        .map(
          (cluster) => `<a class="cluster-chip" data-cluster-focus="${escapeHtmlAttribute(String(cluster.clusterId ?? "unknown"))}" href="${clusterDetailHref(
            runId,
            clusterArtifactPath,
            String(cluster.clusterId ?? "unknown")
          )}" style="--cluster-accent:${clusterColorForId(String(cluster.clusterId ?? "unknown"))}">
              <span class="cluster-chip-swatch"></span>
              <span>#${escapeHtml(String(cluster.clusterId ?? "unknown"))} ${escapeHtml(cluster.label ?? "Cluster")}</span>
              ${
                highlightedClusterIds.has(String(cluster.clusterId ?? "unknown"))
                  ? `<span class="cluster-chip-flag">highlighted</span>`
                  : ""
              }
            </a>`
        )
        .join("")}
    </div>`;
}

function renderFullClusterAtlas(
  clusterArtifact: AnalysisClusterArtifact,
  perspective: ReportBundle["views"][number],
  opinionLookup: Record<string, LoadedOpinionArtifact>,
  projectRoot: string,
  runId?: string,
  clusterArtifactPath?: string
): string {
  const highlightedClusterIds = new Set(
    perspective.clusters.map((cluster) => cluster.clusterId)
  );

  return `<section class="panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Cluster Atlas</p>
          <h3>All clusters in the chosen map</h3>
        </div>
        <p class="meta">${escapeHtml(
          `${clusterArtifact.clusters?.length ?? 0} total clusters · ${highlightedClusterIds.size} highlighted in this perspective`
        )}</p>
      </div>
      <section class="record-list">
        ${(clusterArtifact.clusters ?? [])
          .map((cluster, clusterIndex) => {
            const clusterId = String(cluster.clusterId ?? "unknown");
            const clusterColor = clusterColorForId(clusterId);
            const isHighlighted = highlightedClusterIds.has(clusterId);

            return `<article class="card report-cluster-card ${isHighlighted ? "highlighted-cluster-card" : "secondary-cluster-card"}" id="${clusterAnchorId(
              perspective.viewId,
              clusterId
            )}" style="--cluster-accent:${clusterColor}">
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Cluster ${escapeHtml(clusterId)}</p>
                    <h3>${
                      runId === undefined || clusterArtifactPath === undefined
                        ? escapeHtml(cluster.label ?? "Cluster")
                        : `<a href="${clusterDetailHref(
                            runId,
                            clusterArtifactPath,
                            clusterId
                          )}">${escapeHtml(cluster.label ?? "Cluster")}</a>`
                    }</h3>
                  </div>
                  <p class="meta">${isHighlighted ? "Highlighted in this perspective" : "Not highlighted in this perspective"} · ${escapeHtml(String(cluster.size ?? 0))} opinions</p>
                </div>
                <p>${escapeHtml(cluster.summary ?? "")}</p>
                ${
                  (cluster.topTerms?.length ?? 0) === 0
                    ? ""
                    : `<p class="meta">Top terms: ${escapeHtml((cluster.topTerms ?? []).join(", "))}</p>`
                }
                <div class="stack">
                  <p class="section-label">Representative opinions</p>
                  ${(cluster.representativeOpinions ?? [])
                    .slice(0, 3)
                    .map((opinion, opinionIndex) => {
                      const loadedOpinion =
                        opinion.opinionId === undefined
                          ? undefined
                          : opinionLookup[opinion.opinionId];
                      const dialogId = `atlas-dialog-${escapeHtmlAttribute(perspective.viewId)}-${clusterIndex}-${opinionIndex}`;

                      return `<div class="evidence-card">
                          <blockquote>${escapeHtml(opinion.excerpt ?? opinion.opinionText ?? "")}</blockquote>
                          <div class="evidence-meta">
                            ${
                              loadedOpinion === undefined || opinion.opinionId === undefined
                                ? `<span></span>`
                                : `<button type="button" class="text-button" data-dialog-open="${dialogId}">View source opinion</button>`
                            }
                          </div>
                          ${
                            loadedOpinion === undefined || opinion.opinionId === undefined
                              ? ""
                              : renderOpinionDialog(
                                  dialogId,
                                  opinion.opinionId,
                                  loadedOpinion,
                                  projectRoot
                                )
                          }
                        </div>`;
                    })
                    .join("")}
                </div>
              </article>`;
          })
          .join("")}
      </section>
    </section>`;
}

function resolveThemeClusterReferences(
  clusterIds: string[],
  clusterArtifact: AnalysisClusterArtifact | undefined
): ThemeClusterReference[] {
  const clusterById = new Map(
    (clusterArtifact?.clusters ?? []).map((cluster) => [
      String(cluster.clusterId ?? "unknown"),
      cluster.label ?? "Cluster"
    ] as const)
  );

  return clusterIds.map((clusterId) => ({
    clusterId,
    label: clusterById.get(clusterId) ?? "Cluster"
  }));
}

function renderOpinionDialog(
  dialogId: string,
  sourceOpinionId: string,
  opinion: LoadedOpinionArtifact,
  projectRoot: string
): string {
  return `<dialog class="opinion-dialog" id="${escapeHtmlAttribute(dialogId)}">
      <form method="dialog" class="dialog-shell">
        <div class="dialog-head">
          <div>
            <p class="eyebrow">Source opinion</p>
            <h3>Opinion provenance</h3>
          </div>
          <button type="submit" class="dialog-close" aria-label="Close">×</button>
        </div>
        <div class="stack">
          <p class="section-label">Opinion text</p>
          <p>${escapeHtml(opinion.opinionText ?? "(missing)")}</p>
        </div>
        ${
          opinion.excerpt === undefined
            ? ""
            : `<div class="stack">
                <p class="section-label">Excerpt</p>
                <blockquote>${escapeHtml(opinion.excerpt)}</blockquote>
              </div>`
        }
        ${
          opinion.fullComment === undefined
            ? ""
            : `<div class="stack">
                <p class="section-label">Full comment</p>
                <pre>${escapeHtml(opinion.fullComment)}</pre>
              </div>`
        }
        <div class="stack">
          ${renderKeyValueList([
            ["Opinion ID", sourceOpinionId],
            ["Source ID", opinion.sourceId ?? "unknown"],
            ["Source row", opinion.provenance?.sourceRowNumber === undefined ? "unknown" : String(opinion.provenance.sourceRowNumber)],
            ["External ID", opinion.provenance?.externalId ?? "not set"],
            [
              "Normalized record",
              opinion.provenance?.normalizedRecordPath === undefined
                ? "not set"
                : toPortableRelativePath(projectRoot, opinion.provenance.normalizedRecordPath)
            ]
          ])}
        </div>
      </form>
    </dialog>`;
}

function clusterColorForId(clusterId: string): string {
  const palette = [
    "#145688",
    "#2A8DC8",
    "#CC7418",
    "#15794F",
    "#A85E12",
    "#6E4FF6",
    "#C53F7B",
    "#008B8B",
    "#8D5E2B",
    "#51606F"
  ];
  const numeric = Number(clusterId);
  const index = Number.isFinite(numeric) ? Math.abs(numeric) % palette.length : 0;
  return palette[index] ?? palette[0] ?? "#145688";
}

function clusterAnchorId(perspectiveId: string, clusterId: string): string {
  return `cluster-${escapeHtmlAttribute(perspectiveId)}-${escapeHtmlAttribute(clusterId)}`;
}

function clusterDetailHref(runId: string, clusterArtifactPath: string, clusterId: string): string {
  const artifactName = path.basename(clusterArtifactPath);
  return `/analysis-runs/${encodeURIComponent(runId)}/clusters/${encodeURIComponent(artifactName)}/${encodeURIComponent(clusterId)}`;
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function loadClusterDetail(
  run: LoadedAnalysisRun,
  clusterArtifactName: string,
  clusterId: string
): LoadedClusterDetail {
  const clusterArtifactEntry = run.clusters.find(
    ({ path: artifactPath }) => path.basename(artifactPath) === clusterArtifactName
  );

  if (clusterArtifactEntry === undefined) {
    throw new Error(`Cluster artifact '${clusterArtifactName}' was not found in this analysis run.`);
  }

  const numericClusterId = Number.parseInt(clusterId, 10);
  const cluster = (clusterArtifactEntry.artifact.clusters ?? []).find(
    (item) => item.clusterId === numericClusterId
  );

  if (cluster === undefined) {
    throw new Error(`Cluster '${clusterId}' was not found in artifact '${clusterArtifactName}'.`);
  }

  const members = (clusterArtifactEntry.artifact.members ?? []).filter(
    (member): member is { opinionId: string; clusterId: number; x: number; y: number } =>
      typeof member.opinionId === "string" &&
      typeof member.clusterId === "number" &&
      typeof member.x === "number" &&
      typeof member.y === "number" &&
      member.clusterId === numericClusterId
  );

  return {
    artifactPath: clusterArtifactEntry.path,
    artifact: clusterArtifactEntry.artifact,
    cluster,
    members
  };
}

function renderRunPage(
  data: ProjectDashboardData,
  runId: string,
  run: {
    manifest: unknown;
    records: unknown[];
  }
): string {
  const manifest = run.manifest as {
    createdAt?: string;
    model?: { name?: string; provider?: string; region?: string; modelId?: string };
    prompt?: { path?: string; sha256?: string };
    output?: { opinionsWritten?: number; failedRecords?: number };
  };

  return renderPage(
    data,
    "Opinion Run",
    `<main class="shell">
      ${renderHeader(data, "Opinion Run")}
      <section class="panel">
        <p class="eyebrow"><a href="/pipeline/opinions">Back to Extract Opinions</a></p>
        <h2>${escapeHtml(runId)}</h2>
        <p class="lede">${escapeHtml(
          `${manifest.model?.name ?? "unknown"} · ${manifest.model?.provider ?? "unknown"} · ${manifest.model?.region ?? "unknown"} · ${manifest.model?.modelId ?? "unknown"}`
        )}</p>
        <p class="meta">${escapeHtml(manifest.createdAt ?? "")} · ${manifest.output?.opinionsWritten ?? 0} opinions · ${manifest.output?.failedRecords ?? 0} failures</p>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Transparency</p>
            <h2>Run inputs</h2>
          </div>
        </div>
        <article class="card">
          ${renderKeyValueList([
            [
              "Prompt file",
              manifest.prompt?.path === undefined
                ? "unknown"
                : toPortableRelativePath(data.projectRoot, manifest.prompt.path)
            ],
            ["Prompt SHA-256", manifest.prompt?.sha256 ?? "unknown"]
          ])}
        </article>
      </section>
      <section class="record-list">
        ${run.records
          .map((record, index) => renderRecordCard(record, index + 1, data.projectRoot))
          .join("")}
      </section>
    </main>`
  );
}

function renderAnalysisRunPage(
  data: ProjectDashboardData,
  runId: string,
  run: LoadedAnalysisRun
): string {
  const manifest = run.manifest;
  const extractionModelLabel =
    manifest.input?.extractionModel === undefined
      ? "unknown"
      : `${manifest.input.extractionModel.name ?? "unknown"} (${manifest.input.extractionModel.provider ?? "unknown"} · ${manifest.input.extractionModel.region ?? "unknown"} · ${manifest.input.extractionModel.modelId ?? "unknown"})`;
  const embeddingModelLabel =
    manifest.input?.embeddingModel === undefined
      ? "unknown"
      : `${manifest.input.embeddingModel.name ?? "unknown"} (${manifest.input.embeddingModel.provider ?? "unknown"} · ${manifest.input.embeddingModel.region ?? "unknown"} · ${manifest.input.embeddingModel.modelId ?? "unknown"})`;
  const analysisModelLabel =
    manifest.input?.analysisModel === undefined
      ? "unknown"
      : `${manifest.input.analysisModel.name ?? "unknown"} (${manifest.input.analysisModel.provider ?? "unknown"} · ${manifest.input.analysisModel.region ?? "unknown"} · ${manifest.input.analysisModel.modelId ?? "unknown"})`;

  return renderPage(
    data,
    "Analysis Run",
    `<main class="shell">
      ${renderHeader(data, "Analysis Run")}
      <section class="panel">
        <p class="eyebrow"><a href="/pipeline/analysis">Back to Perform Analysis</a></p>
        <h2>${escapeHtml(runId)}</h2>
        <p class="lede">${escapeHtml(manifest.status ?? "unknown")} · ${escapeHtml(manifest.createdAt ?? "")}</p>
      </section>
      <section class="panel two-up">
        <article class="card">
          <p class="eyebrow">Inputs</p>
          <h2>Run configuration</h2>
          ${renderKeyValueList([
            ["Opinion run", manifest.input?.opinionRunId ?? "unknown"],
            ["Opinions selected", String(manifest.input?.opinionsSelected ?? 0)],
            ["Extraction model", extractionModelLabel],
            ["Embedding model", embeddingModelLabel],
            ["Analysis model", analysisModelLabel],
            ["Merge strategy", manifest.input?.mergeStrategy ?? "unknown"],
            ["Reduction methods", (manifest.input?.reductionMethods ?? []).join(", ") || "none"],
            ["Cluster counts", (manifest.input?.clusterCounts ?? []).join(", ") || "none"],
            ["Synthesis modes", (manifest.input?.synthesisModes ?? []).join(", ") || "none"]
          ])}
        </article>
        <article class="card">
          <p class="eyebrow">Outputs</p>
          <h2>Run results</h2>
          ${renderKeyValueList([
            ["Embeddings ready", String(manifest.output?.embeddingsReady ?? 0)],
            ["Generated now", String(manifest.output?.embeddingsGenerated ?? 0)],
            ["Reused", String(manifest.output?.embeddingsReused ?? 0)],
            ["Failed opinions", String(manifest.output?.failedOpinions ?? 0)],
            ["Cluster artifacts", String(manifest.output?.clusterArtifactsWritten ?? 0)],
            ["Perspective artifacts", String(manifest.output?.perspectiveArtifactsWritten ?? 0)]
          ])}
        </article>
      </section>
      ${renderAnalysisDiagnosticsSummarySection(runId, run)}
      <section class="panel">
        <article class="card">
          <p class="eyebrow">Transparency</p>
          <h2>Analysis prompts</h2>
          ${renderKeyValueList([
            [
              "Cluster labeling prompt",
              manifest.input?.prompts?.clusterLabeling?.path === undefined
                ? "unknown"
                : toPortableRelativePath(data.projectRoot, manifest.input.prompts.clusterLabeling.path)
            ],
            [
              "Cluster labeling prompt SHA-256",
              manifest.input?.prompts?.clusterLabeling?.sha256 ?? "unknown"
            ],
            [
              "Perspective summary prompt",
              manifest.input?.prompts?.perspectiveSummary?.path === undefined
                ? "unknown"
                : toPortableRelativePath(data.projectRoot, manifest.input.prompts.perspectiveSummary.path)
            ],
            [
              "Perspective summary prompt SHA-256",
              manifest.input?.prompts?.perspectiveSummary?.sha256 ?? "unknown"
            ]
          ])}
        </article>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Perspectives</p>
            <h2>Current synthesized readings</h2>
          </div>
        </div>
        ${run.perspectives.length === 0
          ? `<article class="card"><p>No perspective artifacts are available yet.</p></article>`
          : `<section class="grid">
              ${run.perspectives
                .map(({ path: artifactPath, artifact }) => renderPerspectiveCard(artifact, artifactPath, data.projectRoot))
                .join("")}
            </section>`}
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Reductions</p>
            <h2>Map projections</h2>
          </div>
        </div>
        ${run.reductions.length === 0
          ? `<article class="card"><p>No reduction artifacts are available yet.</p></article>`
          : `<section class="record-list">
              ${run.reductions
                .map(({ path: artifactPath, artifact }) => renderReductionCard(artifact, artifactPath, data.projectRoot))
                .join("")}
            </section>`}
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Clusters</p>
            <h2>Cluster sets and labels</h2>
          </div>
        </div>
        ${run.clusters.length === 0
          ? `<article class="card"><p>No cluster artifacts are available yet.</p></article>`
          : `<section class="record-list">
              ${run.clusters
                .map(({ path: artifactPath, artifact }) =>
                  renderClusterCard(artifact, artifactPath, data.projectRoot, runId)
                )
                .join("")}
            </section>`}
      </section>
    </main>`
  );
}

function renderAnalysisDiagnosticsSummarySection(
  runId: string,
  run: LoadedAnalysisRun
): string {
  const reducer = run.reducerEvaluation;
  const clustering = run.clusteringSurfaceEvaluation;
  const hasDiagnostics = reducer !== null || clustering !== null;

  return `<section class="panel">
    <article class="card">
      <div class="section-head">
        <div>
          <p class="eyebrow">Diagnostics</p>
          <h2>Reducer and clustering surface checks</h2>
        </div>
        <a class="button-link button-link-secondary button-link-small" href="/analysis-runs/${encodeURIComponent(runId)}/diagnostics">Open diagnostics</a>
      </div>
      ${
        hasDiagnostics
          ? `<div class="meta-chip-row">
              ${renderMetaChip(`Reducer ${escapeHtml(reducer?.method ?? "missing")}`)}
              ${renderMetaChip(`Clustering ${escapeHtml(clustering?.method ?? "missing")}`)}
              ${renderMetaChip(`${escapeHtml(String(reducer?.corpus?.comparableOpinionCount ?? clustering?.corpus?.comparableOpinionCount ?? 0))} comparable opinions`)}
            </div>
            ${renderDiagnosticObservationPreview(reducer, clustering)}`
          : `<p class="meta">No reducer or clustering-surface diagnostics exist for this run yet. Generate them from the CLI, then reload this page.</p>
            <pre>node packages/cli/dist/index.js analysis --evaluate-reducers --run ${escapeHtml(runId)}
node packages/cli/dist/index.js analysis --evaluate-clustering-surfaces --run ${escapeHtml(runId)}</pre>`
      }
    </article>
  </section>`;
}

function renderDiagnosticObservationPreview(
  reducer: AnalysisReducerEvaluationArtifact | null,
  clustering: AnalysisClusteringSurfaceEvaluationArtifact | null
): string {
  const observations = [
    ...(reducer?.observations ?? []),
    ...(clustering?.observations ?? [])
  ].slice(0, 4);

  return observations.length === 0
    ? ""
    : `<div class="stack"><p class="section-label">Current read</p>${renderBulletList(observations)}</div>`;
}

function renderAnalysisDiagnosticsPage(
  data: ProjectDashboardData,
  runId: string,
  run: LoadedAnalysisRun
): string {
  const reducer = run.reducerEvaluation;
  const clustering = run.clusteringSurfaceEvaluation;

  return renderPage(
    data,
    "Analysis Diagnostics",
    `<main class="shell">
      ${renderHeader(data, "Analysis Diagnostics")}
      <section class="panel">
        <p class="eyebrow"><a href="/analysis-runs/${encodeURIComponent(runId)}">Back to Analysis Run</a></p>
        <h2>Reducer and clustering diagnostics</h2>
        <p class="lede">${escapeHtml(runId)}</p>
        <p class="meta">These checks reuse existing embeddings, reductions, and cluster artifacts. They do not make model calls.</p>
      </section>
      <section class="panel two-up">
        ${renderReducerDiagnosticOverviewCard(reducer)}
        ${renderClusteringSurfaceDiagnosticOverviewCard(clustering)}
      </section>
      ${renderReducerDiagnosticSection(reducer)}
      ${renderClusteringSurfaceDiagnosticSection(clustering)}
      ${renderClusteringComparisonSection(clustering)}
    </main>`
  );
}

function renderReducerDiagnosticOverviewCard(
  reducer: AnalysisReducerEvaluationArtifact | null
): string {
  if (reducer === null) {
    return `<article class="card">
      <p class="eyebrow">Reducer Evaluation</p>
      <h2>Not generated</h2>
      <p class="meta">Run <code>broadly analysis --evaluate-reducers</code> for this analysis run.</p>
    </article>`;
  }

  const bestReduction = [...(reducer.reductions ?? [])]
    .filter((item) => item.neighborRecallAtK?.mean !== null && item.neighborRecallAtK?.mean !== undefined)
    .sort(
      (left, right) =>
        (right.neighborRecallAtK?.mean ?? -1) - (left.neighborRecallAtK?.mean ?? -1)
    )[0];

  return `<article class="card">
    <p class="eyebrow">Reducer Evaluation</p>
    <h2>${escapeHtml(bestReduction?.method ?? "No ready reducers")}</h2>
    ${renderKeyValueList([
      ["Created", reducer.createdAt ?? "unknown"],
      ["Comparable opinions", String(reducer.corpus?.comparableOpinionCount ?? 0)],
      ["Ready reductions", `${reducer.corpus?.readyReductionCount ?? 0} of ${reducer.corpus?.reductionCount ?? 0}`],
      ["Best recall@k", formatDiagnosticMetric(bestReduction?.neighborRecallAtK?.mean ?? null)]
    ])}
    ${renderDiagnosticObservationPreview(reducer, null)}
  </article>`;
}

function renderClusteringSurfaceDiagnosticOverviewCard(
  clustering: AnalysisClusteringSurfaceEvaluationArtifact | null
): string {
  if (clustering === null) {
    return `<article class="card">
      <p class="eyebrow">Clustering Surfaces</p>
      <h2>Not generated</h2>
      <p class="meta">Run <code>broadly analysis --evaluate-clustering-surfaces</code> for this analysis run.</p>
    </article>`;
  }

  const bestSurface = [...(clustering.surfaces ?? [])]
    .filter((item) => item.embeddingNeighborPurityAtK !== null && item.embeddingNeighborPurityAtK !== undefined)
    .sort(
      (left, right) =>
        (right.embeddingNeighborPurityAtK ?? -1) - (left.embeddingNeighborPurityAtK ?? -1)
    )[0];

  return `<article class="card">
    <p class="eyebrow">Clustering Surfaces</p>
    <h2>${escapeHtml(bestSurface?.label ?? "No ready surfaces")}</h2>
    ${renderKeyValueList([
      ["Created", clustering.createdAt ?? "unknown"],
      ["Comparable opinions", String(clustering.corpus?.comparableOpinionCount ?? 0)],
      ["Surfaces", `${clustering.corpus?.embeddingSurfaceCount ?? 0} embedding · ${clustering.corpus?.projectionSurfaceCount ?? 0} projection`],
      ["Best purity", formatDiagnosticMetric(bestSurface?.embeddingNeighborPurityAtK ?? null)]
    ])}
    ${renderDiagnosticObservationPreview(null, clustering)}
  </article>`;
}

function renderReducerDiagnosticSection(
  reducer: AnalysisReducerEvaluationArtifact | null
): string {
  if (reducer === null) {
    return "";
  }

  return `<section class="panel">
    <div class="section-head">
      <div>
        <p class="eyebrow">Reducers</p>
        <h2>Local-neighbor preservation</h2>
      </div>
    </div>
    <section class="grid">
      ${(reducer.reductions ?? [])
        .map(
          (reduction) => `<article class="card">
            <p class="eyebrow">${escapeHtml(reduction.method ?? "unknown")}</p>
            <h3>Recall@${escapeHtml(String(reduction.neighborRecallAtK?.k ?? "?"))}: ${escapeHtml(formatDiagnosticMetric(reduction.neighborRecallAtK?.mean ?? null))}</h3>
            ${renderKeyValueList([
              ["Status", reduction.status ?? "unknown"],
              ["Points", String(reduction.pointCount ?? 0)],
              ["Comparable opinions", String(reduction.comparableOpinionCount ?? 0)],
              ["Median recall", formatDiagnosticMetric(reduction.neighborRecallAtK?.median ?? null)],
              ["Duplicate coordinates", formatDiagnosticRatio(reduction.projection?.duplicateCoordinateRate ?? null)],
              ["Outlier rate", formatDiagnosticRatio(reduction.projection?.outlierRate ?? null)],
              ["Projected area", formatDiagnosticMetric(reduction.projection?.area ?? null)]
            ])}
          </article>`
        )
        .join("")}
    </section>
  </section>`;
}

function renderClusteringSurfaceDiagnosticSection(
  clustering: AnalysisClusteringSurfaceEvaluationArtifact | null
): string {
  if (clustering === null) {
    return "";
  }

  return `<section class="panel">
    <div class="section-head">
      <div>
        <p class="eyebrow">Clustering Surfaces</p>
        <h2>Embedding-space quality by surface</h2>
      </div>
    </div>
    <section class="grid">
      ${(clustering.surfaces ?? [])
        .map(
          (surface) => `<article class="card">
            <p class="eyebrow">${escapeHtml(surface.surfaceKind ?? "surface")}</p>
            <h3>${escapeHtml(surface.label ?? surface.surfaceId ?? "unknown")}</h3>
            <div class="meta-chip-row">
              ${renderMetaChip(`k=${escapeHtml(String(surface.effectiveClusterCount ?? "?"))}`)}
              ${renderMetaChip(escapeHtml(surface.method ?? "unknown"))}
              ${renderMetaChip(escapeHtml(surface.status ?? "unknown"))}
            </div>
            ${renderKeyValueList([
              ["Embedding-neighbor purity", formatDiagnosticMetric(surface.embeddingNeighborPurityAtK ?? null)],
              ["Embedding silhouette", formatDiagnosticMetric(surface.embeddingSilhouette ?? null)],
              ["Largest cluster share", formatDiagnosticRatio(surface.largestClusterShare ?? null)],
              ["Singleton clusters", String(surface.singletonClusterCount ?? 0)],
              ["Comparable opinions", String(surface.comparableOpinionCount ?? 0)]
            ])}
          </article>`
        )
        .join("")}
    </section>
  </section>`;
}

function renderClusteringComparisonSection(
  clustering: AnalysisClusteringSurfaceEvaluationArtifact | null
): string {
  if (clustering === null) {
    return "";
  }

  const comparisons = clustering.comparisons ?? [];

  return `<section class="panel">
    <div class="section-head">
      <div>
        <p class="eyebrow">Surface Agreement</p>
        <h2>Membership shifts between clusterings</h2>
      </div>
    </div>
    ${
      comparisons.length === 0
        ? `<article class="card"><p>No surface comparisons were available.</p></article>`
        : `<section class="record-list">
            ${comparisons
              .slice(0, 12)
              .map(
                (comparison) => `<article class="card">
                  <div class="section-head">
                    <div>
                      <p class="eyebrow">Adjusted Rand ${escapeHtml(formatDiagnosticMetric(comparison.adjustedRandIndex ?? null))}</p>
                      <h3>${escapeHtml(comparison.leftLabel ?? comparison.leftSurfaceId ?? "left")} vs ${escapeHtml(comparison.rightLabel ?? comparison.rightSurfaceId ?? "right")}</h3>
                    </div>
                    ${renderMetaChip(`${escapeHtml(String(comparison.comparableOpinionCount ?? 0))} opinions`)}
                  </div>
                  ${renderMembershipShiftList(comparison.largestMembershipShifts ?? [])}
                </article>`
              )
              .join("")}
          </section>`
    }
  </section>`;
}

function renderMembershipShiftList(
  shifts: NonNullable<AnalysisClusteringSurfaceEvaluationArtifact["comparisons"]>[number]["largestMembershipShifts"]
): string {
  if (shifts === undefined || shifts.length === 0) {
    return `<p class="meta">No membership shift detail was available.</p>`;
  }

  return `<div class="stack">
    <p class="section-label">Largest source-cluster splits</p>
    <ul class="bullets compact-bullets">
      ${shifts
        .slice(0, 3)
        .map((shift) => {
          const destinations = (shift.topDestinationClusters ?? [])
            .map(
              (destination) =>
                `${escapeHtml(String(destination.clusterId ?? "?"))}: ${escapeHtml(formatDiagnosticRatio(destination.share ?? null))}`
            )
            .join(", ");

          return `<li>Cluster ${escapeHtml(String(shift.sourceClusterId ?? "?"))} (${escapeHtml(String(shift.sourceClusterSize ?? 0))} opinions) fragmented ${escapeHtml(formatDiagnosticRatio(shift.fragmentationRate ?? null))}; destinations ${destinations}</li>`;
        })
        .join("")}
    </ul>
  </div>`;
}

function formatDiagnosticMetric(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function formatDiagnosticRatio(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "n/a";
}

function renderClusterDetailPage(
  data: ProjectDashboardData,
  runId: string,
  clusterArtifactName: string,
  detail: LoadedClusterDetail,
  opinionLookup: Record<string, LoadedOpinionArtifact>
): string {
  const clusterId = String(detail.cluster.clusterId ?? "unknown");
  const linkedOpinions = detail.members.map((member) => ({
    member,
    opinion: opinionLookup[member.opinionId]
  }));

  return renderPage(
    data,
    "Cluster Detail",
    `<main class="shell">
      ${renderHeader(data, "Cluster Detail")}
      <section class="panel">
        <p class="eyebrow"><a href="/analysis-runs/${encodeURIComponent(runId)}">Back to Analysis Run</a></p>
        <h2>${escapeHtml(detail.cluster.label ?? `Cluster ${clusterId}`)}</h2>
        <p class="lede">Cluster ${escapeHtml(clusterId)} from ${escapeHtml(clusterArtifactName)}</p>
        <p class="meta">${escapeHtml(String(detail.members.length))} supporting opinions</p>
      </section>
      <section class="panel two-up">
        <article class="card">
          <p class="eyebrow">Summary</p>
          <h3>Cluster overview</h3>
          <p>${escapeHtml(detail.cluster.summary ?? "")}</p>
          ${renderKeyValueList([
            ["Cluster ID", clusterId],
            ["Supporting opinions", String(detail.members.length)],
            ["Artifact", detail.artifactPath]
          ])}
          ${
            (detail.cluster.topTerms?.length ?? 0) === 0
              ? ""
              : `<div class="stack"><p class="section-label">Top terms</p><p class="meta">${escapeHtml(
                  (detail.cluster.topTerms ?? []).join(", ")
                )}</p></div>`
          }
        </article>
        <article class="card">
          <p class="eyebrow">Map</p>
          <h3>Cluster position</h3>
          ${renderScatterPlot(undefined, detail.artifact.members?.filter(
            (member): member is { opinionId: string; clusterId: number; x: number; y: number } =>
              typeof member.opinionId === "string" &&
              typeof member.clusterId === "number" &&
              typeof member.x === "number" &&
              typeof member.y === "number"
          ))}
        </article>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Supporting Opinions</p>
            <h3>All opinions assigned to this cluster</h3>
          </div>
        </div>
        ${
          linkedOpinions.length === 0
            ? `<article class="card"><p>No supporting opinions were found for this cluster.</p></article>`
            : `<section class="record-list">
                ${linkedOpinions
                  .map(({ opinion, member }, index) => {
                    const dialogId = `cluster-detail-opinion-${index}`;
                    return `<article class="card record-card">
                        <div class="record-header">
                          <p class="eyebrow">Opinion ${index + 1}</p>
                          <h3>${escapeHtml(opinion?.opinionText ?? member.opinionId)}</h3>
                          <p class="meta">${escapeHtml(opinion?.sourceId ?? "unknown source")}</p>
                        </div>
                        ${
                          opinion?.excerpt === undefined
                            ? ""
                            : `<blockquote>${escapeHtml(opinion.excerpt)}</blockquote>`
                        }
                        ${
                          opinion === undefined
                            ? `<p class="meta">Opinion artifact unavailable.</p>`
                            : `<div class="evidence-meta">
                                <span></span>
                                <button type="button" class="text-button" data-dialog-open="${dialogId}">View source opinion</button>
                              </div>
                              ${renderOpinionDialog(dialogId, member.opinionId, opinion, data.projectRoot)}`
                        }
                      </article>`;
                  })
                  .join("")}
              </section>`
        }
      </section>
    </main>`
  );
}

function renderHeader(data: ProjectDashboardData, activePage: string): string {
  const navItems: Array<{ href: string; label: string; key: string }> = [
    { href: "/", label: "Overview", key: "Overview" },
    { href: "/pipeline/ingest", label: "Ingest Comments", key: "Ingest Comments" },
    { href: "/pipeline/opinions", label: "Extract Opinions", key: "Extract Opinions" },
    { href: "/pipeline/analysis", label: "Perform Analysis", key: "Perform Analysis" },
    { href: "/pipeline/report", label: "Create Report", key: "Create Report" },
    { href: "/statements", label: "Statements", key: "Statements" },
    { href: "/admin", label: "Admin Review", key: "Admin Review" }
  ];

  return `<header class="site-header">
    <div>
      <p class="eyebrow">Broadly Web</p>
      <h1>${escapeHtml(data.config.project.name)}</h1>
      <p class="lede">${escapeHtml(activePage)}</p>
    </div>
    <nav class="tab-nav">
      ${navItems
        .map(
          (item) => `<a class="tab ${item.key === activePage ? "active" : ""}" href="${item.href}">${escapeHtml(item.label)}</a>`
        )
        .join("")}
    </nav>
  </header>`;
}

function renderRecordCard(record: unknown, index: number, projectRoot: string): string {
  const parsed = record as {
    sourceId?: string;
    splitDecision?: string;
    splitRationale?: string;
    normalizedRecordPath?: string;
    response?: { rawText?: string };
    parsed?: {
      opinions?: Array<{
        opinion_text?: string;
        source_excerpt?: string;
        source_fields?: string[];
      }>;
    };
    error?: string;
    sourceRecord?: {
      contentText?: string;
      rawRow?: Record<string, string>;
      provenance?: {
        sourceRowNumber?: number;
        externalId?: string;
        importPath?: string;
      };
    };
  };

  return `<article class="card record-card">
    <div class="record-header">
      <p class="eyebrow">Record ${index}</p>
      <h3>${escapeHtml(parsed.sourceId ?? "unknown source")}</h3>
      ${
        parsed.error === undefined
          ? `<p class="meta">${escapeHtml(parsed.splitDecision ?? "unknown")} · ${escapeHtml(parsed.splitRationale ?? "")}</p>`
          : `<p class="meta error">${escapeHtml(parsed.error)}</p>`
      }
    </div>
    <div class="columns">
      <section>
        <h4>Parsed Opinions</h4>
        ${
          Array.isArray(parsed.parsed?.opinions) && parsed.parsed.opinions.length > 0
            ? parsed.parsed.opinions
                .map(
                  (opinion) => `<div class="opinion">
                      <p><strong>Opinion:</strong> ${escapeHtml(opinion.opinion_text ?? "")}</p>
                      <p><strong>Excerpt:</strong> ${escapeHtml(opinion.source_excerpt ?? "")}</p>
                      <p><strong>Fields:</strong> ${escapeHtml((opinion.source_fields ?? []).join(", "))}</p>
                    </div>`
                )
                .join("")
            : `<p>No opinions extracted.</p>`
        }
      </section>
      <section>
        <h4>Raw Model Response</h4>
        <pre>${escapeHtml(parsed.response?.rawText ?? parsed.error ?? "")}</pre>
      </section>
    </div>
    <section class="source-record">
      <h4>Raw Source Record</h4>
      <pre>${escapeHtml(renderSourceRecordText(parsed.sourceRecord, projectRoot))}</pre>
    </section>
    <p class="meta">Normalized record: ${escapeHtml(parsed.normalizedRecordPath ?? "")}</p>
  </article>`;
}

function renderPerspectiveCard(
  perspective: AnalysisPerspectiveArtifact,
  artifactPath: string,
  projectRoot: string
): string {
  const highlights = perspective.highlights ?? [];

  return `<article class="card record-card">
    <div class="record-header">
      <p class="eyebrow">${escapeHtml((perspective.mode ?? "unknown").toUpperCase())}</p>
      <h3>${escapeHtml(perspective.title ?? perspective.mode ?? "Perspective")}</h3>
      <p class="meta">${escapeHtml(perspective.status ?? "unknown")} · ${escapeHtml(perspective.synthesis?.method ?? "unknown")} · ${escapeHtml(perspective.summary ?? perspective.rationale ?? "")}</p>
    </div>
    <div class="columns">
      <section>
        <h4>Highlights</h4>
        ${
          highlights.length === 0
            ? "<p>No highlights are available.</p>"
            : highlights
                .map(
                  (highlight) => `<div class="opinion">
                      <p><strong>${escapeHtml(highlight.label ?? `Cluster ${highlight.clusterId ?? "?"}`)}</strong> · ${escapeHtml(String(highlight.size ?? 0))} opinions</p>
                      <p>${escapeHtml(highlight.summary ?? "")}</p>
                      ${
                        (highlight.representativeOpinions ?? []).length === 0
                          ? ""
                          : `<p class="meta">${escapeHtml(
                              (highlight.representativeOpinions ?? [])
                                .slice(0, 2)
                                .map((item) => truncateForUi(item.opinionText ?? "", 90))
                                .join(" | ")
                            )}</p>`
                      }
                    </div>`
                )
                .join("")
        }
      </section>
      <section>
        <h4>Selection</h4>
        ${renderKeyValueList([
          ["Reduction", perspective.chosenReductionMethod ?? "unknown"],
          ["Cluster count", String(perspective.chosenClusterCount ?? "unknown")],
          ["Stop reason", perspective.synthesis?.stopReason ?? "unknown"],
          ["Artifact", toPortableRelativePath(projectRoot, artifactPath)]
        ])}
        <p class="meta">${escapeHtml(perspective.synthesis?.error ?? perspective.rationale ?? "")}</p>
      </section>
    </div>
  </article>`;
}

function renderReductionCard(
  reduction: AnalysisReductionArtifact,
  artifactPath: string,
  projectRoot: string
): string {
  const points = (reduction.points ?? [])
    .filter(
      (point): point is { opinionId: string; x: number; y: number } =>
        typeof point.opinionId === "string" &&
        typeof point.x === "number" &&
        typeof point.y === "number"
    );

  return `<article class="card record-card">
    <div class="record-header">
      <p class="eyebrow">${escapeHtml(reduction.method ?? "unknown")}</p>
      <h3>${escapeHtml((reduction.method ?? "reduction").toUpperCase())}</h3>
      <p class="meta">${escapeHtml(reduction.status ?? "unknown")} · ${escapeHtml(String(reduction.pointCount ?? 0))} points</p>
    </div>
    ${
      reduction.status === "ready"
        ? renderScatterPlot(points, undefined)
        : `<p class="meta">${escapeHtml(reduction.message ?? "No plot available.")}</p>`
    }
    <p class="meta">Artifact ${escapeHtml(toPortableRelativePath(projectRoot, artifactPath))}</p>
  </article>`;
}

function renderClusterCard(
  clusterArtifact: AnalysisClusterArtifact,
  artifactPath: string,
  projectRoot: string,
  runId?: string
): string {
  const members = (clusterArtifact.members ?? [])
    .filter(
      (member): member is { opinionId: string; clusterId: number; x: number; y: number } =>
        typeof member.opinionId === "string" &&
        typeof member.clusterId === "number" &&
        typeof member.x === "number" &&
        typeof member.y === "number"
    );
  const clusters = (clusterArtifact.clusters ?? [])
    .filter(
      (
        cluster
      ): cluster is {
        clusterId: number;
        size: number;
        label?: string;
        summary?: string;
        representativeOpinions?: Array<{ opinionId?: string; opinionText?: string; excerpt?: string }>;
      } => typeof cluster.clusterId === "number" && typeof cluster.size === "number"
    )
    .sort((left, right) => right.size - left.size || left.clusterId - right.clusterId);

  return `<article class="card record-card">
    <div class="record-header">
      <p class="eyebrow">${escapeHtml((clusterArtifact.method ?? "unknown").toUpperCase())} · K=${escapeHtml(String(clusterArtifact.effectiveClusterCount ?? clusterArtifact.requestedClusterCount ?? "?"))}</p>
      <h3>${escapeHtml(clusterArtifact.status ?? "unknown")}</h3>
      <p class="meta">${escapeHtml(String(members.length))} assigned points · requested ${escapeHtml(String(clusterArtifact.requestedClusterCount ?? "?"))} · ${escapeHtml(clusterArtifact.labeling?.method ?? "unknown")}</p>
    </div>
    ${
      clusterArtifact.status === "ready"
        ? renderScatterPlot(undefined, members)
        : `<p class="meta">${escapeHtml(clusterArtifact.message ?? "No clustered plot available.")}</p>`
    }
    <div class="stack">
      <h4>Cluster labels</h4>
      ${
        clusters.length === 0
          ? "<p>No cluster summaries are available.</p>"
          : clusters
              .map(
                (cluster) => `<div class="opinion">
                    <p><strong>${
                      runId === undefined
                        ? escapeHtml(cluster.label ?? `Cluster ${cluster.clusterId + 1}`)
                        : `<a href="${clusterDetailHref(
                            runId,
                            artifactPath,
                            String(cluster.clusterId)
                          )}">${escapeHtml(cluster.label ?? `Cluster ${cluster.clusterId + 1}`)}</a>`
                    }</strong> · ${escapeHtml(String(cluster.size))} opinions</p>
                    <p>${escapeHtml(cluster.summary ?? "")}</p>
                    ${
                      (cluster.representativeOpinions ?? []).length === 0
                        ? ""
                        : `<p class="meta">${escapeHtml(
                            (cluster.representativeOpinions ?? [])
                              .slice(0, 2)
                              .map((item) => truncateForUi(item.opinionText ?? "", 90))
                              .join(" | ")
                          )}</p>`
                    }
                  </div>`
              )
              .join("")
      }
    </div>
    <p class="meta">Label stop reason: ${escapeHtml(clusterArtifact.labeling?.stopReason ?? "unknown")}</p>
    <p class="meta">Artifact ${escapeHtml(toPortableRelativePath(projectRoot, artifactPath))}</p>
  </article>`;
}

function renderScatterPlot(
  reductionPoints?: Array<{ opinionId: string; x: number; y: number }>,
  clusterMembers?: Array<{ opinionId: string; clusterId: number; x: number; y: number }>
): string {
  const points =
    clusterMembers?.map((member) => ({
      x: member.x,
      y: member.y,
      color: CLUSTER_COLORS[member.clusterId % CLUSTER_COLORS.length] ?? "#5D6378"
    })) ??
    reductionPoints?.map((point) => ({
      x: point.x,
      y: point.y,
      color: "#2A8DC8"
    })) ??
    [];

  if (points.length === 0) {
    return `<div class="plot-shell"><p class="meta">No plot data available.</p></div>`;
  }

  const width = 560;
  const height = 320;
  const padding = 24;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const xSpan = Math.max(maxX - minX, 1);
  const ySpan = Math.max(maxY - minY, 1);
  const circles = points
    .map((point) => {
      const x = padding + ((point.x - minX) / xSpan) * (width - padding * 2);
      const y = height - padding - ((point.y - minY) / ySpan) * (height - padding * 2);
      return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5" fill="${point.color}" fill-opacity="0.88" />`;
    })
    .join("");

  return `<div class="plot-shell">
    <svg class="plot" viewBox="0 0 ${width} ${height}" aria-label="analysis plot" role="img">
      <rect x="0" y="0" width="${width}" height="${height}" rx="18" fill="#F7F8FA" stroke="#DCDFE7" />
      ${circles}
    </svg>
  </div>`;
}

function renderNormalizedRecordPreview(
  record: NormalizedRecordPreview,
  index: number,
  projectRoot: string
): string {
  return `<article class="card record-card">
    <div class="record-header">
      <p class="eyebrow">Normalized Record ${index}</p>
      <h3>${escapeHtml(record.sourceId)}</h3>
      <p class="meta">Row ${escapeHtml(record.sourceRowNumber?.toString() ?? "unknown")} · External ID ${escapeHtml(record.externalId ?? "none")}</p>
    </div>
    ${
      record.primaryText === record.contentText
        ? ""
        : `<p class="section-label">Primary text</p><pre>${escapeHtml(record.primaryText)}</pre>`
    }
    <p class="section-label">Full normalized record</p>
    <pre>${escapeHtml(record.contentText)}</pre>
    <p class="meta">SHA-256 ${escapeHtml(record.contentSha256)}</p>
    <p class="meta">Artifact ${escapeHtml(toPortableRelativePath(projectRoot, record.normalizedRecordPath))}</p>
  </article>`;
}

function renderSourceRecordText(
  sourceRecord:
    | {
        contentText?: string;
        rawRow?: Record<string, string>;
        provenance?: {
          sourceRowNumber?: number;
          externalId?: string;
          importPath?: string;
        };
      }
    | undefined,
  projectRoot: string
): string {
  if (sourceRecord === undefined) {
    return "Source record unavailable.";
  }

  const rawRowLines =
    sourceRecord.rawRow === undefined
      ? []
      : Object.entries(sourceRecord.rawRow).map(([field, value]) => `${field}: ${value}`);
  const provenanceLines = [
    sourceRecord.provenance?.sourceRowNumber === undefined
      ? null
      : `Source Row Number: ${sourceRecord.provenance.sourceRowNumber}`,
    sourceRecord.provenance?.externalId === undefined
      ? null
      : `External ID: ${sourceRecord.provenance.externalId}`,
    sourceRecord.provenance?.importPath === undefined
      ? null
      : `Import Path: ${toPortableRelativePath(projectRoot, sourceRecord.provenance.importPath)}`
  ].filter((line): line is string => line !== null);

  return [...rawRowLines, ...(rawRowLines.length > 0 && provenanceLines.length > 0 ? [""] : []), ...provenanceLines]
    .join("\n")
    .trim() || sourceRecord.contentText || "Source record unavailable.";
}

function renderPipelineCard(step: {
  step: PipelineStep;
  title: string;
  href: string;
  status: StepStatus;
  summary: string;
  detail: string;
}): string {
  return `<a class="card link-card pipeline-card ${step.status}" href="${step.href}">
    <p class="eyebrow">${escapeHtml(stageStatusLabel(step.status))}</p>
    <h3>${escapeHtml(step.title)}</h3>
    <p>${escapeHtml(step.summary)}</p>
    <p class="meta">${escapeHtml(step.detail)}</p>
  </a>`;
}

function renderAdminKindToggle(kind: "comments" | "opinions", query: string): string {
  return ([
    { kind: "opinions", label: "Opinions" },
    { kind: "comments", label: "Comments" }
  ] as const)
    .map(
      (item) => `<a class="filter-chip ${item.kind === kind ? "active" : ""}" href="${buildAdminContentHref(item.kind, [], 0, query)}">${escapeHtml(item.label)}</a>`
    )
    .join("");
}

function renderReviewFilterLinks(
  basePath: string,
  kind: "comments" | "opinions",
  selectedStatuses: ReviewStatus[],
  query: string
): string {
  const allActive = selectedStatuses.length === REVIEW_STATUS_VALUES.length;

  return [
    `<a class="filter-chip ${allActive ? "active" : ""}" href="${buildAdminContentHref(kind, [], 0, query, basePath)}">Default view</a>`,
    ...REVIEW_STATUS_VALUES.map(
      (status) =>
        `<a class="filter-chip ${selectedStatuses.includes(status) ? "active" : ""}" href="${buildAdminContentHref(kind, [status], 0, query, basePath)}">${escapeHtml(
          status
        )}</a>`
    )
  ].join("");
}

function buildAdminContentHref(
  kind: "comments" | "opinions",
  statuses: ReviewStatus[],
  offset: number,
  query = "",
  basePath = "/admin/content"
): string {
  const params = new URLSearchParams();
  params.set("kind", kind);

  for (const status of statuses) {
    params.append("status", status);
  }

  if (query.trim().length > 0) {
    params.set("q", query.trim());
  }

  if (offset > 0) {
    params.set("offset", String(offset));
  }

  return `${basePath}?${params.toString()}`;
}

function renderAdminCommentTable(entries: AdminCommentEntry[]): string {
  if (entries.length === 0) {
    return `<article class="card"><p>No comments matched this filter.</p></article>`;
  }

  return `<div class="review-list">
    ${entries
      .map((entry) => {
        const chips = [
          renderReviewStatusBadge(entry.effectiveStatus),
          renderMetaChip(`Source ${entry.sourceId}`),
          renderMetaChip(`Row ${String(entry.record.provenance.sourceRowNumber ?? "unknown")}`),
          renderMetaChip(
            `${entry.relatedOpinionIds.length} related opinion${entry.relatedOpinionIds.length === 1 ? "" : "s"}`
          ),
          entry.record.provenance.externalId === undefined
            ? ""
            : renderMetaChip(`External ${entry.record.provenance.externalId}`),
          entry.review === null ? "" : renderMetaChip(`Reason ${entry.review.reasonCode}`),
          entry.suggestion === null
            ? ""
            : renderSuggestionChip(entry.suggestion.suggestedStatus, entry.suggestion.confidence)
        ]
          .filter((item) => item.length > 0)
          .join("");

        return `<article class="card review-card">
          <div class="review-card-head">
            <div>
              <p class="eyebrow">Comment</p>
              <h3><a href="/admin/comments/${encodeURIComponent(entry.sourceId)}">${escapeHtml(
                entry.sourceId
              )}</a></h3>
            </div>
            <div class="review-card-actions">
              <label class="select-pill">
                <input type="checkbox" name="selected" value="${escapeHtmlAttribute(entry.sourceId)}" />
                <span>Select</span>
              </label>
              <a class="button-link button-link-secondary button-link-small" href="/admin/comments/${encodeURIComponent(
                entry.sourceId
              )}">Open</a>
            </div>
          </div>
          <p class="review-snippet review-snippet-comment">${escapeHtml(
            truncateForUi(getNormalizedCommentPrimaryText(entry.record), 320)
          )}</p>
          <div class="meta-chip-row">${chips}</div>
          ${
            entry.review?.note.length
              ? `<p class="review-note">${escapeHtml(truncateForUi(entry.review.note, 220))}</p>`
              : ""
          }
          ${
            entry.suggestion?.note.length
              ? `<p class="review-note review-note-suggestion">${escapeHtml(truncateForUi(entry.suggestion.note, 220))}</p>`
              : ""
          }
        </article>`;
      })
      .join("")}
  </div>`;
}

function renderAdminOpinionTable(entries: AdminOpinionEntry[]): string {
  if (entries.length === 0) {
    return `<article class="card"><p>No opinions matched this filter.</p></article>`;
  }

  return `<div class="review-list">
    ${entries
      .map((entry) => {
        const chips = [
          renderReviewStatusBadge(entry.effectiveStatus),
          renderMetaChip(
            `Source ${
              entry.artifact.sourceId === undefined
                ? "unknown"
                : `<a href="/admin/comments/${encodeURIComponent(entry.artifact.sourceId)}">${escapeHtml(
                    entry.artifact.sourceId
                  )}</a>`
            }`
          ),
          renderMetaChip(`Review ${entry.effectiveStatusSource}`),
          renderMetaChip(`Run ${entry.runId}`),
          entry.opinionReview === null ? "" : renderMetaChip(`Reason ${entry.opinionReview.reasonCode}`),
          entry.suggestion === null
            ? ""
            : renderSuggestionChip(entry.suggestion.suggestedStatus, entry.suggestion.confidence)
        ]
          .filter((item) => item.length > 0)
          .join("");

        return `<article class="card review-card">
          <div class="review-card-head">
            <div>
              <p class="eyebrow">Opinion</p>
              <h3><a href="/admin/opinions/${encodeURIComponent(entry.opinionId)}">${escapeHtml(
                truncateForUi(entry.artifact.opinionText ?? entry.opinionId, 160)
              )}</a></h3>
            </div>
            <div class="review-card-actions">
              <label class="select-pill">
                <input type="checkbox" name="selected" value="${escapeHtmlAttribute(entry.opinionId)}" />
                <span>Select</span>
              </label>
              <a class="button-link button-link-secondary button-link-small" href="/admin/opinions/${encodeURIComponent(
                entry.opinionId
              )}">Open</a>
            </div>
          </div>
          ${
            entry.artifact.excerpt === undefined || entry.artifact.excerpt.trim().length === 0
              ? ""
              : `<p class="review-subtext">${escapeHtml(truncateForUi(entry.artifact.excerpt, 240))}</p>`
          }
          <div class="meta-chip-row">${chips}</div>
          <p class="review-snippet review-snippet-source">${escapeHtml(
            truncateForUi(
              entry.sourceRecord === null || entry.sourceRecord === undefined
                ? entry.artifact.fullComment ?? "Source comment unavailable."
                : getNormalizedCommentPrimaryText(entry.sourceRecord),
              320
            )
          )}</p>
          ${
            entry.opinionReview?.note.length
              ? `<p class="review-note">${escapeHtml(truncateForUi(entry.opinionReview.note, 220))}</p>`
              : ""
          }
          ${
            entry.suggestion?.note.length
              ? `<p class="review-note review-note-suggestion">${escapeHtml(truncateForUi(entry.suggestion.note, 220))}</p>`
              : ""
          }
        </article>`;
      })
      .join("")}
  </div>`;
}

function summarizeReviewStatuses(statuses: ReviewStatus[]): Array<[ReviewStatus, number]> {
  const counts = new Map<ReviewStatus, number>(
    REVIEW_STATUS_VALUES.map((status) => [status, 0] as const)
  );

  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  return REVIEW_STATUS_VALUES.map((status) => [status, counts.get(status) ?? 0]);
}

function renderReviewStatusSummary(
  kind: "comments" | "opinions",
  items: Array<[ReviewStatus, number]>
): string {
  return `<div class="review-status-grid">
    ${items
      .map(
        ([status, count]) => `<a class="review-status-card review-status-link" href="${buildAdminContentHref(
          kind,
          [status],
          0
        )}">
            ${renderReviewStatusBadge(status)}
            <p class="review-status-count">${count}</p>
          </a>`
      )
      .join("")}
  </div>`;
}

function formatIncludedStatuses(statuses: ReviewStatus[]): string {
  return statuses.length === 0 ? "none" : statuses.join(", ");
}

function renderReviewStatusBadge(status: ReviewStatus): string {
  return `<span class="status-badge ${reviewStatusClassName(status)}">${escapeHtml(status)}</span>`;
}

function renderStatementReviewCard(
  data: ProjectDashboardData,
  loaded: LoadedStatementBank,
  statement: Statement
): string {
  const review = loaded.reviewByStatementId.get(statement.statementId);
  const evidenceRefs = statement.evidenceRefs.filter(
    (ref) => ref.refType === "opinion" || ref.refType === "cluster" || ref.refType === "theme"
  );

  return `<article class="card statement-card">
    <div class="record-header">
      <div>
        <p class="eyebrow">${escapeHtml(statement.statementId)}</p>
        <h3>${escapeHtml(statement.statementText)}</h3>
        <div class="meta-row">
          ${renderStatementStatusBadge(statement.moderationStatus)}
          ${renderMetaChip(escapeHtml(statement.visibilityStatus))}
          ${statement.duplicateOfStatementId === undefined ? "" : renderMetaChip(`Duplicate of ${escapeHtml(statement.duplicateOfStatementId)}`)}
          ${renderMetaChip(`${evidenceRefs.length} evidence ref(s)`)}
        </div>
      </div>
    </div>
    <div class="columns">
      <section class="stack">
        <p>${escapeHtml(statement.generationRationale)}</p>
        ${
          statement.sourceClusterIds.length === 0
            ? ""
            : `<p class="meta">Clusters: ${escapeHtml(statement.sourceClusterIds.join(", "))}</p>`
        }
        ${
          statement.sourceOpinionIds.length === 0
            ? ""
            : `<p class="meta">Opinions: ${escapeHtml(statement.sourceOpinionIds.slice(0, 8).join(", "))}${statement.sourceOpinionIds.length > 8 ? "..." : ""}</p>`
        }
        ${renderStatementEvidenceList(evidenceRefs)}
      </section>
      <form class="admin-form" method="post" action="/statements/${encodeURIComponent(loaded.statementRunId)}/${encodeURIComponent(statement.statementId)}/review">
        <div class="field-grid">
          <label class="field">
            <span>Status</span>
            <select name="status">
              ${renderStatementStatusOptions(statement.moderationStatus)}
            </select>
          </label>
          <label class="field">
            <span>Visibility</span>
            <select name="visibility">
              ${renderStatementVisibilityOptions(statement.visibilityStatus)}
            </select>
          </label>
        </div>
        <label class="field">
          <span>Statement text</span>
          <textarea name="statementText" rows="4">${escapeHtml(statement.statementText)}</textarea>
        </label>
        <label class="field">
          <span>Review note</span>
          <textarea name="note" rows="3">${escapeHtml(review?.note ?? "")}</textarea>
        </label>
        <button class="button-link" type="submit">Save statement review</button>
        <p class="meta">Artifact ${escapeHtml(toPortableRelativePath(data.projectRoot, path.join(loaded.statementRunPaths.statementsDir, `${statement.statementId}.json`)))}</p>
      </form>
    </div>
  </article>`;
}

function renderStatementEvidenceList(refs: Statement["evidenceRefs"]): string {
  const visibleRefs = refs.slice(0, 6);

  if (visibleRefs.length === 0) {
    return `<p class="meta">No evidence references are attached.</p>`;
  }

  return `<div class="stack">
    <p class="section-label">Evidence</p>
    ${visibleRefs
      .map(
        (ref) => `<blockquote>
          <strong>${escapeHtml(ref.refType)}</strong>
          ${ref.clusterId === undefined ? "" : ` · Cluster ${escapeHtml(ref.clusterId)}`}
          ${ref.themeId === undefined ? "" : ` · Theme ${escapeHtml(ref.themeId)}`}
          ${ref.opinionId === undefined ? "" : ` · Opinion ${escapeHtml(ref.opinionId)}`}
          ${ref.excerpt === undefined ? "" : `<br />${escapeHtml(truncateForUi(ref.excerpt, 280))}`}
        </blockquote>`
      )
      .join("")}
  </div>`;
}

function renderStatementStatusBadge(status: StatementModerationStatus, count?: number): string {
  const label = count === undefined ? status : `${status}: ${count}`;
  return `<span class="status-badge status-${escapeHtmlAttribute(status)}">${escapeHtml(label)}</span>`;
}

function renderStatementStatusOptions(selectedStatus: StatementModerationStatus): string {
  const statuses: StatementModerationStatus[] = [
    "pending",
    "accepted",
    "rejected",
    "hidden_from_public",
    "excluded_from_analysis"
  ];

  return statuses
    .map(
      (status) =>
        `<option value="${escapeHtmlAttribute(status)}" ${status === selectedStatus ? "selected" : ""}>${escapeHtml(status)}</option>`
    )
    .join("");
}

function renderStatementVisibilityOptions(selectedStatus: StatementVisibilityStatus): string {
  const statuses: StatementVisibilityStatus[] = ["private", "admin_only", "public"];

  return statuses
    .map(
      (status) =>
        `<option value="${escapeHtmlAttribute(status)}" ${status === selectedStatus ? "selected" : ""}>${escapeHtml(status)}</option>`
    )
    .join("");
}

function summarizeWebStatementStatuses(
  statements: Statement[]
): Record<StatementModerationStatus, number> {
  const summary: Record<StatementModerationStatus, number> = {
    pending: 0,
    accepted: 0,
    rejected: 0,
    hidden_from_public: 0,
    excluded_from_analysis: 0
  };

  for (const statement of statements) {
    summary[statement.moderationStatus] += 1;
  }

  return summary;
}

function renderMetaChip(content: string): string {
  return `<span class="meta-chip">${content}</span>`;
}

function renderSuggestionChip(status: ReviewStatus, confidence: number): string {
  return `<span class="meta-chip meta-chip-suggestion">Suggest ${escapeHtml(
    status
  )} · ${Math.round(confidence * 100)}%</span>`;
}

function matchesAdminCommentQuery(entry: AdminCommentEntry, query: string): boolean {
  if (query.trim().length === 0) {
    return true;
  }

  return buildAdminSearchHaystack([
    entry.sourceId,
    getNormalizedCommentPrimaryText(entry.record),
    entry.record.contentText,
    entry.record.provenance.externalId ?? "",
    entry.review?.reasonCode ?? "",
    entry.review?.note ?? "",
    entry.suggestion?.reasonCode ?? "",
    entry.suggestion?.note ?? ""
  ]).includes(query.trim().toLowerCase());
}

function matchesAdminOpinionQuery(entry: AdminOpinionEntry, query: string): boolean {
  if (query.trim().length === 0) {
    return true;
  }

  return buildAdminSearchHaystack([
    entry.opinionId,
    entry.artifact.sourceId ?? "",
    entry.artifact.opinionText ?? "",
    entry.artifact.excerpt ?? "",
    entry.sourceRecord === null || entry.sourceRecord === undefined
      ? ""
      : getNormalizedCommentPrimaryText(entry.sourceRecord),
    entry.sourceRecord?.contentText ?? entry.artifact.fullComment ?? "",
    entry.opinionReview?.reasonCode ?? "",
    entry.opinionReview?.note ?? "",
    entry.commentReview?.reasonCode ?? "",
    entry.commentReview?.note ?? "",
    entry.suggestion?.reasonCode ?? "",
    entry.suggestion?.note ?? ""
  ]).includes(query.trim().toLowerCase());
}

function buildAdminSearchHaystack(values: string[]): string {
  return values.join("\n").toLowerCase();
}

function reviewStatusClassName(status: ReviewStatus): string {
  return `status-${status.replaceAll(/[^a-z0-9]+/g, "-")}`;
}

function renderReviewArtifactSummary(
  artifact: CommentReviewArtifact | OpinionReviewArtifact | null,
  kind: "comment" | "opinion"
): string {
  if (artifact === null) {
    return `<div class="stack">
      <p class="section-label">${kind === "comment" ? "Comment review" : "Opinion review"}</p>
      <p class="meta">No explicit ${kind} review artifact exists. The effective status currently falls back to default or inherited state.</p>
    </div>`;
  }

  return `<div class="stack">
    <p class="section-label">${kind === "comment" ? "Comment review" : "Opinion review"}</p>
    ${renderKeyValueList([
      ["Status", artifact.status],
      ["Reason", artifact.reasonCode],
      ["Actor", `${artifact.actor.type}:${artifact.actor.name}`],
      ["Updated", artifact.updatedAt]
    ])}
    ${
      artifact.note.length === 0
        ? ""
        : `<p class="meta">${escapeHtml(artifact.note)}</p>`
    }
  </div>`;
}

function renderReviewSuggestionSummary(
  artifact: CommentReviewSuggestionArtifact | OpinionReviewSuggestionArtifact | null,
  kind: "comment" | "opinion",
  actions?: { actionPath: string; nextPath: string }
): string {
  if (artifact === null) {
    return `<div class="stack">
      <p class="section-label">${kind === "comment" ? "Comment suggestion" : "Opinion suggestion"}</p>
      <p class="meta">No machine suggestion is currently stored for this ${kind}.</p>
    </div>`;
  }

  return `<div class="stack">
    <p class="section-label">${kind === "comment" ? "Comment suggestion" : "Opinion suggestion"}</p>
    ${renderKeyValueList([
      ["Suggested status", artifact.suggestedStatus],
      ["Reason", artifact.reasonCode],
      ["Confidence", `${Math.round(artifact.confidence * 100)}%`],
      ["State", artifact.state],
      ["Actor", artifact.actor.name]
    ])}
    ${
      artifact.note.length === 0
        ? ""
        : `<p class="meta">${escapeHtml(artifact.note)}</p>`
    }
    ${renderSuggestionDecisionControls(artifact, actions)}
  </div>`;
}

function renderSuggestionDecisionControls(
  artifact: CommentReviewSuggestionArtifact | OpinionReviewSuggestionArtifact,
  actions?: { actionPath: string; nextPath: string }
): string {
  if (artifact.state !== "proposed") {
    return `<p class="meta">This suggestion has been ${escapeHtml(artifact.state)}.</p>`;
  }

  if (actions === undefined) {
    return "";
  }

  const actionPath = escapeHtmlAttribute(actions.actionPath);
  const nextPath = escapeHtmlAttribute(actions.nextPath);

  return `<div class="button-row suggestion-actions">
    <form method="post" action="${actionPath}">
      <input type="hidden" name="decision" value="accept" />
      <input type="hidden" name="next" value="${nextPath}" />
      <button class="button-link button-link-small" type="submit">Accept suggestion</button>
    </form>
    <form method="post" action="${actionPath}">
      <input type="hidden" name="decision" value="reject" />
      <input type="hidden" name="next" value="${nextPath}" />
      <button class="button-link button-link-secondary button-link-small" type="submit">Reject suggestion</button>
    </form>
  </div>`;
}

function renderAdminOpinionCard(opinion: AdminOpinionEntry): string {
  return `<article class="card record-card">
    <div class="record-header">
      <p class="eyebrow">Opinion</p>
      <h3><a href="/admin/opinions/${encodeURIComponent(opinion.opinionId)}">${escapeHtml(
        truncateForUi(opinion.artifact.opinionText ?? opinion.opinionId, 120)
      )}</a></h3>
      <p class="meta">${escapeHtml(opinion.opinionId)}</p>
    </div>
    <p>${renderReviewStatusBadge(opinion.effectiveStatus)} <span class="meta">via ${escapeHtml(opinion.effectiveStatusSource)}</span></p>
    <p>${escapeHtml(opinion.artifact.excerpt ?? "")}</p>
  </article>`;
}

function renderReviewStatusOptions(selectedStatus: ReviewStatus): string {
  return REVIEW_STATUS_VALUES.map(
    (status) =>
      `<option value="${escapeHtmlAttribute(status)}" ${status === selectedStatus ? "selected" : ""}>${escapeHtml(status)}</option>`
  ).join("");
}

function renderReviewStatusCheckboxes(fieldName: string, selectedStatuses: ReviewStatus[]): string {
  return `<div class="checkbox-grid">
    ${REVIEW_STATUS_VALUES.map(
      (status) => `<label class="checkbox-pill ${selectedStatuses.includes(status) ? "active" : ""}">
          <input type="checkbox" name="${escapeHtmlAttribute(fieldName)}" value="${escapeHtmlAttribute(status)}" ${selectedStatuses.includes(status) ? "checked" : ""} />
          <span>${escapeHtml(status)}</span>
        </label>`
    ).join("")}
  </div>`;
}

function renderKeyValueList(items: Array<[string, string]>): string {
  return `<dl class="facts">
    ${items
      .map(
        ([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
      )
      .join("")}
  </dl>`;
}

function renderBulletList(items: string[]): string {
  return `<ul class="bullets">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function uniqueLabels(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function truncateForUi(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

const CLUSTER_COLORS = [
  "#1B72B0",
  "#E8913A",
  "#15794F",
  "#A64D79",
  "#6C63FF",
  "#B85C38",
  "#0E3D66",
  "#7D9D0B",
  "#C44536",
  "#2A9D8F",
  "#8D5A97",
  "#F4A261"
];

function describeAnalysisStatus(
  status: StepStatus,
  analysisRunCount: number,
  opinionRunCount: number
): string {
  if (status === "ready") {
    return `${analysisRunCount} analysis artifact set(s) are already present.`;
  }

  if (status === "active") {
    return opinionRunCount > 0
      ? "Opinion extraction exists, so this is the next meaningful stage."
      : "This stage will become relevant after opinion extraction.";
  }

  return "This stage is waiting on earlier pipeline steps.";
}

function renderPage(data: ProjectDashboardData, title: string, body: string): string {
  const behaviorScript = `
    <script>
      const clearClusterFocus = (scope) => {
        if (!(scope instanceof HTMLElement)) return;
        scope.querySelectorAll(".plot").forEach((plot) => {
          plot.classList.remove("focus-mode");
          plot.querySelectorAll(".plot-point").forEach((point) => {
            point.classList.remove("is-focused");
          });
        });
      };

      const applyClusterFocus = (scope, clusterId) => {
        if (!(scope instanceof HTMLElement)) return;
        scope.querySelectorAll(".plot").forEach((plot) => {
          plot.classList.add("focus-mode");
          plot.querySelectorAll(".plot-point").forEach((point) => {
            const matches = point.getAttribute("data-cluster-id") === clusterId;
            point.classList.toggle("is-focused", matches);
          });
        });
      };

      const applyThemeFocus = (scope, clusterIds) => {
        if (!(scope instanceof HTMLElement)) return;
        const wanted = new Set(clusterIds);
        scope.querySelectorAll(".plot").forEach((plot) => {
          plot.classList.add("focus-mode");
          plot.querySelectorAll(".plot-point").forEach((point) => {
            const matches = wanted.has(point.getAttribute("data-cluster-id"));
            point.classList.toggle("is-focused", matches);
          });
        });
      };

      document.addEventListener("mouseover", (event) => {
        const chip = event.target.closest("[data-cluster-focus]");
        if (!(chip instanceof HTMLElement)) return;
        const clusterId = chip.getAttribute("data-cluster-focus");
        const scope = chip.closest("[data-cluster-scope]");
        if (clusterId && scope instanceof HTMLElement) {
          applyClusterFocus(scope, clusterId);
        }
      });

      document.addEventListener("mouseover", (event) => {
        const card = event.target.closest("[data-theme-clusters]");
        if (!(card instanceof HTMLElement)) return;
        const raw = card.getAttribute("data-theme-clusters");
        const scope = card.closest("[data-cluster-scope]");
        if (raw && scope instanceof HTMLElement) {
          applyThemeFocus(scope, raw.split(",").map((value) => value.trim()).filter(Boolean));
        }
      });

      document.addEventListener("mouseout", (event) => {
        const chip = event.target.closest("[data-cluster-focus]");
        if (!(chip instanceof HTMLElement)) return;
        const related = event.relatedTarget;
        if (related instanceof Node && chip.contains(related)) return;
        const scope = chip.closest("[data-cluster-scope]");
        clearClusterFocus(scope);
      });

      document.addEventListener("mouseout", (event) => {
        const card = event.target.closest("[data-theme-clusters]");
        if (!(card instanceof HTMLElement)) return;
        const related = event.relatedTarget;
        if (related instanceof Node && card.contains(related)) return;
        const scope = card.closest("[data-cluster-scope]");
        clearClusterFocus(scope);
      });

      document.addEventListener("click", (event) => {
        const card = event.target.closest("[data-theme-clusters]");
        if (!(card instanceof HTMLElement)) return;
        const raw = card.getAttribute("data-theme-clusters");
        const scope = card.closest("[data-cluster-scope]");
        if (raw && scope instanceof HTMLElement) {
          applyThemeFocus(scope, raw.split(",").map((value) => value.trim()).filter(Boolean));
        }
      });

      document.addEventListener("click", (event) => {
        const openButton = event.target.closest("[data-dialog-open]");
        if (openButton instanceof HTMLElement) {
          const dialogId = openButton.getAttribute("data-dialog-open");
          if (dialogId) {
            const dialog = document.getElementById(dialogId);
            if (dialog instanceof HTMLDialogElement) {
              dialog.showModal();
            }
          }
        }
      });

      document.addEventListener("click", (event) => {
        const tabButton = event.target.closest("[data-tab-target]");
        if (!(tabButton instanceof HTMLElement)) return;
        const tabTarget = tabButton.getAttribute("data-tab-target");
        const tabGroup = tabButton.closest("[data-tab-group]");
        if (!tabTarget || !(tabGroup instanceof HTMLElement)) return;

        event.preventDefault();

        tabGroup.querySelectorAll("[data-tab-target]").forEach((button) => {
          button.classList.toggle("active", button === tabButton);
        });
        tabGroup.querySelectorAll("[data-tab-panel]").forEach((panel) => {
          const matches = panel.getAttribute("data-tab-panel") === tabTarget;
          panel.classList.toggle("active", matches);
        });
      });

      document.addEventListener("click", (event) => {
        const tabButton = event.target.closest("[data-perspective-target]");
        if (!(tabButton instanceof HTMLElement)) return;
        const tabTarget = tabButton.getAttribute("data-perspective-target");
        const tabGroup = tabButton.closest("[data-perspective-group]");
        if (!tabTarget || !(tabGroup instanceof HTMLElement)) return;

        event.preventDefault();

        tabGroup.querySelectorAll("[data-perspective-target]").forEach((button) => {
          button.classList.toggle("active", button === tabButton);
        });
        document.querySelectorAll("[data-perspective-panel]").forEach((panel) => {
          const matches = panel.getAttribute("data-perspective-panel") === tabTarget;
          panel.classList.toggle("active", matches);
        });
        if (window.location.hash !== "#" + tabTarget) {
          history.replaceState(null, "", "#" + tabTarget);
        }
        window.scrollTo({ top: 0, behavior: "smooth" });
      });

      const hashPanelId = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : "";
      if (hashPanelId) {
        const matchingButton = document.querySelector('[data-perspective-target="' + CSS.escape(hashPanelId) + '"]');
        if (matchingButton instanceof HTMLElement) {
          matchingButton.click();
        }
      }
    </script>`;
  const liveReloadScript = data.liveReloadEnabled
    ? `
    <script>
      const broadlyLiveReload = new EventSource("/__broadly_live_reload");
      broadlyLiveReload.addEventListener("reload", () => {
        window.location.reload();
      });
    </script>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(`${data.config.project.name} · ${title}`)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bl-primary-900: #082640;
        --bl-primary-800: #0E3D66;
        --bl-primary-700: #145688;
        --bl-primary-600: #1B72B0;
        --bl-primary-500: #2A8DC8;
        --bl-primary-300: #85C3E8;
        --bl-primary-200: #B8DEF3;
        --bl-primary-100: #E0F1FB;
        --bl-accent-700: #A85E12;
        --bl-accent-600: #CC7418;
        --bl-accent-500: #E8913A;
        --bl-accent-100: #FDF2E3;
        --bl-success-600: #15794F;
        --bl-warning-600: #A67B0A;
        --bl-gray-900: #1A1D25;
        --bl-gray-800: #2B3041;
        --bl-gray-700: #444A5E;
        --bl-gray-600: #5D6378;
        --bl-gray-500: #7A8197;
        --bl-gray-300: #BFC4D0;
        --bl-gray-200: #DCDFE7;
        --bl-gray-100: #ECEEF3;
        --bl-gray-50: #F7F8FA;
        --bl-white: #FFFFFF;
        --bl-font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        --bg: var(--bl-gray-50);
        --card: var(--bl-white);
        --ink: var(--bl-gray-800);
        --muted: var(--bl-gray-600);
        --line: var(--bl-gray-200);
        --accent: var(--bl-primary-700);
        --warm: var(--bl-accent-600);
        --ready: var(--bl-success-600);
        --active: var(--bl-accent-600);
        --pending: var(--bl-gray-500);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: var(--bl-font);
        background:
          radial-gradient(circle at top left, rgba(42,141,200,0.12), transparent 28%),
          radial-gradient(circle at top right, rgba(232,145,58,0.14), transparent 24%),
          var(--bg);
        color: var(--ink);
        -webkit-font-smoothing: antialiased;
      }
      a { color: var(--bl-primary-600); text-decoration: none; }
      .shell { max-width: 1240px; margin: 0 auto; padding: 32px 24px 72px; }
      .site-header {
        display: grid;
        gap: 18px;
        align-items: end;
        margin-bottom: 28px;
      }
      .tab-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .tab {
        padding: 10px 14px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: rgba(255,255,255,0.72);
        color: var(--muted);
        font: 600 14px/1.2 ui-monospace, monospace;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .tab.active {
        color: white;
        background: linear-gradient(135deg, var(--bl-primary-800), var(--bl-primary-600));
        border-color: var(--bl-primary-700);
      }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--warm);
        font: 700 12px/1.2 ui-monospace, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .section-label {
        margin: 0 0 6px;
        color: var(--muted);
        font: 700 12px/1.2 ui-monospace, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0 0 8px;
        font-size: clamp(2.2rem, 5vw, 4.4rem);
        line-height: 0.94;
        letter-spacing: -0.03em;
        color: var(--bl-primary-900);
      }
      h2, h3, h4 {
        margin: 0 0 10px;
        color: var(--bl-gray-900);
      }
      .lede, .meta {
        margin: 0;
        color: var(--muted);
      }
      .panel {
        margin-top: 22px;
      }
      .grid,
      .record-list,
      .intro-grid,
      .two-up,
      .pipeline-grid {
        display: grid;
        gap: 18px;
      }
      .grid,
      .intro-grid,
      .two-up {
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .pipeline-grid {
        grid-template-columns: repeat(4, minmax(0, 1fr));
        align-items: stretch;
      }
      .card {
        background: rgba(255,255,255,0.92);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 18px 20px;
        box-shadow: 0 10px 24px rgba(0,0,0,0.08), 0 4px 8px rgba(0,0,0,0.04);
      }
      .feature-card {
        padding: 24px;
      }
      .link-card:hover {
        transform: translateY(-1px);
        box-shadow: 0 20px 40px rgba(0,0,0,0.10);
        border-color: var(--bl-primary-300);
      }
      .pipeline-card.ready {
        border-color: rgba(21,121,79,0.42);
        background: linear-gradient(180deg, rgba(231,248,239,0.98), rgba(255,255,255,0.96));
      }
      .pipeline-card.ready .eyebrow {
        color: #15794f;
      }
      .pipeline-card.active {
        border-color: rgba(232,145,58,0.52);
        background: linear-gradient(180deg, rgba(255,244,226,0.98), rgba(255,255,255,0.96));
      }
      .pipeline-card.active .eyebrow {
        color: #b66411;
      }
      .pipeline-card.pending {
        border-color: rgba(122,129,151,0.26);
        background: rgba(255,255,255,0.92);
      }
      .section-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: end;
        margin-bottom: 14px;
      }
      .text-link {
        font: 700 13px/1.2 ui-monospace, monospace;
      }
      .button-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 12px 18px;
        border: 0;
        border-radius: 12px;
        background: linear-gradient(135deg, var(--bl-primary-800), var(--bl-primary-600));
        color: white;
        cursor: pointer;
        font: 700 14px/1.2 ui-monospace, monospace;
        box-shadow: 0 10px 24px rgba(8,38,64,0.18);
      }
      .button-link:hover {
        text-decoration: none;
        filter: brightness(1.03);
      }
      .button-link-secondary {
        background: rgba(255,255,255,0.88);
        color: var(--bl-primary-800);
        border: 1px solid rgba(27,114,176,0.18);
        box-shadow: none;
      }
      .facts {
        display: grid;
        gap: 12px;
        margin: 0;
      }
      .facts div {
        padding-top: 10px;
        border-top: 1px solid var(--line);
      }
      .facts div:first-child {
        border-top: 0;
        padding-top: 0;
      }
      .facts dt {
        color: var(--muted);
        font: 700 12px/1.2 ui-monospace, monospace;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 4px;
      }
      .facts dd {
        margin: 0;
        word-break: break-word;
      }
      .bullets {
        margin: 0;
        padding-left: 18px;
      }
      .bullets li + li {
        margin-top: 8px;
      }
      .compact-bullets li + li {
        margin-top: 4px;
      }
      .stack {
        margin-top: 18px;
      }
      .record-card { padding: 22px; }
      .record-header { margin-bottom: 16px; }
      .load-more-row {
        display: flex;
        justify-content: center;
        margin-top: 18px;
      }
      .button-row,
      .admin-toolbar,
      .toggle-row,
      .filter-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .button-row form {
        margin: 0;
      }
      .admin-form {
        display: grid;
        gap: 16px;
      }
      .admin-search-card {
        margin-bottom: 14px;
      }
      .admin-search-grid {
        align-items: end;
      }
      .admin-search-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .form-grid {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      }
      .field {
        display: grid;
        gap: 8px;
        color: var(--bl-gray-900);
        font: 700 12px/1.2 ui-monospace, monospace;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .field input,
      .field select,
      .field textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.98);
        color: var(--ink);
        font: 500 14px/1.45 ui-sans-serif, system-ui, sans-serif;
      }
      .checkbox-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .checkbox-pill {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255,255,255,0.92);
        font: 700 12px/1.2 ui-monospace, monospace;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--muted);
      }
      .checkbox-pill.active {
        border-color: rgba(27,114,176,0.20);
        background: rgba(27,114,176,0.08);
        color: var(--bl-primary-800);
      }
      .admin-toolbar {
        flex-direction: column;
        margin-bottom: 16px;
      }
      .table-shell {
        overflow-x: auto;
      }
      .review-list {
        display: grid;
        gap: 14px;
      }
      .review-card {
        padding: 20px 22px;
      }
      .review-card-head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 12px;
      }
      .review-card-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .review-card-head h3 {
        margin-bottom: 0;
      }
      .button-link-small {
        padding: 9px 12px;
        font-size: 12px;
      }
      .select-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.92);
        color: var(--muted);
        font: 700 12px/1.2 ui-monospace, monospace;
      }
      .select-pill input {
        margin: 0;
      }
      .review-snippet {
        margin: 0;
        color: var(--bl-gray-900);
      }
      .review-snippet-comment {
        font-size: 1.08rem;
        line-height: 1.65;
      }
      .review-subtext {
        margin: 0 0 10px;
        color: var(--bl-gray-700);
        font-size: .97rem;
      }
      .review-snippet-source {
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--line);
        color: var(--bl-gray-700);
        font-size: .95rem;
        line-height: 1.6;
      }
      .review-note {
        margin: 12px 0 0;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(245,247,251,0.92);
        color: var(--bl-gray-700);
        font-size: .92rem;
      }
      .meta-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }
      .meta-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 10px;
        border-radius: 999px;
        background: rgba(236,238,243,0.82);
        color: var(--bl-gray-700);
        font: 700 12px/1.2 ui-monospace, monospace;
      }
      .meta-chip a {
        color: inherit;
        text-decoration: none;
      }
      .meta-chip a:hover {
        text-decoration: underline;
      }
      .admin-table {
        width: 100%;
        border-collapse: collapse;
        background: rgba(255,255,255,0.9);
        border: 1px solid var(--line);
        border-radius: 16px;
        overflow: hidden;
      }
      .admin-table th,
      .admin-table td {
        padding: 14px 16px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
        text-align: left;
      }
      .admin-table th {
        color: var(--muted);
        font: 700 12px/1.2 ui-monospace, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        background: rgba(245,247,251,0.92);
      }
      .admin-table tbody tr:last-child td {
        border-bottom: 0;
      }
      .filter-chip,
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        font: 700 12px/1.2 ui-monospace, monospace;
        letter-spacing: 0.02em;
      }
      .filter-chip {
        padding: 10px 14px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.9);
        color: var(--muted);
      }
      .filter-chip.active {
        border-color: rgba(27,114,176,0.22);
        background: rgba(27,114,176,0.10);
        color: var(--bl-primary-800);
      }
      .status-badge {
        padding: 7px 10px;
        border: 1px solid transparent;
        white-space: nowrap;
      }
      .status-included {
        background: rgba(21,121,79,0.12);
        border-color: rgba(21,121,79,0.18);
        color: #0d5f3b;
      }
      .status-excluded-non-substantive {
        background: rgba(232,145,58,0.14);
        border-color: rgba(232,145,58,0.18);
        color: #9b5808;
      }
      .status-excluded-off-topic {
        background: rgba(166,77,121,0.12);
        border-color: rgba(166,77,121,0.18);
        color: #86355e;
      }
      .status-excluded-admin {
        background: rgba(198,69,54,0.12);
        border-color: rgba(198,69,54,0.18);
        color: #8c2e24;
      }
      .status-excluded-duplicate {
        background: rgba(108,99,255,0.12);
        border-color: rgba(108,99,255,0.18);
        color: #4d44d3;
      }
      .review-status-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .review-status-card {
        display: block;
        padding: 14px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(250,251,253,0.92);
      }
      .review-status-link {
        color: inherit;
        transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
      }
      .review-status-link:hover {
        transform: translateY(-1px);
        border-color: var(--bl-primary-300);
        box-shadow: 0 12px 28px rgba(8,38,64,0.10);
        text-decoration: none;
      }
      .review-status-count {
        margin: 10px 0 0;
        font-size: 1.6rem;
        font-weight: 700;
        color: var(--bl-gray-900);
      }
      .columns {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .opinion {
        padding: 12px 0;
        border-top: 1px solid var(--line);
      }
      .opinion:first-of-type {
        border-top: 0;
        padding-top: 0;
      }
      .plot-shell {
        margin-top: 12px;
        border-radius: 18px;
        overflow: hidden;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(255,255,255,0.94), rgba(247,248,250,0.98));
      }
      .plot {
        display: block;
        width: 100%;
        height: auto;
      }
      .plot-point {
        transition: fill-opacity 120ms ease, stroke-opacity 120ms ease, r 120ms ease, transform 120ms ease;
      }
      .plot.focus-mode .plot-point {
        fill-opacity: 0.14 !important;
        stroke-opacity: 0.12 !important;
      }
      .plot.focus-mode .plot-point.is-focused {
        fill-opacity: 0.98 !important;
        stroke-opacity: 0.75 !important;
      }
      .report-hero {
        background:
          linear-gradient(135deg, rgba(8,38,64,0.98), rgba(20,86,136,0.92)),
          radial-gradient(circle at top right, rgba(232,145,58,0.24), transparent 40%);
        color: white;
        border-radius: 24px;
        padding: 28px;
        border: 0;
      }
      .report-hero h2,
      .report-hero .lede,
      .report-hero .meta,
      .report-hero a {
        color: white;
      }
      .report-hero .eyebrow {
        color: rgba(255, 231, 205, 0.94);
      }
      .perspective-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 12px;
      }
      .perspective-switcher {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
      }
      .perspective-switcher-tab {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        padding: 16px 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(242,249,253,0.92));
        color: var(--bl-gray-900);
        cursor: pointer;
        text-align: left;
        box-shadow: 0 10px 24px rgba(0,0,0,0.06), 0 4px 8px rgba(0,0,0,0.03);
        transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease, background 120ms ease;
      }
      .perspective-switcher-tab:hover {
        transform: translateY(-1px);
        border-color: var(--bl-primary-300);
        box-shadow: 0 16px 32px rgba(20,86,136,0.10), 0 4px 10px rgba(0,0,0,0.04);
      }
      .perspective-switcher-tab.active {
        border-color: var(--bl-primary-500);
        background: linear-gradient(135deg, rgba(8,38,64,0.98), rgba(20,86,136,0.94));
        color: white;
      }
      .perspective-switcher-title {
        font-size: 1.02rem;
        font-weight: 700;
        line-height: 1.25;
      }
      .perspective-switcher-meta {
        color: var(--bl-gray-600);
        font: 700 12px/1.35 ui-monospace, monospace;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .perspective-switcher-tab.active .perspective-switcher-meta {
        color: rgba(236, 246, 252, 0.92);
      }
      .perspective-panel {
        display: none;
      }
      .perspective-panel.active {
        display: block;
      }
      .perspective-panel-meta {
        max-width: 480px;
        text-align: right;
      }
      .cluster-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 14px;
      }
      .cluster-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.92);
        color: var(--bl-gray-800);
        font: 700 12px/1.2 ui-monospace, monospace;
        transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
      }
      .cluster-chip:hover {
        border-color: var(--bl-primary-300);
        background: #fff;
        transform: translateY(-1px);
      }
      .tab-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }
      .report-subtab {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 10px 14px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.92);
        color: var(--bl-gray-700);
        font: 700 13px/1.2 ui-monospace, monospace;
        cursor: pointer;
      }
      .report-subtab.active {
        background: linear-gradient(135deg, var(--bl-primary-800), var(--bl-primary-600));
        border-color: var(--bl-primary-700);
        color: white;
      }
      .tab-panel {
        display: none;
        margin-top: 18px;
      }
      .tab-panel.active {
        display: block;
      }
      .cluster-chip-flag {
        padding: 3px 7px;
        border-radius: 999px;
        background: rgba(20,86,136,0.10);
        color: var(--bl-primary-800);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .cluster-chip-swatch {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--cluster-accent, var(--bl-primary-600));
        box-shadow: 0 0 0 2px rgba(8,38,64,0.08);
      }
      .theme-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .theme-card {
        padding: 16px;
        border-radius: 16px;
        background: linear-gradient(180deg, rgba(248,251,254,0.98), rgba(255,255,255,0.98));
        border: 1px solid var(--line);
        cursor: pointer;
        transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
      }
      .theme-card:hover {
        border-color: var(--bl-primary-300);
        box-shadow: 0 12px 24px rgba(20,86,136,0.08);
        transform: translateY(-1px);
      }
      .perspective-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 9px 14px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--bl-gray-50);
        color: var(--bl-primary-800);
        font: 700 13px/1.2 ui-monospace, monospace;
      }
      .perspective-pill.primary {
        background: linear-gradient(135deg, var(--bl-primary-800), var(--bl-primary-600));
        border-color: var(--bl-primary-700);
        color: white;
      }
      .report-cluster-card {
        border-top: 4px solid var(--cluster-accent, var(--bl-primary-600));
      }
      .highlighted-cluster-card {
        box-shadow: 0 16px 32px rgba(20,86,136,0.10), 0 4px 10px rgba(0,0,0,0.04);
      }
      .secondary-cluster-card {
        background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(247,248,250,0.96));
      }
      .evidence-card + .evidence-card {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid var(--line);
      }
      .evidence-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        margin-top: 8px;
      }
      .text-button {
        border: 0;
        padding: 0;
        background: none;
        color: var(--bl-primary-700);
        cursor: pointer;
        font: 700 13px/1.2 ui-monospace, monospace;
      }
      .text-button:hover {
        text-decoration: underline;
      }
      .opinion-dialog {
        width: min(760px, calc(100vw - 32px));
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 0;
        box-shadow: 0 32px 72px rgba(0,0,0,0.22);
      }
      .opinion-dialog::backdrop {
        background: rgba(8,38,64,0.36);
        backdrop-filter: blur(2px);
      }
      .dialog-shell {
        padding: 22px 24px 24px;
      }
      .dialog-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
      }
      .dialog-close {
        border: 0;
        background: var(--bl-gray-100);
        color: var(--bl-gray-800);
        width: 36px;
        height: 36px;
        border-radius: 999px;
        cursor: pointer;
        font: 700 22px/1 Inter, sans-serif;
      }
      blockquote {
        margin: 10px 0 0;
        padding: 12px 14px;
        border-left: 4px solid var(--bl-primary-300);
        background: #f7fbfe;
        border-radius: 12px;
      }
      pre {
        margin: 0;
        padding: 14px;
        border-radius: 14px;
        background: var(--bl-gray-50);
        border: 1px solid var(--bl-gray-200);
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font: 13px/1.45 ui-monospace, monospace;
      }
      code {
        font: 0.95em ui-monospace, monospace;
      }
      .error {
        color: #B5312B;
      }
      @media (max-width: 1120px) {
        .pipeline-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .shell {
          padding: 24px 16px 56px;
        }
        .pipeline-grid {
          grid-template-columns: 1fr;
        }
        .section-head {
          align-items: start;
          flex-direction: column;
        }
        .perspective-panel-meta {
          text-align: left;
        }
      }
    </style>
  </head>
  <body>${body}${behaviorScript}${liveReloadScript}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function listNormalizedRecordPaths(normalizedDir: string): Promise<string[]> {
  const entries = await readdir(normalizedDir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        entry.name !== "ingest-manifest.json"
    )
    .map((entry) => path.join(normalizedDir, entry.name))
    .sort();
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function toPortableRelativePath(fromDirectory: string, toPath: string): string {
  const relativePath = path.relative(fromDirectory, toPath);
  const portablePath = relativePath.split(path.sep).join("/");

  return portablePath.startsWith(".") ? portablePath : `./${portablePath}`;
}

function createLiveReloadController(projectRoot: string): LiveReloadController {
  const clients = new Set<ServerResponse>();
  const watchers: FSWatcher[] = [];
  let reloadTimer: NodeJS.Timeout | null = null;

  const broadcastReload = (): void => {
    for (const client of clients) {
      client.write("event: reload\ndata: project-changed\n\n");
    }
  };

  const scheduleReload = (): void => {
    if (reloadTimer !== null) {
      clearTimeout(reloadTimer);
    }

    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      broadcastReload();
    }, 120);
  };

  try {
    watchers.push(watch(projectRoot, { recursive: true }, scheduleReload));
  } catch {
    const fallbackTargets = [
      path.join(projectRoot, "broadly.yaml"),
      path.join(projectRoot, "data"),
      path.join(projectRoot, "runs"),
      path.join(projectRoot, "reports"),
      path.join(projectRoot, "prompts")
    ];

    for (const target of fallbackTargets) {
      try {
        watchers.push(watch(target, scheduleReload));
      } catch {
        continue;
      }
    }
  }

  return {
    handleClient(response: ServerResponse): void {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      response.write("retry: 500\n\n");
      clients.add(response);

      response.on("close", () => {
        clients.delete(response);
      });
    },
    close(): void {
      if (reloadTimer !== null) {
        clearTimeout(reloadTimer);
      }

      for (const watcher of watchers) {
        watcher.close();
      }

      for (const client of clients) {
        client.end();
      }

      clients.clear();
    }
  };
}

function parseOffset(value: string | null): number {
  if (value === null) {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}
