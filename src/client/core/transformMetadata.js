const supportedTypes = new Set(["src", "coord", "color", "combine", "combineCoord"]);
const identifier = /^[A-Za-z_$][\w$]{0,79}$/;

/** Copy only the display metadata needed by the editor from the running Hydra instance. */
export function copyTransformMetadata(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return undefined;
  return Object.fromEntries(
    Object.entries(registry)
      .slice(0, 256)
      .flatMap(([name, transform]) => {
        if (
          !identifier.test(name) ||
          !supportedTypes.has(transform?.type) ||
          !Array.isArray(transform.inputs) ||
          transform.inputs.length > 32
        ) {
          return [];
        }
        const inputs = [];
        for (const input of transform.inputs) {
          if (typeof input?.name !== "string" || !identifier.test(input.name)) return [];
          const entry = { name: input.name };
          const value = input.default;
          if (Number.isFinite(value) || (typeof value === "string" && value.length <= 80)) {
            entry.default = value;
          }
          inputs.push(entry);
        }
        return [[name, { type: transform.type, inputs }]];
      }),
  );
}
