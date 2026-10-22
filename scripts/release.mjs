import { readFileSync, readdirSync, appendFileSync, writeFileSync, lstatSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateReleaseTag(tag, versions) {
  if (typeof tag !== 'string' || tag !== tag.trim() || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(tag)) {
    throw new Error('Release tag must be vX.Y.Z or vX.Y.Z-prerelease.');
  }
  const version = tag.slice(1);
  const prerelease = version.includes('-');
  if (prerelease && version.slice(version.indexOf('-') + 1).split('.').some(part => /^0\d+$/.test(part))) {
    throw new Error('Numeric prerelease identifiers cannot have leading zeros.');
  }
  for (const key of ['package', 'lock', 'cargo', 'tauri']) {
    if (versions[key] !== version) throw new Error('Release version does not match ' + key + ' metadata.');
  }
  return { version, prerelease };
}

export function readVersions(root = new URL('../', import.meta.url)) {
  const json = file => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
  const cargo = readFileSync(new URL('src-tauri/Cargo.toml', root), 'utf8');
  const section = cargo.match(/^\[package\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  const cargoVersion = section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  return { package: json('package.json').version, lock: json('package-lock.json').packages[''].version,
    cargo: cargoVersion, tauri: json('src-tauri/tauri.conf.json').version };
}

const REPOSITORY = 'elves-ai/dsh-wsl-desktop';
const CHECKSUMS = 'SHA256SUMS.txt';
const APP = 'dsh-wsl-desktop.exe';

function assertVersion(version) {
  validateReleaseTag('v' + version, Object.fromEntries(['package', 'lock', 'cargo', 'tauri'].map(key => [key, version])));
}

export function readUpdaterPublicKey() {
  return JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).plugins?.updater?.pubkey;
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || !value) {
    throw new Error('Invalid base64 ' + label + '.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Noncanonical base64 ' + label + '.');
  return bytes;
}

// Tauri wraps the complete minisign text in base64. Verify both the artifact
// signature and the global signature binding its trusted comment. Format:
// https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/helpers/updater_signature.rs
// https://github.com/jedisct1/rust-minisign-verify/blob/master/src/lib.rs
export function verifyUpdaterSignature(content, signature, publicKey, version) {
  const keyLines = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(publicKey, 'public key')).trimEnd().split(/\r?\n/);
  const sigLines = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(signature, 'signature')).trimEnd().split(/\r?\n/);
  if (keyLines.length !== 2 || !keyLines[0].startsWith('untrusted comment: ')
      || sigLines.length !== 4 || !sigLines[0].startsWith('untrusted comment: ')
      || !sigLines[2].startsWith('trusted comment: ')) throw new Error('Invalid minisign text.');
  const key = decodeBase64(keyLines[1], 'public key packet');
  const packet = decodeBase64(sigLines[1], 'signature packet');
  const global = decodeBase64(sigLines[3], 'global signature');
  if (key.length !== 42 || packet.length !== 74 || global.length !== 64
      || key.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('Invalid minisign packet.');
  const algorithm = packet.subarray(0, 2).toString('latin1');
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw new Error('Unsupported minisign algorithm.');
  if (!key.subarray(2, 10).equals(packet.subarray(2, 10))) throw new Error('Updater signature key ID mismatch.');
  const ed25519 = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der', type: 'spki',
  });
  const message = algorithm === 'ED' ? createHash('blake2b512').update(content).digest() : content;
  const artifactSignature = packet.subarray(10);
  const trusted = Buffer.from(sigLines[2].slice('trusted comment: '.length), 'utf8');
  if (!verify(null, message, ed25519, artifactSignature)
      || !verify(null, Buffer.concat([artifactSignature, trusted]), ed25519, global)) {
    throw new Error('Updater signature cryptographic verification failed.');
  }
  const signedVersions = trusted.toString('utf8').split('\t').filter(field => field.startsWith('version:'));
  if (signedVersions.length !== 1 || signedVersions[0] !== 'version:' + version) {
    throw new Error('Updater trusted signature version mismatch.');
  }
  return true;
}

function regularFiles(directory) {
  if (!lstatSync(directory).isDirectory()) throw new Error('Artifact directory must not be a symlink.');
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile())) throw new Error('Release must contain only regular files, never symlinks.');
  return entries.map(entry => entry.name).sort();
}

function exactFiles(directory, expected) {
  const names = regularFiles(directory);
  if (JSON.stringify(names) !== JSON.stringify([...expected].sort())) {
    throw new Error('Release must contain exactly the expected regular files (version-matched installer required).');
  }
  return names;
}

function verifyChecksums(directory, files) {
  const lines = readFileSync(resolve(directory, CHECKSUMS), 'utf8').trimEnd().split(/\r?\n/);
  if (lines.length !== files.length) throw new Error('Checksum manifest must cover every artifact exactly once.');
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  ([^\r\n]+)$/i);
    if (!match || !files.includes(match[2]) || seen.has(match[2])) throw new Error('Invalid, duplicate, or unexpected checksum entry.');
    seen.add(match[2]);
    const actual = createHash('sha256').update(readFileSync(resolve(directory, match[2]))).digest('hex');
    if (actual !== match[1].toLowerCase()) throw new Error('Release artifact checksum mismatch.');
  }
}

// Explicitly separate unsigned CI/legacy bundles from publishable updater releases.
export function verifyUnsignedAssets(directory, version) {
  assertVersion(version);
  const names = regularFiles(directory);
  if (names.length !== 3) throw new Error('Unsigned release must contain exactly three regular files.');
  const binaries = names.filter(name => name.endsWith('.exe'));
  if (!names.includes(CHECKSUMS) || !binaries.includes(APP) || binaries.length !== 2
      || !binaries.some(name => name.endsWith('_' + version + '_x64-setup.exe'))) {
    throw new Error('Missing application, version-matched x64 installer, or checksums.');
  }
  verifyChecksums(directory, binaries);
  return names;
}

function assetNames(version) {
  assertVersion(version);
  const installer = 'dsh-wsl-desktop_' + version + '_x64-setup.exe';
  return { installer, signature: installer + '.sig', files: [APP, installer, installer + '.sig', 'latest.json'] };
}

function updaterUrl(version, installer) {
  return 'https://github.com/' + REPOSITORY + '/releases/download/v' + version + '/' + installer;
}

function exactKeys(object, keys) {
  return object !== null && typeof object === 'object' && !Array.isArray(object)
    && JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort());
}

export function verifyAssets(directory, version, { publicKey = readUpdaterPublicKey() } = {}) {
  const { installer, signature, files } = assetNames(version);
  const names = exactFiles(directory, [...files, CHECKSUMS]);
  verifyChecksums(directory, files);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'latest.json'), 'utf8'));
  if (!exactKeys(manifest, ['version', 'notes', 'pub_date', 'platforms']) || manifest.version !== version
      || typeof manifest.notes !== 'string' || !manifest.notes.trim()
      || typeof manifest.pub_date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.pub_date)
      || !Number.isFinite(Date.parse(manifest.pub_date)) || new Date(manifest.pub_date).toISOString() !== manifest.pub_date
      || !exactKeys(manifest.platforms, ['windows-x86_64'])) throw new Error('Invalid updater manifest version, date, notes or platforms.');
  const platform = manifest.platforms['windows-x86_64'];
  const encodedSignature = readFileSync(resolve(directory, signature), 'utf8').trim();
  if (!exactKeys(platform, ['url', 'signature']) || platform.url !== updaterUrl(version, installer)
      || platform.signature !== encodedSignature) throw new Error('Updater manifest URL/tag/version or signature mismatch.');
  verifyUpdaterSignature(readFileSync(resolve(directory, installer)), encodedSignature, publicKey, version);
  return names;
}

export function prepareAssets(directory, version, { publicKey = readUpdaterPublicKey(), date = new Date().toISOString(), notes = 'DSH WSL Desktop ' + version + ' for Windows x64.' } = {}) {
  const { installer, signature, files } = assetNames(version);
  // Reject unexpected files and symlinks before writing anything, including existing
  // manifests/checksums. In particular, never follow a pre-existing output symlink.
  const names = regularFiles(directory);
  if ([APP, installer, signature].some(name => !names.includes(name))
      || names.some(name => ![...files, CHECKSUMS].includes(name))) throw new Error('Missing or unexpected release input files.');
  const encodedSignature = readFileSync(resolve(directory, signature), 'utf8').trim();
  verifyUpdaterSignature(readFileSync(resolve(directory, installer)), encodedSignature, publicKey, version);
  const manifest = { version, notes, pub_date: date, platforms: {
    'windows-x86_64': { signature: encodedSignature, url: updaterUrl(version, installer) },
  } };
  writeFileSync(resolve(directory, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const checksums = [...files].sort().map(name => createHash('sha256').update(readFileSync(resolve(directory, name))).digest('hex') + '  ' + name);
  writeFileSync(resolve(directory, CHECKSUMS), checksums.join('\n') + '\n');
  return verifyAssets(directory, version, { publicKey });
}

function main() {
  const release = validateReleaseTag(process.env.RELEASE_TAG, readVersions());
  if (process.argv[2] === 'validate') {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      'version=' + release.version + '\nprerelease=' + release.prerelease + '\n');
    console.log('Validated release version ' + release.version + (release.prerelease ? ' (prerelease)' : ''));
  } else if (['prepare', 'verify'].includes(process.argv[2]) && process.argv[3]) {
    const action = process.argv[2] === 'prepare' ? prepareAssets : verifyAssets;
    console.log('Verified release files: ' + action(process.argv[3], release.version).join(', '));
  } else throw new Error('Usage: RELEASE_TAG=vX.Y.Z node scripts/release.mjs validate|prepare|verify <artifact-directory>');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
