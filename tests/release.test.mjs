import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { readReleaseNotes, prepareAssets, readUpdaterPublicKey, readVersions, validateReleaseTag, verifyAssets, verifyUnsignedAssets, verifyUpdaterSignature } from '../scripts/release.mjs';
import { fileURLToPath } from 'node:url';

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
function releaseFixture(t, version = VERSION, installerPrefix = 'DSH WSL Desktop') {
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
  const installer = `${installerPrefix}_${version}_x64-setup.exe`;
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
  test(`verifyUnsignedAssets accepts three ${version} release files, spaces and CRLF checksums`, t => {
    const fixture = releaseFixture(t, version);
    assert.ok(fixture.installer.includes(' '));
    assert.deepEqual(verifyUnsignedAssets(fixture.dir, version), [
      APP_NAME, fixture.installer, CHECKSUM_NAME,
    ].sort());
  });
}

for (const binary of ['application', 'installer']) {
  test(`verifyUnsignedAssets rejects tampered ${binary} contents`, t => {
    const fixture = releaseFixture(t);
    const name = binary === 'application' ? APP_NAME : fixture.installer;
    writeFileSync(join(fixture.dir, name), Buffer.from('MZ tampered executable'));
    assert.throws(() => verifyUnsignedAssets(fixture.dir, VERSION), /checksum mismatch/i);
  });
}

test('verifyUnsignedAssets rejects a missing checksum file', t => {
  const fixture = releaseFixture(t);
  unlinkSync(join(fixture.dir, CHECKSUM_NAME));
  assert.throws(() => verifyUnsignedAssets(fixture.dir, VERSION), /three regular files/i);
});

test('verifyUnsignedAssets rejects a missing executable checksum entry', t => {
  const fixture = releaseFixture(t);
  fixture.writeManifest(fixture.checksumLines.slice(0, 1));
  assert.throws(() => verifyUnsignedAssets(fixture.dir, VERSION), /cover every artifact/i);
});

test('verifyUnsignedAssets rejects duplicate checksum entries even with two lines', t => {
  const fixture = releaseFixture(t);
  fixture.writeManifest([fixture.checksumLines[0], fixture.checksumLines[0]]);
  assert.throws(() => verifyUnsignedAssets(fixture.dir, VERSION), /duplicate/i);
});

for (const name of ['../dsh-wsl-desktop.exe', '..\\dsh-wsl-desktop.exe', '/tmp/dsh-wsl-desktop.exe', 'unknown.exe']) {
  test(`verifyUnsignedAssets rejects unsafe or unknown checksum filename ${JSON.stringify(name)}`, t => {
    const fixture = releaseFixture(t);
    fixture.writeManifest([
      `${sha256(fixture.contents.get(APP_NAME))}  ${name}`,
      fixture.checksumLines[1],
    ]);
    assert.throws(() => verifyUnsignedAssets(fixture.dir, VERSION), /unexpected checksum entry/i);
  });
}

for (const malformed of ['not-a-hash  dsh-wsl-desktop.exe', `${'0'.repeat(64)} dsh-wsl-desktop.exe`]) {
  test(`verifyUnsignedAssets rejects malformed checksum line ${JSON.stringify(malformed)}`, t => {
    const fixture = releaseFixture(t);
    fixture.writeManifest([malformed, fixture.checksumLines[1]]);
    assert.throws(() => verifyUnsignedAssets(fixture.dir, VERSION), /invalid/i);
  });
}

for (const extra of ['extra.exe', 'release-notes.txt']) {
  test(`verifyUnsignedAssets rejects extra release file ${extra}`, t => {
    const fixture = releaseFixture(t);
    writeFileSync(join(fixture.dir, extra), 'unexpected');
    assert.throws(() => verifyUnsignedAssets(fixture.dir, VERSION), /regular files/i);
  });
}

test('verifyUnsignedAssets rejects an installer for a different version', t => {
  const fixture = releaseFixture(t);
  assert.throws(() => verifyUnsignedAssets(fixture.dir, '0.2.0'), /version-matched/i);
});

for (const kind of ['application', 'checksum']) {
  test(`verifyUnsignedAssets rejects a ${kind} symlink`, { skip: process.platform === 'win32' }, t => {
    const fixture = releaseFixture(t);
    const name = kind === 'application' ? APP_NAME : CHECKSUM_NAME;
    const target = join(fixture.root, 'symlink-target');
    const content = kind === 'application'
      ? fixture.contents.get(APP_NAME)
      : `${fixture.checksumLines.join('\r\n')}\r\n`;
    writeFileSync(target, content);
    unlinkSync(join(fixture.dir, name));
    symlinkSync(target, join(fixture.dir, name));
    assert.throws(() => verifyUnsignedAssets(fixture.dir, VERSION), /regular files/i);
  });
}

// These are fresh, test-only Ed25519 keys; production signing secrets are never read.
const SIGNER = generateKeyPairSync('ed25519');
const KEY_ID = Buffer.from('0123456789abcdef', 'hex');
const DATE = '2026-10-22T14:00:00.000Z';
function publicKeyFor(keyPair = SIGNER) {
  const key = keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const packet = Buffer.concat([Buffer.from('Ed'), KEY_ID, key]).toString('base64');
  return Buffer.from('untrusted comment: test updater public key\n' + packet + '\n').toString('base64');
}
function signatureFor(content, { version = VERSION, keyPair = SIGNER, algorithm = 'ED', trustedComment } = {}) {
  const message = algorithm === 'ED' ? createHash('blake2b512').update(content).digest() : content;
  const artifact = sign(null, message, keyPair.privateKey);
  const packet = Buffer.concat([Buffer.from(algorithm), KEY_ID, artifact]).toString('base64');
  const trusted = trustedComment ?? 'timestamp:1792677600\tfile:original-setup.exe\tversion:' + version;
  const global = sign(null, Buffer.concat([artifact, Buffer.from(trusted)]), keyPair.privateKey).toString('base64');
  return Buffer.from('untrusted comment: test signature\n' + packet + '\ntrusted comment: ' + trusted + '\n' + global + '\n').toString('base64');
}
function signedFixture(t, version = VERSION) {
  const fixture = releaseFixture(t, version, 'dsh-wsl-desktop');
  const publicKey = publicKeyFor();
  const signature = fixture.installer + '.sig';
  writeFileSync(join(fixture.dir, signature), signatureFor(fixture.contents.get(fixture.installer), { version }));
  prepareAssets(fixture.dir, version, { publicKey, date: DATE });
  const rehash = () => {
    const names = readdirSync(fixture.dir).filter(name => name !== CHECKSUM_NAME).sort();
    fixture.writeManifest(names.map(name => sha256(readFileSync(join(fixture.dir, name))) + '  ' + name));
  };
  const mutateManifest = mutate => {
    const manifest = JSON.parse(readFileSync(join(fixture.dir, 'latest.json'), 'utf8'));
    mutate(manifest);
    writeFileSync(join(fixture.dir, 'latest.json'), JSON.stringify(manifest));
    rehash();
  };
  return { ...fixture, publicKey, signature, rehash, mutateManifest };
}

for (const version of [VERSION, '0.2.0-rc.1']) {
  test('signed release generates and verifies exactly five ' + version + ' assets', t => {
    const fixture = signedFixture(t, version);
    const expected = [APP_NAME, fixture.installer, fixture.signature, 'latest.json', CHECKSUM_NAME].sort();
    assert.deepEqual(verifyAssets(fixture.dir, version, fixture), expected);
    const manifest = JSON.parse(readFileSync(join(fixture.dir, 'latest.json'), 'utf8'));
    assert.equal(manifest.version, version);
    assert.equal(manifest.pub_date, DATE);
    assert.ok(manifest.notes.includes(version));
    assert.ok(manifest.notes.includes('https://github.com/PC2005-cloud/dsh-pet'));
    assert.ok(manifest.notes.includes('prohibit commercial use'));
    assert.deepEqual(Object.keys(manifest.platforms), ['windows-x86_64']);
    assert.equal(manifest.platforms['windows-x86_64'].url,
      'https://github.com/elves-ai/dsh-wsl-desktop/releases/download/v' + version + '/' + fixture.installer);
    assert.equal(manifest.platforms['windows-x86_64'].signature, readFileSync(join(fixture.dir, fixture.signature), 'utf8'));
    assert.equal(readFileSync(join(fixture.dir, CHECKSUM_NAME), 'utf8').trimEnd().split(/\r?\n/).length, 4);
  });
}

test('checked-in updater public key is configured, never supplied through signing environment', () => {
  assert.equal(typeof readUpdaterPublicKey(), 'string');
  assert.ok(readUpdaterPublicKey().length > 50);
});

test('legacy unsigned three-file bundle cannot pass publish verification', t => {
  const fixture = releaseFixture(t);
  assert.throws(() => verifyAssets(fixture.dir, VERSION, { publicKey: publicKeyFor() }), /exactly.*expected/i);
});

for (const name of [APP_NAME, 'dsh-wsl-desktop_0.1.0_x64-setup.exe', 'dsh-wsl-desktop_0.1.0_x64-setup.exe.sig', 'latest.json']) {
  test('signed release rejects tampered hash for ' + name, t => {
    const fixture = signedFixture(t);
    writeFileSync(join(fixture.dir, name), 'tampered');
    assert.throws(() => verifyAssets(fixture.dir, VERSION, fixture), /checksum mismatch/i);
  });
}
for (const name of [APP_NAME, 'dsh-wsl-desktop_0.1.0_x64-setup.exe', 'dsh-wsl-desktop_0.1.0_x64-setup.exe.sig', 'latest.json', CHECKSUM_NAME]) {
  test('signed release rejects missing ' + name, t => {
    const fixture = signedFixture(t);
    unlinkSync(join(fixture.dir, name));
    assert.throws(() => verifyAssets(fixture.dir, VERSION, fixture), /exactly.*expected/i);
  });
  test('signed release rejects symlink for ' + name + ' without following output targets', { skip: process.platform === 'win32' }, t => {
    const fixture = signedFixture(t);
    const target = join(fixture.root, 'outside-release');
    const original = readFileSync(join(fixture.dir, name));
    writeFileSync(target, original);
    unlinkSync(join(fixture.dir, name));
    symlinkSync(target, join(fixture.dir, name));
    assert.throws(() => verifyAssets(fixture.dir, VERSION, fixture), /regular files/i);
    assert.throws(() => prepareAssets(fixture.dir, VERSION, fixture), /regular files/i);
    assert.deepEqual(readFileSync(target), original);
  });
}

test('signed release rejects extra files, nested directories and alternate installer names', t => {
  const fixture = signedFixture(t);
  writeFileSync(join(fixture.dir, 'extra.exe'), 'extra');
  assert.throws(() => verifyAssets(fixture.dir, VERSION, fixture), /exactly.*expected/i);
  unlinkSync(join(fixture.dir, 'extra.exe'));
  mkdirSync(join(fixture.dir, 'nested'));
  assert.throws(() => verifyAssets(fixture.dir, VERSION, fixture), /regular files/i);
});

test('signed release rejects a symlink artifact root', { skip: process.platform === 'win32' }, t => {
  const fixture = signedFixture(t);
  const link = join(fixture.root, 'linked-release');
  symlinkSync(fixture.dir, link, 'dir');
  assert.throws(() => verifyAssets(link, VERSION, fixture), /directory.*symlink/i);
});

const invalidManifests = [
  ['version', m => { m.version = '0.2.0'; }],
  ['date', m => { m.pub_date = 'yesterday'; }],
  ['impossible date', m => { m.pub_date = '2026-02-30T14:00:00.000Z'; }],
  ['empty notes', m => { m.notes = ' '; }],
  ['missing notes', m => { delete m.notes; }],
  ['extra platform', m => { m.platforms['linux-x86_64'] = m.platforms['windows-x86_64']; }],
  ['wrong platform', m => { m.platforms['windows-aarch64'] = m.platforms['windows-x86_64']; delete m.platforms['windows-x86_64']; }],
  ['extra field', m => { m.url = 'https://example.com'; }],
  ['wrong repo', m => { m.platforms['windows-x86_64'].url = m.platforms['windows-x86_64'].url.replace('elves-ai', 'attacker'); }],
  ['wrong tag', m => { m.platforms['windows-x86_64'].url = m.platforms['windows-x86_64'].url.replace('/v0.1.0/', '/v0.2.0/'); }],
  ['latest URL', m => { m.platforms['windows-x86_64'].url = 'https://github.com/elves-ai/dsh-wsl-desktop/releases/latest/download/installer.exe'; }],
  ['URL traversal', m => { m.platforms['windows-x86_64'].url += '/../evil.exe'; }],
  ['signature', m => { m.platforms['windows-x86_64'].signature = 'ZmFrZQ=='; }],
];
for (const [reason, mutate] of invalidManifests) {
  test('signed release rejects manifest ' + reason + ' even with recomputed hashes', t => {
    const fixture = signedFixture(t);
    fixture.mutateManifest(mutate);
    assert.throws(() => verifyAssets(fixture.dir, VERSION, fixture), /manifest/i);
  });
}

for (const entry of ['../outside', '..\\outside', '/tmp/outside', 'unknown.exe', 'latest.json']) {
  test('signed checksums reject traversal, unexpected or duplicate entry ' + entry, t => {
    const fixture = signedFixture(t);
    const lines = readFileSync(join(fixture.dir, CHECKSUM_NAME), 'utf8').trimEnd().split(/\r?\n/);
    lines[0] = '0'.repeat(64) + '  ' + entry;
    fixture.writeManifest(lines);
    assert.throws(() => verifyAssets(fixture.dir, VERSION, fixture), /checksum entry|checksum mismatch/i);
  });
}

test('recomputed SHA256 cannot hide a modified installer', t => {
  const fixture = signedFixture(t);
  writeFileSync(join(fixture.dir, fixture.installer), 'malicious installer');
  fixture.rehash();
  assert.throws(() => verifyAssets(fixture.dir, VERSION, fixture), /cryptographic verification/i);
});

test('installer signatures verify both prehashed and legacy Ed25519 minisign modes', () => {
  const content = Buffer.from('signed payload');
  for (const algorithm of ['ED', 'Ed']) {
    assert.equal(verifyUpdaterSignature(content, signatureFor(content, { algorithm }), publicKeyFor(), VERSION), true);
  }
});

test('valid payload with wrong key is rejected cryptographically', () => {
  const content = Buffer.from('payload');
  assert.throws(() => verifyUpdaterSignature(content, signatureFor(content), publicKeyFor(generateKeyPairSync('ed25519')), VERSION), /cryptographic/i);
});

for (const trustedComment of ['timestamp:1\tfile:a', 'timestamp:1\tversion:0.2.0', 'version:0.1.0\tversion:0.1.0']) {
  test('authenticated but absent/wrong/duplicate trusted version is rejected: ' + trustedComment, () => {
    const content = Buffer.from('payload');
    assert.throws(() => verifyUpdaterSignature(content, signatureFor(content, { trustedComment }), publicKeyFor(), VERSION), /trusted.*version/i);
  });
}

test('global signature authenticates the trusted version comment', () => {
  const content = Buffer.from('payload');
  const original = signatureFor(content, { version: '0.0.9' });
  const changed = Buffer.from(Buffer.from(original, 'base64').toString('utf8').replace('version:0.0.9', 'version:0.1.0')).toString('base64');
  assert.throws(() => verifyUpdaterSignature(content, changed, publicKeyFor(), VERSION), /cryptographic/i);
});

for (const bad of [undefined, '', 'not base64', 'ZmFrZQ==', signatureFor(Buffer.from('wrong')) + '\n']) {
  test('signature parser fails closed on malformed encoding ' + String(bad).slice(0, 15), () => {
    assert.throws(() => verifyUpdaterSignature(Buffer.from('payload'), bad, publicKeyFor(), VERSION), /base64|minisign/i);
  });
}

test('signature parser rejects unsupported algorithms, truncated packets and wrong key IDs', () => {
  const content = Buffer.from('payload');
  for (const mutate of [
    packet => { packet[0] = 0; },
    packet => { packet[0] |= 0x80; },
    packet => { packet[2] ^= 1; },
    packet => packet.subarray(0, 40),
  ]) {
    const lines = Buffer.from(signatureFor(content), 'base64').toString('utf8').trimEnd().split('\n');
    let packet = Buffer.from(lines[1], 'base64');
    packet = mutate(packet) ?? packet;
    lines[1] = packet.toString('base64');
    assert.throws(() => verifyUpdaterSignature(content, Buffer.from(lines.join('\n')).toString('base64'), publicKeyFor(), VERSION), /algorithm|packet|key ID/i);
  }
});

test('unsafe versions cannot become release paths', t => {
  const fixture = signedFixture(t);
  for (const version of ['../bad', '..\\bad', '0.1.0/../bad', '0.1.0\n']) {
    assert.throws(() => verifyAssets(fixture.dir, version, fixture), /tag/i);
    assert.throws(() => prepareAssets(fixture.dir, version, fixture), /tag/i);
  }
});

test('real installed Tauri signer output passes cryptographic verification and manifest preparation', { timeout: 30000 }, t => {
  const fixture = releaseFixture(t, VERSION, 'dsh-wsl-desktop');
  const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
  const keyPath = join(fixture.root, 'ephemeral-test-key');
  const invoke = args => {
    // Capture CLI output: key generation prints the private key. Never echo it,
    // even on failure. This key only exists in our temporary test directory.
    const result = spawnSync(process.execPath, [cli, 'signer', ...args], {
      encoding: 'utf8', timeout: 15000,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TAURI_SIGNING_'))), CI: 'true' },
    });
    assert.equal(result.status, 0, 'Tauri test-only signer command must succeed (output suppressed)');
  };
  invoke(['generate', '--ci', '--password', '', '--write-keys', keyPath]);
  invoke(['sign', '--private-key-path', keyPath, '--password', '', '--app-version', VERSION, join(fixture.dir, fixture.installer)]);
  const publicKey = readFileSync(keyPath + '.pub', 'utf8').trim();
  assert.equal(prepareAssets(fixture.dir, VERSION, { publicKey, date: DATE }).length, 5);
  assert.equal(verifyAssets(fixture.dir, VERSION, { publicKey }).length, 5);
});

test('publish verification defaults to the checked-in key, not the test signer key', t => {
  const fixture = signedFixture(t);
  assert.throws(() => verifyAssets(fixture.dir, VERSION), /key ID|cryptographic/i);
});

test('signature parser rejects invalid UTF-8 instead of silently replacing bytes', () => {
  const content = Buffer.from('payload');
  const decoded = Buffer.from(signatureFor(content), 'base64');
  decoded[0] = 0xff;
  assert.throws(() => verifyUpdaterSignature(content, decoded.toString('base64'), publicKeyFor(), VERSION), /encoded data|encoding/i);
});

test('version-matched release notes describe interactions and retain upstream asset restrictions', () => {
  const notes=readReleaseNotes(readVersions().package);
  assert.ok(notes.startsWith('# v'+readVersions().package+'\n'));
  assert.ok(notes.includes('允许一次/拒绝'));
  assert.ok(notes.includes('https://github.com/PC2005-cloud/dsh-pet'));
  assert.ok(notes.includes('prohibit commercial use'));
  assert.throws(()=>readReleaseNotes('99.0.0'),/match the application version/);
});
