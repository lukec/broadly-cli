import { access, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import {
  createStarterProjectConfig,
  slugifyProjectName,
  serializeProjectConfig
} from "@broadly/config";
import {
  DEFAULT_PROJECT_DIRECTORIES,
  ensureProjectLayout
} from "@broadly/core";

export interface InitProjectOptions {
  project?: string;
  name?: string;
  description?: string;
  goals?: string[];
  force: boolean;
}

export async function initProject(options: InitProjectOptions): Promise<void> {
  const setup = await resolveProjectSetup(options);
  const projectPaths = await ensureProjectLayout(setup.rootDir);
  const broadlyYaml = serializeProjectConfig(
    createStarterProjectConfig({
      name: setup.name,
      description: setup.description,
      goals: setup.goals
    })
  );

  if (!options.force && (await fileExists(projectPaths.configPath))) {
    throw new Error(`Refusing to overwrite existing config: ${projectPaths.configPath}`);
  }

  await writeFile(projectPaths.configPath, broadlyYaml, "utf8");

  for (const relativeDirectory of DEFAULT_PROJECT_DIRECTORIES) {
    const absoluteDirectory = path.join(setup.rootDir, relativeDirectory);
    const directoryEntries = await readdir(absoluteDirectory);

    if (directoryEntries.length === 0) {
      await writeFile(path.join(absoluteDirectory, ".gitkeep"), "", "utf8");
    }
  }

  printNextSteps(setup.rootDir, projectPaths.configPath);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function printNextSteps(rootDir: string, configPath: string): void {
  const lines = [
    `Initialized Broadly project at ${rootDir}`,
    "",
    "Created:",
    `- ${configPath}`,
    "- data/raw",
    "- data/normalized",
    "- data/opinions",
    "- runs",
    "- reports",
    "",
    "Next steps:",
    `1. cd ${rootDir}`,
    "2. broadly ingest ./path/to/source.csv",
    "3. Edit broadly.yaml with guiding questions and Bedrock model IDs."
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function resolveProjectSetup(options: InitProjectOptions): Promise<ResolvedProjectSetup> {
  const fallbackName = options.project === undefined ? undefined : path.basename(options.project);
  const name = await resolveRequiredField({
    missingFlag: "--name",
    prompt: "Project name",
    providedValue: options.name,
    ...(fallbackName === undefined ? {} : { defaultValue: fallbackName })
  });
  const description = await resolveRequiredField({
    missingFlag: "--description",
    prompt: "Project description",
    providedValue: options.description,
    defaultValue: "Local-first Broadly analysis project."
  });
  const goals = await resolveGoals(options.goals);
  const projectRoot = resolveProjectRoot(options.project ?? slugifyProjectName(name));

  return {
    description,
    goals,
    name,
    rootDir: projectRoot
  };
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

interface ResolvedProjectSetup {
  rootDir: string;
  name: string;
  description: string;
  goals: string[];
}

interface ResolveRequiredFieldOptions {
  missingFlag: string;
  prompt: string;
  providedValue: string | undefined;
  defaultValue?: string | undefined;
}

async function resolveRequiredField(
  options: ResolveRequiredFieldOptions
): Promise<string> {
  const providedValue = options.providedValue?.trim();

  if (providedValue !== undefined && providedValue.length > 0) {
    return providedValue;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Missing required option: provide ${options.missingFlag} when not running interactively.`
    );
  }

  const answer = await prompt(options.prompt, options.defaultValue);
  const trimmedAnswer = answer.trim();

  if (trimmedAnswer.length > 0) {
    return trimmedAnswer;
  }

  if (options.defaultValue !== undefined && options.defaultValue.trim().length > 0) {
    return options.defaultValue.trim();
  }

  throw new Error(`${options.prompt} is required.`);
}

async function resolveGoals(providedGoals: string[] | undefined): Promise<string[]> {
  const normalizedGoals = normalizeGoals(providedGoals ?? []);

  if (normalizedGoals.length > 0) {
    return normalizedGoals;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Missing required option: provide one or more --goal values when not running interactively.");
  }

  const answer = await prompt("Project goals (separate multiple goals with ;)");
  const promptedGoals = normalizeGoals(answer.split(";"));

  if (promptedGoals.length === 0) {
    throw new Error("At least one project goal is required.");
  }

  return promptedGoals;
}

function normalizeGoals(goals: string[]): string[] {
  return goals.map((goal) => goal.trim()).filter((goal) => goal.length > 0);
}

async function prompt(label: string, defaultValue?: string): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const suffix =
      defaultValue === undefined || defaultValue.trim().length === 0
        ? ""
        : ` [${defaultValue}]`;

    return await readline.question(`${label}${suffix}: `);
  } finally {
    readline.close();
  }
}
