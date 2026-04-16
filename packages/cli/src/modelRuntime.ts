import {
  ConverseCommand,
  InvokeModelCommand,
  type ContentBlock,
  BedrockRuntimeClient
} from "@aws-sdk/client-bedrock-runtime";
import type { BroadlyProjectConfig } from "@broadly/config";
import { resolveProjectPaths, sha256Hex } from "@broadly/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { inferBedrockModelKind } from "./bedrock.js";
import {
  fileExists,
  inferGoogleCloudModelKind,
  probeGoogleCloudRuntime
} from "./googleCloud.js";
import { runOpenAiEmbedding, runOpenAiTextPrompt } from "./openai.js";

export type RegisteredModel = BroadlyProjectConfig["models"][number];

export interface TextGenerationResult {
  text: string;
  stopReason: string | null;
}

export interface RunTextPromptOptions {
  model: RegisteredModel;
  prompt: string;
  maxOutputTokens: number;
  projectRoot: string;
  temperature?: number;
}

export interface RunEmbeddingOptions {
  model: RegisteredModel;
  input: string;
  projectRoot: string;
}

export async function runTextPromptWithModel(
  options: RunTextPromptOptions
): Promise<TextGenerationResult> {
  const cacheKey = sha256Hex(
    JSON.stringify({
      provider: options.model.provider,
      modelName: options.model.name,
      modelId: options.model.modelId,
      region: options.model.region,
      prompt: options.prompt,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature ?? 0.7
    })
  );
  const cachePath = path.join(
    resolveProjectPaths(options.projectRoot).llmCacheDir,
    "text",
    `${cacheKey}.json`
  );
  const cached = await readCachedTextGeneration(cachePath);

  if (cached !== null) {
    return cached;
  }

  const result = await runTextPromptWithModelUncached(options);
  await writeCachedTextGeneration(cachePath, {
    createdAt: new Date().toISOString(),
    model: options.model,
    result
  });
  return result;
}

async function runTextPromptWithModelUncached(
  options: RunTextPromptOptions
): Promise<TextGenerationResult> {
  if (options.model.provider === "bedrock") {
    if (inferBedrockModelKind(options.model.modelId) === "embedding") {
      throw new Error(
        `Model '${options.model.modelId}' is an embedding model, not a text-generation model. Use it in analysis.embeddingModel or a future embeddings command, not \`broadly llm\`.`
      );
    }

    return runBedrockPrompt(options);
  }

  if (options.model.provider === "google-cloud") {
    if (inferGoogleCloudModelKind(options.model.modelId) === "embedding") {
      throw new Error(
        `Model '${options.model.modelId}' is an embedding model, not a text-generation model. Use it in analysis.embeddingModel or a future embeddings command, not \`broadly llm\`.`
      );
    }

    return runGoogleCloudPrompt(options);
  }

  if (options.model.provider === "openai") {
    return runOpenAiTextPrompt({
      modelId: options.model.modelId,
      prompt: options.prompt,
      maxOutputTokens: options.maxOutputTokens,
      projectRoot: options.projectRoot
    });
  }

  throw new Error(`Unsupported provider '${options.model.provider}'.`);
}

async function readCachedTextGeneration(filePath: string): Promise<TextGenerationResult | null> {
  try {
    const cached = JSON.parse(await readFile(filePath, "utf8")) as {
      result?: TextGenerationResult;
    };
    return cached.result?.text !== undefined ? cached.result : null;
  } catch {
    return null;
  }
}

async function writeCachedTextGeneration(
  filePath: string,
  value: {
    createdAt: string;
    model: RegisteredModel;
    result: TextGenerationResult;
  }
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function runEmbeddingWithModel(
  options: RunEmbeddingOptions
): Promise<number[]> {
  if (options.model.provider === "bedrock") {
    if (inferBedrockModelKind(options.model.modelId) !== "embedding") {
      throw new Error(
        `Model '${options.model.modelId}' is not an embedding model. Use a registered embedding model for \`broadly analysis\`.`
      );
    }

    return runBedrockEmbedding(options);
  }

  if (options.model.provider === "google-cloud") {
    if (inferGoogleCloudModelKind(options.model.modelId) !== "embedding") {
      throw new Error(
        `Model '${options.model.modelId}' is not an embedding model. Use a registered embedding model for \`broadly analysis\`.`
      );
    }

    return runGoogleCloudEmbedding(options);
  }

  if (options.model.provider === "openai") {
    return runOpenAiEmbedding({
      modelId: options.model.modelId,
      input: options.input,
      projectRoot: options.projectRoot
    });
  }

  throw new Error(`Unsupported provider '${options.model.provider}'.`);
}

async function runBedrockPrompt(options: RunTextPromptOptions): Promise<TextGenerationResult> {
  const client = new BedrockRuntimeClient({
    region: options.model.region
  });
  const response = await client.send(
    new ConverseCommand({
      modelId: options.model.modelId,
      messages: [
        {
          role: "user",
          content: [
            {
              text: options.prompt
            }
          ]
        }
      ],
      inferenceConfig: {
        maxTokens: options.maxOutputTokens,
        temperature: options.temperature ?? 0.7
      }
    })
  );
  const blocks = response.output?.message?.content ?? [];
  const text = extractTextFromContentBlocks(blocks).trim();

  if (text.length === 0) {
    throw new Error("The Bedrock model returned an empty response.");
  }

  return {
    text,
    stopReason: response.stopReason ?? null
  };
}

async function runGoogleCloudPrompt(options: RunTextPromptOptions): Promise<TextGenerationResult> {
  const runtimeContext = await resolveGoogleCloudRuntimeContext();
  const response = await fetch(
    `https://${options.model.region}-aiplatform.googleapis.com/v1/projects/${runtimeContext.projectId}/locations/${options.model.region}/publishers/google/models/${options.model.modelId}:generateContent`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeContext.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: options.prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxOutputTokens
        }
      })
    }
  );

  if (!response.ok) {
    const errorText = await describeGoogleCloudError(response);

    throw new Error(
      `Google Cloud inference failed: ${response.status} ${response.statusText}${errorText === null ? "" : ` - ${errorText}`}`
    );
  }

  const responseJson = (await response.json()) as {
    candidates?: Array<{
      finishReason?: string;
      content?: {
        parts?: Array<{
          text?: string;
        }>;
      };
    }>;
  };
  const text = responseJson.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (text === undefined || text.length === 0) {
    throw new Error("The Google Cloud model returned an empty response.");
  }

  return {
    text,
    stopReason: responseJson.candidates?.[0]?.finishReason ?? null
  };
}

async function runBedrockEmbedding(options: RunEmbeddingOptions): Promise<number[]> {
  const client = new BedrockRuntimeClient({
    region: options.model.region
  });
  const response = await client.send(
    new InvokeModelCommand({
      modelId: options.model.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: buildBedrockEmbeddingBody(options.model.modelId, options.input)
    })
  );
  const responseBody = JSON.parse(new TextDecoder().decode(response.body)) as {
    embedding?: unknown;
    embeddings?: unknown;
    response_type?: unknown;
    embeddingsByType?: {
      float?: unknown;
    };
  };

  if (Array.isArray(responseBody.embedding)) {
    return assertNumericVector(responseBody.embedding, "Bedrock");
  }

  if (Array.isArray(responseBody.embeddingsByType?.float)) {
    return assertNumericVector(responseBody.embeddingsByType.float, "Bedrock");
  }

  if (
    typeof responseBody.embeddings === "object" &&
    responseBody.embeddings !== null &&
    "float" in responseBody.embeddings &&
    Array.isArray(responseBody.embeddings.float) &&
    Array.isArray(responseBody.embeddings.float[0])
  ) {
    return assertNumericVector(responseBody.embeddings.float[0], "Bedrock");
  }

  if (Array.isArray(responseBody.embeddings) && Array.isArray(responseBody.embeddings[0])) {
    return assertNumericVector(responseBody.embeddings[0], "Bedrock");
  }

  throw new Error("The Bedrock embedding model returned an invalid embedding payload.");
}

async function runGoogleCloudEmbedding(options: RunEmbeddingOptions): Promise<number[]> {
  const runtimeContext = await resolveGoogleCloudRuntimeContext();
  const response = await fetch(
    `https://${options.model.region}-aiplatform.googleapis.com/v1/projects/${runtimeContext.projectId}/locations/${options.model.region}/publishers/google/models/${options.model.modelId}:predict`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeContext.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        instances: [
          {
            content: options.input
          }
        ],
        parameters: {
          autoTruncate: true
        }
      })
    }
  );

  if (!response.ok) {
    const errorText = await describeGoogleCloudError(response);

    throw new Error(
      `Google Cloud embedding request failed: ${response.status} ${response.statusText}${errorText === null ? "" : ` - ${errorText}`}`
    );
  }

  const responseJson = (await response.json()) as {
    predictions?: Array<{
      embeddings?: {
        values?: unknown;
      };
    }>;
  };
  const values = responseJson.predictions?.[0]?.embeddings?.values;

  if (!Array.isArray(values)) {
    throw new Error("The Google Cloud embedding model returned an invalid embedding payload.");
  }

  return assertNumericVector(values, "Google Cloud");
}

async function resolveGoogleCloudRuntimeContext(): Promise<{
  accessToken: string;
  projectId: string;
}> {
  const runtimeProbe = await probeGoogleCloudRuntime();

  if (!runtimeProbe.tokenAvailable || runtimeProbe.accessToken === null) {
    const missingPaths: string[] = [];

    if (runtimeProbe.configuredCredentialsPath !== null) {
      missingPaths.push(`GOOGLE_APPLICATION_CREDENTIALS=${runtimeProbe.configuredCredentialsPath}`);
    }

    if (!(await fileExists(runtimeProbe.adcPath))) {
      missingPaths.push(`ADC path ${runtimeProbe.adcPath}`);
    }

    const details =
      runtimeProbe.tokenError === null
        ? missingPaths.length === 0
          ? ""
          : ` Checked ${missingPaths.join("; ")}.`
        : ` ${runtimeProbe.tokenError}`;

    throw new Error(`Could not obtain a Google Cloud access token from local credentials.${details}`);
  }

  if (runtimeProbe.projectId === null || runtimeProbe.projectId.trim().length === 0) {
    throw new Error(
      "Google Cloud credentials are available, but no project ID could be resolved. Set GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT."
    );
  }

  return {
    accessToken: runtimeProbe.accessToken,
    projectId: runtimeProbe.projectId
  };
}

async function describeGoogleCloudError(response: Response): Promise<string | null> {
  try {
    const responseText = await response.text();

    if (responseText.trim().length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(responseText) as {
        error?: {
          message?: unknown;
          status?: unknown;
        };
      };
      const status =
        typeof parsed.error?.status === "string" && parsed.error.status.trim().length > 0
          ? parsed.error.status.trim()
          : null;
      const message =
        typeof parsed.error?.message === "string" && parsed.error.message.trim().length > 0
          ? parsed.error.message.trim()
          : null;

      if (status !== null && message !== null) {
        return `${status}: ${message}`;
      }

      if (message !== null) {
        return message;
      }
    } catch {
      // Fall through to raw text.
    }

    return responseText.trim().replace(/\s+/g, " ");
  } catch {
    return null;
  }
}

function extractTextFromContentBlocks(contentBlocks: ContentBlock[]): string {
  return contentBlocks
    .flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []))
    .join("");
}

function buildBedrockEmbeddingBody(modelId: string, input: string): Uint8Array {
  if (modelId.startsWith("cohere.")) {
    return new TextEncoder().encode(
      JSON.stringify({
        texts: [input],
        input_type: "search_document",
        embedding_types: ["float"]
      })
    );
  }

  return new TextEncoder().encode(
    JSON.stringify({
      inputText: input
    })
  );
}

function assertNumericVector(values: unknown[], providerName: string): number[] {
  if (values.some((value) => typeof value !== "number")) {
    throw new Error(`The ${providerName} embedding model returned a non-numeric vector.`);
  }

  return values as number[];
}
