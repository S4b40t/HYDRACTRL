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
  const profile = app.commandLine.getSwitchValue("signature-assist-test-profile");
  if (!metadata.signatureAssistTest) {
    if (profile) throw new Error("Use the dedicated Signature Assist test package.");
    return null;
  }
  const port = ports.get(profile);
  if (!port) throw new Error("Start this test package with Launch Signature Assist TEST.cmd.");
  const root = join(realpathSync(dirname(executable)), "signature-test-data");
  const expected = join(root, profile);
  const supplied = app.commandLine.getSwitchValue("user-data-dir");
  if (!supplied || resolve(supplied).toLowerCase() !== expected.toLowerCase()) {
    throw new Error("The launcher must supply this package's dedicated user-data directory.");
  }
  const profilePath = makeLocalDir(join(makeLocalDir(root), profile));
  if (profilePath.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("The test profile resolved outside the package.");
  }
  app.setPath("userData", profilePath);
  app.setPath("sessionData", profilePath);
  app.setPath("crashDumps", makeLocalDir(join(profilePath, "crash-dumps")));
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
