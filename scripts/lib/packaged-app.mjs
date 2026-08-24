import { access } from "node:fs/promises";
import path from "node:path";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function resolvePackagedAppArtifacts(appPath) {
  if (typeof appPath !== "string" || appPath.trim() === "") {
    throw new TypeError("A packaged application path is required");
  }
  const resolvedApp = path.resolve(appPath);
  if (path.extname(resolvedApp) !== ".app") {
    throw new TypeError(`Expected a .app bundle path, received ${appPath}`);
  }
  const asarPath = path.join(resolvedApp, "Contents", "Resources", "app.asar");
  return Object.freeze({
    platform: "darwin",
    appPath: resolvedApp,
    asarPath,
    unpackedPath: `${asarPath}.unpacked`,
    executablePath: path.join(resolvedApp, "Contents", "MacOS", "Grok Bot"),
  });
}

export function resolvePackagedLinuxArtifacts(appPath) {
  if (typeof appPath !== "string" || appPath.trim() === "") {
    throw new TypeError("A packaged application path is required");
  }
  const resolvedApp = path.resolve(appPath);
  const asarPath = path.join(resolvedApp, "resources", "app.asar");
  return Object.freeze({
    platform: "linux",
    appPath: resolvedApp,
    asarPath,
    unpackedPath: `${asarPath}.unpacked`,
    executablePath: path.join(resolvedApp, "electron"),
  });
}

export async function resolvePackagedArtifacts(appPath) {
  const resolved = path.resolve(appPath);
  if (path.extname(resolved) === ".app") {
    return resolvePackagedAppArtifacts(resolved);
  }
  if (await exists(path.join(resolved, "resources", "app.asar"))) {
    return resolvePackagedLinuxArtifacts(resolved);
  }
  throw new TypeError(`Expected a packaged macOS .app bundle or Linux Electron directory, received ${appPath}`);
}

export async function resolvePayloadResourcesRoot(appPath) {
  const resolved = path.resolve(appPath);
  if (path.extname(resolved) === ".app") {
    return path.join(resolved, "Contents", "Resources");
  }
  const resources = path.join(resolved, "resources");
  if (await exists(resources)) {
    return resources;
  }
  return resolved;
}
