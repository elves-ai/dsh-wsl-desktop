import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { readVersions, validateReleaseTag, verifyAssets } from '../scripts/release.mjs';

const VERSION = '0.1.0';
const METADATA_KEYS = ['package', 'lock', 'cargo', 'tauri'];
const APP_NAME = 'dsh-wsl-desktop.exe';
const CHECKSUM_NAME = 'SHA256SUMS.txt';
const TEMP_PREFIX = 'dsh-release-test-';

function versions(version = VERSION) {
  return Object.fromEntries(METADATA_KEYS.map(key => [key, version]));
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

// Every asset test starts from the same valid three-file release. The fake
// executables are only hashed, never executed; no network or publishing is used.
function releaseFixture(t, version = VERSION) {
  const tempParent = realpathSync(tmpdir());
  const root = mkdtempSync(join(tempParent, TEMP_PREFIX));
  function assertSafeCleanupRoot() {
    assert.ok(isAbsolute(root), 'cleanup requires an absolute temporary path');
    assert.equal(dirname(root), tempParent);
    assert.ok(basename(root).startsWith(TEMP_PREFIX));
    assert.notEqual(root, tempParent);
    assert.equal(realpathSync(root), root, 'temporary root must not be a symlink');
  }
  assertSafeCleanupRoot();
  t.after(() => {
    assertSafeCleanupRoot();
    rmSync(root, { recursive: true, force: true });
  });

  const dir = join(root, 'release');
  mkdirSync(dir);
  const installer = `DSH WSL Desktop_${version}_x64-setup.exe`;
  const contents = new Map([
    [APP_NAME, Buffer.from('MZ\0fake desktop application\r\n', 'utf8')],
    [installer, Buffer.from('MZ\0fake setup executable\r\n', 'utf8')],
  ]);
  for (const [name, content] of contents) writeFileSync(join(dir, name), content);
  const checksumLines = [...contents].map(([name, content]) => `${sha256(content)}  ${name}`);
  const writeManifest = (lines = checksumLines) => {
    writeFileSync(join(dir, CHECKSUM_NAME), `${lines.join('\r\n')}\r\n`);
  };
  writeManifest();
  return { root, dir, installer, contents, checksumLines, writeManifest };
}

test('validateReleaseTag accepts matching stable and prerelease metadata', () => {
  assert.deepEqual(validateReleaseTag('v0.1.0', versions()), {
    version: VERSION, prerelease: false,
  });
  assert.deepEqual(validateReleaseTag('v0.2.0-rc.1', versions('0.2.0-rc.1')), {
    version: '0.2.0-rc.1', prerelease: true,
  });
});

const invalidTags = [
  '0.1.0', '', 'v0.1', 'v0.1.0.1', 'v0.1.0-', 'v0.1.0-rc..1',
  'v0.1.0-rc_1', 'v0.1.0+build.1', ' v0.1.0', 'v0.1.0\n',
  'v00.1.0', 'v0.01.0', 'v0.1.00',
  'v0.2.0-01', 'v0.2.0-rc.01', 'v0.2.0-00.rc',
  undefined, null, 100, {},
];
for (const tag of invalidTags) {
  test(`validateReleaseTag rejects invalid tag ${JSON.stringify(tag)}`, () => {
    const matching = versions(typeof tag === 'string' ? tag.replace(/^v/, '') : VERSION);
    assert.throws(() => validateReleaseTag(tag, matching), /tag|leading zeros/i);
  });
}

for (const key of METADATA_KEYS) {
  test(`validateReleaseTag rejects mismatched ${key} metadata`, () => {
    assert.throws(
      () => validateReleaseTag('v0.1.0', { ...versions(), [key]: '0.2.0' }),
      new RegExp(`match ${key} metadata`),
    );
  });
}

test('readVersions reads four consistent current metadata versions', () => {
  const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(typeof packageVersion, 'string');
  assert.ok(packageVersion.length > 0);
  assert.deepEqual(readVersions(), versions(packageVersion));
});

for (const version of [VERSION, '0.2.0-rc.1']) {
  test(`verifyAssets accepts three ${version} release files, spaces and CRLF checksums`, t => {
    const fixture = releaseFixture(t, version);
    assert.ok(fixture.installer.includes(' '));
    assert.deepEqual(verifyAssets(fixture.dir, version), [
      APP_NAME, fixture.installer, CHECKSUM_NAME,
    ].sort());
  });
}

for (const binary of ['application', 'installer']) {
  test(`verifyAssets rejects tampered ${binary} contents`, t => {
    const fixture = releaseFixture(t);
    const name = binary === 'application' ? APP_NAME : fixture.installer;
    writeFileSync(join(fixture.dir, name), Buffer.from('MZ tampered executable'));
    assert.throws(() => verifyAssets(fixture.dir, VERSION), /checksum mismatch/i);
  });
}

test('verifyAssets rejects a missing checksum file', t => {
  const fixture = releaseFixture(t);
  unlinkSync(join(fixture.dir, CHECKSUM_NAME));
  assert.throws(() => verifyAssets(fixture.dir, VERSION), /three regular files/i);
});

test('verifyAssets rejects a missing executable checksum entry', t => {
  const fixture = releaseFixture(t);
  fixture.writeManifest(fixture.checksumLines.slice(0, 1));
  assert.throws(() => verifyAssets(fixture.dir, VERSION), /cover every executable/i);
});

test('verifyAssets rejects duplicate checksum entries even with two lines', t => {
  const fixture = releaseFixture(t);
  fixture.writeManifest([fixture.checksumLines[0], fixture.checksumLines[0]]);
  assert.throws(() => verifyAssets(fixture.dir, VERSION), /duplicate/i);
});

for (const name of ['../dsh-wsl-desktop.exe', '..\\dsh-wsl-desktop.exe', '/tmp/dsh-wsl-desktop.exe', 'unknown.exe']) {
  test(`verifyAssets rejects unsafe or unknown checksum filename ${JSON.stringify(name)}`, t => {
    const fixture = releaseFixture(t);
    fixture.writeManifest([
      `${sha256(fixture.contents.get(APP_NAME))}  ${name}`,
      fixture.checksumLines[1],
    ]);
    assert.throws(() => verifyAssets(fixture.dir, VERSION), /unexpected checksum entry/i);
  });
}

for (const malformed of ['not-a-hash  dsh-wsl-desktop.exe', `${'0'.repeat(64)} dsh-wsl-desktop.exe`]) {
  test(`verifyAssets rejects malformed checksum line ${JSON.stringify(malformed)}`, t => {
    const fixture = releaseFixture(t);
    fixture.writeManifest([malformed, fixture.checksumLines[1]]);
    assert.throws(() => verifyAssets(fixture.dir, VERSION), /invalid/i);
  });
}

for (const extra of ['extra.exe', 'release-notes.txt']) {
  test(`verifyAssets rejects extra release file ${extra}`, t => {
    const fixture = releaseFixture(t);
    writeFileSync(join(fixture.dir, extra), 'unexpected');
    assert.throws(() => verifyAssets(fixture.dir, VERSION), /three regular files/i);
  });
}

test('verifyAssets rejects an installer for a different version', t => {
  const fixture = releaseFixture(t);
  assert.throws(() => verifyAssets(fixture.dir, '0.2.0'), /version-matched/i);
});

for (const kind of ['application', 'checksum']) {
  test(`verifyAssets rejects a ${kind} symlink`, { skip: process.platform === 'win32' }, t => {
    const fixture = releaseFixture(t);
    const name = kind === 'application' ? APP_NAME : CHECKSUM_NAME;
    const target = join(fixture.root, 'symlink-target');
    const content = kind === 'application'
      ? fixture.contents.get(APP_NAME)
      : `${fixture.checksumLines.join('\r\n')}\r\n`;
    writeFileSync(target, content);
    unlinkSync(join(fixture.dir, name));
    symlinkSync(target, join(fixture.dir, name));
    assert.throws(() => verifyAssets(fixture.dir, VERSION), /three regular files/i);
  });
}
