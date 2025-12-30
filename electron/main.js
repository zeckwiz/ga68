
// electron/main.js
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.removeMenu(); // optional
  mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function wireAutoUpdater() {
  // Recommended: log autoUpdater events for troubleshooting
  autoUpdater.logger = require('electron-log');
  autoUpdater.logger.transports.file.level = 'info';

  // Optional: allow prerelease updates if you tag releases as prerelease
  // autoUpdater.allowPrerelease = false;

  // Check on startup; downloads + notifies when ready
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater] error:', err);
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[autoUpdater] update available:', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[autoUpdater] up to date');
  });

  autoUpdater.on('download-progress', (progress) => {
    const { percent } = progress;
    console.log(`[autoUpdater] download progress: ${percent?.toFixed?.(1) ?? percent}%`);
  });

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: 'A new version has been downloaded. Restart to apply now?',
      buttons: ['Restart', 'Later']
    }).then(result => {
      if (result.response === 0) {
        // Quit and install
        autoUpdater.quitAndInstall();
      }
    });
  });
}

app.whenReady().then(() => {
  createWindow();
  wireAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Quit on Windows & Linux
  if (process.platform !== 'darwin') app.quit();
});
