import {
  CheckCircleIcon,
  CircleAlertIcon,
  EyeIcon,
  DownloadIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
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
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
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
  preview,
  validating,
  creatingPreview,
  onValidate,
  onCreatePreview,
}: {
  entry: ExtensionRegistryEntry;
  validation?: ExtensionPatchValidationResult;
  preview?: ExtensionPreviewVariantEntry;
  validating?: boolean;
  creatingPreview?: boolean;
  onValidate?: () => void;
  onCreatePreview?: () => void;
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
        onValidate ? (
          <span className="inline-flex items-center gap-1.5">
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
                ...current.variants.filter((entry) => entry.variantId !== variant.variantId),
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
        description: "The extension is installed and enabled in the local registry.",
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
  const registry = extensionsQuery.data;
  const installed = registry?.installed ?? [];
  const drafts = registry?.drafts ?? [];
  const variants = registry?.variants ?? [];
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
      </SettingsSection>

      <SettingsSection title="Installed">
        {installed.length > 0 ? (
          installed.map((entry) => <ExtensionRow key={entry.path} entry={entry} />)
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
