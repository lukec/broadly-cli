import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createDefaultReviewConfig,
  isReviewStatus,
  resolveProjectPaths,
  type CommentReviewArtifact,
  type CommentReviewSuggestionArtifact,
  type OpinionReviewArtifact,
  type OpinionReviewSuggestionArtifact,
  type ProjectPaths,
  type ReviewActor,
  type ReviewConfig,
  type ReviewSuggestionActor,
  type ReviewStatus
} from "@broadly/core";

export interface EffectiveOpinionReviewStatus {
  status: ReviewStatus;
  source: "default" | "comment" | "opinion";
  commentReview: CommentReviewArtifact | null;
  opinionReview: OpinionReviewArtifact | null;
}

export interface UpsertCommentReviewInput {
  subjectId: string;
  status: ReviewStatus;
  reasonCode: string;
  note: string;
  actor: ReviewActor;
  normalizedRecordPath: string;
}

export interface UpsertOpinionReviewInput {
  subjectId: string;
  status: ReviewStatus;
  reasonCode: string;
  note: string;
  actor: ReviewActor;
  opinionArtifactPath: string;
  sourceId: string;
  normalizedRecordPath: string;
}

export interface UpsertCommentReviewSuggestionInput {
  subjectId: string;
  suggestedStatus: ReviewStatus;
  reasonCode: string;
  note: string;
  confidence: number;
  state?: "proposed" | "accepted" | "rejected";
  actor: ReviewSuggestionActor;
  normalizedRecordPath: string;
}

export interface UpsertOpinionReviewSuggestionInput {
  subjectId: string;
  suggestedStatus: ReviewStatus;
  reasonCode: string;
  note: string;
  confidence: number;
  state?: "proposed" | "accepted" | "rejected";
  actor: ReviewSuggestionActor;
  opinionArtifactPath: string;
  sourceId: string;
  normalizedRecordPath: string;
}

export async function ensureProjectReviewState(
  projectRootOrPaths: string | ProjectPaths
): Promise<ReviewConfig> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const reviewConfig = await loadReviewConfig(projectPaths);

  if (reviewConfig !== null) {
    return reviewConfig;
  }

  const defaultConfig = createDefaultReviewConfig();
  await writeReviewConfig(projectPaths, defaultConfig);
  return defaultConfig;
}

export async function loadReviewConfig(
  projectRootOrPaths: string | ProjectPaths
): Promise<ReviewConfig | null> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const parsed = await readJsonFile<ReviewConfig>(projectPaths.reviewConfigPath);

  if (parsed === null) {
    return null;
  }

  return normalizeReviewConfig(parsed);
}

export async function writeReviewConfig(
  projectRootOrPaths: string | ProjectPaths,
  config: ReviewConfig
): Promise<void> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const normalizedConfig = normalizeReviewConfig(config);
  await mkdir(projectPaths.reviewDir, { recursive: true });
  await writeJsonFile(projectPaths.reviewConfigPath, normalizedConfig);
}

export async function loadCommentReview(
  projectRootOrPaths: string | ProjectPaths,
  subjectId: string
): Promise<CommentReviewArtifact | null> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const artifact = await readJsonFile<CommentReviewArtifact>(
    `${projectPaths.reviewCommentsDir}/${subjectId}.json`
  );

  return artifact === null ? null : normalizeCommentReviewArtifact(artifact);
}

export async function loadOpinionReview(
  projectRootOrPaths: string | ProjectPaths,
  subjectId: string
): Promise<OpinionReviewArtifact | null> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const artifact = await readJsonFile<OpinionReviewArtifact>(
    `${projectPaths.reviewOpinionsDir}/${subjectId}.json`
  );

  return artifact === null ? null : normalizeOpinionReviewArtifact(artifact);
}

export async function loadCommentReviewSuggestion(
  projectRootOrPaths: string | ProjectPaths,
  subjectId: string
): Promise<CommentReviewSuggestionArtifact | null> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const artifact = await readJsonFile<CommentReviewSuggestionArtifact>(
    `${projectPaths.reviewCommentSuggestionsDir}/${subjectId}.json`
  );

  return artifact === null ? null : normalizeCommentReviewSuggestionArtifact(artifact);
}

export async function loadOpinionReviewSuggestion(
  projectRootOrPaths: string | ProjectPaths,
  subjectId: string
): Promise<OpinionReviewSuggestionArtifact | null> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const artifact = await readJsonFile<OpinionReviewSuggestionArtifact>(
    `${projectPaths.reviewOpinionSuggestionsDir}/${subjectId}.json`
  );

  return artifact === null ? null : normalizeOpinionReviewSuggestionArtifact(artifact);
}

export async function upsertCommentReview(
  projectRootOrPaths: string | ProjectPaths,
  input: UpsertCommentReviewInput
): Promise<CommentReviewArtifact> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const existing = await loadCommentReview(projectPaths, input.subjectId);
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const artifact = normalizeCommentReviewArtifact({
    subjectKind: "comment",
    subjectId: input.subjectId,
    status: input.status,
    reasonCode: normalizeRequiredString(input.reasonCode, "manual-update"),
    note: normalizeReviewNote(input.note, input.status),
    actor: normalizeReviewActor(input.actor),
    createdAt,
    updatedAt: new Date().toISOString(),
    provenance: {
      normalizedRecordPath: normalizeRequiredString(input.normalizedRecordPath)
    }
  });

  await mkdir(projectPaths.reviewCommentsDir, { recursive: true });
  await writeJsonFile(`${projectPaths.reviewCommentsDir}/${input.subjectId}.json`, artifact);
  return artifact;
}

export async function upsertOpinionReview(
  projectRootOrPaths: string | ProjectPaths,
  input: UpsertOpinionReviewInput
): Promise<OpinionReviewArtifact> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const existing = await loadOpinionReview(projectPaths, input.subjectId);
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const artifact = normalizeOpinionReviewArtifact({
    subjectKind: "opinion",
    subjectId: input.subjectId,
    status: input.status,
    reasonCode: normalizeRequiredString(input.reasonCode, "manual-update"),
    note: normalizeReviewNote(input.note, input.status),
    actor: normalizeReviewActor(input.actor),
    createdAt,
    updatedAt: new Date().toISOString(),
    provenance: {
      opinionArtifactPath: normalizeRequiredString(input.opinionArtifactPath),
      sourceId: normalizeRequiredString(input.sourceId),
      normalizedRecordPath: normalizeRequiredString(input.normalizedRecordPath)
    }
  });

  await mkdir(projectPaths.reviewOpinionsDir, { recursive: true });
  await writeJsonFile(`${projectPaths.reviewOpinionsDir}/${input.subjectId}.json`, artifact);
  return artifact;
}

export async function upsertCommentReviewSuggestion(
  projectRootOrPaths: string | ProjectPaths,
  input: UpsertCommentReviewSuggestionInput
): Promise<CommentReviewSuggestionArtifact> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const existing = await loadCommentReviewSuggestion(projectPaths, input.subjectId);
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const artifact = normalizeCommentReviewSuggestionArtifact({
    subjectKind: "comment",
    subjectId: input.subjectId,
    suggestedStatus: input.suggestedStatus,
    reasonCode: normalizeRequiredString(input.reasonCode, "machine-suggestion"),
    note: typeof input.note === "string" ? input.note.trim() : "",
    confidence: normalizeConfidence(input.confidence),
    state: input.state ?? "proposed",
    actor: normalizeReviewSuggestionActor(input.actor),
    createdAt,
    updatedAt: new Date().toISOString(),
    provenance: {
      normalizedRecordPath: normalizeRequiredString(input.normalizedRecordPath)
    }
  });

  await mkdir(projectPaths.reviewCommentSuggestionsDir, { recursive: true });
  await writeJsonFile(
    `${projectPaths.reviewCommentSuggestionsDir}/${input.subjectId}.json`,
    artifact
  );
  return artifact;
}

export async function upsertOpinionReviewSuggestion(
  projectRootOrPaths: string | ProjectPaths,
  input: UpsertOpinionReviewSuggestionInput
): Promise<OpinionReviewSuggestionArtifact> {
  const projectPaths = resolvePaths(projectRootOrPaths);
  const existing = await loadOpinionReviewSuggestion(projectPaths, input.subjectId);
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const artifact = normalizeOpinionReviewSuggestionArtifact({
    subjectKind: "opinion",
    subjectId: input.subjectId,
    suggestedStatus: input.suggestedStatus,
    reasonCode: normalizeRequiredString(input.reasonCode, "machine-suggestion"),
    note: typeof input.note === "string" ? input.note.trim() : "",
    confidence: normalizeConfidence(input.confidence),
    state: input.state ?? "proposed",
    actor: normalizeReviewSuggestionActor(input.actor),
    createdAt,
    updatedAt: new Date().toISOString(),
    provenance: {
      opinionArtifactPath: normalizeRequiredString(input.opinionArtifactPath),
      sourceId: normalizeRequiredString(input.sourceId),
      normalizedRecordPath: normalizeRequiredString(input.normalizedRecordPath)
    }
  });

  await mkdir(projectPaths.reviewOpinionSuggestionsDir, { recursive: true });
  await writeJsonFile(
    `${projectPaths.reviewOpinionSuggestionsDir}/${input.subjectId}.json`,
    artifact
  );
  return artifact;
}

export function resolveEffectiveOpinionReviewStatus(options: {
  commentReview: CommentReviewArtifact | null;
  opinionReview: OpinionReviewArtifact | null;
}): EffectiveOpinionReviewStatus {
  if (options.opinionReview !== null) {
    return {
      status: options.opinionReview.status,
      source: "opinion",
      commentReview: options.commentReview,
      opinionReview: options.opinionReview
    };
  }

  if (options.commentReview !== null) {
    return {
      status: options.commentReview.status,
      source: "comment",
      commentReview: options.commentReview,
      opinionReview: options.opinionReview
    };
  }

  return {
    status: "included",
    source: "default",
    commentReview: options.commentReview,
    opinionReview: options.opinionReview
  };
}

function resolvePaths(projectRootOrPaths: string | ProjectPaths): ProjectPaths {
  return typeof projectRootOrPaths === "string"
    ? resolveProjectPaths(projectRootOrPaths)
    : projectRootOrPaths;
}

function normalizeReviewConfig(config: ReviewConfig): ReviewConfig {
  return {
    analysis: {
      includeCommentStatuses: normalizeReviewStatusList(config.analysis?.includeCommentStatuses),
      includeOpinionStatuses: normalizeReviewStatusList(config.analysis?.includeOpinionStatuses)
    },
    report: {
      includeCommentStatuses: normalizeReviewStatusList(config.report?.includeCommentStatuses),
      includeOpinionStatuses: normalizeReviewStatusList(config.report?.includeOpinionStatuses)
    },
    web: {
      defaultVisibleCommentStatuses: normalizeReviewStatusList(
        config.web?.defaultVisibleCommentStatuses
      ),
      defaultVisibleOpinionStatuses: normalizeReviewStatusList(
        config.web?.defaultVisibleOpinionStatuses
      )
    }
  };
}

function normalizeCommentReviewArtifact(artifact: CommentReviewArtifact): CommentReviewArtifact {
  return {
    subjectKind: "comment",
    subjectId: normalizeRequiredString(artifact.subjectId),
    status: normalizeReviewStatus(artifact.status),
    reasonCode: normalizeRequiredString(artifact.reasonCode, "manual-update"),
    note: normalizeReviewNote(artifact.note, artifact.status),
    actor: normalizeReviewActor(artifact.actor),
    createdAt: normalizeTimestamp(artifact.createdAt),
    updatedAt: normalizeTimestamp(artifact.updatedAt),
    provenance: {
      normalizedRecordPath: normalizeRequiredString(artifact.provenance?.normalizedRecordPath)
    }
  };
}

function normalizeOpinionReviewArtifact(artifact: OpinionReviewArtifact): OpinionReviewArtifact {
  return {
    subjectKind: "opinion",
    subjectId: normalizeRequiredString(artifact.subjectId),
    status: normalizeReviewStatus(artifact.status),
    reasonCode: normalizeRequiredString(artifact.reasonCode, "manual-update"),
    note: normalizeReviewNote(artifact.note, artifact.status),
    actor: normalizeReviewActor(artifact.actor),
    createdAt: normalizeTimestamp(artifact.createdAt),
    updatedAt: normalizeTimestamp(artifact.updatedAt),
    provenance: {
      opinionArtifactPath: normalizeRequiredString(artifact.provenance?.opinionArtifactPath),
      sourceId: normalizeRequiredString(artifact.provenance?.sourceId),
      normalizedRecordPath: normalizeRequiredString(artifact.provenance?.normalizedRecordPath)
    }
  };
}

function normalizeCommentReviewSuggestionArtifact(
  artifact: CommentReviewSuggestionArtifact
): CommentReviewSuggestionArtifact {
  return {
    subjectKind: "comment",
    subjectId: normalizeRequiredString(artifact.subjectId),
    suggestedStatus: normalizeReviewStatus(artifact.suggestedStatus),
    reasonCode: normalizeRequiredString(artifact.reasonCode, "machine-suggestion"),
    note: typeof artifact.note === "string" ? artifact.note.trim() : "",
    confidence: normalizeConfidence(artifact.confidence),
    state: normalizeSuggestionState(artifact.state),
    actor: normalizeReviewSuggestionActor(artifact.actor),
    createdAt: normalizeTimestamp(artifact.createdAt),
    updatedAt: normalizeTimestamp(artifact.updatedAt),
    provenance: {
      normalizedRecordPath: normalizeRequiredString(artifact.provenance?.normalizedRecordPath)
    }
  };
}

function normalizeOpinionReviewSuggestionArtifact(
  artifact: OpinionReviewSuggestionArtifact
): OpinionReviewSuggestionArtifact {
  return {
    subjectKind: "opinion",
    subjectId: normalizeRequiredString(artifact.subjectId),
    suggestedStatus: normalizeReviewStatus(artifact.suggestedStatus),
    reasonCode: normalizeRequiredString(artifact.reasonCode, "machine-suggestion"),
    note: typeof artifact.note === "string" ? artifact.note.trim() : "",
    confidence: normalizeConfidence(artifact.confidence),
    state: normalizeSuggestionState(artifact.state),
    actor: normalizeReviewSuggestionActor(artifact.actor),
    createdAt: normalizeTimestamp(artifact.createdAt),
    updatedAt: normalizeTimestamp(artifact.updatedAt),
    provenance: {
      opinionArtifactPath: normalizeRequiredString(artifact.provenance?.opinionArtifactPath),
      sourceId: normalizeRequiredString(artifact.provenance?.sourceId),
      normalizedRecordPath: normalizeRequiredString(artifact.provenance?.normalizedRecordPath)
    }
  };
}

function normalizeReviewStatus(value: unknown): ReviewStatus {
  return isReviewStatus(value) ? value : "included";
}

function normalizeReviewStatusList(values: unknown): ReviewStatus[] {
  const list = Array.isArray(values) ? values.filter(isReviewStatus) : [];
  const unique = [...new Set(list)];
  return unique.length === 0 ? ["included"] : unique;
}

function normalizeReviewActor(actor: ReviewActor | undefined): ReviewActor {
  return {
    type: actor?.type === "machine" ? "machine" : "human",
    name: normalizeRequiredString(actor?.name, "local-admin")
  };
}

function normalizeReviewSuggestionActor(
  actor: ReviewSuggestionActor | undefined
): ReviewSuggestionActor {
  return {
    type: "machine",
    name: normalizeRequiredString(actor?.name, "machine-suggester")
  };
}

function normalizeReviewNote(value: unknown, status: unknown): string {
  const note = typeof value === "string" ? value.trim() : "";

  if (status === "excluded-admin" && note.length === 0) {
    throw new Error("Status 'excluded-admin' requires a non-empty note.");
  }

  return note;
}

function normalizeRequiredString(value: unknown, fallback = ""): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length === 0 ? fallback : normalized;
}

function normalizeTimestamp(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length === 0 ? new Date().toISOString() : normalized;
}

function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);

  if (Number.isNaN(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(1, numeric));
}

function normalizeSuggestionState(value: unknown): "proposed" | "accepted" | "rejected" {
  return value === "accepted" || value === "rejected" ? value : "proposed";
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
