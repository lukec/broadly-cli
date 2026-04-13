import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  parseProjectConfig,
  serializeProjectConfig
} from "@broadly/config";
import { resolveProjectPaths } from "@broadly/core";
import { addTabularDataSource } from "@broadly/ingest";

export interface AddDataSourceOptions {
  datasetPath: string;
  project?: string;
}

export async function addDataSource(options: AddDataSourceOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const projectPaths = resolveProjectPaths(projectRoot);

  if (!(await fileExists(projectPaths.configPath))) {
    throw new Error(`Could not find broadly.yaml at ${projectPaths.configPath}`);
  }

  const absoluteDatasetPath = path.resolve(options.datasetPath);
  const configSource = await readFile(projectPaths.configPath, "utf8");
  const config = parseProjectConfig(configSource);
  const ingestResult = await addTabularDataSource({
    projectRoot,
    datasetPath: absoluteDatasetPath
  });
  const relativeDatasetPath = toPortableRelativePath(projectRoot, absoluteDatasetPath);

  config.dataset = {
    path: relativeDatasetPath,
    format: ingestResult.datasetFormat,
    encoding: ingestResult.encoding,
    delimiter: ingestResult.delimiter,
    ...(ingestResult.idColumn === undefined ? {} : { idColumn: ingestResult.idColumn })
  };

  await writeFile(projectPaths.configPath, serializeProjectConfig(config), "utf8");

  const lines = [
    `Ingested data source into ${projectPaths.configPath}`,
    "",
    `Source file: ${absoluteDatasetPath}`,
    `Stored as: ${relativeDatasetPath}`,
    `Detected format: ${ingestResult.datasetFormat}`,
    `Detected encoding: ${ingestResult.encoding}`,
    `Detected delimiter: ${renderDelimiterLabel(ingestResult.delimiter)}`,
    `Rows normalized: ${ingestResult.rowCount}`,
    `JSON files written: ${ingestResult.filesWritten}`,
    `Normalized output: ${ingestResult.normalizedDir}`
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

function renderDelimiterLabel(delimiter: string): string {
  if (delimiter === "\t") {
    return "\\t";
  }

  return delimiter;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
