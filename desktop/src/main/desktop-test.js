import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TEST_SENDER = "HYDRACTRL Signature Assist TEST";
const ports = new Map([
  ["main", 43129],
  ["smoke", 43130],
  ["biotech", 43131],
]);

function makeLocalDir(path) {
  mkdirSync(path, { recursive: true });
  if (lstatSync(path).isSymbolicLink())
    throw new Error("Test profile directories cannot be links.");
  return realpathSync(path);
}

export function startDesktopTest(app, executable = process.execPath) {
  if (!app.isPackaged) return null;
  const metadata = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
  const requestedProfile = app.commandLine.getSwitchValue("signature-assist-test-profile");
  if (!metadata.signatureAssistTest) {
    if (requestedProfile) throw new Error("Use the dedicated HYDRACTRL Portable package.");
    return null;
  }
  const profile = requestedProfile || "main";
  const port = ports.get(profile);
  if (!port) throw new Error("Unknown HYDRACTRL Portable profile.");
  const root = join(realpathSync(dirname(executable)), "signature-test-data");
  const expected = join(root, profile);
  const supplied = app.commandLine.getSwitchValue("user-data-dir");
  if (supplied && resolve(supplied).toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Use this package's dedicated user-data directory.");
  }
  const profilePath = makeLocalDir(join(makeLocalDir(root), profile));
  if (profilePath.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("The test profile resolved outside the package.");
  }
  app.setPath("userData", profilePath);
  app.setPath("sessionData", profilePath);
  app.setPath("crashDumps", makeLocalDir(join(profilePath, "crash-dumps")));
  if (!supplied) app.commandLine.appendSwitch("user-data-dir", profilePath);
  return { profilePath, port, revision: metadata.signatureAssistTest };
}

export function testSettings(settings, test) {
  let folder = settings.media.folder;
  if (folder) {
    try {
      folder = realpathSync(folder);
      const inside = relative(test.profilePath, folder);
      if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        folder = "";
      }
    } catch {
      folder = "";
    }
  }
  return {
    ...settings,
    server: { port: test.port, allowNetwork: false },
    media: { folder },
    output: { ...settings.output, name: TEST_SENDER, autoStart: false },
  };
}

export function verifyTestBundle(packagedHash, responseBytes) {
  const sha256 = createHash("sha256").update(responseBytes).digest("hex");
  if (sha256 !== packagedHash)
    throw new Error("The test server did not serve the packaged client.");
}
