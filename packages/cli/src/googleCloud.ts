import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { GoogleAuth } from "google-auth-library";

export interface GoogleCloudRuntimeProbe {
  configuredCredentialsPath: string | null;
  adcPath: string;
  envProjectId: string | null;
  tokenAvailable: boolean;
  tokenError: string | null;
  accessToken: string | null;
  projectId: string | null;
}

export interface GoogleCloudModelAccessProbe {
  ok: boolean;
  statusCode: number | null;
  errorStatus: string | null;
  errorMessage: string | null;
  modelKind: "embedding" | "generative";
}

export async function probeGoogleCloudRuntime(): Promise<GoogleCloudRuntimeProbe> {
  const configuredCredentialsPath = normalizeEnvPath(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const gcloudConfigDir =
    process.env.CLOUDSDK_CONFIG ?? path.join(os.homedir(), ".config", "gcloud");
  const adcPath =
    configuredCredentialsPath ?? path.join(gcloudConfigDir, "application_default_credentials.json");
  const envProjectId = normalizeEnvValue(
    process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT
  );
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  });

  try {
    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();
    const tokenValue = typeof accessToken === "string" ? accessToken : (accessToken?.token ?? null);

    return {
      configuredCredentialsPath,
      adcPath,
      envProjectId,
      tokenAvailable: tokenValue !== null && tokenValue.trim().length > 0,
      tokenError: null,
      accessToken: tokenValue !== null && tokenValue.trim().length > 0 ? tokenValue : null,
      projectId: await resolveGoogleCloudProjectId(auth, adcPath, envProjectId)
    };
  } catch (error) {
    return {
      configuredCredentialsPath,
      adcPath,
      envProjectId,
      tokenAvailable: false,
      tokenError: error instanceof Error ? error.message : String(error),
      accessToken: null,
      projectId: await resolveGoogleCloudProjectId(auth, adcPath, envProjectId)
    };
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function probeGoogleCloudModelAccess(options: {
  accessToken: string;
  projectId: string;
  region: string;
  modelId: string;
}): Promise<GoogleCloudModelAccessProbe> {
  const modelKind = inferGoogleCloudModelKind(options.modelId);
  const response =
    modelKind === "embedding"
      ? await fetch(
          `https://${options.region}-aiplatform.googleapis.com/v1/projects/${options.projectId}/locations/${options.region}/publishers/google/models/${options.modelId}:predict`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              instances: [
                {
                  content: "Broadly connectivity check."
                }
              ],
              parameters: {
                autoTruncate: true
              }
            })
          }
        )
      : await fetch(
          `https://${options.region}-aiplatform.googleapis.com/v1/projects/${options.projectId}/locations/${options.region}/publishers/google/models/${options.modelId}:countTokens`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      text: "Broadly connectivity check."
                    }
                  ]
                }
              ]
            })
          }
        );

  if (response.ok) {
    return {
      ok: true,
      statusCode: response.status,
      errorStatus: null,
      errorMessage: null,
      modelKind
    };
  }

  const parsedError = await parseGoogleCloudError(response);

  return {
    ok: false,
    statusCode: response.status,
    errorStatus: parsedError.status,
    errorMessage: parsedError.message,
    modelKind
  };
}

export function inferGoogleCloudModelKind(modelId: string): "embedding" | "generative" {
  return modelId.toLowerCase().includes("embedding") ? "embedding" : "generative";
}

async function resolveGoogleCloudProjectId(
  auth: GoogleAuth,
  adcPath: string,
  envProjectId: string | null
): Promise<string | null> {
  if (envProjectId !== null) {
    return envProjectId;
  }

  try {
    const detectedProjectId = await auth.getProjectId();

    if (detectedProjectId.trim().length > 0) {
      return detectedProjectId.trim();
    }
  } catch {
    // Fall through to ADC file inspection below.
  }

  try {
    const source = await readFile(adcPath, "utf8");
    const parsed = JSON.parse(source) as {
      quota_project_id?: unknown;
      project_id?: unknown;
    };
    const quotaProjectId =
      typeof parsed.quota_project_id === "string" ? parsed.quota_project_id.trim() : "";
    const projectId = typeof parsed.project_id === "string" ? parsed.project_id.trim() : "";

    if (quotaProjectId.length > 0) {
      return quotaProjectId;
    }

    if (projectId.length > 0) {
      return projectId;
    }
  } catch {
    // Ignore ADC parsing failures and return null below.
  }

  return null;
}

function normalizeEnvPath(value: string | undefined): string | null {
  const trimmedValue = value?.trim();

  return trimmedValue !== undefined && trimmedValue.length > 0 ? trimmedValue : null;
}

function normalizeEnvValue(value: string | undefined): string | null {
  const trimmedValue = value?.trim();

  return trimmedValue !== undefined && trimmedValue.length > 0 ? trimmedValue : null;
}

async function parseGoogleCloudError(response: Response): Promise<{
  status: string | null;
  message: string | null;
}> {
  try {
    const responseText = await response.text();

    if (responseText.trim().length === 0) {
      return {
        status: null,
        message: null
      };
    }

    try {
      const parsed = JSON.parse(responseText) as {
        error?: {
          status?: unknown;
          message?: unknown;
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

      return {
        status,
        message
      };
    } catch {
      return {
        status: null,
        message: responseText.trim().replace(/\s+/g, " ")
      };
    }
  } catch {
    return {
      status: null,
      message: null
    };
  }
}
