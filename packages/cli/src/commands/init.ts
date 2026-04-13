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

  const starterPromptPath = path.join(projectPaths.promptsDir, "opinion-extraction.md");

  if (options.force || !(await fileExists(starterPromptPath))) {
    await writeFile(starterPromptPath, createStarterOpinionExtractionPrompt(), "utf8");
  }

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
    "- prompts",
    "- runs",
    "- reports",
    "",
    "Next steps:",
    `1. cd ${rootDir}`,
    "2. broadly ingest ./path/to/source.csv",
    "3. broadly models add",
    "4. Review and edit prompts/opinion-extraction.md for your domain and dataset.",
    "5. Edit broadly.yaml with guiding questions and model aliases."
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function createStarterOpinionExtractionPrompt(): string {
  return `# Opinion Extraction Prompt

You are a research assistant for broad listening analysis.

The input is one normalized source record rendered as labeled fields followed by values.
Extract zero or more distinct opinion units from that record.

## Working definition

An opinion unit is one substantive request, concern, proposal, complaint, judgment, or preference that can stand on its own.

## Rules

- Return structured JSON only.
- Keep the output in the same language as the source excerpt whenever possible.
- Prefer to keep the record as a single opinion unit unless it clearly contains multiple distinct issues.
- Split only when the source expresses materially separate issues that would cluster differently.
- Exclude text that does not amount to a substantive opinion.
  - Examples: "I don't know", greetings, pure logistics, empty filler, or text too vague to support a defensible opinion.
- Do not invent missing context or force meaning onto vague text.
- Normalize wording only enough to make the opinion clear and concise.
- Preserve concrete actions, problems, requests, and policy-relevant details.
- Include a verbatim supporting excerpt so later stages can verify the extraction against the source.

## Output schema

\`\`\`json
{
  "opinions": [
    {
      "opinion_text": "One clear substantive opinion",
      "source_excerpt": "Verbatim supporting text from the source record",
      "source_fields": ["Field name 1", "Field name 2"]
    }
  ]
}
\`\`\`

## Input / output examples

### Example 1: keep as one opinion

Input:

\`\`\`text
Comment: Citizens need to be educated about AI's capabilities, limitations, and ethical considerations.
\`\`\`

Output:

\`\`\`json
{
  "opinions": [
    {
      "opinion_text": "Citizens should be educated about AI's capabilities, limitations, and ethical considerations",
      "source_excerpt": "Citizens need to be educated about AI's capabilities, limitations, and ethical considerations.",
      "source_fields": ["Comment"]
    }
  ]
}
\`\`\`

### Example 2: exclude non-opinion text

Input:

\`\`\`text
Comment: I don't know.
\`\`\`

Output:

\`\`\`json
{
  "opinions": []
}
\`\`\`

### Example 3: split only when the issues are distinct

Input:

\`\`\`text
Comment: I would like roads improved, bridges enhanced, and digitalization in municipalities promoted as soon as possible, and I also think more public tourist facilities are still needed.
\`\`\`

Output:

\`\`\`json
{
  "opinions": [
    {
      "opinion_text": "Road improvement and bridge enhancement should be advanced as soon as possible",
      "source_excerpt": "I would like roads improved, bridges enhanced",
      "source_fields": ["Comment"]
    },
    {
      "opinion_text": "Digitalization in municipalities should be promoted as soon as possible",
      "source_excerpt": "digitalization in municipalities promoted as soon as possible",
      "source_fields": ["Comment"]
    },
    {
      "opinion_text": "More public tourist facilities are needed",
      "source_excerpt": "I also think more public tourist facilities are still needed",
      "source_fields": ["Comment"]
    }
  ]
}
\`\`\`
`;
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
