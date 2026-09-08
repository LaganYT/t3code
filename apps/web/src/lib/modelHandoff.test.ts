import { describe, expect, it } from "vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  buildModelHandoffPrompt,
  modelHandoffActionId,
  parseModelHandoffActionId,
} from "./modelHandoff";

const source = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
};
const target = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
};

describe("model handoff", () => {
  it("round-trips provider/model action ids including punctuation", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("opencode_personal"),
      model: "openrouter/example:model:free",
    };

    expect(parseModelHandoffActionId(modelHandoffActionId(selection))).toEqual(selection);
    expect(parseModelHandoffActionId("rename")).toBeNull();
  });

  it("builds a compact continuation prompt with source and recent context", () => {
    const prompt = buildModelHandoffPrompt({
      threadTitle: "Fix provider switching",
      branch: "feat/provider-switch",
      sourceModelSelection: source,
      targetModelSelection: target,
      messages: [
        { role: "user", text: "Implement safe provider switching without losing context." },
        { role: "assistant", text: "I added the initial provider routing changes." },
        { role: "user", text: "Now preserve the current worktree and finish the tests." },
      ],
    });

    expect(prompt).toContain("## Handoff summary");
    expect(prompt).toContain("Source model: gpt-6-astra");
    expect(prompt).toContain("Target model: claude-opus-5");
    expect(prompt).toContain("branch feat/provider-switch");
    expect(prompt).toContain("Original goal: Implement safe provider switching");
    expect(prompt).toContain("User: Now preserve the current worktree and finish the tests.");
    expect(prompt).toContain("Inspect the current files and git diff");
  });

  it("keeps only recent conversation context", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message-${index}`,
    }));
    const prompt = buildModelHandoffPrompt({
      threadTitle: "Long thread",
      branch: null,
      sourceModelSelection: source,
      targetModelSelection: target,
      messages,
    });

    expect(prompt).not.toContain("User: message-0");
    expect(prompt).toContain("User: message-4");
    expect(prompt).toContain("Assistant: message-11");
  });
});
