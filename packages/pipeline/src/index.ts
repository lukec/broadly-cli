import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256Hex } from "@broadly/core";
import type { NormalizedCommentRecord } from "@broadly/ingest";

export type SynthesisMode = "balanced" | "consensus" | "dissent";
export type OpinionExtractionMethod = "whole-record-pass-through";

export interface PerspectiveCandidate {
  id: string;
  title: string;
  clusterCount: number;
  reductionMethod: string;
  synthesisMode: SynthesisMode;
  notes: string[];
}

export interface PerspectiveScorecard {
  perspectiveId: string;
  relevanceToGuidingQuestions: number;
  evidenceCoverage: number;
  narrativeLegibility: number;
  dissentVisibility: number;
  novelty: number;
}

export interface OpinionUnitRecord {
  opinionId: string;
  sourceId: string;
  sourceContentSha256: string;
  opinionText: string;
  excerpt: string;
  createdAt: string;
  extractionMethod: OpinionExtractionMethod;
  provenance: {
    normalizedRecordPath: string;
    sourceImportPath: string;
    sourceFileSha256: string;
    sourceRowNumber: number;
    externalId?: string;
  };
}

export interface OpinionExtractionManifest {
  createdAt: string;
  extractionMethod: OpinionExtractionMethod;
  input: {
    normalizedDir: string;
    recordsRead: number;
  };
  output: {
    opinionsDir: string;
    opinionsWritten: number;
    manifestPath: string;
  };
}

export interface ExtractOpinionUnitsOptions {
  normalizedDir: string;
  outputDir: string;
}

export interface ExtractOpinionUnitsResult {
  normalizedDir: string;
  outputDir: string;
  manifestPath: string;
  extractionMethod: OpinionExtractionMethod;
  recordsRead: number;
  opinionsWritten: number;
}

export async function extractOpinionUnits(
  options: ExtractOpinionUnitsOptions
): Promise<ExtractOpinionUnitsResult> {
  const normalizedDir = path.resolve(options.normalizedDir);
  const outputDir = path.resolve(options.outputDir);
  const manifestPath = path.join(outputDir, "extraction-manifest.json");
  const createdAt = new Date().toISOString();
  const extractionMethod: OpinionExtractionMethod = "whole-record-pass-through";
  const normalizedRecordPaths = await listNormalizedRecordPaths(normalizedDir);

  await mkdir(outputDir, { recursive: true });

  let opinionsWritten = 0;

  for (const normalizedRecordPath of normalizedRecordPaths) {
    const normalizedRecord = await readNormalizedRecord(normalizedRecordPath);
    const opinionRecord = buildOpinionUnitRecord({
      createdAt,
      extractionMethod,
      normalizedRecord,
      normalizedRecordPath
    });
    const outputPath = path.join(outputDir, `${opinionRecord.opinionId}.json`);

    await writeFile(outputPath, `${JSON.stringify(opinionRecord, null, 2)}\n`, "utf8");
    opinionsWritten += 1;
  }

  const manifest: OpinionExtractionManifest = {
    createdAt,
    extractionMethod,
    input: {
      normalizedDir,
      recordsRead: normalizedRecordPaths.length
    },
    output: {
      opinionsDir: outputDir,
      opinionsWritten,
      manifestPath
    }
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    normalizedDir,
    outputDir,
    manifestPath,
    extractionMethod,
    recordsRead: normalizedRecordPaths.length,
    opinionsWritten
  };
}

interface BuildOpinionUnitRecordOptions {
  createdAt: string;
  extractionMethod: OpinionExtractionMethod;
  normalizedRecord: NormalizedCommentRecord;
  normalizedRecordPath: string;
}

function buildOpinionUnitRecord(
  options: BuildOpinionUnitRecordOptions
): OpinionUnitRecord {
  const normalizedRecord = options.normalizedRecord;
  const opinionText = normalizedRecord.contentText;
  const opinionPayload = JSON.stringify({
    extractionMethod: options.extractionMethod,
    opinionText,
    sourceId: normalizedRecord.sourceId
  });
  const opinionId = sha256Hex(opinionPayload);

  return {
    opinionId,
    sourceId: normalizedRecord.sourceId,
    sourceContentSha256: normalizedRecord.contentSha256,
    opinionText,
    excerpt: createExcerpt(opinionText),
    createdAt: options.createdAt,
    extractionMethod: options.extractionMethod,
    provenance: {
      normalizedRecordPath: options.normalizedRecordPath,
      sourceImportPath: normalizedRecord.provenance.importPath,
      sourceFileSha256: normalizedRecord.provenance.sourceFileSha256,
      sourceRowNumber: normalizedRecord.provenance.sourceRowNumber,
      ...(normalizedRecord.provenance.externalId === undefined
        ? {}
        : { externalId: normalizedRecord.provenance.externalId })
    }
  };
}

async function listNormalizedRecordPaths(normalizedDir: string): Promise<string[]> {
  const entries = await readdir(normalizedDir, { withFileTypes: true });

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        entry.name !== "ingest-manifest.json"
    )
    .map((entry) => path.join(normalizedDir, entry.name))
    .sort();
}

async function readNormalizedRecord(
  normalizedRecordPath: string
): Promise<NormalizedCommentRecord> {
  const source = await readFile(normalizedRecordPath, "utf8");

  return JSON.parse(source) as NormalizedCommentRecord;
}

function createExcerpt(opinionText: string): string {
  const normalized = opinionText.replace(/\s+/g, " ").trim();

  if (normalized.length <= 280) {
    return normalized;
  }

  return `${normalized.slice(0, 277)}...`;
}
