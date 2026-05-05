import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseProjectConfig } from "@broadly/config";
import {
  resolveProjectPaths,
  resolveVoteRoundPaths,
  sha256Hex,
  type VoteRoundPaths
} from "@broadly/core";
import type {
  InitialQuestionResponseEvent,
  InitialQuestionResponseValue,
  ReactionEvent,
  ReactionState,
  ReactionValue,
  Statement,
  StatementBank,
  VoteInitialQuestion,
  VoteRoundManifest,
  VoteRoundSummary,
  VoteStatementSummary
} from "@broadly/report-model";

import {
  appendJsonLine,
  artifactExists,
  createTimestampRunId,
  hashFile,
  readCurrentRunId,
  readJsonArtifact,
  toProjectRelativePath,
  writeCurrentRunId,
  writeJsonArtifact
} from "../projectArtifacts.js";
import { withProjectActionLog } from "../projectLog.js";
import { resolveCommandProjectRoot } from "./projectDashboard.js";
import {
  findLatestStatementRunId,
  loadStatementBankWithReviews
} from "./statements.js";

export interface VoteInitCommandOptions {
  project?: string;
  statements?: string;
}

export interface VoteWebCommandOptions {
  project?: string;
  round?: string;
  port?: number;
}

export interface VoteExportCommandOptions {
  project?: string;
  round?: string;
}

export interface VoteAnalyzeCommandOptions {
  project?: string;
  round?: string;
}

export interface VoteSeedCommandOptions {
  project?: string;
  round?: string;
  participants?: number;
}

export interface VoteReportCommandOptions {
  project?: string;
  round?: string;
}

interface LoadedVoteRound {
  voteRoundId: string;
  paths: VoteRoundPaths;
  manifest: VoteRoundManifest;
  statements: Statement[];
  state: ReactionState;
}

const REACTION_VALUES: ReactionValue[] = ["agree", "disagree", "pass"];
const INITIAL_QUESTION_RESPONSE_VALUES: InitialQuestionResponseValue[] = ["yes", "no", "skip"];

export async function initVoteRound(options: VoteInitCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "vote init",
    details: {
      statements: options.statements ?? "(current accepted statements)"
    },
    action: async () => {
      const projectPaths = resolveProjectPaths(projectRoot);
      const config = parseProjectConfig(await readFile(projectPaths.configPath, "utf8"));
      const bank = await loadStatementBankForVoting(projectRoot, options.statements);
      const initialQuestions: VoteInitialQuestion[] = config.voting.initialQuestions.map((question) => ({
        questionId: question.questionId,
        questionText: question.questionText,
        responseKind: question.responseKind
      }));
      const acceptedStatements = bank.statements.filter(
        (statement) =>
          statement.moderationStatus === "accepted" &&
          statement.visibilityStatus !== "private" &&
          statement.duplicateOfStatementId === undefined
      );

      if (acceptedStatements.length === 0) {
        throw new Error(
          "No accepted public statements are available. Review statements first with broadly statements review."
        );
      }

      const voteRoundId = createTimestampRunId("vote", bank.statementRunId);
      const paths = resolveVoteRoundPaths(projectRoot, voteRoundId);
      const createdAt = new Date().toISOString();
      const sourceBankPath = path.join(projectPaths.statementsDir, bank.statementRunId, "statement-bank.json");
      const statementBankSha256 =
        (await artifactExists(sourceBankPath)) === true
          ? await hashFile(sourceBankPath)
          : sha256Hex(JSON.stringify(bank));
      const manifest: VoteRoundManifest = {
        voteRoundId,
        createdAt,
        updatedAt: createdAt,
        status: "active",
        input: {
          statementBankPath: sourceBankPath,
          statementBankSha256,
          statementRunId: bank.statementRunId,
          acceptedStatementCount: acceptedStatements.length,
          initialQuestionCount: initialQuestions.length,
          initialQuestions
        },
        output: {
          statementsPath: paths.statementsPath,
          reactionEventsPath: paths.reactionEventsPath,
          reactionStatePath: paths.reactionStatePath,
          exportsDir: paths.exportsDir
        },
        limits: {
          localOnly: true,
          identity: "anonymous-or-named-local",
          productionUse: "not-production-civic-infrastructure"
        }
      };
      const state: ReactionState = {
        voteRoundId,
        updatedAt: createdAt,
        initialQuestions,
        statements: acceptedStatements.map((statement) => ({
          statementId: statement.statementId,
          statementText: statement.statementText
        })),
        participants: [],
        initialQuestionResponses: {},
        reactions: {}
      };

      await mkdir(paths.exportsDir, { recursive: true });
      await writeJsonArtifact(paths.manifestPath, manifest);
      await writeJsonArtifact(paths.statementsPath, {
        voteRoundId,
        statementRunId: bank.statementRunId,
        initialQuestions,
        statements: acceptedStatements
      });
      await writeFile(paths.reactionEventsPath, "", "utf8");
      await writeJsonArtifact(paths.reactionStatePath, state);
      await writeCurrentRunId(projectPaths.votesCurrentRoundPath, voteRoundId);

      process.stdout.write(
        [
          `Initialized local voting round for ${projectRoot}`,
          "",
          `Vote round: ${voteRoundId}`,
          `Initial questions: ${initialQuestions.length}`,
          `Statements: ${acceptedStatements.length}`,
          `Round dir: ${toProjectRelativePath(projectRoot, paths.roundDir)}`
        ].join("\n") + "\n"
      );
    }
  });
}

export async function serveVoteWeb(options: VoteWebCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);
  const port = options.port ?? 4320;
  const roundId = await resolveVoteRoundId(projectRoot, options.round);

  if (roundId === null) {
    throw new Error("No voting round was found. Run broadly vote init first.");
  }

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

      if (request.method === "POST" && requestUrl.pathname === "/vote") {
        const form = await readRequestForm(request);
        const participantId = normalizeParticipantId(form.get("participantId"));
        const round = await loadVoteRound(projectRoot, roundId);
        const events = applyVoteForm(round, participantId, form);

        if (events.length > 0) {
          for (const event of events) {
            await appendJsonLine(round.paths.reactionEventsPath, event);
          }

          await writeJsonArtifact(round.paths.reactionStatePath, round.state);
        }

        response.writeHead(303, { Location: `/?participant=${encodeURIComponent(participantId)}` });
        response.end();
        return;
      }

      if (requestUrl.pathname !== "/") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }

      const round = await loadVoteRound(projectRoot, roundId);
      const participantId = normalizeParticipantId(requestUrl.searchParams.get("participant"));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderVoteRoundPage(round, participantId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`${message}\n`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  process.stdout.write(
    `Broadly local voting sandbox running for ${projectRoot}\nRound: ${roundId}\nOpen: http://127.0.0.1:${port}\n`
  );
}

export async function exportVoteRound(options: VoteExportCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "vote export",
    details: {
      round: options.round ?? "(current)"
    },
    action: async () => {
      const round = await requireVoteRound(projectRoot, options.round);
      const summary = summarizeVoteRound(round, await loadStatementBankForRound(projectRoot, round));
      const csvPath = path.join(round.paths.exportsDir, "statement-results.csv");
      const initialQuestionsCsvPath = path.join(round.paths.exportsDir, "initial-question-results.csv");

      await mkdir(round.paths.exportsDir, { recursive: true });
      await writeJsonArtifact(path.join(round.paths.exportsDir, "reaction-state.json"), round.state);
      await writeJsonArtifact(path.join(round.paths.exportsDir, "statements.json"), {
        voteRoundId: round.voteRoundId,
        statementRunId: round.manifest.input.statementRunId,
        initialQuestions: round.state.initialQuestions,
        statements: round.statements
      });
      await writeFile(csvPath, renderVoteSummaryCsv(summary), "utf8");
      await writeFile(initialQuestionsCsvPath, renderInitialQuestionSummaryCsv(summary), "utf8");
      await writeJsonArtifact(round.paths.manifestPath, {
        ...round.manifest,
        status: "exported",
        updatedAt: new Date().toISOString()
      } satisfies VoteRoundManifest);

      process.stdout.write(
        [
          `Exported vote round for ${projectRoot}`,
          "",
          `Vote round: ${round.voteRoundId}`,
          `Reaction state: ${toProjectRelativePath(projectRoot, path.join(round.paths.exportsDir, "reaction-state.json"))}`,
          `Initial questions: ${toProjectRelativePath(projectRoot, initialQuestionsCsvPath)}`,
          `Statement results: ${toProjectRelativePath(projectRoot, csvPath)}`
        ].join("\n") + "\n"
      );
    }
  });
}

export async function seedVoteRound(options: VoteSeedCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "vote seed",
    details: {
      round: options.round ?? "(current)",
      participants: options.participants ?? 5
    },
    action: async () => {
      const round = await requireVoteRound(projectRoot, options.round);
      const participantCount = options.participants ?? 5;
      const events: Array<ReactionEvent | InitialQuestionResponseEvent> = [];

      for (let index = 1; index <= participantCount; index += 1) {
        const participantId = `synthetic-${String(index).padStart(2, "0")}`;
        const form = new URLSearchParams();
        form.set("participantId", participantId);

        for (const statement of round.statements) {
          form.set(
            `reaction:${statement.statementId}`,
            deterministicSyntheticReaction(round.voteRoundId, participantId, statement.statementId)
          );
        }

        for (const question of round.state.initialQuestions) {
          form.set(
            `initial-question:${question.questionId}`,
            deterministicSyntheticInitialQuestionResponse(
              round.voteRoundId,
              participantId,
              question.questionId
            )
          );
        }

        events.push(...applyVoteForm(round, participantId, form));
      }

      for (const event of events) {
        await appendJsonLine(round.paths.reactionEventsPath, event);
      }

      await writeJsonArtifact(round.paths.reactionStatePath, round.state);

      process.stdout.write(
        [
          `Seeded synthetic votes for ${projectRoot}`,
          "",
          `Vote round: ${round.voteRoundId}`,
          `Participants: ${participantCount}`,
          `Events written: ${events.length}`
        ].join("\n") + "\n"
      );
    }
  });
}

export async function analyzeVoteRound(options: VoteAnalyzeCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "vote analyze",
    details: {
      round: options.round ?? "(current)"
    },
    action: async () => {
      const round = await requireVoteRound(projectRoot, options.round);
      const bank = await loadStatementBankForRound(projectRoot, round);
      const summary = summarizeVoteRound(round, bank);

      await writeJsonArtifact(round.paths.summaryPath, summary);
      await writeJsonArtifact(round.paths.manifestPath, {
        ...round.manifest,
        status: "analyzed",
        updatedAt: new Date().toISOString()
      } satisfies VoteRoundManifest);

      process.stdout.write(
        [
          `Analyzed vote round for ${projectRoot}`,
          "",
          `Vote round: ${round.voteRoundId}`,
          `Participants: ${summary.participantCount}`,
          `High consensus: ${summary.highConsensusStatementIds.length}`,
          `High contention: ${summary.highContentionStatementIds.length}`,
          `Low participation: ${summary.lowParticipationStatementIds.length}`,
          `Summary: ${toProjectRelativePath(projectRoot, round.paths.summaryPath)}`
        ].join("\n") + "\n"
      );
    }
  });
}

export async function publishVoteReport(options: VoteReportCommandOptions): Promise<void> {
  const projectRoot = await resolveCommandProjectRoot(options.project);

  await withProjectActionLog({
    projectRoot,
    command: "vote report",
    details: {
      round: options.round ?? "(current)"
    },
    action: async () => {
      const round = await requireVoteRound(projectRoot, options.round);
      const bank = await loadStatementBankForRound(projectRoot, round);
      const existingSummary = await readJsonArtifact<VoteRoundSummary>(round.paths.summaryPath);
      const summary =
        existingSummary === null
          ? summarizeVoteRound(round, bank)
          : {
              ...existingSummary,
              initialQuestions: existingSummary.initialQuestions ?? []
            };
      const reportSummaryPath = path.join(
        resolveProjectPaths(projectRoot).reportsDir,
        bank.analysisRunId,
        "vote-summary.json"
      );

      await writeJsonArtifact(round.paths.summaryPath, summary);
      await writeJsonArtifact(reportSummaryPath, summary);

      process.stdout.write(
        [
          `Attached vote summary to report artifacts for ${projectRoot}`,
          "",
          `Vote round: ${round.voteRoundId}`,
          `Analysis run: ${bank.analysisRunId}`,
          `Report vote summary: ${toProjectRelativePath(projectRoot, reportSummaryPath)}`
        ].join("\n") + "\n"
      );
    }
  });
}

export async function loadVoteSummaryForReport(
  reportsDir: string,
  analysisRunId: string
): Promise<VoteRoundSummary | null> {
  const summary = await readJsonArtifact<VoteRoundSummary>(
    path.join(reportsDir, analysisRunId, "vote-summary.json")
  );

  if (summary === null) {
    return null;
  }

  return {
    ...summary,
    initialQuestions: summary.initialQuestions ?? []
  };
}

async function loadStatementBankForVoting(
  projectRoot: string,
  statementsPath: string | undefined
): Promise<StatementBank> {
  if (statementsPath === undefined) {
    const loaded = await loadStatementBankWithReviews(projectRoot);
    return {
      ...loaded.bank,
      statements: loaded.statements
    };
  }

  const resolvedPath = await resolveInputPath(projectRoot, statementsPath);
  const bank = await readJsonArtifact<StatementBank>(resolvedPath);

  if (bank === null) {
    throw new Error(`Statement bank '${statementsPath}' could not be read.`);
  }

  if (path.basename(resolvedPath) === "statement-bank.json") {
    const runId = path.basename(path.dirname(resolvedPath));
    const loaded = await loadStatementBankWithReviews(projectRoot, runId);
    return {
      ...loaded.bank,
      statements: loaded.statements
    };
  }

  return bank;
}

async function loadStatementBankForRound(
  projectRoot: string,
  round: LoadedVoteRound
): Promise<StatementBank> {
  const loaded = await loadStatementBankWithReviews(projectRoot, round.manifest.input.statementRunId);
  return {
    ...loaded.bank,
    statements: loaded.statements
  };
}

async function requireVoteRound(
  projectRoot: string,
  requestedRoundId: string | undefined
): Promise<LoadedVoteRound> {
  const voteRoundId = await resolveVoteRoundId(projectRoot, requestedRoundId);

  if (voteRoundId === null) {
    throw new Error("No voting round was found. Run broadly vote init first.");
  }

  return loadVoteRound(projectRoot, voteRoundId);
}

async function resolveVoteRoundId(
  projectRoot: string,
  requestedRoundId: string | undefined
): Promise<string | null> {
  const projectPaths = resolveProjectPaths(projectRoot);

  return (
    requestedRoundId ??
    (await readCurrentRunId(projectPaths.votesCurrentRoundPath)) ??
    (await findLatestVoteRoundId(projectPaths.votesDir))
  );
}

async function findLatestVoteRoundId(votesDir: string): Promise<string | null> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(votesDir, { withFileTypes: true }).catch(() => []);
  const rounds: Array<{ voteRoundId: string; createdAt: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifest = await readJsonArtifact<VoteRoundManifest>(
      path.join(votesDir, entry.name, "manifest.json")
    );

    if (manifest?.createdAt !== undefined) {
      rounds.push({
        voteRoundId: entry.name,
        createdAt: manifest.createdAt
      });
    }
  }

  rounds.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return rounds[0]?.voteRoundId ?? null;
}

async function loadVoteRound(projectRoot: string, voteRoundId: string): Promise<LoadedVoteRound> {
  const paths = resolveVoteRoundPaths(projectRoot, voteRoundId);
  const manifest = await readJsonArtifact<VoteRoundManifest>(paths.manifestPath);
  const statementsArtifact = await readJsonArtifact<{
    initialQuestions?: VoteInitialQuestion[];
    statements?: Statement[];
  }>(paths.statementsPath);
  const state = await readJsonArtifact<ReactionState>(paths.reactionStatePath);

  if (manifest === null || statementsArtifact?.statements === undefined || state === null) {
    throw new Error(`Vote round '${voteRoundId}' could not be loaded.`);
  }

  return {
    voteRoundId,
    paths,
    manifest,
    statements: statementsArtifact.statements,
    state: normalizeReactionState(state, statementsArtifact.initialQuestions ?? manifest.input.initialQuestions ?? [])
  };
}

function applyVoteForm(
  round: LoadedVoteRound,
  participantId: string,
  form: URLSearchParams
): Array<ReactionEvent | InitialQuestionResponseEvent> {
  const initialQuestionResponses = round.state.initialQuestionResponses[participantId] ?? {};
  const participantReactions = round.state.reactions[participantId] ?? {};
  const events: Array<ReactionEvent | InitialQuestionResponseEvent> = [];
  const createdAt = new Date().toISOString();

  if (!round.state.participants.includes(participantId)) {
    round.state.participants.push(participantId);
    round.state.participants.sort();
  }

  for (const question of round.state.initialQuestions) {
    const response = parseInitialQuestionResponseValue(
      form.get(`initial-question:${question.questionId}`)
    );

    if (response === null) {
      continue;
    }

    const previousResponse = initialQuestionResponses[question.questionId];

    if (previousResponse === response) {
      continue;
    }

    initialQuestionResponses[question.questionId] = response;
    events.push({
      eventKind: "initial-question-response",
      eventId: `event-${sha256Hex(
        JSON.stringify({
          voteRoundId: round.voteRoundId,
          participantId,
          questionId: question.questionId,
          response,
          createdAt
        })
      ).slice(0, 20)}`,
      createdAt,
      voteRoundId: round.voteRoundId,
      participantId,
      questionId: question.questionId,
      response,
      ...(previousResponse === undefined ? {} : { previousResponse })
    });
  }

  round.state.initialQuestionResponses[participantId] = initialQuestionResponses;

  if (!hasAnsweredAllInitialQuestions(round.state, participantId)) {
    round.state.reactions[participantId] = participantReactions;
    round.state.updatedAt = createdAt;
    return events;
  }

  for (const statement of round.statements) {
    const reaction = parseReactionValue(form.get(`reaction:${statement.statementId}`));

    if (reaction === null) {
      continue;
    }

    const previousReaction = participantReactions[statement.statementId];

    if (previousReaction === reaction) {
      continue;
    }

    participantReactions[statement.statementId] = reaction;
    events.push({
      eventKind: "statement-reaction",
      eventId: `event-${sha256Hex(
        JSON.stringify({
          voteRoundId: round.voteRoundId,
          participantId,
          statementId: statement.statementId,
          reaction,
          createdAt
        })
      ).slice(0, 20)}`,
      createdAt,
      voteRoundId: round.voteRoundId,
      participantId,
      statementId: statement.statementId,
      reaction,
      ...(previousReaction === undefined ? {} : { previousReaction })
    });
  }

  round.state.reactions[participantId] = participantReactions;
  round.state.updatedAt = createdAt;
  return events;
}

function summarizeVoteRound(round: LoadedVoteRound, bank: StatementBank): VoteRoundSummary {
  const statements = round.statements.map((statement) => summarizeStatementVote(statement, round.state));
  const highConsensusStatementIds = statements
    .filter((statement) => statement.classification === "high-consensus")
    .map((statement) => statement.statementId);
  const highContentionStatementIds = statements
    .filter((statement) => statement.classification === "high-contention")
    .map((statement) => statement.statementId);
  const lowParticipationStatementIds = statements
    .filter((statement) => statement.classification === "low-participation")
    .map((statement) => statement.statementId);

  return {
    voteRoundId: round.voteRoundId,
    statementRunId: round.manifest.input.statementRunId,
    analysisRunId: bank.analysisRunId,
    createdAt: new Date().toISOString(),
    participantCount: round.state.participants.length,
    initialQuestions: summarizeInitialQuestions(round.state),
    statementCount: round.statements.length,
    statements,
    highConsensusStatementIds,
    highContentionStatementIds,
    lowParticipationStatementIds,
    bridgeCandidatePlaceholders:
      round.state.participants.length >= 8
        ? ["Participant-cluster bridge analysis is intentionally not implemented in this first pass."]
        : []
  };
}

function summarizeStatementVote(statement: Statement, state: ReactionState): VoteStatementSummary {
  const totals = {
    agree: 0,
    disagree: 0,
    pass: 0,
    total: 0
  };

  for (const participantId of state.participants) {
    const reaction = state.reactions[participantId]?.[statement.statementId];

    if (reaction === undefined) {
      continue;
    }

    totals[reaction] += 1;
    totals.total += 1;
  }

  const rates = {
    agree: totals.total === 0 ? 0 : totals.agree / totals.total,
    disagree: totals.total === 0 ? 0 : totals.disagree / totals.total,
    pass: totals.total === 0 ? 0 : totals.pass / totals.total
  };
  const classification = classifyStatementVote(totals, rates, state.participants.length);

  return {
    statementId: statement.statementId,
    statementText: statement.statementText,
    evidenceRefs: statement.evidenceRefs,
    totals,
    rates,
    classification
  };
}

function summarizeInitialQuestions(
  state: ReactionState
): VoteRoundSummary["initialQuestions"] {
  return state.initialQuestions.map((question) => {
    const totals = {
      yes: 0,
      no: 0,
      skip: 0,
      total: 0
    };

    for (const participantId of state.participants) {
      const response = state.initialQuestionResponses[participantId]?.[question.questionId];

      if (response === undefined) {
        continue;
      }

      totals[response] += 1;
      totals.total += 1;
    }

    return {
      questionId: question.questionId,
      questionText: question.questionText,
      totals,
      rates: {
        yes: totals.total === 0 ? 0 : totals.yes / totals.total,
        no: totals.total === 0 ? 0 : totals.no / totals.total,
        skip: totals.total === 0 ? 0 : totals.skip / totals.total
      }
    };
  });
}

function classifyStatementVote(
  totals: VoteStatementSummary["totals"],
  rates: VoteStatementSummary["rates"],
  participantCount: number
): VoteStatementSummary["classification"] {
  if (totals.total < Math.min(3, Math.max(1, participantCount))) {
    return "low-participation";
  }

  if (rates.agree >= 0.7 || rates.disagree >= 0.7) {
    return "high-consensus";
  }

  if (rates.agree >= 0.35 && rates.disagree >= 0.35) {
    return "high-contention";
  }

  return "mixed";
}

function renderVoteSummaryCsv(summary: VoteRoundSummary): string {
  const header = [
    "statement_id",
    "classification",
    "agree",
    "disagree",
    "pass",
    "total",
    "agree_rate",
    "disagree_rate",
    "pass_rate",
    "statement_text"
  ];
  const rows = summary.statements.map((statement) =>
    [
      statement.statementId,
      statement.classification,
      String(statement.totals.agree),
      String(statement.totals.disagree),
      String(statement.totals.pass),
      String(statement.totals.total),
      statement.rates.agree.toFixed(4),
      statement.rates.disagree.toFixed(4),
      statement.rates.pass.toFixed(4),
      statement.statementText
    ]
      .map(escapeCsvCell)
      .join(",")
  );

  return `${[header.join(","), ...rows].join("\n")}\n`;
}

function renderInitialQuestionSummaryCsv(summary: VoteRoundSummary): string {
  const header = [
    "question_id",
    "yes",
    "no",
    "skip",
    "total",
    "yes_rate",
    "no_rate",
    "skip_rate",
    "question_text"
  ];
  const rows = summary.initialQuestions.map((question) =>
    [
      question.questionId,
      String(question.totals.yes),
      String(question.totals.no),
      String(question.totals.skip),
      String(question.totals.total),
      question.rates.yes.toFixed(4),
      question.rates.no.toFixed(4),
      question.rates.skip.toFixed(4),
      question.questionText
    ]
      .map(escapeCsvCell)
      .join(",")
  );

  return `${[header.join(","), ...rows].join("\n")}\n`;
}

function escapeCsvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) {
    return value;
  }

  return `"${value.replaceAll('"', '""')}"`;
}

async function resolveInputPath(projectRoot: string, inputPath: string): Promise<string> {
  const absoluteInputPath = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(projectRoot, inputPath);

  if (await artifactExists(absoluteInputPath)) {
    return absoluteInputPath;
  }

  const cwdRelativePath = path.resolve(inputPath);

  if (await artifactExists(cwdRelativePath)) {
    return cwdRelativePath;
  }

  return absoluteInputPath;
}

function parseReactionValue(value: string | null): ReactionValue | null {
  if (value !== null && REACTION_VALUES.includes(value as ReactionValue)) {
    return value as ReactionValue;
  }

  return null;
}

function parseInitialQuestionResponseValue(
  value: string | null
): InitialQuestionResponseValue | null {
  if (
    value !== null &&
    INITIAL_QUESTION_RESPONSE_VALUES.includes(value as InitialQuestionResponseValue)
  ) {
    return value as InitialQuestionResponseValue;
  }

  return null;
}

function deterministicSyntheticReaction(
  voteRoundId: string,
  participantId: string,
  statementId: string
): ReactionValue {
  const bucket = Number.parseInt(
    sha256Hex(`${voteRoundId}:${participantId}:${statementId}`).slice(0, 2),
    16
  ) % 10;

  if (bucket <= 4) {
    return "agree";
  }

  if (bucket <= 7) {
    return "disagree";
  }

  return "pass";
}

function deterministicSyntheticInitialQuestionResponse(
  voteRoundId: string,
  participantId: string,
  questionId: string
): InitialQuestionResponseValue {
  const bucket = Number.parseInt(
    sha256Hex(`${voteRoundId}:${participantId}:${questionId}:initial`).slice(0, 2),
    16
  ) % 10;

  if (bucket <= 4) {
    return "yes";
  }

  if (bucket <= 8) {
    return "no";
  }

  return "skip";
}

function hasAnsweredAllInitialQuestions(state: ReactionState, participantId: string): boolean {
  const responses = state.initialQuestionResponses[participantId] ?? {};
  return state.initialQuestions.every((question) => responses[question.questionId] !== undefined);
}

function normalizeReactionState(
  state: ReactionState,
  initialQuestions: VoteInitialQuestion[]
): ReactionState {
  return {
    ...state,
    initialQuestions: state.initialQuestions ?? initialQuestions,
    initialQuestionResponses: state.initialQuestionResponses ?? {}
  };
}

function normalizeParticipantId(value: string | null): string {
  const normalized = (value ?? "").trim().replace(/\s+/g, "-").slice(0, 80);
  return normalized.length === 0 ? "local-participant" : normalized;
}

async function readRequestForm(request: AsyncIterable<Buffer | string>): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function renderVoteRoundPage(round: LoadedVoteRound, participantId: string): string {
  const participantReactions = round.state.reactions[participantId] ?? {};
  const initialQuestionResponses = round.state.initialQuestionResponses[participantId] ?? {};
  const initialQuestionsComplete = hasAnsweredAllInitialQuestions(round.state, participantId);
  const nextInitialQuestion = round.state.initialQuestions.find(
    (question) => initialQuestionResponses[question.questionId] === undefined
  );
  const nextInitialQuestionIndex =
    nextInitialQuestion === undefined
      ? 0
      : round.state.initialQuestions.findIndex(
          (question) => question.questionId === nextInitialQuestion.questionId
        ) + 1;
  const answeredStatementCount = round.statements.filter(
    (statement) => participantReactions[statement.statementId] !== undefined
  ).length;
  const nextStatementEntry = initialQuestionsComplete
    ? round.statements
        .map((statement, index) => ({ statement, index }))
        .find((entry) => participantReactions[entry.statement.statementId] === undefined)
    : undefined;
  const actionLabel =
    nextInitialQuestion !== undefined
      ? "Continue"
      : nextStatementEntry !== undefined
        ? "Save answer"
        : null;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Broadly Vote Sandbox</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 16px/1.5 Inter, system-ui, sans-serif;
        color: #18202f;
        background: #f6f8fb;
      }
      main {
        max-width: 920px;
        margin: 0 auto;
        padding: 28px 18px 56px;
      }
      header, article {
        background: #fff;
        border: 1px solid #d9e0ea;
        border-radius: 8px;
        padding: 18px;
        margin-bottom: 14px;
      }
      .topline {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      h1, h2 { margin: 0 0 8px; }
      .meta { color: #5e6878; margin: 0; }
      .participant-badge {
        color: #5e6878;
        font-size: 12px;
        line-height: 1.2;
        text-align: right;
        white-space: nowrap;
      }
      .participant-badge strong {
        display: block;
        color: #18202f;
        font-size: 13px;
        font-weight: 700;
        margin-top: 2px;
      }
      .intro-section {
        margin: 18px 0;
      }
      .choices {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }
      label.choice {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid #c7d1df;
        border-radius: 999px;
        padding: 7px 10px;
        background: #f9fbfd;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 6px;
        padding: 10px 14px;
        font: 700 15px/1 Inter, system-ui, sans-serif;
        color: #fff;
        background: #145688;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="topline">
          <div>
            <h1>Broadly Vote Sandbox</h1>
            <p class="meta">Local reference round ${escapeHtml(round.voteRoundId)}. This is not production civic infrastructure.</p>
          </div>
          <p class="participant-badge">Participant<strong>${escapeHtml(participantId)}</strong></p>
        </div>
      </header>
      <form method="post" action="/vote">
        <input type="hidden" name="participantId" value="${escapeHtmlAttribute(participantId)}" />
        ${
          nextInitialQuestion === undefined
            ? ""
            : `<section class="intro-section">
                <p class="meta">Initial questions are asked before statement voting.</p>
                ${renderInitialQuestionCard(nextInitialQuestion, nextInitialQuestionIndex)}
              </section>`
        }
        ${
          nextInitialQuestion !== undefined
            ? `<article>
                <p class="meta">Answer yes, no, or skip for each initial question to continue to statement voting.</p>
              </article>`
            : nextStatementEntry !== undefined
              ? renderVoteStatementCard(
                  nextStatementEntry.statement,
                  nextStatementEntry.index + 1,
                  round.statements.length
                )
              : `<article>
                  <h2>All done.</h2>
                  <p class="meta">You answered ${answeredStatementCount} statement(s) in this local round.</p>
                </article>`
        }
        ${actionLabel === null ? "" : `<button type="submit">${actionLabel}</button>`}
      </form>
    </main>
  </body>
</html>`;
}

function renderInitialQuestionCard(
  question: VoteInitialQuestion,
  index: number
): string {
  return `<article>
    <p class="meta">Initial question ${index}</p>
    <h2>${escapeHtml(question.questionText)}</h2>
    <div class="choices">
      ${INITIAL_QUESTION_RESPONSE_VALUES.map(
        (response) => `<label class="choice">
          <input type="radio" name="initial-question:${escapeHtmlAttribute(question.questionId)}" value="${response}" required />
          <span>${response}</span>
        </label>`
      ).join("")}
    </div>
  </article>`;
}

function renderVoteStatementCard(
  statement: Statement,
  index: number,
  total: number
): string {
  return `<article>
    <p class="meta">Statement ${index} of ${total}</p>
    <h2>${escapeHtml(statement.statementText)}</h2>
    <div class="choices">
      ${REACTION_VALUES.map(
        (reaction) => `<label class="choice">
          <input type="radio" name="reaction:${escapeHtmlAttribute(statement.statementId)}" value="${reaction}" required />
          <span>${reaction}</span>
        </label>`
      ).join("")}
    </div>
  </article>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}
