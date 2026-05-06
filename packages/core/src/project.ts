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
  "taxonomies",
  "llm-cache/text",
  "prompts",
  "runs",
  "reports",
  "statements",
  "votes",
  "attestations"
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
  taxonomiesDir: string;
  reportsDir: string;
  statementsDir: string;
  votesDir: string;
  attestationsDir: string;
  opinionsCurrentRunPath: string;
  analysisCurrentRunPath: string;
  statementsCurrentRunPath: string;
  taxonomyCurrentRunPath: string;
  votesCurrentRoundPath: string;
}

export interface StatementRunPaths {
  runDir: string;
  manifestPath: string;
  statementBankPath: string;
  statementsDir: string;
  qaDir: string;
  reviewDir: string;
  acceptedStatementsPath: string;
}

export interface VoteRoundPaths {
  roundDir: string;
  manifestPath: string;
  statementsPath: string;
  reactionEventsPath: string;
  reactionStatePath: string;
  summaryPath: string;
  exportsDir: string;
}

export interface AttestationPaths {
  rootDir: string;
  reportsDir: string;
  statementsDir: string;
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
    taxonomiesDir: path.join(absoluteRootDir, "taxonomies"),
    reportsDir: path.join(absoluteRootDir, "reports"),
    statementsDir: path.join(absoluteRootDir, "statements"),
    votesDir: path.join(absoluteRootDir, "votes"),
    attestationsDir: path.join(absoluteRootDir, "attestations"),
    opinionsCurrentRunPath: path.join(absoluteRootDir, "data", "opinions", "current-run.txt"),
    analysisCurrentRunPath: path.join(absoluteRootDir, "runs", "current-run.txt"),
    statementsCurrentRunPath: path.join(absoluteRootDir, "statements", "current-run.txt"),
    taxonomyCurrentRunPath: path.join(absoluteRootDir, "taxonomies", "current-run.txt"),
    votesCurrentRoundPath: path.join(absoluteRootDir, "votes", "current-round.txt")
  };
}

export function resolveStatementRunPaths(rootDir: string, statementRunId: string): StatementRunPaths {
  const projectPaths = resolveProjectPaths(rootDir);
  const runDir = path.join(projectPaths.statementsDir, statementRunId);

  return {
    runDir,
    manifestPath: path.join(runDir, "manifest.json"),
    statementBankPath: path.join(runDir, "statement-bank.json"),
    statementsDir: path.join(runDir, "statements"),
    qaDir: path.join(runDir, "qa"),
    reviewDir: path.join(runDir, "review", "statements"),
    acceptedStatementsPath: path.join(runDir, "accepted-statements.json")
  };
}

export function resolveVoteRoundPaths(rootDir: string, voteRoundId: string): VoteRoundPaths {
  const projectPaths = resolveProjectPaths(rootDir);
  const roundDir = path.join(projectPaths.votesDir, voteRoundId);

  return {
    roundDir,
    manifestPath: path.join(roundDir, "manifest.json"),
    statementsPath: path.join(roundDir, "statements.json"),
    reactionEventsPath: path.join(roundDir, "reaction-events.jsonl"),
    reactionStatePath: path.join(roundDir, "reaction-state.json"),
    summaryPath: path.join(roundDir, "summary.json"),
    exportsDir: path.join(roundDir, "exports")
  };
}

export function resolveAttestationPaths(rootDir: string): AttestationPaths {
  const projectPaths = resolveProjectPaths(rootDir);

  return {
    rootDir: projectPaths.attestationsDir,
    reportsDir: path.join(projectPaths.attestationsDir, "reports"),
    statementsDir: path.join(projectPaths.attestationsDir, "statements")
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
