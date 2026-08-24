import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { extractAll } from "@electron/asar";
import {
  cacheDir,
  cachedLinuxElectronDir,
  cachedPayloadAsar,
  cachedPayloadUnpacked,
  cachedRuntimeApp,
  sourceAppDir,
  upstreamAsarSha256,
  upstreamVersion,
} from "./config.mjs";
import { capture, run } from "./process.mjs";
import { requireDarwinTool, SYSTEM_TOOLS } from "./system-tools.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function getRuntimeLayout(runtimeRoot) {
  if (process.platform === "darwin") {
    return {
      resources: path.join(runtimeRoot, "Contents", "Resources"),
      asar: path.join(runtimeRoot, "Contents", "Resources", "app.asar"),
      unpacked: path.join(runtimeRoot, "Contents", "Resources", "app.asar.unpacked"),
    };
  }
  if (process.platform === "linux") {
    return {
      resources: path.join(runtimeRoot, "resources"),
      asar: path.join(runtimeRoot, "resources", "app.asar"),
      unpacked: path.join(runtimeRoot, "resources", "app.asar.unpacked"),
    };
  }
  throw new Error(`Unsupported platform for runtime layout: ${process.platform}`);
}

export function getRuntimeUnpackedDistRoot(runtimeRoot) {
  return path.join(getRuntimeLayout(runtimeRoot).unpacked, "dist");
}

export async function validateRuntimeApp(appPath) {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const executable = path.join(appPath, "Contents", "MacOS", "Grok Bot");
  const unpacked = path.join(appPath, "Contents", "Resources", "app.asar.unpacked");
  const version = await capture(requireDarwinTool("plutil"), ["-extract", "CFBundleShortVersionString", "raw", infoPlist]);
  if (version !== upstreamVersion) {
    throw new Error(`Expected Grok Bot ${upstreamVersion}, got ${version} at ${appPath}`);
  }
  if (!(await stat(executable)).isFile() || !(await stat(unpacked)).isDirectory()) {
    throw new Error(`Incomplete Grok Bot runtime at ${appPath}`);
  }
  return appPath;
}

export async function validateLinuxRuntime(electronDir) {
  const resolved = path.resolve(electronDir);
  const layout = getRuntimeLayout(resolved);
  const electronBinary = path.join(resolved, "electron");
  if (!(await stat(electronBinary)).isFile()) {
    throw new Error(`Missing Electron binary at ${electronBinary}`);
  }
  if (!(await stat(layout.asar)).isFile()) {
    throw new Error(`Missing checksum-pinned app.asar at ${layout.asar}`);
  }
  if (!(await stat(layout.unpacked)).isDirectory()) {
    throw new Error(`Missing app.asar.unpacked payload at ${layout.unpacked}`);
  }
  const bytes = await readFile(layout.asar);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== upstreamAsarSha256) {
    throw new Error(`Upstream app.asar checksum mismatch: expected ${upstreamAsarSha256}, got ${actualSha256}`);
  }
  return resolved;
}

export async function validateRuntime(runtimeRoot) {
  if (process.platform === "darwin") {
    return validateRuntimeApp(runtimeRoot);
  }
  if (process.platform === "linux") {
    return validateLinuxRuntime(runtimeRoot);
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

export async function resolveRuntimeApp() {
  const configured = process.env.GROK_BOT_018_APP?.trim();
  if (configured) {
    return await validateRuntimeApp(path.resolve(configured));
  }
  if (process.platform === "linux") {
    if (await exists(cachedLinuxElectronDir)) {
      return await validateLinuxRuntime(cachedLinuxElectronDir);
    }
    throw new Error("Missing Linux runtime. Run `npm run bootstrap` first.");
  }
  if (await exists(cachedRuntimeApp)) {
    return await validateRuntimeApp(cachedRuntimeApp);
  }
  throw new Error("Missing 0.18.0 runtime. Run `npm run bootstrap` first.");
}

async function mirrorTree(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  if (process.platform === "darwin") {
    await run(requireDarwinTool("ditto"), [source, destination]);
    return;
  }
  await run(SYSTEM_TOOLS.cp, ["-a", source, destination]);
}

export async function cacheRuntimeFromApp(source) {
  const validated = await validateRuntimeApp(path.resolve(source));
  const runtimeDir = path.dirname(cachedRuntimeApp);
  await mkdir(runtimeDir, { recursive: true });
  await rm(cachedRuntimeApp, { recursive: true, force: true });
  await mirrorTree(validated, cachedRuntimeApp);
  return await validateRuntimeApp(cachedRuntimeApp);
}

export async function resolvePayloadAsarPath() {
  const configured = process.env.GROK_BOT_018_ASAR?.trim();
  if (configured) return path.resolve(configured);
  if (await exists(cachedPayloadAsar)) return cachedPayloadAsar;
  throw new Error(
    "Missing checksum-pinned app.asar payload. Set GROK_BOT_018_ASAR, populate .cache/payload/app.asar, or bootstrap once on macOS and copy the extracted archive.",
  );
}

export async function resolvePayloadUnpackedPath(asarPath) {
  const configured = process.env.GROK_BOT_018_ASAR_UNPACKED?.trim();
  if (configured) return path.resolve(configured);
  const sibling = `${asarPath}.unpacked`;
  if (await exists(sibling)) return sibling;
  if (await exists(cachedPayloadUnpacked)) return cachedPayloadUnpacked;
  throw new Error(
    "Missing app.asar.unpacked payload. Set GROK_BOT_018_ASAR_UNPACKED, populate .cache/payload/app.asar.unpacked, or copy it from a macOS bootstrap.",
  );
}

export async function installLinuxPayload(electronDir, { asarPath, unpackedPath } = {}) {
  const archive = asarPath ?? await resolvePayloadAsarPath();
  const unpacked = unpackedPath ?? await resolvePayloadUnpackedPath(archive);
  const layout = getRuntimeLayout(electronDir);
  await mkdir(layout.resources, { recursive: true });
  await cp(archive, layout.asar);
  await rm(layout.unpacked, { recursive: true, force: true });
  await cp(unpacked, layout.unpacked, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  await mkdir(path.dirname(cachedPayloadAsar), { recursive: true });
  await cp(archive, cachedPayloadAsar);
  await rm(cachedPayloadUnpacked, { recursive: true, force: true });
  await cp(unpacked, cachedPayloadUnpacked, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  return { asarPath: archive, unpackedPath: unpacked };
}

export async function hydrateSourcePayloadFromAsar(archive, {
  destination = sourceAppDir,
  expectedSha256 = upstreamAsarSha256,
} = {}) {
  const bytes = await readFile(archive);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Upstream app.asar checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }

  const hydrationRoot = path.join(cacheDir, "source-payloads");
  await mkdir(hydrationRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(hydrationRoot, "grok-bot-018-"));
  try {
    extractAll(archive, temporary);
    for (const required of [
      "dist/electron-main/main.cjs",
      "dist/host/host-main.cjs",
      "dist/renderer/index.html",
    ]) {
      if (!(await stat(path.join(temporary, required))).isFile()) {
        throw new Error(`Upstream app.asar is missing ${required}`);
      }
    }
    await mkdir(destination, { recursive: true });
    await rm(path.join(destination, "dist"), { recursive: true, force: true });
    await cp(path.join(temporary, "dist"), path.join(destination, "dist"), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { archive, sha256: actualSha256, destination: path.join(destination, "dist") };
}

export async function hydrateSourcePayloadFromRuntime(runtimeRoot, options = {}) {
  const archive = getRuntimeLayout(await validateRuntime(runtimeRoot)).asar;
  return hydrateSourcePayloadFromAsar(archive, options);
}

export async function copyTree(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}
