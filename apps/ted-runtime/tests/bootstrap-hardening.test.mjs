// RED: hardening do bootstrap — traversal, root, config pré-existente.
// Achado security: identity aceitava path traversal; writeTedConfig
// sobrescrevia opencode.json e seguia symlink. TDD fail-closed:
// identidades inválidas recusadas, root protegido, trabalho do usuário
// nunca sobrescrito. Sem dependências (só fs/os/path).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claimHostDir, writeTedConfig } from '../src/bootstrap.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

function tmpRoot() {
  return approvedTmpRoot('ted-harden');
}

describe('bootstrap hardening (fail-closed)', () => {
  it('recusa identidades inválidas (traversal, absoluto, vazio, separadores)', () => {
    const root = tmpRoot();
    for (const bad of ['../evil', '..', '.', '', 'a/b', 'a\\b', '/abs', 'C:\\x', 'a b', 'a:b', '.hidden']) {
      assert.throws(() => claimHostDir(root, bad), /identity/, `identity ${JSON.stringify(bad)} deve ser recusada`);
    }
    assert.doesNotThrow(() => claimHostDir(root, 'a'));
    assert.doesNotThrow(() => claimHostDir(tmpRoot(), 'host-1.Ok_2'));
  });

  it('protege root: relativo, raiz do filesystem e symlink recusados', () => {
    assert.throws(() => claimHostDir('rel/path', 'a'), /root/);
    assert.throws(() => claimHostDir(path.parse(os.tmpdir()).root, 'a'), /root/);
  });

  it('nunca assume diretório alheio: home não-vazio sem marker é recusado', () => {
    const root = tmpRoot();
    const foreign = path.join(root, '.ted-home-a');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'user-data.txt'), 'trabalho do usuário');
    assert.throws(() => claimHostDir(root, 'a'), /marker|not empty|foreign|refuse/);
    // E o arquivo do usuário segue intacto.
    assert.ok(fs.existsSync(path.join(foreign, 'user-data.txt')));
  });

  it('marker de outra identidade impede reutilização do home', () => {
    const root = tmpRoot();
    // Home de 'b' pré-ocupado com marker de outra identidade (colisão de
    // nome em FS case-insensitive, ou diretório plantado): recusar, nunca
    // reconfigurar.
    const homeB = path.join(root, '.ted-home-b');
    fs.mkdirSync(homeB, { recursive: true });
    fs.writeFileSync(path.join(homeB, '.ted-host.json'), JSON.stringify({ identity: 'a' }));
    assert.throws(() => claimHostDir(root, 'b'), /another identity/);
  });

  it('não reescreve marker existente idêntico (mtime preservado)', () => {
    const root = tmpRoot();
    const first = claimHostDir(root, 'a');
    const marker = path.join(first.home, '.ted-host.json');
    const before = fs.statSync(marker).mtimeMs;
    const second = claimHostDir(root, 'a');
    assert.equal(second.home, first.home);
    assert.equal(fs.statSync(marker).mtimeMs, before, 'marker idêntico: sem reescrita');
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(parsed.identity, 'a');
  });

  it('recusa marker que é symlink mesmo com identity válida', (t) => {
    const root = tmpRoot();
    const home = path.join(root, '.ted-home-a');
    fs.mkdirSync(home, { recursive: true });
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ identity: 'a' }));
    try {
      fs.symlinkSync(outside, path.join(home, '.ted-host.json'));
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('sem privilégio p/ symlink neste SO'); return; }
      throw e;
    }
    // Link para JSON externo com identity "válida": recusar, sem ler fora
    // do root e sem criar nada a partir dele.
    assert.throws(() => claimHostDir(root, 'a'), /symlink/);
    assert.ok(!fs.existsSync(path.join(home, 'config')), 'nada criado a partir de marker linkado');
    assert.equal(JSON.parse(fs.readFileSync(outside, 'utf8')).identity, 'a', 'arquivo externo intacto');
  });

  it('recusa symlink em componentes do home (config) antes de qualquer escrita', (t) => {
    const root = tmpRoot();
    const home = path.join(root, '.ted-home-a');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.ted-host.json'), JSON.stringify({ identity: 'a' }));
    const target = path.join(home, 'real-config');
    fs.mkdirSync(target, { recursive: true });
    try {
      fs.symlinkSync(target, path.join(home, 'config'), 'junction');
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('sem privilégio p/ symlink neste SO'); return; }
      throw e;
    }
    assert.throws(() => claimHostDir(root, 'a'), /symlink|redirected/);
    // writeTedConfig também recusa o destino linkado, sem escrever nada.
    assert.throws(() => writeTedConfig(path.join(home, 'config')), /symlink/);
    assert.ok(!fs.existsSync(path.join(target, 'opencode.json')), 'nada escrito através do link');
  });

  it('writeTedConfig é idempotente p/ conteúdo idêntico e recusa divergência', () => {
    const dir = tmpRoot();
    const first = writeTedConfig(dir);
    assert.ok(fs.existsSync(first));
    const second = writeTedConfig(dir);
    assert.equal(second, first);
    // Trabalho do usuário (config divergente) nunca é sobrescrito.
    const before = fs.readFileSync(first, 'utf8');
    fs.writeFileSync(first, before.replace('"ted"', '"user-agent"'));
    assert.throws(() => writeTedConfig(dir), /overwrite|exists|diverg|refuse/);
    assert.ok(fs.readFileSync(first, 'utf8').includes('user-agent'), 'config do usuário intacta');
  });

  it('writeTedConfig nunca segue symlink', (t) => {
    const dir = tmpRoot();
    const link = path.join(dir, 'opencode.json');
    try {
      fs.symlinkSync(path.join(dir, 'target.json'), link);
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('sem privilégio p/ symlink neste SO'); return; }
      throw e;
    }
    fs.writeFileSync(path.join(dir, 'target.json'), '{}');
    assert.throws(() => writeTedConfig(dir), /symlink/);
  });
});
