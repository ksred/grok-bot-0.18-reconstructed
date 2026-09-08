const darwinOnly = Object.freeze({
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  hdiutil: "/usr/bin/hdiutil",
  plutil: "/usr/bin/plutil",
});

const shared = Object.freeze({
  cp: "/bin/cp",
  lsof: "/usr/sbin/lsof",
  ps: "/bin/ps",
  xattr: "/usr/bin/xattr",
});

export const SYSTEM_TOOLS = Object.freeze({
  ...shared,
  ...(process.platform === "darwin" ? darwinOnly : {}),
});

export function requireDarwinTool(name) {
  const tool = SYSTEM_TOOLS[name];
  if (!tool) {
    throw new Error(`${name} is only available on macOS`);
  }
  return tool;
}
