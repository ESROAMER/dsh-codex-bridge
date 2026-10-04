// One isolated packaging check: install, configure/update and uninstall without touching a real desktop.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const setup = join(dirname(fileURLToPath(import.meta.url)), 'setup.mjs');
const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-setup-'));
const dsh = join(dir, 'dsh'), codex = join(dir, 'codex');
const profile = join(dsh, 'profiles', 'desktop', 'package.json');
const run = (...flags) => {
  const env = {...process.env};
  delete env.DSH_CODEX_BRIDGE_STATE; delete env.DSH_CODEX_BRIDGE_TOKEN_FILE;
  const result = spawnSync(process.execPath, [setup, '--dsh-home', dsh, '--codex-home', codex, ...flags], {encoding:'utf8', env});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
};
try {
  await mkdir(dirname(profile), {recursive:true});
  await writeFile(profile, JSON.stringify({dependencies:{other:'1.0.0'}, dsh:{profile:{bundles:['other']}}}));
  await mkdir(join(dsh, 'storages'), {recursive:true});
  await writeFile(join(dsh, 'storages', 'workspace.json'), JSON.stringify({unit:{name:'workspace',version:2},tables:{workspaces:{one:{title:'one',path:dir},two:{title:'two',path:dir}}}}));
  run('--workspace','one','--workspace','two');
  const installed = JSON.parse(await readFile(profile));
  assert.equal(installed.dependencies.other, '1.0.0');
  assert(installed.dsh.profile.bundles.includes('dsh-codex-bridge'));
  assert((await lstat(join(dirname(profile),'node_modules','dsh-codex-bridge'))).isSymbolicLink());
  const installedPatch = await readFile(join(dsh,'codex-bridge-install','plugin','cordis.patch.yml'),'utf8');
  assert.match(installedPatch, /name: 'dsh-codex-bridge'/);
  assert.doesNotMatch(installedPatch, /name: '@esroamer\/dsh-codex-bridge'/);
  const tokens = JSON.parse(await readFile(join(dsh,'codex-bridge','tokens.json')));
  assert.deepEqual(Object.values(tokens.tokens)[0].workspaceIds, ['one','two']);
  const settings = JSON.parse(await readFile(join(codex,'skills','deepseek-harness','references','local-settings.json')));
  assert((await readFile(settings.token_file,'utf8')).startsWith('dshb_'));
  run('--configure-only','--workspace','two');
  run('--workspace','two');
  run('--uninstall');
  const removed = JSON.parse(await readFile(profile));
  assert.deepEqual(removed.dsh.profile.bundles, ['other']);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dsh,'codex-bridge','tokens.json'))).tokens), []);
  console.log('PASS: isolated install/configure/update/uninstall, scope and unrelated configuration preservation');
} finally { await rm(dir, {recursive:true,force:true}); }
