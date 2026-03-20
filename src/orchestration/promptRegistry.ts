import type { Phase } from "../../shared/types.js";
import { readRuntimeConfig } from "../runtime/config.js";
import { getPromptConfigForPhase } from "./promptRegistryRepository.js";

export interface RolePromptConfig {
  name: string;
  version: string;
  systemPrompt: string;
}

export interface PromptConfig {
  phase: Phase;
  roles: string[];
  roleConfigVersion: string;
  templateVersion: string;
  schemaVersion: string;
  model: string;
  timeoutSeconds: number;
  temperature?: number;
  template: string;
  schema: Record<string, unknown>;
  roleDefinitions: Record<string, RolePromptConfig>;
}

export function loadPromptConfig(phase: Phase): PromptConfig {
  const manifest = getPromptConfigForPhase(phase);
  const runtimeConfig = readRuntimeConfig();

  return {
    phase: manifest.phase,
    roles: manifest.roles,
    roleConfigVersion: manifest.roleConfigVersion,
    templateVersion: manifest.templateVersion,
    schemaVersion: manifest.schemaVersion,
    model: manifest.model?.trim() || runtimeConfig.geminiModel,
    timeoutSeconds: manifest.timeoutSeconds,
    temperature: manifest.temperature,
    template: manifest.template,
    schema: manifest.schema,
    roleDefinitions: manifest.roleDefinitions
  };
}
