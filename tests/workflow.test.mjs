import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
const raw = readFileSync(new URL('../.github/workflows/windows-build.yml', import.meta.url), 'utf8');
const document = parseDocument(raw, { uniqueKeys: true });
const workflow = document.toJS();

test('CI is valid YAML, defaults to read-only tokens and runs only on version tag pushes', () => {
  assert.equal(document.errors.length, 0);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on, { push: { tags: ['v*'] } });
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'publish-release') assert.ok(!job.permissions || job.permissions.contents !== 'write');
  }
});
test('environment inspection and directory save fixture tests run before packaging', () => {
  const step = workflow.jobs.verify.steps.find(step => step.run?.includes('python -m unittest discover'));
  assert.ok(step);
  assert.ok(step.run.includes("-p 'test_*.py'"));
  assert.equal(workflow.env.PYTHONDONTWRITEBYTECODE, '1');
});

test('Windows packaging waits for verification and pins every third-party action', () => {
  assert.equal(workflow.jobs['build-windows'].needs, 'verify');
  assert.equal(workflow.jobs['build-windows']['runs-on'], 'windows-2022');
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job['timeout-minutes'] > 0);
    for (const step of job.steps) if (step.uses) {
      assert.match(step.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
      if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
      if (step.uses.startsWith('dtolnay/rust-toolchain@')) assert.equal(step.with.toolchain, 'stable');
    }
  }
});
test('Windows build locks dependencies and fails when installer artifacts are missing', () => {
  const steps = workflow.jobs['build-windows'].steps;
  const build = steps.find(s => s.name === 'Build signed Windows application and NSIS installer');
  assert.match(build.run, /--target x86_64-pc-windows-msvc/); assert.match(build.run, /--bundles nsis/); assert.match(build.run, /-- --locked/);
  const upload = steps.find(s => s.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with['if-no-files-found'], 'error'); assert.equal(upload.with['retention-days'], 30);
  const collect = steps.find(s => s.name.startsWith('Collect executable'));
  assert.match(collect.run, /Get-FileHash/); assert.match(collect.run, /SHA256/);
  assert.match(collect.run, /installers\.Count -ne 1/);
  assert.match(collect.run, /dsh-wsl-desktop_/);
});

test('only successful tag pushes may publish a release with narrowly scoped write permission', () => {
  const job = workflow.jobs['publish-release'];
  assert.equal(job.needs, 'build-windows');
  assert.equal(job.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  assert.deepEqual(job.permissions, { contents: 'write' });
  const validation = workflow.jobs.verify.steps.find(s => s.name === 'Validate release tag against application versions');
  assert.equal(validation.if, job.if); assert.match(validation.run, /release\.mjs validate/);
  const download = job.steps.find(s => s.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, 'dsh-wsl-desktop-windows-x64-${{ github.run_number }}');
  const verify = job.steps.findIndex(s => s.name === 'Verify release files and checksums');
  const publish = job.steps.findIndex(s => s.name.startsWith('Publish complete release'));
  assert.ok(verify >= 0 && verify < publish);
  const run = job.steps[publish].run;
  assert.ok(run.indexOf('gh release upload') < run.indexOf('--draft=false'));
  assert.match(run, /--verify-tag/); assert.match(run, /refusing to overwrite/);
  assert.match(run, /--prerelease=/); assert.match(run, /--latest=/);
});

const trustedTag = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";
test('signing secrets exist only in explicitly trusted tag steps and never in job/global environment', () => {
  assert.ok(!JSON.stringify(workflow.env).includes('TAURI_SIGNING_'));
  const secretSteps = [];
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(!JSON.stringify(job.env ?? {}).includes('secrets.TAURI_SIGNING_'));
    for (const step of job.steps) {
      if (JSON.stringify(step.env ?? {}).includes('secrets.TAURI_SIGNING_')) {
        secretSteps.push(step);
        assert.equal(step.if, trustedTag);
        assert.doesNotMatch(step.run, /Write-(?:Output|Host).*TAURI_SIGNING_|echo.*TAURI_SIGNING_|printenv|Get-ChildItem Env:/);
      }
    }
  }
  assert.equal(secretSteps.length, 2);
  const steps = workflow.jobs['build-windows'].steps;
  const guard = steps.find(s => s.name === 'Require updater signing key for trusted tag build');
  assert.match(guard.run, /IsNullOrWhiteSpace\(\$env:TAURI_SIGNING_PRIVATE_KEY\)/);
  assert.match(guard.run, /throw/);
  assert.ok(steps.indexOf(guard) < steps.findIndex(s => s.name === 'Set up Rust MSVC'));
  assert.equal(guard.env.TAURI_SIGNING_PRIVATE_KEY, '${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}');
  const signed = steps.find(s => s.name === 'Build signed Windows application and NSIS installer');
  assert.equal(signed.if, trustedTag);
  assert.equal(signed.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, '${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}');
  assert.match(signed.run, /--bundles nsis/);
  assert.doesNotMatch(signed.run, /createUpdaterArtifacts.*false|--config/);
});

test('tag-only builds have no unsigned fallback and save caches for trusted tags', () => {
  const builds = workflow.jobs['build-windows'].steps.filter(s => s.run?.includes('npm run desktop:build'));
  assert.equal(builds.length, 1);
  assert.equal(builds[0].if, trustedTag);
  assert.doesNotMatch(raw, /tauri-no-updater|createUpdaterArtifacts/);
  for (const name of ['verify', 'build-windows']) {
    const cache = workflow.jobs[name].steps.find(s => s.uses?.startsWith('Swatinem/rust-cache@'));
    assert.equal(cache.with['save-if'], '${{ ' + trustedTag + ' }}');
  }
});

test('tag artifacts preserve installer signature and prepare manifest before upload', () => {
  const steps = workflow.jobs['build-windows'].steps;
  const collect = steps.find(s => s.name.startsWith('Collect executable'));
  assert.equal(collect.env, undefined);
  assert.doesNotMatch(collect.run, /IS_RELEASE/);
  assert.match(collect.run, /FullName \+ '\.sig'/);
  assert.match(collect.run, /\$installerName \+ '\.sig'/);
  const prepare = steps.find(s => s.name === 'Prepare and verify signed updater release');
  assert.equal(prepare.if, trustedTag);
  assert.match(prepare.run, /node scripts\/release\.mjs prepare artifacts\/windows/);
  assert.match(prepare.run, /LASTEXITCODE/);
  assert.ok(steps.indexOf(collect) < steps.indexOf(prepare));
  assert.ok(steps.indexOf(prepare) < steps.findIndex(s => s.name === 'Upload Windows downloads'));
});

test('publish includes updater signature and manifest, verifies the full asset set, and never marks prereleases latest', () => {
  const job = workflow.jobs['publish-release'];
  const validation = job.steps.find(s => s.name === 'Verify release files and checksums');
  assert.match(validation.run, /release\.mjs verify artifacts\/windows/);
  const run = job.steps.find(s => s.name.startsWith('Publish complete release')).run;
  assert.match(run, /assets=\(artifacts\/windows\/\*\.exe artifacts\/windows\/\*\.exe\.sig artifacts\/windows\/latest\.json artifacts\/windows\/SHA256SUMS\.txt\)/);
  assert.ok(run.indexOf('refusing to overwrite') < run.indexOf('gh release upload'));
  assert.ok(run.indexOf('--draft') < run.indexOf('gh release upload'));
  assert.ok(run.indexOf('gh release upload') < run.indexOf('diff -u'));
  assert.ok(run.indexOf('diff -u') < run.indexOf('--draft=false'));
  assert.match(run, /if \[\[ "\$IS_PRERELEASE" == true \]\]; then latest=false; fi/);
  assert.match(run, /--prerelease="\$IS_PRERELEASE" --latest="\$latest"/);
});
