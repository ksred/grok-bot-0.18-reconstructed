import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  linuxOutputApp,
  outputDir,
  reconstructedName,
  upstreamVersion,
} from "./lib/config.mjs";
import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { linuxLaunchWrapperScript } from "./lib/linux-launch-flags.mjs";
import { getRuntimeLayout, resolveRuntimeApp } from "./lib/runtime.mjs";
import { run } from "./lib/process.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

if (process.platform !== "linux") {
  throw new Error("The reconstructed Linux application can only be packaged on Linux.");
}

const arch = process.arch === "arm64" ? "arm64" : "x64";
const outputName = path.basename(linuxOutputApp);
const desktopFileName = `${outputName}.desktop`;

const { builtAsar, builtAsarUnpacked } = await buildFidelityReconstructedAsar();
const runtimeRoot = await resolveRuntimeApp();

await mkdir(outputDir, { recursive: true });
await rm(linuxOutputApp, { recursive: true, force: true });
await runCopyTree(runtimeRoot, linuxOutputApp);

const packagedLayout = getRuntimeLayout(linuxOutputApp);
await rm(packagedLayout.asar, { force: true });
await rm(packagedLayout.unpacked, { recursive: true, force: true });
await cp(builtAsar, packagedLayout.asar);
await cp(builtAsarUnpacked, packagedLayout.unpacked, {
  recursive: true,
  dereference: false,
  preserveTimestamps: true,
});

const electronBinary = path.join(linuxOutputApp, "electron");
const launchWrapper = path.join(linuxOutputApp, "grok-bot");
await writeFile(launchWrapper, linuxLaunchWrapperScript(), { mode: 0o755 });
const desktopEntry = [
  "[Desktop Entry]",
  `Name=${reconstructedName}`,
  "Type=Application",
  "Categories=Development;",
  `Exec=${JSON.stringify(launchWrapper)} %u`,
  "StartupWMClass=Grok Bot",
  "MimeType=x-scheme-handler/sand;",
  "",
].join("\n");
await writeFile(path.join(linuxOutputApp, desktopFileName), desktopEntry);

console.log(`Packaged application: ${linuxOutputApp}`);
console.log(`Desktop entry: ${path.join(linuxOutputApp, desktopFileName)}`);
console.log(`Launch wrapper: ${launchWrapper}`);
console.log(`Electron binary: ${electronBinary}`);
console.log(`Upstream version: ${upstreamVersion} (${arch})`);
console.log(`Register sand:// deep links manually with xdg-mime if needed: xdg-mime default ${desktopFileName} x-scheme-handler/sand`);

async function runCopyTree(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await run(SYSTEM_TOOLS.cp, ["-a", source, destination]);
}
