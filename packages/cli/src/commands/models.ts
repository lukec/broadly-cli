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

type SupportedModelProvider = "bedrock" | "google-cloud";

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

export async function addModel(options: AddModelOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const projectPaths = resolveProjectPaths(projectRoot);
  const config = await loadProjectConfig(projectPaths.configPath);
  const provider = await resolveProvider(options.provider);
  const modelId = await resolveRequiredText(
    "Provider model name",
    options.modelId,
    "Provide --model-id when not running interactively."
  );
  const region = await resolveRequiredText(
    "Region",
    options.region,
    "Provide --region when not running interactively."
  );
  const name = await resolveRequiredText(
    "Project alias for this model",
    options.name,
    "Provide --name when not running interactively."
  );
  const credentialCheck = await checkProviderCredentials(provider);
  const existingIndex = config.models.findIndex((model) => model.name === name);
  const modelRecord = {
    name,
    provider,
    modelId,
    region
  };

  if (existingIndex >= 0) {
    config.models[existingIndex] = modelRecord;
  } else {
    config.models.push(modelRecord);
  }

  await writeFile(projectPaths.configPath, serializeProjectConfig(config), "utf8");

  const lines = [
    `${existingIndex >= 0 ? "Updated" : "Added"} model alias in ${projectPaths.configPath}`,
    "",
    `Alias: ${name}`,
    `Provider: ${provider}`,
    `Model ID: ${modelId}`,
    `Region: ${region}`,
    `Credential check: ${credentialCheck.ok ? "ok" : "not ready"}`,
    `Status: ${credentialCheck.summary}`
  ];

  if (credentialCheck.detected.length > 0) {
    lines.push("Detected credential sources:");
    for (const detected of credentialCheck.detected) {
      lines.push(`- ${detected}`);
    }
  }

  if (!credentialCheck.ok) {
    lines.push("Next steps:");
    for (const nextStep of credentialCheck.nextSteps) {
      lines.push(`- ${nextStep}`);
    }
    lines.push("- Then run `broadly models check`.");
  }

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

  const lines = [`Model checks for ${projectPaths.configPath}`, ""];

  for (const model of modelsToCheck) {
    const credentialCheck = await checkProviderCredentials(model.provider);

    lines.push(`${model.name}`);
    lines.push(`- provider: ${model.provider}`);
    lines.push(`- model id: ${model.modelId}`);
    lines.push(`- region: ${model.region}`);
    lines.push(`- credentials: ${credentialCheck.ok ? "ok" : "not ready"}`);
    lines.push(`- status: ${credentialCheck.summary}`);

    if (credentialCheck.detected.length > 0) {
      for (const detected of credentialCheck.detected) {
        lines.push(`- detected: ${detected}`);
      }
    }

    if (!credentialCheck.ok) {
      for (const nextStep of credentialCheck.nextSteps) {
        lines.push(`- next: ${nextStep}`);
      }
    }

    lines.push("");
  }

  process.stdout.write(`${lines.join("\n").trimEnd()}\n`);
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
    { label: "google-cloud", value: "google-cloud" }
  ]);

  return answer;
}

async function resolveRequiredText(
  label: string,
  providedValue: string | undefined,
  missingMessage: string
): Promise<string> {
  const trimmedProvidedValue = providedValue?.trim();

  if (trimmedProvidedValue !== undefined && trimmedProvidedValue.length > 0) {
    return trimmedProvidedValue;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(missingMessage);
  }

  const answer = await promptText(label);
  const trimmedAnswer = answer.trim();

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
  provider: SupportedModelProvider
): Promise<ProviderCredentialCheck> {
  if (provider === "bedrock") {
    return checkBedrockCredentials();
  }

  return checkGoogleCloudCredentials();
}

async function checkBedrockCredentials(): Promise<ProviderCredentialCheck> {
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

  return {
    ok: hasAnyCredentialsSource,
    provider: "bedrock",
    summary: hasAnyCredentialsSource
      ? "AWS credential source detected for Bedrock."
      : "Missing an AWS credential source for Bedrock.",
    detected,
    nextSteps
  };
}

async function checkGoogleCloudCredentials(): Promise<ProviderCredentialCheck> {
  const detected: string[] = [];
  const nextSteps: string[] = [];
  const configuredCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const gcloudConfigDir =
    process.env.CLOUDSDK_CONFIG ?? path.join(os.homedir(), ".config", "gcloud");
  const adcPath = path.join(gcloudConfigDir, "application_default_credentials.json");
  const hasConfiguredCredentialsPath =
    configuredCredentialsPath !== undefined &&
    configuredCredentialsPath.trim().length > 0 &&
    (await fileExists(configuredCredentialsPath));
  const hasApplicationDefaultCredentials = await fileExists(adcPath);

  if (hasConfiguredCredentialsPath) {
    detected.push(`GOOGLE_APPLICATION_CREDENTIALS at ${configuredCredentialsPath}`);
  }

  if (hasApplicationDefaultCredentials) {
    detected.push(`Google application default credentials at ${adcPath}`);
  }

  if (!hasConfiguredCredentialsPath && !hasApplicationDefaultCredentials) {
    nextSteps.push(
      "Set GOOGLE_APPLICATION_CREDENTIALS to a service account key or run `gcloud auth application-default login`"
    );
  }

  if (!hasNonEmptyEnv("GOOGLE_CLOUD_PROJECT") && !hasNonEmptyEnv("GCLOUD_PROJECT")) {
    nextSteps.push("Set GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT for Vertex AI usage");
  }

  return {
    ok: hasConfiguredCredentialsPath || hasApplicationDefaultCredentials,
    provider: "google-cloud",
    summary:
      hasConfiguredCredentialsPath || hasApplicationDefaultCredentials
        ? "Google Cloud application credentials detected."
        : "Missing Google Cloud application credentials.",
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileContains(filePath: string, pattern: RegExp): Promise<boolean> {
  try {
    const source = await readFile(filePath, "utf8");
    return pattern.test(source);
  } catch {
    return false;
  }
}
