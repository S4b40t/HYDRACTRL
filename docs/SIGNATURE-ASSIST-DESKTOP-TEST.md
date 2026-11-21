# HYDRACTRL Signature Assist TEST on Windows

This is the unsigned, unpacked Windows x64 test package based on accepted checkpoint `9ae88d1367b04cac2072030e5fe86c04ead195ba`. Keep the complete directory together. Electron, the native texture bridge, the Bun server and the web assets are included.

## Launch and test

1. Close the installed HYDRACTRL. Open **Launch Signature Assist TEST.cmd** beside the executable. Always use the launcher. The bare EXE refuses to start without the dedicated profile argument.
2. Confirm the window title contains **HYDRACTRL Signature Assist TEST** and **9ae88d1**. The settings window should show `http://127.0.0.1:43129` and LAN access off. The test log in `signature-test-data\main\logs` records the profile, the packaged server path and the verified client hash.
3. In **Setup**, paste the original local Setup v1 file. Switch to **Sketch** and run a test sketch. Use **Import scenes** (Alt+I) for a disposable bank export. This changes the test profile’s banks. Drag a disposable image or video onto the editor to copy it into the test media folder. The default is `signature-test-data\main\media`.
4. Choose an input using the editor’s audio selector. Open **Output Settings** and verify 1280×720, 60 fps and alpha enabled. Output starts on request. Use **Output → Start Output**, then check the sender **HYDRACTRL Signature Assist TEST**. The app reports native sender FPS separately from the configured rate.
5. For the optional Biotech Setup, run `"Launch Signature Assist TEST.cmd" biotech` from a Windows Command Prompt in the package directory. This uses `signature-test-data\biotech` and port 43131. Import the Biotech Setup privately into that profile.

## Resolume receiver check

Use a disposable composition. Add a Spout input using **HYDRACTRL Signature Assist TEST** and verify the live scene, cadence, and switching between two test scenes. To check alpha, place a contrasting layer behind the sender and run a scene with a transparent field and an opaque shape. Compare Resolume’s receiver behavior with the sender FPS shown in HYDRACTRL. Stop and restart the sender once and verify the receiver reconnects. Close the disposable composition after the test.

## Stop and return to the installed app

Stop Spout and close the test window. The test server shuts down with the app. Relaunch the official app from its usual shortcut only after closing the test. The test app saves its settings, Chromium storage, logs, crash dumps and media under `signature-test-data` in this directory. To discard test data, close the app first and remove only that test folder. To remove the test build, close it and remove this complete unpacked folder.

## Reproduce the package and smoke

Run frozen Bun installs with Bun 1.4.5 in the repository root and `desktop`. In PowerShell with Bun on PATH, run the following from `desktop` using the Windows x64 host.

```powershell
bun run pack --win --x64 --publish never --config.win.signExecutable=false --config.extraMetadata.signatureAssistTest=9ae88d1367b04cac2072030e5fe86c04ead195ba
Copy-Item -LiteralPath 'scripts\Launch Signature Assist TEST.cmd' -Destination 'dist\win-unpacked'
```

From the repository root with Node 24 and the verified Setup fixture, use the following. The smoke profile uses port 43130 and stays on disk for the restart check. Start with a fresh smoke profile and give the timed run a fresh output filename.

```powershell
$env:BENCH_FIXTURE = 'C:\path\to\HYDRACTRL_Setup_v1.js'
node desktop/scripts/smoke.mjs --signature-test
node desktop/scripts/smoke.mjs --signature-test --persistence-only
$env:SUSTAIN_RESULT = 'C:\path\to\desktop-sustained.json'
node desktop/scripts/smoke.mjs --signature-test --sustain
```

The Setup SHA-256 must be `dc8fc01531c058172a51da081c35479f7320e7de408c2a706c749d4b413d2324`. The accepted app client SHA-256 is `df17224268f1da046489749f7bc58dd37aaf4130a62763b3bfd346388b5944c5`. The test verifies both the packaged file and the file served by the owned loopback child before loading the editor. Keep private Setup files and generated profiles out of any archive or share.
