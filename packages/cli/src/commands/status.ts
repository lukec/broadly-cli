import { readFile } from "node:fs/promises";
import process from "node:process";

import { parseProjectConfig } from "@broadly/config";
import { resolveProjectPaths } from "@broadly/core";
import { withProjectActionLog } from "../projectLog.js";

import {
  buildPipelineSteps,
  loadProjectDashboard,
  stageStatusLabel,
  resolveCommandProjectRoot,
  type ProjectDashboardData,
  type StepStatus
} from "./projectDashboard.js";

export interface StatusCommandOptions {
  project?: string;
}

export async function showProjectStatus(options: StatusCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  await withProjectActionLog({
    projectRoot,
    command: "status",
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = parseProjectConfig(await readFile(projectPaths.configPath, "utf8"));
      const dashboard = await loadProjectDashboard(projectRoot, config, false);

      process.stdout.write(`${renderStatusReport(dashboard, projectPaths.configPath)}\n`);
    }
  });
}

function renderStatusReport(data: ProjectDashboardData, configPath: string): string {
  const lines: string[] = [];
  const steps = buildPipelineSteps(data);
  const completeCount = steps.filter((step) => step.status === "ready").length;
  const inProgressCount = steps.filter((step) => step.status === "active").length;
  const pendingCount = steps.filter((step) => step.status === "pending").length;

  lines.push(color.heading("Broadly Project Status"));
  lines.push(color.muted(rule("=")));
  lines.push(formatDetailLine("Project", color.title(data.config.project.name)));
  lines.push(formatDetailLine("Config", configPath));
  lines.push(
    formatDetailLine(
      "Summary",
      `${completeCount} complete, ${inProgressCount} in progress, ${pendingCount} pending`
    )
  );
  lines.push("");

  lines.push(color.section("Project"));
  lines.push(formatDetailLine("Root", data.projectRoot));
  lines.push(formatDetailLine("Slug", data.config.project.slug));
  lines.push(
    formatDetailLine(
      "Description",
      data.config.project.description.trim().length > 0 ? data.config.project.description : "No description."
    )
  );

  if (data.config.project.goals.length > 0) {
    lines.push(color.section("Goals"));
    for (const goal of data.config.project.goals) {
      lines.push(`  ${color.bullet("+")} ${goal}`);
    }
  }

  lines.push(color.section("Key Questions"));
  for (const question of data.config.questions) {
    lines.push(`  ${color.bullet("?")} ${question}`);
  }

  lines.push("");
  lines.push(color.section("Pipeline"));

  for (const step of steps) {
    lines.push(
      `${statusBadge(step.status)} ${color.title(step.title)} ${color.muted(`(${stageStatusLabel(step.status)})`)}`
    );
    lines.push(formatDetailLine("What", step.summary));
    lines.push(formatDetailLine("State", step.detail));

    if (step.step === "ingest") {
      lines.push(
        formatDetailLine(
          "Latest",
          data.ingest.latestImport === null
            ? "No import manifest yet"
            : `${formatPrettyDate(data.ingest.latestImport.createdAt)} · ${data.ingest.latestImport.recordsWritten} records`
        )
      );
    }

    if (step.step === "opinions") {
      const latestRun = data.opinionRuns[0];
      lines.push(
        formatDetailLine(
          "Latest",
          latestRun === undefined
            ? "No opinion runs yet"
            : `${latestRun.runId} · ${formatPrettyDate(latestRun.createdAt)}`
        )
      );
    }

    if (step.step === "analysis") {
      const latestRun = data.analysis.runs[0];
      lines.push(
        formatDetailLine(
          "Latest",
          latestRun === undefined
            ? "No analysis runs yet"
            : `${latestRun.runId} · ${formatPrettyDate(latestRun.createdAt)}`
        )
      );
    }

    if (step.step === "report") {
      lines.push(
        formatDetailLine(
          "Output",
          `${data.report.fileCount} file(s) in ${data.report.reportDir} · primary ${data.report.primaryView}`
        )
      );
    }

    lines.push("");
  }

  return lines.map((line) => line.replace(/\s+$/g, "")).join("\n").trimEnd();
}

function formatDetailLine(label: string, value: string): string {
  return `  ${color.label(label.padEnd(8))} ${value}`;
}

function statusBadge(status: StepStatus): string {
  switch (status) {
    case "ready":
      return color.goodBadge("DONE ");
    case "active":
      return color.warnBadge("WORK ");
    case "pending":
      return color.pendingBadge("WAIT ");
  }
}

function formatPrettyDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const relative = formatRelativeTime(date);
  const absolute = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);

  return `${relative} (${absolute})`;
}

function formatRelativeTime(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 1000 * 60 * 60 * 24 * 365],
    ["month", 1000 * 60 * 60 * 24 * 30],
    ["week", 1000 * 60 * 60 * 24 * 7],
    ["day", 1000 * 60 * 60 * 24],
    ["hour", 1000 * 60 * 60],
    ["minute", 1000 * 60],
    ["second", 1000]
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  for (const [unit, unitMs] of units) {
    if (Math.abs(diffMs) >= unitMs || unit === "second") {
      return rtf.format(Math.round(diffMs / unitMs), unit);
    }
  }

  return "now";
}

function rule(character: string): string {
  const width = process.stdout.columns ?? 72;
  return character.repeat(Math.max(24, Math.min(width, 72)));
}

const color = {
  heading: (value: string) => applyAnsi(value, ["1", "36"]),
  title: (value: string) => applyAnsi(value, ["1", "37"]),
  label: (value: string) => applyAnsi(value, ["1", "34"]),
  muted: (value: string) => applyAnsi(value, ["2", "37"]),
  section: (value: string) => applyAnsi(`  ${value}`, ["1", "35"]),
  bullet: (value: string) => applyAnsi(value, ["1", "36"]),
  goodBadge: (value: string) => applyAnsi(`[${value}]`, ["1", "30", "42"]),
  warnBadge: (value: string) => applyAnsi(`[${value}]`, ["1", "30", "43"]),
  pendingBadge: (value: string) => applyAnsi(`[${value}]`, ["1", "37", "100"])
};

function applyAnsi(value: string, codes: string[]): string {
  if (!process.stdout.isTTY) {
    return value;
  }

  return `\u001B[${codes.join(";")}m${value}\u001B[0m`;
}
