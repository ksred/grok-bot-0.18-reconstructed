import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  archivedDmg,
  cachedDmg,
  cachedLinuxElectronDir,
  cachedLinuxElectronZip,
  cachedRuntimeApp,
  dmgSha256,
  dmgUrl,
  linuxElectronZipUrl,
} from "./lib/config.mjs";
import { run } from "./lib/process.mjs";
import {
  cacheRuntimeFromApp,
  hydrateSourcePayloadFromAsar,
  hydrateSourcePayloadFromRuntime,
  installLinuxPayload,
  resolvePayloadAsarPath,
  validateLinuxRuntime,
  validateRuntimeApp,
} from "./lib/runtime.mjs";
import { requireDarwinTool, SYSTEM_TOOLS } from "./lib/system-tools.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadFile(url, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body == null) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }));
  await rename(partial, destination);
}

async function downloadDmg() {
  await mkdir(path.dirname(cachedDmg), { recursive: true });
  if (await exists(cachedDmg)) {
    const digest = await sha256(cachedDmg);
    if (digest === dmgSha256) return;
    await rm(cachedDmg, { force: true });
  }

  if (await exists(archivedDmg)) {
    const archivedDigest = await sha256(archivedDmg);
    if (archivedDigest !== dmgSha256) {
      throw new Error(`Archived DMG checksum mismatch: expected ${dmgSha256}, got ${archivedDigest}. Run git lfs pull before bootstrapping.`);
    }
    console.log(`Using archived release ${archivedDmg}`);
    await copyFile(archivedDmg, cachedDmg);
    return;
  }

  await downloadFile(dmgUrl, cachedDmg);
  const digest = await sha256(cachedDmg);
  if (digest !== dmgSha256) {
    await rm(cachedDmg, { force: true });
    throw new Error(`DMG checksum mismatch: expected ${dmgSha256}, got ${digest}`);
  }
}

async function extractRuntime() {
  const mountRoot = await mkdtemp(path.join(tmpdir(), "grok-bot-018-mount-"));
  let attached = false;
  try {
    await run(requireDarwinTool("hdiutil"), ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, cachedDmg]);
    attached = true;
    await cacheRuntimeFromApp(path.join(mountRoot, "Grok Bot.app"));
  } finally {
    if (attached) await run(requireDarwinTool("hdiutil"), ["detach", mountRoot]);
    await rm(mountRoot, { recursive: true, force: true });
  }
}

async function downloadLinuxElectron() {
  if (!(await exists(cachedLinuxElectronZip))) {
    await downloadFile(linuxElectronZipUrl, cachedLinuxElectronZip);
  }
}

async function extractLinuxElectron() {
  await downloadLinuxElectron();
  const extractRoot = await mkdtemp(path.join(tmpdir(), "grok-bot-018-electron-"));
  try {
    await run("unzip", ["-q", cachedLinuxElectronZip, "-d", extractRoot]);
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(extractRoot, { withFileTypes: true }));
    const root = entries.length === 1 && entries[0].isDirectory()
      ? path.join(extractRoot, entries[0].name)
      : extractRoot;
    await rm(cachedLinuxElectronDir, { recursive: true, force: true });
    await mkdir(path.dirname(cachedLinuxElectronDir), { recursive: true });
    await run(SYSTEM_TOOLS.cp, ["-a", `${root}/.`, cachedLinuxElectronDir]);
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
}

async function bootstrapDarwin() {
  const configuredApp = process.env.GROK_BOT_018_APP?.trim();
  let runtimeApp;
  if (configuredApp) {
    runtimeApp = await cacheRuntimeFromApp(configuredApp);
  } else if (await exists(cachedRuntimeApp)) {
    runtimeApp = await validateRuntimeApp(cachedRuntimeApp);
  } else {
    await downloadDmg();
    await extractRuntime();
    runtimeApp = await validateRuntimeApp(cachedRuntimeApp);
  }

  const hydrated = await hydrateSourcePayloadFromRuntime(runtimeApp);
  console.log(`Runtime ready: ${cachedRuntimeApp}`);
  console.log(`Checksum-pinned source payload ready: ${hydrated.destination} (${hydrated.sha256})`);
  console.log("The checksum-pinned app supplies only the Electron shell, ABI-matched native dependencies, and explicitly documented build fallbacks.");
}

async function bootstrapLinux() {
  if (!(await exists(cachedLinuxElectronDir))) {
    await extractLinuxElectron();
  }

  const asarPath = await resolvePayloadAsarPath();
  await installLinuxPayload(cachedLinuxElectronDir, { asarPath });
  const runtimeRoot = await validateLinuxRuntime(cachedLinuxElectronDir);
  const hydrated = await hydrateSourcePayloadFromAsar(asarPath);
  console.log(`Linux runtime ready: ${runtimeRoot}`);
  console.log(`Checksum-pinned source payload ready: ${hydrated.destination} (${hydrated.sha256})`);
  console.log("Populate .cache/payload from a macOS bootstrap when moving machines; GROK_BOT_018_ASAR can override the archive path.");
}

if (process.platform === "linux") {
  await bootstrapLinux();
} else {
  await bootstrapDarwin();
}
