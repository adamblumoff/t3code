// @effect-diagnostics nodeBuiltinImport:off -- The fixture builds real Cargo packages and checks the native files they leave behind.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { hasCargoCacheConsumer, inspectCargoCaches } from "./cargoCacheReport.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const fixtures: Array<string> = [];
const cargoHelp = NodeChildProcess.spawnSync("cargo", ["clean", "--help"], { timeout: 20_000 });

afterEach(async () => {
  for (const fixture of fixtures.splice(0))
    await NodeFSP.rm(fixture, { recursive: true, force: true });
});

async function makeWorkspace(name: string, parent?: string) {
  const root = parent ?? (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cargo-cache-")));
  if (parent === undefined) fixtures.push(root);
  const workspace = parent === undefined ? root : NodePath.join(root, name);
  await NodeFSP.mkdir(NodePath.join(workspace, "src"), { recursive: true });
  const manifestPath = NodePath.join(workspace, "Cargo.toml");
  await NodeFSP.writeFile(
    manifestPath,
    `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`,
  );
  await NodeFSP.writeFile(NodePath.join(workspace, "src", "main.rs"), "fn main() {}\n");
  return { root, workspace, manifestPath, targetPath: NodePath.join(workspace, "target") };
}

async function build(manifestPath: string) {
  await execFile("cargo", ["build", "--offline", "--manifest-path", manifestPath], {
    timeout: 60_000,
  });
}

describe.skipIf(
  HostProcessPlatform.defaultValue() === "win32" ||
    !cargoHelp.stdout?.toString().includes("--dry-run"),
)("Cargo cache reports", () => {
  it("distinguishes workspace members from the separate CLI workspace", async () => {
    const root = await makeWorkspace("workspace_root");
    const members = Array.from({ length: 5 }, (_, index) => `member_${index}`);
    for (const member of members) await makeWorkspace(member, root.root);
    const cli = await makeWorkspace("separate_cli", root.root);
    await NodeFSP.appendFile(
      root.manifestPath,
      `\n[workspace]\nmembers = ${JSON.stringify(members)}\nexclude = ["separate_cli"]\n`,
    );
    await build(root.manifestPath);
    await build(cli.manifestPath);
    const candidates = await inspectCargoCaches(root.root);
    const workspaces = candidates.filter((candidate) => candidate.reason === null);
    expect(workspaces.map((candidate) => candidate.targetPath).sort()).toEqual(
      [root.targetPath, cli.targetPath].sort(),
    );
    expect(
      workspaces.find((candidate) => candidate.manifestPath === root.manifestPath)!.packages,
    ).toHaveLength(6);
    expect(workspaces.every((candidate) => candidate.projectedBytes > 0)).toBe(true);
  });
  it("reports Cargo-selected package artifacts while preserving source, lockfiles, binaries and ignored data", async () => {
    const root = await makeWorkspace("root_app");
    const nested = await makeWorkspace("nested_cli", root.root);
    await build(root.manifestPath);
    await build(nested.manifestPath);
    const lockfile = await NodeFSP.readFile(NodePath.join(nested.workspace, "Cargo.lock"), "utf8");
    const ignoredData = NodePath.join(nested.targetPath, "debug", "local-data");
    await NodeFSP.writeFile(ignoredData, "preserve me");

    const candidates = await inspectCargoCaches(root.root);
    expect(candidates).toHaveLength(2);
    const cli = candidates.find((candidate) => candidate.manifestPath === nested.manifestPath);
    expect(cli).toMatchObject({
      targetPath: nested.targetPath,
      packages: ["nested_cli"],
      reason: null,
    });
    expect(cli!.projectedBytes).toBeGreaterThan(0);

    expect(await NodeFSP.readFile(ignoredData, "utf8")).toBe("preserve me");
    expect(await NodeFSP.readFile(NodePath.join(nested.workspace, "Cargo.lock"), "utf8")).toBe(
      lockfile,
    );
    expect(await NodeFSP.readFile(NodePath.join(nested.workspace, "src", "main.rs"), "utf8")).toBe(
      "fn main() {}\n",
    );
    expect((await NodeFSP.stat(NodePath.join(root.targetPath, "debug", "root_app"))).isFile()).toBe(
      true,
    );
    expect(
      (await NodeFSP.stat(NodePath.join(nested.targetPath, "debug", "nested_cli"))).isFile(),
    ).toBe(true);
  });

  it("rejects a shared target configured outside the workspace", async () => {
    const root = await makeWorkspace("external_app");
    const shared = `${root.root}.shared`;
    await NodeFSP.mkdir(NodePath.join(root.workspace, ".cargo"));
    await NodeFSP.writeFile(
      NodePath.join(root.workspace, ".cargo", "config.toml"),
      `[build]\ntarget-dir = "${shared}"\n`,
    );
    const candidates = await inspectCargoCaches(root.root);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.reason).toBe("target is external or shared");
  });

  it("rejects a symlinked target without changing its destination", async () => {
    const root = await makeWorkspace("linked_app");
    const destination = NodePath.join(root.root, "elsewhere");
    await NodeFSP.mkdir(destination);
    await NodeFSP.symlink(destination, root.targetPath);
    const candidates = await inspectCargoCaches(root.root);
    expect(candidates[0]!.reason).toBe("target path contains a symlink");
    expect((await NodeFSP.lstat(root.targetPath)).isSymbolicLink()).toBe(true);
    expect((await NodeFSP.stat(destination)).isDirectory()).toBe(true);
  });

  it("rejects two workspaces that resolve to the same internal target", async () => {
    const root = await makeWorkspace("shared_root");
    await makeWorkspace("shared_nested", root.root);
    await build(root.manifestPath);
    await NodeFSP.mkdir(NodePath.join(root.root, ".cargo"));
    await NodeFSP.writeFile(
      NodePath.join(root.root, ".cargo", "config.toml"),
      `[build]\ntarget-dir = "${root.targetPath}"\n`,
    );
    const candidates = await inspectCargoCaches(root.root);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.reason)).toEqual([
      "target is shared with another workspace",
      "target is external or shared",
    ]);
  });

  it("holds a cache while a process uses the worktree", async () => {
    const root = await makeWorkspace("live_consumer");
    await build(root.manifestPath);
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      { cwd: root.targetPath, stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", () => resolve());
        child.once("error", reject);
      });
      expect(
        await hasCargoCacheConsumer(root.root, root.targetPath, HostProcessPlatform.defaultValue()),
      ).toBe(true);
      expect(
        (await NodeFSP.stat(NodePath.join(root.targetPath, "debug", "live_consumer"))).isFile(),
      ).toBe(true);
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });

  it("stops inspection when its report budget has expired", async () => {
    const root = await makeWorkspace("expired_report");
    await build(root.manifestPath);
    const candidates = await inspectCargoCaches(root.root, performance.now() - 1);
    expect(candidates[0]!.reason).toBe("Cargo inspection failed");
    expect(
      (await NodeFSP.stat(NodePath.join(root.targetPath, "debug", "expired_report"))).isFile(),
    ).toBe(true);
  });
});
