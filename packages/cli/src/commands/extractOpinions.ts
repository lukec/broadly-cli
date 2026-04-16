import { access } from "node:fs/promises";
import path from "node:path";

import { extractOpinionsWithModel } from "./opinions.js";

export interface ExtractOpinionsOptions {
  project?: string;
  archive?: boolean;
  resume?: boolean;
  concurrency?: number;
}

export async function extractOpinions(options: ExtractOpinionsOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  await extractOpinionsWithModel({
    project: projectRoot,
    ...(options.archive === true ? { archive: true } : {}),
    ...(options.resume === true ? { resume: true } : {}),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
  });
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
