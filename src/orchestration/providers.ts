import { GoogleGenAI, Type } from "@google/genai";
import type { Phase } from "../../shared/types.js";
import type { PromptConfig, RolePromptConfig } from "./promptRegistry.js";

export interface IdeaOutput {
  title?: string;
  text: string;
  rationale?: string;
}

export interface CritiqueOutput {
  targetIds: string[];
  text: string;
  riskLevel?: string;
}

export interface DecisionOutput {
  options: { title: string; summary: string }[];
  recommendation: string;
  rationale: string;
  risks: string[];
  nextSteps: string[];
}

export interface ImproveStatementOutput {
  clarifiedProblemStatement: string;
  contextAndConstraints: string;
  successCriteria: string;
  scopeBoundaries: string;
  brainstormingLaunchQuestion: string;
}

export interface ClusterOutput {
  id: string;
  label: string;
  summary: string;
  rationale: string;
  memberIdeaIds: string[];
  bridgeIdeaIds: string[];
  confidence: number;
}

export interface ClusteringOutput {
  clusters: ClusterOutput[];
  unclusteredIdeaIds: string[];
}

export interface ProblemFramingContext {
  clarifiedProblemStatement: string;
  contextAndConstraints: string;
  successCriteria: string;
  scopeBoundaries: string;
  brainstormingLaunchQuestion: string;
}

export interface LlmProvider {
  improveProblemStatement(input: { prompt: string; rawStatement: string }): Promise<ImproveStatementOutput>;
  generateIdeas(input: {
    problemStatement: string;
    role: string;
    roleId: string;
    framingContext?: ProblemFramingContext;
    promptConfig: PromptConfig;
    roleDefinition: RolePromptConfig;
  }): Promise<IdeaOutput[]>;
  generateCritiques(input: {
    problemStatement: string;
    clusters: { id: string; label: string; ideas: string[] }[];
    framingContext?: ProblemFramingContext;
  }): Promise<CritiqueOutput[]>;
  generateClusters(input: {
    problemStatement: string;
    ideas: { id: string; title?: string; text: string; rationale?: string; sourceRole?: string }[];
    framingContext?: ProblemFramingContext;
    promptConfig: PromptConfig;
  }): Promise<ClusteringOutput>;
  generateDecision(input: {
    problemStatement: string;
    clusters: { id: string; label: string }[];
    critiques: string[];
    framingContext?: ProblemFramingContext;
  }): Promise<DecisionOutput>;
  embedTexts(input: string[]): Promise<number[][]>;
}

function extractMinimumIdeaCount(template: string) {
  const rangeMatch = template.match(
    /Generate\s+(\d+)\s*(?:to|-)\s*(\d+)\s+(?:concise\s+)?ideas(?:\s+per\s+(?:assigned\s+)?role)?/i
  );
  if (rangeMatch) {
    return Number(rangeMatch[1]);
  }

  const exactMatch = template.match(/Generate\s+(\d+)\s+(?:concise\s+)?ideas(?:\s+per\s+(?:assigned\s+)?role)?/i);
  if (exactMatch) {
    return Number(exactMatch[1]);
  }

  return 3;
}

function buildDivergePrompt(input: {
  problemStatement: string;
  role: string;
  roleId: string;
  framingContext?: ProblemFramingContext;
  promptConfig: PromptConfig;
  roleDefinition: RolePromptConfig;
}) {
  const framingBlock = input.framingContext
    ? `\nProblem framing:\n${JSON.stringify(input.framingContext, null, 2)}`
    : "";

  return [
    input.roleDefinition.systemPrompt,
    "",
    input.promptConfig.template.trim(),
    "",
    `Role ID: ${input.roleId}`,
    `Role Label: ${input.role}`,
    `Problem statement: ${input.problemStatement}`,
    framingBlock
  ]
    .filter(Boolean)
    .join("\n");
}

function buildClusterPrompt(input: {
  problemStatement: string;
  ideas: { id: string; title?: string; text: string; rationale?: string; sourceRole?: string }[];
  framingContext?: ProblemFramingContext;
  promptConfig: PromptConfig;
}) {
  const framingBlock = input.framingContext
    ? `\nProblem framing:\n${JSON.stringify(input.framingContext, null, 2)}`
    : "";

  return [
    input.promptConfig.template.trim(),
    "",
    `Problem statement: ${input.problemStatement}`,
    "Ideas:",
    JSON.stringify(input.ideas, null, 2),
    framingBlock
  ]
    .filter(Boolean)
    .join("\n");
}

const fakeClusterStopWords = new Set([
  "a",
  "an",
  "and",
  "for",
  "how",
  "into",
  "the",
  "this",
  "that",
  "with",
  "from",
  "their",
  "your",
  "idea",
  "build",
  "create"
]);

function tokenizeClusterText(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !fakeClusterStopWords.has(token));
}

function summarizeFakeClusterLabel(
  ideas: { id: string; title?: string; text: string; rationale?: string; sourceRole?: string }[]
) {
  const frequency = new Map<string, number>();

  for (const idea of ideas) {
    for (const token of new Set(tokenizeClusterText(`${idea.title ?? ""} ${idea.text}`))) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }

  const topTokens = [...frequency.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([token]) => token[0].toUpperCase() + token.slice(1));

  if (topTokens.length > 0) {
    return topTokens.join(" ");
  }

  return (ideas[0]?.title ?? ideas[0]?.text ?? "Standalone Idea").split(/\s+/).slice(0, 3).join(" ");
}

function fakeIdeasOverlap(
  left: { id: string; title?: string; text: string; rationale?: string; sourceRole?: string },
  right: { id: string; title?: string; text: string; rationale?: string; sourceRole?: string }
) {
  const leftTokens = new Set(tokenizeClusterText(`${left.title ?? ""} ${left.text}`));
  const rightTokens = new Set(tokenizeClusterText(`${right.title ?? ""} ${right.text}`));

  for (const token of leftTokens) {
    if (rightTokens.has(token)) return true;
  }

  return false;
}

export class FakeLlmProvider implements LlmProvider {
  async improveProblemStatement(input: { prompt: string; rawStatement: string }): Promise<ImproveStatementOutput> {
    const normalized = input.rawStatement.trim();
    return {
      clarifiedProblemStatement: normalized.endsWith(".") ? normalized : `${normalized}.`,
      contextAndConstraints:
        "Assumption: the original statement is incomplete, so missing context should be confirmed before running the brainstorm.",
      successCriteria: "A useful output should be specific, actionable, and aligned on what success looks like.",
      scopeBoundaries: "In scope: framing the problem clearly. Out of scope: choosing the final solution before ideation.",
      brainstormingLaunchQuestion: `How might we address this challenge effectively: ${normalized}?`
    };
  }

  async generateIdeas(input: {
    problemStatement: string;
    role: string;
    roleId: string;
    framingContext?: ProblemFramingContext;
    promptConfig: PromptConfig;
    roleDefinition: RolePromptConfig;
  }): Promise<IdeaOutput[]> {
    const ideaCount = extractMinimumIdeaCount(input.promptConfig.template);
    return Array.from({ length: ideaCount }, (_, index) => ({
      title: `${input.role} title ${index + 1}`,
      text: `${input.role} idea ${index + 1} for ${input.problemStatement}`,
      rationale: `${input.role} rationale ${index + 1}`
    }));
  }

  async generateCritiques(input: {
    problemStatement: string;
    clusters: { id: string; label: string; ideas: string[] }[];
    framingContext?: ProblemFramingContext;
  }): Promise<CritiqueOutput[]> {
    return input.clusters.map((cluster, index) => ({
      targetIds: [cluster.id],
      text: `Critique ${index + 1} for ${cluster.label} on ${input.problemStatement}`,
      riskLevel: "medium"
    }));
  }

  async generateClusters(input: {
    problemStatement: string;
    ideas: { id: string; title?: string; text: string; rationale?: string; sourceRole?: string }[];
    framingContext?: ProblemFramingContext;
    promptConfig: PromptConfig;
  }): Promise<ClusteringOutput> {
    const groups: Array<typeof input.ideas> = [];
    const embeddings = await this.embedTexts(input.ideas.map((idea) => idea.text));

    for (const [index, idea] of input.ideas.entries()) {
      const embedding = embeddings[index] ?? [];
      const match = groups.find((group) => {
        const groupIndex = input.ideas.findIndex((candidate) => candidate.id === group[0]?.id);
        const groupEmbedding = groupIndex >= 0 ? embeddings[groupIndex] ?? [] : [];
        if (embedding.length > 0 && groupEmbedding.length > 0) {
          return (
            groupEmbedding.length === embedding.length &&
            embedding.every((value, embeddingIndex) => value === groupEmbedding[embeddingIndex])
          );
        }

        return group.some((candidate) => fakeIdeasOverlap(candidate, idea));
      });
      if (match) {
        match.push(idea);
      } else {
        groups.push([idea]);
      }
    }

    return {
      clusters: groups.map((group, index) => ({
        id: `cluster-${index + 1}`,
        label: summarizeFakeClusterLabel(group),
        summary:
          group.length === 1
            ? `A distinct standalone concept centered on ${group[0]?.title ?? group[0]?.id}.`
            : `Ideas grouped around the shared theme of ${summarizeFakeClusterLabel(group).toLowerCase()}.`,
        rationale:
          group.length === 1
            ? "No other idea showed strong enough thematic overlap to justify grouping."
            : "These ideas share repeated keywords and a common topical focus in the fake provider.",
        memberIdeaIds: group.map((idea) => idea.id),
        bridgeIdeaIds: [],
        confidence: group.length === 1 ? 0.6 : 0.8
      })),
      unclusteredIdeaIds: []
    };
  }

  async generateDecision(input: {
    problemStatement: string;
    clusters: { id: string; label: string }[];
    critiques: string[];
    framingContext?: ProblemFramingContext;
  }): Promise<DecisionOutput> {
    return {
      options: input.clusters.slice(0, 3).map((cluster, index) => ({
        title: `Option ${index + 1}: ${cluster.label}`,
        summary: `Summary for ${cluster.label}`
      })),
      recommendation: `Recommended direction for ${input.problemStatement}`,
      rationale: `Decision based on ${input.clusters.length} clusters and ${input.critiques.length} critiques`,
      risks: ["Execution risk", "Adoption risk"],
      nextSteps: ["Assign owner", "Validate with stakeholders"]
    };
  }

  async embedTexts(input: string[]): Promise<number[][]> {
    return input.map((text, idx) => [text.length, idx + 1, text.split(" ").length]);
  }
}

export class GeminiProvider implements LlmProvider {
  private generationClient: GoogleGenAI;
  private embeddingClient: GoogleGenAI;
  private model: string;
  private embeddingModel: string;

  constructor(apiKey: string, model = "gemini-2.5-flash", embeddingModel = "gemini-embedding-001") {
    this.generationClient = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });
    this.embeddingClient = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
    this.model = model;
    this.embeddingModel = embeddingModel;
  }

  async improveProblemStatement(input: { prompt: string; rawStatement: string }): Promise<ImproveStatementOutput> {
    const response = await this.generationClient.models.generateContent({
      model: this.model,
      contents: `${input.prompt}\n\nRough problem statement:\n${input.rawStatement}`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: Type.OBJECT,
          properties: {
            clarifiedProblemStatement: { type: Type.STRING },
            contextAndConstraints: { type: Type.STRING },
            successCriteria: { type: Type.STRING },
            scopeBoundaries: { type: Type.STRING },
            brainstormingLaunchQuestion: { type: Type.STRING }
          },
          required: [
            "clarifiedProblemStatement",
            "contextAndConstraints",
            "successCriteria",
            "scopeBoundaries",
            "brainstormingLaunchQuestion"
          ],
          propertyOrdering: [
            "clarifiedProblemStatement",
            "contextAndConstraints",
            "successCriteria",
            "scopeBoundaries",
            "brainstormingLaunchQuestion"
          ]
        }
      }
    });

    return JSON.parse(response.text ?? "{}") as ImproveStatementOutput;
  }

  async generateIdeas(input: {
    problemStatement: string;
    role: string;
    roleId: string;
    framingContext?: ProblemFramingContext;
    promptConfig: PromptConfig;
    roleDefinition: RolePromptConfig;
  }): Promise<IdeaOutput[]> {
    const response = await this.generationClient.models.generateContent({
      model: input.promptConfig.model || this.model,
      contents: buildDivergePrompt(input),
      config: {
        temperature: input.promptConfig.temperature,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              text: { type: Type.STRING },
              rationale: { type: Type.STRING }
            },
            required: ["text", "rationale"],
            propertyOrdering: ["title", "text", "rationale"]
          }
        }
      }
    });
    return JSON.parse(response.text ?? "[]") as IdeaOutput[];
  }

  async generateCritiques(input: {
    problemStatement: string;
    clusters: { id: string; label: string; ideas: string[] }[];
    framingContext?: ProblemFramingContext;
  }): Promise<CritiqueOutput[]> {
    const framingBlock = input.framingContext
      ? `\nProblem framing:\n${JSON.stringify(input.framingContext, null, 2)}`
      : "";
    const response = await this.generationClient.models.generateContent({
      model: this.model,
      contents: `Critique these clusters for ${input.problemStatement}: ${JSON.stringify(input.clusters)}${framingBlock}`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              targetIds: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              text: { type: Type.STRING },
              riskLevel: { type: Type.STRING }
            },
            required: ["targetIds", "text", "riskLevel"],
            propertyOrdering: ["targetIds", "text", "riskLevel"]
          }
        }
      }
    });
    return JSON.parse(response.text ?? "[]") as CritiqueOutput[];
  }

  async generateClusters(input: {
    problemStatement: string;
    ideas: { id: string; title?: string; text: string; rationale?: string; sourceRole?: string }[];
    framingContext?: ProblemFramingContext;
    promptConfig: PromptConfig;
  }): Promise<ClusteringOutput> {
    const response = await this.generationClient.models.generateContent({
      model: input.promptConfig.model || this.model,
      contents: buildClusterPrompt(input),
      config: {
        temperature: input.promptConfig.temperature,
        responseMimeType: "application/json",
        responseJsonSchema: input.promptConfig.schema as NonNullable<
          Parameters<typeof this.generationClient.models.generateContent>[0]["config"]
        >["responseJsonSchema"]
      }
    });

    return JSON.parse(response.text ?? "{\"clusters\":[],\"unclusteredIdeaIds\":[]}") as ClusteringOutput;
  }

  async generateDecision(input: {
    problemStatement: string;
    clusters: { id: string; label: string }[];
    critiques: string[];
    framingContext?: ProblemFramingContext;
  }): Promise<DecisionOutput> {
    const framingBlock = input.framingContext ? ` Problem framing: ${JSON.stringify(input.framingContext)}` : "";
    const response = await this.generationClient.models.generateContent({
      model: this.model,
      contents: `Produce top three options, recommendation, rationale, risks, and next steps for ${input.problemStatement}. Clusters: ${JSON.stringify(input.clusters)} Critiques: ${JSON.stringify(input.critiques)}${framingBlock}`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: Type.OBJECT,
          properties: {
            options: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  summary: { type: Type.STRING }
                },
                required: ["title", "summary"],
                propertyOrdering: ["title", "summary"]
              }
            },
            recommendation: { type: Type.STRING },
            rationale: { type: Type.STRING },
            risks: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            nextSteps: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          },
          required: ["options", "recommendation", "rationale", "risks", "nextSteps"],
          propertyOrdering: ["options", "recommendation", "rationale", "risks", "nextSteps"]
        }
      }
    });
    return JSON.parse(response.text ?? "{}") as DecisionOutput;
  }

  async embedTexts(input: string[]): Promise<number[][]> {
    const response = await this.embeddingClient.models.embedContent({
      model: this.embeddingModel,
      contents: input
    });
    return (response.embeddings ?? []).map((item) => item.values ?? []);
  }
}

import { readRuntimeConfig } from "../runtime/config.js";

export function createLlmProvider(): LlmProvider {
  const runtimeConfig = readRuntimeConfig();
  const apiKey = runtimeConfig.geminiApiKey;
  const fakeEnabled = runtimeConfig.useFakeLlm;
  const isTestRuntime = runtimeConfig.isTestRuntime;

  if (fakeEnabled) {
    if (!isTestRuntime) {
      throw new Error("USE_FAKE_LLM=true is not allowed outside tests");
    }
    return new FakeLlmProvider();
  }

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required when USE_FAKE_LLM=false");
  }

  return new GeminiProvider(
    apiKey,
    runtimeConfig.geminiModel,
    runtimeConfig.geminiEmbeddingModel
  );
}
