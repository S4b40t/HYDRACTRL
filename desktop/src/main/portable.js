import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PORTABLE_PORT = 43129;
export const PORTABLE_OUTPUT = Object.freeze({
  width: 1280,
  height: 720,
  frameRate: 60,
  includeAlpha: true,
});

/** Set both Chromium's session root and Electron's application data root before app.ready. */
export function configurePortable(app) {
  if (!app.isPackaged) return null;
  const manifest = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
  if (manifest.hydractrlPortable !== true) return null;

  const profile = join(realpathSync(dirname(app.getPath("exe"))), "portable-data");
  const supplied = app.commandLine.getSwitchValue("user-data-dir");
  if (supplied && resolve(supplied) !== profile) {
    throw new Error(
      "This Portable uses its own portable-data folder. Remove --user-data-dir and retry.",
    );
  }
  mkdirSync(profile, { recursive: true });
  const path = realpathSync(profile);
  app.setPath("userData", path);
  app.setPath("sessionData", path);
  app.commandLine.appendSwitch("user-data-dir", path);
  return { path, port: PORTABLE_PORT };
}
