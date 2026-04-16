import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  parseProjectConfig,
  type BroadlyProjectConfig
} from "@broadly/config";
import { resolveProjectPaths } from "@broadly/core";
import { runTextPromptWithModel } from "../modelRuntime.js";
import { withProjectActionLog } from "../projectLog.js";

type SupportedModelProvider = BroadlyProjectConfig["models"][number]["provider"];
type RegisteredModel = BroadlyProjectConfig["models"][number];

export interface RunLlmOptions {
  prompt: string;
  project?: string;
  model?: string;
  allModels: boolean;
  maxOutputTokens?: number;
}

interface LlmRunResult {
  model: RegisteredModel;
  text: string;
  stopReason: string | null;
}

interface LlmRunFailure {
  model: RegisteredModel;
  error: string;
}

export async function runLlm(options: RunLlmOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  await withProjectActionLog({
    projectRoot,
    command: "llm",
    details: {
      allModels: options.allModels,
      model: options.model,
      maxOutputTokens: options.maxOutputTokens
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = await loadProjectConfig(projectPaths.configPath);
      const targetModels = resolveTargetModels(config, options);
      const prompt = options.prompt.trim();

      if (prompt.length === 0) {
        throw new Error("Prompt text is required.");
      }

  const settledResults = await Promise.allSettled(
    targetModels.map(async (model) =>
      runPromptWithModel(model, prompt, options.maxOutputTokens ?? 2048, projectRoot)
    )
  );
  const successes: LlmRunResult[] = [];
  const failures: LlmRunFailure[] = [];

  for (const [index, settledResult] of settledResults.entries()) {
    const model = targetModels[index];

    if (model === undefined) {
      continue;
    }

    if (settledResult.status === "fulfilled") {
      successes.push(settledResult.value);
    } else {
      const reason =
        settledResult.reason instanceof Error
          ? settledResult.reason.message
          : String(settledResult.reason);
      failures.push({
        model,
        error: reason
      });
    }
  }

      process.stdout.write(renderLlmReport(projectPaths.configPath, prompt, successes, failures));

      if (failures.length > 0) {
        process.exitCode = 1;
      }
    }
  });
}

async function runPromptWithModel(
  model: RegisteredModel,
  prompt: string,
  maxOutputTokens: number,
  projectRoot: string
): Promise<LlmRunResult> {
  const result = await runTextPromptWithModel({
    model,
    prompt,
    maxOutputTokens,
    projectRoot,
    temperature: 0.7
  });

  return { model, ...result };
}

function resolveTargetModels(
  config: BroadlyProjectConfig,
  options: RunLlmOptions
): RegisteredModel[] {
  if (config.models.length === 0) {
    throw new Error("This project has no registered models. Run `broadly models add` first.");
  }

  if (options.allModels && options.model !== undefined) {
    throw new Error("Use either --model or --all-models, not both.");
  }

  if (options.allModels) {
    return [...config.models];
  }

  if (options.model !== undefined) {
    const selectedModel = config.models.find((model) => model.name === options.model);

    if (selectedModel === undefined) {
      throw new Error(
        `No model alias named '${options.model}' is registered in this project.`
      );
    }

    return [selectedModel];
  }

  throw new Error("Specify --model <alias> or --all-models.");
}

function renderLlmReport(
  configPath: string,
  prompt: string,
  successes: LlmRunResult[],
  failures: LlmRunFailure[]
): string {
  const lines: string[] = [];

  lines.push(color.heading("Broadly LLM"));
  lines.push(color.muted(rule("=")));
  lines.push(formatDetailLine("Config", configPath));
  lines.push(formatDetailLine("Prompt", prompt));
  lines.push(
    formatDetailLine(
      "Summary",
      `${successes.length} succeeded, ${failures.length} failed`
    )
  );
  lines.push("");

  for (const result of successes) {
    lines.push(color.muted(rule("-")));
    lines.push(
      `${color.goodBadge("OK")} ${color.title(result.model.name)} ${color.muted(
        `(${result.model.provider} · ${result.model.region})`
      )}`
    );
    lines.push(formatDetailLine("Model ID", result.model.modelId));
    if (result.stopReason !== null) {
      lines.push(formatDetailLine("Stop", result.stopReason));

      if (isMaxTokenStopReason(result.stopReason)) {
        lines.push(`  ${color.warn("Output may be truncated. Re-run with --max-output-tokens <n>.")}`);
      }
    }
    lines.push("");
    lines.push(indentBlock(result.text, 2));
    lines.push("");
  }

  for (const failure of failures) {
    lines.push(color.muted(rule("-")));
    lines.push(
      `${color.warnBadge("FAIL")} ${color.title(failure.model.name)} ${color.muted(
        `(${failure.model.provider} · ${failure.model.region})`
      )}`
    );
    lines.push(formatDetailLine("Model ID", failure.model.modelId));
    lines.push(color.section("Error"));
    lines.push(`  ${color.bullet("!")} ${failure.error}`);
    lines.push("");
  }

  return `${lines.map((line) => line.replace(/\s+$/g, "")).join("\n").trimEnd()}\n`;
}

async function loadProjectConfig(configPath: string): Promise<BroadlyProjectConfig> {
  if (!(await fileExists(configPath))) {
    throw new Error(`Could not find broadly.yaml at ${configPath}`);
  }

  const configSource = await readFile(configPath, "utf8");

  return parseProjectConfig(configSource);
}

async function resolveCommandProjectRoot(project: string | undefined): Promise<string> {
  if (project !== undefined) {
    return resolveProjectRoot(project);
  }

  let currentDirectory = process.cwd();

  while (true) {
    if (await fileExists(path.join(currentDirectory, "broadly.yaml"))) {
      return currentDirectory;
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      throw new Error(
        "Could not find broadly.yaml from the current directory. Run the command inside a project or pass --project."
      );
    }

    currentDirectory = parentDirectory;
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

function indentBlock(value: string, spaces: number): string {
  const indentation = " ".repeat(spaces);

  return value
    .split("\n")
    .map((line) => `${indentation}${line}`)
    .join("\n");
}

function formatDetailLine(label: string, value: string): string {
  return `  ${color.label(label.padEnd(8))} ${value}`;
}

function rule(character: string): string {
  const width = process.stdout.columns ?? 72;
  return character.repeat(Math.max(24, Math.min(width, 72)));
}

const color = {
  heading: (value: string) => applyAnsi(value, ["1", "36"]),
  title: (value: string) => applyAnsi(value, ["1", "37"]),
  label: (value: string) => applyAnsi(value, ["1", "34"]),
  muted: (value: string) => applyAnsi(value, ["2", "37"]),
  section: (value: string) => applyAnsi(`  ${value}`, ["1", "35"]),
  bullet: (value: string) => applyAnsi(value, ["1", "36"]),
  warn: (value: string) => applyAnsi(value, ["1", "33"]),
  goodBadge: (value: string) => applyAnsi(`[${value}]`, ["1", "30", "42"]),
  warnBadge: (value: string) => applyAnsi(`[${value}]`, ["1", "30", "41"])
};

function isMaxTokenStopReason(value: string): boolean {
  return value === "MAX_TOKENS" || value === "max_tokens";
}

function applyAnsi(value: string, codes: string[]): string {
  if (!process.stdout.isTTY) {
    return value;
  }

  return `\u001B[${codes.join(";")}m${value}\u001B[0m`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
