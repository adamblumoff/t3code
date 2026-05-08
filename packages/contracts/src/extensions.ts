import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ExtensionId = TrimmedNonEmptyString.pipe(Schema.brand("ExtensionId"));
export type ExtensionId = typeof ExtensionId.Type;

export const ExtensionVersion = TrimmedNonEmptyString.pipe(Schema.brand("ExtensionVersion"));
export type ExtensionVersion = typeof ExtensionVersion.Type;

export const ExtensionBaseBuild = Schema.Struct({
  channel: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  gitCommit: Schema.optional(TrimmedNonEmptyString),
});
export type ExtensionBaseBuild = typeof ExtensionBaseBuild.Type;

export const ExtensionManifest = Schema.Struct({
  id: ExtensionId,
  publisher: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: ExtensionVersion,
  description: Schema.optional(TrimmedNonEmptyString),
  generatedAgainst: Schema.optional(ExtensionBaseBuild),
});
export type ExtensionManifest = typeof ExtensionManifest.Type;

export const ExtensionInstallState = Schema.Literals([
  "draft",
  "enabled",
  "disabled",
  "incompatible",
]);
export type ExtensionInstallState = typeof ExtensionInstallState.Type;

export const ExtensionKind = Schema.Literals(["installed", "draft"]);
export type ExtensionKind = typeof ExtensionKind.Type;

export const ExtensionRegistryEntry = Schema.Struct({
  kind: ExtensionKind,
  state: ExtensionInstallState,
  manifest: ExtensionManifest,
  path: TrimmedNonEmptyString,
  status: Schema.optional(TrimmedNonEmptyString),
  updatedAt: Schema.optional(IsoDateTime),
});
export type ExtensionRegistryEntry = typeof ExtensionRegistryEntry.Type;

export const ExtensionRegistry = Schema.Struct({
  installedDir: TrimmedNonEmptyString,
  draftsDir: TrimmedNonEmptyString,
  variantsDir: TrimmedNonEmptyString,
  installed: Schema.Array(ExtensionRegistryEntry),
  drafts: Schema.Array(ExtensionRegistryEntry),
});
export type ExtensionRegistry = typeof ExtensionRegistry.Type;

export const ExtensionDraftTemplateId = Schema.Literal("dense-sidebar");
export type ExtensionDraftTemplateId = typeof ExtensionDraftTemplateId.Type;

export const ExtensionCreateDraftInput = Schema.Struct({
  templateId: ExtensionDraftTemplateId,
});
export type ExtensionCreateDraftInput = typeof ExtensionCreateDraftInput.Type;

export class ExtensionRegistryError extends Schema.TaggedErrorClass<ExtensionRegistryError>()(
  "ExtensionRegistryError",
  {
    path: Schema.String,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Extension registry error at ${this.path}: ${this.detail}`;
  }
}
