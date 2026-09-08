import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { ContextMenuItem, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { resolveSnoozePresets, snoozeWakeDescription } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { environmentServerConfigsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsTitleRegeneration,
  readThreadShell,
  useProjects,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readLocalApi } from "../localApi";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { useUiStateStore } from "../uiStateStore";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../providerInstances";
import {
  buildModelHandoffMessage,
  MODEL_HANDOFF_SUMMARY_REQUEST,
  modelHandoffActionId,
  parseModelHandoffActionId,
  type ModelHandoffActionId,
} from "../lib/modelHandoff";
import { newMessageId, newThreadId } from "../lib/utils";

type ThreadMenuActionId = ThreadActionMenuId | "model-handoff" | ModelHandoffActionId;

const MODEL_HANDOFF_SUMMARY_TIMEOUT_MS = 3 * 60_000;

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
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

/**
 * The per-thread action menu (pin, settle, snooze, rename, copy, delete…) as
 * a self-contained hook, for surfaces other than the sidebar row — today the
 * chat header. Renders through the native context-menu bridge and dispatches
 * through the same mutations the sidebar uses.
 *
 * Unlike the sidebar, settle and snooze here never navigate away: the caller
 * is acting on the thread they are reading, and ChatView's parked-thread
 * banner already offers the way back.
 */
export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** Fallback for "Copy path" when the thread has no worktree. */
  readonly projectCwd: string | null;
  readonly onStartRename: () => void;
}) {
  const { threadRef, projectCwd, onStartRename } = input;
  const router = useRouter();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const logicalProjectKeyByPhysicalKey = useMemo(
    () =>
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
      }),
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const createThreadCommand = useAtomCommand(threadEnvironment.create, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => failureToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "Branch copied", description: branch });
    },
    onError: (error) => failureToast("Failed to copy branch", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({ type: "success", title: "Thread ID copied", description: threadId });
    },
    onError: (error) => failureToast("Failed to copy thread ID", error),
  });

  const openMenu = useCallback(
    (position: { x: number; y: number }) => {
      if (threadRef === null) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        // Snapshot at open time — the menu is modal, so state read now is
        // what the user is looking at.
        const thread = readThreadShell(threadRef);
        if (!thread) return;
        const now = new Date();
        const supports = {
          settlement: readEnvironmentSupportsSettlement(threadRef.environmentId),
          snooze: readEnvironmentSupportsSnooze(threadRef.environmentId),
          pinning: readEnvironmentSupportsPinning(threadRef.environmentId),
          titleRegeneration: readEnvironmentSupportsTitleRegeneration(threadRef.environmentId),
        };
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const isRunning = thread.session?.status === "running" && thread.session.activeTurnId != null;
        const snoozePresets = resolveSnoozePresets(now, timestampFormat);
        const baseItems = buildThreadActionMenuItems({
          branch: thread.branch ?? null,
          isPinned: thread.pinnedAt != null,
          isSettled: supports.settlement && thread.settledOverride === "settled",
          isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
          canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
          isRegeneratingTitle,
          isRunning,
          supports,
          snoozePresets,
        });

        const serverConfig = appAtomRegistry
          .get(environmentServerConfigsAtom)
          .get(threadRef.environmentId);
        const providerEntries = deriveProviderInstanceEntries(serverConfig?.providers ?? []);
        const handoffChildren: Array<ContextMenuItem<ThreadMenuActionId>> = [];
        for (const entry of providerEntries) {
          if (!isProviderInstancePickerReady(entry)) continue;
          for (const model of entry.models) {
            if (
              entry.instanceId === thread.modelSelection.instanceId &&
              model.slug === thread.modelSelection.model
            ) {
              continue;
            }
            handoffChildren.push({
              id: modelHandoffActionId({ instanceId: entry.instanceId, model: model.slug }),
              label: `${entry.displayName} · ${model.name}`,
            });
          }
        }
        const handoffItem: ContextMenuItem<ThreadMenuActionId> = {
          id: "model-handoff",
          label: "Continue with another model",
          icon: "arrow-right-left",
          disabled: isRunning || handoffChildren.length === 0,
          children: handoffChildren,
        };
        const insertionIndex = baseItems[0]?.id === "new-thread-on-branch" ? 1 : 0;
        const items: ReadonlyArray<ContextMenuItem<ThreadMenuActionId>> = [
          ...baseItems.slice(0, insertionIndex),
          handoffItem,
          ...baseItems.slice(insertionIndex),
        ];

        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const action: ThreadMenuActionId = clicked.value;

        const handoffSelection = parseModelHandoffActionId(action);
        if (handoffSelection !== null) {
          const sourceDetail = appAtomRegistry.get(environmentThreadDetails.detailAtom(threadRef));
          const existingAssistantMessageIds = new Set(
            (sourceDetail?.messages ?? [])
              .filter((message) => message.role === "assistant")
              .map((message) => message.id),
          );
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
          if (summaryStart._tag === "Failure") {
            if (!isAtomCommandInterrupted(summaryStart)) {
              failureToast(
                "Could not generate handoff summary",
                squashAtomCommandFailure(summaryStart),
              );
            }
            return;
          }

          toastManager.add({
            type: "info",
            title: "Generating handoff summary",
            description: `${thread.modelSelection.model} is preparing context for ${handoffSelection.model}.`,
          });

          const summaryResult = await settlePromise(() =>
            waitForGeneratedHandoffSummary(threadRef, existingAssistantMessageIds),
          );
          if (summaryResult._tag === "Failure") {
            failureToast("Could not finish model handoff", squashAtomCommandFailure(summaryResult));
            return;
          }

          const handoffMessage = buildModelHandoffMessage({
            threadTitle: thread.title,
            branch: thread.branch ?? null,
            sourceModelSelection: thread.modelSelection,
            targetModelSelection: handoffSelection,
            summary: summaryResult.value,
          });
          const targetThreadId = newThreadId();
          const targetCreatedAt = new Date().toISOString();
          const createResult = await createThreadCommand({
            environmentId: threadRef.environmentId,
            input: {
              threadId: targetThreadId,
              projectId: thread.projectId,
              title: thread.title,
              modelSelection: handoffSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: "default",
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              createdAt: targetCreatedAt,
            },
          });
          if (createResult._tag === "Failure") {
            if (!isAtomCommandInterrupted(createResult)) {
              failureToast("Could not create model handoff", squashAtomCommandFailure(createResult));
            }
            return;
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
              modelSelection: handoffSelection,
              titleSeed: thread.title,
              runtimeMode: thread.runtimeMode,
              interactionMode: "default",
              createdAt: targetCreatedAt,
            },
          });
          if (targetStart._tag === "Failure" && !isAtomCommandInterrupted(targetStart)) {
            failureToast(
              "Handoff thread created, but the summary could not be sent",
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
          toastManager.add({
            type: "success",
            title: "Model handoff complete",
            description: `${handoffSelection.model} has been caught up and told to wait for your next message.`,
          });
          return;
        }

        if (action.startsWith("snooze:")) {
          const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
          if (!preset) return;
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) {
              failureToast("Failed to snooze thread", squashAtomCommandFailure(result));
            }
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}`,
              timeout: 5_000,
              actionProps: {
                children: "Undo",
                onClick: () => {
                  void unsnoozeThread(threadRef).then((undone) => {
                    if (undone._tag === "Failure" && !isAtomCommandInterrupted(undone)) {
                      failureToast("Failed to wake thread", squashAtomCommandFailure(undone));
                    }
                  });
                },
              },
            }),
          );
          return;
        }
        const reportFailure = async (
          title: string,
          run: () => Promise<AtomCommandResult<unknown, unknown>>,
        ) => {
          const result = await run();
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(title, squashAtomCommandFailure(result));
          }
        };
        switch (action) {
          case "project-settings": {
            const project = projects.find(
              (candidate) =>
                candidate.environmentId === thread.environmentId &&
                candidate.id === thread.projectId,
            );
            if (!project) return;
            const projectKey =
              logicalProjectKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
              deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings);
            void router.navigate({
              to: "/projects/$projectKey",
              params: { projectKey },
            });
            return;
          }
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              failureToast("Could not create thread", squashAtomCommandFailure(result));
            }
            return;
          }
          case "settle":
            await reportFailure("Failed to settle thread", () => settleThread(threadRef));
            return;
          case "unsettle":
            await reportFailure("Failed to un-settle thread", () => unsettleThread(threadRef));
            return;
          case "unsnooze":
            await reportFailure("Failed to wake thread", () => unsnoozeThread(threadRef));
            return;
          case "pin":
            await reportFailure("Failed to pin thread", () => pinThread(threadRef));
            return;
          case "unpin": {
            await reportFailure("Failed to unpin thread", () => confirmAndUnpinThread(threadRef));
            return;
          }
          case "rename":
            onStartRename();
            return;
          case "regenerate-title":
            if (isRegeneratingTitle) return;
            await reportFailure("Failed to regenerate thread title", () =>
              updateThreadMetadata({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, regenerateTitle: true },
              }),
            );
            return;
          case "mark-unread":
            markThreadUnread(scopedThreadKey(threadRef), thread.latestTurn?.completedAt);
            return;
          case "copy-path": {
            const workspacePath = thread.worktreePath ?? projectCwd;
            if (!workspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          }
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              failureToast(
                didArchive ? "Thread archived, but navigation failed" : "Failed to archive thread",
                squashAtomCommandFailure(result),
              );
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const deleted = await deleteThread(threadRef);
            if (
              deleted._tag === "Failure" &&
              !isAtomCommandInterrupted(deleted) &&
              // A failure with the thread already gone is worktree cleanup
              // failing after a successful delete — deleteThread has toasted
              // that itself, and "Failed to delete thread" would be a lie.
              readThreadShell(threadRef) !== null
            ) {
              failureToast("Failed to delete thread", squashAtomCommandFailure(deleted));
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      archiveThread,
      confirmThreadArchive,
      confirmThreadDelete,
      confirmAndUnpinThread,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      createThreadCommand,
      deleteThread,
      handleNewThread,
      logicalProjectKeyByPhysicalKey,
      markThreadUnread,
      onStartRename,
      pinThread,
      projectCwd,
      projectGroupingSettings,
      projects,
      router,
      settleThread,
      snoozeThread,
      startThreadTurn,
      threadRef,
      timestampFormat,
      unsettleThread,
      unsnoozeThread,
      updateThreadMetadata,
    ],
  );

  const closeMenu = useCallback(() => {
    void readLocalApi()?.contextMenu.close();
  }, []);

  return { openMenu, closeMenu };
}
