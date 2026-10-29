import { SessionManager } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { commitFold } from "../../../../src/fold/fold-commit.ts";
import { assistantMessage } from "../../../../tests/support/session-messages.ts";
import { createNavigatorState } from "../../../../src/core/navigator-state.ts";
import { createIndependentRecoveryController } from "../../../../src/recovery/independent-recovery.ts";

const sm = SessionManager.inMemory("/tmp");
const user = sm.appendMessage({role:"user", content:"OMITTED_SYNTHETIC_MARKER", timestamp:1});
const targetId = sm.appendMessage({role:"user", content:"Start", timestamp:2});
sm.appendLabelChange(targetId, "anchor:start");
sm.appendContextEdit(user, null);
const foldPointId = sm.appendMessage(assistantMessage([{type:"text", text:"Completed synthetic work ".repeat(4000)}], "stop"));
const visible = () => JSON.stringify(sm.buildSessionProjection().messages).includes("OMITTED_SYNTHETIC_MARKER");
const before = visible();
const result = await commitFold(sm, {targetId, rewindTo:"start", newLabel:"folded", summaryText:"## Goal\nWork finished\n## Next Steps\nContinue.", handoffMode:"digest", contextWindow:100000, foldPointId, continuationText:()=>"Continue", writeLabel:(id,label)=>{sm.appendLabelChange(id,label);return true;}});
console.log(JSON.stringify({ok:result.ok, omittedMessageVisibleBefore:before, omittedMessageVisibleAfter:visible()}));

const locked = SessionManager.inMemory("/tmp");
locked.appendMessage({role:"user",content:"Synthetic request", timestamp:1});
locked.appendMessage(assistantMessage([{type:"text", text:"Completed synthetic work ".repeat(4000)}],"stop"));
const state = createNavigatorState();
state.folds.runningFolds.add(locked.getSessionId());
const model = {provider:"test", id:"synthetic",contextWindow:10000,maxTokens:1000};
let pressureCalled = false;
const recovery = createIndependentRecoveryController({state, runFold:async()=>{throw new Error("No anchor should be available");},compactUnderPressure:async()=>{pressureCalled=true;return {kind:"skip",reason:"Synthetic fixture stopped before mutation"};}});
const outcome = await recovery.recoverIndependently({sessionManager:locked,model,signal:undefined}, {sm:locked,model,registry:{},thinking:"off"}, undefined);
console.log(JSON.stringify({locked:state.folds.runningFolds.has(locked.getSessionId()),pressureCalled,outcome}));
