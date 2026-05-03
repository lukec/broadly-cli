#!/usr/bin/env node

import { Command } from "commander";

import { addDataSource } from "./commands/addDataSource.js";
import { runAnalysis } from "./commands/analysis.js";
import { defaultBlueskyScrapeOptions, scrapeBluesky } from "./commands/bluesky.js";
import { configureDataset } from "./commands/configureDataset.js";
import { extractOpinions } from "./commands/extractOpinions.js";
import { initProject } from "./commands/init.js";
import { runLlm } from "./commands/llm.js";
import { addModel, checkModels, removeModel } from "./commands/models.js";
import { extractOpinionsWithModel } from "./commands/opinions.js";
import { generateReport } from "./commands/report.js";
import { runQa } from "./commands/qa.js";
import { runPipeline } from "./commands/run.js";
import { runReview } from "./commands/review.js";
import { showProjectStatus } from "./commands/status.js";
import { generateStatements, reviewStatements, runStatementQa } from "./commands/statements.js";
import { serveProjectWeb } from "./commands/web.js";

const program = new Command();

program
  .name("broadly")
  .description("Local-first analysis harness for Broad Listener.")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a local Broadly project under ./projects.")
  .argument("[project]", "Project directory name to create under ./projects")
  .option("--name <name>", "Human-readable project name")
  .option("--description <description>", "Project description")
  .option("--goal <goal>", "Project goal; repeat to add more than one", collectOptionValue, [])
  .option("--force", "Overwrite an existing broadly.yaml file", false)
  .action(
    async (
      project: string | undefined,
      options: {
        description?: string;
        force: boolean;
        goal: string[];
        name?: string;
      }
    ) => {
      await initProject({
        force: options.force,
        ...(project === undefined ? {} : { project }),
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.goal.length === 0 ? {} : { goals: options.goal })
      });
    }
  );

program
  .command("ingest")
  .description("Ingest a tabular source file and write normalized row artifacts.")
  .argument("<file>", "Path to a CSV or TSV file")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .action(
    async (
      file: string,
      options: {
        project?: string;
      }
    ) => {
      await addDataSource({
        datasetPath: file,
        ...(options.project === undefined ? {} : { project: options.project })
      });
    }
  );

const configureCommand = program
  .command("configure")
  .description("Configure project settings from local artifacts.");

configureCommand
  .command("dataset")
  .description("Inspect a tabular dataset and configure the fields Broadly should analyze.")
  .argument("[file]", "Path to a CSV or TSV file; defaults to dataset.path in broadly.yaml")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--model <name>", "Project model alias to use for field classification")
  .option(
    "--sample-rows <count>",
    "Number of example rows to include in the classification prompt",
    parsePositiveInteger,
    8
  )
  .option(
    "--max-output-tokens <count>",
    "Maximum output tokens to request from the classification model",
    parsePositiveInteger,
    1200
  )
  .action(
    async (
      file: string | undefined,
      options: {
        maxOutputTokens: number;
        model?: string;
        project?: string;
        sampleRows: number;
      }
    ) => {
      await configureDataset({
        ...(file === undefined ? {} : { file }),
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.model === undefined ? {} : { model: options.model }),
        sampleRows: options.sampleRows,
        maxOutputTokens: options.maxOutputTokens
      });
    }
  );

program
  .command("analysis")
  .description("Generate embedding, reduction, clustering, and perspective-planning artifacts.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--embedding-model <name>", "Project model alias to use for embeddings")
  .option("--limit <count>", "Only process the first N opinion artifacts from the selected run", parsePositiveInteger)
  .option("--offset <count>", "Skip the first N opinion artifacts from the selected run", parsePositiveInteger)
  .action(
    async (options: {
      project?: string;
      embeddingModel?: string;
      limit?: number;
      offset?: number;
    }) => {
      await runAnalysis({
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.embeddingModel === undefined
          ? {}
          : { embeddingModel: options.embeddingModel }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.offset === undefined ? {} : { offset: options.offset })
      });
    }
  );

program
  .command("run")
  .description("Run the end-to-end local pipeline: review, opinions, analysis, and report.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--review-model <name>", "Project model alias to use for comment review")
  .option("--extraction <name>", "Configured opinion extraction name to run; defaults to all configured extractions")
  .option(
    "-c, --concurrency <count>",
    "Number of opinion extraction requests to run in parallel",
    parsePositiveInteger
  )
  .option("--no-review", "Skip the review step")
  .option("--no-opinions", "Skip the opinion extraction step")
  .option("--no-analysis", "Skip the analysis step")
  .option("--no-report", "Skip the report generation step")
  .action(
    async (options: {
      project?: string;
      reviewModel?: string;
      extraction?: string;
      concurrency?: number;
      review: boolean;
      opinions: boolean;
      analysis: boolean;
      report: boolean;
    }) => {
      await runPipeline({
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.reviewModel === undefined ? {} : { reviewModel: options.reviewModel }),
        ...(options.extraction === undefined ? {} : { extraction: options.extraction }),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        review: options.review,
        opinions: options.opinions,
        analysis: options.analysis,
        report: options.report
      });
    }
  );

program
  .command("report")
  .description("Generate a report bundle and static site from an analysis run.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--run <runId>", "Analysis run id to publish; defaults to the latest run")
  .action(
    async (options: {
      project?: string;
      run?: string;
    }) => {
      await generateReport({
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.run === undefined ? {} : { run: options.run })
      });
    }
  );

program
  .command("qa")
  .description("Run structural and model-assisted QA checks against an analysis run and report bundle.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--run <runId>", "Analysis run id to review; defaults to the current analysis run, then latest")
  .option(
    "--phase <name>",
    "QA phase to run; repeat for multiple phases (structural, cluster-membership, theme-support)",
    collectOptionValue,
    []
  )
  .option("--model <name>", "Project model alias to use as the QA judge")
  .option("--sample-size <count>", "Sample this many opinions per cluster during semantic QA", parsePositiveInteger)
  .option("--sample-percent <percent>", "Sample this percentage of opinions per cluster during semantic QA", parsePositiveInteger)
  .option("--qa-all", "Review all eligible opinions instead of sampling", false)
  .option("--view <name>", "Limit semantic QA to one analysis view; repeatable", collectOptionValue, [])
  .option("--cluster-limit <count>", "Limit semantic QA to the first N eligible clusters", parsePositiveInteger)
  .option("--theme-limit <count>", "Limit theme-support QA to the first N eligible themes", parsePositiveInteger)
  .action(
    async (options: {
      project?: string;
      run?: string;
      phase: string[];
      model?: string;
      sampleSize?: number;
      samplePercent?: number;
      qaAll: boolean;
      view: string[];
      clusterLimit?: number;
      themeLimit?: number;
    }) => {
      await runQa({
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.run === undefined ? {} : { run: options.run }),
        ...(options.phase.length === 0 ? {} : { phase: options.phase }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.sampleSize === undefined ? {} : { sampleSize: options.sampleSize }),
        ...(options.samplePercent === undefined ? {} : { samplePercent: options.samplePercent }),
        ...(options.qaAll === true ? { qaAll: true } : {}),
        ...(options.view.length === 0 ? {} : { view: options.view }),
        ...(options.clusterLimit === undefined ? {} : { clusterLimit: options.clusterLimit }),
        ...(options.themeLimit === undefined ? {} : { themeLimit: options.themeLimit })
      });
    }
  );

const statementsCommand = program
  .command("statements")
  .description("Generate, QA, and locally review votable statement banks.");

statementsCommand
  .command("generate")
  .description("Generate a pending statement bank from existing report artifacts.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--run <runId>", "Report/analysis run id to use; defaults to the latest report")
  .option("--from-report", "Generate statements from reports/<run-id>/report-bundle.json", false)
  .action(
    async (options: {
      project?: string;
      run?: string;
      fromReport: boolean;
    }) => {
      await generateStatements({
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.run === undefined ? {} : { run: options.run }),
        ...(options.fromReport === true ? { fromReport: true } : {})
      });
    }
  );

statementsCommand
  .command("qa")
  .description("Run deterministic QA checks over a statement bank.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--run <statementRunId>", "Statement run id; defaults to current, then latest")
  .action(
    async (options: {
      project?: string;
      run?: string;
    }) => {
      await runStatementQa({
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.run === undefined ? {} : { run: options.run })
      });
    }
  );

statementsCommand
  .command("review")
  .description("Review statement statuses and export accepted statements.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--run <statementRunId>", "Statement run id; defaults to current, then latest")
  .option("--statement <statementId>", "Statement id to update")
  .option("--status <status>", "pending, accepted, rejected, hidden_from_public, or excluded_from_analysis")
  .option("--text <text>", "Replacement statement text for --statement")
  .option("--note <note>", "Reviewer note for changed statements")
  .option("--accept <statementId>", "Accept a statement; repeatable", collectOptionValue, [])
  .option("--reject <statementId>", "Reject a statement; repeatable", collectOptionValue, [])
  .option("--export-accepted", "Write accepted-statements.json for the run", false)
  .action(
    async (options: {
      accept: string[];
      exportAccepted: boolean;
      note?: string;
      project?: string;
      reject: string[];
      run?: string;
      statement?: string;
      status?: string;
      text?: string;
    }) => {
      await reviewStatements({
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.run === undefined ? {} : { run: options.run }),
        ...(options.statement === undefined ? {} : { statement: options.statement }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.text === undefined ? {} : { text: options.text }),
        ...(options.note === undefined ? {} : { note: options.note }),
        ...(options.accept.length === 0 ? {} : { accept: options.accept }),
        ...(options.reject.length === 0 ? {} : { reject: options.reject }),
        ...(options.exportAccepted === true ? { exportAccepted: true } : {})
      });
    }
  );

program
  .command("extract-opinions")
  .description("Create opinion-unit artifacts from normalized records.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--extraction <name>", "Configured opinion extraction name to run; defaults to all configured extractions")
  .option("--archive", "Move prior opinion runs into archive/ before starting a new extraction", false)
  .option("--resume", "Continue the latest run for the configured model and skip records that already succeeded", false)
  .option(
    "-c, --concurrency <count>",
    "Number of opinion extraction requests to run in parallel",
    parsePositiveInteger
  )
  .action(
    async (options: {
      project?: string;
      extraction?: string;
      archive: boolean;
      resume: boolean;
      concurrency?: number;
    }) => {
      await extractOpinions(
        {
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.extraction === undefined ? {} : { extraction: options.extraction }),
          ...(options.archive === true ? { archive: true } : {}),
          ...(options.resume === true ? { resume: true } : {}),
          ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
        }
      );
    }
  );

program
  .command("opinions")
  .description("Extract opinion units from normalized records using one or more configured opinion extractions.")
  .option("--extraction <name>", "Configured opinion extraction name to run; defaults to all configured extractions")
  .option("--model <name>", "Project model alias to use for opinion extraction")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--limit <count>", "Only process the first N normalized records", parsePositiveInteger)
  .option("--offset <count>", "Skip the first N normalized records", parsePositiveInteger)
  .option("--archive", "Move prior opinion runs into archive/ before starting a new extraction", false)
  .option("--resume", "Continue the latest run for this model and skip records that already succeeded", false)
  .option(
    "-c, --concurrency <count>",
    "Number of opinion extraction requests to run in parallel",
    parsePositiveInteger
  )
  .action(
    async (options: {
      extraction?: string;
      model?: string;
      project?: string;
      limit?: number;
      offset?: number;
      archive: boolean;
      resume: boolean;
      concurrency?: number;
    }) => {
      await extractOpinionsWithModel({
        ...(options.extraction === undefined ? {} : { extraction: options.extraction }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.offset === undefined ? {} : { offset: options.offset }),
        ...(options.archive === true ? { archive: true } : {}),
        ...(options.resume === true ? { resume: true } : {}),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
      });
    }
  );

program
  .command("review")
  .description("Generate machine review decisions and suggestions for comments and opinions.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--kind <kind>", "comments, opinions, or both", "both")
  .option("--model <name>", "Project model alias to use for review screening")
  .option(
    "-c, --concurrency <count>",
    "Number of review requests to run in parallel",
    parsePositiveInteger
  )
  .action(
    async (options: {
      project?: string;
      kind: string;
      model?: string;
      concurrency?: number;
    }) => {
      const normalizedKind =
        options.kind === "comments" || options.kind === "opinions" || options.kind === "both"
          ? options.kind
          : "both";

      await runReview({
        ...(options.project === undefined ? {} : { project: options.project }),
        kind: normalizedKind,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
      });
    }
  );

program
  .command("status")
  .description("Show project status similar to the Broadly web overview.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .action(async (options: { project?: string }) => {
    await showProjectStatus(options);
  });

program
  .command("web")
  .description("Start a local web viewer for the current Broadly project.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--port <port>", "Port to bind the local server", parsePositiveInteger)
  .option("--watch", "Reload browser pages when project files change", false)
  .action(async (options: { project?: string; port?: number; watch: boolean }) => {
    await serveProjectWeb(options);
  });

const scrapeCommand = program
  .command("scrape")
  .description("Scrape public web and social sources into local Broadly datasets.");

scrapeCommand
  .command("bluesky")
  .description("Scrape recent Bluesky posts matching account and city queries into a project CSV.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option(
    "--account <handle>",
    "Target Bluesky account handle to resolve; repeat to track more than one account",
    collectOptionValue,
    []
  )
  .option(
    "--query <query>",
    "Bluesky search query; repeat to add more than one query",
    collectOptionValue,
    []
  )
  .option("--since <iso>", "Only collect posts at or after this ISO timestamp")
  .option("--until <iso>", "Only collect posts before this ISO timestamp")
  .option(
    "--since-days <days>",
    "Date window to collect when --since is omitted",
    parsePositiveInteger,
    defaultBlueskyScrapeOptions.sinceDays
  )
  .option(
    "--limit <count>",
    "Maximum posts to fetch per query",
    parsePositiveInteger,
    defaultBlueskyScrapeOptions.limit
  )
  .option(
    "--output <path>",
    "Project-relative CSV output path",
    defaultBlueskyScrapeOptions.output
  )
  .option(
    "--manifest <path>",
    "Project-relative scrape manifest path",
    defaultBlueskyScrapeOptions.manifest
  )
  .option(
    "--appview <url>",
    "Bluesky AppView service URL",
    defaultBlueskyScrapeOptions.appview
  )
  .action(
    async (options: {
      account: string[];
      appview: string;
      limit: number;
      manifest: string;
      output: string;
      project?: string;
      query: string[];
      since?: string;
      sinceDays: number;
      until?: string;
    }) => {
      await scrapeBluesky({
        account:
          options.account.length === 0
            ? [...defaultBlueskyScrapeOptions.account]
            : options.account,
        appview: options.appview,
        limit: options.limit,
        manifest: options.manifest,
        output: options.output,
        ...(options.project === undefined ? {} : { project: options.project }),
        query:
          options.query.length === 0
            ? [...defaultBlueskyScrapeOptions.query]
            : options.query,
        ...(options.since === undefined ? {} : { since: options.since }),
        sinceDays: options.sinceDays,
        ...(options.until === undefined ? {} : { until: options.until })
      });
    }
  );

program
  .command("llm")
  .description("Run a prompt against one registered model alias or all registered models.")
  .argument("<prompt...>", "Prompt text")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--model <name>", "Project model alias to use")
  .option("--all-models", "Run the prompt against every registered model", false)
  .option("--max-output-tokens <count>", "Maximum output tokens to request", parsePositiveInteger)
  .action(
    async (
      promptParts: string[],
      options: {
        project?: string;
        model?: string;
        allModels: boolean;
        maxOutputTokens?: number;
      }
    ) => {
      await runLlm({
        prompt: promptParts.join(" "),
        allModels: options.allModels,
        ...(options.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.model === undefined ? {} : { model: options.model })
      });
    }
  );

const modelsCommand = program
  .command("models")
  .description("Manage model aliases available to this project.");

modelsCommand
  .command("add")
  .description("Add a model alias to this project and check local credentials.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--provider <provider>", "Model provider: bedrock, google-cloud, or openai")
  .option("--model-id <modelId>", "Provider model identifier")
  .option("--region <region>", "Provider region for this model")
  .option("--name <name>", "Project alias for this model")
  .action(
    async (
      options: {
        project?: string;
        provider?: "bedrock" | "google-cloud" | "openai";
        modelId?: string;
        region?: string;
        name?: string;
      }
    ) => {
      await addModel(options);
    }
  );

modelsCommand
  .command("remove")
  .description("Remove a model alias from this project.")
  .argument("[name]", "Project alias to remove; prompts when omitted")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .action(
    async (
      name: string | undefined,
      options: {
        project?: string;
      }
    ) => {
      await removeModel({
        ...(name === undefined ? {} : { name }),
        ...(options.project === undefined ? {} : { project: options.project })
      });
    }
  );

modelsCommand
  .command("check")
  .description("Check whether local credentials are available for registered models.")
  .argument("[name]", "Optional project alias to check")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .action(
    async (
      name: string | undefined,
      options: {
        project?: string;
      }
    ) => {
      await checkModels({
        ...(name === undefined ? {} : { name }),
        ...(options.project === undefined ? {} : { project: options.project })
      });
    }
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received '${value}'.`);
  }

  return parsed;
}
