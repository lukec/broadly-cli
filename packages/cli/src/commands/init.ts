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
import { appendProjectLogEvent, ensureProjectLogFile, PROJECT_LOG_FILENAME } from "../projectLog.js";

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
  await ensureProjectLogFile(setup.rootDir);

  const starterPromptPath = path.join(projectPaths.promptsDir, "opinion-extraction.md");
  const analysisClusterPromptPath = path.join(
    projectPaths.promptsDir,
    "analysis-cluster-labeling.md"
  );
  const analysisPerspectivePromptPath = path.join(
    projectPaths.promptsDir,
    "analysis-perspective-summary.md"
  );
  const analysisSemanticMergePromptPath = path.join(
    projectPaths.promptsDir,
    "analysis-semantic-merge.md"
  );

  if (options.force || !(await fileExists(starterPromptPath))) {
    await writeFile(starterPromptPath, createStarterOpinionExtractionPrompt(), "utf8");
  }

  if (options.force || !(await fileExists(analysisClusterPromptPath))) {
    await writeFile(
      analysisClusterPromptPath,
      createStarterAnalysisClusterLabelingPrompt(),
      "utf8"
    );
  }

  if (options.force || !(await fileExists(analysisPerspectivePromptPath))) {
    await writeFile(
      analysisPerspectivePromptPath,
      createStarterAnalysisPerspectiveSummaryPrompt(),
      "utf8"
    );
  }

  if (options.force || !(await fileExists(analysisSemanticMergePromptPath))) {
    await writeFile(
      analysisSemanticMergePromptPath,
      createStarterAnalysisSemanticMergePrompt(),
      "utf8"
    );
  }

  for (const relativeDirectory of DEFAULT_PROJECT_DIRECTORIES) {
    const absoluteDirectory = path.join(setup.rootDir, relativeDirectory);
    const directoryEntries = await readdir(absoluteDirectory);

    if (directoryEntries.length === 0) {
      await writeFile(path.join(absoluteDirectory, ".gitkeep"), "", "utf8");
    }
  }

  await appendProjectLogEvent({
    projectRoot: setup.rootDir,
    command: "init",
    event: "end",
    details: {
      project: setup.name,
      slug: slugifyProjectName(setup.name)
    }
  });

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
    "- archive",
    "- llm-cache",
    "- prompts",
    "- runs",
    "- reports",
    `- ${PROJECT_LOG_FILENAME}`,
    "",
    "Next steps:",
    `1. cd ${rootDir}`,
    "2. broadly ingest ./path/to/source.csv",
    "3. broadly models add",
    "4. Review and edit prompts/opinion-extraction.md and the analysis prompt files for your domain.",
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

- Return plain text only using the exact header format defined below.
- Keep the output in the same language as the source excerpt whenever possible.
- Prefer to keep the record as a single opinion unit unless it clearly contains multiple distinct issues.
- Split only when the source expresses materially separate issues that would cluster differently.
- Exclude text that does not amount to a substantive opinion.
  - Examples: "I don't know", greetings, pure logistics, empty filler, or text too vague to support a defensible opinion.
- Do not invent missing context or force meaning onto vague text.
- Normalize wording only enough to make the opinion clear and concise.
- Preserve concrete actions, problems, requests, and policy-relevant details.
- Include a verbatim supporting excerpt so later stages can verify the extraction against the source.
- Use exact field names from the provided field list whenever possible.
- Include a short split rationale explaining why you returned zero, one, or multiple opinions.
- Do not wrap the response in code fences.

## Output format

\`\`\`text
Split-Decision: none | single | multiple
Split-Rationale: Short explanation of why the record was or was not split

Opinion-Text: One clear substantive opinion
Source-Excerpt: Verbatim supporting text from the source record
Source-Fields: Exact Field Name 1 | Exact Field Name 2
\`\`\`

If there are multiple opinions, repeat the \`Opinion-Text\`, \`Source-Excerpt\`, and \`Source-Fields\`
block separated by a blank line.

If there are no opinions, return only:

\`\`\`text
Split-Decision: none
Split-Rationale: Brief explanation
\`\`\`

## Input / output examples

### Example 1: keep as one opinion

Input:

\`\`\`text
Comment: Citizens need to be educated about AI's capabilities, limitations, and ethical considerations.
\`\`\`

Output:

\`\`\`text
Split-Decision: single
Split-Rationale: The comment expresses one clear request about public education on AI.

Opinion-Text: Citizens should be educated about AI's capabilities, limitations, and ethical considerations
Source-Excerpt: Citizens need to be educated about AI's capabilities, limitations, and ethical considerations.
Source-Fields: Comment
\`\`\`

### Example 2: exclude non-opinion text

Input:

\`\`\`text
Comment: I don't know.
\`\`\`

Output:

\`\`\`text
Split-Decision: none
Split-Rationale: The text does not contain a substantive opinion.
\`\`\`

### Example 3: split only when the issues are distinct

Input:

\`\`\`text
Comment: I would like roads improved, bridges enhanced, and digitalization in municipalities promoted as soon as possible, and I also think more public tourist facilities are still needed.
\`\`\`

Output:

\`\`\`text
Split-Decision: multiple
Split-Rationale: The comment contains three materially distinct infrastructure and tourism issues.

Opinion-Text: Road improvement and bridge enhancement should be advanced as soon as possible
Source-Excerpt: I would like roads improved, bridges enhanced
Source-Fields: Comment

Opinion-Text: Digitalization in municipalities should be promoted as soon as possible
Source-Excerpt: digitalization in municipalities promoted as soon as possible
Source-Fields: Comment

Opinion-Text: More public tourist facilities are needed
Source-Excerpt: I also think more public tourist facilities are still needed
Source-Fields: Comment
\`\`\`
`;
}

function createStarterAnalysisClusterLabelingPrompt(): string {
  return `# Analysis Cluster Labeling Prompt

You are a data analyst skilled in broad listening and the KJ method.

Your task is to assign a concise, specific nameplate (label) and a one-sentence description to each opinion cluster.

## Rules

- Return plain text only using the exact header format defined below.
- Use the sample opinions to identify the concept shared across the cluster.
- Prefer concrete, specific labels over abstract ones.
- Avoid generic labels such as "other concerns", "general feedback", or "public opinion".
- Keep each label short and scannable.
- Use domain-specific terms when they clearly fit the sample opinions.
- Write one sentence of description that explains what the cluster is really about.
- Ground the label and description in the provided sample opinions only.
- Do not invent issues that are not visible in the samples.
- Do not wrap the response in code fences.

## Output format

\`\`\`text
Cluster-ID: 0
Nameplate: Concise specific label
Description: One-sentence description of the shared concern, request, or viewpoint
\`\`\`

Repeat that block for every provided cluster.

## Example

\`\`\`text
Cluster-ID: 2
Nameplate: Federal Registry Coverage
Description: Calls for a unified registry that makes it easier to understand where organizations operate across provinces.
\`\`\`
`;
}

function createStarterAnalysisPerspectiveSummaryPrompt(): string {
  return `# Analysis Perspective Summary Prompt

You are a data analyst preparing a broad listening briefing for a municipal engagement lead.

You will receive guiding questions, a perspective mode, and a set of labeled clusters.
Write a short title and a very concise summary of the perspective.

## Rules

- Return plain text only using the exact header format defined below.
- Keep the summary extremely concise: at most one paragraph and at most four sentences.
- The title should be short and specific.
- Use the provided cluster labels, descriptions, and representative opinions as your evidence base.
- Do not flatten disagreement into a falsely reassuring summary.
- In \`balanced\` mode, foreground the broadest defensible reading while still acknowledging real tensions.
- In \`dissent\` mode, foreground narrower or minority viewpoints that could be overlooked.
- Do not invent facts or policy claims not present in the cluster material.
- Do not wrap the response in code fences.

## Output format

\`\`\`text
Title: Short title
Summary: A concise summary of this perspective, no more than four sentences.
\`\`\`
`;
}

function createStarterAnalysisSemanticMergePrompt(): string {
  return `# Analysis Semantic Merge Prompt

You are a data analyst preparing a higher-level thematic merge of lower-level opinion clusters.

You will receive a set of labeled clusters with sizes, descriptions, top terms, and representative opinions.
Group them into a smaller number of higher-level themes when a merge is semantically defensible.

## Rules

- Return plain text only using the exact header format defined below.
- Every provided cluster must appear in exactly one theme.
- Prefer semantically meaningful themes, not vague buckets.
- Merge smaller or narrower clusters into broader themes only when the shared concern is clear.
- Do not merge clusters that merely sound adjacent but express materially different concerns.
- Prefer 2 to 5 higher-level themes for a typical batch unless the evidence clearly demands otherwise.
- Theme labels should be short and specific.
- Theme summaries should explain what unifies the included clusters.
- Merge rationale should briefly explain why these clusters belong together.
- Do not wrap the response in code fences.

## Output format

\`\`\`text
Theme-ID: 1
Theme-Label: Short specific theme label
Theme-Summary: One concise sentence explaining the shared concern or viewpoint
Cluster-IDs: 0 | 3 | 5
Merge-Rationale: Brief reason these clusters belong together
\`\`\`

Repeat that block for every theme.
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
