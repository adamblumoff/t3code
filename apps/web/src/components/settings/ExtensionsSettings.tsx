import {
  CheckCircleIcon,
  CircleAlertIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExtensionPatchValidationResult, ExtensionRegistryEntry } from "@t3tools/contracts";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function extensionStateLabel(entry: ExtensionRegistryEntry): string {
  switch (entry.state) {
    case "draft":
      return "Draft";
    case "enabled":
      return "Enabled";
    case "disabled":
      return "Disabled";
    case "incompatible":
      return "Needs repair";
  }
}

function ExtensionRow({
  entry,
  validation,
  validating,
  building,
  uninstalling,
  toggling,
  onValidate,
  onBuild,
  onUninstall,
  onToggleEnabled,
}: {
  entry: ExtensionRegistryEntry;
  validation?: ExtensionPatchValidationResult;
  validating?: boolean;
  building?: boolean;
  uninstalling?: boolean;
  toggling?: boolean;
  onValidate?: () => void;
  onBuild?: () => void;
  onUninstall?: () => void;
  onToggleEnabled?: (enabled: boolean) => void;
}) {
  const baseBuild = entry.manifest.generatedAgainst;
  const baseLabel = [baseBuild?.channel, baseBuild?.version, baseBuild?.gitCommit]
    .filter(Boolean)
    .join(" ");
  const validationLabel = validation
    ? validation.valid
      ? "Patch applies"
      : "Patch conflict"
    : null;
  return (
    <SettingsRow
      title={entry.manifest.name}
      description={validation?.detail ?? entry.manifest.description ?? entry.manifest.id}
      status={
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span>{extensionStateLabel(entry)}</span>
          <span className="text-muted-foreground/50">v{entry.manifest.version}</span>
          {validationLabel ? (
            <span
              className={
                validation?.valid ? "text-success" : "text-destructive dark:text-destructive"
              }
            >
              {validationLabel}
            </span>
          ) : null}
          {baseLabel ? (
            <span className="min-w-0 truncate text-muted-foreground/50">{baseLabel}</span>
          ) : null}
        </span>
      }
      control={
        onValidate || onBuild || onUninstall || onToggleEnabled ? (
          <span className="inline-flex items-center gap-1.5">
            {onToggleEnabled ? (
              <Switch
                checked={entry.state === "enabled"}
                disabled={toggling}
                onCheckedChange={(checked) => onToggleEnabled(Boolean(checked))}
                aria-label={`${entry.state === "enabled" ? "Disable" : "Enable"} ${entry.manifest.name}`}
              />
            ) : null}
            {onValidate ? (
              <Button size="xs" variant="outline" disabled={validating} onClick={onValidate}>
                {validation?.valid ? (
                  <CheckCircleIcon className="size-3.5 text-success" />
                ) : validation ? (
                  <CircleAlertIcon className="size-3.5 text-destructive" />
                ) : (
                  <ShieldCheckIcon className="size-3.5" />
                )}
                {validating ? "Checking" : validation ? "Recheck" : "Validate"}
              </Button>
            ) : null}
            {onBuild ? (
              <Button size="xs" variant="outline" disabled={building} onClick={onBuild}>
                <PackageIcon className="size-3.5" />
                {building ? "Building" : "Build"}
              </Button>
            ) : null}
            {onUninstall ? (
              <Button size="xs" variant="outline" disabled={uninstalling} onClick={onUninstall}>
                <Trash2Icon className="size-3.5" />
                {uninstalling ? "Removing" : "Uninstall"}
              </Button>
            ) : null}
          </span>
        ) : (
          <code className="max-w-54 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {entry.manifest.id}
          </code>
        )
      }
    />
  );
}

export function ExtensionsSettingsPanel() {
  const queryClient = useQueryClient();
  const [validationByExtensionId, setValidationByExtensionId] = useState<
    Record<string, ExtensionPatchValidationResult>
  >({});
  const extensionsQuery = useQuery({
    queryKey: ["server", "extensions"],
    queryFn: () => ensureLocalApi().server.listExtensions(),
  });
  const createDenseSidebarDraftMutation = useMutation({
    mutationFn: () => ensureLocalApi().server.createExtensionDraft({ templateId: "dense-sidebar" }),
    onSuccess: (registry) => {
      queryClient.setQueryData(["server", "extensions"], registry);
      toastManager.add({
        title: "Draft created",
        description: "Dense Sidebar is ready to build.",
        type: "success",
      });
    },
    onError: (error) => {
      toastManager.add({
        title: "Unable to create draft",
        description:
          error instanceof Error ? error.message : "The extension draft was not created.",
        type: "error",
      });
    },
  });
  const validateDraftMutation = useMutation({
    mutationFn: (entry: ExtensionRegistryEntry) =>
      ensureLocalApi().server.validateExtensionDraft({
        extensionId: entry.manifest.id,
      }),
    onSuccess: (result) => {
      setValidationByExtensionId((current) => ({
        ...current,
        [result.extensionId]: result,
      }));
      toastManager.add({
        title: result.valid ? "Patch applies cleanly" : "Patch conflict",
        description: result.detail,
        type: result.valid ? "success" : "warning",
      });
    },
    onError: (error) => {
      toastManager.add({
        title: "Unable to validate patch",
        description:
          error instanceof Error ? error.message : "The extension patch was not checked.",
        type: "error",
      });
    },
  });
  const validateInstalledMutation = useMutation({
    mutationFn: (entry: ExtensionRegistryEntry) =>
      ensureLocalApi().server.validateInstalledExtension({
        extensionId: entry.manifest.id,
      }),
    onSuccess: (result) => {
      setValidationByExtensionId((current) => ({
        ...current,
        [result.extensionId]: result,
      }));
      toastManager.add({
        title: result.valid ? "Installed patch applies" : "Installed patch conflict",
        description: result.detail,
        type: result.valid ? "success" : "warning",
      });
    },
    onError: (error) => {
      toastManager.add({
        title: "Unable to recheck installed extension",
        description:
          error instanceof Error ? error.message : "The installed extension was not checked.",
        type: "error",
      });
    },
  });
  const buildDraftMutation = useMutation({
    mutationFn: async (entry: ExtensionRegistryEntry) => {
      const api = ensureLocalApi();
      const variant = await api.server.createExtensionPreviewVariant({
        extensionId: entry.manifest.id,
      });
      return api.server.installExtensionPreviewVariant({
        extensionId: variant.extensionId,
        variantId: variant.variantId,
      });
    },
    onSuccess: (registry) => {
      queryClient.setQueryData(["server", "extensions"], registry);
      toastManager.add({
        title: "Extension built",
        description: "The extension is installed and ready to activate.",
        type: "success",
      });
    },
    onError: (error) => {
      toastManager.add({
        title: "Unable to build extension",
        description:
          error instanceof Error ? error.message : "The extension was not built or installed.",
        type: "error",
      });
    },
  });
  const uninstallMutation = useMutation({
    mutationFn: (entry: ExtensionRegistryEntry) =>
      ensureLocalApi().server.uninstallExtension({
        extensionId: entry.manifest.id,
      }),
    onSuccess: (registry, entry) => {
      queryClient.setQueryData(["server", "extensions"], registry);
      setValidationByExtensionId((current) => {
        const next = { ...current };
        delete next[entry.manifest.id];
        return next;
      });
      toastManager.add({
        title: "Extension uninstalled",
        description: "The extension was removed from the local registry.",
        type: "success",
      });
    },
    onError: (error) => {
      toastManager.add({
        title: "Unable to uninstall extension",
        description: error instanceof Error ? error.message : "The extension was not removed.",
        type: "error",
      });
    },
  });
  const setEnabledMutation = useMutation({
    mutationFn: (input: { entry: ExtensionRegistryEntry; enabled: boolean }) =>
      ensureLocalApi().server.setExtensionEnabled({
        extensionId: input.entry.manifest.id,
        enabled: input.enabled,
      }),
    onSuccess: (registry, input) => {
      queryClient.setQueryData(["server", "extensions"], registry);
      setValidationByExtensionId((current) => {
        const next = { ...current };
        delete next[input.entry.manifest.id];
        return next;
      });
      toastManager.add({
        title: input.enabled ? "Extension enabled" : "Extension disabled",
        description: input.enabled
          ? "The extension patch was applied to the live workspace."
          : "The extension patch was removed from the live workspace.",
        type: "success",
      });
    },
    onError: (error, input) => {
      toastManager.add({
        title: input.enabled ? "Unable to enable extension" : "Unable to disable extension",
        description:
          error instanceof Error ? error.message : "The extension state was not updated.",
        type: "error",
      });
    },
  });
  const registry = extensionsQuery.data;
  const installed = registry?.installed ?? [];
  const drafts = registry?.drafts ?? [];
  const activeStack = registry?.activeStack;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Build"
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            disabled={extensionsQuery.isFetching}
            onClick={() => void extensionsQuery.refetch()}
            aria-label="Refresh extensions"
          >
            <RefreshCwIcon
              className={extensionsQuery.isFetching ? "size-3 animate-spin" : "size-3"}
            />
          </Button>
        }
      >
        <SettingsRow
          title="Patch Studio"
          description="Create local patch extensions and build them into installed extensions."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={createDenseSidebarDraftMutation.isPending}
              onClick={() => createDenseSidebarDraftMutation.mutate()}
            >
              <PlusIcon className="size-3.5" />
              Dense Sidebar
            </Button>
          }
        />
        {drafts.length > 0 ? (
          drafts.map((entry) => {
            const validation = validationByExtensionId[entry.manifest.id];
            return (
              <ExtensionRow
                key={entry.path}
                entry={entry}
                {...(validation ? { validation } : {})}
                validating={
                  validateDraftMutation.isPending &&
                  validateDraftMutation.variables?.path === entry.path
                }
                onValidate={() => validateDraftMutation.mutate(entry)}
                building={
                  buildDraftMutation.isPending && buildDraftMutation.variables?.path === entry.path
                }
                onBuild={() => buildDraftMutation.mutate(entry)}
              />
            );
          })
        ) : (
          <Empty className="min-h-56">
            <EmptyMedia variant="icon">
              <WrenchIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No draft extensions</EmptyTitle>
              <EmptyDescription>Drafts from Patch Studio will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SettingsSection>

      {activeStack?.restartRequired ? (
        <Alert variant="warning" className="mx-1">
          <CircleAlertIcon />
          <AlertTitle>Extension workspace is out of sync</AlertTitle>
          <AlertDescription>
            Toggle the affected extension again. T3 will reject the change if the patch cannot be
            applied cleanly.
          </AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection title="Activate">
        {installed.length > 0 ? (
          installed.map((entry) => {
            const validation = validationByExtensionId[entry.manifest.id];
            return (
              <ExtensionRow
                key={entry.path}
                entry={entry}
                {...(validation ? { validation } : {})}
                validating={
                  validateInstalledMutation.isPending &&
                  validateInstalledMutation.variables?.path === entry.path
                }
                onValidate={() => validateInstalledMutation.mutate(entry)}
                uninstalling={
                  uninstallMutation.isPending && uninstallMutation.variables?.path === entry.path
                }
                onUninstall={() => uninstallMutation.mutate(entry)}
                toggling={
                  setEnabledMutation.isPending &&
                  setEnabledMutation.variables?.entry.path === entry.path
                }
                onToggleEnabled={(enabled) => setEnabledMutation.mutate({ entry, enabled })}
              />
            );
          })
        ) : (
          <Empty className="min-h-56">
            <EmptyMedia variant="icon">
              <PackageIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No built extensions</EmptyTitle>
              <EmptyDescription>Built extensions will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SettingsSection>

      {extensionsQuery.isError ? (
        <SettingsSection title="Registry error">
          <SettingsRow
            title="Unable to load extensions"
            description={
              extensionsQuery.error instanceof Error
                ? extensionsQuery.error.message
                : "The extension registry could not be read."
            }
          />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
