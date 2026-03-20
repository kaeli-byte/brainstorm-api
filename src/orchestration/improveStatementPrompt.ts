import { getToolPrompt } from "./promptRegistryRepository.js";

export function loadImproveStatementPrompt() {
  return getToolPrompt("improve-statement");
}
