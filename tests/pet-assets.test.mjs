import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const assetRoot = 'public/pet/dsh-pet/';
const manifestPath = 'third-party/dsh-pet/manifest.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (path) => readFile(new URL(path, root), 'utf8');
const manifest = JSON.parse(await text(manifestPath));
const publicConfig = JSON.parse(await text(assetRoot + 'config.json'));
const loadTs = async (path, base) => {
  let source = await text(path);
  if (base !== undefined) source = source.replace('import.meta.env?.BASE_URL', JSON.stringify(base));
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
};
const config = await loadTs('src/pet/config.ts');
const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(new URL(directory + '/', root), { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    assert.equal(entry.isSymbolicLink(), false, 'No symlink in vendored payload: ' + path);
    if (entry.isDirectory()) files.push(...await walk(path));
    else { assert.equal(entry.isFile(), true, path); files.push(path); }
  }
  return files;
};

test('pinned manifest is complete, unique, and bundled with public assets', async () => {
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.upstream.url, 'https://github.com/PC2005-cloud/dsh-pet');
  assert.equal(manifest.upstream.commit, 'bbf9dd800c8e5d4dc8cd2209c537b28808465c52');
  assert.equal(manifest.codeLicense, 'MIT');
  assert.equal(manifest.hashAlgorithm, 'sha256');
  assert.deepEqual(JSON.parse(await text(assetRoot + 'manifest.json')), manifest);
  const paths = manifest.files.map((file) => file.path);
  assert.equal(new Set(paths).size, paths.length);
  const actual = ['src/pet/config.ts'];
  for (const directory of ['src/vendor/dsh-pet', 'public/pet/dsh-pet', 'third-party/dsh-pet']) {
    actual.push(...await walk(directory));
  }
  const exclusions = ['third-party/dsh-pet/manifest.json', assetRoot + 'manifest.json'];
  assert.deepEqual(manifest.manifestExclusions, exclusions);
  assert.deepEqual(paths.sort(), actual.filter((p) => !exclusions.includes(p)).sort());
  for (const path of paths) assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), path);
});

test('every vendored file has its recorded byte count and SHA-256', async () => {
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    const bytes = await readFile(new URL(file.path, root));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
    if (file.transform === 'copy') assert.equal(file.sha256, file.upstreamSha256, file.path);
  }
});

test('all 106 original assets are real VP9 WebM, not Git LFS pointers', async () => {
  const files = manifest.files.filter((file) => file.path.endsWith('.webm'));
  assert.equal(files.length, 106);
  assert.equal(manifest.assetCount, 106);
  assert.equal(manifest.assetBytes, 54351332);
  assert.equal(files.reduce((sum, file) => sum + file.bytes, 0), manifest.assetBytes);
  for (const file of files) {
    const bytes = await readFile(new URL(file.path, root));
    assert.ok(bytes.length > 1024, file.path);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3', file.path + ': EBML header');
    assert.ok(bytes.subarray(0, 128).includes(Buffer.from('webm')), file.path + ': WebM document type');
    assert.ok(bytes.includes(Buffer.from('V_VP9')), file.path + ': original VP9 track');
    assert.ok(!bytes.subarray(0, 200).includes(Buffer.from('git-lfs.github.com/spec')), file.path);
    assert.equal(file.transform, 'copy');
    assert.equal(file.upstreamPath, 'dsh-pet/assets/webm/' + file.path.split('/').at(-1));
  }
  assert.deepEqual(files.map((f) => f.path.split('/').at(-1)).sort(),
    config.animationNames.map((name) => name + '.webm').sort());
});

test('shared source differs from upstream only by documented TypeScript extensions', async () => {
  const sourceFiles = manifest.files.filter((file) => file.path.startsWith('src/vendor/dsh-pet/'));
  assert.deepEqual(sourceFiles.map((f) => f.path.split('/').at(-1)).sort(), [
    'constants.ts', 'displays.ts', 'motion.ts', 'physics.ts', 'pickers.ts', 'types.ts', 'work-status.ts',
  ]);
  for (const file of sourceFiles) {
    const source = await text(file.path);
    const recovered = file.transform === 'relative-import-ts-extension'
      ? source.replace(/from '(\.\/[^']+)\.ts'/g, "from '$1'") : source;
    assert.equal(sha256(recovered), file.upstreamSha256, file.path);
    const ast = ts.createSourceFile(file.path, source, ts.ScriptTarget.ES2022, true);
    for (const node of ast.statements) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (!node.moduleSpecifier) continue;
        const specifier = node.moduleSpecifier.text;
        assert.match(specifier, /^\.\/[a-z-]+\.ts$/, file.path);
        assert.ok(sourceFiles.some((f) => f.path === 'src/vendor/dsh-pet/' + specifier.slice(2)), specifier);
      }
    }
    assert.doesNotMatch(source, /(?:require\s*\(|import\s*\(|process\.env|fetch\s*\(|new WebSocket\s*\()/, file.path);
  }
});

test('renderer exports match the prompt-free public config and original state pools', async () => {
  assert.deepEqual(Object.keys(publicConfig).sort(), ['animationWeights', 'animations', 'physics']);
  assert.deepEqual(config.petConfig, publicConfig);
  assert.strictEqual(config.default, config.petConfig);
  assert.strictEqual(config.PET_ANIMATIONS, config.animations);
  assert.strictEqual(config.PET_ANIMATION_WEIGHTS, config.animationWeights);
  assert.deepEqual(config.animationWeights, { idle: 10, turn: 5, move: 5 });
  assert.deepEqual(config.physics, { gravity: 1400, restitution: 0.78, groundFriction: 2.5,
    ceilingBounce: true, throwPower: 1, petCollision: false });
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, /prompt|credential|token|apiKey|provider|model|secret|endpoint/i);
      visit(child);
    }
  };
  visit(publicConfig);
  const status = await loadTs('src/vendor/dsh-pet/work-status.ts');
  assert.deepEqual(status.WORK_STATUS_STATES, ['thinking', 'working', 'result', 'waiting', 'success', 'error']);
  assert.equal(config.animations.events.workStatus.length, 6);
  for (const [index, state] of status.WORK_STATUS_STATES.entries()) assert.equal(status.WORK_STATUS_INDEX[state], index);
  assert.deepEqual(config.animations.events.workStatus, ['工作状态-思考冒泡', '工作状态-忙碌点按',
    '工作状态-清点归档', '工作状态-原地踱步张望', '工作状态-雀跃庆祝', '工作状态-垂头叹气冒汗']);
});

test('animation URLs are local encoded resources and respect the Vite deployment base', async () => {
  for (const base of ['/', '/desktop/', './', '/desktop', 'https://example.test/desktop/']) {
    const exports = await loadTs('src/pet/config.ts', base);
    const prefix = (base.endsWith('/') ? base : base + '/') + 'pet/dsh-pet/';
    assert.equal(exports.PET_ASSET_BASE, prefix + 'webm/');
    assert.equal(exports.PET_NOTICE_URL, prefix + 'NOTICE.md');
    assert.equal(exports.PET_LICENSE_URL, prefix + 'LICENSE');
    for (const name of exports.animationNames) {
      assert.equal(exports.resolveAnimationUrl(name), prefix + 'webm/' + encodeURIComponent(name) + '.webm');
    }
    for (const invalid of ['../secret', '/etc/passwd', 'https://evil.test/a', '待机呼吸休闲.webm', '']) {
      assert.throws(() => exports.resolveAnimationUrl(invalid), /Unknown dsh-pet animation/);
    }
  }
});

test('distribution includes original MIT and verbatim upstream asset/derivative requirements', async () => {
  const excerpt = '## 许可\n\n- 代码：MIT\n- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**\n'
    + '- **二次创作（二创）约定**：基于本项目的衍生 / 改版 / 换皮作品，在**任何介绍、展示、分发该作品的地方**，须附上原作者 GitHub 地址：<https://github.com/PC2005-cloud/dsh-pet>\n';
  for (const path of ['third-party/dsh-pet/', assetRoot]) {
    const license = await text(path + 'LICENSE');
    assert.match(license, /^MIT License\n/);
    assert.match(license, /Copyright \(c\) 2026 PC2005-cloud/);
    assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
    assert.equal(await text(path + 'README-LICENSE.md'), excerpt);
    const notice = await text(path + 'NOTICE.md');
    assert.ok(notice.includes(excerpt));
    assert.match(notice, /https:\/\/github\.com\/PC2005-cloud\/dsh-pet/);
    assert.match(notice, /commercial use is prohibited/);
    assert.match(notice, /everywhere the work is introduced, displayed, or distributed/);
  }
});

test('Git checkout keeps vendored bytes even with Windows CRLF defaults', {timeout:60_000}, async t => {
  const temp=await mkdtemp(join(tmpdir(),'dsh-pet-checkout-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const repository=join(temp,'repository');const output=join(temp,'checkout');
  await mkdir(repository);await mkdir(output);
  const original=new Map();
  const paths=manifest.files.filter(file=>!file.path.endsWith('.webm')).map(file=>file.path);
  paths.push('.gitattributes',manifest.files.find(file=>file.path.endsWith('.webm')).path);
  for(const path of paths) original.set(path,await readFile(new URL(path,root)));
  // Future upstream CRLF content must also remain verbatim, rather than being normalized.
  original.set('src/vendor/dsh-pet/original-crlf.txt',Buffer.from('upstream\r\nbyte-exact\r\n'));
  for(const [path,bytes] of original) {
    const destination=join(repository,path);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes);
  }
  const git=(...args)=>{
    const result=spawnSync('git',['-c','core.autocrlf=true','-c','core.eol=crlf',...args],{cwd:repository,encoding:'utf8',timeout:30_000});
    assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  };
  git('init','--quiet');git('add','--all');
  git('checkout-index','--all','--prefix='+output.replaceAll('\\','/')+'/');
  for(const [path,bytes] of original) assert.equal(sha256(await readFile(join(output,path))),sha256(bytes),path);
});
