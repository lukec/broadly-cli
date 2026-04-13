import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { sha256Hex } from "@broadly/core";

const delimiterCandidates = [",", "\t", ";", "|"] as const;
const likelyIdColumnNames = new Set([
  "id",
  "record id",
  "response id",
  "submission id",
  "comment id",
  "source id"
]);

export interface NormalizedCommentRecord {
  sourceId: string;
  contentSha256: string;
  contentText: string;
  rawRow: Record<string, string>;
  provenance: {
    importPath: string;
    importEncoding: string;
    delimiter: string;
    sourceRowNumber: number;
    externalId?: string;
  };
}

export interface AddTabularDataSourceOptions {
  projectRoot: string;
  datasetPath: string;
}

export interface AddTabularDataSourceResult {
  datasetPath: string;
  datasetFormat: "csv" | "tsv";
  encoding: string;
  delimiter: string;
  idColumn?: string;
  rowCount: number;
  filesWritten: number;
  normalizedDir: string;
  headers: string[];
}

export async function addTabularDataSource(
  options: AddTabularDataSourceOptions
): Promise<AddTabularDataSourceResult> {
  const absoluteDatasetPath = path.resolve(options.datasetPath);
  const normalizedDir = path.join(path.resolve(options.projectRoot), "data", "normalized");
  const sourceBuffer = await readFile(absoluteDatasetPath);
  const decodedSource = decodeSourceText(sourceBuffer);
  const parsedDataset = parseTabularText(decodedSource.text);

  if (parsedDataset.rows.length === 0) {
    throw new Error(`No rows found in dataset: ${absoluteDatasetPath}`);
  }

  const [headerRow, ...dataRows] = parsedDataset.rows;

  if (headerRow === undefined || headerRow.length === 0) {
    throw new Error(`Could not read a header row from dataset: ${absoluteDatasetPath}`);
  }

  const headers = dedupeHeaders(headerRow);
  const idColumn = detectIdColumn(headers);
  const createdAt = new Date().toISOString();

  await mkdir(normalizedDir, { recursive: true });

  let filesWritten = 0;
  let rowCount = 0;

  for (const [index, row] of dataRows.entries()) {
    const rawRow = buildRawRow(headers, row);

    if (isEmptyRow(rawRow)) {
      continue;
    }

    const contentText = renderContentText(headers, rawRow);
    const contentSha256 = sha256Hex(contentText);
    const record: NormalizedCommentRecord = {
      sourceId: contentSha256,
      contentSha256,
      contentText,
      rawRow,
      provenance: {
        importPath: absoluteDatasetPath,
        importEncoding: decodedSource.encoding,
        delimiter: parsedDataset.delimiter,
        sourceRowNumber: index + 2,
        ...(idColumn === undefined || rawRow[idColumn] === undefined || rawRow[idColumn].length === 0
          ? {}
          : { externalId: rawRow[idColumn] })
      }
    };

    const outputPath = path.join(normalizedDir, `${contentSha256}.json`);

    await writeFile(
      outputPath,
      JSON.stringify(
        {
          createdAt,
          ...record
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    filesWritten += 1;
    rowCount += 1;
  }

  return {
    datasetPath: absoluteDatasetPath,
    datasetFormat: parsedDataset.delimiter === "\t" ? "tsv" : "csv",
    encoding: decodedSource.encoding,
    delimiter: parsedDataset.delimiter,
    ...(idColumn === undefined ? {} : { idColumn }),
    rowCount,
    filesWritten,
    normalizedDir,
    headers
  };
}

function decodeSourceText(sourceBuffer: Buffer): { encoding: string; text: string } {
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(sourceBuffer);
    return {
      encoding: "utf-8",
      text: utf8
    };
  } catch {
    return {
      encoding: "latin1",
      text: sourceBuffer.toString("latin1")
    };
  }
}

function parseTabularText(text: string): { delimiter: string; rows: string[][] } {
  let bestDelimiter = ",";
  let bestRows: string[][] = [];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const delimiter of delimiterCandidates) {
    const rows = parseDelimitedRows(text, delimiter).filter((row) => !isBlankParsedRow(row));

    if (rows.length === 0) {
      continue;
    }

    const score = scoreParsedRows(rows);

    if (score > bestScore) {
      bestDelimiter = delimiter;
      bestRows = rows;
      bestScore = score;
    }
  }

  if (bestRows.length === 0) {
    throw new Error("Could not detect a supported delimited format.");
  }

  return {
    delimiter: bestDelimiter,
    rows: bestRows
  };
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === undefined) {
      continue;
    }

    if (inQuotes) {
      if (character === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }

      continue;
    }

    if (character === "\"") {
      inQuotes = true;
      continue;
    }

    if (character === delimiter) {
      row.push(field);
      field = "";
      continue;
    }

    if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (character === "\r") {
      if (text[index + 1] === "\n") {
        continue;
      }

      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += character;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function scoreParsedRows(rows: string[][]): number {
  const sampleRows = rows.slice(0, 25);
  const headerWidth = sampleRows[0]?.length ?? 0;

  if (headerWidth <= 1) {
    return Number.NEGATIVE_INFINITY;
  }

  let consistentRows = 0;

  for (const row of sampleRows.slice(1)) {
    if (row.length === headerWidth) {
      consistentRows += 1;
    }
  }

  return headerWidth * 100 + consistentRows;
}

function dedupeHeaders(headers: string[]): string[] {
  const seenHeaders = new Map<string, number>();

  return headers.map((header, index) => {
    const baseHeader = normalizeHeader(header, index);
    const existingCount = seenHeaders.get(baseHeader) ?? 0;
    const nextCount = existingCount + 1;

    seenHeaders.set(baseHeader, nextCount);

    return nextCount === 1 ? baseHeader : `${baseHeader} (${nextCount})`;
  });
}

function normalizeHeader(header: string, index: number): string {
  const normalizedHeader = normalizeCellValue(header).replace(/\s+/g, " ").trim();

  return normalizedHeader.length === 0 ? `Column ${index + 1}` : normalizedHeader;
}

function buildRawRow(headers: string[], row: string[]): Record<string, string> {
  const rawRow: Record<string, string> = {};

  for (const [index, header] of headers.entries()) {
    rawRow[header] = normalizeCellValue(row[index] ?? "");
  }

  return rawRow;
}

function renderContentText(headers: string[], rawRow: Record<string, string>): string {
  const lines: string[] = [];

  for (const header of headers) {
    const value = rawRow[header];

    if (value === undefined || value.length === 0) {
      continue;
    }

    lines.push(value.includes("\n") ? `${header}:\n${value}` : `${header}: ${value}`);
  }

  return lines.join("\n");
}

function normalizeCellValue(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function isBlankParsedRow(row: string[]): boolean {
  return row.every((value) => normalizeCellValue(value).length === 0);
}

function isEmptyRow(rawRow: Record<string, string>): boolean {
  return Object.values(rawRow).every((value) => value.length === 0);
}

function detectIdColumn(headers: string[]): string | undefined {
  return headers.find((header) => likelyIdColumnNames.has(header.toLowerCase()));
}
