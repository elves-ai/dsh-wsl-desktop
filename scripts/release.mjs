import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

export function verifyAssets(directory, version) {
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length !== 3 || entries.some(entry => !entry.isFile())) throw new Error('Release must contain exactly three regular files.');
  const names = entries.map(entry => entry.name);
  const binaries = names.filter(name => name.endsWith('.exe'));
  if (!names.includes('SHA256SUMS.txt') || !binaries.includes('dsh-wsl-desktop.exe') || binaries.length !== 2
      || !binaries.some(name => name.endsWith('_' + version + '_x64-setup.exe'))) {
    throw new Error('Missing application, version-matched x64 installer, or checksums.');
  }
  const manifest = readFileSync(resolve(directory, 'SHA256SUMS.txt'), 'utf8').trimEnd().split(/\r?\n/);
  if (manifest.length !== binaries.length) throw new Error('Checksum manifest must cover every executable exactly once.');
  const seen = new Set();
  for (const line of manifest) {
    const match = line.match(/^([a-f0-9]{64})  ([^\r\n]+)$/i);
    if (!match || !binaries.includes(match[2]) || seen.has(match[2])) throw new Error('Invalid, duplicate, or unexpected checksum entry.');
    seen.add(match[2]);
    const actual = createHash('sha256').update(readFileSync(resolve(directory, match[2]))).digest('hex');
    if (actual !== match[1].toLowerCase()) throw new Error('Release executable checksum mismatch.');
  }
  return names.sort();
}

function main() {
  const release = validateReleaseTag(process.env.RELEASE_TAG, readVersions());
  if (process.argv[2] === 'validate') {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      'version=' + release.version + '\nprerelease=' + release.prerelease + '\n');
    console.log('Validated release version ' + release.version + (release.prerelease ? ' (prerelease)' : ''));
  } else if (process.argv[2] === 'verify' && process.argv[3]) {
    console.log('Verified release files: ' + verifyAssets(process.argv[3], release.version).join(', '));
  } else throw new Error('Usage: RELEASE_TAG=vX.Y.Z node scripts/release.mjs validate|verify <artifact-directory>');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
