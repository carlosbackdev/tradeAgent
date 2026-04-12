/**
 * scripts/generate-keys.js
 * Generates an Ed25519 key pair for Revolut X API authentication.
 *
 * Usage: node scripts/generate-keys.js
 *
 * Output:
 *   keys/private.pem  — keep this SECRET, never commit it
 *   keys/public.pem   — paste this into Revolut X when creating API key
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const keysDir = path.resolve('./keys');
if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
});

const privatePath = path.join(keysDir, 'private.pem');
const publicPath  = path.join(keysDir, 'public.pem');

fs.writeFileSync(privatePath, privateKey, { mode: 0o600 }); // chmod 600
fs.writeFileSync(publicPath,  publicKey);

console.log('✅ Key pair generated:');
console.log(`   Private: ${privatePath}  (chmod 600 — DO NOT COMMIT)`);
console.log(`   Public:  ${publicPath}`);
console.log('\n📋 Paste the contents of public.pem into Revolut X when creating your API key:');
console.log('─'.repeat(60));
console.log(publicKey);
