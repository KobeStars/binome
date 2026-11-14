import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';

async function save(path: string, value: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, await safeStorage.encryptStringAsync(value));
  await rename(tmp, path);
}

/**
 * Clé privée Ed25519 de l'appareil, chiffrée par Windows (DPAPI) via safeStorage.
 * Seul le compte Windows qui l'a créée peut la relire.
 * Renvoie la clé en PKCS#8, à transmettre au moteur.
 */
export async function loadOrCreateIdentity(userData: string): Promise<Uint8Array> {
  const path = join(userData, 'identity.bin');
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('Chiffrement du système indisponible : impossible de protéger la clé');
  }

  if (existsSync(path)) {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(await readFile(path));
    if (shouldReEncrypt) await save(path, result);
    return new Uint8Array(Buffer.from(result, 'base64'));
  }

  const pkcs8 = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' });
  await save(path, pkcs8.toString('base64'));
  return new Uint8Array(pkcs8);
}
