import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  becameHealthy,
  CRASH_WINDOW_MS,
  crashLooping,
  emptyGuard,
  HEALTHY_AFTER_MS,
  isPrerelease,
  keepVersion,
  markClean,
  markHealthy,
  normalizeGuard,
  parsePublishRepo,
  previousVersion,
  recordBoot,
  skipVersion,
  unskipVersion,
  type GuardState,
} from '../apps/desktop/src/main/update-guard.ts';
import { LogTail } from '../apps/desktop/src/main/log-tail.ts';

/** 0.1.1 a tourné sans souci, puis la mise à jour 0.2.0 vient d'arriver. */
function afterUpdate(): GuardState {
  let s = markHealthy(recordBoot(emptyGuard(), '0.1.0', 0), '0.1.0');
  s = markHealthy(recordBoot(s, '0.1.1', 1), '0.1.1');
  return recordBoot(s, '0.2.0', 2);
}

describe('garde-fou des mises à jour', () => {
  test('la version précédente est la dernière version saine lancée avant', () => {
    const s = afterUpdate();
    assert.equal(previousVersion(s, '0.2.0'), '0.1.1');
    assert.equal(previousVersion(s, '0.1.1'), '0.1.0');
    assert.deepEqual(s.versions, ['0.1.0', '0.1.1', '0.2.0']);
  });

  test('sans version saine avant, rien à proposer', () => {
    const s = recordBoot(emptyGuard(), '0.2.0', 0);
    assert.equal(previousVersion(s, '0.2.0'), null);
    assert.equal(crashLooping(s, '0.2.0', [1, 2, 3], 4), false);
  });

  test('3 plantages en 10 minutes : on propose de revenir', () => {
    const s = afterUpdate();
    const t = 10_000;
    assert.equal(crashLooping(s, '0.2.0', [t, t + 1], t + 2), false);
    assert.equal(crashLooping(s, '0.2.0', [t, t + 1, t + 2], t + 3), true);
    assert.equal(crashLooping(s, '0.2.0', [t, t + 1, t + 2], t + CRASH_WINDOW_MS + 10), false, 'trop anciens');
    assert.equal(crashLooping(keepVersion(s, '0.2.0'), '0.2.0', [t, t + 1, t + 2], t + 3), false, 'choisi de rester');
    assert.equal(crashLooping(markHealthy(s, '0.2.0'), '0.2.0', [t, t + 1, t + 2], t + 3), false, 'déjà saine');
  });

  test('deux lancements interrompus avant d’être sains : on propose de revenir', () => {
    let s = afterUpdate(); // premier lancement de 0.2.0, planté
    s = recordBoot(s, '0.2.0', 3); // planté
    s = recordBoot(s, '0.2.0', 4); // en cours
    assert.equal(crashLooping(s, '0.2.0', [], 5), true);
  });

  test('des fermetures normales ne comptent pas comme des plantages', () => {
    let s = markClean(afterUpdate(), '0.2.0');
    s = markClean(recordBoot(s, '0.2.0', 3), '0.2.0');
    s = recordBoot(s, '0.2.0', 4);
    assert.equal(crashLooping(s, '0.2.0', [], 5), false);
  });

  test('saine après 5 minutes sans boucle de plantages', () => {
    assert.equal(becameHealthy(0, [], HEALTHY_AFTER_MS - 1), false);
    assert.equal(becameHealthy(0, [], HEALTHY_AFTER_MS), true);
    assert.equal(becameHealthy(0, [1, 2, 3], HEALTHY_AFTER_MS), false);
    assert.equal(becameHealthy(0, [1, 2], HEALTHY_AFTER_MS), true);
  });

  test('versions mises de côté après un retour en arrière', () => {
    let s = skipVersion(afterUpdate(), '0.2.0');
    s = skipVersion(s, '0.2.0');
    assert.deepEqual(s.skip, ['0.2.0']);
    assert.deepEqual(unskipVersion(s, '0.2.0').skip, []);
  });

  test('un état abîmé ne fait pas planter le garde-fou', () => {
    assert.deepEqual(normalizeGuard(null), emptyGuard());
    assert.deepEqual(normalizeGuard('n’importe quoi'), emptyGuard());
    const s = normalizeGuard({
      channel: 'beta',
      versions: ['0.1.0', 'pas une version', 3, '0.2.0-beta.1'],
      boots: [{ version: '0.1.0', at: 1, healthy: true }, 'x', { at: 2 }],
      skip: 'tout',
    });
    assert.equal(s.channel, 'beta');
    assert.deepEqual(s.versions, ['0.1.0', '0.2.0-beta.1']);
    assert.deepEqual(s.boots, [{ version: '0.1.0', at: 1, healthy: true, clean: false }]);
    assert.deepEqual(s.skip, []);
    assert.equal(normalizeGuard({ channel: 'nightly' }).channel, 'stable');
  });

  test('dépôt de publication et versions bêta', () => {
    const yml = 'owner: KobeStars\nrepo: binome\nprovider: github\nupdaterCacheDirName: binome-desktop-updater\n';
    assert.deepEqual(parsePublishRepo(yml), { owner: 'KobeStars', repo: 'binome' });
    assert.equal(parsePublishRepo('provider: generic\nurl: http://127.0.0.1:8899/\n'), null);
    assert.equal(parsePublishRepo('owner: a/../b\nrepo: x\nprovider: github\n'), null);
    assert.equal(isPrerelease('0.2.0-beta.1'), true);
    assert.equal(isPrerelease('0.2.0'), false);
  });
});

describe('fin de journal', () => {
  test('garde la fin, sans dépasser la taille prévue', () => {
    const t = new LogTail(100);
    for (let i = 0; i < 50; i++) t.push(`ligne ${i}\n`);
    assert.ok(t.value.length <= 100);
    assert.ok(t.value.endsWith('ligne 49\n'));
  });

  test('résumé : la dernière ligne d’erreur', () => {
    const t = new LogTail();
    t.push('démarrage\nTypeError: x is undefined\n    at foo (a.js:1)\nfin\n');
    assert.equal(t.lastError(), 'TypeError: x is undefined');
    t.clear();
    t.push('tout va bien\n');
    assert.equal(t.lastError(), null);
  });
});
