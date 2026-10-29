#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root; synthetic in-memory fixtures only.

bun - <<'TS'
import { buildClone } from './src/retrospective/retrospective-clone.ts';
import { readBranchLedger, CONTINUITY_OPS_CUSTOM_TYPE } from './src/continuity/continuity-store.ts';
import { createLedger, applyOps } from './src/continuity/continuity-ledger-reducer.ts';
const t='2026-01-01T00:00:00Z';
const entries=[{type:'message',id:'u',parentId:null,timestamp:t,message:{role:'user',content:'Rule: never deploy without approval',timestamp:1}},{type:'custom',id:'ops',parentId:'u',timestamp:t,customType:CONTINUITY_OPS_CUSTOM_TYPE,data:{ops:[{op:{op:'add',kind:'rule',text:'Rule: never deploy without approval'},ctx:{origin:'user',entryId:'u'}}]}},{type:'message',id:'tail',parentId:'ops',timestamp:t,message:{role:'user',content:'Continue implementation',timestamp:2}}];
const snapshot={path:'/synthetic.jsonl',sha256:'a'.repeat(64),header:{type:'session',version:3,id:'source',cwd:'/tmp',timestamp:t},entries,name:'source',safeCuts:new Set([-1,0,1,2]),pendingToolCalls:[]};
const plan={version:1,source:snapshot.path,sourceSha256:snapshot.sha256,nameSuffix:' clone',parentHandoffMode:'digest',recurse:false,descendantPlans:[],groups:[{name:'first',firstEntryId:'u',lastEntryId:'ops',summary:'Completed first phase.',state:'folded',children:[]}]};
const clone=buildClone(snapshot,plan); const byId=new Map(clone.entries.map(e=>[e.id,e])); let at=clone.entries.at(-1), branch=[]; while(at){branch.unshift(at);at=byId.get(at.parentId)};
console.log('clone ledger preservation',JSON.stringify({before:readBranchLedger(entries).ledger.items.map(i=>i.text),after:readBranchLedger(branch).ledger.items.map(i=>i.text),sourceOpsStillArchived:clone.entries.some(e=>e.id==='ops')}));
let l=applyOps(createLedger(),[{op:'add',kind:'decision',text:'Decision: use SQLite'}],{origin:'agent'}).ledger;
l=applyOps(l,[{op:'add',kind:'decision',text:'Decision: use SQLite'}],{origin:'user',entryId:'u'}).ledger;
const archived=applyOps(l,[{op:'archive',id:l.items[0].id}],{origin:'agent'});
console.log('user duplicate authority',JSON.stringify({source:l.items[0].source,agentArchiveApplied:archived.applied.length,status:archived.ledger.items[0].status}));
TS

bun - <<'TS'
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {createNavigatorState} from './src/core/navigator-state.ts';
import {createRequestGuard} from './src/recovery/request-guard.ts';
import {requestAccounting} from './src/core/request-accounting.ts';
const sm=SessionManager.inMemory('/tmp');sm.appendMessage({role:'user',content:'large context '.repeat(10000),timestamp:1});
const state=createNavigatorState();const model={provider:'test',id:'synthetic',contextWindow:10000,maxTokens:1000};const host={sm,model,registry:{},thinking:'off'};let aborted=false;let calls=0;
const guard=createRequestGuard({state,piCompaction:()=>({enabled:false}),foldHostOf:()=>host,captureSystemHead:()=>{},recoverIndependently:async()=>{calls++;return {status:'done',draft:{type:'custom_message',customType:'test-recovery',content:'Reduced but still oversized',display:true,details:{}}}}});
const result=await guard.onContextWithSystem({messages:sm.buildSessionProjection().messages},{sessionManager:sm,model,signal:undefined,abort:()=>{aborted=true}});
console.log(JSON.stringify({calls,aborted,returnedTokens:requestAccounting(sm,result.messages).tokens,window:model.contextWindow}));
TS

bun - <<'TS'
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createNavigatorState} from './src/core/navigator-state.ts';
import {createFoldRuntime} from './src/fold/fold-runtime.ts';
import {recoveryCutOf} from './src/recovery/recovery-cut.ts';
import {fakeRegistry} from './tests/support/model-registry.ts';
import {assistantMessage} from './tests/support/session-messages.ts';
const sm=SessionManager.inMemory('/tmp');
const anchor=sm.appendMessage(assistantMessage([{type:'toolCall',id:'unfinished',name:'bash',arguments:{command:'echo test'}}],'toolUse'));
sm.appendLabelChange(anchor,'anchor:start');
sm.appendMessage(assistantMessage([{type:'text',text:'additional recorded work '.repeat(4000)}],'stop'));
const state=createNavigatorState();const f=fakeRegistry();const runtime=createFoldRuntime({state,minRewindSavingsTokens:4000,writeLabel:(s,id,label)=>{s.appendLabelChange(id,label);return true;}});
const beforeCut=recoveryCutOf(sm);
const result=await runtime.runFold({sm,model:{provider:'test',id:'synthetic',contextWindow:100000,maxTokens:10000},registry:f.registry,thinking:'off',isIdle:()=>true},{sessionId:sm.getSessionId(),origin:'manual',rewindTo:'start',newLabel:'folded',focus:'Summarize the recorded work and continue the remaining implementation.'});
console.log(JSON.stringify({beforeCut,resultStatus:result.status,reason:result.reason,summaryCalls:f.calls.length,afterCut:recoveryCutOf(sm)}));
TS

bun - <<'TS'
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { commitFold } from './src/fold/fold-commit.ts';
import { assistantMessage } from './tests/support/session-messages.ts';
const sm=SessionManager.inMemory('/tmp');
sm.appendModelChange('test','old-model');sm.appendThinkingLevelChange('low');sm.appendMessage({role:'system',content:'Initial system',sections:{policy:'old'},timestamp:1});
const targetId=sm.appendMessage({role:'user',content:'Start',timestamp:2});sm.appendLabelChange(targetId,'anchor:start');
sm.appendModelChange('test','new-model');sm.appendThinkingLevelChange('high');sm.appendMessage({role:'system',content:'',sections:{policy:'new-critical-policy'},timestamp:3});
const foldPointId=sm.appendMessage(assistantMessage([{type:'text',text:'completed work '.repeat(4000)}],'stop'));
const value=()=>{const c=sm.buildSessionContext();return {model:c.model,thinking:c.thinkingLevel,sections:getCurrentSystemMessage(c.messages)?.sections}};
const before=value();
const result=await commitFold(sm,{targetId,rewindTo:'start',newLabel:'folded',summaryText:'## Goal\nWork finished\n## Next Steps\nContinue.',handoffMode:'digest',contextWindow:100000,foldPointId,continuationText:()=> 'Continue',writeLabel:(id,label)=>{sm.appendLabelChange(id,label);return true;}});
console.log(JSON.stringify({ok:result.ok,before,after:value()}));
TS

bun - <<'TS'
import {SessionManager,convertToLlm} from '@earendil-works/pi-coding-agent';
import {buildFoldSegment} from './src/fold/fold-inputs.ts';
const sm=SessionManager.inMemory('/tmp');const anchor=sm.appendMessage({role:'user',content:'start',timestamp:1});
const leaf=sm.appendCustomMessageEntry('extension-result','HIDDEN BUT MODEL-VISIBLE RESULT',false);
console.log(JSON.stringify({wireContainsHidden:JSON.stringify(convertToLlm(sm.buildSessionProjection().messages)).includes('HIDDEN BUT MODEL-VISIBLE RESULT'),summaryRecords:buildFoldSegment(sm.getEntries(),leaf,anchor).records}));
TS
