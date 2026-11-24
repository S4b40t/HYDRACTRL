# HYDRACTRL Link Experimental · 10–15 minute Windows check

You need Windows 10 or 11 (x64) and the extracted test package. Test on a private network without other active Link sessions. The test peer’s tempo buttons intentionally change the session tempo. Ableton Live, MIDI, and audio input are unnecessary for this check.

1. Extract the entire ZIP into a new folder. Open `HYDRACTRL` and double-click `HYDRACTRL Link Experimental.exe`. Leave the other files in place. This build uses its own settings, media folder, and browser storage.
2. Choose **Output → Ableton Link…**. Enable **Ableton Link** and leave **Beats per cycle** at 4. The helper should change from **Starting** to **Local timing**, with zero peers.
3. In the extracted `Link Test Peer` folder, double-click `LinkTestPeer.exe`. Both programs should show one peer. HYDRACTRL should show **Synced** and the same BPM as the test peer. If Windows prompts about network access, allow both programs on the private network used for this test.
4. In HYDRACTRL’s Stats panel, click **Link Test Scene** and confirm the Sketch tab replacement. The square should step through four positions in teal, pulse on each beat, and flash gold on the first beat of the cycle. If the button is out of view, open the Stats panel or copy the supplied `Link Test Scene.js` into the Sketch tab and press **Run**. The scene needs no Setup edits or saved bank.
5. In the peer, click **90 BPM**, then **140 BPM**, then **120 BPM**. Both BPM readouts should agree. The square should move more slowly at 90 and faster at 140.
6. Click **Disconnect** in the peer. HYDRACTRL should return to **Local timing** with zero peers. The square should turn red and continue at the last tempo. Click **Reconnect**. The peer count and teal/gold cycle should return. A single repositioning of the square can occur when the timing grids meet again.
7. If you use Resolume, start Spout from the **Output** menu and select the **HYDRACTRL Link Experimental** sender. Repeat one tempo change and one disconnect/reconnect. The visual in Resolume should follow the same cycle and BPM changes. Restart output once and check that the visual resumes. Skip this step if you do not have a Spout receiver.
8. Close HYDRACTRL and the peer normally. Both windows should close. If you close HYDRACTRL first, the test peer should return to zero peers without a restart.

If a step fails, click **Copy Link Diagnostics** in Link settings and paste it into the GitHub issue. Include the step number, what happened, the peer’s BPM and peer count, and whether Spout was on. The report contains timing and helper status. Review it before posting.
