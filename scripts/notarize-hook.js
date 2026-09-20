'use strict';

/**
 * electron-builder afterSign hook: notarises and staples the .app itself,
 * before it is packaged into a disk image.
 *
 * Stapling the disk image alone is not enough. Once someone drags the app
 * out, the copy has no ticket of its own, so a Mac that is offline at first
 * launch has no way to confirm the app was notarised and shows the warning
 * anyway. Stapling here puts the proof inside the bundle, and the image
 * built from it inherits a stapled app.
 *
 * notarytool cannot accept a bare .app, so it is zipped for submission only.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROFILE = process.env.PULSE_NOTARY_PROFILE || 'pulse';

module.exports = async function notarizeApp(context) {
  if (context.electronPlatformName !== 'darwin') return;

  if (process.env.PULSE_SKIP_NOTARIZE === '1') {
    console.log('  • notarisation skipped  reason=PULSE_SKIP_NOTARIZE');
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // A contributor without the keychain profile gets an ad-hoc build rather
  // than a failed one.
  try {
    execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE], { stdio: 'ignore' });
  } catch {
    console.log(`  • notarisation skipped  reason=no keychain profile "${PROFILE}"`);
    return;
  }

  const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-notarize-')), 'app.zip');

  console.log(`  • notarising app  path=${appPath}`);
  execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
  execFileSync('xcrun',
    ['notarytool', 'submit', zipPath, '--keychain-profile', PROFILE, '--wait'],
    { stdio: 'inherit' });

  console.log('  • stapling app');
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });

  fs.rmSync(path.dirname(zipPath), { recursive: true, force: true });
};
