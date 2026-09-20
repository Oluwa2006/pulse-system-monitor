'use strict';

/**
 * Renders build/icon.html to build/icon.png at 1024x1024.
 *
 * Run with: npm run icon
 * electron-builder converts the PNG to .icns at package time, so this is the
 * only icon source that needs to exist.
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const OUTPUT = path.join(__dirname, '..', 'build', 'icon.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: false }
  });

  await win.loadFile(path.join(__dirname, '..', 'build', 'icon.html'));
  // One frame of settling, otherwise the capture can come back blank.
  await new Promise((resolve) => setTimeout(resolve, 600));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUTPUT, image.toPNG());

  const { width, height } = image.getSize();
  console.log(`wrote ${OUTPUT} at ${width}x${height}`);
  app.quit();
});
