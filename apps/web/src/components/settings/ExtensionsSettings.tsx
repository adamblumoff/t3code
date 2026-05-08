import { PackageIcon, PlusIcon, RefreshCwIcon, WrenchIcon } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExtensionRegistryEntry } from "@t3tools/contracts";

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

function ExtensionRow({ entry }: { entry: ExtensionRegistryEntry }) {
  const baseBuild = entry.manifest.generatedAgainst;
  const baseLabel = [baseBuild?.channel, baseBuild?.version, baseBuild?.gitCommit]
    .filter(Boolean)
    .join(" ");
  return (
    <SettingsRow
      title={entry.manifest.name}
      description={entry.manifest.description ?? entry.manifest.id}
      status={
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span>{extensionStateLabel(entry)}</span>
          <span className="text-muted-foreground/50">v{entry.manifest.version}</span>
          {baseLabel ? (
            <span className="min-w-0 truncate text-muted-foreground/50">{baseLabel}</span>
          ) : null}
        </span>
      }
      control={
        <code className="max-w-54 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {entry.manifest.id}
        </code>
      }
    />
  );
}

export function ExtensionsSettingsPanel() {
  const queryClient = useQueryClient();
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
  const registry = extensionsQuery.data;
  const installed = registry?.installed ?? [];
  const drafts = registry?.drafts ?? [];
  const isEmpty = installed.length === 0 && drafts.length === 0;

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
          drafts.map((entry) => <ExtensionRow key={entry.path} entry={entry} />)
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
          <SettingsRow
            title="Active recipe"
            description="Variant build and preview controls will land after the local registry is wired."
            status={registry ? `Variants: ${registry.variantsDir}` : undefined}
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
