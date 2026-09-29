/**
 * The AppUserModelID Windows uses to identify this app.
 *
 * Windows draws a toast's header from the process AppUserModelID. When none is
 * set, Electron builds one out of the executable's file name and the app name,
 * so a development run announces itself as
 * "electron.app.Radio Record Windows App" - the user reads the build tooling
 * instead of the product. Setting the id explicitly replaces that derived
 * string.
 *
 * It has to equal `build.appId` in package.json: that is the id the installer
 * writes into the Start Menu shortcut, so this is the key Windows looks up to
 * find the name to print. A value that drifts from it would resolve to nothing
 * and the toast would lose its header. `tools/check-app-identity.mjs` fails the
 * build if the two ever disagree.
 */
export const APP_ID = "ru.radiorecord.mini";
