import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
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

const asarBytes = await readFile(artifacts.asarPath);
const asarSha256 = createHash("sha256").update(asarBytes).digest("hex");
if (asarSha256 === upstreamAsarSha256) {
  console.warn("Warning: packaged asar still matches the pristine upstream hash; expected a reconstructed fidelity build.");
}

const listing = new Set(listPackage(artifacts.asarPath).map((entry) => `/${entry}`));
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

const desktopPath = path.join(verifiedApp, `${path.basename(verifiedApp)}.desktop`);
if (await exists(desktopPath)) {
  const desktop = await readFile(desktopPath, "utf8");
  if (!desktop.includes("MimeType=x-scheme-handler/sand;")) {
    throw new Error("Desktop entry is missing sand:// protocol registration");
  }
  if (!desktop.includes("%u")) {
    throw new Error("Desktop entry is missing %u deep-link placeholder");
  }
}

console.log(`Verified Linux package: ${verifiedApp}`);
console.log(`Electron binary: ${artifacts.executablePath}`);
console.log(`Packaged asar: ${artifacts.asarPath} (${asarSha256.slice(0, 12)}…)`);
console.log(`Display name: ${reconstructedName}`);
