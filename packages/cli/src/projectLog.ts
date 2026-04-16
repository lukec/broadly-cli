import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const PROJECT_LOG_FILENAME = "broadly.log";

interface ProjectLogEntry {
  timestamp: string;
  event: "start" | "end" | "error" | "info";
  command: string;
  pid: number;
  cwd: string;
  duration_ms?: number;
  details?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
  };
}

export async function ensureProjectLogFile(projectRoot: string): Promise<void> {
  const logPath = path.join(projectRoot, PROJECT_LOG_FILENAME);

  try {
    await appendFile(logPath, "");
  } catch {
    await writeFile(logPath, "", "utf8");
  }
}

export async function appendProjectLogEvent(options: {
  projectRoot: string;
  command: string;
  event: ProjectLogEntry["event"];
  details?: Record<string, unknown>;
  durationMs?: number;
  error?: unknown;
}): Promise<void> {
  const entry: ProjectLogEntry = {
    timestamp: new Date().toISOString(),
    event: options.event,
    command: options.command,
    pid: process.pid,
    cwd: process.cwd(),
    ...(options.durationMs === undefined ? {} : { duration_ms: options.durationMs }),
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.error === undefined
      ? {}
      : {
          error: {
            name: options.error instanceof Error ? options.error.name : "Error",
            message: options.error instanceof Error ? options.error.message : String(options.error)
          }
        })
  };

  try {
    await ensureProjectLogFile(options.projectRoot);
    await appendFile(
      path.join(options.projectRoot, PROJECT_LOG_FILENAME),
      `${JSON.stringify(entry)}\n`,
      "utf8"
    );
  } catch {
    // Logging is best-effort and must not break the command.
  }
}

export async function withProjectActionLog<T>(options: {
  projectRoot: string;
  command: string;
  details?: Record<string, unknown>;
  action: () => Promise<T>;
  summarizeResult?: (result: T) => Record<string, unknown> | undefined;
}): Promise<T> {
  const startedAt = Date.now();
  await appendProjectLogEvent({
    projectRoot: options.projectRoot,
    command: options.command,
    event: "start",
    ...(options.details === undefined ? {} : { details: options.details })
  });

  try {
    const result = await options.action();

    const summary = options.summarizeResult?.(result);
    await appendProjectLogEvent({
      projectRoot: options.projectRoot,
      command: options.command,
      event: "end",
      durationMs: Date.now() - startedAt,
      ...(summary === undefined ? {} : { details: summary })
    });

    return result;
  } catch (error) {
    await appendProjectLogEvent({
      projectRoot: options.projectRoot,
      command: options.command,
      event: "error",
      durationMs: Date.now() - startedAt,
      ...(options.details === undefined ? {} : { details: options.details }),
      error
    });
    throw error;
  }
}
