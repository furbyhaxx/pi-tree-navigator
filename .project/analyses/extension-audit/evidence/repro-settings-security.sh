#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. Prototype pollution is confined to its subprocess.
bun - <<'TS'
import {accepts} from './src/ui/settings-screen-editing.ts';
import {entrySettings} from './src/ui/settings-screen-maps.ts';
import {parseTreeNavigatorConfig} from './src/core/config.ts';
const def=entrySettings('__proto__').find(x=>x.key.endsWith('auto_navigate.enabled'));
const before=Object.hasOwn(Object.prototype,'auto_navigate');
const accepted=accepts(def,true);
console.log(JSON.stringify({before,accepted,after:Object.hasOwn(Object.prototype,'auto_navigate'),emptyConfigAuto:parseTreeNavigatorConfig({}).layer.autoNavigate}));
TS

bun - <<'TS'
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {loadTreeNavigatorConfig,resolveAutoNavigateConfig} from './src/core/config.ts';
import {buildAutoMilestoneEvidence} from './src/auto/auto-milestone.ts';
import {assistantMessage} from './tests/support/session-messages.ts';
const sm=SessionManager.inMemory();
sm.appendMessage({role:'user',content:'Synthetic audit fixture',timestamp:1});
sm.appendMessage(assistantMessage([{type:'toolCall',id:'t1',name:'read',arguments:{path:'synthetic.txt'}}],'toolUse'));
const leafId=sm.appendMessage({role:'toolResult',toolCallId:'t1',toolName:'read',content:[{type:'text',text:'SYNTHETIC_RESTRICTED_MARKER'}],isError:false,timestamp:2});
const cases=[
{name:'valid-proposal',global:JSON.stringify({auto_navigate:{enabled:true},treeProposal:{model:'current',tools:{read:'omit'}}}),project:'{}'},
{name:'invalid-proposal',global:JSON.stringify({auto_navigate:{enabled:true},treeProposal:{model:42,tools:{read:'omit'}}}),project:'{}'},
{name:'invalid-base-override',global:JSON.stringify({auto_navigate:{enabled:true,tools:{read:'omti',bash:'omit'}},model_overrides:{'fixture/exact':{auto_navigate:{enabled:true}}}}),project:'{}'},
{name:'malformed-layer',global:'{"treeProposal":{"tools":{"read":"omit"}},',project:JSON.stringify({auto_navigate:{enabled:true}})}
];
for(const item of cases){
 const loaded=await loadTreeNavigatorConfig({agentDir:'/synthetic-agent',projectPath:'/synthetic-project',projectTrusted:true,readFile:async path=>path==='/synthetic-project'?item.project:item.global});
 const resolved=resolveAutoNavigateConfig(loaded.config,'fixture/exact');
 const evidence=buildAutoMilestoneEvidence({entries:sm.getEntries(),leafId,getLabel:id=>sm.getLabel(id),tools:resolved.tools});
 console.log(JSON.stringify({case:item.name,enabled:resolved.enabled,tools:resolved.tools,proposalError:loaded.config.proposalError,warnings:loaded.warnings,syntheticContentInEvidence:JSON.stringify(evidence).includes('SYNTHETIC_RESTRICTED_MARKER')}));
}
TS
