#!/usr/bin/env node

import { Command } from "commander";

import { addDataSource } from "./commands/addDataSource.js";
import { runAnalysis } from "./commands/analysis.js";
import { extractOpinions } from "./commands/extractOpinions.js";
import { initProject } from "./commands/init.js";
import { runLlm } from "./commands/llm.js";
import { addModel, checkModels, removeModel } from "./commands/models.js";
import { extractOpinionsWithModel } from "./commands/opinions.js";
import { generateReport } from "./commands/report.js";
import { runQa } from "./commands/qa.js";
import { showProjectStatus } from "./commands/status.js";
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
