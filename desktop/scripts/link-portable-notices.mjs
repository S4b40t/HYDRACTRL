import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LINK_TEST_SCENE } from "../../src/client/plugins/linkTestScene.js";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(desktop);
const output = resolve(process.argv[2]);
const licenses = join(output, "Licenses");
const packages = new Map();

function packagePath(name, directory) {
  for (let current = directory; current !== dirname(current); current = dirname(current)) {
    const candidate = join(current, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function collect(name, from, optional = false) {
  const path = packagePath(name, from);
  if (!path) {
    if (optional) return;
    throw new Error(`Missing package ${name} when collecting notices`);
  }
  const meta = JSON.parse(readFileSync(path, "utf8"));
  const key = `${meta.name}@${meta.version}`;
  if (packages.has(key)) return;
  const pkg = dirname(path);
  const dest = join(licenses, "npm", key.replaceAll("/", "_"));
  const files = readdirSync(pkg, { withFileTypes: true }).filter(
    (entry) =>
      entry.isFile() && /^(licen[cs]e|copying|notice|third.party.notices)\b/i.test(entry.name),
  );
  mkdirSync(dest, { recursive: true });
  for (const { name: file } of files) copyFileSync(join(pkg, file), join(dest, file));
  packages.set(key, {
    license: meta.license ?? null,
    repository: meta.repository?.url ?? meta.repository ?? meta.homepage ?? null,
    notices: files.map((file) => file.name),
  });
  for (const dep of Object.keys(meta.dependencies ?? {})) collect(dep, pkg);
  for (const dep of Object.keys(meta.optionalDependencies ?? {})) collect(dep, pkg, true);
}

for (const directory of [repo, desktop]) {
  const meta = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  for (const name of Object.keys(meta.dependencies)) collect(name, directory);
}
collect("p5", repo);
copyFileSync(join(repo, "public/assets/fonts/LICENSE.txt"), join(licenses, "App-fonts.txt"));
writeFileSync(
  join(licenses, "npm-manifest.json"),
  `${JSON.stringify(Object.fromEntries(packages), null, 2)}\n`,
);
writeFileSync(join(output, "Link Test Scene.js"), `${LINK_TEST_SCENE}\n`);
