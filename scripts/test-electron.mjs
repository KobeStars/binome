// Lance les tests avec le Node embarqué dans Electron (BoringSSL, module natif de node-datachannel).
// Des primitives qui marchent sous Node peuvent manquer ici : ChaCha20-Poly1305 par exemple.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
const tests = readdirSync('tests').filter((f) => f.endsWith('.test.ts')).map((f) => `tests/${f}`);
const r = spawnSync(electron, ['--import', 'tsx', '--test', ...tests], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(r.status ?? 1);
