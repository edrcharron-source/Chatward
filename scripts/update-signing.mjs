#!/usr/bin/env node
// Signs Chatward installers so the desktop app can check that an update really came from us.
//
//   node scripts/update-signing.mjs keygen
//     Creates update-keys/update-private.pem (secret) and update-keys/update-public.pem (safe to share).
//
//   node scripts/update-signing.mjs sign <installer>
//     Writes <installer>.sig. Reads the private key from the UPDATE_SIGNING_KEY environment variable.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [command, file] = process.argv.slice(2);

if (command === 'keygen') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const dir = 'update-keys';
  mkdirSync(dir, { recursive: true });
  // 'wx' refuses to overwrite an existing key, so a second run can't silently replace the first.
  writeFileSync(join(dir, 'update-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx' });
  writeFileSync(join(dir, 'update-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Wrote ${dir}/update-private.pem and ${dir}/update-public.pem`);
  console.log('Put the private key in the GitHub secret UPDATE_SIGNING_KEY. Give the public key to the app (packages/client/src/main/updateKey.ts).');
} else if (command === 'sign' && file) {
  const pem = process.env.UPDATE_SIGNING_KEY;
  if (!pem) {
    console.error('UPDATE_SIGNING_KEY is not set. Refusing to sign.');
    process.exit(1);
  }
  const signature = sign(null, readFileSync(file), createPrivateKey(pem));
  writeFileSync(`${file}.sig`, signature);
  console.log(`Wrote ${file}.sig`);
} else {
  console.error('Usage: update-signing.mjs keygen | sign <installer>');
  process.exit(1);
}
