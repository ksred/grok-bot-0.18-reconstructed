export const LINUX_ELECTRON_LAUNCH_FLAGS = Object.freeze([
  "--use-mock-keychain",
  "--disable-gpu",
  "--disable-dev-shm-usage",
]);

export function linuxLaunchWrapperScript() {
  return [
    "#!/bin/sh",
    "set -eu",
    'APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'exec "$APP_DIR/electron" --use-mock-keychain --disable-gpu --disable-dev-shm-usage "$@"',
    "",
  ].join("\n");
}
