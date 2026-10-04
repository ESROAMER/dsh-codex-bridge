#!/usr/bin/env node
// Portable user-level setup. No account credentials, network downloads or shell execution.
import { readFile, writeFile, mkdir, cp, rename, lstat, symlink, rm, readdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function values(key) { return args.flatMap((x, i) => x === key ? [args[i + 1]] : []); }
function option(key, fallback) { return values(key).at(-1) ?? fallback; }
const has = key => args.includes(key);
function validateUrl(base) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw Error('Bridge URL must be loopback HTTP without credentials/query/fragment.');
}
const dsh = resolve(option('--dsh-home', join(homedir(), '.dsh')));
const codex = resolve(option('--codex-home', join(homedir(), '.codex')));
const stateDir = join(dsh, 'codex-bridge');
const installDir = join(dsh, 'codex-bridge-install');
const pluginDir = join(installDir, 'plugin');
const skillDir = join(codex, 'skills', 'deepseek-harness');
const profileFile = join(dsh, 'profiles', 'desktop', 'package.json');
const linkPath = join(dirname(profileFile), 'node_modules', 'dsh-codex-bridge');
const manifestFile = join(installDir, 'installation.json');
const pluginBundleNames = new Set(['dsh-codex-bridge', '@esroamer/dsh-codex-bridge']);
const hash = text => createHash('sha256').update(text).digest('hex');
const json = async (path, fallback) => {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
};
const atomic = async (path, data) => {
  await mkdir(dirname(path), {recursive: true});
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
  await rename(temp, path);
};
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function workspaces() {
  const doc = await json(join(dsh, 'storages', 'workspace.json'));
  if (doc.unit?.name !== 'workspace' || !doc.tables?.workspaces) throw Error('Unsupported workspace storage. Supply a compatible DSH Desktop; no storage will be changed.');
  return Object.entries(doc.tables.workspaces).map(([id, w]) => ({id, title: w.title, path: w.path}));
}
async function check() {
  const settings = await json(join(skillDir, 'references', 'local-settings.json'));
  validateUrl(settings.base_url);
  const token = (await readFile(settings.token_file, 'utf8')).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(settings.base_url + '/health', {headers: {authorization: 'Bearer ' + token}, redirect: 'error', signal: controller.signal});
    const body = await response.json();
    if (!response.ok || body.value?.bridge !== 'ready') throw Error(`Health check failed (HTTP ${response.status}). Open/restart DSH and check plugin settings.`);
    console.log('Bridge ready. Protocol:', body.protocolVersion, 'PID:', body.value.pid);
    console.log('This only checks connectivity; test desktop grouping, model selection and live messages separately.');
  } finally { clearTimeout(timer); }
}
async function uninstall() {
  const manifest = await json(manifestFile);
  if (manifest.dshHome !== dsh || manifest.codexHome !== codex || manifest.pluginDir !== pluginDir || manifest.skillDir !== skillDir) throw Error('Installation manifest path mismatch. Refusing removal.');
  if (!/^codex-installer-[a-f0-9-]+$/.test(manifest.tokenAlias) || manifest.tokenFile !== join(stateDir, manifest.tokenAlias + '.token')) throw Error('Installation credential path mismatch. Refusing removal.');
  const profile = await json(profileFile);
  if (manifest.installedPlugin) {
    const spec = profile.dependencies?.['dsh-codex-bridge'];
    if (spec !== manifest.linkSpec) throw Error('Plugin configuration changed since install. Remove the plugin with the official plugin manager instead.');
    delete profile.dependencies['dsh-codex-bridge'];
    profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter(x => x !== 'dsh-codex-bridge');
    await atomic(profileFile, profile);
    if (await exists(linkPath)) {
      if (!(await lstat(linkPath)).isSymbolicLink()) throw Error('Plugin node_modules entry is no longer an installer junction; left untouched.');
      await rm(linkPath); // junction only, never its target
    }
  }
  const tokensFile = join(stateDir, 'tokens.json');
  const tokens = await json(tokensFile, {version: 1, tokens: {}});
  delete tokens.tokens[manifest.tokenAlias];
  await atomic(tokensFile, tokens);
  const current = await json(join(skillDir, 'references', 'local-settings.json'), {});
  if (current.installation_id === manifest.installationId) {
    // Move rather than recursively delete: preserve any user additions.
    await rename(skillDir, join(installDir, 'removed-skill-' + Date.now()));
    if (manifest.previousSkill && await exists(manifest.previousSkill)) await rename(manifest.previousSkill, skillDir);
  }
  if (await exists(manifest.tokenFile)) await rm(manifest.tokenFile);
  await rename(manifestFile, manifestFile + '.uninstalled-' + Date.now());
  console.log('Uninstalled owned configuration and revoked token. Restart DSH. Desktop conversations and bridge task state are preserved.');
  if (!manifest.installedPlugin) console.log('Plugin was installed by the official manager: remove it there separately.');
}
async function install() {
  const base = option('--url', 'http://127.0.0.1:19387/codex-bridge').replace(/\/$/, '');
  validateUrl(base);
  const selected = [...new Set(values('--workspace'))];
  const known = await workspaces();
  if (!selected.length || selected.some(id => !known.some(w => w.id === id))) throw Error('Select at least one existing registered workspace ID.');
  const profile = await json(profileFile);
  if (!Array.isArray(profile.dsh?.profile?.bundles)) throw Error('Desktop profile not initialized. Start DSH once first.');
  if (process.env.DSH_CODEX_BRIDGE_STATE || process.env.DSH_CODEX_BRIDGE_TOKEN_FILE) throw Error('Custom bridge state/token environment detected. Configure manually to avoid a conflicting deployment.');
  const previous = await json(manifestFile, null);
  if (previous && (previous.dshHome !== dsh || previous.codexHome !== codex)) throw Error('Existing installation belongs to different homes. Use its original parameters.');
  const alreadyInstalled = profile.dsh.profile.bundles.some(name => pluginBundleNames.has(name));
  if (has('--configure-only') && !alreadyInstalled) throw Error('ConfigureOnly requires a plugin installed via the official manager or this script.');
  const managed = previous?.installedPlugin === true;
  if (alreadyInstalled && !managed && !has('--configure-only')) throw Error('Plugin already installed externally. Use -ConfigureOnly to preserve it.');
  const stamp = Date.now().toString();
  const backupDir = join(installDir, 'backups', stamp);
  await mkdir(backupDir, {recursive: true});
  await cp(profileFile, join(backupDir, 'package.json'));
  const patchFile = join(dirname(profileFile), 'cordis.patch.yml');
  if (await exists(patchFile)) await cp(patchFile, join(backupDir, 'cordis.patch.yml'));
  const tokensFile = join(stateDir, 'tokens.json');
  const originalTokens = await json(tokensFile, {version: 1, tokens: {}});
  const tokens = structuredClone(originalTokens);
  const alias = previous?.tokenAlias ?? 'codex-installer-' + randomUUID();
  const token = 'dshb_' + randomBytes(32).toString('base64url');
  tokens.tokens ??= {};
  tokens.tokens[alias] = {alias, hash: hash(token), workspaceIds: selected, createdAt: new Date().toISOString(), source: 'installer'};
  const tokenFile = join(stateDir, alias + '.token');
  const installationId = previous?.installationId ?? randomUUID();
  const linkSpec = 'link:' + pluginDir.replaceAll('\\', '/');
  let skillBackup, pluginBackup, createdLink = false, skillWritten = false;
  const oldToken = await exists(tokenFile) ? await readFile(tokenFile) : null;
  try {
    if (!has('--configure-only')) {
      if (await exists(pluginDir)) { pluginBackup = join(backupDir, 'plugin'); await rename(pluginDir, pluginBackup); }
      await mkdir(pluginDir, {recursive: true});
      for (const file of ['index.js', 'admin.mjs', 'package.json', 'cordis.patch.yml', 'PROTOCOL.md', 'README.md', 'README.zh-CN.md', 'LICENSE']) await cp(join(repo, file), join(pluginDir, file));
      // Explicit state path allows custom DSH homes without changing process-wide environment.
      let patch = await readFile(join(pluginDir, 'cordis.patch.yml'), 'utf8');
      patch = patch.replace('stateDir: !!js process.env.DSH_CODEX_BRIDGE_STATE ?? undefined', 'stateDir: ' + JSON.stringify(stateDir));
      patch = patch.replace("name: '@esroamer/dsh-codex-bridge'", "name: 'dsh-codex-bridge'");
      await writeFile(join(pluginDir, 'cordis.patch.yml'), patch);
      await mkdir(dirname(linkPath), {recursive: true});
      if (await exists(linkPath)) {
        if (!(await lstat(linkPath)).isSymbolicLink() || !managed) throw Error('Existing module entry is not owned by this installer. Use the official manager.');
      } else { await symlink(pluginDir, linkPath, 'junction'); createdLink = true; }
      profile.dependencies ??= {};
      profile.dependencies['dsh-codex-bridge'] = linkSpec;
      if (!alreadyInstalled) profile.dsh.profile.bundles.push('dsh-codex-bridge');
      await atomic(profileFile, profile);
    }
    if (await exists(skillDir)) { skillBackup = join(backupDir, 'skill'); await rename(skillDir, skillBackup); }
    await cp(join(repo, 'skills', 'deepseek-harness'), skillDir, {recursive: true});
    skillWritten = true;
    await mkdir(stateDir, {recursive: true});
    await writeFile(tokenFile, token + '\n', {mode: 0o600});
    await atomic(tokensFile, tokens);
    await atomic(join(skillDir, 'references', 'local-settings.json'), {base_url: base, token_file: tokenFile, python_executable: option('--python', null), installation_id: installationId});
    await atomic(manifestFile, {version: 1, installationId, dshHome: dsh, codexHome: codex, pluginDir, skillDir, installedPlugin: managed || !has('--configure-only'), linkSpec, tokenAlias: alias, tokenFile, previousSkill: previous ? (previous.previousSkill ?? null) : (skillBackup ?? null), backupDir});
  } catch (e) {
    await cp(join(backupDir, 'package.json'), profileFile);
    await atomic(tokensFile, originalTokens);
    if (oldToken) await writeFile(tokenFile, oldToken); else if (await exists(tokenFile)) await rm(tokenFile);
    if (skillWritten && await exists(skillDir)) await rename(skillDir, join(backupDir, 'failed-skill'));
    if (skillBackup && await exists(skillBackup)) await rename(skillBackup, skillDir);
    if (createdLink && await exists(linkPath)) await rm(linkPath);
    if (pluginBackup) { if (await exists(pluginDir)) await rename(pluginDir, join(backupDir, 'failed-plugin')); await rename(pluginBackup, pluginDir); }
    throw e;
  }
  console.log('Installed/configured. Credential saved locally; its value is not printed.');
  console.log('Authorized workspaces:', selected.join(', '));
  console.log('Codex skill:', skillDir);
  console.log('Backups:', backupDir);
  console.log('Open/restart DSH, start a new Codex chat, then run install.ps1 -Check.');
  if (!option('--python', null)) console.log('Python not detected. Install Python 3.10+ or rerun with -PythonPath.');
}
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node.js 22+ required.');
  if (has('--list')) for (const w of await workspaces()) console.log(`${w.id}\t${w.title}\t${w.path}`);
  else if (has('--check')) await check();
  else if (has('--uninstall')) await uninstall();
  else await install();
} catch (e) { console.error('setup:', e.message); process.exitCode = 1; }
