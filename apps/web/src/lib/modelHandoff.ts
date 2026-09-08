import type { ModelSelection } from "@t3tools/contracts";

const MAX_HANDOFF_MESSAGES = 8;
const MAX_HANDOFF_MESSAGE_CHARS = 2_000;
const MAX_HANDOFF_CONTEXT_CHARS = 12_000;

export type ModelHandoffActionId = `handoff-model:${string}:${string}`;

export interface ModelHandoffMessage {
  readonly role: string;
  readonly text: string;
}

export interface ModelHandoffPromptInput {
  readonly threadTitle: string;
  readonly branch: string | null;
  readonly sourceModelSelection: ModelSelection;
  readonly targetModelSelection: ModelSelection;
  readonly messages: ReadonlyArray<ModelHandoffMessage>;
}

function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatRecentMessages(messages: ReadonlyArray<ModelHandoffMessage>): string {
  const eligible = messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0,
  );
  const recent = eligible.slice(-MAX_HANDOFF_MESSAGES);
  const lines: string[] = [];
  let usedChars = 0;

  for (const message of recent) {
    const speaker = message.role === "user" ? "User" : "Assistant";
    const text = compactText(message.text, MAX_HANDOFF_MESSAGE_CHARS);
    const line = `${speaker}: ${text}`;
    if (usedChars + line.length > MAX_HANDOFF_CONTEXT_CHARS) break;
    lines.push(line);
    usedChars += line.length;
  }

  return lines.length > 0 ? lines.join("\n") : "No prior user/assistant messages were available.";
}

export function buildModelHandoffPrompt(input: ModelHandoffPromptInput): string {
  const firstUserMessage = input.messages.find(
    (message) => message.role === "user" && message.text.trim().length > 0,
  );
  const originalGoal = firstUserMessage
    ? compactText(firstUserMessage.text, MAX_HANDOFF_MESSAGE_CHARS)
    : "Not available.";
  const workspace = input.branch ? `branch ${input.branch}` : "the current project workspace";

  return [
    "Continue this task from another T3 Code thread.",
    "",
    "## Handoff summary",
    `- Source thread: ${compactText(input.threadTitle, 300)}`,
    `- Source model: ${input.sourceModelSelection.model}`,
    `- Target model: ${input.targetModelSelection.model}`,
    `- Workspace: ${workspace}`,
    `- Original goal: ${originalGoal}`,
    "",
    "## Recent context",
    formatRecentMessages(input.messages),
    "",
    "## Continue from here",
    "Use the existing workspace state as the source of truth. Inspect the current files and git diff before changing anything, do not redo work that is already complete, and continue the task from the latest state. Briefly state what you are picking up, then proceed.",
  ].join("\n");
}

export function modelHandoffActionId(selection: ModelSelection): ModelHandoffActionId {
  return `handoff-model:${encodeURIComponent(selection.instanceId)}:${encodeURIComponent(selection.model)}`;
}

export function parseModelHandoffActionId(action: string): ModelSelection | null {
  if (!action.startsWith("handoff-model:")) return null;
  const encoded = action.slice("handoff-model:".length);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator === encoded.length - 1) return null;

  try {
    const instanceId = decodeURIComponent(encoded.slice(0, separator));
    const model = decodeURIComponent(encoded.slice(separator + 1));
    if (!instanceId || !model) return null;
    return { instanceId, model } as ModelSelection;
  } catch {
    return null;
  }
}
