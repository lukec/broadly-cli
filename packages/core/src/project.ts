import { mkdir } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_PROJECT_DIRECTORIES = [
  "data/raw",
  "data/normalized",
  "data/opinions",
  "data/embeddings",
  "data/review/comments",
  "data/review/opinions",
  "data/review/suggestions/comments",
  "data/review/suggestions/opinions",
  "archive/opinions",
  "archive/analysis",
  "llm-cache/text",
  "prompts",
  "runs",
  "reports"
] as const;

export interface ProjectPaths {
  rootDir: string;
  configPath: string;
  dataDir: string;
  reviewDir: string;
  reviewCommentsDir: string;
  reviewOpinionsDir: string;
  reviewSuggestionsDir: string;
  reviewCommentSuggestionsDir: string;
  reviewOpinionSuggestionsDir: string;
  reviewConfigPath: string;
  archiveDir: string;
  llmCacheDir: string;
  promptsDir: string;
  runsDir: string;
  reportsDir: string;
  opinionsCurrentRunPath: string;
  analysisCurrentRunPath: string;
}

export function resolveProjectPaths(rootDir: string): ProjectPaths {
  const absoluteRootDir = path.resolve(rootDir);

  return {
    rootDir: absoluteRootDir,
    configPath: path.join(absoluteRootDir, "broadly.yaml"),
    dataDir: path.join(absoluteRootDir, "data"),
    reviewDir: path.join(absoluteRootDir, "data", "review"),
    reviewCommentsDir: path.join(absoluteRootDir, "data", "review", "comments"),
    reviewOpinionsDir: path.join(absoluteRootDir, "data", "review", "opinions"),
    reviewSuggestionsDir: path.join(absoluteRootDir, "data", "review", "suggestions"),
    reviewCommentSuggestionsDir: path.join(
      absoluteRootDir,
      "data",
      "review",
      "suggestions",
      "comments"
    ),
    reviewOpinionSuggestionsDir: path.join(
      absoluteRootDir,
      "data",
      "review",
      "suggestions",
      "opinions"
    ),
    reviewConfigPath: path.join(absoluteRootDir, "data", "review", "config.json"),
    archiveDir: path.join(absoluteRootDir, "archive"),
    llmCacheDir: path.join(absoluteRootDir, "llm-cache"),
    promptsDir: path.join(absoluteRootDir, "prompts"),
    runsDir: path.join(absoluteRootDir, "runs"),
    reportsDir: path.join(absoluteRootDir, "reports"),
    opinionsCurrentRunPath: path.join(absoluteRootDir, "data", "opinions", "current-run.txt"),
    analysisCurrentRunPath: path.join(absoluteRootDir, "runs", "current-run.txt")
  };
}

export async function ensureProjectLayout(rootDir: string): Promise<ProjectPaths> {
  const projectPaths = resolveProjectPaths(rootDir);

  await mkdir(projectPaths.rootDir, { recursive: true });

  for (const relativeDirectory of DEFAULT_PROJECT_DIRECTORIES) {
    await mkdir(path.join(projectPaths.rootDir, relativeDirectory), { recursive: true });
  }

  return projectPaths;
}
