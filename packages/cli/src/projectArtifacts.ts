import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveProjectPaths, sha256Hex } from "@broadly/core";

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

export async function readJsonArtifact<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJsonArtifact(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function listJsonArtifactPaths(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => path.join(directoryPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function artifactExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function hashFile(filePath: string): Promise<string> {
  return sha256Hex(await readFile(filePath));
}

export function createTimestampRunId(prefix: string, suffix?: string): string {
  const timestamp = formatRunTimestamp(new Date());
  const safeSuffix = suffix === undefined ? "" : `-${slugifyRunIdPart(suffix)}`;
  return `${prefix}-${timestamp}${safeSuffix}`;
}

export function toProjectRelativePath(projectRoot: string, artifactPath: string): string {
  const relativePath = path.relative(projectRoot, artifactPath);

  if (relativePath.length === 0) {
    return ".";
  }

  return relativePath.split(path.sep).join("/");
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

function formatRunTimestamp(value: Date): string {
  return [
    `${value.getFullYear()}-${padPart(value.getMonth() + 1)}-${padPart(value.getDate())}`,
    `${padPart(value.getHours())}-${padPart(value.getMinutes())}-${padPart(value.getSeconds())}`
  ].join("-");
}

function slugifyRunIdPart(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
}
