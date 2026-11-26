# HYDRACTRL Portable for Windows x64

1. Extract the entire archive to a writable folder. Keep the runtime files together.
2. Close any previous HYDRACTRL Portable using port 43129.
3. Open **HydractrlPortable.cmd** or **HYDRACTRL.exe**. Both use the same profile.
4. Close the app normally before backing up, copying, or moving that profile.

New profiles start at 1280 × 720, 60 FPS, with Spout alpha enabled. In Desktop Settings, the Output section shows whether Spout is available and running. Use a Spout receiver to verify the shared texture.

## MIDI

Expand **System**, select the controller, and open **MIDI mappings**. Learn a rotary for **Pending slot**, a separate button for **Confirm pending slot**, and two bank controls. Learn knobs or faders for parameters declared with `midiParam()` after saving and running the sketch in a slot. See [the MIDI guide](MIDI.md) for the UC-33 acceptance checklist and button modes.

The [MIDI easing diagnostic](midi-easing/README.md) contains a six-lane Setup and Sketch. Use it to compare smoothing durations and custom easing curves.

## Editor

Press Tab to accept a completion. Callable completions put the cursor inside the parentheses and display available parameter hints. See [Signature Assist](SIGNATURE-ASSIST.md) for keyboard controls and supported completions.

## Windows graphics preference

Open **Output Settings → Graphics** to choose **Let Windows decide**, **Power saving**, or **High performance**. Restart HYDRACTRL and check **Active renderer**. Spout works best when HYDRACTRL and the receiver use the same GPU. Set the preference again if you copy the Portable to another PC or move the executable.

## Ableton Link

Open **Output → Ableton Link…** to enable the desktop timing bridge. Link is disabled by default. The bundled **Link Test Peer** can drive a private test session with the supplied **Link Test Scene**. The [Windows Link test guide](LINK-WINDOWS-TEST.md) describes the sender and peer controls.

## Spectral Analysis

Open **Spectral Diagnostics** for the supplied sketches and WAV. Select an audio input or loopback in the editor and use the WAV with the [diagnostic guide](SPECTRAL_ANALYSIS.md). Use `a.clearBandRanges()` to return to legacy FFT bins.

## Storage and recovery

The **portable-data** folder beside HYDRACTRL.exe holds the browser profile, scene banks, Setup, MIDI assignments, settings, logs, and default media. The renderer uses the fixed local origin **http://127.0.0.1:43129**. If that port is in use, close the other listener and retry. Moving or renaming the parent folder preserves the profile when you move its contents together.

Before upgrading, export the banks and copy the Setup text as additional backups. For a Portable-to-Portable upgrade, extract beside the old copy and copy its entire **portable-data** folder before first launch. Keep the old installation and shortcut details until the new app and Spout pass a restart check. To carry over the previous Signature Assist Portable's main profile, close both apps, then copy **signature-test-data/main** to **portable-data** in the new extraction before its first launch. Keep the original copy. For the old biotech or smoke modes, launch that mode in the original copy and export its banks and copy Setup. Those modes used different origins. Custom absolute media paths may need to be selected again. If the new extraction already has data, back it up before replacing any profile files.

See **BUILD-INFO.json** for the source revision and build version. This prerelease is unsigned.
