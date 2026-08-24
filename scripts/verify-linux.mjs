import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extractFile, listPackage } from "@electron/asar";

import {
  linuxOutputApp,
  reconstructedName,
  upstreamAsarSha256,
} from "./lib/config.mjs";
import { resolvePackagedArtifacts } from "./lib/packaged-app.mjs";

if (process.platform !== "linux") {
  throw new Error("Linux package verification can only run on Linux.");
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function readAppArgument(argv) {
  const index = argv.indexOf("--app");
  if (index === -1) return linuxOutputApp;
  if (index !== argv.length - 2 || argv[index + 1]?.startsWith("--")) {
    throw new Error("Usage: node scripts/verify-linux.mjs [--app /absolute/path/to/linux-app-dir]");
  }
  return path.resolve(argv[index + 1]);
}

function assertElfNode(nodePath, arch = process.arch === "arm64" ? "aarch64" : "x86-64") {
  const result = spawnSync("file", [nodePath], { encoding: "utf8" });
  const description = result.stdout?.trim() ?? "";
  if (!description.includes("ELF") || !description.includes(arch)) {
    throw new Error(`Expected Linux ELF (${arch}) for ${nodePath}, got: ${description || "unknown"}`);
  }
}

const verifiedApp = readAppArgument(process.argv.slice(2));
const artifacts = await resolvePackagedArtifacts(verifiedApp);

if (!(await exists(artifacts.executablePath))) {
  throw new Error(`Missing Electron binary at ${artifacts.executablePath}`);
}
if (!(await exists(artifacts.asarPath))) {
  throw new Error(`Missing packaged asar at ${artifacts.asarPath}`);
}
if (!(await exists(artifacts.unpackedPath))) {
  throw new Error(`Missing unpacked runtime at ${artifacts.unpackedPath}`);
}

const launchWrapper = path.join(verifiedApp, "grok-bot");
if (!(await exists(launchWrapper))) {
  throw new Error(`Missing launch wrapper at ${launchWrapper}`);
}
const wrapperSource = await readFile(launchWrapper, "utf8");
if (!wrapperSource.includes("--disable-gpu")) {
  throw new Error("Launch wrapper is missing Linux GPU compatibility flags");
}

const asarBytes = await readFile(artifacts.asarPath);
const asarSha256 = createHash("sha256").update(asarBytes).digest("hex");
if (asarSha256 === upstreamAsarSha256) {
  console.warn("Warning: packaged asar still matches the pristine upstream hash; expected a reconstructed fidelity build.");
}

const listing = new Set(listPackage(artifacts.asarPath));
for (const required of [
  "/dist/electron-main/main.cjs",
  "/dist/host/host-main.cjs",
  "/dist/renderer/index.html",
  "/dist/reconstruction-build.json",
]) {
  if (!listing.has(required)) {
    throw new Error(`Packaged asar is missing ${required}`);
  }
}

const mainSource = extractFile(artifacts.asarPath, "dist/electron-main/main.cjs").toString("utf8");
if (!mainSource.includes("SAND_DISABLE_UPDATES")) {
  throw new Error("Reconstructed updater guard is missing from packaged electron-main");
}

const gnuTag = process.arch === "arm64" ? "linux-arm64-gnu" : "linux-x64-gnu";
const requiredNativeNodes = [
  path.join(artifacts.unpackedPath, "dist", "deps", "tree-sitter", "build", "Release", "tree_sitter_runtime_binding.node"),
  path.join(artifacts.unpackedPath, "dist", "deps", "tree-sitter-bash", "build", "Release", "tree_sitter_bash_binding.node"),
  path.join(artifacts.unpackedPath, "dist", "deps", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
  path.join(artifacts.unpackedPath, "dist", "deps", "whichlang-node", `whichlang-node.${gnuTag}.node`),
];
for (const nodePath of requiredNativeNodes) {
  if (!(await exists(nodePath))) {
    throw new Error(`Missing required Linux native module ${nodePath}`);
  }
  assertElfNode(nodePath);
}

const desktopPath = path.join(verifiedApp, `${path.basename(verifiedApp)}.desktop`);
if (await exists(desktopPath)) {
  const desktop = await readFile(desktopPath, "utf8");
  if (!desktop.includes("MimeType=x-scheme-handler/sand;")) {
    throw new Error("Desktop entry is missing sand:// protocol registration");
  }
  if (!desktop.includes("%u")) {
    throw new Error("Desktop entry is missing %u deep-link placeholder");
  }
  if (!desktop.includes("grok-bot")) {
    throw new Error("Desktop entry should launch via the grok-bot wrapper");
  }
}

console.log(`Verified Linux package: ${verifiedApp}`);
console.log(`Launch wrapper: ${launchWrapper}`);
console.log(`Electron binary: ${artifacts.executablePath}`);
console.log(`Packaged asar: ${artifacts.asarPath} (${asarSha256.slice(0, 12)}…)`);
console.log(`Linux native modules: ${requiredNativeNodes.length}/${requiredNativeNodes.length} ELF binaries present`);
console.log(`Display name: ${reconstructedName}`);
