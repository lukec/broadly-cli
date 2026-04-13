import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { resolveProjectPaths } from "@broadly/core";
import { extractOpinionUnits } from "@broadly/pipeline";

export interface ExtractOpinionsOptions {
  project?: string;
}

export async function extractOpinions(options: ExtractOpinionsOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const projectPaths = resolveProjectPaths(projectRoot);
  const normalizedDir = path.join(projectPaths.dataDir, "normalized");
  const opinionsDir = path.join(projectPaths.dataDir, "opinions");
  const result = await extractOpinionUnits({
    normalizedDir,
    outputDir: opinionsDir
  });
  const relativeManifestPath = toPortableRelativePath(projectRoot, result.manifestPath);

  const lines = [
    `Extracted opinion units for ${projectRoot}`,
    "",
    `Method: ${result.extractionMethod}`,
    `Normalized records read: ${result.recordsRead}`,
    `Opinion files written: ${result.opinionsWritten}`,
    `Opinions output: ${result.outputDir}`,
    `Manifest: ${relativeManifestPath}`
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
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

function toPortableRelativePath(fromDirectory: string, toPath: string): string {
  const relativePath = path.relative(fromDirectory, toPath);
  const portablePath = relativePath.split(path.sep).join("/");

  return portablePath.startsWith(".") ? portablePath : `./${portablePath}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
