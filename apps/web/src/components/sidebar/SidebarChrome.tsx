import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import {
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  ChartNoAxesColumnIcon,
  GitPullRequestIcon,
  SettingsIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { memo, useCallback, useMemo } from "react";
import {
  Link,
  useCanGoBack,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { useModelHandoff } from "../../hooks/useModelHandoff";
import { parseModelHandoffActionId } from "../../lib/modelHandoff";
import { buildModelHandoffMenuItem } from "../../lib/modelHandoffMenu";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironments } from "../../state/environments";
import { readThreadShell } from "../../state/entities";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  const routeParams = useParams({ strict: false }) as Partial<
    Record<"environmentId" | "threadId", string>
  >;
  const { handoffModel } = useModelHandoff();
  const threadRef = useMemo((): ScopedThreadRef | null => {
    if (!routeParams.environmentId || !routeParams.threadId) return null;
    return scopeThreadRef(
      routeParams.environmentId as ScopedThreadRef["environmentId"],
      routeParams.threadId as ScopedThreadRef["threadId"],
    );
  }, [routeParams.environmentId, routeParams.threadId]);
  const handoffItem = threadRef === null ? null : buildModelHandoffMenuItem(threadRef);
  const handoffAvailable = (handoffItem?.children?.length ?? 0) > 0;

  const handleHandoffClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (threadRef === null) return;
      const api = readLocalApi();
      if (!api) return;
      const thread = readThreadShell(threadRef);
      const menuItem = buildModelHandoffMenuItem(threadRef, {
        disabled:
          thread?.session?.status === "running" && thread.session.activeTurnId != null,
      });
      const children = menuItem?.children ?? [];
      if (children.length === 0 || menuItem?.disabled) return;
      const rect = event.currentTarget.getBoundingClientRect();
      void (async () => {
        const clicked = await settlePromise(() =>
          api.contextMenu.show(children, { x: rect.right, y: rect.bottom }),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const selection = parseModelHandoffActionId(clicked.value);
        if (selection !== null) {
          await handoffModel(threadRef, selection);
        }
      })();
    },
    [handoffModel, threadRef],
  );

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
          backdropVariant && resolveSidebarStageFocusRingOffsetClass(backdropVariant),
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden rounded-full px-1.5 text-muted-foreground @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
      {handoffAvailable ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton
                type="button"
                size="icon"
                aria-label="Continue with another model"
                onClick={handleHandoffClick}
                className={cn(
                  "relative z-10 ml-auto size-7 shrink-0",
                  backdropVariant &&
                    "text-white/80 hover:bg-white/15 hover:text-white focus-visible:ring-white/90",
                )}
              />
            }
          >
            <ArrowRightLeftIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Continue with another model</TooltipPopup>
        </Tooltip>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <span className="inline-flex min-w-0 items-baseline gap-1">
        <T3Wordmark aria-label="T3" className="h-2.5 w-auto shrink-0" />
        <span
          className={cn(
            "truncate text-sm font-medium tracking-tight",
            onBackdrop ? "text-white/70" : "text-muted-foreground",
          )}
        >
          Code
        </span>
      </span>
    </Link>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) =>
      /^\/settings(?:\/|$)/.test(location.pathname)
        ? "settings"
        : /^\/projects\/[^/]+\/?$/.test(location.pathname)
          ? "project-settings"
          : location.pathname === "/usage"
            ? "usage"
            : location.pathname === "/pull-requests"
              ? "pull-requests"
              : null,
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, closeMobileSidebar, navigate]);

  return (
    <SidebarMenu className="flex-row items-center">
      {currentFooterPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<GitPullRequestIcon />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
