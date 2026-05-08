import {
  CheckCircleIcon,
  CircleAlertIcon,
  EyeIcon,
  DownloadIcon,
  FolderOpenIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ExtensionPatchValidationResult,
  ExtensionPreviewVariantEntry,
  ExtensionRegistry,
  ExtensionRegistryEntry,
} from "@t3tools/contracts";
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

function activeStackStatusLabel(registry: ExtensionRegistry | undefined): string | undefined {
  const stack = registry?.activeStack;
  if (!stack) return undefined;
  if (stack.restartRequired) return "Workspace out of sync";
  if (stack.desiredExtensionIds.length > 0) return "Live patches applied";
  return "No enabled extensions";
}

function ExtensionRow({
  entry,
  validation,
  preview,
  validating,
  creatingPreview,
  uninstalling,
  toggling,
  onValidate,
  onCreatePreview,
  onUninstall,
  onToggleEnabled,
}: {
  entry: ExtensionRegistryEntry;
  validation?: ExtensionPatchValidationResult;
  preview?: ExtensionPreviewVariantEntry;
  validating?: boolean;
  creatingPreview?: boolean;
  uninstalling?: boolean;
  toggling?: boolean;
  onValidate?: () => void;
  onCreatePreview?: () => void;
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
  const previewLabel = preview ? "Preview ready" : null;
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
          {previewLabel ? <span className="text-success">{previewLabel}</span> : null}
          {baseLabel ? (
            <span className="min-w-0 truncate text-muted-foreground/50">{baseLabel}</span>
          ) : null}
        </span>
      }
      control={
        onValidate || onUninstall || onToggleEnabled ? (
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
            {onCreatePreview ? (
              <Button
                size="xs"
                variant="outline"
                disabled={creatingPreview}
                onClick={onCreatePreview}
              >
                <EyeIcon className="size-3.5" />
                {creatingPreview ? "Creating" : preview ? "Recreate" : "Preview"}
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

function VariantRow({
  variant,
  installed,
  installing,
  onInstall,
}: {
  variant: ExtensionPreviewVariantEntry;
  installed: boolean;
  installing?: boolean;
  onInstall: () => void;
}) {
  return (
    <SettingsRow
      title={variant.extensionId}
      description={variant.detail}
      status={
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={variant.status === "ready" ? "text-success" : "text-destructive"}>
            {variant.status === "ready" ? "Preview ready" : "Preview failed"}
          </span>
          {variant.baseGitCommit ? (
            <span className="text-muted-foreground/50">{variant.baseGitCommit.slice(0, 8)}</span>
          ) : null}
        </span>
      }
      control={
        <span className="inline-flex items-center gap-1.5">
          <code className="max-w-54 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {variant.variantId}
          </code>
          <Button
            size="xs"
            variant="outline"
            disabled={installed || installing || variant.status !== "ready"}
            onClick={onInstall}
          >
            {installed ? (
              <CheckCircleIcon className="size-3.5 text-success" />
            ) : (
              <DownloadIcon className="size-3.5" />
            )}
            {installing ? "Installing" : installed ? "Installed" : "Install"}
          </Button>
        </span>
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
        description: "Dense Sidebar is ready to preview from the Drafts section.",
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
  const createPreviewMutation = useMutation({
    mutationFn: (entry: ExtensionRegistryEntry) =>
      ensureLocalApi().server.createExtensionPreviewVariant({
        extensionId: entry.manifest.id,
      }),
    onSuccess: (variant) => {
      queryClient.setQueryData<ExtensionRegistry>(["server", "extensions"], (current) =>
        current
          ? {
              ...current,
              variants: [
                variant,
                ...current.variants.filter((entry) => entry.extensionId !== variant.extensionId),
              ],
            }
          : current,
      );
      toastManager.add({
        title: "Preview ready",
        description: "The extension patch was applied to an isolated source variant.",
        type: "success",
      });
    },
    onError: (error) => {
      toastManager.add({
        title: "Unable to create preview",
        description:
          error instanceof Error ? error.message : "The extension preview variant was not created.",
        type: "error",
      });
    },
  });
  const installPreviewMutation = useMutation({
    mutationFn: (variant: ExtensionPreviewVariantEntry) =>
      ensureLocalApi().server.installExtensionPreviewVariant({
        extensionId: variant.extensionId,
        variantId: variant.variantId,
      }),
    onSuccess: (registry) => {
      queryClient.setQueryData(["server", "extensions"], registry);
      toastManager.add({
        title: "Extension installed",
        description: "The extension is installed. Toggle it on to add it to the active stack.",
        type: "success",
      });
    },
    onError: (error) => {
      toastManager.add({
        title: "Unable to install extension",
        description:
          error instanceof Error ? error.message : "The extension preview was not installed.",
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
          error instanceof Error ? error.message : "The active extension stack was not updated.",
        type: "error",
      });
    },
  });
  const openActiveSourceMutation = useMutation({
    mutationFn: (sourceDir: string) =>
      ensureLocalApi().shell.openInEditor(sourceDir, "file-manager"),
    onError: (error) => {
      toastManager.add({
        title: "Unable to open workspace",
        description:
          error instanceof Error ? error.message : "The workspace folder was not opened.",
        type: "error",
      });
    },
  });
  const registry = extensionsQuery.data;
  const installed = registry?.installed ?? [];
  const drafts = registry?.drafts ?? [];
  const variants = registry?.variants ?? [];
  const activeStack = registry?.activeStack;
  const installedExtensionIds = new Set(installed.map((entry) => entry.manifest.id));
  const latestVariantByExtensionId = new Map<string, ExtensionPreviewVariantEntry>();
  for (const variant of variants) {
    if (!latestVariantByExtensionId.has(variant.extensionId)) {
      latestVariantByExtensionId.set(variant.extensionId, variant);
    }
  }
  const isEmpty = installed.length === 0 && drafts.length === 0 && variants.length === 0;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Extensions"
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
          description="Local patch extensions are created as drafts, previewed as patched variants, then installed into the active recipe."
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
        <SettingsRow
          title="Extension storage"
          description={registry ? registry.installedDir : "Loading local extension registry."}
          status={registry ? `Drafts: ${registry.draftsDir}` : undefined}
        />
        {activeStack ? (
          <SettingsRow
            title="Live workspace"
            description={activeStack.sourceDir}
            status={activeStackStatusLabel(registry)}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={openActiveSourceMutation.isPending}
                onClick={() => openActiveSourceMutation.mutate(activeStack.sourceDir)}
              >
                <FolderOpenIcon className="size-3.5" />
                Open
              </Button>
            }
          />
        ) : null}
      </SettingsSection>

      {activeStack?.restartRequired ? (
        <Alert variant="warning" className="mx-1">
          <CircleAlertIcon />
          <AlertTitle>Extension workspace is out of sync</AlertTitle>
          <AlertDescription>
            Toggle the extension again to re-apply the live patch stack. If the patch no longer
            applies cleanly, T3 will reject it before changing extension state.
          </AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection title="Installed">
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
              <EmptyTitle>No installed extensions</EmptyTitle>
              <EmptyDescription>Installed patch extensions will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SettingsSection>

      <SettingsSection title="Drafts">
        {drafts.length > 0 ? (
          drafts.map((entry) => {
            const validation = validationByExtensionId[entry.manifest.id];
            const preview = latestVariantByExtensionId.get(entry.manifest.id);
            return (
              <ExtensionRow
                key={entry.path}
                entry={entry}
                {...(validation ? { validation } : {})}
                {...(preview ? { preview } : {})}
                validating={
                  validateDraftMutation.isPending &&
                  validateDraftMutation.variables?.path === entry.path
                }
                onValidate={() => validateDraftMutation.mutate(entry)}
                creatingPreview={
                  createPreviewMutation.isPending &&
                  createPreviewMutation.variables?.path === entry.path
                }
                onCreatePreview={() => createPreviewMutation.mutate(entry)}
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
              <EmptyDescription>Patch Studio drafts will appear here.</EmptyDescription>
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

      {isEmpty ? null : (
        <SettingsSection title="Variants">
          {variants.length > 0 ? (
            variants.map((variant) => {
              const installed = installedExtensionIds.has(variant.extensionId);
              return (
                <VariantRow
                  key={`${variant.extensionId}:${variant.variantId}`}
                  variant={variant}
                  installed={installed}
                  installing={
                    installPreviewMutation.isPending &&
                    installPreviewMutation.variables?.variantId === variant.variantId
                  }
                  onInstall={() => installPreviewMutation.mutate(variant)}
                />
              );
            })
          ) : (
            <SettingsRow
              title="No preview variants"
              description="Validated draft extensions can create isolated preview source variants."
              status={registry ? `Variants: ${registry.variantsDir}` : undefined}
            />
          )}
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
