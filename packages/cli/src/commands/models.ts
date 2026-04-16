import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import {
  parseProjectConfig,
  serializeProjectConfig,
  type BroadlyProjectConfig
} from "@broadly/config";
import { resolveProjectPaths } from "@broadly/core";
import { probeBedrockModelAccess } from "../bedrock.js";
import {
  fileExists,
  probeGoogleCloudModelAccess,
  probeGoogleCloudRuntime
} from "../googleCloud.js";
import { probeOpenAiModelAccess, probeOpenAiRuntime } from "../openai.js";

type SupportedModelProvider = "bedrock" | "google-cloud" | "openai";

export interface AddModelOptions {
  project?: string;
  provider?: SupportedModelProvider;
  modelId?: string;
  name?: string;
  region?: string;
}

export interface RemoveModelOptions {
  project?: string;
  name?: string;
}

export interface CheckModelsOptions {
  project?: string;
  name?: string;
}

interface ProviderCredentialCheck {
  ok: boolean;
  provider: SupportedModelProvider;
  summary: string;
  detected: string[];
  nextSteps: string[];
}

type RegisteredModel = BroadlyProjectConfig["models"][number];

export async function addModel(options: AddModelOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const projectPaths = resolveProjectPaths(projectRoot);
  const config = await loadProjectConfig(projectPaths.configPath);
  const provider = await resolveProvider(options.provider);
  const suggestedRegion =
    config.models.find((model) => model.provider === provider)?.region ??
    (provider === "openai" ? "global" : undefined);
  const modelId = await resolveRequiredText(
    "Provider model name",
    options.modelId,
    "Provide --model-id when not running interactively."
  );
  const region = await resolveRequiredText(
    "Region",
    options.region,
    "Provide --region when not running interactively.",
    suggestedRegion
  );
  const name = await resolveRequiredText(
    "Project alias for this model",
    options.name,
    "Provide --name when not running interactively."
  );
  const modelRecord = {
    name,
    provider,
    modelId,
    region
  };
  const existingIndex = config.models.findIndex((model) => model.name === name);

  if (existingIndex >= 0) {
    config.models[existingIndex] = modelRecord;
  } else {
    config.models.push(modelRecord);
  }

  await writeFile(projectPaths.configPath, serializeProjectConfig(config), "utf8");

  const credentialCheck = await checkProviderCredentials(modelRecord, projectRoot);
  const lines = [
    `${existingIndex >= 0 ? "Updated" : "Added"} model alias in ${projectPaths.configPath}`,
    "",
    `Alias: ${name}`,
    `Provider: ${provider}`,
    `Model ID: ${modelId}`,
    `Region: ${region}`,
    "",
    ...renderModelChecksReport(projectPaths.configPath, [
      {
        ...modelRecord,
        __credentialCheck: credentialCheck
      }
    ])
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function removeModel(options: RemoveModelOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const projectPaths = resolveProjectPaths(projectRoot);
  const config = await loadProjectConfig(projectPaths.configPath);

  if (config.models.length === 0) {
    throw new Error("This project has no registered models.");
  }

  const name = await resolveModelNameToRemove(config, options.name);
  const nextModels = config.models.filter((model) => model.name !== name);

  if (nextModels.length === config.models.length) {
    throw new Error(`No model alias named '${name}' is registered in this project.`);
  }

  config.models = nextModels;
  await writeFile(projectPaths.configPath, serializeProjectConfig(config), "utf8");

  process.stdout.write(`Removed model alias '${name}' from ${projectPaths.configPath}\n`);
}

export async function checkModels(options: CheckModelsOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const projectPaths = resolveProjectPaths(projectRoot);
  const config = await loadProjectConfig(projectPaths.configPath);
  const modelsToCheck =
    options.name === undefined
      ? config.models
      : config.models.filter((model) => model.name === options.name);

  if (config.models.length === 0) {
    throw new Error("This project has no registered models. Run `broadly models add` first.");
  }

  if (modelsToCheck.length === 0) {
    throw new Error(`No model alias named '${options.name}' is registered in this project.`);
  }

  const checkedModels: CheckedModelRecord[] = [];

  for (const model of modelsToCheck) {
    checkedModels.push({
      ...model,
      __credentialCheck: await checkProviderCredentials(model, projectRoot)
    });
  }

  const lines = renderModelChecksReport(projectPaths.configPath, checkedModels);

  process.stdout.write(`${lines.join("\n")}\n`);
}

function renderModelChecksReport(
  configPath: string,
  modelsToCheck: CheckedModelRecord[]
): string[] {
  const lines: string[] = [];
  const readyCount = modelsToCheck.filter((model) => model.__credentialCheck?.ok).length;
  const needsAttentionCount = modelsToCheck.length - readyCount;

  lines.push(color.heading("Broadly Models Check"));
  lines.push(color.muted(rule("=")));
  lines.push(formatDetailLine("Config", configPath));
  lines.push(
    formatDetailLine(
      "Summary",
      `${modelsToCheck.length} checked, ${readyCount} ready, ${needsAttentionCount} need attention`
    )
  );
  lines.push("");

  for (const model of modelsToCheck) {
    const credentialCheck = model.__credentialCheck;

    if (credentialCheck === undefined) {
      continue;
    }

    lines.push(
      `${credentialCheck.ok ? color.goodBadge("READY") : color.warnBadge("ATTN ")} ${color.title(model.name)} ${color.muted(`(${model.provider} · ${model.region} · ${model.modelId})`)}`
    );
    lines.push(formatDetailLine("Status", credentialCheck.summary));

    if (!credentialCheck.ok && credentialCheck.detected.length > 0) {
      lines.push(color.section("Detected"));
      for (const detected of credentialCheck.detected) {
        lines.push(`  ${color.bullet("+")} ${detected}`);
      }
    }

    if (!credentialCheck.ok && credentialCheck.nextSteps.length > 0) {
      lines.push(color.section("Next"));
      for (const nextStep of credentialCheck.nextSteps) {
        lines.push(`  ${color.bullet("!")} ${nextStep}`);
      }
    }

    lines.push("");
  }

  return lines.map((line) => line.replace(/\s+$/g, ""));
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

async function resolveProvider(
  providedProvider: SupportedModelProvider | undefined
): Promise<SupportedModelProvider> {
  if (providedProvider !== undefined) {
    return providedProvider;
  }

  const answer = await promptSelect("Provider", [
    { label: "bedrock", value: "bedrock" },
    { label: "google-cloud", value: "google-cloud" },
    { label: "openai", value: "openai" }
  ]);

  return answer;
}

async function resolveRequiredText(
  label: string,
  providedValue: string | undefined,
  missingMessage: string,
  defaultValue?: string
): Promise<string> {
  const trimmedProvidedValue = providedValue?.trim();

  if (trimmedProvidedValue !== undefined && trimmedProvidedValue.length > 0) {
    return trimmedProvidedValue;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(missingMessage);
  }

  const answer = await promptText(label, defaultValue);
  const trimmedAnswer = answer.trim();

  if (trimmedAnswer.length === 0 && defaultValue !== undefined && defaultValue.trim().length > 0) {
    return defaultValue.trim();
  }

  if (trimmedAnswer.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return trimmedAnswer;
}

async function resolveModelNameToRemove(
  config: BroadlyProjectConfig,
  providedName: string | undefined
): Promise<string> {
  const trimmedProvidedName = providedName?.trim();

  if (trimmedProvidedName !== undefined && trimmedProvidedName.length > 0) {
    return trimmedProvidedName;
  }

  const answer = await promptSelect(
    "Model alias to remove",
    config.models.map((model) => ({
      label: `${model.name} (${model.provider})`,
      value: model.name
    }))
  );

  return answer;
}

async function checkProviderCredentials(
  model: RegisteredModel,
  projectRoot?: string
): Promise<ProviderCredentialCheck> {
  if (model.provider === "bedrock") {
    return checkBedrockCredentials(model);
  }

  if (model.provider === "openai") {
    return checkOpenAiCredentials(model, projectRoot);
  }

  return checkGoogleCloudCredentials(model);
}

type CheckedModelRecord = RegisteredModel & {
  __credentialCheck?: ProviderCredentialCheck;
};

async function checkBedrockCredentials(
  model: RegisteredModel
): Promise<ProviderCredentialCheck> {
  const detected: string[] = [];
  const nextSteps: string[] = [];
  const credentialsFile =
    process.env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(os.homedir(), ".aws", "credentials");
  const configFile = process.env.AWS_CONFIG_FILE ?? path.join(os.homedir(), ".aws", "config");
  const hasEnvKeys =
    hasNonEmptyEnv("AWS_ACCESS_KEY_ID") && hasNonEmptyEnv("AWS_SECRET_ACCESS_KEY");
  const hasProfileEnv = hasNonEmptyEnv("AWS_PROFILE");
  const hasCredentialsFile = await fileExists(credentialsFile);
  const hasConfigFile = await fileExists(configFile);
  const hasAnyCredentialsSource = hasEnvKeys || hasProfileEnv || hasCredentialsFile;
  const hasRegionEnv = hasNonEmptyEnv("AWS_REGION") || hasNonEmptyEnv("AWS_DEFAULT_REGION");
  const hasConfigRegion = hasConfigFile && (await fileContains(configFile, /(^|\n)\s*region\s*=/m));

  if (hasEnvKeys) {
    detected.push("AWS access key credentials from environment variables");
  }

  if (hasProfileEnv) {
    detected.push(`AWS profile from AWS_PROFILE=${process.env.AWS_PROFILE}`);
  }

  if (hasCredentialsFile) {
    detected.push(`AWS shared credentials file at ${credentialsFile}`);
  }

  if (!hasAnyCredentialsSource) {
    nextSteps.push("Set AWS credentials in environment variables or ~/.aws/credentials");
  }

  if (hasRegionEnv) {
    detected.push("AWS default region from AWS_REGION or AWS_DEFAULT_REGION");
  } else if (hasConfigRegion) {
    detected.push(`AWS default region in config file at ${configFile}`);
  }

  let modelAccessSummary: string | null = null;
  let modelAccessOk = false;

  if (hasAnyCredentialsSource) {
    const modelAccessProbe = await probeBedrockModelAccess({
      region: model.region,
      modelId: model.modelId
    });

    if (modelAccessProbe.ok) {
      modelAccessOk = true;
      detected.push(
        modelAccessProbe.modelKind === "embedding"
          ? "Bedrock embedding invocation check succeeded"
          : "Bedrock Converse inference check succeeded"
      );
    } else {
      modelAccessSummary = formatBedrockModelAccessFailure(modelAccessProbe);
      nextSteps.push(...suggestBedrockNextSteps(modelAccessProbe, model));
    }
  }

  return {
    ok: hasAnyCredentialsSource && modelAccessOk,
    provider: "bedrock",
    summary: hasAnyCredentialsSource
      ? modelAccessOk
        ? "AWS credentials and Bedrock model access resolved."
        : modelAccessSummary ?? "AWS credentials are available, but Bedrock model access failed."
      : "Missing an AWS credential source for Bedrock.",
    detected,
    nextSteps
  };
}

async function checkGoogleCloudCredentials(
  model: RegisteredModel
): Promise<ProviderCredentialCheck> {
  const detected: string[] = [];
  const nextSteps: string[] = [];
  const runtimeProbe = await probeGoogleCloudRuntime();
  const hasConfiguredCredentialsPath =
    runtimeProbe.configuredCredentialsPath !== null &&
    (await fileExists(runtimeProbe.configuredCredentialsPath));
  const hasApplicationDefaultCredentials = await fileExists(runtimeProbe.adcPath);

  if (hasConfiguredCredentialsPath) {
    detected.push(`GOOGLE_APPLICATION_CREDENTIALS at ${runtimeProbe.configuredCredentialsPath}`);
  }

  if (hasApplicationDefaultCredentials) {
    detected.push(`Google application default credentials at ${runtimeProbe.adcPath}`);
  }

  if (runtimeProbe.envProjectId !== null) {
    detected.push(`Google Cloud project from environment: ${runtimeProbe.envProjectId}`);
  }

  if (runtimeProbe.tokenAvailable) {
    detected.push("google-auth-library obtained an access token");
  } else if (runtimeProbe.tokenError !== null) {
    nextSteps.push(`google-auth-library token check failed: ${runtimeProbe.tokenError}`);
  }

  if (runtimeProbe.projectId !== null) {
    detected.push(`Google Cloud project resolved as ${runtimeProbe.projectId}`);
  }

  let modelAccessSummary: string | null = null;
  let modelAccessOk = false;

  if (runtimeProbe.tokenAvailable && runtimeProbe.accessToken !== null && runtimeProbe.projectId !== null) {
    const modelAccessProbe = await probeGoogleCloudModelAccess({
      accessToken: runtimeProbe.accessToken,
      projectId: runtimeProbe.projectId,
      region: model.region,
      modelId: model.modelId
    });

    if (modelAccessProbe.ok) {
      modelAccessOk = true;
      detected.push(
        modelAccessProbe.modelKind === "embedding"
          ? "Vertex AI embedding prediction endpoint is reachable"
          : "Vertex AI publisher model endpoint is reachable"
      );
    } else {
      modelAccessSummary = formatGoogleModelAccessFailure(modelAccessProbe);

      if (shouldSuggestVertexApiEnable(modelAccessProbe)) {
        nextSteps.push(
          `Enable Vertex AI API: gcloud services enable aiplatform.googleapis.com --project ${runtimeProbe.projectId}`
        );
      }
    }
  }

  if (!hasConfiguredCredentialsPath && !hasApplicationDefaultCredentials) {
    nextSteps.push(
      "Set GOOGLE_APPLICATION_CREDENTIALS to a service account key or run `gcloud auth application-default login`"
    );
    nextSteps.push(
      `Checked GOOGLE_APPLICATION_CREDENTIALS=${runtimeProbe.configuredCredentialsPath ?? "(not set)"}`
    );
    nextSteps.push(`Checked ADC path ${runtimeProbe.adcPath}`);
  }

  if (runtimeProbe.projectId === null) {
    nextSteps.push("Set GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT for Vertex AI usage");
    nextSteps.push("No Google Cloud project ID could be resolved from env, auth, or ADC");
  }

  const runtimeReady = runtimeProbe.tokenAvailable && runtimeProbe.projectId !== null;

  return {
    ok: runtimeReady && modelAccessOk,
    provider: "google-cloud",
    summary:
      runtimeReady && modelAccessOk
        ? "Google Cloud credentials, project ID, and Vertex AI access resolved."
        : runtimeReady
          ? modelAccessSummary ?? "Google Cloud runtime is ready, but Vertex AI model access failed."
          : runtimeProbe.tokenAvailable
          ? "Google Cloud credentials are available, but project ID resolution failed."
          : "Missing usable Google Cloud application credentials.",
    detected,
    nextSteps
  };
}

async function checkOpenAiCredentials(
  model: RegisteredModel,
  projectRoot?: string
): Promise<ProviderCredentialCheck> {
  const detected: string[] = [];
  const nextSteps: string[] = [];
  const runtimeProbe = probeOpenAiRuntime(projectRoot);

  if (runtimeProbe.apiKeyPresent) {
    detected.push(
      runtimeProbe.apiKeySource === "env"
        ? "OPENAI_API_KEY is set in the environment"
        : runtimeProbe.apiKeySource === "project-env"
          ? `OPENAI_API_KEY loaded from ${runtimeProbe.projectEnvPath}`
          : `OPENAI_API_KEY loaded from ${runtimeProbe.authEnvPath}`
    );
  } else {
    nextSteps.push("Set OPENAI_API_KEY for OpenAI API access");
    if (runtimeProbe.projectEnvPath !== null) {
      nextSteps.push(`Checked project env file ${runtimeProbe.projectEnvPath}`);
    }
    nextSteps.push(`Checked auth file ${runtimeProbe.authEnvPath}`);
  }

  if (runtimeProbe.organization !== null) {
    detected.push(`OpenAI organization from OPENAI_ORG_ID=${runtimeProbe.organization}`);
  }

  if (runtimeProbe.project !== null) {
    detected.push(`OpenAI project from OPENAI_PROJECT=${runtimeProbe.project}`);
  }

  if (!runtimeProbe.apiKeyPresent) {
    return {
      ok: false,
      provider: "openai",
      summary: "Missing OPENAI_API_KEY for OpenAI.",
      detected,
      nextSteps
    };
  }

  const modelAccessProbe = await probeOpenAiModelAccess(model.modelId, projectRoot);

  if (modelAccessProbe.ok) {
    return {
      ok: true,
      provider: "openai",
      summary: "OpenAI credentials and model access resolved.",
      detected,
      nextSteps
    };
  }

  const accessSummary = formatOpenAiModelAccessFailure(modelAccessProbe);

  if (accessSummary !== null) {
    nextSteps.push(accessSummary);
  }

  return {
    ok: false,
    provider: "openai",
    summary:
      accessSummary ?? "OpenAI credentials are available, but the model check failed.",
    detected,
    nextSteps
  };
}

async function promptText(label: string, defaultValue?: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Missing required value for ${label}.`);
  }

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

async function promptSelect<T extends string>(
  label: string,
  options: Array<{ label: string; value: T }>
): Promise<T> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Missing required value for ${label}.`);
  }

  const numberedOptions = options
    .map((option, index) => `${index + 1}. ${option.label}`)
    .join("\n");
  const answer = await promptText(`${label}\n${numberedOptions}\nChoose a number`);
  const selectedIndex = Number.parseInt(answer.trim(), 10) - 1;

  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= options.length) {
    throw new Error(`Invalid selection for ${label}.`);
  }

  return options[selectedIndex]!.value;
}

function hasNonEmptyEnv(name: string): boolean {
  const value = process.env[name];

  return value !== undefined && value.trim().length > 0;
}

function formatGoogleModelAccessFailure(probe: {
  statusCode: number | null;
  errorStatus: string | null;
  errorMessage: string | null;
  modelKind?: "embedding" | "generative";
}): string | null {
  const parts = [
    probe.statusCode === null ? null : `Vertex AI check returned ${probe.statusCode}`,
    probe.errorStatus,
    probe.errorMessage
  ].filter((value): value is string => value !== null && value.trim().length > 0);

  return parts.length > 0 ? parts.join(" - ") : null;
}

function shouldSuggestVertexApiEnable(probe: {
  errorStatus: string | null;
  errorMessage: string | null;
}): boolean {
  const combinedMessage = `${probe.errorStatus ?? ""} ${probe.errorMessage ?? ""}`.toLowerCase();

  return (
    combinedMessage.includes("aiplatform.googleapis.com") &&
    (combinedMessage.includes("disabled") ||
      combinedMessage.includes("has not been used") ||
      combinedMessage.includes("enable it"))
  );
}

function formatBedrockModelAccessFailure(probe: {
  errorCode: string | null;
  errorMessage: string | null;
}): string | null {
  const parts = [probe.errorCode, probe.errorMessage].filter(
    (value): value is string => value !== null && value.trim().length > 0
  );

  return parts.length > 0 ? parts.join(" - ") : null;
}

function formatOpenAiModelAccessFailure(probe: {
  statusCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}): string | null {
  const parts = [
    probe.statusCode === null ? null : `OpenAI model check returned ${probe.statusCode}`,
    probe.errorCode,
    probe.errorMessage
  ].filter((value): value is string => value !== null && value.trim().length > 0);

  return parts.length > 0 ? parts.join(" - ") : null;
}

function suggestBedrockNextSteps(
  probe: {
    errorCode: string | null;
    errorMessage: string | null;
  },
  model: RegisteredModel
): string[] {
  const nextSteps: string[] = [];
  const combinedMessage = `${probe.errorCode ?? ""} ${probe.errorMessage ?? ""}`.toLowerCase();

  if (
    combinedMessage.includes("accessdenied") ||
    combinedMessage.includes("not authorized") ||
    combinedMessage.includes("not authorized to invoke") ||
    combinedMessage.includes("access denied")
  ) {
    nextSteps.push(
      `Grant Bedrock inference access for ${model.modelId} in ${model.region} and ensure your IAM principal can call bedrock:InvokeModel and bedrock:Converse.`
    );
  }

  if (
    combinedMessage.includes("could not resolve the foundation model") ||
    combinedMessage.includes("model identifier is invalid") ||
    combinedMessage.includes("validationexception") ||
    combinedMessage.includes("not found")
  ) {
    nextSteps.push(
      `Check that model '${model.modelId}' is available in Bedrock region ${model.region} and that the model ID is correct.`
    );
  }

  if (nextSteps.length === 0 && probe.errorMessage !== null) {
    nextSteps.push(`Review the Bedrock error and retry once the model is callable: ${probe.errorMessage}`);
  }

  return nextSteps;
}

async function fileContains(filePath: string, pattern: RegExp): Promise<boolean> {
  try {
    const source = await readFile(filePath, "utf8");
    return pattern.test(source);
  } catch {
    return false;
  }
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
  goodBadge: (value: string) => applyAnsi(`[${value}]`, ["1", "30", "42"]),
  warnBadge: (value: string) => applyAnsi(`[${value}]`, ["1", "30", "43"])
};

function applyAnsi(value: string, codes: string[]): string {
  if (!process.stdout.isTTY) {
    return value;
  }

  return `\u001B[${codes.join(";")}m${value}\u001B[0m`;
}
