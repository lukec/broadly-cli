import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig, type BroadlyProjectConfig } from "@broadly/config";
import { resolveProjectPaths, sha256Hex } from "@broadly/core";

import { runAnalysis } from "./analysis.js";
import { extractOpinionsWithModel } from "./opinions.js";
import { resolveCommandProjectRoot } from "./projectDashboard.js";
import { generateReport } from "./report.js";
import {
  loadReviewPromptTemplate,
  resolveReviewModel,
  REVIEW_PROMPT_FILENAME,
  runReview
} from "./review.js";
import { withProjectActionLog } from "../projectLog.js";

export interface RunCommandOptions {
  project?: string;
  review?: boolean;
  opinions?: boolean;
  analysis?: boolean;
  report?: boolean;
  reviewModel?: string;
  extraction?: string;
  concurrency?: number;
}

interface ReviewManifest {
  kind?: "comments" | "opinions" | "both";
  fingerprint?: {
    commentsSha256?: string | null;
    opinionsSha256?: string | null;
    modelSha256?: string | null;
    promptSha256?: string | null;
  };
  model?: {
    name?: string;
    provider?: string;
    region?: string;
    modelId?: string;
  } | null;
}

export async function runPipeline(options: RunCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "run",
    details: {
      review: options.review !== false,
      opinions: options.opinions !== false,
      analysis: options.analysis !== false,
      report: options.report !== false,
      reviewModel: options.reviewModel ?? "(configured)",
      extraction: options.extraction ?? "(all configured)",
      concurrency: options.concurrency
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = parseProjectConfig(await readFile(projectPaths.configPath, "utf8"));

      process.stdout.write(`Broadly run for ${projectRoot}\n\n`);

      if (options.review !== false) {
        await maybeRunReview({
          projectRoot,
          projectPaths,
          config,
          ...(options.reviewModel === undefined
            ? {}
            : { explicitReviewModel: options.reviewModel })
        });
      } else {
        process.stdout.write("Review: skipped (--no-review)\n\n");
      }

      if (options.opinions !== false) {
        process.stdout.write("Opinions: starting\n");
        await extractOpinionsWithModel({
          project: projectRoot,
          ...(options.extraction === undefined ? {} : { extraction: options.extraction }),
          ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
        });
        process.stdout.write("\n");
      } else {
        process.stdout.write("Opinions: skipped (--no-opinions)\n\n");
      }

      if (options.analysis !== false) {
        process.stdout.write("Analysis: starting\n");
        await runAnalysis({
          project: projectRoot
        });
        process.stdout.write("\n");
      } else {
        process.stdout.write("Analysis: skipped (--no-analysis)\n\n");
      }

      if (options.report !== false) {
        process.stdout.write("Report: starting\n");
        await generateReport({
          project: projectRoot
        });
        process.stdout.write("\n");
      } else {
        process.stdout.write("Report: skipped (--no-report)\n\n");
      }

      process.stdout.write("Broadly run complete.\n");
    }
  });
}

async function maybeRunReview(options: {
  projectRoot: string;
  projectPaths: ReturnType<typeof resolveProjectPaths>;
  config: BroadlyProjectConfig;
  explicitReviewModel?: string;
}): Promise<void> {
  const reviewModel = resolveReviewModel(options.config, options.explicitReviewModel);

  if (reviewModel === null) {
    process.stdout.write(
      "Review: skipped (no review model configured; set review_model or pass --review-model)\n\n"
    );
    return;
  }

  const promptPath = path.join(options.projectRoot, "prompts", REVIEW_PROMPT_FILENAME);
  const promptTemplate = await loadReviewPromptTemplate(promptPath);
  const expectedCommentsSha256 = await computeNormalizedCommentsSha256(
    path.join(options.projectPaths.dataDir, "normalized")
  );
  const expectedModelSha256 = sha256Hex(
    JSON.stringify({
      name: reviewModel.name,
      provider: reviewModel.provider,
      region: reviewModel.region,
      modelId: reviewModel.modelId
    })
  );
  const existingManifest = await readJsonFile<ReviewManifest>(
    path.join(options.projectPaths.reviewDir, "review-manifest.json")
  );

  if (
    existingManifest?.kind === "comments" &&
    existingManifest.fingerprint?.commentsSha256 === expectedCommentsSha256 &&
    existingManifest.fingerprint?.modelSha256 === expectedModelSha256 &&
    existingManifest.fingerprint?.promptSha256 === sha256Hex(promptTemplate.source)
  ) {
    process.stdout.write("Review: up to date, skipping\n\n");
    return;
  }

  process.stdout.write("Review: starting\n");
  await runReview({
    project: options.projectRoot,
    kind: "comments",
    model: reviewModel.name
  });
  process.stdout.write("\n");
}

async function computeNormalizedCommentsSha256(normalizedDir: string): Promise<string> {
  const entries = await readdir(normalizedDir, { withFileTypes: true }).catch(() => []);
  const sourceIds = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "ingest-manifest.json")
    .map((entry) => entry.name.replace(/\.json$/u, ""))
    .sort((left, right) => left.localeCompare(right));

  return sha256Hex(JSON.stringify(sourceIds));
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}
