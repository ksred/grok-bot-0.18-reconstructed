import { createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { cacheDir, electronVersion, repoRoot } from "./config.mjs";
import { run } from "./process.mjs";

const cachedHeadersDir = path.join(cacheDir, "electron-headers", `v${electronVersion}`);
const headersArchiveUrl = `https://artifacts.electronjs.org/headers/dist/v${electronVersion}/node-v${electronVersion}-headers.tar.gz`;

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function nodeVersionHeaderPath(headersRoot) {
  return path.join(headersRoot, "include", "node", "node_version.h");
}

async function downloadHeadersArchive(destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  console.log(`Downloading Electron ${electronVersion} headers`);
  const response = await fetch(headersArchiveUrl, { redirect: "follow" });
  if (!response.ok || response.body == null) {
    throw new Error(`Electron headers download failed: HTTP ${response.status}`);
  }
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }));
  await rename(partial, destination);
}

async function validateHeadersRoot(headersRoot) {
  const headerPath = nodeVersionHeaderPath(headersRoot);
  if (!(await exists(headerPath))) {
    throw new Error(`Electron headers root is missing ${headerPath}`);
  }
  return headersRoot;
}

export async function resolveElectronHeadersDir() {
  const configured = process.env.ELECTRON_HEADERS_DIR?.trim();
  if (configured) return validateHeadersRoot(path.resolve(configured));

  const npmDist = path.join(repoRoot, "node_modules", "electron", "dist");
  if (await exists(nodeVersionHeaderPath(npmDist))) {
    return validateHeadersRoot(npmDist);
  }

  if (await exists(nodeVersionHeaderPath(cachedHeadersDir))) {
    return validateHeadersRoot(cachedHeadersDir);
  }

  const archivePath = path.join(cacheDir, "downloads", `node-v${electronVersion}-headers.tar.gz`);
  if (!(await exists(archivePath))) {
    await downloadHeadersArchive(archivePath);
  }

  await rm(cachedHeadersDir, { recursive: true, force: true });
  await mkdir(cachedHeadersDir, { recursive: true });
  await run("tar", ["-xzf", archivePath, "-C", cachedHeadersDir, "--strip-components=1"]);
  return validateHeadersRoot(cachedHeadersDir);
}

export async function readElectronHeaderVersion(headersRoot) {
  const { readFile } = await import("node:fs/promises");
  return readFile(nodeVersionHeaderPath(headersRoot), "utf8");
}
