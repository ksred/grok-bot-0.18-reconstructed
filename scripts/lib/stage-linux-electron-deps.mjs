import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { electronVersion, repoRoot } from "./config.mjs";
import { resolveElectronHeadersDir } from "./electron-headers.mjs";

const overlayPackages = ["tree-sitter", "tree-sitter-bash"];
const betterSqlite3Version = "13.0.3";
const whichlangVersion = "0.2.1";

function linuxArchTag() {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function linuxGnuTag() {
  return process.arch === "arm64" ? "linux-arm64-gnu" : "linux-x64-gnu";
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function copyTree(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function assertElfNode(nodePath) {
  if (!await exists(nodePath)) {
    throw new Error(`Missing native module ${nodePath}`);
  }
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("file", [nodePath], { encoding: "utf8" });
  const description = result.stdout?.trim() ?? "";
  if (!description.includes("ELF") || !description.includes(linuxArchTag() === "arm64" ? "ARM aarch64" : "x86-64")) {
    throw new Error(`Expected Linux ${linuxArchTag()} ELF for ${nodePath}, got: ${description || "unknown"}`);
  }
}

function electronGypEnv() {
  return {
    ...process.env,
    npm_config_runtime: "electron",
    npm_config_target: electronVersion,
    npm_config_disturl: "https://artifacts.electronjs.org/headers/dist",
    npm_config_arch: linuxArchTag(),
    npm_config_build_from_source: "true",
  };
}

async function ensureRepoPackage(packageName, version) {
  const packageRoot = path.join(repoRoot, "node_modules", packageName);
  if (await exists(path.join(packageRoot, "package.json"))) {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.version === version) return packageRoot;
  }
  await run("npm", ["install", "--no-save", `${packageName}@${version}`]);
  return packageRoot;
}

async function rebuildElectronPackage(packageRoot, headersDir, gyp, env) {
  await rm(path.join(packageRoot, "build"), { recursive: true, force: true });
  await rm(path.join(packageRoot, "prebuilds"), { recursive: true, force: true });
  await run(gyp, ["rebuild", "--directory", packageRoot, "--release", "--nodedir", headersDir, "--jobs", "max"], env);
}

async function stageBetterSqlite3(destinationDepsRoot, headersDir, gyp, env) {
  const packageName = "better-sqlite3";
  const sourceRoot = await ensureRepoPackage(packageName, betterSqlite3Version);
  const packageRoot = path.join(destinationDepsRoot, packageName);
  await copyTree(sourceRoot, packageRoot);
  await rebuildElectronPackage(packageRoot, headersDir, gyp, env);
  const nodePath = path.join(packageRoot, "build", "Release", "better_sqlite3.node");
  await assertElfNode(nodePath);
  return nodePath;
}

async function downloadWhichlangOptionalPackage() {
  const optionalPackage = `whichlang-node-${linuxGnuTag()}`;
  const cacheDir = path.join(repoRoot, ".cache", "linux-native-downloads");
  await mkdir(cacheDir, { recursive: true });
  const tgz = path.join(cacheDir, `${optionalPackage}-${whichlangVersion}.tgz`);
  if (!await exists(tgz)) {
    await run("npm", ["pack", `${optionalPackage}@${whichlangVersion}`, "--pack-destination", cacheDir]);
  }
  const extractDir = path.join(cacheDir, `${optionalPackage}-extracted`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await run("tar", ["-xzf", tgz, "-C", extractDir, "--strip-components=1"]);
  return { optionalPackage, extractDir };
}

async function stageWhichlangLinux(destinationDepsRoot) {
  const { optionalPackage, extractDir } = await downloadWhichlangOptionalPackage();
  const nodeFile = `whichlang-node.${linuxGnuTag()}.node`;
  const nodeSource = path.join(extractDir, nodeFile);
  if (!await exists(nodeSource)) {
    throw new Error(`Downloaded ${optionalPackage} is missing ${nodeFile}`);
  }

  await copyTree(extractDir, path.join(destinationDepsRoot, optionalPackage));
  await cp(nodeSource, path.join(destinationDepsRoot, "whichlang-node", nodeFile));
  await assertElfNode(nodeSource);
  await rm(path.join(destinationDepsRoot, "whichlang-node-darwin-arm64"), { recursive: true, force: true });
  return nodeSource;
}

async function pruneUnavailableLinuxPackages(destinationDepsRoot) {
  // cursor-proclist ships only a prebuilt macOS binary and no compilable sources.
  // The reconstructed runtime already degrades gracefully when it is absent.
  await rm(path.join(destinationDepsRoot, "cursor-proclist"), { recursive: true, force: true });

  // @anysphere/tree-chunk-napi is Anysphere-internal and not published for Linux.
  // Nothing in the reconstructed Linux bundles imports it at startup.
  const treeChunkDir = path.join(destinationDepsRoot, "@anysphere", "tree-chunk-napi");
  if (await exists(treeChunkDir)) {
    await rm(path.join(treeChunkDir, "tree-chunk-napi.darwin-arm64.node"), { force: true });
  }
}

async function updateLinuxRuntimeDepsManifest(destinationDepsRoot) {
  const manifestPath = path.join(destinationDepsRoot, "runtime-deps-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const gnuTag = linuxGnuTag();
  manifest.platform = "linux";
  manifest.arch = linuxArchTag();
  manifest.required = [
    "tree-sitter",
    "tree-sitter-bash",
    "whichlang-node",
    `whichlang-node-${gnuTag}`,
  ];
  manifest.nodeFiles = [
    "tree-sitter/build/Release/tree_sitter_runtime_binding.node",
    "tree-sitter-bash/build/Release/tree_sitter_bash_binding.node",
    "better-sqlite3/build/Release/better_sqlite3.node",
    `whichlang-node/whichlang-node.${gnuTag}.node`,
    `whichlang-node-${gnuTag}/whichlang-node.${gnuTag}.node`,
  ];
  manifest.linuxNativeStaging = {
    betterSqlite3Version,
    whichlangVersion,
    electronVersion,
    stagedAt: new Date().toISOString(),
    inventorySha256: createHash("sha256").update(JSON.stringify(manifest.nodeFiles)).digest("hex"),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function stageLinuxElectronDeps(runtimeDepsRoot, destinationDepsRoot) {
  if (process.platform !== "linux") {
    throw new Error("Linux Electron dependency staging is only supported on Linux");
  }

  await copyTree(runtimeDepsRoot, destinationDepsRoot);

  const electronRebuild = path.join(repoRoot, "node_modules", ".bin", "electron-rebuild");
  await run(electronRebuild, [
    "-f",
    ...overlayPackages.flatMap((name) => ["-w", name]),
  ]);

  for (const packageName of overlayPackages) {
    await copyTree(
      path.join(repoRoot, "node_modules", packageName),
      path.join(destinationDepsRoot, packageName),
    );
    const nodeName = packageName === "tree-sitter"
      ? "tree-sitter/build/Release/tree_sitter_runtime_binding.node"
      : "tree-sitter-bash/build/Release/tree_sitter_bash_binding.node";
    await assertElfNode(path.join(destinationDepsRoot, nodeName));
  }

  const headersDir = await resolveElectronHeadersDir();
  const gyp = path.join(repoRoot, "node_modules", ".bin", "node-gyp");
  const env = electronGypEnv();

  await stageBetterSqlite3(destinationDepsRoot, headersDir, gyp, env);
  await stageWhichlangLinux(destinationDepsRoot);
  await pruneUnavailableLinuxPackages(destinationDepsRoot);
  await updateLinuxRuntimeDepsManifest(destinationDepsRoot);

  return destinationDepsRoot;
}
