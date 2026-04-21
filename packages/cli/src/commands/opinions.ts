import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  getOpinionExtractionConfig,
  parseProjectConfig,
  type BroadlyProjectConfig
} from "@broadly/config";
import { resolveProjectPaths, sha256Hex } from "@broadly/core";
import {
  getNormalizedCommentDerivedFields,
  getNormalizedCommentPrimaryText,
  type NormalizedCommentRecord
} from "@broadly/ingest";

import { runTextPromptWithModel } from "../modelRuntime.js";
import {
  archiveProjectRuns,
  readCurrentRunId,
  writeCurrentRunId
} from "../projectArtifacts.js";
import { withProjectActionLog } from "../projectLog.js";

type RegisteredModel = BroadlyProjectConfig["models"][number];

export interface OpinionsCommandOptions {
  project?: string;
  extraction?: string;
  model?: string;
  limit?: number;
  offset?: number;
  archive?: boolean;
  resume?: boolean;
  concurrency?: number;
}

interface OpinionExtractionItem {
  opinion_text: string;
  source_excerpt: string;
  source_fields: string[];
}

interface OpinionExtractionResponse {
  split_decision: "none" | "single" | "multiple";
  split_rationale: string;
  opinions: OpinionExtractionItem[];
}

interface OpinionRunManifest {
  createdAt: string;
  updatedAt: string;
  runId: string;
  extraction: {
    name: string;
    title?: string;
  };
  model: RegisteredModel;
  fingerprint: OpinionRunFingerprint;
  prompt: {
    path: string;
    sha256: string;
  };
  input: {
    normalizedDir: string;
    recordsAttempted: number;
    concurrency: number;
    offset?: number;
    limit?: number;
  };
  output: {
    runDir: string;
    recordsDir: string;
    opinionsDir: string;
    manifestPath: string;
    recordsWritten: number;
    opinionsWritten: number;
    failedRecords: number;
  };
}

interface OpinionRunFingerprint {
  extractionName: string;
  promptSha256: string;
  ingestManifestSha256: string | null;
}

export async function extractOpinionsWithModel(
  options: OpinionsCommandOptions
): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  await withProjectActionLog({
    projectRoot,
    command: "opinions",
    details: {
      extraction: options.extraction ?? "(configured)",
      model: options.model ?? "(configured)",
      limit: options.limit,
      offset: options.offset,
      archive: options.archive === true,
      resume: options.resume === true,
      concurrency: options.concurrency ?? 4
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = await loadProjectConfig(projectPaths.configPath);
      const opinionsRootDir = path.join(projectPaths.dataDir, "opinions");

      if (options.archive === true && options.resume === true) {
        throw new Error("Cannot use --archive and --resume together.");
      }

      if (options.archive === true) {
        const archiveResult = await archiveProjectRuns({
          projectRoot,
          sourceDir: opinionsRootDir,
          archiveKind: "opinions",
          pointerPath: projectPaths.opinionsCurrentRunPath
        });
        process.stdout.write(
          `Archive requested: moved ${archiveResult.archivedRunIds.length} opinion run(s) to ${toPortableRelativePath(projectRoot, archiveResult.archiveDir)}\n`
        );
        if (process.stdout.isTTY) {
          process.stdout.write("\n");
        }
      }

      const extractionTargets = resolveOpinionExtractionTargets(config, options);

      for (const extractionTarget of extractionTargets) {
        await extractOpinionsForTarget({
          projectRoot,
          projectPaths,
          config,
          extractionName: extractionTarget.name,
          ...(extractionTarget.title === undefined ? {} : { extractionTitle: extractionTarget.title }),
          model: resolveModel(config, options.model ?? extractionTarget.model),
          promptPath: path.join(projectRoot, extractionTarget.prompt),
          resume: options.resume === true,
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          ...(options.offset === undefined ? {} : { offset: options.offset }),
          ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
        });
      }
    }
  });
}

async function extractOpinionsForTarget(options: {
  projectRoot: string;
  projectPaths: ReturnType<typeof resolveProjectPaths>;
  config: BroadlyProjectConfig;
  extractionName: string;
  extractionTitle?: string;
  model: RegisteredModel;
  promptPath: string;
  limit?: number;
  offset?: number;
  resume: boolean;
  concurrency?: number;
}): Promise<void> {
  const normalizedDir = path.join(options.projectPaths.dataDir, "normalized");
  const opinionsRootDir = path.join(options.projectPaths.dataDir, "opinions");
  const promptTemplate = await readFile(options.promptPath, "utf8");
  const promptSha256 = sha256Hex(promptTemplate);
  const normalizedRecordPaths = await listNormalizedRecordPaths(normalizedDir);
  const fingerprint = await resolveOpinionRunFingerprint(
    normalizedDir,
    options.extractionName,
    promptSha256
  );
  const offset = options.offset ?? 0;
  const selectedRecordPaths = normalizedRecordPaths.slice(
    offset,
    options.limit === undefined ? undefined : offset + options.limit
  );
  const createdAt = new Date().toISOString();
  const concurrency = resolveConcurrency(options.concurrency);
  const currentRunId = await readCurrentRunId(options.projectPaths.opinionsCurrentRunPath);

  const currentCompatibleRun =
    currentRunId === null
      ? null
      : await findCompatibleOpinionRunById(
          opinionsRootDir,
          currentRunId,
          options.extractionName,
          options.model,
          fingerprint
        );
  const latestCompatibleRun = await findLatestCompatibleOpinionRunForModel(
    opinionsRootDir,
    options.extractionName,
    options.model,
    fingerprint
  );

  if (options.resume === true && currentCompatibleRun === null && latestCompatibleRun === null) {
    throw new Error(
      `No compatible opinion run found for extraction '${options.extractionName}'. The prompt or dataset fingerprint may have changed; start a fresh run without --resume or use --archive.`
    );
  }

  const resumedRun = currentCompatibleRun ?? latestCompatibleRun;
  const autoResumed = options.resume !== true && resumedRun !== null;

  const runId = resumedRun?.runId ?? createRunId(options.extractionName);
  const runCreatedAt = resumedRun?.createdAt ?? createdAt;
  const runDir = path.join(opinionsRootDir, runId);
  const recordsDir = path.join(runDir, "records");
  const opinionsDir = path.join(runDir, "opinions");
  const manifestPath = path.join(runDir, "manifest.json");

  await mkdir(recordsDir, { recursive: true });
  await mkdir(opinionsDir, { recursive: true });
  await writeCurrentRunId(options.projectPaths.opinionsCurrentRunPath, runId);

  const selectedSourceIds = new Set(
    selectedRecordPaths.map((normalizedRecordPath) => path.basename(normalizedRecordPath, ".json"))
  );
  const existingProgress = await loadExistingRunProgress(recordsDir, selectedSourceIds);
  let recordsWritten = existingProgress.recordsWritten;
  let opinionsWritten = existingProgress.opinionsWritten;
  let failedRecords = existingProgress.failedRecords;
  const pendingRecordPaths = selectedRecordPaths.filter((normalizedRecordPath) => {
    const sourceId = path.basename(normalizedRecordPath, ".json");
    return existingProgress.successfulSourceIds.has(sourceId) === false;
  });
  const progress = createProgressReporter(selectedRecordPaths.length);
  let completedThisInvocation = 0;
  let interruptSignal: NodeJS.Signals | null = null;
  let nextPendingRecordIndex = 0;
  let checkpointQueue = Promise.resolve();

  const checkpointManifest = async (): Promise<void> => {
    await writeOpinionRunManifest({
      createdAt: runCreatedAt,
      updatedAt: new Date().toISOString(),
      runId,
      extractionName: options.extractionName,
      ...(options.extractionTitle === undefined ? {} : { extractionTitle: options.extractionTitle }),
      model: options.model,
      promptPath: options.promptPath,
      promptSha256,
      normalizedDir,
      recordsAttempted: selectedRecordPaths.length,
      concurrency,
      fingerprint,
      offset,
      limit: options.limit,
      runDir,
      recordsDir,
      opinionsDir,
      manifestPath,
      recordsWritten,
      opinionsWritten,
      failedRecords
    });
  };
  const queueCheckpointManifest = async (): Promise<void> => {
    checkpointQueue = checkpointQueue.then(() => checkpointManifest());
    await checkpointQueue;
  };

  const handleInterrupt = (signal: NodeJS.Signals): void => {
    if (interruptSignal !== null) {
      if (process.stdout.isTTY) {
        process.stdout.write("\n");
      }
      process.stdout.write(`Second interrupt received (${signal}). Exiting immediately.\n`);
      process.exit(130);
    }

    interruptSignal = signal;
    if (process.stdout.isTTY) {
      process.stdout.write("\n");
    }
    process.stdout.write(
      `Interrupt requested (${signal}). Finishing current record, checkpointing manifest, and exiting.\n`
    );
    void queueCheckpointManifest().catch(() => {
      // Best-effort checkpoint on signal; a final checkpoint is also attempted before exit.
    });
  };

      if (options.resume === true) {
      process.stdout.write(
          `Resume requested for ${options.extractionName}: continuing ${toPortableRelativePath(options.projectRoot, runDir)}\n`
        );
      } else if (autoResumed) {
        process.stdout.write(
          `Compatible current run found for ${options.extractionName}: continuing ${toPortableRelativePath(options.projectRoot, runDir)}\n`
        );
      }

  process.stdout.write(`Opinion extraction [${options.extractionName}] concurrency: ${concurrency}\n`);

      process.on("SIGINT", handleInterrupt);
      process.on("SIGTERM", handleInterrupt);

      try {
    await writeOpinionRunManifest({
      createdAt: runCreatedAt,
      updatedAt: createdAt,
      runId,
      extractionName: options.extractionName,
      ...(options.extractionTitle === undefined ? {} : { extractionTitle: options.extractionTitle }),
      model: options.model,
      promptPath: options.promptPath,
      promptSha256,
      normalizedDir,
      recordsAttempted: selectedRecordPaths.length,
      concurrency,
      fingerprint,
      offset,
      limit: options.limit,
      runDir,
      recordsDir,
      opinionsDir,
      manifestPath,
      recordsWritten,
      opinionsWritten,
      failedRecords
    });

    if (recordsWritten > 0) {
      progress.tick({
        recordsWritten,
        opinionsWritten,
        failedRecords
      });
    }

    const processRecord = async (normalizedRecordPath: string): Promise<void> => {
      const normalizedRecord = await readNormalizedRecord(normalizedRecordPath);
      const prompt = buildOpinionPrompt(promptTemplate, normalizedRecord);
      const priorStatus = existingProgress.recordStatusBySourceId.get(normalizedRecord.sourceId);

      try {
        const result = await runTextPromptWithModel({
          model: options.model,
          prompt,
          maxOutputTokens: 2048,
          projectRoot: options.projectRoot,
          temperature: 0
        });
        const parsed = parseOpinionResponse(result.text, normalizedRecord);
        const opinionIds: string[] = [];

        for (const opinion of parsed.opinions) {
          const opinionRecord = buildOpinionRecord({
            createdAt,
            model: options.model,
            normalizedRecord,
            normalizedRecordPath,
            opinion,
            promptPath: options.promptPath,
            promptSha256,
            responseStopReason: result.stopReason
          });
          const outputPath = path.join(opinionsDir, `${opinionRecord.opinionId}.json`);

          await writeJsonArtifact(outputPath, opinionRecord);
          opinionIds.push(opinionRecord.opinionId);
          opinionsWritten += 1;
        }

        const recordArtifact = {
          createdAt,
          sourceId: normalizedRecord.sourceId,
          normalizedRecordPath,
          extraction: {
            name: options.extractionName,
            ...(options.extractionTitle === undefined ? {} : { title: options.extractionTitle })
          },
          model: options.model,
          prompt: {
            path: options.promptPath,
            sha256: promptSha256
          },
          response: {
            stopReason: result.stopReason,
            rawText: result.text
          },
          splitDecision: parsed.split_decision,
          splitRationale: parsed.split_rationale,
          parsed,
          opinionIds
        };

        await writeJsonArtifact(path.join(recordsDir, `${normalizedRecord.sourceId}.json`), recordArtifact);
        if (priorStatus === "failed") {
          failedRecords = Math.max(0, failedRecords - 1);
        } else {
          recordsWritten += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failureArtifact = {
          createdAt,
          sourceId: normalizedRecord.sourceId,
          normalizedRecordPath,
          extraction: {
            name: options.extractionName,
            ...(options.extractionTitle === undefined ? {} : { title: options.extractionTitle })
          },
          model: options.model,
          prompt: {
            path: options.promptPath,
            sha256: promptSha256
          },
          error: message
        };

        await writeJsonArtifact(path.join(recordsDir, `${normalizedRecord.sourceId}.json`), failureArtifact);
        if (priorStatus === "failed") {
          // Still failed; keep the current counts unchanged apart from the overwritten artifact.
        } else {
          failedRecords += 1;
          recordsWritten += 1;
        }
      }

      completedThisInvocation += 1;
      progress.tick({
        recordsWritten,
        opinionsWritten,
        failedRecords
      });

      if (
        completedThisInvocation % 10 === 0 ||
        completedThisInvocation === pendingRecordPaths.length
      ) {
        await queueCheckpointManifest();
      }
    };

    const workerCount = Math.min(concurrency, Math.max(1, pendingRecordPaths.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (interruptSignal !== null) {
          return;
        }

        const currentIndex = nextPendingRecordIndex;

        if (currentIndex >= pendingRecordPaths.length) {
          return;
        }

        nextPendingRecordIndex += 1;
        const normalizedRecordPath = pendingRecordPaths[currentIndex];

        if (normalizedRecordPath === undefined) {
          return;
        }

        await processRecord(normalizedRecordPath);
      }
    });

    await Promise.all(workers);

    progress.finish();

    if (pendingRecordPaths.length === 0 && options.resume === true) {
      process.stdout.write(
        `Resume requested for ${options.extractionName}: no remaining records needed processing for this selection.\n`
      );
    }

    await queueCheckpointManifest();

      const lines = [
        `${interruptSignal === null ? "Extracted" : "Interrupted"} opinions for ${options.projectRoot}`,
        "",
      ...(options.resume === true ? ["Resumed existing run: yes"] : []),
      ...(autoResumed ? ["Resumed compatible run by default: yes"] : []),
      ...(interruptSignal === null ? [] : [`Interrupted by: ${interruptSignal}`]),
      `Extraction: ${options.extractionName}${options.extractionTitle === undefined ? "" : ` (${options.extractionTitle})`}`,
      `Model: ${options.model.name} (${options.model.provider} · ${options.model.region} · ${options.model.modelId})`,
      `Concurrency: ${concurrency}`,
      `Run: ${runId}`,
      `Offset: ${offset}`,
      `Records attempted: ${selectedRecordPaths.length}`,
        `Records remaining at start: ${pendingRecordPaths.length}`,
        `Records written: ${recordsWritten}`,
        `Failed records: ${failedRecords}`,
        `Opinions written: ${opinionsWritten}`,
        `Current pointer: ${toPortableRelativePath(options.projectRoot, options.projectPaths.opinionsCurrentRunPath)}`,
        `Output: ${toPortableRelativePath(options.projectRoot, runDir)}`,
        `Manifest: ${toPortableRelativePath(options.projectRoot, manifestPath)}`
      ];

    if (interruptSignal !== null) {
      process.exitCode = 130;
    }

    process.stdout.write(`${lines.join("\n")}\n`);
      } finally {
        process.off("SIGINT", handleInterrupt);
        process.off("SIGTERM", handleInterrupt);
      }
}

function resolveOpinionExtractionTargets(
  config: BroadlyProjectConfig,
  options: OpinionsCommandOptions
): Array<{
  name: string;
  title?: string;
  model: string;
  prompt: string;
}> {
  if (options.extraction !== undefined) {
    const extraction = getOpinionExtractionConfig(config, options.extraction);

    return [
      {
        name: extraction.name,
        ...(extraction.title === undefined ? {} : { title: extraction.title }),
        model: extraction.model,
        prompt: extraction.prompt
      }
    ];
  }

  if (options.model !== undefined) {
    const matchingExtraction = config.opinionExtractions.find((item) => item.model === options.model);

    if (matchingExtraction !== undefined) {
      return [
        {
          name: matchingExtraction.name,
          ...(matchingExtraction.title === undefined ? {} : { title: matchingExtraction.title }),
          model: matchingExtraction.model,
          prompt: matchingExtraction.prompt
        }
      ];
    }

    return [
      {
        name: `adhoc-${options.model}`,
        model: options.model,
        prompt: "prompts/opinion-extraction.md"
      }
    ];
  }

  return config.opinionExtractions.map((extraction) => ({
    name: extraction.name,
    ...(extraction.title === undefined ? {} : { title: extraction.title }),
    model: extraction.model,
    prompt: extraction.prompt
  }));
}

async function writeOpinionRunManifest(options: {
  createdAt: string;
  updatedAt: string;
  runId: string;
  extractionName: string;
  extractionTitle?: string;
  model: RegisteredModel;
  promptPath: string;
  promptSha256: string;
  normalizedDir: string;
  recordsAttempted: number;
  concurrency: number;
  fingerprint: OpinionRunFingerprint;
  offset: number;
  limit: number | undefined;
  runDir: string;
  recordsDir: string;
  opinionsDir: string;
  manifestPath: string;
  recordsWritten: number;
  opinionsWritten: number;
  failedRecords: number;
}): Promise<void> {
  const manifest: OpinionRunManifest = {
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
    runId: options.runId,
    extraction: {
      name: options.extractionName,
      ...(options.extractionTitle === undefined ? {} : { title: options.extractionTitle })
    },
    model: options.model,
    fingerprint: options.fingerprint,
    prompt: {
      path: options.promptPath,
      sha256: options.promptSha256
    },
    input: {
      normalizedDir: options.normalizedDir,
      recordsAttempted: options.recordsAttempted,
      concurrency: options.concurrency,
      ...(options.offset > 0 ? { offset: options.offset } : {}),
      ...(options.limit === undefined ? {} : { limit: options.limit })
    },
    output: {
      runDir: options.runDir,
      recordsDir: options.recordsDir,
      opinionsDir: options.opinionsDir,
      manifestPath: options.manifestPath,
      recordsWritten: options.recordsWritten,
      opinionsWritten: options.opinionsWritten,
      failedRecords: options.failedRecords
    }
  };

  await writeJsonArtifact(options.manifestPath, manifest);
}

async function findLatestCompatibleOpinionRunForModel(
  opinionsRootDir: string,
  extractionName: string,
  model: RegisteredModel,
  fingerprint: OpinionRunFingerprint
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
      fingerprint?: {
        extractionName?: string;
        promptSha256?: string;
        ingestManifestSha256?: string | null;
      };
      input?: {
        fingerprint?: {
          promptSha256?: string;
          ingestManifestSha256?: string | null;
        };
      };
    }>(manifestPath);

    if (
      manifest?.createdAt !== undefined &&
      (manifest.extraction?.name ?? manifest.fingerprint?.extractionName) === extractionName &&
      manifest.model?.name === model.name &&
      manifest.model?.provider === model.provider &&
      manifest.model?.region === model.region &&
      manifest.model?.modelId === model.modelId &&
      (manifest.fingerprint?.promptSha256 ?? manifest.input?.fingerprint?.promptSha256) ===
        fingerprint.promptSha256 &&
      ((manifest.fingerprint?.ingestManifestSha256 ??
        manifest.input?.fingerprint?.ingestManifestSha256 ??
        null) ===
        fingerprint.ingestManifestSha256)
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

async function findCompatibleOpinionRunById(
  opinionsRootDir: string,
  runId: string,
  extractionName: string,
  model: RegisteredModel,
  fingerprint: OpinionRunFingerprint
): Promise<{ runId: string; createdAt: string } | null> {
  const manifest = await readJsonFile<{
    createdAt?: string;
    extraction?: { name?: string };
    model?: { name?: string; provider?: string; region?: string; modelId?: string };
    fingerprint?: {
      extractionName?: string;
      promptSha256?: string;
      ingestManifestSha256?: string | null;
    };
    input?: {
      fingerprint?: {
        promptSha256?: string;
        ingestManifestSha256?: string | null;
      };
    };
  }>(path.join(opinionsRootDir, runId, "manifest.json"));

  if (
    manifest?.createdAt === undefined ||
    (manifest.extraction?.name ?? manifest.fingerprint?.extractionName) !== extractionName ||
    manifest.model?.name !== model.name ||
    manifest.model?.provider !== model.provider ||
    manifest.model?.region !== model.region ||
    manifest.model?.modelId !== model.modelId ||
    (manifest.fingerprint?.promptSha256 ?? manifest.input?.fingerprint?.promptSha256) !==
      fingerprint.promptSha256 ||
    ((manifest.fingerprint?.ingestManifestSha256 ??
      manifest.input?.fingerprint?.ingestManifestSha256 ??
      null) !== fingerprint.ingestManifestSha256)
  ) {
    return null;
  }

  return {
    runId,
    createdAt: manifest.createdAt
  };
}

async function resolveOpinionRunFingerprint(
  normalizedDir: string,
  extractionName: string,
  promptSha256: string
): Promise<OpinionRunFingerprint> {
  const ingestManifestPath = path.join(normalizedDir, "ingest-manifest.json");
  const ingestManifestSource = await readFile(ingestManifestPath, "utf8").catch(() => null);

  return {
    extractionName,
    promptSha256,
    ingestManifestSha256:
      ingestManifestSource === null ? null : sha256Hex(ingestManifestSource)
  };
}

async function loadExistingRunProgress(
  recordsDir: string,
  selectedSourceIds: Set<string> | undefined
): Promise<{
  recordsWritten: number;
  opinionsWritten: number;
  failedRecords: number;
  successfulSourceIds: Set<string>;
  recordStatusBySourceId: Map<string, "success" | "failed">;
}> {
  const entries = await readdir(recordsDir, { withFileTypes: true }).catch(() => []);
  let recordsWritten = 0;
  let opinionsWritten = 0;
  let failedRecords = 0;
  const successfulSourceIds = new Set<string>();
  const recordStatusBySourceId = new Map<string, "success" | "failed">();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const artifact = await readJsonFile<{
      sourceId?: string;
      opinionIds?: unknown;
      error?: unknown;
    }>(path.join(recordsDir, entry.name));

    if (artifact?.sourceId === undefined) {
      continue;
    }

    if (selectedSourceIds !== undefined && selectedSourceIds.has(artifact.sourceId) === false) {
      continue;
    }

    recordsWritten += 1;

    if (typeof artifact.error === "string" && artifact.error.length > 0) {
      failedRecords += 1;
      recordStatusBySourceId.set(artifact.sourceId, "failed");
      continue;
    }

    const opinionIds = Array.isArray(artifact.opinionIds) ? artifact.opinionIds.length : 0;
    opinionsWritten += opinionIds;
    successfulSourceIds.add(artifact.sourceId);
    recordStatusBySourceId.set(artifact.sourceId, "success");
  }

  return {
    recordsWritten,
    opinionsWritten,
    failedRecords,
    successfulSourceIds,
    recordStatusBySourceId
  };
}

function resolveModel(config: BroadlyProjectConfig, modelAlias: string): RegisteredModel {
  const model = config.models.find((item) => item.name === modelAlias);

  if (model === undefined) {
    throw new Error(`No model alias named '${modelAlias}' is registered in this project.`);
  }

  return model;
}

function createProgressReporter(totalRecords: number): {
  tick(values: { recordsWritten: number; opinionsWritten: number; failedRecords: number }): void;
  finish(): void;
} {
  if (totalRecords <= 0) {
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
    recordsWritten: number;
    opinionsWritten: number;
    failedRecords: number;
  }): void => {
    if (process.stdout.isTTY) {
      const width = 24;
      const ratio = Math.min(values.recordsWritten / totalRecords, 1);
      const filled = Math.round(width * ratio);
      const bar = `${"=".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}`;
      const line =
        `Progress [${bar}] ${values.recordsWritten}/${totalRecords}` +
        ` opinions=${values.opinionsWritten} failed=${values.failedRecords}`;
      const paddedLine =
        line.length < lastRenderedLength
          ? `${line}${" ".repeat(lastRenderedLength - line.length)}`
          : line;

      process.stdout.write(`\r${paddedLine}`);
      lastRenderedLength = paddedLine.length;
      return;
    }

    const shouldLog =
      values.recordsWritten === totalRecords ||
      values.recordsWritten === 1 ||
      values.recordsWritten >= lastPlainLogCount + 250;

    if (shouldLog) {
      process.stdout.write(
        `Processed ${values.recordsWritten}/${totalRecords} records; opinions=${values.opinionsWritten}; failed=${values.failedRecords}\n`
      );
      lastPlainLogCount = values.recordsWritten;
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

function resolveConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return 4;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Concurrency must be a positive integer.");
  }

  return value;
}

async function loadProjectConfig(configPath: string): Promise<BroadlyProjectConfig> {
  const source = await readFile(configPath, "utf8");
  return parseProjectConfig(source);
}

function buildOpinionPrompt(
  promptTemplate: string,
  normalizedRecord: NormalizedCommentRecord
): string {
  const derived = getNormalizedCommentDerivedFields(normalizedRecord);
  const fieldList = Object.keys(normalizedRecord.rawRow)
    .map((field) => `- ${field}`)
    .join("\n");

  return `${promptTemplate.trim()}

## Available field names

${fieldList}

## Derived primary text

\`\`\`text
${getNormalizedCommentPrimaryText(normalizedRecord)}
\`\`\`

${derived.translatedPrimaryText === undefined ? "" : `## Derived translated primary text

\`\`\`text
${derived.translatedPrimaryText}
\`\`\`

`}
${derived.titleText === undefined ? "" : `## Derived title or subject

\`\`\`text
${derived.titleText}
\`\`\`

`}
${derived.contextText === undefined ? "" : `## Derived context or prompt

\`\`\`text
${derived.contextText}
\`\`\`

`}
## Source record

\`\`\`text
${normalizedRecord.contentText}
\`\`\`
`;
}

function parseOpinionResponse(
  responseText: string,
  normalizedRecord: NormalizedCommentRecord
): OpinionExtractionResponse {
  const headerParsed = parseHeaderStyleOpinionResponse(responseText, normalizedRecord);

  if (headerParsed !== null) {
    return headerParsed;
  }

  throw new Error(
    "Model response did not match the required header format. Expected 'Split-Decision', 'Split-Rationale', and opinion blocks."
  );
}

function parseHeaderStyleOpinionResponse(
  responseText: string,
  normalizedRecord: NormalizedCommentRecord
): OpinionExtractionResponse | null {
  const lines = responseText
    .replace(/```[a-z]*\s*/gi, "")
    .replace(/```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const splitDecisionHeader = readSingleHeader(lines, "Split-Decision");
  const splitRationaleHeader = readSingleHeader(lines, "Split-Rationale");

  if (splitDecisionHeader === null && splitRationaleHeader === null) {
    return null;
  }

  const opinions: OpinionExtractionItem[] = [];
  let current: {
    opinion_text?: string;
    source_excerpt?: string;
    source_fields?: string[];
  } = {};

  for (const line of lines) {
    if (line.length === 0) {
      pushOpinionBlock(current, normalizedRecord, opinions);
      current = {};
      continue;
    }

    if (line.startsWith("Split-Decision:") || line.startsWith("Split-Rationale:")) {
      continue;
    }

    const header = readHeaderLine(line);

    if (header === null) {
      continue;
    }

    if (header.name === "Opinion-Text") {
      current.opinion_text = header.value;
    } else if (header.name === "Source-Excerpt") {
      current.source_excerpt = header.value;
    } else if (header.name === "Source-Fields") {
      current.source_fields = header.value
        .split("|")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }
  }

  pushOpinionBlock(current, normalizedRecord, opinions);

  const splitDecision =
    splitDecisionHeader === "none" ||
    splitDecisionHeader === "single" ||
    splitDecisionHeader === "multiple"
      ? splitDecisionHeader
      : deriveSplitDecision(opinions.length);

  return {
    split_decision:
      splitDecision === "none" && opinions.length > 0
        ? deriveSplitDecision(opinions.length)
        : splitDecision,
    split_rationale:
      splitRationaleHeader !== null && splitRationaleHeader.length > 0
        ? splitRationaleHeader
        : defaultSplitRationale(deriveSplitDecision(opinions.length), opinions.length),
    opinions
  };
}

function pushOpinionBlock(
  value: {
    opinion_text?: string;
    source_excerpt?: string;
    source_fields?: string[];
  },
  normalizedRecord: NormalizedCommentRecord,
  opinions: OpinionExtractionItem[]
): void {
  const opinion = normalizeOpinion(
    {
      opinion_text: value.opinion_text,
      source_excerpt: value.source_excerpt,
      source_fields: value.source_fields
    },
    normalizedRecord
  );

  if (opinion !== null) {
    opinions.push(opinion);
  }
}

function readSingleHeader(lines: string[], headerName: string): string | null {
  for (const line of lines) {
    const parsed = readHeaderLine(line);

    if (parsed?.name === headerName) {
      return parsed.value;
    }
  }

  return null;
}

function readHeaderLine(line: string): { name: string; value: string } | null {
  const trimmedLine = line.replace(/^[-*]\s*/, "");
  const separatorIndex = trimmedLine.indexOf(":");

  if (separatorIndex <= 0) {
    return null;
  }

  const name = canonicalHeaderName(trimmedLine.slice(0, separatorIndex));

  if (name === null) {
    return null;
  }

  return {
    name,
    value: trimmedLine.slice(separatorIndex + 1).trim()
  };
}

function canonicalHeaderName(value: string): string | null {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  switch (normalized) {
    case "split decision":
      return "Split-Decision";
    case "split rationale":
      return "Split-Rationale";
    case "opinion text":
      return "Opinion-Text";
    case "source excerpt":
      return "Source-Excerpt";
    case "source fields":
      return "Source-Fields";
    default:
      return null;
  }
}

function normalizeOpinion(item: {
  opinion_text?: unknown;
  source_excerpt?: unknown;
  source_fields?: unknown;
}, normalizedRecord: NormalizedCommentRecord): OpinionExtractionItem | null {
  const opinionText =
    typeof item.opinion_text === "string" ? item.opinion_text.trim() : "";
  const sourceExcerpt =
    typeof item.source_excerpt === "string" ? item.source_excerpt.trim() : "";
  const requestedSourceFields = Array.isArray(item.source_fields)
    ? item.source_fields
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
  const sourceFields = resolveSourceFields({
    requestedSourceFields,
    sourceExcerpt,
    normalizedRecord
  });

  if (opinionText.length === 0 || sourceExcerpt.length === 0) {
    return null;
  }

  return {
    opinion_text: opinionText,
    source_excerpt: sourceExcerpt,
    source_fields: sourceFields
  };
}

function resolveSourceFields(options: {
  requestedSourceFields: string[];
  sourceExcerpt: string;
  normalizedRecord: NormalizedCommentRecord;
}): string[] {
  const exactHeaders = Object.keys(options.normalizedRecord.rawRow);
  const matches = new Set<string>();

  for (const requestedField of options.requestedSourceFields) {
    const resolved = resolveExactHeader(requestedField, exactHeaders);

    if (resolved !== null) {
      matches.add(resolved);
    }
  }

  if (matches.size === 0) {
    for (const inferredField of inferFieldsFromExcerpt(options.sourceExcerpt, options.normalizedRecord)) {
      matches.add(inferredField);
    }
  }

  if (matches.size === 0) {
    const likelyCommentField = exactHeaders.find((header) =>
      normalizeFieldName(header).includes("comment question or idea")
    );

    if (likelyCommentField !== undefined) {
      matches.add(likelyCommentField);
    }
  }

  return [...matches];
}

function resolveExactHeader(requestedField: string, exactHeaders: string[]): string | null {
  if (exactHeaders.includes(requestedField)) {
    return requestedField;
  }

  const lowerMatch = exactHeaders.find(
    (header) => header.toLowerCase() === requestedField.toLowerCase()
  );

  if (lowerMatch !== undefined) {
    return lowerMatch;
  }

  const normalizedRequested = normalizeFieldName(requestedField);
  const requestedTokens = normalizedRequested.split(" ").filter(Boolean);
  let bestMatch: { header: string; score: number; tokenDelta: number } | null = null;

  for (const header of exactHeaders) {
    const normalizedHeader = normalizeFieldName(header);
    const headerTokens = normalizedHeader.split(" ").filter(Boolean);
    let score = 0;

    if (normalizedHeader === normalizedRequested) {
      score = 100;
    } else if (
      containsWholeNormalizedPhrase(normalizedHeader, normalizedRequested) ||
      containsWholeNormalizedPhrase(normalizedRequested, normalizedHeader)
    ) {
      score = 80;
    } else {
      const requestedTokenSet = new Set(requestedTokens);
      const headerTokenSet = new Set(headerTokens);
      const sharedCount = [...requestedTokenSet].filter((token) => headerTokenSet.has(token)).length;
      score = sharedCount;
    }

    const tokenDelta = Math.abs(headerTokens.length - requestedTokens.length);

    if (
      bestMatch === null ||
      score > bestMatch.score ||
      (score === bestMatch.score && tokenDelta < bestMatch.tokenDelta)
    ) {
      bestMatch = { header, score, tokenDelta };
    }
  }

  return bestMatch !== null && bestMatch.score >= 3 ? bestMatch.header : null;
}

function containsWholeNormalizedPhrase(value: string, phrase: string): boolean {
  if (value.length === 0 || phrase.length === 0) {
    return false;
  }

  return ` ${value} `.includes(` ${phrase} `);
}

function inferFieldsFromExcerpt(
  sourceExcerpt: string,
  normalizedRecord: NormalizedCommentRecord
): string[] {
  const normalizedExcerpt = normalizeText(sourceExcerpt);
  const exactHeaders = Object.keys(normalizedRecord.rawRow);
  const matches: string[] = [];

  for (const header of exactHeaders) {
    const value = normalizedRecord.rawRow[header];

    if (value === undefined || value.trim().length === 0) {
      continue;
    }

    const normalizedValue = normalizeText(value);
    const tokenCount = normalizedValue.split(" ").filter(Boolean).length;

    if (normalizedValue.length < 12 || tokenCount < 3) {
      continue;
    }

    if (
      normalizedValue.includes(normalizedExcerpt) ||
      normalizedExcerpt.includes(normalizedValue)
    ) {
      matches.push(header);
    }
  }

  return matches;
}

function normalizeFieldName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveSplitDecision(opinionCount: number): "none" | "single" | "multiple" {
  if (opinionCount === 0) {
    return "none";
  }

  if (opinionCount === 1) {
    return "single";
  }

  return "multiple";
}

function defaultSplitRationale(
  splitDecision: "none" | "single" | "multiple",
  opinionCount: number
): string {
  if (splitDecision === "none") {
    return "No substantive opinion unit was identified in the record.";
  }

  if (splitDecision === "single") {
    return opinionCount === 1
      ? "The record was treated as one substantive issue."
      : "The record was treated as a single substantive issue.";
  }

  return "The record was split because it appears to contain materially separate issues.";
}

function buildOpinionRecord(options: {
  createdAt: string;
  model: RegisteredModel;
  normalizedRecord: NormalizedCommentRecord;
  normalizedRecordPath: string;
  opinion: OpinionExtractionItem;
  promptPath: string;
  promptSha256: string;
  responseStopReason: string | null;
}) {
  const opinionPayload = JSON.stringify({
    sourceId: options.normalizedRecord.sourceId,
    opinionText: options.opinion.opinion_text,
    sourceExcerpt: options.opinion.source_excerpt,
    model: options.model.name
  });
  const opinionId = sha256Hex(opinionPayload);

  return {
    opinionId,
    sourceId: options.normalizedRecord.sourceId,
    sourceContentSha256: options.normalizedRecord.contentSha256,
    opinionText: options.opinion.opinion_text,
    excerpt: options.opinion.source_excerpt,
    sourceFields: options.opinion.source_fields,
    createdAt: options.createdAt,
    extractionMethod: "llm-opinion-extraction",
    model: options.model,
    prompt: {
      path: options.promptPath,
      sha256: options.promptSha256
    },
    responseStopReason: options.responseStopReason,
    provenance: {
      normalizedRecordPath: options.normalizedRecordPath,
      sourceImportPath: options.normalizedRecord.provenance.importPath,
      sourceFileSha256: options.normalizedRecord.provenance.sourceFileSha256,
      sourceRowNumber: options.normalizedRecord.provenance.sourceRowNumber,
      ...(options.normalizedRecord.provenance.externalId === undefined
        ? {}
        : { externalId: options.normalizedRecord.provenance.externalId })
    }
  };
}

async function listNormalizedRecordPaths(normalizedDir: string): Promise<string[]> {
  const entries = await readdir(normalizedDir, { withFileTypes: true });

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

async function writeJsonArtifact(outputPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readNormalizedRecord(normalizedRecordPath: string): Promise<NormalizedCommentRecord> {
  const source = await readFile(normalizedRecordPath, "utf8");
  return JSON.parse(source) as NormalizedCommentRecord;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function createRunId(modelAlias: string): string {
  const timestamp = formatRunTimestamp(new Date());
  return `${timestamp}-${modelAlias}`;
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
