import {
  ConverseCommand,
  InvokeModelCommand,
  BedrockRuntimeClient
} from "@aws-sdk/client-bedrock-runtime";

export interface BedrockModelAccessProbe {
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  modelKind: "embedding" | "generative";
}

export async function probeBedrockModelAccess(options: {
  region: string;
  modelId: string;
}): Promise<BedrockModelAccessProbe> {
  const client = new BedrockRuntimeClient({
    region: options.region
  });
  const modelKind = inferBedrockModelKind(options.modelId);

  try {
    if (modelKind === "embedding") {
      await client.send(
        new InvokeModelCommand({
          modelId: options.modelId,
          contentType: "application/json",
          accept: "application/json",
          body: buildEmbeddingProbeBody(options.modelId)
        })
      );
    } else {
      await client.send(
        new ConverseCommand({
          modelId: options.modelId,
          messages: [
            {
              role: "user",
              content: [
                {
                  text: "Broadly connectivity check."
                }
              ]
            }
          ],
          inferenceConfig: {
            maxTokens: 1,
            temperature: 0
          }
        })
      );
    }

    return {
      ok: true,
      errorCode: null,
      errorMessage: null,
      modelKind
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: extractBedrockErrorCode(error),
      errorMessage: extractBedrockErrorMessage(error),
      modelKind
    };
  }
}

export function inferBedrockModelKind(modelId: string): "embedding" | "generative" {
  return modelId.toLowerCase().includes("embed") ? "embedding" : "generative";
}

function buildEmbeddingProbeBody(modelId: string): Uint8Array {
  if (modelId.startsWith("cohere.")) {
    return new TextEncoder().encode(
      JSON.stringify({
        texts: ["Broadly connectivity check."],
        input_type: "search_document"
      })
    );
  }

  if (modelId.startsWith("amazon.titan-embed")) {
    return new TextEncoder().encode(
      JSON.stringify({
        inputText: "Broadly connectivity check."
      })
    );
  }

  return new TextEncoder().encode(
    JSON.stringify({
      inputText: "Broadly connectivity check."
    })
  );
}

function extractBedrockErrorCode(error: unknown): string | null {
  if (error instanceof Error && error.name.trim().length > 0) {
    return error.name.trim();
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "Code" in error &&
    typeof error.Code === "string" &&
    error.Code.trim().length > 0
  ) {
    return error.Code.trim();
  }

  return null;
}

function extractBedrockErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message.trim();
  }

  return null;
}
