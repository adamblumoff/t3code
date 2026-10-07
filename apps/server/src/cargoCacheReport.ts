// @effect-diagnostics nodeBuiltinImport:off -- Cargo inspection needs native filesystem allocation, process descriptors and the Cargo CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const MAX_WORKSPACES = 4;
const MAX_PACKAGES = 32;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const CARGO_CACHE_REPORT_BUDGET_MS = 120_000;

type CargoMetadata = {
  readonly workspace_root: string;
  readonly target_directory: string;
  readonly workspace_members: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<{ readonly id: string; readonly name: string }>;
};

type CargoCacheCandidate = {
  readonly manifestPath: string;
  readonly targetPath: string;
  readonly packages: ReadonlyArray<string>;
  readonly projectedBytes: number;
  readonly reason: string | null;
};

const inside = (root: string, candidate: string) => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
};

const runCargo = async (args: ReadonlyArray<string>, cwd: string, deadline: number) => {
  const remaining = deadline - performance.now();
  if (remaining < 5_000) throw new Error("Cargo cache sweep budget expired");
  return execFile("cargo", [...args], {
    cwd,
    timeout: Math.min(20_000, remaining),
    maxBuffer: MAX_OUTPUT_BYTES,
  });
};

const isPlainDirectory = async (directory: string) => {
  const stat = await NodeFSP.lstat(directory);
  return stat.isDirectory() && (await NodeFSP.realpath(directory)) === directory;
};

const linkedPath = async (root: string, target: string) => {
  let current = target;
  while (current !== root) {
    const stat = await NodeFSP.lstat(current);
    if (stat.isSymbolicLink()) return true;
    current = NodePath.dirname(current);
    if (!inside(root, current) && current !== root) return true;
  }
  return !(await isPlainDirectory(root));
};

async function workspaceManifests(worktreePath: string): Promise<ReadonlyArray<string>> {
  const manifests: Array<string> = [];
  const inspect = async (directory: string) => {
    const manifestPath = NodePath.join(directory, "Cargo.toml");
    try {
      if ((await NodeFSP.lstat(manifestPath)).isFile()) manifests.push(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  await inspect(worktreePath);
  const children = await NodeFSP.readdir(worktreePath, { withFileTypes: true });
  if (children.length > 256) throw new Error("workspace has too many root entries");
  for (const child of children) {
    if (child.isDirectory() && !child.name.startsWith(".") && child.name !== "node_modules") {
      await inspect(NodePath.join(worktreePath, child.name));
    }
  }
  if (manifests.length > MAX_WORKSPACES) throw new Error("too many Cargo workspaces");
  return manifests;
}

async function inspectManifest(
  worktreePath: string,
  manifestPath: string,
  deadline: number,
): Promise<CargoCacheCandidate> {
  const empty = (reason: string): CargoCacheCandidate => ({
    manifestPath,
    targetPath: "",
    packages: [],
    projectedBytes: 0,
    reason,
  });
  const { stdout } = await runCargo(
    ["metadata", "--no-deps", "--frozen", "--format-version", "1", "--manifest-path", manifestPath],
    NodePath.dirname(manifestPath),
    deadline,
  );
  const metadata = JSON.parse(stdout) as CargoMetadata;
  const workspaceRoot = NodePath.resolve(metadata.workspace_root);
  if (workspaceRoot !== NodePath.dirname(manifestPath))
    return empty("manifest is not a workspace root");
  const targetPath = NodePath.resolve(metadata.target_directory);
  if (!inside(workspaceRoot, targetPath) || !inside(worktreePath, targetPath)) {
    return { ...empty("target is external or shared"), targetPath };
  }
  try {
    if (!(await isPlainDirectory(targetPath)) || (await linkedPath(worktreePath, targetPath))) {
      return { ...empty("target path contains a symlink"), targetPath };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...empty("target does not exist"), targetPath };
    }
    throw error;
  }
  const members = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter((pkg) => members.has(pkg.id)).map((pkg) => pkg.name);
  if (
    packages.length === 0 ||
    packages.length > MAX_PACKAGES ||
    new Set(packages).size !== packages.length
  ) {
    return { ...empty("workspace package selection is ambiguous or too large"), targetPath };
  }
  let projectedBytes = 0;
  const counted = new Set<string>();
  const countedInodes = new Set<string>();
  const selectors = packages.flatMap((packageName) => ["-p", packageName]);
  const dryRun = await runCargo(
    [
      "clean",
      "--frozen",
      "--dry-run",
      "-v",
      ...selectors,
      "--manifest-path",
      manifestPath,
      "--target-dir",
      targetPath,
    ],
    workspaceRoot,
    deadline,
  );
  for (const entry of dryRun.stderr.split("\n").concat(dryRun.stdout.split("\n"))) {
    if (performance.now() >= deadline) throw new Error("Cargo cache sweep budget expired");
    if (!NodePath.isAbsolute(entry) || counted.has(entry)) continue;
    if (!inside(targetPath, entry) || (await linkedPath(targetPath, entry))) {
      return {
        manifestPath,
        targetPath,
        packages,
        projectedBytes: 0,
        reason: "Cargo selected a path outside the target or through a symlink",
      };
    }
    counted.add(entry);
    const stat = await NodeFSP.lstat(entry);
    const inode = `${stat.dev}:${stat.ino}`;
    if (stat.nlink === 1 && !countedInodes.has(inode)) projectedBytes += (stat.blocks ?? 0) * 512;
    countedInodes.add(inode);
  }
  return { manifestPath, targetPath, packages, projectedBytes, reason: null };
}

const matchesConsumerPath = (worktreePath: string, targetPath: string, value: string) => {
  const candidate = value.endsWith(" (deleted)") ? value.slice(0, -10) : value;
  return (
    candidate === worktreePath ||
    inside(worktreePath, candidate) ||
    candidate === targetPath ||
    inside(targetPath, candidate)
  );
};

async function privateAncestor(directory: string): Promise<boolean> {
  let current = directory;
  while (true) {
    const stat = await NodeFSP.stat(current);
    if ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.()) return true;
    const parent = NodePath.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function hasCargoCacheConsumer(
  worktreePath: string,
  targetPath: string,
  platform: NodeJS.Platform,
  deadline = performance.now() + CARGO_CACHE_REPORT_BUDGET_MS,
): Promise<boolean> {
  if (platform !== "linux" || process.getuid === undefined) return true;
  const isPrivate = await privateAncestor(worktreePath);
  const currentUid = process.getuid();
  const entries = await NodeFSP.readdir("/proc", { withFileTypes: true });
  if (entries.length > 8192) return true;
  for (const entry of entries) {
    if (performance.now() >= deadline) return true;
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name) || Number(entry.name) === process.pid)
      continue;
    const processPath = NodePath.join("/proc", entry.name);
    let status: string;
    try {
      status = await NodeFSP.readFile(NodePath.join(processPath, "status"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return true;
    }
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    if (uid !== currentUid) {
      if (!isPrivate) return true;
      continue;
    }
    for (const link of ["cwd", "exe"]) {
      try {
        if (
          matchesConsumerPath(
            worktreePath,
            targetPath,
            await NodeFSP.readlink(NodePath.join(processPath, link)),
          )
        )
          return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      }
    }
    let descriptors: ReadonlyArray<string>;
    try {
      descriptors = await NodeFSP.readdir(NodePath.join(processPath, "fd"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return true;
    }
    if (descriptors.length > 8192) return true;
    for (const descriptor of descriptors) {
      if (performance.now() >= deadline) return true;
      try {
        if (
          matchesConsumerPath(
            worktreePath,
            targetPath,
            await NodeFSP.readlink(NodePath.join(processPath, "fd", descriptor)),
          )
        )
          return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      }
    }
  }
  return false;
}

export async function inspectCargoCaches(
  worktreePath: string,
  deadline = performance.now() + CARGO_CACHE_REPORT_BUDGET_MS,
): Promise<ReadonlyArray<CargoCacheCandidate>> {
  const candidates: Array<CargoCacheCandidate> = [];
  for (const manifestPath of await workspaceManifests(worktreePath)) {
    try {
      candidates.push(await inspectManifest(worktreePath, manifestPath, deadline));
    } catch {
      candidates.push({
        manifestPath,
        targetPath: "",
        packages: [],
        projectedBytes: 0,
        reason: "Cargo inspection failed",
      });
    }
  }
  return candidates.map((candidate) =>
    candidate.reason !== null ||
    candidates.every(
      (other) =>
        other === candidate ||
        other.targetPath === "" ||
        (other.targetPath !== candidate.targetPath &&
          !inside(other.targetPath, candidate.targetPath) &&
          !inside(candidate.targetPath, other.targetPath)),
    )
      ? candidate
      : { ...candidate, projectedBytes: 0, reason: "target is shared with another workspace" },
  );
}
