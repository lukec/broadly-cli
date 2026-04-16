import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export interface OpenAiRuntimeProbe {
  apiKeyPresent: boolean;
  apiKeySource: "env" | "project-env" | "auth-file" | null;
  organization: string | null;
  project: string | null;
  projectEnvPath: string | null;
  projectEnvFilePresent: boolean;
  authEnvPath: string;
  authEnvFilePresent: boolean;
}

export interface OpenAiModelAccessProbe {
  ok: boolean;
  statusCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export function probeOpenAiRuntime(projectRoot?: string): OpenAiRuntimeProbe {
  const projectEnvPath = projectRoot === undefined ? null : path.join(projectRoot, ".env");
  const projectEnv =
    projectEnvPath === null ? { exists: false, values: {} } : loadEnvFile(projectEnvPath);
  const authEnvPath = path.join(os.homedir(), ".config", "broadly", "auth.env");
  const authEnv = loadEnvFile(authEnvPath);
  const apiKeyFromEnv = normalizeEnvValue(process.env.OPENAI_API_KEY);
  const apiKeyFromProjectEnv = projectEnv.values.OPENAI_API_KEY ?? null;
  const apiKeyFromFile = authEnv.values.OPENAI_API_KEY ?? null;
  const organizationFromEnv = normalizeEnvValue(process.env.OPENAI_ORG_ID);
  const organizationFromProjectEnv = projectEnv.values.OPENAI_ORG_ID ?? null;
  const organizationFromFile = authEnv.values.OPENAI_ORG_ID ?? null;
  const projectFromEnv = normalizeEnvValue(process.env.OPENAI_PROJECT);
  const projectFromProjectEnv = projectEnv.values.OPENAI_PROJECT ?? null;
  const projectFromFile = authEnv.values.OPENAI_PROJECT ?? null;

  return {
    apiKeyPresent: apiKeyFromEnv !== null || apiKeyFromProjectEnv !== null || apiKeyFromFile !== null,
    apiKeySource:
      apiKeyFromEnv !== null
        ? "env"
        : apiKeyFromProjectEnv !== null
          ? "project-env"
          : apiKeyFromFile !== null
            ? "auth-file"
            : null,
    organization: organizationFromEnv ?? organizationFromProjectEnv ?? organizationFromFile,
    project: projectFromEnv ?? projectFromProjectEnv ?? projectFromFile,
    projectEnvPath,
    projectEnvFilePresent: projectEnv.exists,
    authEnvPath,
    authEnvFilePresent: authEnv.exists
  };
}

export async function probeOpenAiModelAccess(
  modelId: string,
  projectRoot?: string
): Promise<OpenAiModelAccessProbe> {
  const runtime = probeOpenAiRuntime(projectRoot);

  if (!runtime.apiKeyPresent) {
    return {
      ok: false,
      statusCode: null,
      errorCode: null,
      errorMessage: "OPENAI_API_KEY is not set."
    };
  }

  const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(modelId)}`, {
    method: "GET",
    headers: buildOpenAiHeaders(projectRoot)
  });

  if (response.ok) {
    return {
      ok: true,
      statusCode: response.status,
      errorCode: null,
      errorMessage: null
    };
  }

  const parsedError = await parseOpenAiError(response);

  return {
    ok: false,
    statusCode: response.status,
    errorCode: parsedError.code,
    errorMessage: parsedError.message
  };
}

export async function runOpenAiTextPrompt(options: {
  modelId: string;
  prompt: string;
  maxOutputTokens: number;
  projectRoot?: string;
}): Promise<{
  text: string;
  stopReason: string | null;
}> {
  const runtime = probeOpenAiRuntime(options.projectRoot);

  if (!runtime.apiKeyPresent) {
    throw new Error("Missing OPENAI_API_KEY for OpenAI.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      ...buildOpenAiHeaders(options.projectRoot),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: options.modelId,
      input: options.prompt,
      max_output_tokens: options.maxOutputTokens
    })
  });

  if (!response.ok) {
    const parsedError = await parseOpenAiError(response);
    throw new Error(
      `OpenAI inference failed: ${response.status} ${response.statusText}${parsedError.message === null ? "" : ` - ${parsedError.message}`}`
    );
  }

  const responseJson = (await response.json()) as {
    output_text?: unknown;
    incomplete_details?: {
      reason?: unknown;
    } | null;
    status?: unknown;
  };
  const text =
    typeof responseJson.output_text === "string" ? responseJson.output_text.trim() : "";

  if (text.length === 0) {
    throw new Error("The OpenAI model returned an empty response.");
  }

  return {
    text,
    stopReason:
      typeof responseJson.incomplete_details?.reason === "string"
        ? responseJson.incomplete_details.reason
        : typeof responseJson.status === "string" && responseJson.status !== "completed"
          ? responseJson.status
          : null
  };
}

export async function runOpenAiEmbedding(options: {
  modelId: string;
  input: string;
  projectRoot?: string;
}): Promise<number[]> {
  const runtime = probeOpenAiRuntime(options.projectRoot);

  if (!runtime.apiKeyPresent) {
    throw new Error("Missing OPENAI_API_KEY for OpenAI.");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      ...buildOpenAiHeaders(options.projectRoot),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: options.modelId,
      input: options.input
    })
  });

  if (!response.ok) {
    const parsedError = await parseOpenAiError(response);
    throw new Error(
      `OpenAI embedding request failed: ${response.status} ${response.statusText}${parsedError.message === null ? "" : ` - ${parsedError.message}`}`
    );
  }

  const responseJson = (await response.json()) as {
    data?: Array<{
      embedding?: unknown;
    }>;
  };
  const embedding = responseJson.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
    throw new Error("The OpenAI embeddings endpoint returned an invalid embedding payload.");
  }

  return embedding as number[];
}

function buildOpenAiHeaders(projectRoot?: string): Record<string, string> {
  const runtime = probeOpenAiRuntime(projectRoot);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolveOpenAiValue("OPENAI_API_KEY", projectRoot) ?? ""}`
  };
  const organization = runtime.organization;
  const project = runtime.project;

  if (organization !== null) {
    headers["OpenAI-Organization"] = organization;
  }

  if (project !== null) {
    headers["OpenAI-Project"] = project;
  }

  return headers;
}

async function parseOpenAiError(response: Response): Promise<{
  code: string | null;
  message: string | null;
}> {
  try {
    const responseText = await response.text();

    if (responseText.trim().length === 0) {
      return {
        code: null,
        message: null
      };
    }

    try {
      const parsed = JSON.parse(responseText) as {
        error?: {
          code?: unknown;
          message?: unknown;
          type?: unknown;
        };
      };
      const code =
        typeof parsed.error?.code === "string" && parsed.error.code.trim().length > 0
          ? parsed.error.code.trim()
          : typeof parsed.error?.type === "string" && parsed.error.type.trim().length > 0
            ? parsed.error.type.trim()
            : null;
      const message =
        typeof parsed.error?.message === "string" && parsed.error.message.trim().length > 0
          ? parsed.error.message.trim()
          : null;

      return {
        code,
        message
      };
    } catch {
      return {
        code: null,
        message: responseText.trim().replace(/\s+/g, " ")
      };
    }
  } catch {
    return {
      code: null,
      message: null
    };
  }
}

function normalizeEnvValue(value: string | undefined): string | null {
  const trimmedValue = value?.trim();

  return trimmedValue !== undefined && trimmedValue.length > 0 ? trimmedValue : null;
}

function resolveOpenAiValue(
  name: "OPENAI_API_KEY" | "OPENAI_ORG_ID" | "OPENAI_PROJECT",
  projectRoot?: string
): string | null {
  const envValue = normalizeEnvValue(process.env[name]);

  if (envValue !== null) {
    return envValue;
  }

  if (projectRoot !== undefined) {
    const projectEnv = loadEnvFile(path.join(projectRoot, ".env"));

    if (projectEnv.values[name] !== undefined) {
      return projectEnv.values[name] ?? null;
    }
  }

  const authEnvPath = path.join(os.homedir(), ".config", "broadly", "auth.env");
  const authEnv = loadEnvFile(authEnvPath);

  return authEnv.values[name] ?? null;
}

function loadEnvFile(filePath: string): {
  exists: boolean;
  values: Partial<Record<"OPENAI_API_KEY" | "OPENAI_ORG_ID" | "OPENAI_PROJECT", string>>;
} {
  if (!existsSync(filePath)) {
    return {
      exists: false,
      values: {}
    };
  }

  try {
    const source = readFileSync(filePath, "utf8");
    const values: Partial<Record<"OPENAI_API_KEY" | "OPENAI_ORG_ID" | "OPENAI_PROJECT", string>> =
      {};

    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();

      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }

      const normalizedLine = line.startsWith("export ") ? line.slice(7).trim() : line;
      const separatorIndex = normalizedLine.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = normalizedLine.slice(0, separatorIndex).trim();
      const rawValue = normalizedLine.slice(separatorIndex + 1).trim();

      if (!isSupportedOpenAiAuthKey(key)) {
        continue;
      }

      const value = stripWrappingQuotes(rawValue);

      if (value.length > 0) {
        values[key] = value;
      }
    }

    return {
      exists: true,
      values
    };
  } catch {
    return {
      exists: true,
      values: {}
    };
  }
}

function isSupportedOpenAiAuthKey(
  value: string
): value is "OPENAI_API_KEY" | "OPENAI_ORG_ID" | "OPENAI_PROJECT" {
  return value === "OPENAI_API_KEY" || value === "OPENAI_ORG_ID" || value === "OPENAI_PROJECT";
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }

  return value;
}
