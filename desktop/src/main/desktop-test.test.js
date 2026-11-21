import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_SENDER, startDesktopTest, testSettings, verifyTestBundle } from "./desktop-test.js";
import { DEFAULT_SETTINGS } from "./settings.js";

test("a marked package selects its own profile before the app can take the lock", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "signature-profile-test-")));
  try {
    writeFileSync(join(directory, "package.json"), '{"signatureAssistTest":"reviewed"}');
    const values = {};
    const switches = {};
    const app = {
      isPackaged: true,
      getAppPath: () => directory,
      commandLine: {
        getSwitchValue: (name) => switches[name],
        appendSwitch: (name, value) => {
          switches[name] = value;
        },
      },
      setPath: (key, value) => {
        values[key] = value;
      },
    };
    const executable = join(directory, "HYDRACTRL.exe");
    switches["user-data-dir"] = directory;
    expect(() => startDesktopTest(app, executable)).toThrow("dedicated user-data");
    expect(values).toEqual({});

    const profilePath = join(directory, "signature-test-data", "main");
    delete switches["user-data-dir"];
    const config = startDesktopTest(app, executable);
    expect(config).toEqual({ profilePath, port: 43129, revision: "reviewed" });
    expect(values).toEqual({
      userData: profilePath,
      sessionData: profilePath,
      crashDumps: join(profilePath, "crash-dumps"),
    });
    expect(switches["user-data-dir"]).toBe(profilePath);

    switches["signature-assist-test-profile"] = "unknown";
    expect(() => startDesktopTest(app, executable)).toThrow("Unknown HYDRACTRL Portable profile.");
    switches["signature-assist-test-profile"] = "biotech";
    expect(() => startDesktopTest(app, executable)).toThrow("dedicated user-data");
    delete switches["user-data-dir"];
    expect(startDesktopTest(app, executable)).toEqual({
      profilePath: join(directory, "signature-test-data", "biotech"),
      port: 43131,
      revision: "reviewed",
    });
    const localMedia = join(profilePath, "images");
    mkdirSync(localMedia);
    const constrained = testSettings({ ...DEFAULT_SETTINGS, media: { folder: directory } }, config);
    expect(constrained.server).toEqual({ port: 43129, allowNetwork: false });
    expect(constrained.output).toMatchObject({ name: TEST_SENDER, autoStart: false });
    expect(constrained.media.folder).toBe("");
    expect(
      testSettings({ ...DEFAULT_SETTINGS, media: { folder: localMedia } }, config).media.folder,
    ).toBe(localMedia);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only the accepted client bytes pass the desktop test gate", () => {
  const good = Buffer.from("built client");
  const hash = createHash("sha256").update(good).digest("hex");
  expect(() => verifyTestBundle(hash, good)).not.toThrow();
  expect(() => verifyTestBundle(hash, Buffer.from("another server"))).toThrow("packaged client");
});
