import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
const raw = readFileSync(new URL('../.github/workflows/windows-build.yml', import.meta.url), 'utf8');
const document = parseDocument(raw, { uniqueKeys: true });
const workflow = document.toJS();

test('CI is valid YAML, defaults to read-only tokens and has explicit triggers', () => {
  assert.equal(document.errors.length, 0);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.on.pull_request.branches, ['main']);
  assert.ok('workflow_dispatch' in workflow.on);
  assert.ok(!('pull_request_target' in workflow.on));
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'publish-release') assert.ok(!job.permissions || job.permissions.contents !== 'write');
  }
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
  const build = steps.find(s => s.name === 'Build Windows application and NSIS installer');
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
