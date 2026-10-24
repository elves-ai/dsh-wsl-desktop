import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => path && existsSync(path));

test('real browser keeps speech above, input below and controls inside either edge without scaling the stage', { skip: chrome ? false : 'Chrome/Chromium not installed', timeout: 30000 }, async () => {
  const source = await readFile(new URL('../src/assistant.ts', import.meta.url), 'utf8');
  const root = {};
  // Use the actual pet host markup, not a second hand-maintained copy.
  vm.runInNewContext(source.slice(source.indexOf('const face ='), source.indexOf('function el<')), {root, view:'pet'});
  const css = (await Promise.all(['assistant.css','pet/notifications.css','pet/interactions.css'].map(file => readFile(new URL('../src/' + file, import.meta.url), 'utf8')))).join('\n');
  const placementSources = await Promise.all(['bubble-layout.ts','bubble-positioner.ts'].map(file => readFile(new URL('../src/pet/' + file, import.meta.url), 'utf8')));
  const placementScript = placementSources.map(source => ts.transpileModule(source.replace(/^import .*;$/gm, '').replace(/^export /gm, ''), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText).join('\n');
  const html = '<!doctype html><meta charset="utf-8"><style>' + css + '</style><body data-view="pet"><main id="assistant-root" style="width:360px;height:320px">' + root.innerHTML + '</main><pre id="result"></pre><script>' + placementScript + '</script><script>(' + (() => {
      const failures = [];
      const root = document.getElementById('assistant-root');
      const stage = document.querySelector('.pet-stage');
      const pet = document.getElementById('pet');
      pet.style.cssText = 'left:31.25%;top:13.8889%;width:37.5%;height:79.1667%';
      if (document.getElementById('pet-status')) failures.push(['pet head status remains']);
      document.getElementById('notice').textContent = '移动失败后仍可打开设置';
      document.getElementById('pet-topmost').textContent = '窗口置顶：已开启';
      const bubble = document.getElementById('pet-bubble');
      bubble.className = 'pet-notifications';
      bubble.innerHTML = '<button class="pet-notification-open"><span class="pet-notification-title">完成通知</span><span class="pet-notification-body">任务已经完成，可打开查看</span></button><button class="pet-notification-close">×</button>';
      const interaction = document.getElementById('pet-interaction');
      interaction.className = 'pet-interactions';
      interaction.innerHTML = '<section class="pet-interactions-panel"><header class="pet-interactions-header"><div class="pet-interactions-heading">需要确认操作</div><button class="pet-interactions-close">×</button></header><div class="pet-interactions-content"><div class="pet-interactions-scroll"><textarea class="pet-interactions-custom">补充说明</textarea></div><footer class="pet-interactions-actions"><button>允许一次</button><button>拒绝</button><button>在 DSH 打开</button></footer></div></section>';
      if (root.querySelector('.pet-tools, .pet-attribution')) failures.push(['bottom chrome remains']);
      const originalStage = stage.getBoundingClientRect();
      const originalPet = pet.getBoundingClientRect();
      const cases = [[0,0],[112,0],[0,112],[112.5,0],[0,112.5],[0,0]];
      for (const [left,right] of cases) {
        root.style.setProperty('--pet-visible-left', left + 'px');
        root.style.setProperty('--pet-visible-right', right + 'px');
        for (const panel of ['none','pet-menu','pet-bubble','pet-interaction','notice','pet-composer']) {
          for (const id of ['pet-menu','pet-bubble','pet-interaction','notice','pet-composer']) document.getElementById(id).hidden = id !== panel;
          document.getElementById('pet-dialogue').hidden = panel !== 'pet-composer';
          document.getElementById('pet-speech').hidden = false;
          document.getElementById('pet-speech-text').textContent = '我在呢，想说些什么？';
          document.getElementById('pet-enable').hidden = true;
          layoutPetBubbles(root,pet,{left,right});
          if (panel === 'pet-composer') {
            const input=document.getElementById('pet-composer').getBoundingClientRect();
            const character=pet.getBoundingClientRect();
            const speech=document.getElementById('pet-dialogue').getBoundingClientRect();
            if(input.top < character.bottom + 4 || input.bottom > 320) failures.push(['input not below pet',left,right,input.top,character.bottom,input.bottom]);
            if(speech.bottom > character.top + .1) failures.push(['speech not above head',left,right,speech.bottom,character.top]);
            if(document.getElementById('pet-dialogue').contains(document.getElementById('pet-composer'))) failures.push(['input still grouped with speech']);
          }
          const selectors = ' .pet-credit, .asset-license, #pet-menu, #pet-menu button, #pet-menu select, #notice, #pet-bubble, #pet-bubble button, #pet-interaction, #pet-interaction button, #pet-interaction textarea, #pet-composer, #pet-composer textarea, #pet-composer button, #pet-dialogue';
          for (const node of root.querySelectorAll(selectors)) {
            if (!node.getClientRects().length) continue;
            const rect = node.getBoundingClientRect();
            if (rect.left < left - .1 || rect.right > 360 - right + .1 || rect.width <= 0) failures.push([left,right,panel,node.className || node.id,rect.left,rect.right]);
          }
          for (const [node,original] of [[stage,originalStage],[pet,originalPet]]) {
            const rect = node.getBoundingClientRect();
            if (rect.x !== original.x || rect.width !== original.width || rect.height !== original.height) failures.push(['stage/pet changed',left,right]);
          }
          // Native hit reporting reads these same post-layout bounding boxes.
          if (panel === 'pet-menu') { const menu = document.getElementById('pet-menu').getBoundingClientRect(); if (menu.width > 180 || menu.height > 300) failures.push(['menu too large',menu.width,menu.height]); }
          const tools = panel === 'pet-menu' ? [...document.querySelectorAll('#pet-menu button')] : [];
          for (const button of tools) {
            const rect = button.getBoundingClientRect();
            if (!button.contains(document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2))) failures.push(['tool hit miss',left,right,panel,button.textContent]);
          }
        }
      }
      document.getElementById('result').textContent = JSON.stringify(failures);
    }).toString() + ')();</script>';
  const temp = await mkdtemp(join(tmpdir(), 'dsh-pet-overlay-'));
  try {
    const file = join(temp, 'layout.html'); await writeFile(file, html);
    const {stdout} = await promisify(execFile)(chrome, ['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--dump-dom','file://' + file], {timeout:20000,maxBuffer:1024*1024});
    const result = stdout.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];
    assert.ok(result, 'browser did not finish layout assertions');
    assert.deepEqual(JSON.parse(result.replaceAll('&quot;','"').replaceAll('&amp;','&')), []);
  } finally {
    if (!temp.startsWith(join(tmpdir(), 'dsh-pet-overlay-'))) throw new Error('Unexpected test temporary path');
    await rm(temp, {recursive:true,force:true});
  }
});
