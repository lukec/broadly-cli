import YAML from "yaml";
import { z } from "zod";

const datasetFormatValues = ["auto", "csv", "tsv", "xlsx", "json", "jsonl"] as const;
const reductionMethodValues = ["umap", "pacmap"] as const;
const analysisViewModeValues = ["balanced", "dissent"] as const;
const mergeStrategyValues = ["semantic"] as const;
const modelProviderValues = ["bedrock", "google-cloud", "openai"] as const;

const opinionExtractionConfigSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  model: z.string().min(1),
  prompt: z.string().min(1).default("prompts/opinion-extraction.md")
});

const analysisViewConfigSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  sourceExtraction: z.string().min(1),
  embeddingModel: z.string().min(1),
  analysisModel: z.string().min(1).optional(),
  prompts: z
    .object({
      clusterLabeling: z.string().min(1).default("prompts/analysis-cluster-labeling.md"),
      semanticMerge: z.string().min(1).default("prompts/analysis-semantic-merge.md"),
      viewSummary: z.string().min(1).default("prompts/analysis-perspective-summary.md")
    })
    .default({
      clusterLabeling: "prompts/analysis-cluster-labeling.md",
      semanticMerge: "prompts/analysis-semantic-merge.md",
      viewSummary: "prompts/analysis-perspective-summary.md"
    }),
  reduction: z.object({
    method: z.enum(reductionMethodValues),
    dimensions: z.literal(2).default(2)
  }),
  clustering: z.object({
    count: z.number().int().positive(),
    mergeStrategy: z.enum(mergeStrategyValues).default("semantic")
  }),
  mode: z.enum(analysisViewModeValues)
});

export const projectConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    project: z.object({
      name: z.string().min(1),
      slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
      description: z.string().default(""),
      goals: z.array(z.string().min(1)).default([])
    }),
    models: z
      .array(
        z.object({
          name: z.string().min(1),
          provider: z.enum(modelProviderValues),
          modelId: z.string().min(1),
          region: z.string().min(1)
        })
      )
      .default([]),
    dataset: z.object({
      path: z.string().min(1),
      format: z.enum(datasetFormatValues).default("auto"),
      encoding: z.string().min(1).optional(),
      delimiter: z.string().min(1).optional(),
      idColumn: z.string().min(1).optional(),
      allowFields: z.array(z.string().min(1)).min(1).optional()
    }),
    review_model: z.string().min(1).optional(),
    qa_model: z.string().min(1).optional(),
    questions: z.array(z.string().min(1)).min(1),
    opinionExtractions: z.array(opinionExtractionConfigSchema).min(1),
    analysisViews: z.array(analysisViewConfigSchema).min(1),
    report: z.object({
      reportDir: z.string().min(1).default("reports"),
      primaryView: z.string().min(1)
    })
  })
  .superRefine((value, context) => {
    const modelNames = new Set(value.models.map((model) => model.name));
    const extractionNames = new Set<string>();
    const analysisViewNames = new Set<string>();

    for (const [index, extraction] of value.opinionExtractions.entries()) {
      if (extractionNames.has(extraction.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["opinionExtractions", index, "name"],
          message: `Duplicate opinion extraction name '${extraction.name}'.`
        });
      } else {
        extractionNames.add(extraction.name);
      }

      if (modelNames.has(extraction.model) === false) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["opinionExtractions", index, "model"],
          message: `Opinion extraction '${extraction.name}' references unknown model '${extraction.model}'.`
        });
      }
    }

    for (const [index, view] of value.analysisViews.entries()) {
      if (analysisViewNames.has(view.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["analysisViews", index, "name"],
          message: `Duplicate analysis view name '${view.name}'.`
        });
      } else {
        analysisViewNames.add(view.name);
      }

      if (extractionNames.has(view.sourceExtraction) === false) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["analysisViews", index, "sourceExtraction"],
          message: `Analysis view '${view.name}' references unknown opinion extraction '${view.sourceExtraction}'.`
        });
      }

      if (modelNames.has(view.embeddingModel) === false) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["analysisViews", index, "embeddingModel"],
          message: `Analysis view '${view.name}' references unknown embedding model '${view.embeddingModel}'.`
        });
      }

      if (view.analysisModel !== undefined && modelNames.has(view.analysisModel) === false) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["analysisViews", index, "analysisModel"],
          message: `Analysis view '${view.name}' references unknown analysis model '${view.analysisModel}'.`
        });
      }
    }

    if (analysisViewNames.has(value.report.primaryView) === false) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["report", "primaryView"],
        message: `Report primaryView '${value.report.primaryView}' does not match any configured analysis view.`
      });
    }
  });

export type BroadlyProjectConfig = z.infer<typeof projectConfigSchema>;
export type OpinionExtractionConfig = BroadlyProjectConfig["opinionExtractions"][number];
export type AnalysisViewConfig = BroadlyProjectConfig["analysisViews"][number];
export type RegisteredModelConfig = BroadlyProjectConfig["models"][number];

export function parseProjectConfig(source: string): BroadlyProjectConfig {
  const parsed = YAML.parse(source);
  return projectConfigSchema.parse(parsed);
}

export function serializeProjectConfig(config: BroadlyProjectConfig): string {
  return [
    "# Broadly project configuration",
    "# Use `broadly ingest <file>` to register a dataset and write normalized row artifacts.",
    "# Use `broadly models add` to register model aliases available to this project.",
    "# Opinion extractions define how comments become opinion artifacts.",
    "# Analysis views define the named map/report variants Broadly should build.",
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
    models: [],
    dataset: {
      path: "./data/source.csv",
      format: "auto"
    },
    review_model: "my-frontier-text-model",
    qa_model: "my-frontier-text-model",
    questions: [
      "What are the dominant themes in this corpus?",
      "Where do the strongest points of agreement and disagreement appear?",
      "What concerns would matter most to a municipal engagement lead?"
    ],
    opinionExtractions: [
      {
        name: "cheap-opinions",
        title: "Cheaper Opinion Extraction",
        model: "my-cheap-text-model",
        prompt: "prompts/opinion-extraction.md"
      },
      {
        name: "frontier-opinions",
        title: "Frontier Opinion Extraction",
        model: "my-frontier-text-model",
        prompt: "prompts/opinion-extraction.md"
      }
    ],
    analysisViews: [
      {
        name: "balanced-umap-cheap",
        title: "Balanced UMAP Cheap View",
        sourceExtraction: "cheap-opinions",
        embeddingModel: "my-embedding-model",
        analysisModel: "my-cheap-text-model",
        prompts: {
          clusterLabeling: "prompts/analysis-cluster-labeling.md",
          semanticMerge: "prompts/analysis-semantic-merge.md",
          viewSummary: "prompts/analysis-perspective-summary.md"
        },
        reduction: {
          method: "umap",
          dimensions: 2
        },
        clustering: {
          count: 12,
          mergeStrategy: "semantic"
        },
        mode: "balanced"
      },
      {
        name: "balanced-umap-frontier",
        title: "Balanced UMAP Frontier View",
        sourceExtraction: "frontier-opinions",
        embeddingModel: "my-embedding-model",
        analysisModel: "my-frontier-text-model",
        prompts: {
          clusterLabeling: "prompts/analysis-cluster-labeling.md",
          semanticMerge: "prompts/analysis-semantic-merge.md",
          viewSummary: "prompts/analysis-perspective-summary.md"
        },
        reduction: {
          method: "umap",
          dimensions: 2
        },
        clustering: {
          count: 12,
          mergeStrategy: "semantic"
        },
        mode: "balanced"
      },
      {
        name: "balanced-pacmap-frontier",
        title: "Balanced PaCMAP Frontier Comparison",
        sourceExtraction: "frontier-opinions",
        embeddingModel: "my-embedding-model",
        analysisModel: "my-frontier-text-model",
        prompts: {
          clusterLabeling: "prompts/analysis-cluster-labeling.md",
          semanticMerge: "prompts/analysis-semantic-merge.md",
          viewSummary: "prompts/analysis-perspective-summary.md"
        },
        reduction: {
          method: "pacmap",
          dimensions: 2
        },
        clustering: {
          count: 12,
          mergeStrategy: "semantic"
        },
        mode: "balanced"
      }
    ],
    report: {
      reportDir: "reports",
      primaryView: "balanced-umap-frontier"
    }
  };
}

export function findOpinionExtractionConfig(
  config: BroadlyProjectConfig,
  name: string
): OpinionExtractionConfig | undefined {
  return config.opinionExtractions.find((item) => item.name === name);
}

export function getOpinionExtractionConfig(
  config: BroadlyProjectConfig,
  name: string
): OpinionExtractionConfig {
  const extraction = findOpinionExtractionConfig(config, name);

  if (extraction === undefined) {
    throw new Error(`No opinion extraction named '${name}' is configured in broadly.yaml.`);
  }

  return extraction;
}

export function findAnalysisViewConfig(
  config: BroadlyProjectConfig,
  name: string
): AnalysisViewConfig | undefined {
  return config.analysisViews.find((item) => item.name === name);
}

export function getAnalysisViewConfig(
  config: BroadlyProjectConfig,
  name: string
): AnalysisViewConfig {
  const view = findAnalysisViewConfig(config, name);

  if (view === undefined) {
    throw new Error(`No analysis view named '${name}' is configured in broadly.yaml.`);
  }

  return view;
}

export function slugifyProjectName(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
