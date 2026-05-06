import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  getAnalysisViewConfig,
  parseProjectConfig,
  type BroadlyProjectConfig
} from "@broadly/config";
import {
  resolveProjectPaths,
  sha256Hex,
  type ProjectPaths,
  type ReviewConfig,
  type ReviewStatus
} from "@broadly/core";

import { readCurrentRunId } from "../projectArtifacts.js";
import { withProjectActionLog } from "../projectLog.js";
import {
  ensureProjectReviewState,
  loadCommentReview,
  loadOpinionReview,
  resolveEffectiveOpinionReviewStatus
} from "../reviewState.js";
import { resolveCommandProjectRoot } from "./projectDashboard.js";

export const CODEX_GOLD_STANDARD_STRATEGY = "codex-gold-standard";

export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface CodexGoldStandardAnalysisOptions {
  project?: string;
  extraction?: string;
  opinionRun?: string;
  run?: string;
  limit?: number;
  offset?: number;
  batchSize?: number;
  model?: string;
  reasoning?: CodexReasoningEffort;
  codexBin?: string;
  dryRun?: boolean;
  force?: boolean;
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

interface OpinionRunManifest {
  createdAt: string;
  runId: string;
  extraction?: {
    name?: string;
    title?: string;
  };
  model?: {
    name?: string;
    provider?: string;
    region?: string;
    modelId?: string;
  };
}

interface LoadedOpinionRun {
  runId: string;
  runDir: string;
  opinionsDir: string;
  manifest: OpinionRunManifest;
}

interface GoldOpinion {
  opinionId: string;
  sourceId: string;
  opinionText: string;
  excerpt?: string;
  provenance: {
    normalizedRecordPath?: string;
    sourceImportPath?: string;
    sourceFileSha256?: string;
    sourceRowNumber?: number;
    externalId?: string;
  };
}

interface GoldOpinionBatch {
  batchId: string;
  batchIndex: number;
  opinionCount: number;
  opinions: GoldOpinion[];
}

interface ReviewStatusCounts {
  included: number;
  "excluded-non-substantive": number;
  "excluded-off-topic": number;
  "excluded-admin": number;
  "excluded-duplicate": number;
}

interface SelectedOpinions {
  allOpinionCount: number;
  includedOpinionCount: number;
  selectedOpinions: GoldOpinion[];
  excludedOpinionCount: number;
  excludedByStatus: ReviewStatusCounts;
}

interface GoldRunPaths {
  runDir: string;
  manifestPath: string;
  inputsDir: string;
  batchesDir: string;
  schemasDir: string;
  promptsDir: string;
  codexEventsDir: string;
  codexStderrDir: string;
  batchTaxonomiesDir: string;
  batchAssignmentsDir: string;
  opinionsJsonlPath: string;
  taxonomyPath: string;
  assignmentsJsonlPath: string;
  assignmentSummaryPath: string;
}

interface GoldRunFingerprint {
  version: string;
  sha256: string;
  opinionRunId: string;
  sourceExtraction: string;
  opinionCount: number;
  selectedOpinionIdsSha256: string;
  selectedOpinionTextsSha256: string;
  reviewConfigSha256: string;
  offset: number;
  limit?: number;
  batchSize: number;
  model: string;
  reasoningEffort: CodexReasoningEffort;
}

interface CodexGoldStandardManifest {
  runId: string;
  kind: "codex-gold-standard-analysis";
  strategy: typeof CODEX_GOLD_STANDARD_STRATEGY;
  createdAt: string;
  updatedAt: string;
  status: "prepared" | "running" | "ready" | "failed" | "dry-run";
  project: {
    name: string;
    slug: string;
    rootDir: string;
    configPath: string;
  };
  model: {
    provider: "codex-cli";
    modelId: string;
    reasoningEffort: CodexReasoningEffort;
    codexBin: string;
  };
  input: {
    sourceExtraction: string;
    opinionRunId: string;
    opinionRunDir: string;
    opinionsDir: string;
    opinionsAvailable: number;
    opinionsIncludedByReview: number;
    opinionsSelected: number;
    offset: number;
    limit?: number;
    batchSize: number;
    review: {
      configPath: string;
      configSha256: string;
      includeCommentStatuses: ReviewStatus[];
      includeOpinionStatuses: ReviewStatus[];
      excludedOpinions: number;
      excludedByStatus: ReviewStatusCounts;
    };
  };
  fingerprint: GoldRunFingerprint;
  output: {
    runDir: string;
    opinionsJsonlPath: string;
    batchesDir: string;
    schemasDir: string;
    promptsDir: string;
    codexEventsDir: string;
    codexStderrDir: string;
    batchTaxonomiesDir: string;
    taxonomyPath: string;
    batchAssignmentsDir: string;
    assignmentsJsonlPath: string;
    assignmentSummaryPath: string;
  };
  stages: {
    batchTaxonomies: StageProgress;
    taxonomyMerge: StageProgress;
    assignments: StageProgress;
  };
  error?: string;
}

interface StageProgress {
  status: "pending" | "running" | "ready" | "failed" | "skipped";
  total: number;
  completed: number;
  reused: number;
  failed: number;
}

interface CodexExecResult {
  outputPath: string;
  eventsPath: string;
  stderrPath: string;
  elapsedMs: number;
}

const GOLD_STANDARD_VERSION = "codex-gold-standard-v2";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = "medium";
const DEFAULT_BATCH_SIZE = 80;

const batchTaxonomySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Broadly Codex Gold Standard Batch Taxonomy",
  type: "object",
  additionalProperties: false,
  required: ["batch_id", "themes", "unassigned_opinion_ids", "notes"],
  properties: {
    batch_id: { type: "string" },
    themes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "theme_id",
          "label",
          "summary",
          "inclusion_rule",
          "exclusion_rule",
          "opinion_ids",
          "representative_opinion_ids",
          "policy_significance",
          "minority_theme"
        ],
        properties: {
          theme_id: { type: "string" },
          label: { type: "string" },
          summary: { type: "string" },
          inclusion_rule: { type: "string" },
          exclusion_rule: { type: "string" },
          opinion_ids: { type: "array", items: { type: "string" } },
          representative_opinion_ids: { type: "array", items: { type: "string" } },
          policy_significance: { type: "string" },
          minority_theme: { type: "boolean" }
        }
      }
    },
    unassigned_opinion_ids: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } }
  }
} as const;

const mergedTaxonomySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Broadly Codex Gold Standard Taxonomy",
  type: "object",
  additionalProperties: false,
  required: ["taxonomy_id", "categories", "themes", "missing_or_uncertain_areas", "notes"],
  properties: {
    taxonomy_id: { type: "string" },
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "category_id",
          "label",
          "summary",
          "inclusion_rule",
          "exclusion_rule",
          "subgroup_theme_ids"
        ],
        properties: {
          category_id: { type: "string" },
          label: { type: "string" },
          summary: { type: "string" },
          inclusion_rule: { type: "string" },
          exclusion_rule: { type: "string" },
          subgroup_theme_ids: { type: "array", items: { type: "string" } }
        }
      }
    },
    themes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "theme_id",
          "parent_category_id",
          "label",
          "summary",
          "inclusion_rule",
          "exclusion_rule",
          "distinguishing_features",
          "representative_opinion_ids",
          "merged_from_batch_theme_ids",
          "expected_false_friends"
        ],
        properties: {
          theme_id: { type: "string" },
          parent_category_id: { type: "string" },
          label: { type: "string" },
          summary: { type: "string" },
          inclusion_rule: { type: "string" },
          exclusion_rule: { type: "string" },
          distinguishing_features: { type: "array", items: { type: "string" } },
          representative_opinion_ids: { type: "array", items: { type: "string" } },
          merged_from_batch_theme_ids: { type: "array", items: { type: "string" } },
          expected_false_friends: { type: "array", items: { type: "string" } }
        }
      }
    },
    missing_or_uncertain_areas: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } }
  }
} as const;

const assignmentSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Broadly Codex Gold Standard Batch Assignments",
  type: "object",
  additionalProperties: false,
  required: ["batch_id", "assignments", "new_theme_suggestions", "notes"],
  properties: {
    batch_id: { type: "string" },
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "opinion_id",
          "primary_category_id",
          "primary_theme_id",
          "secondary_theme_ids",
          "confidence",
          "fit",
          "uncertainty_flag",
          "rationale",
          "evidence_quote",
          "false_friend_check"
        ],
        properties: {
          opinion_id: { type: "string" },
          primary_category_id: { type: ["string", "null"] },
          primary_theme_id: { type: ["string", "null"] },
          secondary_theme_ids: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          fit: {
            type: "string",
            enum: ["clear", "partial", "uncertain", "out_of_scope"]
          },
          uncertainty_flag: { type: "boolean" },
          rationale: { type: "string" },
          evidence_quote: { type: "string" },
          false_friend_check: {
            type: "object",
            additionalProperties: false,
            required: ["exclusion_rule_checked", "nearest_false_friend_theme_ids", "note"],
            properties: {
              exclusion_rule_checked: { type: "boolean" },
              nearest_false_friend_theme_ids: { type: "array", items: { type: "string" } },
              note: { type: "string" }
            }
          }
        }
      }
    },
    new_theme_suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "rationale", "opinion_ids"],
        properties: {
          label: { type: "string" },
          rationale: { type: "string" },
          opinion_ids: { type: "array", items: { type: "string" } }
        }
      }
    },
    notes: { type: "array", items: { type: "string" } }
  }
} as const;

export async function runCodexGoldStandardAnalysis(
  options: CodexGoldStandardAnalysisOptions
): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const model = options.model ?? DEFAULT_CODEX_MODEL;
  const reasoning = options.reasoning ?? DEFAULT_REASONING_EFFORT;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const codexBin = options.codexBin ?? process.env.BROADLY_CODEX_BIN ?? "codex";

  if (batchSize <= 0 || Number.isInteger(batchSize) === false) {
    throw new Error("--batch-size must be a positive integer.");
  }

  await withProjectActionLog({
    projectRoot,
    command: "analysis codex-gold-standard",
    details: {
      extraction: options.extraction ?? "(configured)",
      opinionRun: options.opinionRun ?? "(latest)",
      run: options.run ?? "(new)",
      model,
      reasoning,
      batchSize,
      limit: options.limit,
      offset: options.offset,
      dryRun: options.dryRun === true,
      force: options.force === true
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = await loadProjectConfig(projectPaths.configPath);
      const reviewConfig = await ensureProjectReviewState(projectPaths);
      const reviewConfigSha256 = sha256Hex(JSON.stringify(reviewConfig));
      const sourceExtraction = resolveSourceExtractionName(config, options.extraction);
      const opinionRun = await resolveOpinionRun({
        projectPaths,
        sourceExtraction,
        ...(options.opinionRun === undefined ? {} : { explicitOpinionRunId: options.opinionRun })
      });
      const selected = await selectOpinions({
        projectPaths,
        opinionsDir: opinionRun.opinionsDir,
        reviewConfig,
        offset: options.offset ?? 0,
        ...(options.limit === undefined ? {} : { limit: options.limit })
      });

      if (selected.selectedOpinions.length === 0) {
        throw new Error("No opinions matched the selected run, review boundary, offset, and limit.");
      }

      const fingerprint = buildGoldRunFingerprint({
        opinionRunId: opinionRun.runId,
        sourceExtraction,
        selectedOpinions: selected.selectedOpinions,
        reviewConfigSha256,
        offset: options.offset ?? 0,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        batchSize,
        model,
        reasoning
      });
      const runId = options.run ?? createGoldRunId(model);
      const paths = resolveGoldRunPaths(projectPaths, runId);
      const createdAt = new Date().toISOString();
      const existingManifest = await readJsonFile<CodexGoldStandardManifest>(paths.manifestPath);

      if (
        existingManifest !== null &&
        existingManifest.fingerprint.sha256 !== fingerprint.sha256 &&
        options.force !== true
      ) {
        throw new Error(
          `Gold-standard run '${runId}' already exists with a different input fingerprint. Pass --force to overwrite reusable artifacts or choose a different --run.`
        );
      }

      const batches = buildOpinionBatches(selected.selectedOpinions, batchSize);
      await prepareRunInputs({
        paths,
        config,
        sourceExtraction,
        opinionRun,
        selectedOpinions: selected.selectedOpinions,
        batches
      });

      const manifestBase: CodexGoldStandardManifest = {
        runId,
        kind: "codex-gold-standard-analysis",
        strategy: CODEX_GOLD_STANDARD_STRATEGY,
        createdAt: existingManifest?.createdAt ?? createdAt,
        updatedAt: new Date().toISOString(),
        status: options.dryRun === true ? "dry-run" : "prepared",
        project: {
          name: config.project.name,
          slug: config.project.slug,
          rootDir: projectRoot,
          configPath: projectPaths.configPath
        },
        model: {
          provider: "codex-cli",
          modelId: model,
          reasoningEffort: reasoning,
          codexBin
        },
        input: {
          sourceExtraction,
          opinionRunId: opinionRun.runId,
          opinionRunDir: opinionRun.runDir,
          opinionsDir: opinionRun.opinionsDir,
          opinionsAvailable: selected.allOpinionCount,
          opinionsIncludedByReview: selected.includedOpinionCount,
          opinionsSelected: selected.selectedOpinions.length,
          offset: options.offset ?? 0,
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          batchSize,
          review: {
            configPath: projectPaths.reviewConfigPath,
            configSha256: reviewConfigSha256,
            includeCommentStatuses: [...reviewConfig.analysis.includeCommentStatuses],
            includeOpinionStatuses: [...reviewConfig.analysis.includeOpinionStatuses],
            excludedOpinions: selected.excludedOpinionCount,
            excludedByStatus: selected.excludedByStatus
          }
        },
        fingerprint,
        output: {
          runDir: paths.runDir,
          opinionsJsonlPath: paths.opinionsJsonlPath,
          batchesDir: paths.batchesDir,
          schemasDir: paths.schemasDir,
          promptsDir: paths.promptsDir,
          codexEventsDir: paths.codexEventsDir,
          codexStderrDir: paths.codexStderrDir,
          batchTaxonomiesDir: paths.batchTaxonomiesDir,
          taxonomyPath: paths.taxonomyPath,
          batchAssignmentsDir: paths.batchAssignmentsDir,
          assignmentsJsonlPath: paths.assignmentsJsonlPath,
          assignmentSummaryPath: paths.assignmentSummaryPath
        },
        stages: {
          batchTaxonomies: createStageProgress(batches.length),
          taxonomyMerge: createStageProgress(1),
          assignments: createStageProgress(batches.length)
        }
      };

      await writeJsonFile(paths.manifestPath, manifestBase);

      if (options.dryRun === true) {
        process.stdout.write(renderPreparedSummary(projectRoot, manifestBase, paths));
        return;
      }

      const checkpoint = async (
        status: CodexGoldStandardManifest["status"],
        stages: CodexGoldStandardManifest["stages"],
        error?: string
      ): Promise<void> => {
        const manifest: CodexGoldStandardManifest = {
          ...manifestBase,
          updatedAt: new Date().toISOString(),
          status,
          stages,
          ...(error === undefined ? {} : { error })
        };
        await writeJsonFile(paths.manifestPath, manifest);
      };

      const stages = manifestBase.stages;
      await checkpoint("running", stages);
      process.stdout.write(renderPreparedSummary(projectRoot, manifestBase, paths));

      try {
        await runBatchTaxonomyStage({
          projectRoot,
          config,
          sourceExtraction,
          model,
          reasoning,
          codexBin,
          paths,
          batches,
          force: options.force === true,
          progress: stages.batchTaxonomies,
          checkpoint: async () => checkpoint("running", stages)
        });
        stages.taxonomyMerge.status = "running";
        await checkpoint("running", stages);
        await runTaxonomyMergeStage({
          projectRoot,
          config,
          sourceExtraction,
          model,
          reasoning,
          codexBin,
          paths,
          batches,
          force: options.force === true,
          progress: stages.taxonomyMerge
        });
        stages.taxonomyMerge.status = "ready";
        stages.taxonomyMerge.completed = 1;
        await checkpoint("running", stages);
        await runAssignmentStage({
          projectRoot,
          config,
          sourceExtraction,
          model,
          reasoning,
          codexBin,
          paths,
          batches,
          force: options.force === true,
          progress: stages.assignments,
          checkpoint: async () => checkpoint("running", stages)
        });
        await writeAssignmentSummary(paths, batches);
        await checkpoint("ready", stages);
      } catch (error) {
        await checkpoint("failed", stages, error instanceof Error ? error.message : String(error));
        throw error;
      }

      const finalManifest = await readJsonFile<CodexGoldStandardManifest>(paths.manifestPath);

      if (finalManifest !== null) {
        process.stdout.write(renderFinishedSummary(projectRoot, finalManifest));
      }
    }
  });
}

async function runBatchTaxonomyStage(options: {
  projectRoot: string;
  config: BroadlyProjectConfig;
  sourceExtraction: string;
  model: string;
  reasoning: CodexReasoningEffort;
  codexBin: string;
  paths: GoldRunPaths;
  batches: GoldOpinionBatch[];
  force: boolean;
  progress: StageProgress;
  checkpoint: () => Promise<void>;
}): Promise<void> {
  const schemaPath = path.join(options.paths.schemasDir, "batch-taxonomy.schema.json");
  options.progress.status = "running";

  for (const batch of options.batches) {
    const artifactPath = path.join(options.paths.batchTaxonomiesDir, `${batch.batchId}.json`);

    if (options.force === false && (await fileExists(artifactPath))) {
      options.progress.completed += 1;
      options.progress.reused += 1;
      await options.checkpoint();
      process.stdout.write(`  batch ${batch.batchId}: reused\n`);
      continue;
    }

    const prompt = renderBatchTaxonomyPrompt({
      config: options.config,
      sourceExtraction: options.sourceExtraction,
      batch
    });
    const promptPath = path.join(options.paths.promptsDir, `batch-taxonomy-${batch.batchId}.md`);
    const outputPath = path.join(options.paths.codexEventsDir, `batch-taxonomy-${batch.batchId}.json`);
    const eventsPath = path.join(options.paths.codexEventsDir, `batch-taxonomy-${batch.batchId}.jsonl`);
    const stderrPath = path.join(options.paths.codexStderrDir, `batch-taxonomy-${batch.batchId}.log`);

    await writeFile(promptPath, prompt, "utf8");
    await runCodexStructuredOutput({
      cwd: options.projectRoot,
      codexBin: options.codexBin,
      model: options.model,
      reasoning: options.reasoning,
      prompt,
      schemaPath,
      outputPath,
      eventsPath,
      stderrPath
    });
    const parsed = await readStructuredCodexOutput(artifactPath, outputPath);
    await writeJsonFile(artifactPath, parsed);
    options.progress.completed += 1;
    await options.checkpoint();
    process.stdout.write(`  batch ${batch.batchId}: taxonomy ready\n`);
  }

  options.progress.status = "ready";
}

async function runTaxonomyMergeStage(options: {
  projectRoot: string;
  config: BroadlyProjectConfig;
  sourceExtraction: string;
  model: string;
  reasoning: CodexReasoningEffort;
  codexBin: string;
  paths: GoldRunPaths;
  batches: GoldOpinionBatch[];
  force: boolean;
  progress: StageProgress;
}): Promise<void> {
  if (options.force === false && (await fileExists(options.paths.taxonomyPath))) {
    options.progress.reused = 1;
    process.stdout.write("  taxonomy: reused\n");
    return;
  }

  const batchTaxonomies = [];

  for (const batch of options.batches) {
    const taxonomy = await readJsonFile<unknown>(
      path.join(options.paths.batchTaxonomiesDir, `${batch.batchId}.json`)
    );

    if (taxonomy === null) {
      throw new Error(`Missing batch taxonomy for ${batch.batchId}.`);
    }

    batchTaxonomies.push(taxonomy);
  }

  const prompt = renderTaxonomyMergePrompt({
    config: options.config,
    sourceExtraction: options.sourceExtraction,
    batchTaxonomies
  });
  const promptPath = path.join(options.paths.promptsDir, "taxonomy-merge.md");
  const schemaPath = path.join(options.paths.schemasDir, "taxonomy.schema.json");
  const outputPath = path.join(options.paths.codexEventsDir, "taxonomy-merge.json");
  const eventsPath = path.join(options.paths.codexEventsDir, "taxonomy-merge.jsonl");
  const stderrPath = path.join(options.paths.codexStderrDir, "taxonomy-merge.log");

  await writeFile(promptPath, prompt, "utf8");
  await runCodexStructuredOutput({
    cwd: options.projectRoot,
    codexBin: options.codexBin,
    model: options.model,
    reasoning: options.reasoning,
    prompt,
    schemaPath,
    outputPath,
    eventsPath,
    stderrPath
  });
  const parsed = await readStructuredCodexOutput(options.paths.taxonomyPath, outputPath);
  await writeJsonFile(options.paths.taxonomyPath, parsed);
  process.stdout.write("  taxonomy: merged\n");
}

async function runAssignmentStage(options: {
  projectRoot: string;
  config: BroadlyProjectConfig;
  sourceExtraction: string;
  model: string;
  reasoning: CodexReasoningEffort;
  codexBin: string;
  paths: GoldRunPaths;
  batches: GoldOpinionBatch[];
  force: boolean;
  progress: StageProgress;
  checkpoint: () => Promise<void>;
}): Promise<void> {
  const taxonomy = await readJsonFile<unknown>(options.paths.taxonomyPath);

  if (taxonomy === null) {
    throw new Error("Missing merged taxonomy artifact.");
  }

  const schemaPath = path.join(options.paths.schemasDir, "assignments.schema.json");
  options.progress.status = "running";

  for (const batch of options.batches) {
    const artifactPath = path.join(options.paths.batchAssignmentsDir, `${batch.batchId}.json`);

    if (options.force === false && (await fileExists(artifactPath))) {
      options.progress.completed += 1;
      options.progress.reused += 1;
      await options.checkpoint();
      process.stdout.write(`  batch ${batch.batchId}: assignments reused\n`);
      continue;
    }

    const prompt = renderAssignmentPrompt({
      config: options.config,
      sourceExtraction: options.sourceExtraction,
      taxonomy,
      batch
    });
    const promptPath = path.join(options.paths.promptsDir, `assignments-${batch.batchId}.md`);
    const outputPath = path.join(options.paths.codexEventsDir, `assignments-${batch.batchId}.json`);
    const eventsPath = path.join(options.paths.codexEventsDir, `assignments-${batch.batchId}.jsonl`);
    const stderrPath = path.join(options.paths.codexStderrDir, `assignments-${batch.batchId}.log`);

    await writeFile(promptPath, prompt, "utf8");
    await runCodexStructuredOutput({
      cwd: options.projectRoot,
      codexBin: options.codexBin,
      model: options.model,
      reasoning: options.reasoning,
      prompt,
      schemaPath,
      outputPath,
      eventsPath,
      stderrPath
    });
    const parsed = await readStructuredCodexOutput(artifactPath, outputPath);
    await writeJsonFile(artifactPath, parsed);
    options.progress.completed += 1;
    await options.checkpoint();
    process.stdout.write(`  batch ${batch.batchId}: assignments ready\n`);
  }

  options.progress.status = "ready";
}

async function prepareRunInputs(options: {
  paths: GoldRunPaths;
  config: BroadlyProjectConfig;
  sourceExtraction: string;
  opinionRun: LoadedOpinionRun;
  selectedOpinions: GoldOpinion[];
  batches: GoldOpinionBatch[];
}): Promise<void> {
  await mkdir(options.paths.runDir, { recursive: true });
  await mkdir(options.paths.inputsDir, { recursive: true });
  await mkdir(options.paths.batchesDir, { recursive: true });
  await mkdir(options.paths.schemasDir, { recursive: true });
  await mkdir(options.paths.promptsDir, { recursive: true });
  await mkdir(options.paths.codexEventsDir, { recursive: true });
  await mkdir(options.paths.codexStderrDir, { recursive: true });
  await mkdir(options.paths.batchTaxonomiesDir, { recursive: true });
  await mkdir(options.paths.batchAssignmentsDir, { recursive: true });
  await writeJsonFile(path.join(options.paths.schemasDir, "batch-taxonomy.schema.json"), batchTaxonomySchema);
  await writeJsonFile(path.join(options.paths.schemasDir, "taxonomy.schema.json"), mergedTaxonomySchema);
  await writeJsonFile(path.join(options.paths.schemasDir, "assignments.schema.json"), assignmentSchema);
  await writeFile(
    options.paths.opinionsJsonlPath,
    `${options.selectedOpinions.map((opinion) => JSON.stringify(opinion)).join("\n")}\n`,
    "utf8"
  );
  await writeJsonFile(path.join(options.paths.inputsDir, "context.json"), {
    project: options.config.project,
    questions: options.config.questions,
    sourceExtraction: options.sourceExtraction,
    opinionRun: {
      runId: options.opinionRun.runId,
      model: options.opinionRun.manifest.model ?? null
    },
    selectedOpinionCount: options.selectedOpinions.length
  });

  for (const batch of options.batches) {
    await writeJsonFile(path.join(options.paths.batchesDir, `${batch.batchId}.json`), batch);
  }
}

async function writeAssignmentSummary(
  paths: GoldRunPaths,
  batches: GoldOpinionBatch[]
): Promise<void> {
  const assignmentLines: string[] = [];
  const categoryCounts = new Map<string, number>();
  const themeCounts = new Map<string, number>();
  let assignmentCount = 0;
  let uncertainCount = 0;
  let outOfScopeCount = 0;
  let falseFriendWarningCount = 0;

  for (const batch of batches) {
    const artifact = await readJsonFile<{
      assignments?: Array<{
        opinion_id?: string;
        primary_category_id?: string | null;
        primary_theme_id?: string | null;
        fit?: string;
        uncertainty_flag?: boolean;
        false_friend_check?: {
          nearest_false_friend_theme_ids?: string[];
        };
      }>;
    }>(path.join(paths.batchAssignmentsDir, `${batch.batchId}.json`));

    for (const assignment of artifact?.assignments ?? []) {
      assignmentLines.push(JSON.stringify({ batch_id: batch.batchId, ...assignment }));
      assignmentCount += 1;

      if (typeof assignment.primary_category_id === "string") {
        categoryCounts.set(
          assignment.primary_category_id,
          (categoryCounts.get(assignment.primary_category_id) ?? 0) + 1
        );
      }

      if (typeof assignment.primary_theme_id === "string") {
        themeCounts.set(
          assignment.primary_theme_id,
          (themeCounts.get(assignment.primary_theme_id) ?? 0) + 1
        );
      }

      if (assignment.fit === "out_of_scope") {
        outOfScopeCount += 1;
      }

      if (
        assignment.fit === "uncertain" ||
        assignment.fit === "out_of_scope" ||
        assignment.uncertainty_flag === true
      ) {
        uncertainCount += 1;
      }

      if ((assignment.false_friend_check?.nearest_false_friend_theme_ids ?? []).length > 0) {
        falseFriendWarningCount += 1;
      }
    }
  }

  await writeFile(paths.assignmentsJsonlPath, `${assignmentLines.join("\n")}\n`, "utf8");
  await writeJsonFile(paths.assignmentSummaryPath, {
    assignmentCount,
    uncertainOrOutOfScopeCount: uncertainCount,
    outOfScopeCount,
    falseFriendWarningCount,
    categoryCounts: Object.fromEntries([...categoryCounts.entries()].sort((a, b) => b[1] - a[1])),
    themeCounts: Object.fromEntries([...themeCounts.entries()].sort((a, b) => b[1] - a[1]))
  });
}

async function runCodexStructuredOutput(options: {
  cwd: string;
  codexBin: string;
  model: string;
  reasoning: CodexReasoningEffort;
  prompt: string;
  schemaPath: string;
  outputPath: string;
  eventsPath: string;
  stderrPath: string;
}): Promise<CodexExecResult> {
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await mkdir(path.dirname(options.eventsPath), { recursive: true });
  await mkdir(path.dirname(options.stderrPath), { recursive: true });
  const startedAt = Date.now();
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-m",
    options.model,
    "-c",
    `model_reasoning_effort="${options.reasoning}"`,
    "--output-schema",
    options.schemaPath,
    "-o",
    options.outputPath,
    "-"
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.codexBin, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = createWriteStream(options.eventsPath, { flags: "w" });
    const stderr = createWriteStream(options.stderrPath, { flags: "w" });

    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.stdin.end(options.prompt);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Codex CLI exited with code ${code ?? "unknown"}. See ${options.stderrPath} and ${options.eventsPath}.`
        )
      );
    });
  });

  return {
    outputPath: options.outputPath,
    eventsPath: options.eventsPath,
    stderrPath: options.stderrPath,
    elapsedMs: Date.now() - startedAt
  };
}

async function readStructuredCodexOutput(
  artifactPath: string,
  outputPath: string
): Promise<unknown> {
  const text = await readFile(outputPath, "utf8").catch((error: unknown) => {
    throw new Error(
      `Codex did not write ${outputPath} for ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  const parsed = parseJsonText(text);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Codex output for ${artifactPath} was not a JSON object.`);
  }

  return parsed;
}

function renderBatchTaxonomyPrompt(options: {
  config: BroadlyProjectConfig;
  sourceExtraction: string;
  batch: GoldOpinionBatch;
}): string {
  return [
    "You are building Broadly's gold-standard qualitative taxonomy for a civic consultation dataset.",
    "Read every opinion in this batch. Group opinions by the policy concern or civic argument they express.",
    "Prefer analyst-grade distinctions over geometric similarity. Do not flatten specific policy issues into vague grievance clusters.",
    "Use only the opinion IDs provided. Every on-topic opinion should either appear in one theme's opinion_ids or in unassigned_opinion_ids.",
    "Treat the project questions as the relevance boundary. If an opinion is clearly off topic, put it in unassigned_opinion_ids and explain the boundary in notes rather than inventing an off-topic theme.",
    "Aim for raw material that can later merge into 3-6 top-level categories with 2-8 lower-tier subgroups per category. The tree does not need to be balanced.",
    "",
    "Project:",
    JSON.stringify({
      name: options.config.project.name,
      description: options.config.project.description,
      goals: options.config.project.goals,
      questions: options.config.questions,
      sourceExtraction: options.sourceExtraction
    }, null, 2),
    "",
    "Batch:",
    JSON.stringify(options.batch, null, 2),
    "",
    "Return only the JSON object required by the schema."
  ].join("\n");
}

function renderTaxonomyMergePrompt(options: {
  config: BroadlyProjectConfig;
  sourceExtraction: string;
  batchTaxonomies: unknown[];
}): string {
  return [
    "You are merging batch-level qualitative themes into a corpus-wide gold-standard taxonomy.",
    "Create a compact but expressive two-tier taxonomy that preserves specific policy distinctions.",
    "The top tier must be broad categories, usually 3-6 total. The lower tier must be subgroup themes, usually 2-8 per category. The tree does not need to be balanced.",
    "Use categories for navigation and report structure. Use themes as the assignable subgroups.",
    "Themes should be stable enough for every opinion in the corpus to be assigned later.",
    "Avoid duplicate labels. Separate themes when their policy implications, target institution, or remedy differs.",
    "Do not create a primary-analysis category just to hold clearly off-topic material. Preserve those cases as missing_or_uncertain_areas or later out_of_scope assignments instead.",
    "If a broad inclusion bucket mixes representation, feminist/GBA+, accessibility, Indigenous governance, or reconciliation concerns, split it into subgroups under the most appropriate parent category.",
    "For each subgroup theme, record the parent_category_id and expected_false_friends so assignment QA can catch boundary leakage.",
    "",
    "Project:",
    JSON.stringify({
      name: options.config.project.name,
      description: options.config.project.description,
      goals: options.config.project.goals,
      questions: options.config.questions,
      sourceExtraction: options.sourceExtraction
    }, null, 2),
    "",
    "Batch taxonomies:",
    JSON.stringify(options.batchTaxonomies, null, 2),
    "",
    "Return only the JSON object required by the schema."
  ].join("\n");
}

function renderAssignmentPrompt(options: {
  config: BroadlyProjectConfig;
  sourceExtraction: string;
  taxonomy: unknown;
  batch: GoldOpinionBatch;
}): string {
  return [
    "You are assigning civic consultation opinions to Broadly's gold-standard taxonomy.",
    "Use the taxonomy definitions strictly. Assign each on-topic opinion to one primary subgroup theme and zero or more secondary subgroup themes.",
    "Set primary_category_id to the parent category of the primary theme. Use only category IDs and theme IDs from the taxonomy.",
    "If an opinion is clearly outside the project questions, set fit to out_of_scope, set primary_category_id and primary_theme_id to null, keep secondary_theme_ids empty, and explain the relevance boundary.",
    "If an on-topic opinion does not fit the taxonomy, set fit to uncertain, set uncertainty_flag to true, and explain the gap in new_theme_suggestions.",
    "Set uncertainty_flag to true for partial, uncertain, out_of_scope, low-confidence, or mixed assignments.",
    "Check the assigned theme's exclusion_rule and expected_false_friends. Fill false_friend_check with nearby false-friend theme IDs when the opinion might be confused with a neighboring theme.",
    "",
    "Project:",
    JSON.stringify({
      name: options.config.project.name,
      description: options.config.project.description,
      goals: options.config.project.goals,
      questions: options.config.questions,
      sourceExtraction: options.sourceExtraction
    }, null, 2),
    "",
    "Taxonomy:",
    JSON.stringify(options.taxonomy, null, 2),
    "",
    "Batch:",
    JSON.stringify(options.batch, null, 2),
    "",
    "Return only the JSON object required by the schema."
  ].join("\n");
}

async function selectOpinions(options: {
  projectPaths: ProjectPaths;
  opinionsDir: string;
  reviewConfig: ReviewConfig;
  offset: number;
  limit?: number;
}): Promise<SelectedOpinions> {
  const opinionPaths = await listOpinionArtifactPaths(options.opinionsDir);
  const included: GoldOpinion[] = [];
  const excludedByStatus = createEmptyReviewStatusCounts();

  for (const opinionPath of opinionPaths) {
    const opinion = await readJsonFile<OpinionArtifact>(opinionPath);

    if (opinion === null || typeof opinion.opinionId !== "string") {
      continue;
    }

    const [commentReview, opinionReview] = await Promise.all([
      loadCommentReview(options.projectPaths, opinion.sourceId),
      loadOpinionReview(options.projectPaths, opinion.opinionId)
    ]);
    const resolvedReview = resolveEffectiveOpinionReviewStatus({
      commentReview,
      opinionReview
    });

    if (
      isIncludedByReviewConfig(
        options.reviewConfig,
        resolvedReview.source,
        resolvedReview.status
      )
    ) {
      included.push(toGoldOpinion(opinion));
    } else {
      excludedByStatus[resolvedReview.status] += 1;
    }
  }

  const selectedOpinions = included.slice(
    options.offset,
    options.limit === undefined ? undefined : options.offset + options.limit
  );
  const excludedOpinionCount = opinionPaths.length - included.length;

  return {
    allOpinionCount: opinionPaths.length,
    includedOpinionCount: included.length,
    selectedOpinions,
    excludedOpinionCount,
    excludedByStatus
  };
}

function toGoldOpinion(opinion: OpinionArtifact): GoldOpinion {
  return {
    opinionId: opinion.opinionId,
    sourceId: opinion.sourceId,
    opinionText: opinion.opinionText,
    ...(opinion.excerpt === undefined ? {} : { excerpt: opinion.excerpt }),
    provenance: {
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
}

async function resolveOpinionRun(options: {
  projectPaths: ProjectPaths;
  sourceExtraction: string;
  explicitOpinionRunId?: string;
}): Promise<LoadedOpinionRun> {
  const opinionsRootDir = path.join(options.projectPaths.dataDir, "opinions");

  if (options.explicitOpinionRunId !== undefined) {
    const run = await loadOpinionRunById(opinionsRootDir, options.explicitOpinionRunId);

    if (run === null) {
      throw new Error(`No opinion run named '${options.explicitOpinionRunId}' was found.`);
    }

    return run;
  }

  const currentRunId = await readCurrentRunId(options.projectPaths.opinionsCurrentRunPath);

  if (currentRunId !== null) {
    const currentRun = await loadOpinionRunById(opinionsRootDir, currentRunId);

    if (currentRun?.manifest.extraction?.name === options.sourceExtraction) {
      return currentRun;
    }
  }

  const entries = await readdir(opinionsRootDir, { withFileTypes: true }).catch(() => []);
  const runs: LoadedOpinionRun[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const run = await loadOpinionRunById(opinionsRootDir, entry.name);

    if (run?.manifest.extraction?.name === options.sourceExtraction) {
      runs.push(run);
    }
  }

  runs.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));

  const latestRun = runs[0];

  if (latestRun === undefined) {
    throw new Error(
      `No opinion run found for extraction '${options.sourceExtraction}'. Run broadly opinions first.`
    );
  }

  return latestRun;
}

async function loadOpinionRunById(
  opinionsRootDir: string,
  runId: string
): Promise<LoadedOpinionRun | null> {
  const runDir = path.join(opinionsRootDir, runId);
  const manifest = await readJsonFile<OpinionRunManifest>(path.join(runDir, "manifest.json"));

  if (manifest === null || typeof manifest.createdAt !== "string") {
    return null;
  }

  return {
    runId,
    runDir,
    opinionsDir: path.join(runDir, "opinions"),
    manifest
  };
}

function resolveSourceExtractionName(config: BroadlyProjectConfig, explicit: string | undefined): string {
  if (explicit !== undefined) {
    return explicit;
  }

  const primaryView = getAnalysisViewConfig(config, config.report.primaryView);
  return primaryView.sourceExtraction;
}

function buildGoldRunFingerprint(options: {
  opinionRunId: string;
  sourceExtraction: string;
  selectedOpinions: GoldOpinion[];
  reviewConfigSha256: string;
  offset: number;
  limit?: number;
  batchSize: number;
  model: string;
  reasoning: CodexReasoningEffort;
}): GoldRunFingerprint {
  const selectedOpinionIdsSha256 = sha256Hex(
    JSON.stringify(options.selectedOpinions.map((opinion) => opinion.opinionId).sort())
  );
  const selectedOpinionTextsSha256 = sha256Hex(
    JSON.stringify(
      options.selectedOpinions.map((opinion) => ({
        opinionId: opinion.opinionId,
        textSha256: sha256Hex(opinion.opinionText)
      }))
    )
  );
  const value = {
    version: GOLD_STANDARD_VERSION,
    opinionRunId: options.opinionRunId,
    sourceExtraction: options.sourceExtraction,
    opinionCount: options.selectedOpinions.length,
    selectedOpinionIdsSha256,
    selectedOpinionTextsSha256,
    reviewConfigSha256: options.reviewConfigSha256,
    offset: options.offset,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    batchSize: options.batchSize,
    model: options.model,
    reasoningEffort: options.reasoning
  };

  return {
    ...value,
    sha256: sha256Hex(JSON.stringify(value))
  };
}

function buildOpinionBatches(opinions: GoldOpinion[], batchSize: number): GoldOpinionBatch[] {
  const batches: GoldOpinionBatch[] = [];

  for (let index = 0; index < opinions.length; index += batchSize) {
    const batchOpinions = opinions.slice(index, index + batchSize);
    const batchIndex = batches.length + 1;
    const batchId = `batch-${String(batchIndex).padStart(4, "0")}`;
    batches.push({
      batchId,
      batchIndex,
      opinionCount: batchOpinions.length,
      opinions: batchOpinions
    });
  }

  return batches;
}

function resolveGoldRunPaths(projectPaths: ProjectPaths, runId: string): GoldRunPaths {
  const runDir = path.join(projectPaths.rootDir, "gold-standards", runId);

  return {
    runDir,
    manifestPath: path.join(runDir, "manifest.json"),
    inputsDir: path.join(runDir, "inputs"),
    batchesDir: path.join(runDir, "inputs", "batches"),
    schemasDir: path.join(runDir, "schemas"),
    promptsDir: path.join(runDir, "prompts"),
    codexEventsDir: path.join(runDir, "codex-events"),
    codexStderrDir: path.join(runDir, "codex-stderr"),
    batchTaxonomiesDir: path.join(runDir, "batch-taxonomies"),
    batchAssignmentsDir: path.join(runDir, "batch-assignments"),
    opinionsJsonlPath: path.join(runDir, "inputs", "opinions.jsonl"),
    taxonomyPath: path.join(runDir, "taxonomy.json"),
    assignmentsJsonlPath: path.join(runDir, "assignments.jsonl"),
    assignmentSummaryPath: path.join(runDir, "assignment-summary.json")
  };
}

function createGoldRunId(model: string): string {
  return `${formatRunTimestamp(new Date())}-codex-${slugifyRunIdPart(model)}`;
}

function createStageProgress(total: number): StageProgress {
  return {
    status: total === 0 ? "skipped" : "pending",
    total,
    completed: 0,
    reused: 0,
    failed: 0
  };
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

function isIncludedByReviewConfig(
  reviewConfig: ReviewConfig,
  source: "default" | "comment" | "opinion",
  status: ReviewStatus
): boolean {
  if (source === "comment") {
    return reviewConfig.analysis.includeCommentStatuses.includes(status);
  }

  return reviewConfig.analysis.includeOpinionStatuses.includes(status);
}

function renderPreparedSummary(
  projectRoot: string,
  manifest: CodexGoldStandardManifest,
  paths: GoldRunPaths
): string {
  return [
    "Broadly Codex Gold Standard Analysis",
    rule("="),
    formatDetailLine("Project", projectRoot),
    formatDetailLine("Run", manifest.runId),
    formatDetailLine("Model", `${manifest.model.modelId} (${manifest.model.reasoningEffort})`),
    formatDetailLine("Extraction", manifest.input.sourceExtraction),
    formatDetailLine("Opinion Run", manifest.input.opinionRunId),
    formatDetailLine("Opinions", `${manifest.input.opinionsSelected} selected`),
    formatDetailLine("Batches", `${manifest.stages.batchTaxonomies.total} x ${manifest.input.batchSize}`),
    formatDetailLine("Manifest", toPortableRelativePath(projectRoot, paths.manifestPath)),
    formatDetailLine("Input", toPortableRelativePath(projectRoot, paths.opinionsJsonlPath)),
    ""
  ].join("\n");
}

function renderFinishedSummary(projectRoot: string, manifest: CodexGoldStandardManifest): string {
  return [
    "",
    "Codex gold-standard analysis complete",
    rule("="),
    formatDetailLine("Run", manifest.runId),
    formatDetailLine("Taxonomy", toPortableRelativePath(projectRoot, manifest.output.taxonomyPath)),
    formatDetailLine("Assignments", toPortableRelativePath(projectRoot, manifest.output.assignmentsJsonlPath)),
    formatDetailLine("Summary", toPortableRelativePath(projectRoot, manifest.output.assignmentSummaryPath)),
    ""
  ].join("\n");
}

function formatDetailLine(label: string, value: string): string {
  return `  ${label.padEnd(12)} ${value}`;
}

function rule(character: string): string {
  return character.repeat(72);
}

async function listOpinionArtifactPaths(opinionsDir: string): Promise<string[]> {
  const entries = await readdir(opinionsDir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => path.join(opinionsDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();

  if (trimmed.startsWith("```")) {
    const withoutOpeningFence = trimmed.replace(/^```(?:json)?\s*/i, "");
    return JSON.parse(withoutOpeningFence.replace(/\s*```$/, ""));
  }

  return JSON.parse(trimmed);
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

function slugifyRunIdPart(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug.length === 0 ? "run" : slug;
}

function toPortableRelativePath(fromDirectory: string, toPath: string): string {
  const relativePath = path.relative(fromDirectory, toPath);
  const portablePath = relativePath.split(path.sep).join("/");

  return portablePath.startsWith(".") ? portablePath : `./${portablePath}`;
}
