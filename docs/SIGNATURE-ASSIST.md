# Native Hydra signature assistance

The bundled editor plugin shows a call signature and highlights the current parameter using CodeMirror’s JavaScript syntax tree. Escape dismisses the hint. The editor’s autocomplete keeps its existing keybindings.

## Catalog audit

The v0.1 resolver uses the 76 function records in [the app’s Hydra catalog](../src/data/hydra-functions.json), checked against the locked `hydra-synth` 1.3.29 source and HYDRACTRL’s [Hydra initialization](../src/client/index.js) and [sketch bindings](../src/client/core/sketchRunner.js). The audit covers 68 callable records and excludes 8 globals or properties.

| Coverage | Recognized form |
| --- | --- |
| Seven generators | Direct `noise`, `voronoi`, `osc`, `shape`, `gradient`, `solid`, and `src` calls. |
| Texture transforms, color, composition and modulation | Catalog texture methods on a recognized generator call or a chain of those methods. `out` is terminal. Combine methods keep the catalog’s leading `texture` parameter, which Hydra adds to the shader input list. |
| Four helpers | Direct `render`, `hush`, `setResolution`, and `setFunction` calls. |
| Five source methods | `init`, `initCam`, `initScreen`, `initVideo`, and `initImage` on `s0` through `s3`. |
| Five audio methods | `setSmooth`, `setCutoff`, `setScale`, `setBins`, and `show` on `a`. |
| Five array methods | `fast`, `smooth`, `ease`, `offset`, and `fit` on array literals and recognized array-method chains. |

- `time`, `speed`, `bpm`, `width`, `height`, `mouse`, and `a.fft` are values. `update` is a user-assigned frame callback, so no fixed signature is offered.
- Locked GLSL generator and transform declarations agree with the displayed numeric defaults. The plugin retains descriptive catalog labels where the runtime uses shorter shader input names, such as `source` for `src`, `repeatX` for `reps`, and `amount` for `hue`. `out` defaults to `o0` in HYDRACTRL. Omitted `render` output selects all buffers, so the signature omits the catalog’s `o0` default.
- Audio setter values in the catalog describe initial settings. The setters take arguments without call-site defaults. The tooltip omits those defaults. Array `smooth` uses the runtime parameter name and `ease` displays the string default `"linear"`.
- Source methods include the runtime’s second `params` parameter for texture options. Image and video URL defaults are empty strings. Omitted camera index lets the browser select a device. Hydra accepts a screen index but its browser implementation ignores it, so the hint displays the parameter without a default.
- `initStream` appears in the catalog’s category navigation but has no signature record. Its backing stream provider is also unavailable in HYDRACTRL's Hydra initialization. Other runtime-only APIs, such as `prev`, `shift`, `sum`, and texture `.a()`, are outside catalog coverage.
- Static matching does not resolve aliases, local shadowing, computed or optional access, parenthesized receivers, custom functions, or runtime `setFunction` replacements. The hint stays hidden inside an unknown inner call or when a syntax error or spread before the cursor makes the parameter position uncertain. Extra arguments display the known signature without a highlight.

## Reproduce in Chromium

Start `bun run dev`, then run `node scripts/signature-assist-smoke.mjs` from the repository root. Set `CHROMIUM` or `HYDRACTRL_URL` to override the browser binary or app URL. Set `SIGNATURE_SCREENSHOT` and `SIGNATURE_NARROW_SCREENSHOT` to save screenshots of the default view and the light theme at the editor’s minimum panel width. The script checks auto-run and observes WebGL calls with the plugin installed and removed. It does not measure typing latency or frame timing.
