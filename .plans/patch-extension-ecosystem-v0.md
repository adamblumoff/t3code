# Patch Extension Ecosystem V0

## Product Direction

T3 extensions should let users modify the app without maintaining forks, branches, or long-running PRs. The ecosystem should feel closer to VS Code's extension marketplace in outcome: users can add UI behavior, visual changes, and app customizations locally, then share the useful ones.

The v0 direction is not controlled prompt packs or a narrow command/workflow API. T3 already lives in a world where agents and skills can create prompts. The extension system should focus on app customization.

## Core Model

An extension is a versioned patch bundle that targets a packaged T3 source snapshot.

The user experience should be:

1. User describes or imports a UI customization.
2. Patch Studio creates a draft extension bundle.
3. T3 applies the patch to a user-local copy of the packaged source snapshot.
4. T3 builds a disposable patched variant.
5. User previews the patched app side-by-side.
6. User installs, rejects, disables, repairs, or shares the extension.

The official clean T3 install must remain recoverable. Extensions should not mutate the live official app in place.

## Extension Bundle Shape

Extensions should be shareable as `.t3x` bundles. Internally, the bundle can be a zip-like folder:

```txt
manifest.json
patches/app.patch
files/
screenshots/
README.md
```

The patch is the source of truth for changes to T3-owned files. Extension-owned files must be namespaced by extension id.

Example identity:

```json
{
  "id": "publisher.dense-sidebar",
  "publisher": "publisher",
  "name": "Dense Sidebar",
  "version": "0.0.1"
}
```

Installed extension versions are immutable. Repairs or edits create a new draft/version.

## V0 Boundaries

V0 should stay focused enough to prove the loop without becoming a package manager or fork engine.

Allow:

- Web UI patches under `apps/web/**`.
- Extension-owned source/assets under a namespaced extension directory.
- Unified diff patches.
- Same-file patches when hunks apply cleanly.
- New extension-owned web routes/pages.
- Web CSS/global style changes, with clear labeling.
- Namespaced client-side extension settings/state.
- Stable and nightly base builds.

Do not allow in v0:

- Server, desktop, shared package, contracts, script, lockfile, or package manager changes.
- New third-party dependencies.
- Direct patches to generated files.
- Silent destructive settings or user-data migrations.
- Marketplace install without preview.
- Auto-update of extensions.
- Dependency graphs between extensions.

## Variants And Recipes

The source of truth for the user's modified app is a recipe:

```txt
base build + enabled extension versions + patch order
```

Patched variants are disposable build outputs. T3 should be able to rebuild them from the recipe.

For v0, keep one global active recipe. Use install order as patch order. Named recipes and user-controlled reordering can come later.

Patch failures are extension-scoped:

- If one extension fails to apply, mark that extension incompatible.
- Continue applying later extensions when possible.
- If a later extension applies cleanly without the failed one, keep it.
- Do not let one broken extension block the whole app.

Startup should never block on patch builds. If no valid patched variant exists, launch clean T3 and show that the recipe needs build/repair.

## Source Snapshots

Packaged T3 builds should include, or be able to fetch, a minimal source snapshot for the exact build. Nightlies must participate in the same system.

For web-only v0, the snapshot should include enough to rebuild the web app, but path policy should only allow modifications to `apps/web/**` and extension-owned files.

Patch Studio should generate against the user's current base build first. Marketplace validation can later test against stable and nightly builds.

## Validation

Installing a patch extension should require:

- Manifest parses.
- Patch applies cleanly on the current base plus earlier enabled extensions.
- Path policy passes.
- No new dependency or lockfile changes.
- Web build succeeds.
- Preview variant launches.

For extension install, build and preview are blocking. Lint/typecheck can become warnings or marketplace quality signals. Normal repo development still follows the repository quality gates.

## Settings UI

Put the extension system inside Settings, likely as one Extensions section with tabs:

- Installed
- Drafts
- Patch Studio
- Import

Patch Studio is in-app, but build and preview work happens in isolated user-local source/variant directories.

## Marketplace And Sharing

V0 sharing should export extension bundles, not built app variants and not full T3 source.

Marketplace/install UX should be preview-first and transparent:

- Name, author, version.
- Screenshots or GIF.
- Touched files.
- Diff viewer.
- Base builds validated against, including nightly build identity.
- Known conflicts when available.
- Install/preview success signal.
- Clear blast-radius labels for broad CSS or large core-file rewrites.

Compatibility should come from successful validation, not author claims.

Patch Studio-generated extensions should be private/local by default. Publishing should require an explicit prepare-for-sharing pass.

## First Demo: Dense Sidebar

The first proof should be a Dense Sidebar extension because it is visibly UI-focused and avoids server/runtime complexity.

Scope:

- Reduce sidebar row height.
- Reduce thread/project spacing.
- Use smaller typography in the thread list.
- Show more thread titles per viewport.
- Keep hover and selected states readable.
- Avoid data model, sorting, routing, server, desktop, and dependency changes.

Success flow:

1. Clean T3 shows the normal sidebar.
2. Patch Studio creates Dense Sidebar as a draft extension.
3. T3 previews a side-by-side patched variant.
4. The extension card shows touched files and diff.
5. User installs the extension into the active recipe.
6. User can launch the patched variant.
7. User can disable the extension and return to clean T3.
8. If a nightly breaks it, repair creates a new draft version with failure context.

## Guiding Principle

This system should be easier than maintaining a personal patch branch against main. T3 should own the annoying parts: base build tracking, patch apply, variant build, preview, rollback, compatibility state, and agent-assisted repair.
