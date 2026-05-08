// @effect-diagnostics nodeBuiltinImport:off
import { symlink } from "node:fs/promises";

import {
  ExtensionRegistryError,
  ExtensionManifest,
  ExtensionPreviewVariantEntry,
  type ExtensionActiveStack,
  type ExtensionCreateDraftInput,
  type ExtensionCreatePreviewVariantInput,
  type ExtensionInstallPreviewVariantInput,
  type ExtensionKind,
  type ExtensionPatchValidationResult,
  type ExtensionPreviewVariantEntry as ExtensionPreviewVariantEntryType,
  type ExtensionRegistry,
  type ExtensionRegistryEntry,
  type ExtensionSetEnabledInput,
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
const decodePreviewVariant = Schema.decodeEffect(
  Schema.fromJsonString(ExtensionPreviewVariantEntry),
);
const encodePreviewVariant = Schema.encodeEffect(
  Schema.fromJsonString(ExtensionPreviewVariantEntry),
);
const encodeInstallMetadata = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      installedAt: Schema.String,
      sourceVariantId: Schema.String,
      sourceVariantPath: Schema.String,
      baseGitCommit: Schema.optional(Schema.String),
      enabled: Schema.optional(Schema.Boolean),
    }),
  ),
);
const decodeInstallMetadata = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      installedAt: Schema.optional(Schema.String),
      sourceVariantId: Schema.optional(Schema.String),
      sourceVariantPath: Schema.optional(Schema.String),
      baseGitCommit: Schema.optional(Schema.String),
      enabled: Schema.optional(Schema.Boolean),
    }),
  ),
);
const encodeActiveStack = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      builtAt: Schema.String,
      sourceDir: Schema.String,
      enabledExtensionIds: Schema.Array(Schema.String),
    }),
  ),
);
const decodeActiveStack = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      builtAt: Schema.optional(Schema.String),
      sourceDir: Schema.optional(Schema.String),
      enabledExtensionIds: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
);
const DENSE_SIDEBAR_EXTENSION_ID = "t3labs.dense-sidebar";
const DEPENDENCY_LINK_DIRS = [
  "",
  "apps/desktop",
  "apps/marketing",
  "apps/server",
  "apps/web",
  "oxlint-plugin-t3code",
  "packages/client-runtime",
  "packages/contracts",
  "packages/effect-acp",
  "packages/effect-codex-app-server",
  "packages/shared",
  "packages/ssh",
  "packages/tailscale",
  "scripts",
] as const;

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

function errorMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) {
    return cause.message.trim() || undefined;
  }
  if (typeof cause === "string") {
    return cause.trim() || undefined;
  }
  return undefined;
}

function detailWithCause(detail: string, cause: unknown): string {
  const message = errorMessage(cause);
  if (!message) {
    return detail;
  }
  const singleLineMessage = message.replaceAll(/\s+/g, " ").slice(0, 1_000);
  return `${detail}: ${singleLineMessage}`;
}

function resolveGitRoot(
  config: Pick<ServerConfigShape, "cwd">,
): Effect.Effect<string, ExtensionRegistryError> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess("git", ["rev-parse", "--show-toplevel"], {
          cwd: config.cwd,
          outputMode: "truncate",
          maxBufferBytes: 4 * 1024,
          timeoutMs: 10_000,
        }),
      catch: (cause) =>
        registryError({
          path: config.cwd,
          detail: detailWithCause("failed to resolve repository root", cause),
          cause,
        }),
    });
    return result.stdout.trim();
  });
}

function resolvePatchBaseGitRoot(config: Pick<ServerConfigShape, "cwd">) {
  const baseSourceRoot = process.env.T3CODE_EXTENSION_BASE_SOURCE_ROOT?.trim();
  return resolveGitRoot({ cwd: baseSourceRoot || config.cwd });
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

function resolveInstalledPaths(
  config: Pick<ServerConfigShape, "extensionInstalledDir">,
  extensionId: string,
) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    if (!isSafeExtensionDirectoryName(extensionId)) {
      return yield* registryError({
        path: config.extensionInstalledDir,
        detail: "extension id cannot be used as a local installed directory name",
      });
    }
    const installedDir = pathService.join(config.extensionInstalledDir, extensionId);
    return {
      installedDir,
      installMetadataPath: pathService.join(installedDir, "installed.json"),
    };
  });
}

function resolveActivePaths(config: Pick<ServerConfigShape, "extensionInstalledDir">) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const activeDir = pathService.join(pathService.dirname(config.extensionInstalledDir), "active");
    return {
      activeDir,
      sourceDir: pathService.join(activeDir, "source"),
      stackPath: pathService.join(activeDir, "stack.json"),
    };
  });
}

function resolveSlottedActiveSourceDir(input: {
  readonly activeDir: string;
  readonly currentSourceDir: string | undefined;
}) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const sourceA = pathService.join(input.activeDir, "source-a");
    const sourceB = pathService.join(input.activeDir, "source-b");
    if (samePath(input.currentSourceDir, sourceA)) {
      return sourceB;
    }
    return sourceA;
  });
}

function normalizePathForCompare(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && normalizePathForCompare(left) === normalizePathForCompare(right));
}

function isManagedActiveSourceDir(input: {
  readonly activeDir: string;
  readonly sourceDir: string | undefined;
}): boolean {
  if (!input.sourceDir) {
    return false;
  }
  const activeDir = `${normalizePathForCompare(input.activeDir)}/`;
  const sourceDir = normalizePathForCompare(input.sourceDir);
  return (
    sourceDir === `${activeDir}source` ||
    sourceDir === `${activeDir}source-a` ||
    sourceDir === `${activeDir}source-b`
  );
}

function resolveVariantPaths(
  config: Pick<ServerConfigShape, "extensionVariantsDir">,
  input: {
    readonly extensionId: string;
    readonly variantId: string;
  },
) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    if (!isSafeExtensionDirectoryName(input.extensionId)) {
      return yield* registryError({
        path: config.extensionVariantsDir,
        detail: "extension id cannot be used as a local variant directory name",
      });
    }
    if (!isSafeExtensionDirectoryName(input.variantId)) {
      return yield* registryError({
        path: config.extensionVariantsDir,
        detail: "variant id cannot be used as a local variant directory name",
      });
    }
    const variantDir = pathService.join(
      config.extensionVariantsDir,
      input.extensionId,
      input.variantId,
    );
    return {
      variantDir,
      sourceDir: pathService.join(variantDir, "source"),
      manifestPath: pathService.join(variantDir, "variant.json"),
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

function readPreviewVariant(manifestPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(manifestPath).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: manifestPath,
          detail: "failed to read extension preview variant manifest",
          cause,
        }),
      ),
    );
  }).pipe(
    Effect.flatMap((raw) =>
      decodePreviewVariant(raw).pipe(
        Effect.mapError((cause) =>
          registryError({
            path: manifestPath,
            detail: "extension preview variant manifest does not match the v0 schema",
            cause,
          }),
        ),
      ),
    ),
  );
}

function readInstallMetadata(metadataPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(metadataPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return {};
    }
    const raw = yield* fs.readFileString(metadataPath).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: metadataPath,
          detail: "failed to read extension install metadata",
          cause,
        }),
      ),
    );
    return yield* decodeInstallMetadata(raw).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: metadataPath,
          detail: "extension install metadata does not match the v0 schema",
          cause,
        }),
      ),
    );
  });
}

function readUpdatedAt(extensionPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(extensionPath).pipe(Effect.orElseSucceed(() => null));
    return info ? Option.getOrUndefined(info.mtime)?.toISOString() : undefined;
  });
}

function prunePreviewVariants(input: {
  readonly variantsDir: string;
  readonly extensionId: string;
  readonly keepVariantId: string;
}): Effect.Effect<void, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    if (!isSafeExtensionDirectoryName(input.extensionId)) {
      return yield* registryError({
        path: input.variantsDir,
        detail: "extension id cannot be used as a local variant directory name",
      });
    }
    const extensionVariantsDir = pathService.join(input.variantsDir, input.extensionId);
    const variantIds = yield* readDirectoryNames(extensionVariantsDir);
    yield* Effect.forEach(
      variantIds,
      (variantId) => {
        if (variantId === input.keepVariantId) {
          return Effect.void;
        }
        const variantDir = pathService.join(extensionVariantsDir, variantId);
        return fs.remove(variantDir, { recursive: true, force: true }).pipe(
          Effect.mapError((cause) =>
            registryError({
              path: variantDir,
              detail: "failed to prune stale extension preview variant",
              cause,
            }),
          ),
        );
      },
      { concurrency: 4 },
    );
  });
}

function pruneActiveBuildDirectories(input: {
  readonly activeDir: string;
  readonly keepBuildDir?: string;
}): Effect.Effect<void, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const names = yield* readDirectoryNames(input.activeDir);
    yield* Effect.forEach(
      names,
      (name) => {
        const buildDir = pathService.join(input.activeDir, name);
        if (!name.startsWith("build-") || buildDir === input.keepBuildDir) {
          return Effect.void;
        }
        return fs.remove(buildDir, { recursive: true, force: true }).pipe(
          Effect.mapError((cause) =>
            registryError({
              path: buildDir,
              detail: "failed to prune stale active extension build directory",
              cause,
            }),
          ),
        );
      },
      { concurrency: 4 },
    );
  });
}

function pruneInactiveActiveSources(input: {
  readonly activeDir: string;
  readonly keepSourceDirs: ReadonlyArray<string | undefined>;
}): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const names = yield* readDirectoryNames(input.activeDir).pipe(Effect.orElseSucceed(() => []));
    const keep = input.keepSourceDirs.filter((value): value is string => Boolean(value));
    yield* Effect.forEach(
      names,
      (name) => {
        if (name !== "source" && name !== "source-a" && name !== "source-b") {
          return Effect.void;
        }
        const sourceDir = pathService.join(input.activeDir, name);
        if (keep.some((keepDir) => samePath(sourceDir, keepDir))) {
          return Effect.void;
        }
        return fs
          .remove(sourceDir, { recursive: true, force: true })
          .pipe(Effect.catch(() => Effect.void));
      },
      { concurrency: 2 },
    );
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

function writeInstallMetadata(input: {
  readonly path: string;
  readonly installedAt: string;
  readonly sourceVariantId?: string;
  readonly sourceVariantPath?: string;
  readonly baseGitCommit?: string;
  readonly enabled: boolean;
}): Effect.Effect<void, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const encoded = yield* encodeInstallMetadata({
      installedAt: input.installedAt,
      sourceVariantId: input.sourceVariantId ?? "",
      sourceVariantPath: input.sourceVariantPath ?? "",
      ...(input.baseGitCommit ? { baseGitCommit: input.baseGitCommit } : {}),
      enabled: input.enabled,
    }).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: input.path,
          detail: "failed to encode extension install metadata",
          cause,
        }),
      ),
    );
    yield* writeDraftFile({
      path: input.path,
      contents: `${encoded}\n`,
    });
  });
}

function linkDependencyInstalls(input: {
  readonly repositoryRoot: string;
  readonly sourceDir: string;
}): Effect.Effect<void, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* Effect.forEach(
      DEPENDENCY_LINK_DIRS,
      (relativeDir) =>
        Effect.gen(function* () {
          const baseDir = relativeDir
            ? pathService.join(input.repositoryRoot, relativeDir)
            : input.repositoryRoot;
          const target = pathService.join(baseDir, "node_modules");
          const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
          if (!exists) {
            return;
          }
          const linkParent = relativeDir
            ? pathService.join(input.sourceDir, relativeDir)
            : input.sourceDir;
          const link = pathService.join(linkParent, "node_modules");
          const linkExists = yield* fs.exists(link).pipe(Effect.orElseSucceed(() => false));
          if (linkExists) {
            return;
          }
          yield* Effect.tryPromise({
            try: () => symlink(target, link, process.platform === "win32" ? "junction" : "dir"),
            catch: (cause) =>
              registryError({
                path: link,
                detail: detailWithCause("failed to link extension source dependencies", cause),
                cause,
              }),
          });
        }),
      { concurrency: 4 },
    );
  });
}

function copyDraftDirectory(input: {
  readonly fromDir: string;
  readonly toDir: string;
}): Effect.Effect<void, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const names = yield* fs.readDirectory(input.fromDir).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: input.fromDir,
          detail: "failed to read extension draft directory",
          cause,
        }),
      ),
    );
    yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          const sourcePath = pathService.join(input.fromDir, name);
          const targetPath = pathService.join(input.toDir, name);
          const info = yield* fs.stat(sourcePath).pipe(
            Effect.mapError((cause) =>
              registryError({
                path: sourcePath,
                detail: "failed to inspect extension draft file",
                cause,
              }),
            ),
          );
          if (info.type === "Directory") {
            return yield* copyDraftDirectory({ fromDir: sourcePath, toDir: targetPath });
          }
          if (info.type !== "File") {
            return;
          }
          const contents = yield* fs.readFileString(sourcePath).pipe(
            Effect.mapError((cause) =>
              registryError({
                path: sourcePath,
                detail: "failed to read extension draft file",
                cause,
              }),
            ),
          );
          yield* writeDraftFile({
            path: targetPath,
            contents,
          });
        }),
      { concurrency: 8 },
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
            const { manifest, updatedAt } = yield* Effect.all({
              manifest: readManifest(manifestPath),
              updatedAt: readUpdatedAt(extensionPath),
            });
            const installMetadata =
              input.kind === "installed"
                ? yield* readInstallMetadata(pathService.join(extensionPath, "installed.json"))
                : undefined;
            const state =
              input.kind === "draft"
                ? "draft"
                : installMetadata?.enabled === false
                  ? "disabled"
                  : "enabled";
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

function readVariantEntries(
  variantsDir: string,
): Effect.Effect<
  ExtensionPreviewVariantEntryType[],
  ExtensionRegistryError,
  FileSystem.FileSystem | Path.Path
> {
  return readDirectoryNames(variantsDir).pipe(
    Effect.flatMap((extensionIds) =>
      Effect.forEach(
        extensionIds,
        (extensionId) =>
          Effect.gen(function* () {
            const pathService = yield* Path.Path;
            const extensionVariantsDir = pathService.join(variantsDir, extensionId);
            const variantIds = yield* readDirectoryNames(extensionVariantsDir);
            return yield* Effect.forEach(
              variantIds,
              (variantId) =>
                Effect.gen(function* () {
                  const fs = yield* FileSystem.FileSystem;
                  const manifestPath = pathService.join(
                    extensionVariantsDir,
                    variantId,
                    "variant.json",
                  );
                  const exists = yield* fs
                    .exists(manifestPath)
                    .pipe(Effect.orElseSucceed(() => false));
                  if (!exists) {
                    return [];
                  }
                  return [yield* readPreviewVariant(manifestPath)];
                }),
              { concurrency: 4 },
            ).pipe(Effect.map((entries) => entries.flat()));
          }),
        { concurrency: 4 },
      ).pipe(Effect.map((entries) => entries.flat())),
    ),
    Effect.map((entries) =>
      entries.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
    ),
  );
}

function readActiveStack(
  config: Pick<ServerConfigShape, "extensionInstalledDir"> &
    Partial<Pick<ServerConfigShape, "cwd">>,
  installed: ReadonlyArray<ExtensionRegistryEntry>,
): Effect.Effect<ExtensionActiveStack, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const activePaths = yield* resolveActivePaths(config);
    const desiredExtensionIds = installed
      .filter((entry) => entry.state === "enabled")
      .map((entry) => entry.manifest.id)
      .toSorted((left, right) => left.localeCompare(right));

    const stackExists = yield* fs
      .exists(activePaths.stackPath)
      .pipe(Effect.orElseSucceed(() => false));
    const storedStack = stackExists
      ? yield* fs.readFileString(activePaths.stackPath).pipe(
          Effect.flatMap((raw) => decodeActiveStack(raw)),
          Effect.mapError((cause) =>
            registryError({
              path: activePaths.stackPath,
              detail: "failed to read active extension stack metadata",
              cause,
            }),
          ),
        )
      : {};
    const sourceDir = storedStack.sourceDir ?? activePaths.sourceDir;
    const builtExtensionIds = (storedStack.enabledExtensionIds ?? [])
      .filter(isSafeExtensionDirectoryName)
      .toSorted((left, right) => left.localeCompare(right));
    const currentSourceDir = config.cwd ? yield* resolveGitRoot({ cwd: config.cwd }) : undefined;
    const runningActiveSource = samePath(currentSourceDir, sourceDir);
    const stackMatchesDesired =
      desiredExtensionIds.length === builtExtensionIds.length &&
      desiredExtensionIds.every((id, index) => id === builtExtensionIds[index]);
    const restartRequired =
      !stackMatchesDesired || (desiredExtensionIds.length > 0 && !runningActiveSource);

    return {
      activeDir: activePaths.activeDir,
      sourceDir,
      stackPath: activePaths.stackPath,
      desiredExtensionIds,
      builtExtensionIds,
      ...(currentSourceDir ? { currentSourceDir } : {}),
      ...(storedStack.builtAt ? { builtAt: storedStack.builtAt } : {}),
      runningActiveSource,
      restartRequired,
    };
  });
}

export function listExtensions(
  config: Pick<
    ServerConfigShape,
    "extensionInstalledDir" | "extensionDraftsDir" | "extensionVariantsDir"
  > &
    Partial<Pick<ServerConfigShape, "cwd">>,
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
    variants: readVariantEntries(config.extensionVariantsDir),
  }).pipe(
    Effect.flatMap(({ installed, drafts, variants }) =>
      readActiveStack(config, installed).pipe(
        Effect.map((activeStack) => ({
          installedDir: config.extensionInstalledDir,
          draftsDir: config.extensionDraftsDir,
          variantsDir: config.extensionVariantsDir,
          installed,
          drafts,
          variants,
          activeStack,
        })),
      ),
    ),
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

function readInstalledPatchEntries(
  config: Pick<ServerConfigShape, "extensionInstalledDir">,
): Effect.Effect<
  {
    readonly entry: ExtensionRegistryEntry;
    readonly patchPath: string;
    readonly installMetadataPath: string;
  }[],
  ExtensionRegistryError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const installed = yield* readEntries({
      directoryPath: config.extensionInstalledDir,
      kind: "installed",
    });
    return installed
      .map((entry) => ({
        entry,
        patchPath: pathService.join(entry.path, "patches", "app.patch"),
        installMetadataPath: pathService.join(entry.path, "installed.json"),
      }))
      .toSorted((left, right) => left.entry.manifest.id.localeCompare(right.entry.manifest.id));
  });
}

function rebuildActiveExtensionStack(
  config: Pick<ServerConfigShape, "cwd" | "extensionInstalledDir">,
  input: {
    readonly extensionId: string;
    readonly enabled: boolean;
  },
): Effect.Effect<void, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const repositoryRoot = yield* resolvePatchBaseGitRoot(config);
    const activePaths = yield* resolveActivePaths(config);
    const currentSourceDir = yield* resolveGitRoot({ cwd: config.cwd }).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const replacingRunningSource = isManagedActiveSourceDir({
      activeDir: activePaths.activeDir,
      sourceDir: currentSourceDir,
    });
    const publishSourceDir = replacingRunningSource
      ? yield* resolveSlottedActiveSourceDir({
          activeDir: activePaths.activeDir,
          currentSourceDir,
        })
      : activePaths.sourceDir;
    const buildId = `build-${DateTime.formatIso(yield* DateTime.now)
      .replace(/[^0-9a-z]/gi, "")
      .toLowerCase()}`;
    const buildDir = pathService.join(activePaths.activeDir, buildId);
    const buildSourceDir = pathService.join(buildDir, "source");
    const installedEntries = yield* readInstalledPatchEntries(config);
    const enabledEntries = installedEntries.filter(({ entry }) =>
      entry.manifest.id === input.extensionId ? input.enabled : entry.state === "enabled",
    );
    yield* pruneActiveBuildDirectories({
      activeDir: activePaths.activeDir,
      keepBuildDir: buildDir,
    });

    const build = Effect.gen(function* () {
      yield* fs.makeDirectory(buildDir, { recursive: true }).pipe(
        Effect.mapError((cause) =>
          registryError({
            path: buildDir,
            detail: "failed to prepare active extension build directory",
            cause,
          }),
        ),
      );
      yield* Effect.tryPromise({
        try: () =>
          runProcess(
            "git",
            [
              "-c",
              "core.longpaths=true",
              "clone",
              "--no-hardlinks",
              "--local",
              repositoryRoot,
              buildSourceDir,
            ],
            {
              cwd: repositoryRoot,
              outputMode: "truncate",
              maxBufferBytes: 64 * 1024,
              timeoutMs: 60_000,
            },
          ),
        catch: (cause) =>
          registryError({
            path: buildSourceDir,
            detail: detailWithCause("failed to materialize active extension source", cause),
            cause,
          }),
      });
      yield* linkDependencyInstalls({ repositoryRoot, sourceDir: buildSourceDir });

      for (const { entry, patchPath } of enabledEntries) {
        const patchExists = yield* fs.exists(patchPath).pipe(Effect.orElseSucceed(() => false));
        if (!patchExists) {
          return yield* registryError({
            path: patchPath,
            detail: `${entry.manifest.name} does not include patches/app.patch`,
          });
        }
        yield* Effect.tryPromise({
          try: () =>
            runProcess("git", ["-c", "core.longpaths=true", "apply", patchPath], {
              cwd: buildSourceDir,
              outputMode: "truncate",
              maxBufferBytes: 64 * 1024,
              timeoutMs: 15_000,
            }),
          catch: (cause) =>
            registryError({
              path: patchPath,
              detail: detailWithCause(`failed to apply ${entry.manifest.name}`, cause),
              cause,
            }),
        });
      }

      const stack = yield* encodeActiveStack({
        builtAt: DateTime.formatIso(yield* DateTime.now),
        sourceDir: publishSourceDir,
        enabledExtensionIds: enabledEntries.map(({ entry }) => entry.manifest.id),
      }).pipe(
        Effect.mapError((cause) =>
          registryError({
            path: activePaths.stackPath,
            detail: "failed to encode active extension stack metadata",
            cause,
          }),
        ),
      );
      yield* fs.remove(publishSourceDir, { recursive: true, force: true }).pipe(
        Effect.mapError((cause) =>
          registryError({
            path: publishSourceDir,
            detail: "failed to replace active extension source",
            cause,
          }),
        ),
      );
      yield* fs.rename(buildSourceDir, publishSourceDir).pipe(
        Effect.mapError((cause) =>
          registryError({
            path: publishSourceDir,
            detail: "failed to publish active extension source",
            cause,
          }),
        ),
      );
      yield* writeDraftFile({
        path: activePaths.stackPath,
        contents: `${stack}\n`,
      });
    });

    yield* build.pipe(
      Effect.catch((error) =>
        fs.remove(buildDir, { recursive: true, force: true }).pipe(
          Effect.catch(() => Effect.void),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
      Effect.andThen(
        fs.remove(buildDir, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void)),
      ),
      Effect.andThen(
        pruneActiveBuildDirectories({ activeDir: activePaths.activeDir }).pipe(
          Effect.catch(() => Effect.void),
        ),
      ),
      Effect.andThen(
        pruneInactiveActiveSources({
          activeDir: activePaths.activeDir,
          keepSourceDirs: [publishSourceDir, currentSourceDir],
        }),
      ),
    );
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
    const repositoryRoot = yield* resolvePatchBaseGitRoot(config);

    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess("git", ["-c", "core.longpaths=true", "apply", "--check", patchPath], {
          cwd: repositoryRoot,
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

export function validateInstalledExtension(
  config: Pick<ServerConfigShape, "cwd" | "extensionInstalledDir">,
  input: ExtensionValidateDraftInput,
): Effect.Effect<
  ExtensionPatchValidationResult,
  ExtensionRegistryError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const extensionId = input.extensionId;
    const { installedDir } = yield* resolveInstalledPaths(config, extensionId);
    const manifestPath = pathService.join(installedDir, "manifest.json");
    const patchPath = pathService.join(installedDir, "patches", "app.patch");
    const installedExists = yield* fs.exists(installedDir).pipe(Effect.orElseSucceed(() => false));
    if (!installedExists) {
      return yield* registryError({
        path: installedDir,
        detail: "installed extension does not exist",
      });
    }
    yield* readManifest(manifestPath);
    const patchExists = yield* fs.exists(patchPath).pipe(Effect.orElseSucceed(() => false));
    if (!patchExists) {
      return yield* registryError({
        path: patchPath,
        detail: "installed extension does not include patches/app.patch",
      });
    }
    const repositoryRoot = yield* resolvePatchBaseGitRoot(config);
    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess("git", ["-c", "core.longpaths=true", "apply", "--check", patchPath], {
          cwd: repositoryRoot,
          allowNonZeroExit: true,
          outputMode: "truncate",
          maxBufferBytes: 64 * 1024,
          timeoutMs: 15_000,
        }),
      catch: (cause) =>
        registryError({
          path: patchPath,
          detail: "failed to run installed extension validation",
          cause,
        }),
    });
    const detail =
      result.code === 0
        ? "Installed patch still applies cleanly."
        : result.stderr.trim() || result.stdout.trim() || "Installed patch no longer applies.";
    return {
      extensionId,
      patchPath,
      valid: result.code === 0,
      detail,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
}

export function createExtensionPreviewVariant(
  config: Pick<ServerConfigShape, "cwd" | "extensionDraftsDir" | "extensionVariantsDir">,
  input: ExtensionCreatePreviewVariantInput,
): Effect.Effect<
  ExtensionPreviewVariantEntryType,
  ExtensionRegistryError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const now = yield* DateTime.now;
    const extensionId = input.extensionId;
    const repositoryRoot = yield* resolvePatchBaseGitRoot(config);
    const validation = yield* validateExtensionDraft(config, { extensionId });
    if (!validation.valid) {
      return yield* registryError({
        path: validation.patchPath,
        detail: validation.detail,
      });
    }

    const variantId = `preview-${DateTime.formatIso(now)
      .replace(/[^0-9a-z]/gi, "")
      .toLowerCase()}`;
    const { variantDir, sourceDir, manifestPath } = yield* resolveVariantPaths(config, {
      extensionId,
      variantId,
    });
    yield* fs.makeDirectory(variantDir, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: variantDir,
          detail: "failed to prepare extension preview variant directory",
          cause,
        }),
      ),
    );

    const revParseResult = yield* Effect.tryPromise(() =>
      runProcess("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        allowNonZeroExit: true,
        outputMode: "truncate",
        maxBufferBytes: 4 * 1024,
        timeoutMs: 10_000,
      }),
    ).pipe(Effect.orElseSucceed(() => undefined));
    const baseGitCommit =
      revParseResult && revParseResult.code === 0 ? revParseResult.stdout.trim() : undefined;

    yield* fs
      .remove(sourceDir, { recursive: true, force: true })
      .pipe(Effect.catch(() => Effect.void));
    yield* Effect.tryPromise({
      try: () =>
        runProcess(
          "git",
          [
            "-c",
            "core.longpaths=true",
            "clone",
            "--no-hardlinks",
            "--local",
            repositoryRoot,
            sourceDir,
          ],
          {
            cwd: repositoryRoot,
            outputMode: "truncate",
            maxBufferBytes: 64 * 1024,
            timeoutMs: 60_000,
          },
        ),
      catch: (cause) =>
        registryError({
          path: sourceDir,
          detail: detailWithCause("failed to materialize extension preview source", cause),
          cause,
        }),
    });
    yield* linkDependencyInstalls({ repositoryRoot, sourceDir });
    yield* Effect.tryPromise({
      try: () =>
        runProcess("git", ["-c", "core.longpaths=true", "apply", validation.patchPath], {
          cwd: sourceDir,
          outputMode: "truncate",
          maxBufferBytes: 64 * 1024,
          timeoutMs: 15_000,
        }),
      catch: (cause) =>
        registryError({
          path: validation.patchPath,
          detail: detailWithCause("failed to apply extension patch to preview variant", cause),
          cause,
        }),
    });

    const variant = {
      extensionId,
      variantId,
      path: variantDir,
      sourceDir,
      patchPath: validation.patchPath,
      status: "ready",
      detail: "Preview source variant is ready.",
      createdAt: DateTime.formatIso(now),
      ...(baseGitCommit ? { baseGitCommit } : {}),
    } satisfies ExtensionPreviewVariantEntryType;
    const encoded = yield* encodePreviewVariant(variant).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: manifestPath,
          detail: "failed to encode extension preview variant manifest",
          cause,
        }),
      ),
    );
    yield* writeDraftFile({
      path: manifestPath,
      contents: `${encoded}\n`,
    });
    yield* prunePreviewVariants({
      variantsDir: config.extensionVariantsDir,
      extensionId,
      keepVariantId: variantId,
    });
    return variant;
  });
}

export function installExtensionPreviewVariant(
  config: Pick<
    ServerConfigShape,
    "extensionDraftsDir" | "extensionInstalledDir" | "extensionVariantsDir"
  >,
  input: ExtensionInstallPreviewVariantInput,
): Effect.Effect<ExtensionRegistry, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const now = yield* DateTime.now;
    const { draftDir, manifestPath } = yield* resolveDraftPaths(config, input.extensionId);
    const { installedDir, installMetadataPath } = yield* resolveInstalledPaths(
      config,
      input.extensionId,
    );
    const { manifestPath: variantManifestPath } = yield* resolveVariantPaths(config, input);

    const draftExists = yield* fs.exists(draftDir).pipe(Effect.orElseSucceed(() => false));
    if (!draftExists) {
      return yield* registryError({
        path: draftDir,
        detail: "extension draft does not exist",
      });
    }
    yield* readManifest(manifestPath);

    const variant = yield* readPreviewVariant(variantManifestPath);
    if (variant.status !== "ready") {
      return yield* registryError({
        path: variantManifestPath,
        detail: "only ready preview variants can be installed",
      });
    }
    if (variant.extensionId !== input.extensionId) {
      return yield* registryError({
        path: variantManifestPath,
        detail: "preview variant does not belong to the requested extension",
      });
    }

    yield* fs.remove(installedDir, { recursive: true, force: true }).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: installedDir,
          detail: "failed to replace installed extension",
          cause,
        }),
      ),
    );
    yield* copyDraftDirectory({ fromDir: draftDir, toDir: installedDir });
    yield* writeInstallMetadata({
      path: installMetadataPath,
      installedAt: DateTime.formatIso(now),
      sourceVariantId: variant.variantId,
      sourceVariantPath: variant.path,
      ...(variant.baseGitCommit ? { baseGitCommit: variant.baseGitCommit } : {}),
      enabled: false,
    });

    return yield* listExtensions(config);
  });
}

export function setExtensionEnabled(
  config: Pick<
    ServerConfigShape,
    "cwd" | "extensionDraftsDir" | "extensionInstalledDir" | "extensionVariantsDir"
  >,
  input: ExtensionSetEnabledInput,
): Effect.Effect<ExtensionRegistry, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const now = yield* DateTime.now;
    const { installedDir, installMetadataPath } = yield* resolveInstalledPaths(
      config,
      input.extensionId,
    );
    const installedExists = yield* fs.exists(installedDir).pipe(Effect.orElseSucceed(() => false));
    if (!installedExists) {
      return yield* registryError({
        path: installedDir,
        detail: "installed extension does not exist",
      });
    }
    const metadata = yield* readInstallMetadata(installMetadataPath);
    if (metadata.enabled === input.enabled) {
      return yield* listExtensions(config);
    }

    yield* rebuildActiveExtensionStack(config, input);
    yield* writeInstallMetadata({
      path: installMetadataPath,
      installedAt: metadata.installedAt ?? DateTime.formatIso(now),
      ...(metadata.sourceVariantId ? { sourceVariantId: metadata.sourceVariantId } : {}),
      ...(metadata.sourceVariantPath ? { sourceVariantPath: metadata.sourceVariantPath } : {}),
      ...(metadata.baseGitCommit ? { baseGitCommit: metadata.baseGitCommit } : {}),
      enabled: input.enabled,
    });
    return yield* listExtensions(config);
  });
}

export function uninstallExtension(
  config: Pick<
    ServerConfigShape,
    "extensionDraftsDir" | "extensionInstalledDir" | "extensionVariantsDir"
  >,
  input: ExtensionValidateDraftInput,
): Effect.Effect<ExtensionRegistry, ExtensionRegistryError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { installedDir } = yield* resolveInstalledPaths(config, input.extensionId);
    const installedExists = yield* fs.exists(installedDir).pipe(Effect.orElseSucceed(() => false));
    if (!installedExists) {
      return yield* listExtensions(config);
    }
    yield* fs.remove(installedDir, { recursive: true, force: true }).pipe(
      Effect.mapError((cause) =>
        registryError({
          path: installedDir,
          detail: "failed to uninstall extension",
          cause,
        }),
      ),
    );
    return yield* listExtensions(config);
  });
}
