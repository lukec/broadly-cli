import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig, type BroadlyProjectConfig } from "@broadly/config";
import { resolveProjectPaths, type ReviewStatus } from "@broadly/core";
import type { NormalizedCommentRecord } from "@broadly/ingest";

import { type RegisteredModel, runTextPromptWithModel } from "../modelRuntime.js";
import { withProjectActionLog } from "../projectLog.js";
import {
  loadCommentReview,
  loadCommentReviewSuggestion,
  loadOpinionReview,
  loadOpinionReviewSuggestion,
  upsertCommentReview,
  upsertCommentReviewSuggestion,
  upsertOpinionReview,
  upsertOpinionReviewSuggestion
} from "../reviewState.js";
import { resolveCommandProjectRoot } from "./projectDashboard.js";

export interface ReviewCommandOptions {
  project?: string;
  kind?: "comments" | "opinions" | "both";
  model?: string;
  concurrency?: number;
}

interface ReviewManifest {
  createdAt: string;
  updatedAt: string;
  kind: "comments" | "opinions" | "both";
  model: null | {
    name: string;
    provider: string;
    region: string;
    modelId: string;
  };
  prompt: {
    path: string | null;
    sha256: string | null;
  };
  thresholds: {
    machineReview: number;
    suggestion: number;
  };
  heuristics: string[];
  comments: ReviewSummary;
  opinions: ReviewSummary;
}

interface ReviewSummary {
  evaluated: number;
  llmEvaluated: number;
  machineReviewed: number;
  suggested: number;
  clearedMachineReviews: number;
  clearedSuggestions: number;
  duplicate: number;
  nonSubstantive: number;
  offTopic: number;
}

interface LoadedCommentEntry {
  subjectId: string;
  recordPath: string;
  record: NormalizedCommentRecord;
}

interface LoadedOpinionEntry {
  subjectId: string;
  artifactPath: string;
  sourceId: string;
  normalizedRecordPath: string;
  opinionText: string;
  excerpt: string;
  fullComment: string;
}

interface LoadedOpinionArtifact {
  opinionId?: string;
  opinionText?: string;
  excerpt?: string;
  sourceId?: string;
  fullComment?: string;
  provenance?: {
    normalizedRecordPath?: string;
  };
}

interface ProposedReviewOutcome {
  subjectId: string;
  kind: "comment" | "opinion";
  source: "heuristic" | "llm";
  action: "review" | "suggestion";
  status: ReviewStatus;
  reasonCode: string;
  note: string;
  confidence: number;
}

interface ParsedLlmReviewDecision {
  status: "included" | "excluded-non-substantive" | "excluded-off-topic";
  confidence: number;
  reasonCode: string;
  note: string;
}

interface ReviewTarget<TKind extends "comment" | "opinion"> {
  kind: TKind;
  subjectId: string;
  prompt: string;
  normalizedRecordPath: string;
  opinionArtifactPath?: string;
  sourceId?: string;
}

const MACHINE_REVIEW_THRESHOLD = 0.85;
const SUGGESTION_THRESHOLD = 0.55;
const DEFAULT_CONCURRENCY = 4;
const REVIEW_PROMPT_FILENAME = "review-screening.md";
const REVIEW_MACHINE_ACTOR = "review-llm";
const REVIEW_HEURISTIC_ACTOR = "review-heuristic";
const MACHINE_REVIEW_ACTORS = new Set([REVIEW_MACHINE_ACTOR, REVIEW_HEURISTIC_ACTOR]);

export async function runReview(options: ReviewCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const kind = options.kind ?? "both";
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  await withProjectActionLog({
    projectRoot,
    command: "review",
    details: {
      kind,
      model: options.model ?? "(configured)",
      concurrency
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = parseProjectConfig(await readFile(projectPaths.configPath, "utf8"));
      const reviewModel = resolveReviewModel(config, options.model);
      const promptPath = path.join(projectPaths.promptsDir, REVIEW_PROMPT_FILENAME);
      const promptTemplate = await readReviewPromptTemplate(promptPath);
      const comments =
        kind === "opinions"
          ? []
          : await loadNormalizedComments(path.join(projectPaths.dataDir, "normalized"));
      const opinions =
        kind === "comments"
          ? []
          : await loadDistinctOpinions(path.join(projectPaths.dataDir, "opinions"));

      const heuristicCommentOutcomes = proposeHeuristicCommentOutcomes(comments);
      const heuristicOpinionOutcomes = proposeHeuristicOpinionOutcomes(opinions);

      const llmCommentTargets =
        reviewModel === null
          ? []
          : await buildCommentReviewTargets(projectPaths, comments, heuristicCommentOutcomes, config);
      const llmOpinionTargets =
        reviewModel === null
          ? []
          : await buildOpinionReviewTargets(projectPaths, opinions, heuristicOpinionOutcomes, config);

      const llmCommentOutcomes =
        reviewModel === null
          ? []
          : await runReviewTargetsWithModel(
              llmCommentTargets,
              reviewModel,
              promptTemplate,
              projectRoot,
              concurrency
            );
      const llmOpinionOutcomes =
        reviewModel === null
          ? []
          : await runReviewTargetsWithModel(
              llmOpinionTargets,
              reviewModel,
              promptTemplate,
              projectRoot,
              concurrency
            );

      const activeCommentOutcomes = selectBestOutcomes(
        [...heuristicCommentOutcomes, ...llmCommentOutcomes],
        "comment"
      );
      const activeOpinionOutcomes = selectBestOutcomes(
        [...heuristicOpinionOutcomes, ...llmOpinionOutcomes],
        "opinion"
      );

      const commentApplySummary = await applyCommentOutcomes(projectPaths, comments, activeCommentOutcomes);
      const opinionApplySummary = await applyOpinionOutcomes(projectPaths, opinions, activeOpinionOutcomes);
      const manifestPath = path.join(projectPaths.reviewDir, "review-manifest.json");
      const manifest: ReviewManifest = {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        kind,
        model:
          reviewModel === null
            ? null
            : {
                name: reviewModel.name,
                provider: reviewModel.provider,
                region: reviewModel.region,
                modelId: reviewModel.modelId
              },
        prompt: {
          path: reviewModel === null ? null : promptPath,
          sha256: reviewModel === null ? null : simpleHash(promptTemplate)
        },
        thresholds: {
          machineReview: MACHINE_REVIEW_THRESHOLD,
          suggestion: SUGGESTION_THRESHOLD
        },
        heuristics: ["normalized-exact-duplicate", "short-non-substantive"],
        comments: {
          evaluated: comments.length,
          llmEvaluated: llmCommentTargets.length,
          machineReviewed: commentApplySummary.machineReviewed,
          suggested: commentApplySummary.suggested,
          clearedMachineReviews: commentApplySummary.clearedMachineReviews,
          clearedSuggestions: commentApplySummary.clearedSuggestions,
          duplicate: countOutcomeStatus(activeCommentOutcomes, "excluded-duplicate"),
          nonSubstantive: countOutcomeStatus(activeCommentOutcomes, "excluded-non-substantive"),
          offTopic: countOutcomeStatus(activeCommentOutcomes, "excluded-off-topic")
        },
        opinions: {
          evaluated: opinions.length,
          llmEvaluated: llmOpinionTargets.length,
          machineReviewed: opinionApplySummary.machineReviewed,
          suggested: opinionApplySummary.suggested,
          clearedMachineReviews: opinionApplySummary.clearedMachineReviews,
          clearedSuggestions: opinionApplySummary.clearedSuggestions,
          duplicate: countOutcomeStatus(activeOpinionOutcomes, "excluded-duplicate"),
          nonSubstantive: countOutcomeStatus(activeOpinionOutcomes, "excluded-non-substantive"),
          offTopic: countOutcomeStatus(activeOpinionOutcomes, "excluded-off-topic")
        }
      };

      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const lines = [
        `Generated review outcomes for ${projectRoot}`,
        "",
        `Kind: ${kind}`,
        `Model: ${reviewModel === null ? "none (heuristics only)" : formatModelLabel(reviewModel)}`,
        `Comments: reviewed=${manifest.comments.machineReviewed} · suggested=${manifest.comments.suggested} · llm=${manifest.comments.llmEvaluated}`,
        `  duplicate=${manifest.comments.duplicate} · non-substantive=${manifest.comments.nonSubstantive} · off-topic=${manifest.comments.offTopic}`,
        `Opinions: reviewed=${manifest.opinions.machineReviewed} · suggested=${manifest.opinions.suggested} · llm=${manifest.opinions.llmEvaluated}`,
        `  duplicate=${manifest.opinions.duplicate} · non-substantive=${manifest.opinions.nonSubstantive} · off-topic=${manifest.opinions.offTopic}`,
        `Manifest: ${toPortableRelativePath(projectRoot, manifestPath)}`
      ];

      process.stdout.write(`${lines.join("\n")}\n`);
    }
  });
}

async function loadNormalizedComments(normalizedDir: string): Promise<LoadedCommentEntry[]> {
  const entries = await readdir(normalizedDir, { withFileTypes: true }).catch(() => []);
  const records: LoadedCommentEntry[] = [];

  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".json") && item.name !== "ingest-manifest.json")
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const recordPath = path.join(normalizedDir, entry.name);
    const record = await readJsonFile<NormalizedCommentRecord>(recordPath);

    if (record === null) {
      continue;
    }

    records.push({
      subjectId: record.sourceId,
      recordPath,
      record
    });
  }

  return records.sort((left, right) => {
    const leftRow = left.record.provenance.sourceRowNumber ?? Number.MAX_SAFE_INTEGER;
    const rightRow = right.record.provenance.sourceRowNumber ?? Number.MAX_SAFE_INTEGER;
    return leftRow - rightRow || left.subjectId.localeCompare(right.subjectId);
  });
}

async function loadDistinctOpinions(opinionsRootDir: string): Promise<LoadedOpinionEntry[]> {
  const runEntries = await readdir(opinionsRootDir, { withFileTypes: true }).catch(() => []);
  const sortedRuns = runEntries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => right.name.localeCompare(left.name));
  const opinions = new Map<string, LoadedOpinionEntry>();

  for (const runEntry of sortedRuns) {
    const opinionsDir = path.join(opinionsRootDir, runEntry.name, "opinions");
    const entries = await readdir(opinionsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries
      .filter((item) => item.isFile() && item.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const artifactPath = path.join(opinionsDir, entry.name);
      const artifact = await readJsonFile<LoadedOpinionArtifact>(artifactPath);

      if (
        artifact?.opinionId === undefined ||
        artifact.opinionText === undefined ||
        artifact.sourceId === undefined ||
        artifact.provenance?.normalizedRecordPath === undefined ||
        opinions.has(artifact.opinionId)
      ) {
        continue;
      }

      const sourceRecord = await readJsonFile<NormalizedCommentRecord>(artifact.provenance.normalizedRecordPath);

      opinions.set(artifact.opinionId, {
        subjectId: artifact.opinionId,
        artifactPath,
        sourceId: artifact.sourceId,
        normalizedRecordPath: artifact.provenance.normalizedRecordPath,
        opinionText: artifact.opinionText,
        excerpt: artifact.excerpt ?? "",
        fullComment: sourceRecord?.contentText ?? artifact.fullComment ?? ""
      });
    }
  }

  return [...opinions.values()].sort((left, right) => left.subjectId.localeCompare(right.subjectId));
}

function proposeHeuristicCommentOutcomes(
  comments: LoadedCommentEntry[]
): ProposedReviewOutcome[] {
  const outcomes: ProposedReviewOutcome[] = [];
  const duplicateGroups = buildDuplicateGroups(
    comments.map((entry) => ({
      id: entry.subjectId,
      canonicalOrder: entry.record.provenance.sourceRowNumber ?? Number.MAX_SAFE_INTEGER,
      text: entry.record.contentText
    }))
  );

  for (const group of duplicateGroups) {
    const canonical = group[0];

    if (canonical === undefined) {
      continue;
    }

    for (const duplicate of group.slice(1)) {
      outcomes.push({
        subjectId: duplicate.id,
        kind: "comment",
        source: "heuristic",
        action: "review",
        status: "excluded-duplicate",
        reasonCode: "normalized-exact-duplicate",
        note: `Matches comment ${canonical.id} after whitespace-normalized comparison.`,
        confidence: 0.99
      });
    }
  }

  for (const comment of comments) {
    if (outcomes.some((item) => item.subjectId === comment.subjectId)) {
      continue;
    }

    const outcome = detectShortNonSubstantive(comment.record.contentText, "comment", comment.subjectId);

    if (outcome !== null) {
      outcomes.push(outcome);
    }
  }

  return outcomes;
}

function proposeHeuristicOpinionOutcomes(
  opinions: LoadedOpinionEntry[]
): ProposedReviewOutcome[] {
  const outcomes: ProposedReviewOutcome[] = [];
  const duplicateGroups = buildDuplicateGroups(
    opinions.map((entry) => ({
      id: entry.subjectId,
      canonicalOrder: Number.MAX_SAFE_INTEGER,
      text: entry.opinionText
    }))
  );

  for (const group of duplicateGroups) {
    const canonical = group[0];

    if (canonical === undefined) {
      continue;
    }

    for (const duplicate of group.slice(1)) {
      outcomes.push({
        subjectId: duplicate.id,
        kind: "opinion",
        source: "heuristic",
        action: "review",
        status: "excluded-duplicate",
        reasonCode: "normalized-exact-duplicate",
        note: `Matches opinion ${canonical.id} after whitespace-normalized comparison.`,
        confidence: 0.99
      });
    }
  }

  for (const opinion of opinions) {
    if (outcomes.some((item) => item.subjectId === opinion.subjectId)) {
      continue;
    }

    const outcome = detectShortNonSubstantive(opinion.opinionText, "opinion", opinion.subjectId);

    if (outcome !== null) {
      outcomes.push(outcome);
    }
  }

  return outcomes;
}

function detectShortNonSubstantive(
  value: string,
  kind: "comment" | "opinion",
  subjectId: string
): ProposedReviewOutcome | null {
  const normalized = normalizeDuplicateKey(value);

  if (normalized.length === 0) {
    return null;
  }

  const wordCount = normalized.split(" ").filter(Boolean).length;

  if (wordCount > 6) {
    return null;
  }

  const phraseSet = new Set([
    "thanks",
    "thank you",
    "thank you for this",
    "great work",
    "good work",
    "good job",
    "nice work",
    "nice",
    "cool",
    "awesome",
    "looks good",
    "sounds good",
    "love this",
    "i agree",
    "agree",
    "following",
    "test",
    "ok",
    "okay"
  ]);

  if (phraseSet.has(normalized) === false) {
    return null;
  }

  return {
    subjectId,
    kind,
    source: "heuristic",
    action: "review",
    status: "excluded-non-substantive",
    reasonCode: "short-non-substantive",
    note: `Matched short non-substantive heuristic phrase '${normalized}'.`,
    confidence: normalized === "test" || normalized === "following" ? 0.94 : 0.9
  };
}

function buildDuplicateGroups(
  items: Array<{ id: string; canonicalOrder: number; text: string }>
): Array<Array<{ id: string; canonicalOrder: number; text: string }>> {
  const byKey = new Map<string, Array<{ id: string; canonicalOrder: number; text: string }>>();

  for (const item of items) {
    const key = normalizeDuplicateKey(item.text);

    if (key.length === 0) {
      continue;
    }

    const group = byKey.get(key) ?? [];
    group.push(item);
    byKey.set(key, group);
  }

  return [...byKey.values()]
    .filter((group) => group.length > 1)
    .map((group) =>
      [...group].sort(
        (left, right) => left.canonicalOrder - right.canonicalOrder || left.id.localeCompare(right.id)
      )
    );
}

function normalizeDuplicateKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function buildCommentReviewTargets(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  comments: LoadedCommentEntry[],
  heuristicOutcomes: ProposedReviewOutcome[],
  config: BroadlyProjectConfig
): Promise<Array<ReviewTarget<"comment">>> {
  const heuristicIds = new Set(heuristicOutcomes.map((item) => item.subjectId));
  const targets: Array<ReviewTarget<"comment">> = [];

  for (const comment of comments) {
    if (heuristicIds.has(comment.subjectId)) {
      continue;
    }

    const review = await loadCommentReview(projectPaths, comment.subjectId);

    if (review?.actor.type === "human") {
      continue;
    }

    targets.push({
      kind: "comment",
      subjectId: comment.subjectId,
      normalizedRecordPath: comment.recordPath,
      prompt: renderCommentReviewPrompt(config, comment)
    });
  }

  return targets;
}

async function buildOpinionReviewTargets(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  opinions: LoadedOpinionEntry[],
  heuristicOutcomes: ProposedReviewOutcome[],
  config: BroadlyProjectConfig
): Promise<Array<ReviewTarget<"opinion">>> {
  const heuristicIds = new Set(heuristicOutcomes.map((item) => item.subjectId));
  const targets: Array<ReviewTarget<"opinion">> = [];

  for (const opinion of opinions) {
    if (heuristicIds.has(opinion.subjectId)) {
      continue;
    }

    const review = await loadOpinionReview(projectPaths, opinion.subjectId);

    if (review?.actor.type === "human") {
      continue;
    }

    targets.push({
      kind: "opinion",
      subjectId: opinion.subjectId,
      normalizedRecordPath: opinion.normalizedRecordPath,
      opinionArtifactPath: opinion.artifactPath,
      sourceId: opinion.sourceId,
      prompt: renderOpinionReviewPrompt(config, opinion)
    });
  }

  return targets;
}

async function runReviewTargetsWithModel<TKind extends "comment" | "opinion">(
  targets: Array<ReviewTarget<TKind>>,
  model: RegisteredModel,
  promptTemplate: string,
  projectRoot: string,
  concurrency: number
): Promise<ProposedReviewOutcome[]> {
  const outcomes: ProposedReviewOutcome[] = [];
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, async () => {
    while (nextIndex < targets.length) {
      const target = targets[nextIndex];
      nextIndex += 1;

      if (target === undefined) {
        continue;
      }

      try {
        const result = await runTextPromptWithModel({
          model,
          prompt: `${promptTemplate.trim()}\n\n${target.prompt}`,
          maxOutputTokens: 240,
          projectRoot,
          temperature: 0
        });
        const parsed = parseLlmReviewDecision(result.text);

        if (parsed.status === "included") {
          continue;
        }

        const action =
          parsed.confidence >= MACHINE_REVIEW_THRESHOLD
            ? "review"
            : parsed.confidence >= SUGGESTION_THRESHOLD
              ? "suggestion"
              : null;

        if (action === null) {
          continue;
        }

        outcomes.push({
          subjectId: target.subjectId,
          kind: target.kind,
          source: "llm",
          action,
          status: parsed.status,
          reasonCode: parsed.reasonCode,
          note: parsed.note,
          confidence: parsed.confidence
        });
      } catch {
        // Best-effort review pass. Failures should not block the whole command.
      }
    }
  });

  await Promise.all(workers);
  return outcomes;
}

function parseLlmReviewDecision(source: string): ParsedLlmReviewDecision {
  const status = normalizeLlmDecisionHeader(extractHeaderValue(source, "Decision"));
  const confidence = normalizeConfidence(extractHeaderValue(source, "Confidence"));
  const reasonCode = normalizeReasonCode(extractHeaderValue(source, "Reason-Code"), status);
  const note = normalizeNote(extractHeaderValue(source, "Note"), status);

  return {
    status,
    confidence,
    reasonCode,
    note
  };
}

function normalizeLlmDecisionHeader(
  value: string | null
): ParsedLlmReviewDecision["status"] {
  if (
    value === "included" ||
    value === "excluded-non-substantive" ||
    value === "excluded-off-topic"
  ) {
    return value;
  }

  return "included";
}

function extractHeaderValue(source: string, header: string): string | null {
  const pattern = new RegExp(`^${header}:\\s*(.+)$`, "im");
  const match = source.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function normalizeConfidence(value: string | null): number {
  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    return 0;
  }

  return Math.max(0, Math.min(1, parsed));
}

function normalizeReasonCode(
  value: string | null,
  status: ParsedLlmReviewDecision["status"]
): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-") ?? "";

  if (normalized.length > 0) {
    return normalized;
  }

  return status === "excluded-off-topic" ? "llm-off-topic" : "llm-non-substantive";
}

function normalizeNote(
  value: string | null,
  status: ParsedLlmReviewDecision["status"]
): string {
  if (value !== null && value.trim().length > 0) {
    return value.trim();
  }

  return status === "excluded-off-topic"
    ? "LLM review judged this item off-topic for the project questions."
    : "LLM review judged this item non-substantive for analysis.";
}

function selectBestOutcomes(
  outcomes: ProposedReviewOutcome[],
  kind: "comment" | "opinion"
): Map<string, ProposedReviewOutcome> {
  const selected = new Map<string, ProposedReviewOutcome>();

  for (const outcome of outcomes.filter((item) => item.kind === kind)) {
    const existing = selected.get(outcome.subjectId);

    if (existing === undefined) {
      selected.set(outcome.subjectId, outcome);
      continue;
    }

    if (outcome.action === "review" && existing.action === "suggestion") {
      selected.set(outcome.subjectId, outcome);
      continue;
    }

    if (outcome.action === existing.action && outcome.confidence > existing.confidence) {
      selected.set(outcome.subjectId, outcome);
    }
  }

  return selected;
}

async function applyCommentOutcomes(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  comments: LoadedCommentEntry[],
  activeOutcomes: Map<string, ProposedReviewOutcome>
): Promise<{
  machineReviewed: number;
  suggested: number;
  clearedMachineReviews: number;
  clearedSuggestions: number;
}> {
  let machineReviewed = 0;
  let suggested = 0;

  for (const comment of comments) {
    const outcome = activeOutcomes.get(comment.subjectId);
    const review = await loadCommentReview(projectPaths, comment.subjectId);

    if (review?.actor.type === "human") {
      continue;
    }

    if (outcome?.action === "review") {
      await upsertCommentReview(projectPaths, {
        subjectId: comment.subjectId,
        status: outcome.status,
        reasonCode: outcome.reasonCode,
        note: outcome.note,
        actor: {
          type: "machine",
          name: outcome.source === "heuristic" ? REVIEW_HEURISTIC_ACTOR : REVIEW_MACHINE_ACTOR
        },
        normalizedRecordPath: comment.recordPath
      });
      machineReviewed += 1;
    }

    if (outcome?.action === "suggestion") {
      const existingSuggestion = await loadCommentReviewSuggestion(projectPaths, comment.subjectId);
      await upsertCommentReviewSuggestion(projectPaths, {
        subjectId: comment.subjectId,
        suggestedStatus: outcome.status,
        reasonCode: outcome.reasonCode,
        note: outcome.note,
        confidence: outcome.confidence,
        state:
          existingSuggestion?.state === "accepted" || existingSuggestion?.state === "rejected"
            ? existingSuggestion.state
            : "proposed",
        actor: { type: "machine", name: outcome.source === "heuristic" ? REVIEW_HEURISTIC_ACTOR : REVIEW_MACHINE_ACTOR },
        normalizedRecordPath: comment.recordPath
      });
      suggested += 1;
    }
  }

  const clearedMachineReviews = await clearStaleMachineCommentReviews(
    projectPaths,
    activeOutcomes,
    comments
  );
  const clearedSuggestions = await clearStaleCommentSuggestions(projectPaths, activeOutcomes);

  return { machineReviewed, suggested, clearedMachineReviews, clearedSuggestions };
}

async function applyOpinionOutcomes(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  opinions: LoadedOpinionEntry[],
  activeOutcomes: Map<string, ProposedReviewOutcome>
): Promise<{
  machineReviewed: number;
  suggested: number;
  clearedMachineReviews: number;
  clearedSuggestions: number;
}> {
  let machineReviewed = 0;
  let suggested = 0;

  for (const opinion of opinions) {
    const outcome = activeOutcomes.get(opinion.subjectId);
    const review = await loadOpinionReview(projectPaths, opinion.subjectId);

    if (review?.actor.type === "human") {
      continue;
    }

    if (outcome?.action === "review") {
      await upsertOpinionReview(projectPaths, {
        subjectId: opinion.subjectId,
        status: outcome.status,
        reasonCode: outcome.reasonCode,
        note: outcome.note,
        actor: {
          type: "machine",
          name: outcome.source === "heuristic" ? REVIEW_HEURISTIC_ACTOR : REVIEW_MACHINE_ACTOR
        },
        opinionArtifactPath: opinion.artifactPath,
        sourceId: opinion.sourceId,
        normalizedRecordPath: opinion.normalizedRecordPath
      });
      machineReviewed += 1;
    }

    if (outcome?.action === "suggestion") {
      const existingSuggestion = await loadOpinionReviewSuggestion(projectPaths, opinion.subjectId);
      await upsertOpinionReviewSuggestion(projectPaths, {
        subjectId: opinion.subjectId,
        suggestedStatus: outcome.status,
        reasonCode: outcome.reasonCode,
        note: outcome.note,
        confidence: outcome.confidence,
        state:
          existingSuggestion?.state === "accepted" || existingSuggestion?.state === "rejected"
            ? existingSuggestion.state
            : "proposed",
        actor: { type: "machine", name: outcome.source === "heuristic" ? REVIEW_HEURISTIC_ACTOR : REVIEW_MACHINE_ACTOR },
        opinionArtifactPath: opinion.artifactPath,
        sourceId: opinion.sourceId,
        normalizedRecordPath: opinion.normalizedRecordPath
      });
      suggested += 1;
    }
  }

  const clearedMachineReviews = await clearStaleMachineOpinionReviews(
    projectPaths,
    activeOutcomes,
    opinions
  );
  const clearedSuggestions = await clearStaleOpinionSuggestions(projectPaths, activeOutcomes);

  return { machineReviewed, suggested, clearedMachineReviews, clearedSuggestions };
}

async function clearStaleMachineCommentReviews(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  activeOutcomes: Map<string, ProposedReviewOutcome>,
  comments: LoadedCommentEntry[]
): Promise<number> {
  let cleared = 0;

  for (const comment of comments) {
    const review = await loadCommentReview(projectPaths, comment.subjectId);

    if (
      review?.actor.type === "machine" &&
      MACHINE_REVIEW_ACTORS.has(review.actor.name) &&
      activeOutcomes.get(comment.subjectId)?.action !== "review"
    ) {
      await rm(path.join(projectPaths.reviewCommentsDir, `${comment.subjectId}.json`), { force: true });
      cleared += 1;
    }
  }

  return cleared;
}

async function clearStaleMachineOpinionReviews(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  activeOutcomes: Map<string, ProposedReviewOutcome>,
  opinions: LoadedOpinionEntry[]
): Promise<number> {
  let cleared = 0;

  for (const opinion of opinions) {
    const review = await loadOpinionReview(projectPaths, opinion.subjectId);

    if (
      review?.actor.type === "machine" &&
      MACHINE_REVIEW_ACTORS.has(review.actor.name) &&
      activeOutcomes.get(opinion.subjectId)?.action !== "review"
    ) {
      await rm(path.join(projectPaths.reviewOpinionsDir, `${opinion.subjectId}.json`), { force: true });
      cleared += 1;
    }
  }

  return cleared;
}

async function clearStaleCommentSuggestions(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  activeOutcomes: Map<string, ProposedReviewOutcome>
): Promise<number> {
  const entries = await readdir(projectPaths.reviewCommentSuggestionsDir, { withFileTypes: true }).catch(() => []);
  let cleared = 0;

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".json") === false) {
      continue;
    }

    const subjectId = entry.name.replace(/\.json$/u, "");
    const suggestion = await loadCommentReviewSuggestion(projectPaths, subjectId);

    if (
      suggestion?.state === "proposed" &&
      activeOutcomes.get(subjectId)?.action !== "suggestion"
    ) {
      await rm(path.join(projectPaths.reviewCommentSuggestionsDir, entry.name), { force: true });
      cleared += 1;
    }
  }

  return cleared;
}

async function clearStaleOpinionSuggestions(
  projectPaths: ReturnType<typeof resolveProjectPaths>,
  activeOutcomes: Map<string, ProposedReviewOutcome>
): Promise<number> {
  const entries = await readdir(projectPaths.reviewOpinionSuggestionsDir, { withFileTypes: true }).catch(() => []);
  let cleared = 0;

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".json") === false) {
      continue;
    }

    const subjectId = entry.name.replace(/\.json$/u, "");
    const suggestion = await loadOpinionReviewSuggestion(projectPaths, subjectId);

    if (
      suggestion?.state === "proposed" &&
      activeOutcomes.get(subjectId)?.action !== "suggestion"
    ) {
      await rm(path.join(projectPaths.reviewOpinionSuggestionsDir, entry.name), { force: true });
      cleared += 1;
    }
  }

  return cleared;
}

function countOutcomeStatus(
  outcomes: Map<string, ProposedReviewOutcome>,
  status: ReviewStatus
): number {
  return [...outcomes.values()].filter((item) => item.status === status).length;
}

function renderCommentReviewPrompt(
  config: BroadlyProjectConfig,
  comment: LoadedCommentEntry
): string {
  return [
    "Project-Name:",
    config.project.name,
    "",
    "Project-Questions:",
    ...config.questions.map((question, index) => `${index + 1}. ${question}`),
    "",
    "Item-Kind:",
    "comment",
    "",
    "Source-ID:",
    comment.subjectId,
    "",
    "Comment-Text:",
    comment.record.contentText
  ].join("\n");
}

function renderOpinionReviewPrompt(
  config: BroadlyProjectConfig,
  opinion: LoadedOpinionEntry
): string {
  return [
    "Project-Name:",
    config.project.name,
    "",
    "Project-Questions:",
    ...config.questions.map((question, index) => `${index + 1}. ${question}`),
    "",
    "Item-Kind:",
    "opinion",
    "",
    "Opinion-ID:",
    opinion.subjectId,
    "",
    "Source-ID:",
    opinion.sourceId,
    "",
    "Opinion-Text:",
    opinion.opinionText,
    "",
    "Source-Excerpt:",
    opinion.excerpt.length === 0 ? "(none)" : opinion.excerpt,
    "",
    "Full-Comment:",
    opinion.fullComment.length === 0 ? "(none)" : opinion.fullComment
  ].join("\n");
}

async function readReviewPromptTemplate(promptPath: string): Promise<string> {
  try {
    return await readFile(promptPath, "utf8");
  } catch {
    return createFallbackReviewPrompt();
  }
}

function createFallbackReviewPrompt(): string {
  return [
    "You are helping Broadly screen public-input items for analysis quality control.",
    "Be conservative and prefer included unless exclusion is well supported.",
    "Only use excluded-non-substantive for greetings, filler, praise, logistics, or text that does not express a meaningful opinion.",
    "Only use excluded-off-topic when the content is clearly unrelated to the project questions.",
    "Do not use excluded-duplicate or excluded-admin.",
    "Return plain text only using exactly these headers:",
    "Decision: included | excluded-non-substantive | excluded-off-topic",
    "Confidence: 0.00 to 1.00",
    "Reason-Code: short-kebab-case-code",
    "Note: one short sentence explaining the judgment"
  ].join("\n");
}

function resolveReviewModel(
  config: BroadlyProjectConfig,
  explicitModelAlias: string | undefined
): RegisteredModel | null {
  const alias = explicitModelAlias ?? config.review_model ?? config.qa_model;

  if (alias === undefined) {
    return null;
  }

  const model = config.models.find((item) => item.name === alias);

  if (model === undefined) {
    throw new Error(`Review model '${alias}' is not registered in broadly.yaml.`);
  }

  return model;
}

function formatModelLabel(model: RegisteredModel): string {
  return `${model.name} (${model.provider} · ${model.region} · ${model.modelId})`;
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

function simpleHash(value: string): string {
  let hash = 0;

  for (const character of value) {
    hash = Math.imul(31, hash) + character.charCodeAt(0);
    hash |= 0;
  }

  return String(Math.abs(hash));
}
