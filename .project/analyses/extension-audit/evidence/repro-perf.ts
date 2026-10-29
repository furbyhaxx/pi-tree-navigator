import {SessionManager} from '../../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {collectActiveAnchors} from '../../../../src/core/anchors.ts';
import {buildContextMessages} from '../../../../src/core/projection.ts';
import {installHandoffProjection,resetHandoffProjection} from '../../../../src/fold/handoff-projection.ts';
import {estimateContextTokens} from '../../../../src/core/context-tokens.ts';
function measure(f:()=>unknown, n=5){f(); const times=[];for(let i=0;i<n;i++){const t=performance.now();f();times.push(performance.now()-t);}return times.sort((a,b)=>a-b)[Math.floor(n/2)]?.toFixed(2);}
for(const count of [500,1000,2000,4000]){
 const sm=SessionManager.inMemory();
 for(let i=0;i<count;i++){const id=sm.appendMessage({role:'user',content:'synthetic benchmark text '.repeat(20),timestamp:i});if(i%10===0)sm.appendLabelChange(id,`anchor:stage-${i}`);}
 const restore=installHandoffProjection();
 console.log(JSON.stringify({messages:count,anchors:count/10,projectionMedianMs:measure(()=>buildContextMessages(sm)),anchorListingMedianMs:measure(()=>collectActiveAnchors(sm))}));restore();
}
resetHandoffProjection();
const sm=SessionManager.inMemory();
const id=sm.appendMessage({role:'assistant',content:[{type:'text',text:'retained'}],api:'fixture',provider:'fixture',model:'fixture',stopReason:'stop',usage:{input:100000,output:10,cacheRead:0,cacheWrite:0,totalTokens:100010,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:1});
sm.appendCustomEntry('tree-clone-provenance',{history:{sourceOrder:[id]}});
const stopA=installHandoffProjection(); const stopB=installHandoffProjection();
console.log(JSON.stringify({scenario:'two active installations',tokens:estimateContextTokens(sm.buildSessionContext().messages)}));
stopB();
console.log(JSON.stringify({scenario:'B shutdown, A still active',tokens:estimateContextTokens(sm.buildSessionContext().messages)}));
stopA();
