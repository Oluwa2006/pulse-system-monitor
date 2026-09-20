'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { MetricsCollector } = require('./metrics');
const { analyze } = require('../diagnostics/diagnostics');

const REFRESH_INTERVAL_MS = 2000;

const collector = new MetricsCollector();
let mainWindow = null;
let pollTimer = null;
let sampling = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 940,
    minWidth: 720,
    minHeight: 600,
    title: 'Pulse',
    backgroundColor: '#0b0e14',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Keep stray link clicks out of the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Takes one reading, runs diagnostics on it, and pushes the result to the UI.
 * Guarded so a slow sample can never overlap with the next tick.
 */
async function tick() {
  if (sampling || !mainWindow) return;
  sampling = true;

  try {
    const snapshot = await collector.sample();
    const diagnostics = analyze(snapshot);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pulse:update', { ...snapshot, diagnostics });
    }
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pulse:error', { message: err.message });
    }
  } finally {
    sampling = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  tick();
  pollTimer = setInterval(tick, REFRESH_INTERVAL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// The renderer asks for data once it has mounted, so the first paint is never empty.
ipcMain.handle('pulse:ready', async () => {
  startPolling();
  return { refreshIntervalMs: REFRESH_INTERVAL_MS };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopPolling();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopPolling);
