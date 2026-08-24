import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { electronVersion, repoRoot } from "./config.mjs";
import { resolveElectronHeadersDir } from "./electron-headers.mjs";

const overlayPackages = ["tree-sitter", "tree-sitter-bash"];
const rebuildInPlacePackages = ["better-sqlite3", "cursor-proclist"];

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
  }

  const headersDir = await resolveElectronHeadersDir();
  const gyp = path.join(repoRoot, "node_modules", ".bin", "node-gyp");
  const env = {
    ...process.env,
    npm_config_runtime: "electron",
    npm_config_target: electronVersion,
    npm_config_disturl: "https://artifacts.electronjs.org/headers/dist",
    npm_config_arch: process.arch === "arm64" ? "arm64" : "x64",
  };

  for (const packageName of rebuildInPlacePackages) {
    const packageRoot = path.join(destinationDepsRoot, packageName);
    try {
      await run(gyp, ["rebuild", "--directory", packageRoot, "--release", "--nodedir", headersDir, "--jobs", "max"], env);
    } catch (error) {
      console.warn(`Warning: keeping reference ${packageName} binaries for now (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return destinationDepsRoot;
}
