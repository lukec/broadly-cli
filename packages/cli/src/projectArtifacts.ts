import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveProjectPaths } from "@broadly/core";

export async function readCurrentRunId(pointerPath: string): Promise<string | null> {
  try {
    const value = (await readFile(pointerPath, "utf8")).trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

export async function writeCurrentRunId(pointerPath: string, runId: string): Promise<void> {
  await mkdir(path.dirname(pointerPath), { recursive: true });
  await writeFile(pointerPath, `${runId}\n`, "utf8");
}

export async function clearCurrentRunId(pointerPath: string): Promise<void> {
  await rm(pointerPath, { force: true });
}

export async function archiveProjectRuns(options: {
  projectRoot: string;
  sourceDir: string;
  archiveKind: "opinions" | "analysis";
  pointerPath?: string;
}): Promise<{
  archiveDir: string;
  archivedRunIds: string[];
}> {
  const projectPaths = resolveProjectPaths(options.projectRoot);
  const archiveBatchDir = path.join(
    projectPaths.archiveDir,
    options.archiveKind,
    archiveTimestamp(new Date())
  );
  const entries = await readDirectoryEntries(options.sourceDir);
  const archivedRunIds: string[] = [];

  await mkdir(archiveBatchDir, { recursive: true });

  for (const entry of entries) {
    if (entry === ".gitkeep" || entry === "current-run.txt") {
      continue;
    }

    await rename(path.join(options.sourceDir, entry), path.join(archiveBatchDir, entry));
    archivedRunIds.push(entry);
  }

  if (options.pointerPath !== undefined) {
    await clearCurrentRunId(options.pointerPath);
  }

  return {
    archiveDir: archiveBatchDir,
    archivedRunIds
  };
}

async function readDirectoryEntries(directoryPath: string): Promise<string[]> {
  try {
    return await readDirNames(directoryPath);
  } catch {
    return [];
  }
}

async function readDirNames(directoryPath: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directoryPath, { withFileTypes: true });
  return entries.map((entry) => entry.name).sort();
}

function archiveTimestamp(value: Date): string {
  return [
    `${value.getFullYear()}-${padPart(value.getMonth() + 1)}-${padPart(value.getDate())}`,
    `${padPart(value.getHours())}-${padPart(value.getMinutes())}-${padPart(value.getSeconds())}-${padPart(value.getMilliseconds(), 3)}`
  ].join("_");
}

function padPart(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
