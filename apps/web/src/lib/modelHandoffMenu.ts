import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { readThreadShell } from "../state/entities";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../providerInstances";
import {
  modelHandoffActionId,
  type ModelHandoffActionId,
} from "./modelHandoff";

export type ModelHandoffMenuActionId = "model-handoff" | ModelHandoffActionId;

export function buildModelHandoffMenuItem(
  threadRef: ScopedThreadRef,
  options?: { readonly disabled?: boolean },
): ContextMenuItem<ModelHandoffMenuActionId> | null {
  const thread = readThreadShell(threadRef);
  if (!thread) return null;

  const serverConfig = appAtomRegistry
    .get(environmentServerConfigsAtom)
    .get(threadRef.environmentId);
  const providerEntries = deriveProviderInstanceEntries(serverConfig?.providers ?? []);
  const children: Array<ContextMenuItem<ModelHandoffMenuActionId>> = [];

  for (const entry of providerEntries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    for (const model of entry.models) {
      if (
        entry.instanceId === thread.modelSelection.instanceId &&
        model.slug === thread.modelSelection.model
      ) {
        continue;
      }
      children.push({
        id: modelHandoffActionId({ instanceId: entry.instanceId, model: model.slug }),
        label: `${entry.displayName} · ${model.name}`,
        icon: "arrow-right-left",
      });
    }
  }

  return {
    id: "model-handoff",
    label: "Continue with another model",
    icon: "arrow-right-left",
    disabled: options?.disabled === true || children.length === 0,
    children,
  };
}

export function insertModelHandoffMenuItem<T extends string>(
  baseItems: ReadonlyArray<ContextMenuItem<T>>,
  handoffItem: ContextMenuItem<ModelHandoffMenuActionId> | null,
): ReadonlyArray<ContextMenuItem<T | ModelHandoffMenuActionId>> {
  if (!handoffItem) return baseItems;
  const insertionIndex = baseItems[0]?.id === "new-thread-on-branch" ? 1 : 0;
  return [
    ...baseItems.slice(0, insertionIndex),
    handoffItem,
    ...baseItems.slice(insertionIndex),
  ];
}
