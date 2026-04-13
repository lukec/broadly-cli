import YAML from "yaml";
import { z } from "zod";

const datasetFormatValues = ["auto", "csv", "tsv", "xlsx", "json", "jsonl"] as const;
const reductionMethodValues = ["umap", "pca", "tsne"] as const;
const synthesisModeValues = ["balanced", "consensus", "dissent"] as const;

export const projectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    name: z.string().min(1),
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
    description: z.string().default(""),
    goals: z.array(z.string().min(1)).default([])
  }),
  dataset: z.object({
    path: z.string().min(1),
    format: z.enum(datasetFormatValues).default("auto"),
    encoding: z.string().min(1).optional(),
    delimiter: z.string().min(1).optional(),
    idColumn: z.string().min(1).optional()
  }),
  guidingQuestions: z.array(z.string().min(1)).min(1),
  analysis: z.object({
    extractionModel: z.string().min(1),
    embeddingModel: z.string().min(1),
    synthesisModes: z.array(z.enum(synthesisModeValues)).min(1),
    clusterCounts: z.array(z.number().int().positive()).min(1),
    reduction: z.object({
      method: z.enum(reductionMethodValues),
      dimensions: z.literal(2)
    }),
    maxPerspectives: z.number().int().positive().default(3)
  }),
  output: z.object({
    reportDir: z.string().min(1).default("reports"),
    primaryPerspective: z.enum(synthesisModeValues).default("balanced")
  })
});

export type BroadlyProjectConfig = z.infer<typeof projectConfigSchema>;

export function parseProjectConfig(source: string): BroadlyProjectConfig {
  const parsed = YAML.parse(source);
  return projectConfigSchema.parse(parsed);
}

export function serializeProjectConfig(config: BroadlyProjectConfig): string {
  return [
    "# Broadly project configuration",
    "# Use `broadly ingest <file>` to register a dataset and write normalized row artifacts.",
    "# Then fill in guiding questions and model IDs before running analysis.",
    "",
    YAML.stringify(config)
  ].join("\n");
}

export interface StarterProjectConfigOptions {
  name: string;
  description?: string;
  goals?: string[];
}

export function createStarterProjectConfig(
  options: StarterProjectConfigOptions
): BroadlyProjectConfig {
  const slug = slugifyProjectName(options.name);

  return {
    schemaVersion: 1,
    project: {
      name: options.name,
      slug,
      description: options.description ?? "Local-first Broadly analysis project.",
      goals: options.goals ?? []
    },
    dataset: {
      path: "./data/source.csv",
      format: "auto"
    },
    guidingQuestions: [
      "What are the dominant themes in this corpus?",
      "Where do the strongest points of agreement and disagreement appear?",
      "What concerns would matter most to a municipal engagement lead?"
    ],
    analysis: {
      extractionModel: "bedrock-text-model-id",
      embeddingModel: "bedrock-embedding-model-id",
      synthesisModes: ["balanced", "consensus", "dissent"],
      clusterCounts: [12, 20, 32],
      reduction: {
        method: "umap",
        dimensions: 2
      },
      maxPerspectives: 3
    },
    output: {
      reportDir: "reports",
      primaryPerspective: "balanced"
    }
  };
}

export function slugifyProjectName(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
