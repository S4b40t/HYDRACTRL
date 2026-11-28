import { NAVIGATION_ACTIONS, isContinuousAction } from "../core/midiControls.js";
import { MAX_ARTICULATION_MS, MIDI_EASINGS } from "../core/sketchParameters.js";

function button(text, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.addEventListener("click", action);
  return element;
}

function bindingLabel(binding) {
  if (!binding) return "Unassigned";
  const type = binding.type === "cc" ? "CC" : "Note";
  return `${type} ${binding.number} · Ch ${binding.channel + 1}${binding.mode ? " · Toggle" : ""}`;
}

function articulationControls(name, binding, definition, save) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Articulation";
  details.append(summary);
  const form = document.createElement("form");
  const fields = new Map();
  for (const [direction, label] of [
    ["attack", "Attack"],
    ["release", "Release"],
  ]) {
    const row = document.createElement("div");
    const duration = document.createElement("input");
    duration.type = "number";
    duration.min = "0";
    duration.max = String(MAX_ARTICULATION_MS);
    duration.step = "any";
    duration.style.width = "6em";
    duration.placeholder = String(definition[direction]);
    duration.value = binding.articulation?.[direction] ?? "";
    duration.setAttribute("aria-label", `${name} ${direction} duration (ms)`);
    const easeKey = `${direction}Ease`;
    const ease = document.createElement("select");
    ease.setAttribute("aria-label", `${name} ${direction} easing`);
    ease.add(new Option("Sketch default", ""));
    for (const [key, entry] of Object.entries(MIDI_EASINGS)) {
      ease.add(new Option(entry.label, key));
    }
    ease.value = binding.articulation?.[easeKey] ?? "";
    const caption = document.createElement("label");
    caption.append(`${label} (ms) `, duration);
    row.append(caption, ease);
    fields.set(direction, duration);
    fields.set(easeKey, ease);
    form.append(row);
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Save articulation";
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const overrides = {};
    for (const [key, field] of fields) {
      if (field.value !== "") {
        overrides[key] = field.type === "number" ? field.valueAsNumber : field.value;
      }
    }
    save(overrides);
  });
  form.append(
    button("Use sketch defaults", () => {
      if (save({})) for (const field of fields.values()) field.value = "";
    }),
  );
  details.append(form);
  return details;
}

export function createMidiUiPlugin() {
  return {
    id: "midi-ui",
    name: "MIDI Device UI",
    description: "MIDI device selection and mapping in the stats panel",

    setup(ctx) {
      const midi = ctx.getPanels().stats?.midi;
      const manager = ctx.midi?.manager;
      if (ctx.isMobile || !midi || !manager) return;
      if (!ctx.midi.supported) {
        midi.statusText.textContent = "MIDI unavailable in this browser";
        return;
      }

      const deviceSelect = document.createElement("select");
      deviceSelect.setAttribute("aria-label", "MIDI input");
      const config = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "MIDI mappings";
      const form = document.createElement("div");
      form.style.maxHeight = "min(40vh, 360px)";
      form.style.overflowY = "auto";
      const feedback = document.createElement("div");
      feedback.setAttribute("role", "status");
      feedback.style.padding = "4px 0";

      function cancelLearn() {
        manager.cancelControlLearn();
        if (manager.isLearning()) manager.cancelLearnMode();
        feedback.textContent = "";
      }

      function learn(label, continuous, assign) {
        if (
          !manager.learnControl(continuous, (binding) => {
            feedback.textContent = assign(binding) || `Assigned ${label}.`;
            renderMappings();
          })
        ) {
          feedback.textContent = "Select a MIDI input first.";
          return;
        }
        feedback.textContent = continuous
          ? `Move a fader or knob for ${label}.`
          : `Press a button for ${label}.`;
      }

      function mappingRow(label, binding, continuous, assign) {
        const row = document.createElement("div");
        row.style.marginBottom = "5px";
        const title = document.createElement("div");
        title.textContent = `${label} · ${bindingLabel(binding)}`;
        row.append(
          title,
          button("Learn", () => learn(label, continuous, assign)),
        );
        if (binding) {
          const change = (next) => {
            cancelLearn();
            feedback.textContent = assign(next) || "";
            renderMappings();
          };
          if (!continuous && binding.type === "cc") {
            row.append(
              button(binding.mode ? "Use momentary" : "Use toggle", () =>
                change({ ...binding, mode: binding.mode ? undefined : "toggle" }),
              ),
            );
          }
          row.append(button("Clear", () => change(null)));
        }
        return row;
      }

      function renderParameters() {
        const title = document.createElement("div");
        const slot = manager.getParameterSlot();
        const rows = manager.getParameterMappings();
        title.textContent = slot
          ? `Sketch parameters · Bank ${slot.bank + 1} / Slot ${slot.slot + 1}`
          : "Sketch parameters";
        title.style.marginTop = "8px";
        form.append(title);
        if (!rows.length || !slot) {
          const message = document.createElement("div");
          message.textContent = rows.length
            ? "Save the running sketch to a slot to assign its parameters."
            : "The running sketch has no MIDI parameters.";
          form.append(message);
          return;
        }
        form.append(
          button("Reset parameter values", () => {
            manager.resetParameterValues();
            feedback.textContent = "Parameters returned to sketch defaults.";
          }),
        );
        for (const { name, binding, conflict, definition } of rows) {
          const row = mappingRow(name, binding, true, (next) =>
            manager.assignParameter(name, next),
          );
          if (conflict) {
            const message = document.createElement("div");
            message.textContent = conflict;
            row.append(message);
          }
          if (binding) {
            row.append(
              articulationControls(name, binding, definition, (overrides) => {
                const error = manager.configureParameter(name, overrides);
                feedback.textContent = error || `Saved articulation for ${name}.`;
                return !error;
              }),
            );
          }
          form.append(row);
        }
      }

      function renderMappings() {
        form.replaceChildren();
        if (!manager.getActiveDevice()) return;
        const navigation = manager.getNavigation();
        for (const [action, label] of Object.entries(NAVIGATION_ACTIONS)) {
          form.append(
            mappingRow(label, navigation[action], isContinuousAction(action), (binding) =>
              manager.assignNavigation(action, binding),
            ),
          );
        }
        form.append(
          button("Reset navigation", () => {
            cancelLearn();
            feedback.textContent = manager.resetNavigation()
              ? "Navigation profile cleared."
              : "Could not clear the profile.";
            renderMappings();
          }),
        );
        if (manager.getActiveDevice().name?.toLowerCase().includes("nanopad")) {
          form.append(
            button("Sync Scene ⟷ Bank", () => manager.setScene(ctx.getPanels().slots.getBank())),
            button("Learn pad for active slot", () => {
              cancelLearn();
              feedback.textContent = "Press the nanoPAD2 pad for the active slot.";
              manager.startLearnMode((note) => {
                const slot = ctx.getPanels().slots.getActiveSlotIndex();
                manager.updateMapping(note, slot);
                feedback.textContent = `Assigned pad note ${note} to slot ${slot + 1}.`;
              });
            }),
            button("Show pad notes", () => {
              const bank = manager.getCurrentScene();
              const notes = manager.getMidiMapping()[bank].sort((a, b) => a.slot - b.slot);
              alert(
                `Bank ${bank + 1}\n${notes.map(({ note, slot }) => `Note ${note} → Slot ${slot + 1}`).join("\n")}`,
              );
            }),
            button("Reset pad notes", () => {
              if (confirm("Reset nanoPAD2 notes to defaults?")) manager.resetToDefaultMapping();
            }),
          );
        }
        renderParameters();
      }

      function updateDeviceList() {
        const preferred = manager.getPreferredId();
        const devices = manager.listDevices();
        deviceSelect.replaceChildren(new Option("Automatic MIDI input", ""));
        for (const device of devices) {
          const label = device.name || "Unknown device";
          deviceSelect.add(new Option(label, device.id));
        }
        if (preferred !== null && !devices.some(({ id }) => id === preferred)) {
          deviceSelect.add(new Option("Saved input unavailable", preferred));
        }
        deviceSelect.value = preferred ?? "";
        midi.statusText.textContent = `MIDI · ${manager.getAccessStatus()}`;
        renderMappings();
      }

      deviceSelect.addEventListener("change", () => {
        cancelLearn();
        if (!manager.selectDevice(deviceSelect.value || null)) {
          feedback.textContent = "Could not select the MIDI input.";
          updateDeviceList();
        }
      });
      config.addEventListener("toggle", () => {
        if (!config.open) cancelLearn();
      });
      config.append(summary, feedback, button("Cancel Learn", cancelLearn), form);
      midi.deviceContainer.append(deviceSelect, config);
      window.updateMidiDeviceList = updateDeviceList;
      updateDeviceList();
      const offRun = ctx.events.on("sketch:run", () => {
        cancelLearn();
        renderMappings();
      });

      return {
        api: { updateDeviceList },
        dispose() {
          cancelLearn();
          offRun();
          deviceSelect.remove();
          config.remove();
          if (window.updateMidiDeviceList === updateDeviceList) {
            window.updateMidiDeviceList = undefined;
          }
        },
      };
    },
  };
}
