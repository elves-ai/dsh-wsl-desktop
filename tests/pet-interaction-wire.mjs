// Invoked by the Rust contract test, not by the standalone Node test discovery.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const chunks=[];let length=0;
for await(const chunk of process.stdin){length+=chunk.length;assert.ok(length<=4*1024*1024);chunks.push(chunk);}
const wire=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const source=await readFile(new URL('../src/pet/interactions.ts',import.meta.url),'utf8');
const javascript=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {parsePetInteractionSnapshot}=await import('data:text/javascript;base64,'+Buffer.from(javascript).toString('base64'));
const parsed=parsePetInteractionSnapshot(wire);
assert.ok(parsed,'actual Rust serialization must be accepted by the UI parser');
assert.equal(parsed.revision,43);assert.equal(parsed.connected,true);assert.equal(parsed.items.length,3);
for(const item of parsed.items){assert.equal(item.answerable,true);assert.equal(typeof item.agent_label,'string');}
const question=parsed.items.find(item=>item.id==='event');
assert.equal(question.kind,'questions');assert.ok(question.questions[0].options[0].label.includes('(Recommended)'));
const plan=parsed.items.find(item=>item.id==='plan-event');
assert.equal(plan.questions[0].intent.kind,'plan-review');assert.ok(plan.questions[0].detail.startsWith('# '));
const approval=parsed.items.find(item=>item.id==='approval-event');
assert.equal(approval.kind,'approval');assert.equal(approval.can_allow,true);
assert.ok(approval.details.includes('command'));assert.ok(approval.details.includes('<script>'));
console.log('Rust interaction wire accepted by actual TypeScript parser');
