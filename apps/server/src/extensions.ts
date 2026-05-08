import {
  ExtensionRegistryError,
  ExtensionManifest,
  type ExtensionCreateDraftInput,
  type ExtensionKind,
  type ExtensionPatchValidationResult,
  type ExtensionRegistry,
  type ExtensionRegistryEntry,
  type ExtensionValidateDraftInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ServerConfigShape } from "./config.ts";
import { runProcess } from "./processRunner.ts";

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(ExtensionManifest));
const DENSE_SIDEBAR_EXTENSION_ID = "t3labs.dense-sidebar";

const DENSE_SIDEBAR_MANIFEST_JSON = `{
  "id": "t3labs.dense-sidebar",
  "publisher": "t3labs",
  "name": "Dense Sidebar",
  "version": "0.0.1",
  "description": "Makes thread rows and project headers more compact."
}
`;

const DENSE_SIDEBAR_README = `# Dense Sidebar

This draft is a first-party example of a T3 patch extension.

It contributes one unified diff under \`patches/app.patch\`. The patch only touches web UI source and makes sidebar rows denser by reducing row height and vertical padding.
`;

const DENSE_SIDEBAR_PATCH = `diff --git a/apps/web/src/components/Sidebar.logic.ts b/apps/web/src/components/Sidebar.logic.ts
--- a/apps/web/src/components/Sidebar.logic.ts
+++ b/apps/web/src/components/Sidebar.logic.ts
@@ -279,6 +279,6 @@ export function resolveThreadRowClassName(input: {
   isSelected: boolean;
 }): string {
-  const baseClassName =
-    "h-7 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
+  const baseClassName =
+    "h-6 w-full translate-x-0 cursor-pointer justify-start px-1.5 text-left text-[11px] select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
 
   if (input.isSelected && input.isActive) {
diff --git a/apps/web/src/components/Sidebar.tsx b/apps/web/src/components/Sidebar.tsx
--- a/apps/web/src/components/Sidebar.tsx
+++ b/apps/web/src/components/Sidebar.tsx
@@ -1984,6 +1984,6 @@ const SidebarProjectItem = memo(function SidebarProjectItem(props: SidebarProject
         <SidebarMenuButton
           ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
           size="sm"
-          className={\`gap-2 px-2 py-1.5 pr-8 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground max-sm:pr-14 \${
+          className={\`gap-1.5 px-1.5 py-1 pr-7 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground max-sm:pr-14 \${
             isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
           }\`}
`;

function registryError(input: {
  readonly path: string;
  readonly detail: string;
  readonly cause?: unknown;
}) {
  return new ExtensionRegistryError({
    path: input.path,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function isSafeExtensionDirectoryName(extensionId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(extensionId) && !extensionId.includes("..");
}

function readDirectoryNames(directoryPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const exists = yield* fs.exists(directoryPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [];
    }
    const names = yield* fs.readDirectory(directoryPath).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: directoryPath,
          detail: "failed to read extension directory",
          cause,
        }),
      ),
    );
    const directoryNames = [];
    for (const name of names) {
      const entryPath = pathService.join(directoryPath, name);
      const info = yield* fs.stat(entryPath).pipe(Effect.orElseSucceed(() => null));
      if (info?.type === "Directory") {
        directoryNames.push(name);
      }
    }
    return directoryNames.toSorted((left, right) => left.localeCompare(right));
  });
}

function resolveDraftPaths(
  config: Pick<ServerConfigShape, "extensionDraftsDir">,
  extensionId: string,
) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    if (!isSafeExtensionDirectoryName(extensionId)) {
      return yield* registryError({
        path: config.extensionDraftsDir,
        detail: "extension id cannot be used as a local draft directory name",
      });
    }
    const draftDir = pathService.join(config.extensionDraftsDir, extensionId);
    return {
      draftDir,
      manifestPath: pathService.join(draftDir, "manifest.json"),
      patchPath: pathService.join(draftDir, "patches", "app.patch"),
    };
  });
}

function readManifest(manifestPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(manifestPath).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: manifestPath,
          detail: "failed to read extension manifest",
          cause,
        }),
      ),
    );
  }).pipe(
    Effect.flatMap((raw) =>
      decodeManifest(raw).pipe(
        Effect.mapError((cause) =>
          registryError({
            path: manifestPath,
            detail: "extension manifest does not match the v0 schema",
            cause,
          }),
        ),
      ),
    ),
  );
}

function readUpdatedAt(extensionPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(extensionPath).pipe(Effect.orElseSucceed(() => null));
    return info ? Option.getOrUndefined(info.mtime)?.toISOString() : undefined;
  });
}

function writeDraftFile(input: {
  readonly path: string;
  readonly contents: string;
}): Effect.Effect<void, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(input.path), { recursive: true }).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: input.path,
          detail: "failed to prepare extension draft directory",
          cause,
        }),
      ),
    );
    yield* fs.writeFileString(input.path, input.contents).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: input.path,
          detail: "failed to write extension draft file",
          cause,
        }),
      ),
    );
  });
}

function createDenseSidebarDraft(
  config: Pick<ServerConfigShape, "extensionDraftsDir">,
): Effect.Effect<void, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const draftDir = pathService.join(config.extensionDraftsDir, DENSE_SIDEBAR_EXTENSION_ID);
    yield* writeDraftFile({
      path: pathService.join(draftDir, "manifest.json"),
      contents: DENSE_SIDEBAR_MANIFEST_JSON,
    });
    yield* writeDraftFile({
      path: pathService.join(draftDir, "README.md"),
      contents: DENSE_SIDEBAR_README,
    });
    yield* writeDraftFile({
      path: pathService.join(draftDir, "patches", "app.patch"),
      contents: DENSE_SIDEBAR_PATCH,
    });
  });
}

function readEntries(input: {
  readonly directoryPath: string;
  readonly kind: ExtensionKind;
}): Effect.Effect<
  ExtensionRegistryEntry[],
  ExtensionRegistryError,
  FileSystem.FileSystem | Path.Path
> {
  return readDirectoryNames(input.directoryPath).pipe(
    Effect.flatMap((directoryNames) =>
      Effect.forEach(
        directoryNames,
        (directoryName) =>
          Effect.gen(function* () {
            const pathService = yield* Path.Path;
            const extensionPath = pathService.join(input.directoryPath, directoryName);
            const manifestPath = pathService.join(extensionPath, "manifest.json");
            const state = input.kind === "draft" ? "draft" : "enabled";
            const { manifest, updatedAt } = yield* Effect.all({
              manifest: readManifest(manifestPath),
              updatedAt: readUpdatedAt(extensionPath),
            });
            return {
              kind: input.kind,
              state,
              manifest,
              path: extensionPath,
              ...(updatedAt ? { updatedAt } : {}),
            } satisfies ExtensionRegistryEntry;
          }),
        { concurrency: 8 },
      ),
    ),
  );
}

export function listExtensions(
  config: Pick<
    ServerConfigShape,
    "extensionInstalledDir" | "extensionDraftsDir" | "extensionVariantsDir"
  >,
): Effect.Effect<ExtensionRegistry, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.all({
    installed: readEntries({
      directoryPath: config.extensionInstalledDir,
      kind: "installed",
    }),
    drafts: readEntries({
      directoryPath: config.extensionDraftsDir,
      kind: "draft",
    }),
  }).pipe(
    Effect.map(({ installed, drafts }) => ({
      installedDir: config.extensionInstalledDir,
      draftsDir: config.extensionDraftsDir,
      variantsDir: config.extensionVariantsDir,
      installed,
      drafts,
    })),
  );
}

export function createExtensionDraft(
  config: Pick<
    ServerConfigShape,
    "extensionInstalledDir" | "extensionDraftsDir" | "extensionVariantsDir"
  >,
  input: ExtensionCreateDraftInput,
): Effect.Effect<ExtensionRegistry, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    switch (input.templateId) {
      case "dense-sidebar":
        yield* createDenseSidebarDraft(config);
        break;
    }
    return yield* listExtensions(config);
  });
}

export function validateExtensionDraft(
  config: Pick<ServerConfigShape, "cwd" | "extensionDraftsDir">,
  input: ExtensionValidateDraftInput,
): Effect.Effect<
  ExtensionPatchValidationResult,
  ExtensionRegistryError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const extensionId = input.extensionId;
    const { draftDir, manifestPath, patchPath } = yield* resolveDraftPaths(config, extensionId);
    const draftExists = yield* fs.exists(draftDir).pipe(Effect.orElseSucceed(() => false));
    if (!draftExists) {
      return yield* registryError({
        path: draftDir,
        detail: "extension draft does not exist",
      });
    }
    yield* readManifest(manifestPath);
    const patchExists = yield* fs.exists(patchPath).pipe(Effect.orElseSucceed(() => false));
    if (!patchExists) {
      return yield* registryError({
        path: patchPath,
        detail: "extension draft does not include patches/app.patch",
      });
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess("git", ["apply", "--check", patchPath], {
          cwd: config.cwd,
          allowNonZeroExit: true,
          outputMode: "truncate",
          maxBufferBytes: 64 * 1024,
          timeoutMs: 15_000,
        }),
      catch: (cause) =>
        registryError({
          path: patchPath,
          detail: "failed to run patch validation",
          cause,
        }),
    });
    const detail =
      result.code === 0
        ? "Patch applies cleanly."
        : result.stderr.trim() || result.stdout.trim() || "Patch does not apply cleanly.";
    return {
      extensionId,
      patchPath,
      valid: result.code === 0,
      detail,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
}
