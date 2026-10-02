// In-app updates from GitHub Releases (electron-updater). Releases are built as drafts,
// so an update only reaches installed apps once its draft is published.
//
// The Windows installer, the macOS app (from the zip built next to the .dmg) and the
// Linux AppImage update themselves. The portable Windows exe can't replace itself, so
// it only points at the release page.

const { app, shell } = require("electron");
const { autoUpdater } = require("electron-updater");

const CHECK_MS = 4 * 60 * 60 * 1000;
const RELEASES_URL = "https://github.com/mfan88/htv/releases/latest";

// status: "idle" | "downloading" | "ready" (restart to install) | "available" (download it yourself)
let state = { status: "idle" };
let notify = () => {};

function set(next) {
  state = next;
  notify(state);
}

function canSelfUpdate() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return false; // electron-builder's portable exe
  if (process.platform === "linux" && !process.env.APPIMAGE) return false;
  return true;
}

function start(onChange) {
  notify = onChange;
  // Dev runs have no update feed unless HTV_UPDATE_TEST points at a dev-app-update.yml.
  if (!app.isPackaged && !process.env.HTV_UPDATE_TEST) return;
  if (process.env.HTV_UPDATE_TEST) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = process.env.HTV_UPDATE_TEST;
  }
  const self = canSelfUpdate();
  autoUpdater.autoDownload = self;
  autoUpdater.autoInstallOnAppQuit = self; // a downloaded update also installs on a normal quit
  autoUpdater.logger = null;
  autoUpdater.on("update-available", info => set({ status: self ? "downloading" : "available", version: info.version }));
  autoUpdater.on("update-downloaded", info => set({ status: "ready", version: info.version }));
  autoUpdater.on("error", err => {
    console.error("update failed:", err.message);
    if (state.status === "downloading") set({ status: "idle" }); // try again on the next check
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_MS);
}

function getState() {
  return state;
}

function install() {
  if (state.status === "ready") autoUpdater.quitAndInstall();
  else if (state.status === "available") shell.openExternal(RELEASES_URL);
}

module.exports = { start, getState, install };
