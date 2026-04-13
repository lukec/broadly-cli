import { mkdir } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_PROJECT_DIRECTORIES = [
  "data/raw",
  "data/normalized",
  "data/opinions",
  "runs",
  "reports"
] as const;

export interface ProjectPaths {
  rootDir: string;
  configPath: string;
  dataDir: string;
  runsDir: string;
  reportsDir: string;
}

export function resolveProjectPaths(rootDir: string): ProjectPaths {
  const absoluteRootDir = path.resolve(rootDir);

  return {
    rootDir: absoluteRootDir,
    configPath: path.join(absoluteRootDir, "broadly.yaml"),
    dataDir: path.join(absoluteRootDir, "data"),
    runsDir: path.join(absoluteRootDir, "runs"),
    reportsDir: path.join(absoluteRootDir, "reports")
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
