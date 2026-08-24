import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { archivedDmg, upstreamAsarSha256 } from "./config.mjs";
import { run } from "./process.mjs";

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

async function findAppResources(extractRoot) {
  const direct = path.join(extractRoot, "Grok Bot.app", "Contents", "Resources");
  if (await exists(path.join(direct, "app.asar"))) {
    return direct;
  }

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const asar = path.join(target, "app.asar");
        if (entry.name === "Resources" && await exists(asar)) {
          return target;
        }
        const nested = await walk(target);
        if (nested) return nested;
      }
    }
    return null;
  }

  return walk(extractRoot);
}

export async function extractPayloadFromDmg(dmgPath = archivedDmg) {
  if (!(await exists(dmgPath))) {
    throw new Error(`Missing archived DMG at ${dmgPath}. Run git lfs pull before bootstrapping on Linux.`);
  }

  const extractRoot = await mkdtemp(path.join(tmpdir(), "grok-bot-018-dmg-"));
  try {
    await run("7z", ["x", "-y", dmgPath, `-o${extractRoot}`]);
    const resources = await findAppResources(extractRoot);
    if (!resources) {
      throw new Error(`Could not locate app.asar inside ${dmgPath}`);
    }

    const asarPath = path.join(resources, "app.asar");
    const unpackedPath = `${asarPath}.unpacked`;
    const digest = await sha256(asarPath);
    if (digest !== upstreamAsarSha256) {
      throw new Error(`Extracted app.asar checksum mismatch: expected ${upstreamAsarSha256}, got ${digest}`);
    }
    if (!(await stat(unpackedPath)).isDirectory()) {
      throw new Error(`Missing ${unpackedPath} beside extracted app.asar`);
    }

    return { asarPath, unpackedPath, sha256: digest, extractRoot };
  } catch (error) {
    await rm(extractRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function cachePayloadFromDmg(destinationAsar, destinationUnpacked, dmgPath = archivedDmg) {
  const extracted = await extractPayloadFromDmg(dmgPath);
  try {
    await mkdir(path.dirname(destinationAsar), { recursive: true });
    await cp(extracted.asarPath, destinationAsar);
    await rm(destinationUnpacked, { recursive: true, force: true });
    await cp(extracted.unpackedPath, destinationUnpacked, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
    return extracted;
  } finally {
    await rm(extracted.extractRoot, { recursive: true, force: true });
  }
}
