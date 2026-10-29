import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETTINGS } from '../../../../src/ui/settings-screen-catalog.ts';
import { ITEMS, entrySettings, entryItems, overrideTools, toolDef } from '../../../../src/ui/settings-screen-maps.ts';
import { resolve, resolveDef } from '../../../../src/ui/settings-screen-layers.ts';
import { resolveAutoNavigateConfig, resolveRewindHintReserve } from '../../../../src/core/config.ts';
import { save } from '../../../../src/ui/settings-screen-saving.ts';

console.log(JSON.stringify({scalarDefinitions:SETTINGS.length,topRows:ITEMS.length,perModelScalars:entrySettings('fixture/exact').length,perModelRows:entryItems('fixture/exact').length}));
const paths={global:'/synthetic/tree-navigator.json',project:'/synthetic/project.json',runtime:'runtime'};
const exact='fixture/exact';
for(const [scenario,root] of [
 ['wildcard',{model_overrides:{'fixture/*':{rewindHintReserveTokens:80000,auto_navigate:{check_every_turns:22,tools:{read:'omit'}}},[exact]:{}}}],
 ['explicit-null',{auto_navigate:{milestone:'recommended'},model_overrides:{[exact]:{auto_navigate:{milestone:null}}}}]
]){
 const resolution=await resolve(paths,true,{global:JSON.stringify(root),project:'{}',runtime:'{}'});
 const config=resolution.config;
 const defs=entrySettings(exact);
 const value=suffix=>resolveDef(defs.find(def=>def.key.endsWith(suffix)),resolution);
 const runtime=resolveAutoNavigateConfig(config,exact);
 console.log(JSON.stringify({scenario,rows:{reserve:value('rewindHintReserveTokens'),cadence:value('check_every_turns'),milestone:value('.milestone'),readTool:resolveDef(toolDef(overrideTools(exact),'read'),resolution)},runtime:{reserve:resolveRewindHintReserve(config,exact),cadence:runtime.checkEveryTurns,milestone:runtime.milestonePolicy,tools:runtime.tools}}));
}

const dir=await mkdtemp(join(tmpdir(),'navigator-audit-mode-'));
const oldMask=process.umask(0o022);
try{
 const path=join(dir,'tree-navigator.json');
 await writeFile(path,JSON.stringify({anchorStartAfterTurns:2,syntheticUnknown:'private fixture'}),{mode:0o600});
 const before=(await stat(path)).mode&0o777;
 const def=SETTINGS.find(def=>def.key==='anchorStartAfterTurns');
 const outcome=await save({cwd:dir,sessionManager:{getSessionId:()=>dir},ui:{notify(){},confirm:async()=>true}}, {locations:()=>({agentDir:dir,projectPath:join(dir,'project.json'),projectTrusted:false})}, 'global', new Map([[def.key,{def,edit:{kind:'set',value:3}}]]));
 console.log(JSON.stringify({scenario:'private-file-mode',before:before.toString(8),after:((await stat(path)).mode&0o777).toString(8),outcome}));
}finally{process.umask(oldMask);await rm(dir,{recursive:true,force:true});}
