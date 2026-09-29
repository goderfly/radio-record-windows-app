/**
 * Guards the Windows app identity against drift.
 *
 * The toast header Windows draws comes from the process AppUserModelID, and the
 * name it resolves that id to comes from the Start Menu shortcut the installer
 * creates. Three places have to agree for that chain to work: `build.appId`
 * (which becomes the shortcut's AUMID), `APP_ID` (which the process sets), and
 * `build.nsis.shortcutName` (the text Windows ends up printing). Change one and
 * the notification header silently degrades to a raw id - or to the executable's
 * name, which is how "electron.app.Radio Record Windows App" got on screen.
 *
 *   node tools/check-app-identity.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const pkg = JSON.parse(read("package.json"));
const identity = read("src/main/app-identity.ts");
const main = read("src/main/index.ts");

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(44)} ${detail}`);
};

/** Pulls `export const NAME = "value"` out of a TS source. */
const constValue = (src, name) => {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`));
  return m ? m[1] : null;
};

const appId = pkg.build?.appId ?? null;
const shortcut = pkg.build?.nsis?.shortcutName ?? null;
const exported = constValue(identity, "APP_ID");

check(exported !== null, "app-identity.ts exports APP_ID", exported ?? "not found");
check(appId !== null, "package.json sets build.appId", appId ?? "not set");
check(
  exported !== null && appId !== null && exported === appId,
  "APP_ID equals build.appId",
  exported && appId ? `${exported} vs ${appId}` : "cannot compare",
);

// The id is what Windows looks up, so a value it cannot resolve is worse than
// no check at all: it would silently fall back to the executable's name.
check(
  shortcut !== null && shortcut.trim() !== "",
  "installer registers a shortcut name",
  shortcut ?? "build.nsis.shortcutName not set",
);

// Guards against the constant being left unused, which would revert the fix
// without changing anything a type checker would notice.
check(
  /app\.setAppUserModelId\(\s*APP_ID\s*\)/.test(main),
  "main sets the id before the app is ready",
  /app\.setAppUserModelId/.test(main) ? "setAppUserModelId call found" : "no setAppUserModelId call",
);

console.log(failures ? `\n${failures} failed` : "\napp identity is consistent");
process.exit(failures ? 1 : 0);
