'use strict';

/**
 * Submits the built disk images to Apple for notarisation and staples the
 * resulting ticket into each one.
 *
 * Credentials are never read from this repository or from the environment.
 * They live in the macOS keychain under a notarytool profile, created once:
 *
 *   xcrun notarytool store-credentials "pulse" \
 *     --apple-id "<your-apple-id>" --team-id "<your-team-id>"
 *
 * Stapling matters: without it the Mac opening the app has to reach Apple to
 * check the ticket, so a machine that is offline or behind a strict network
 * still shows the warning. A stapled ticket travels inside the file.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROFILE = process.env.PULSE_NOTARY_PROFILE || 'pulse';
const DIST = path.join(__dirname, '..', 'dist');

function run(args, { capture = false } = {}) {
  return execFileSync('xcrun', args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8'
  });
}

function assertProfileExists() {
  try {
    run(['notarytool', 'history', '--keychain-profile', PROFILE], { capture: true });
  } catch (err) {
    console.error(
      `\nNo notarytool profile named "${PROFILE}".\n\n` +
      `Create it once with:\n\n` +
      `  xcrun notarytool store-credentials "${PROFILE}" \\\n` +
      `    --apple-id "<your-apple-id>" --team-id "<your-team-id>"\n\n` +
      `It will ask for an app-specific password, which you generate at\n` +
      `appleid.apple.com under Sign-In and Security.\n`
    );
    process.exit(1);
  }
}

function main() {
  assertProfileExists();

  const images = fs.readdirSync(DIST).filter((f) => f.endsWith('.dmg'));
  if (!images.length) {
    console.error('No .dmg files in dist/. Run `npm run dist` first.');
    process.exit(1);
  }

  for (const image of images) {
    const target = path.join(DIST, image);

    console.log(`\n── submitting ${image} ───────────────────────────────`);
    run(['notarytool', 'submit', target, '--keychain-profile', PROFILE, '--wait']);

    console.log(`── stapling ${image}`);
    run(['stapler', 'staple', target]);

    console.log(`── verifying ${image}`);
    run(['stapler', 'validate', target]);
  }

  console.log('\nAll disk images notarised and stapled.');
}

main();
