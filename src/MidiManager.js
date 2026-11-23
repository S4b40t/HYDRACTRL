/**
 * MIDI Manager
 * A simple manager for MIDI input devices with special support for Korg nanoPAD2
 */
import { createSafeStorage } from "./client/core/Storage.js";
import {
  NAVIGATION_ACTIONS,
  controlKey,
  createNavigationControls,
  isContinuousAction,
  normalizeControl,
  normalizeNavigationProfile,
  readMidiControl,
} from "./client/core/midiControls.js";

const PREFERENCE_KEY = "hydractrl-midi-preferences";
const PROFILE_PREFIX = "hydractrl-midi-profile:";

function profileKey(device) {
  return PROFILE_PREFIX + device.id;
}

// MIDI device state
/**
 * The scene a pad's note belongs to: the current scene when its mapping has
 * the note, else the first scene whose mapping does, or -1 when none does.
 * Each nanoPAD2 scene plays its own notes, so the pads tell which scene the
 * controller is on even when its scene button's message never arrives.
 */
export function sceneForNote(mapping, currentScene, note) {
  const has = (scene) =>
    Array.isArray(mapping[scene]) && mapping[scene].some((m) => m.note === note);
  if (has(currentScene)) return currentScene;
  for (let scene = 0; scene < mapping.length; scene++) {
    if (has(scene)) return scene;
  }
  return -1;
}

export function createMidiManager(slotsPanel, { storage = createSafeStorage() } = {}) {
  let isNanoPad = false;
  let midiAccess = null;
  let activeDevice = null;
  let isConnected = false;
  let xyPadPanel = null;
  const xyPadValues = { x: 0, y: 0 };
  let preferredId = storage.get(PREFERENCE_KEY);
  let navigation = {};
  let controlLearn = null;
  let accessStatus = "Initializing…";
  let statusTimer;
  const navigationControls = createNavigationControls(slotsPanel);
  const suppressed = new Set();

  function refresh() {
    window.updateMidiDeviceList?.();
  }

  function reservedControl(control) {
    if (!isNanoPad) return false;
    if (control.type === "cc") return [1, 2, 16].includes(control.number);
    return sceneForNote(midiMapping, currentScene, control.number) !== -1;
  }

  function assignNavigation(action, control) {
    if (!activeDevice) return "Select a MIDI input first.";
    if (!Object.hasOwn(NAVIGATION_ACTIONS, action)) return "Unknown MIDI action.";
    const binding = normalizeControl(control, isContinuousAction(action));
    if (control && !binding) return "Use a MIDI CC for this selector.";
    if (binding && reservedControl(binding)) return "This control is reserved for the nanoPAD2.";
    const conflict =
      binding &&
      Object.keys(navigation).find(
        (other) => other !== action && controlKey(navigation[other]) === controlKey(binding),
      );
    if (conflict) return `Already assigned to ${NAVIGATION_ACTIONS[conflict]}.`;
    const next = { ...navigation };
    if (binding) next[action] = binding;
    else delete next[action];
    if (!storage.setJSON(profileKey(activeDevice), next)) return "Could not save the profile.";
    navigation = next;
    navigationControls.reset();
    return null;
  }

  // Initialize global XY pad values
  window.nanoX = 0.5;
  window.nanoY = 0.5;
  xyPadValues.x = 0;
  xyPadValues.y = 0;

  // MIDI learn mode state
  let isLearning = false;
  let learnCallback = null;

  // Create notification for MIDI status
  const midiStatus = document.createElement("div");
  midiStatus.className = "midi-status";
  midiStatus.style.position = "absolute";
  midiStatus.style.bottom = "10px";
  midiStatus.style.left = "10px";
  midiStatus.style.fontSize = "10px";
  midiStatus.style.color = "#aaa";
  midiStatus.style.padding = "4px";
  midiStatus.style.borderRadius = "3px";
  midiStatus.style.backgroundColor = "rgba(30, 30, 30, 0.6)";
  midiStatus.style.display = "none";
  document.body.appendChild(midiStatus);

  // Show/hide MIDI status with animation
  function showMidiStatus(message, isError = false) {
    midiStatus.textContent = message;
    midiStatus.style.color = isError ? "#ff5555" : "#aaa";
    midiStatus.style.display = "block";
    midiStatus.style.opacity = "1";

    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      midiStatus.style.display = "none";
    }, 5000);
  }

  // Initialize MIDI system
  function init() {
    if (!navigator.requestMIDIAccess) {
      console.warn("WebMIDI is not supported in this browser");
      showMidiStatus("MIDI not supported in this browser", true);
      return false;
    }

    navigator
      .requestMIDIAccess({ sysex: true })
      .catch(() => navigator.requestMIDIAccess())
      .then(onMIDISuccess, onMIDIFailure);

    return true;
  }

  // Handle successful MIDI access
  function onMIDISuccess(access) {
    midiAccess = access;

    // Listen for connect/disconnect events
    midiAccess.onstatechange = onStateChange;

    updateConnection();
  }

  function availableDevices() {
    return [...(midiAccess?.inputs.values() ?? [])].filter(
      (input) => input.state !== "disconnected",
    );
  }

  function updateConnection() {
    const inputs = availableDevices();
    const device = preferredId
      ? inputs.find((input) => input.id === preferredId)
      : (inputs.find((input) => input === activeDevice) ?? inputs[0]);
    if ((device ?? null) !== activeDevice) {
      if (activeDevice) activeDevice.onmidimessage = null;
      activeDevice = device ?? null;
      isConnected = Boolean(device);
      isNanoPad = device?.name?.toLowerCase().includes("nanopad") ?? false;
      currentScene = slotsPanel?.getBank?.() ?? 0;
      navigation = device ? normalizeNavigationProfile(storage.getJSON(profileKey(device))) : {};
      navigationControls.reset();
      suppressed.clear();
      controlLearn = null;
      isLearning = false;
      learnCallback = null;
      slotsPanel?.clearPending?.();
      if (device) {
        device.onmidimessage = (message) => {
          if (activeDevice === device && device.state !== "disconnected") onMIDIMessage(message);
        };
      }
    }
    accessStatus = device
      ? device.name || "Unknown device"
      : preferredId
        ? "Selected input unavailable"
        : "No devices found";
    refresh();
  }

  function onStateChange(event) {
    if (event.port.type === "input") updateConnection();
  }

  // Handle MIDI failure
  function onMIDIFailure(error) {
    console.error("MIDI access failed:", error);
    accessStatus = "Access failed. Check permissions.";
    showMidiStatus("MIDI access failed. Check permissions.", true);
    refresh();
  }

  // Track the current scene on the nanoPAD
  let currentScene = 0; // Scene 1 by default

  // Track rate limiting for messages that may come from XY pad
  const lastCCTime = {};
  const THROTTLE_TIME = 150; // ms between allowed bank changes
  const CC_THROTTLE_TIME = 25;
  let lastBankChange = 0;

  // Handle MIDI messages
  function onMIDIMessage(message) {
    const data = message.data;
    if (!data?.length) return;
    const control = readMidiControl(data);
    if (control) {
      const key = controlKey(control);
      if (suppressed.has(key)) {
        if (control.value < (control.type === "cc" ? 64 : 1)) suppressed.delete(key);
        return;
      }
      if (controlLearn) {
        const { continuous, callback } = controlLearn;
        if (continuous ? control.type === "cc" : control.value > 0) {
          controlLearn = null;
          if (!continuous) suppressed.add(key);
          callback(normalizeControl(control));
        }
        return;
      }
      if (!isLearning && !reservedControl(control)) {
        const action = Object.keys(navigation).find((name) => controlKey(navigation[name]) === key);
        if (action) {
          navigationControls.dispatch(action, navigation[action], control);
          return;
        }
      }
    }
    const cmd = data[0] & 0xf0; // Command byte (top 4 bits)
    const channel = data[0] & 0x0f; // Channel (bottom 4 bits)

    // Special guard for XY pad - block high frequency CC messages
    if (cmd === 0xb0) {
      // Control Change
      const ccNum = data[1];
      const value = data[2];

      // Check if this CC number is for the XY pad
      if ([1, 2].includes(ccNum)) {
        // Throttle the message if it's coming too fast
        const now = Date.now();
        const ccKey = `${channel}_${ccNum}`;
        const lastTime = lastCCTime[ccKey] || 0;
        if (now - lastTime < CC_THROTTLE_TIME) {
          return;
        }
        lastCCTime[ccKey] = now;

        // Update XY pad values
        const normalizedValue = value / 127;
        if (ccNum === 2) {
          window.nanoY = normalizedValue;
          xyPadValues.y = normalizedValue;
          if (xyPadPanel) {
            xyPadPanel.updateFromMIDIY(normalizedValue);
          }
        } else if (ccNum === 1) {
          window.nanoX = normalizedValue;
          xyPadValues.x = normalizedValue;
          if (xyPadPanel) {
            xyPadPanel.updateFromMIDIX(normalizedValue);
          }
        }

        // Update XY pad panel if available
        if (xyPadPanel && typeof xyPadPanel.updateFromMIDI === "function") {
          xyPadPanel.updateFromMIDI(xyPadValues.x, xyPadValues.y);
        }

        return;
      }
    }

    // Enhanced MIDI debugging
    let messageType = "Unknown";
    switch (cmd) {
      case 0x80:
        messageType = "Note Off";
        break;
      case 0x90:
        messageType = data[2] > 0 ? "Note On" : "Note Off";
        break;
      case 0xa0:
        messageType = "Aftertouch";
        break;
      case 0xb0:
        messageType = "Control Change";
        if (isNanoPad && xyPadPanel && data[1] === 16 && data[2] === 0) {
          xyPadPanel.handlePadRelease();
        }
        break;
      case 0xc0:
        messageType = "Program Change";
        break;
      case 0xd0:
        messageType = "Channel Pressure";
        break;
      case 0xe0:
        messageType = "Pitch Bend";
        break;
      case 0xf0:
        messageType = "System Exclusive";
        break;
    }

    // Special case for SysEx messages (240 = 0xF0)
    if (isNanoPad && data[0] === 240) {
      // Check for nanoPAD2 scene change SysEx messages
      // Pattern: [240, 66, 64, 0, 1, 18, 0, 95, 79, sceneNumber, 247]
      if (data[1] === 66 && data[2] === 64 && data[8] === 79) {
        const sceneNumber = data[9];
        if (sceneNumber >= 0 && sceneNumber <= 3) {
          // Throttle scene changes to prevent issues from XY pad
          const now = Date.now();

          // Only allow a scene change if it's been at least THROTTLE_TIME ms since the last one
          // This prevents the XY pad from triggering multiple scene changes
          if (now - lastBankChange >= THROTTLE_TIME) {
            console.debug(`nanoPAD2 Scene change SysEx detected: Scene ${sceneNumber + 1}`);
            lastBankChange = now;
            handlePossibleSceneChange(sceneNumber);
          } else {
            console.debug("Throttling nanoPAD2 scene change to prevent XY pad interference");
          }
        }
      }
    }

    console.debug(
      `MIDI ${messageType}: [${data.join(", ")}] Channel: ${channel + 1}`,
      cmd === 0x90
        ? `Note: ${data[1]} Velocity: ${data[2]}`
        : cmd === 0xb0
          ? `Controller: ${data[1]} Value: ${data[2]}`
          : cmd === 0xc0
            ? `Program: ${data[1]}`
            : "",
    );

    // Handle nanoPAD2 pad press
    if (isNanoPad) {
      // Note On message (button press)
      if (cmd === 0x90 && data[2] > 0) {
        // Note On with velocity > 0
        const note = data[1];

        // If in learn mode, call the learn callback
        if (isLearning && learnCallback) {
          isLearning = false;
          learnCallback(note);
          learnCallback = null;
          return;
        }

        // Process regular pad notes (not scene buttons)
        handleNanoPadNote(note);
      }

      // Program Change messages - sometimes used for scene changes
      if (cmd === 0xc0) {
        // Program Change
        const program = data[1];

        // If program is in range 0-3, it might be a scene change
        if (program >= 0 && program <= 3) {
          handlePossibleSceneChange(program);
        }
      }

      // For nanoPAD2, we've determined that it uses SysEx messages for scene changes
      // So we'll completely ignore CC messages for scene changes to prevent the XY pad
      // from triggering unwanted bank changes
      if (cmd === 0xb0) {
        // CC message
        // Just log the message but don't take action
        const ccNum = data[1];
        const value = data[2];
        console.debug(`Ignoring CC#${ccNum}=${value} to prevent XY pad interference`);
      }
    } else {
      // Generic MIDI handling for other devices
      // Note On
      if (cmd === 0x90 && data[2] > 0) {
        const note = data[1];
        handleGenericNote(note);
      }
    }
  }

  // Helper for handling scene changes. With a `slot` (a pad of another
  // scene was pressed), the bank lands on that slot, else on the first one.
  function handlePossibleSceneChange(sceneNumber, slot) {
    if (sceneNumber >= 0 && sceneNumber <= 3) {
      console.log(`Scene change detected: ${sceneNumber + 1}`);

      // Update current scene
      currentScene = sceneNumber;

      // Switch bank to match scene
      if (slotsPanel && slotsPanel.switchBank) {
        if (slot === undefined) {
          slotsPanel.switchBank(sceneNumber);
        } else if (slotsPanel.getBank?.() === sceneNumber) {
          // The bank was picked in the slots panel already
          slotsPanel.setActiveSlot(slot);
        } else {
          slotsPanel.switchBank(sceneNumber, slot);
        }
      }

      // Update MIDI status with highlighted text
      showMidiStatus(`Scene ${sceneNumber + 1} / Bank ${sceneNumber + 1} selected`);

      // Update UI if needed
      if (window.updateMidiDeviceList) {
        window.updateMidiDeviceList();
      }

      // Visual feedback - flash the active bank dot
      if (window.flashActiveBankDot) {
        window.flashActiveBankDot(sceneNumber);
      } else {
        // Create a temporary visual indicator
        const notification = document.createElement("div");
        notification.className = "saved-notification";
        notification.style.backgroundColor = "rgba(80, 250, 123, 0.8)";
        notification.textContent = `Scene ${sceneNumber + 1} / Bank ${sceneNumber + 1}`;
        notification.style.position = "fixed";
        notification.style.top = "50%";
        notification.style.left = "50%";
        notification.style.transform = "translate(-50%, -50%)";
        notification.style.fontSize = "24px";
        notification.style.padding = "20px";
        notification.style.borderRadius = "10px";
        notification.style.boxShadow = "0 0 20px rgba(0, 0, 0, 0.5)";
        notification.style.zIndex = "2000";
        document.body.appendChild(notification);

        // Remove after a short time
        setTimeout(() => {
          notification.classList.add("fade-out");
          setTimeout(() => {
            if (notification.parentNode) {
              document.body.removeChild(notification);
            }
          }, 300);
        }, 800);
      }

      return true;
    }
    return false;
  }

  // Define the default MIDI mapping structure
  const defaultMidiMapping = [
    // Bank 0 (Scene 1) - maps top row to even slots, bottom row to odd slots
    [
      { note: 37, slot: 0 },
      { note: 39, slot: 1 },
      { note: 41, slot: 2 },
      { note: 43, slot: 3 },
      { note: 45, slot: 4 },
      { note: 47, slot: 5 },
      { note: 49, slot: 6 },
      { note: 51, slot: 7 },
      { note: 36, slot: 8 },
      { note: 38, slot: 9 },
      { note: 40, slot: 10 },
      { note: 42, slot: 11 },
      { note: 44, slot: 12 },
      { note: 46, slot: 13 },
      { note: 48, slot: 14 },
      { note: 50, slot: 15 },
    ],
    // Bank 1 (Scene 2) - using same mapping pattern with different notes
    [
      { note: 53, slot: 0 }, // Top row (higher notes)
      { note: 55, slot: 1 },
      { note: 57, slot: 2 },
      { note: 59, slot: 3 },
      { note: 61, slot: 4 },
      { note: 63, slot: 5 },
      { note: 65, slot: 6 },
      { note: 67, slot: 7 },
      { note: 52, slot: 8 }, // Bottom row (lower notes)
      { note: 54, slot: 9 },
      { note: 56, slot: 10 },
      { note: 58, slot: 11 },
      { note: 60, slot: 12 },
      { note: 62, slot: 13 },
      { note: 64, slot: 14 },
      { note: 66, slot: 15 },
    ],
    // Bank 2 (Scene 3) - using same mapping pattern with different notes
    [
      { note: 69, slot: 0 }, // Top row (higher notes)
      { note: 71, slot: 1 },
      { note: 73, slot: 2 },
      { note: 75, slot: 3 },
      { note: 77, slot: 4 },
      { note: 79, slot: 5 },
      { note: 81, slot: 6 },
      { note: 83, slot: 7 },
      { note: 68, slot: 8 }, // Bottom row (lower notes)
      { note: 70, slot: 9 },
      { note: 72, slot: 10 },
      { note: 74, slot: 11 },
      { note: 76, slot: 12 },
      { note: 78, slot: 13 },
      { note: 80, slot: 14 },
      { note: 82, slot: 15 },
    ],
    // Bank 3 (Scene 4) - using same mapping pattern with different notes
    [
      { note: 85, slot: 0 }, // Top row (higher notes)
      { note: 87, slot: 1 },
      { note: 89, slot: 2 },
      { note: 91, slot: 3 },
      { note: 93, slot: 4 },
      { note: 95, slot: 5 },
      { note: 97, slot: 6 },
      { note: 99, slot: 7 },
      { note: 84, slot: 8 }, // Bottom row (lower notes)
      { note: 86, slot: 9 },
      { note: 88, slot: 10 },
      { note: 90, slot: 11 },
      { note: 92, slot: 12 },
      { note: 94, slot: 13 },
      { note: 96, slot: 14 },
      { note: 98, slot: 15 },
    ],
  ];

  // Load saved mapping from localStorage or use default
  function loadMidiMapping() {
    try {
      const savedMapping = localStorage.getItem("hydractrl-midi-mapping");
      if (savedMapping) {
        const parsed = JSON.parse(savedMapping);
        // Validate the mapping structure
        if (Array.isArray(parsed) && parsed.length === 4) {
          return parsed;
        }
      }
    } catch (error) {
      console.error("Error loading MIDI mapping:", error);
    }

    // Return default mapping if no valid mapping is found
    return JSON.parse(JSON.stringify(defaultMidiMapping));
  }

  // Save mapping to localStorage
  function saveMidiMapping(mapping) {
    try {
      localStorage.setItem("hydractrl-midi-mapping", JSON.stringify(mapping));
      return true;
    } catch (error) {
      console.error("Error saving MIDI mapping:", error);
      return false;
    }
  }

  // Load or initialize the MIDI mapping
  const midiMapping = loadMidiMapping();

  // Handle nanoPAD2 pad press
  function handleNanoPadNote(note) {
    console.log(`nanoPAD2 pad: ${note}`);

    // The scene the pad belongs to: the current one, unless the nanoPAD2
    // moved to another scene without its scene button's message reaching us
    // (it is SysEx, which a browser can garble: Chromium 152 did on macOS)
    const scene = sceneForNote(midiMapping, currentScene, note);
    if (scene < 0 || !slotsPanel) {
      console.debug(`No mapping found for MIDI note ${note} in bank ${currentScene}`);
      return;
    }
    const mapping = midiMapping[scene].find((m) => m.note === note);
    if (scene !== currentScene) {
      console.info(
        `nanoPAD2: pad ${note} is on scene ${scene + 1}; following it there ` +
          "(the scene button's message didn't arrive)",
      );
      handlePossibleSceneChange(scene, mapping.slot);
      return;
    }

    console.debug(`MIDI note ${note} maps to slot ${mapping.slot}`);
    slotsPanel.setActiveSlot(mapping.slot);
  }

  // Handle generic MIDI notes for other controllers
  function handleGenericNote(note) {
    // Map MIDI notes to slot index (0-15)
    // Common midi note range starts at 48 (C3)
    const slotIndex = (note - 48) % 16;

    if (slotIndex >= 0 && slotIndex < 16 && slotsPanel) {
      slotsPanel.setActiveSlot(slotIndex);
    }
  }

  // Public API
  return {
    init,
    isConnected: () => isConnected,
    getActiveDevice: () => activeDevice,
    // Get current scene
    getCurrentScene: () => currentScene,
    // Set scene and bank
    setScene: (sceneIndex) => {
      if (sceneIndex >= 0 && sceneIndex < 4) {
        currentScene = sceneIndex;

        // Also change the bank to match
        if (slotsPanel && slotsPanel.switchBank) {
          slotsPanel.switchBank(sceneIndex);
        }

        return true;
      }
      return false;
    },
    getAccessStatus: () => accessStatus,
    getPreferredId: () => preferredId,
    selectDevice: (id) => {
      if (id !== null && !availableDevices().some((input) => input.id === id)) return false;
      if (!(id === null ? storage.remove(PREFERENCE_KEY) : storage.set(PREFERENCE_KEY, id))) {
        return false;
      }
      preferredId = id;
      updateConnection();
      return true;
    },
    connectToDeviceByIndex: (index) => {
      const input = availableDevices()[index];
      if (!input || !storage.set(PREFERENCE_KEY, input.id)) return false;
      preferredId = input.id;
      updateConnection();
      return true;
    },
    listDevices: () =>
      availableDevices().map((input) => ({
        id: input.id,
        name: input.name,
        manufacturer: input.manufacturer,
        isActive: activeDevice === input,
      })),
    getNavigation: () => structuredClone(navigation),
    assignNavigation,
    resetNavigation: () => {
      if (!activeDevice || !storage.remove(profileKey(activeDevice))) return false;
      navigation = {};
      navigationControls.reset();
      slotsPanel?.clearPending?.();
      return true;
    },
    learnControl: (continuous, callback) => {
      if (!activeDevice) return false;
      isLearning = false;
      learnCallback = null;
      controlLearn = { continuous, callback };
      return true;
    },
    cancelControlLearn: () => {
      controlLearn = null;
    },
    // Get the current MIDI mapping for reference
    getMidiMapping: () => {
      return JSON.parse(JSON.stringify(midiMapping)); // Return a deep copy
    },
    // Update a specific note mapping in the current bank
    updateMapping: (note, slotIndex) => {
      if (slotIndex < 0 || slotIndex > 15) return false;

      // Find the existing mapping for this note
      const mapIndex = midiMapping[currentScene].findIndex((m) => m.note === note);

      if (mapIndex >= 0) {
        // Update existing mapping
        midiMapping[currentScene][mapIndex].slot = slotIndex;
      } else {
        // Add new mapping
        midiMapping[currentScene].push({
          note: note,
          slot: slotIndex,
        });
      }

      // Save to localStorage
      saveMidiMapping(midiMapping);

      return true;
    },
    // Set an entirely new mapping for a specific bank/scene
    setMappingForBank: (bankIndex, newMapping) => {
      if (bankIndex < 0 || bankIndex > 3) return false;

      // Validate mapping
      if (!Array.isArray(newMapping)) return false;

      midiMapping[bankIndex] = newMapping;

      // Save to localStorage
      saveMidiMapping(midiMapping);
      return true;
    },

    // Save current mapping configuration
    saveMapping: () => {
      return saveMidiMapping(midiMapping);
    },

    // Reset to default mapping
    resetToDefaultMapping: () => {
      // Reset to default mapping
      for (let i = 0; i < 4; i++) {
        midiMapping[i] = JSON.parse(JSON.stringify(defaultMidiMapping[i]));
      }

      // Save to localStorage
      saveMidiMapping(midiMapping);
      return true;
    },

    // Get current XY pad values (normalized 0-1)
    getXYPadValues: () => {
      return { ...xyPadValues }; // Return a copy
    },

    // Start MIDI learn mode
    startLearnMode: (callback) => {
      controlLearn = null;
      isLearning = true;
      learnCallback = callback;
      showMidiStatus("Press a pad to map it...", false);
    },

    // Cancel MIDI learn mode
    cancelLearnMode: () => {
      isLearning = false;
      learnCallback = null;
      showMidiStatus("MIDI learn cancelled", false);
    },

    // Check if we're in learn mode
    isLearning: () => isLearning,

    // Set the XY pad panel
    setXYPadPanel: (panel) => {
      xyPadPanel = panel;
      // Initialize with current values if they exist
      if (panel && typeof panel.updateFromMIDI === "function" && xyPadValues.x !== undefined) {
        panel.updateFromMIDI(xyPadValues.x, xyPadValues.y);
      }
    },
  };
}
