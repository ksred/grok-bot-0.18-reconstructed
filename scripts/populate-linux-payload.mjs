import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  cachedPayloadAsar,
  cachedPayloadUnpacked,
} from "./lib/config.mjs";
import { getRuntimeLayout } from "./lib/runtime.mjs";
import { run } from "./lib/process.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

async function copyTree(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await run(SYSTEM_TOOLS.cp, ["-a", source, destination]);
}

const sourceApp = process.env.GROK_BOT_018_APP?.trim();
const sourceAsar = process.env.GROK_BOT_018_ASAR?.trim();
const sourceUnpacked = process.env.GROK_BOT_018_ASAR_UNPACKED?.trim();

if (sourceApp) {
  const layout = getRuntimeLayout(path.resolve(sourceApp));
  await mkdir(path.dirname(cachedPayloadAsar), { recursive: true });
  await cp(layout.asar, cachedPayloadAsar);
  await copyTree(layout.unpacked, cachedPayloadUnpacked);
  console.log(`Payload cache populated from macOS app: ${sourceApp}`);
  console.log(`  ${cachedPayloadAsar}`);
  console.log(`  ${cachedPayloadUnpacked}`);
} else if (sourceAsar) {
  const archive = path.resolve(sourceAsar);
  const unpacked = sourceUnpacked
    ? path.resolve(sourceUnpacked)
    : `${archive}.unpacked`;
  await mkdir(path.dirname(cachedPayloadAsar), { recursive: true });
  await cp(archive, cachedPayloadAsar);
  await copyTree(unpacked, cachedPayloadUnpacked);
  console.log(`Payload cache populated from explicit asar paths:`);
  console.log(`  ${cachedPayloadAsar}`);
  console.log(`  ${cachedPayloadUnpacked}`);
} else {
  throw new Error(
    "Set GROK_BOT_018_APP to a macOS .app bundle or GROK_BOT_018_ASAR (+ optional GROK_BOT_018_ASAR_UNPACKED) before populating the Linux payload cache.",
  );
}
