#!/usr/bin/env node
// Signs Chatward installers so the desktop app can check that an update really came from us (docs/UPDATES.md).
//
//   node scripts/update-signing.mjs keygen
//     Makes update-keys/update-private.pem. Its whole contents go into the GitHub secret UPDATE_SIGNING_KEY.
//     Keep the file somewhere safe and private, or delete it once the secret is saved.
//
//   node scripts/update-signing.mjs public-key
//     Prints the public half of UPDATE_SIGNING_KEY (an environment variable). The release build puts it in the app.
//
//   node scripts/update-signing.mjs sign <installer> <version>
//     Writes <installer>.sig, signed with UPDATE_SIGNING_KEY.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [command, file, version] = process.argv.slice(2);

function privateKey() {
  const pem = (process.env.UPDATE_SIGNING_KEY ?? '').trim();
  if (!pem) {
    console.error('UPDATE_SIGNING_KEY is not set. See docs/UPDATES.md.');
    process.exit(1);
  }
  return createPrivateKey(pem);
}

if (command === 'keygen') {
  const { privateKey: key } = generateKeyPairSync('ed25519');
  const dir = 'update-keys';
  mkdirSync(dir, { recursive: true });
  // 'wx' refuses to overwrite an existing key, so a second run can't silently replace the first.
  try {
    writeFileSync(join(dir, 'update-private.pem'), key.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    console.error(`${dir}/update-private.pem already exists. Not replacing it: move it away first if you really want a new key.`);
    process.exit(1);
  }
  console.log(`Wrote ${dir}/update-private.pem`);
  console.log('Copy its whole contents into the GitHub secret UPDATE_SIGNING_KEY. Never commit or share this file.');
} else if (command === 'public-key') {
  process.stdout.write(createPublicKey(privateKey()).export({ type: 'spki', format: 'pem' }).toString());
} else if (command === 'sign' && file && version) {
  // Must match signedUpdateBytes() in packages/client/src/main/updateSignature.ts.
  const bytes = Buffer.concat([Buffer.from(`Chatward update ${version}\n`, 'utf8'), readFileSync(file)]);
  writeFileSync(`${file}.sig`, sign(null, bytes, privateKey()));
  console.log(`Wrote ${file}.sig for version ${version}`);
} else {
  console.error('Usage: update-signing.mjs keygen | public-key | sign <installer> <version>');
  process.exit(1);
}
