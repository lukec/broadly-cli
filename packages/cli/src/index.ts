#!/usr/bin/env node

import { Command } from "commander";

import { addDataSource } from "./commands/addDataSource.js";
import { extractOpinions } from "./commands/extractOpinions.js";
import { initProject } from "./commands/init.js";
import { addModel, checkModels, removeModel } from "./commands/models.js";

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
  .command("extract-opinions")
  .description("Create opinion-unit artifacts from normalized records.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .action(
    async (options: { project?: string }) => {
      await extractOpinions(
        options.project === undefined ? {} : { project: options.project }
      );
    }
  );

const modelsCommand = program
  .command("models")
  .description("Manage model aliases available to this project.");

modelsCommand
  .command("add")
  .description("Add a model alias to this project and check local credentials.")
  .option("--project <project>", "Project directory; defaults to the nearest broadly.yaml")
  .option("--provider <provider>", "Model provider: bedrock or google-cloud")
  .option("--model-id <modelId>", "Provider model identifier")
  .option("--region <region>", "Provider region for this model")
  .option("--name <name>", "Project alias for this model")
  .action(
    async (
      options: {
        project?: string;
        provider?: "bedrock" | "google-cloud";
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
