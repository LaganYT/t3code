import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  buildModelHandoffMessage,
  buildTranscriptHandoffFallback,
  MODEL_HANDOFF_SUMMARY_REQUEST,
  type ModelHandoffSummarySource,
} from "../lib/modelHandoff";
import { newMessageId, newThreadId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

const MODEL_HANDOFF_SUMMARY_TIMEOUT_MS = 3 * 60_000;

function handoffFailureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function handoffWarningToast(title: string, description: string) {
  toastManager.add({
    type: "warning",
    title,
    description,
  });
}

function waitForGeneratedHandoffSummary(
  threadRef: ScopedThreadRef,
  existingAssistantMessageIds: ReadonlySet<string>,
): Promise<string> {
  const detailAtom = environmentThreadDetails.detailAtom(threadRef);

  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      reject(new Error("The source model did not finish the handoff summary."));
    }, MODEL_HANDOFF_SUMMARY_TIMEOUT_MS);

    const finish = (summary: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      unsubscribe?.();
      resolve(summary);
    };

    const inspect = (detail: ReturnType<typeof appAtomRegistry.get>) => {
      if (!detail || typeof detail !== "object" || !("messages" in detail)) return;
      const thread = detail as {
        readonly messages: ReadonlyArray<{
          readonly id: string;
          readonly role: string;
          readonly text: string;
        }>;
        readonly latestTurn?: { readonly completedAt?: string | null } | null;
      };
      if (!thread.latestTurn?.completedAt) return;

      for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
        const message = thread.messages[index];
        if (
          message?.role === "assistant" &&
          !existingAssistantMessageIds.has(message.id) &&
          message.text.trim().length > 0
        ) {
          finish(message.text.trim());
          return;
        }
      }
    };

    unsubscribe = appAtomRegistry.subscribe(detailAtom, inspect);
    inspect(appAtomRegistry.get(detailAtom));
  });
}

export function useModelHandoff() {
  const router = useRouter();
  const createThreadCommand = useAtomCommand(threadEnvironment.create, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });

  const handoffModel = useCallback(
    async (threadRef: ScopedThreadRef, targetModelSelection: ModelSelection) => {
      const thread = readThreadShell(threadRef);
      if (!thread) {
        handoffFailureToast("Could not start model handoff", new Error("Thread not found."));
        return false;
      }

      if (
        thread.modelSelection.instanceId === targetModelSelection.instanceId &&
        thread.modelSelection.model === targetModelSelection.model
      ) {
        return false;
      }

      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        handoffWarningToast(
          "Wait for the current turn",
          "Model handoff is available after the current response finishes.",
        );
        return false;
      }

      const sourceDetail = appAtomRegistry.get(environmentThreadDetails.detailAtom(threadRef));
      const sourceMessages = sourceDetail?.messages ?? [];
      const existingAssistantMessageIds = new Set(
        sourceMessages
          .filter((message) => message.role === "assistant")
          .map((message) => message.id),
      );

      let summary = buildTranscriptHandoffFallback(sourceMessages);
      let summarySource: ModelHandoffSummarySource = "transcript-fallback";
      const summaryCreatedAt = new Date().toISOString();
      const summaryStart = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: thread.id,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: MODEL_HANDOFF_SUMMARY_REQUEST,
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          titleSeed: thread.title,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: summaryCreatedAt,
        },
      });

      if (summaryStart._tag === "Success") {
        toastManager.add({
          type: "info",
          title: "Generating handoff summary",
          description: `${thread.modelSelection.model} is preparing context for ${targetModelSelection.model}.`,
        });

        const summaryResult = await settlePromise(() =>
          waitForGeneratedHandoffSummary(threadRef, existingAssistantMessageIds),
        );
        if (summaryResult._tag === "Success") {
          summary = summaryResult.value;
          summarySource = "source-model";
        } else {
          handoffWarningToast(
            "Using transcript fallback",
            "The source model did not finish the handoff summary, so T3 will catch the new model up from the recent transcript instead.",
          );
        }
      } else if (isAtomCommandInterrupted(summaryStart)) {
        return false;
      } else {
        handoffWarningToast(
          "Using transcript fallback",
          "The source model could not generate a handoff summary (for example, because its usage limit was reached), so T3 will catch the new model up from the recent transcript instead.",
        );
      }

      const handoffMessage = buildModelHandoffMessage({
        threadTitle: thread.title,
        branch: thread.branch ?? null,
        sourceModelSelection: thread.modelSelection,
        targetModelSelection,
        summary,
        summarySource,
      });
      const targetThreadId = newThreadId();
      const targetCreatedAt = new Date().toISOString();
      const createResult = await createThreadCommand({
        environmentId: threadRef.environmentId,
        input: {
          threadId: targetThreadId,
          projectId: thread.projectId,
          title: thread.title,
          modelSelection: targetModelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: "default",
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          createdAt: targetCreatedAt,
        },
      });
      if (createResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(createResult)) {
          handoffFailureToast("Could not create model handoff", squashAtomCommandFailure(createResult));
        }
        return false;
      }

      const targetStart = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: targetThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: handoffMessage,
            attachments: [],
          },
          modelSelection: targetModelSelection,
          titleSeed: thread.title,
          runtimeMode: thread.runtimeMode,
          interactionMode: "default",
          createdAt: targetCreatedAt,
        },
      });
      if (targetStart._tag === "Failure" && !isAtomCommandInterrupted(targetStart)) {
        handoffFailureToast(
          "Handoff thread created, but the context could not be sent",
          squashAtomCommandFailure(targetStart),
        );
      }

      await router.navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: threadRef.environmentId,
          threadId: targetThreadId,
        },
      });

      if (targetStart._tag === "Success") {
        toastManager.add({
          type: "success",
          title: "Model handoff complete",
          description: `${targetModelSelection.model} has been caught up and told to wait for your next message.`,
        });
      }
      return targetStart._tag === "Success";
    },
    [createThreadCommand, router, startThreadTurn],
  );

  return { handoffModel };
}
