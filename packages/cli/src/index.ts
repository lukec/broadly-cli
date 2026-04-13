#!/usr/bin/env node

import { Command } from "commander";

import { addDataSource } from "./commands/addDataSource.js";
import { extractOpinions } from "./commands/extractOpinions.js";
import { initProject } from "./commands/init.js";

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

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}
