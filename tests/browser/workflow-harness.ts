/** Real production HTML/assets and workflow stores; Git index and native dialogs are controlled fixtures. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { DraftPair } from '../../src/draft';
import { ReviewStore, PresetStore, exportReviewMarkdown } from '../../src/review';
import { analyzeImpact } from '../../src/impact';
import { validateMessage, matchesDraftTarget } from '../../src/messages';

const root=resolve(import.meta.dirname,'../..');
const compiled=await build({entryPoints:[resolve(root,'src/webview.ts')],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'vscode-stub',setup(b){b.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'qa'}));b.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:'exports.Uri={joinPath:(_base,...parts)=>({toString:()=>"/"+parts.join("/")})}',loader:'js'}));}}]});
const module={exports:{} as any};new Function('module','exports','require',compiled.outputFiles[0].text)(module,module.exports,createRequire(import.meta.url));
const html=module.exports.html;
const tail=Array.from({length:75},(_,i)=>`// common context ${i+1}\n`).join('');
const definitions=[
 {status:'M',oldPath:'src/example.ts',newPath:'src/example.ts',additions:3,deletions:3,left:`export function greet() {\n  return "before";\n}\n${tail}export const amount = () => 1;\n\nconst whitespace = true;\n`,right:`export function greet() {\n  return "after";\n}\n${tail}export const amount = () => 2;\n\nconst whitespace = true;   \n`},
 {status:'M',oldPath:'docs/review.md',newPath:'docs/review.md',additions:1,deletions:1,left:'# Before\n',right:'# After\n'},
 {status:'M',oldPath:'src/committed.ts',newPath:'src/committed.ts',additions:1,deletions:1,left:'export const committed = false;\n',right:'export const committed = true;\n'},
 {status:'M',oldPath:'assets/image.png',newPath:'assets/image.png',additions:null,deletions:null,left:'',right:'',unsupported:'Binary files cannot be edited as text.'},
];
const tests=[{path:'tests/example.test.ts',text:'import { greet } from "../src/example";\n'},{path:'tests/consumer.spec.ts',text:'import { amount } from "../src/example";\n'}];
const content=(path:string,text:string)=>({path,text,exists:true,mode:'100644'});
let active=0,sessionId='workflow-qa',indexRevision=0,staged=false,indexScenario='',lastOpened='',markdown='';
let reviews=new ReviewStore(),presets=new PresetStore();
let settings={left:'feature/reference',right:'feature/current',includeUpstream:false,highlight:true,flat:false,focusMode:false,ignoreWhitespace:false,filter:''};
let pairs=definitions.map(f=>new DraftPair(content(f.oldPath,f.left),content(f.newPath,f.right)));
const snapshot=(index=active)=>({...pairs[index].current,hunks:pairs[index].hunks()});
function review(index=active){const result=reviews.inspect(definitions[index].newPath,snapshot(index));result.filesReviewed=definitions.filter((_,i)=>reviews.inspect(definitions[i].newPath,snapshot(i)).reviewed).length;result.totalFiles=definitions.length;return result;}
const indexToken=()=>createHash('sha256').update(`index-token-${indexRevision}`).digest('hex');
const staging=()=>active===3?undefined:{token:indexToken(),bufferUnsaved:pairs[active].dirty('right'),error:indexScenario==='error'?'Index lock is held by another process.':undefined,unstaged:active===2||staged?[]:[{index:17,summary:'Working → index · section 18',preview:'- index text\n+ working unsaved text'}],staged:active===2||!staged?[]:[{index:29,summary:'Index → HEAD · section 30',preview:'- HEAD text\n+ staged working text'}]};
const file=()=>({type:'file',sessionId,fileKey:definitions[active].newPath,index:active,total:definitions.length,path:definitions[active].newPath,...pairs[active].current,leftLabel:'Merge base · feature/reference',rightLabel:'feature/current',rightWorkingTree:true,leftDirty:pairs[active].dirty('left'),rightUnsaved:pairs[active].dirty('right'),version:pairs[active].version,hunks:pairs[active].hunks(),dirty:pairs[active].dirty(),unsupported:definitions[active].unsupported,highlight:settings.highlight,focusMode:settings.focusMode,ignoreWhitespace:settings.ignoreWhitespace,review:review(),staging:staging(),impact:active===3?undefined:analyzeImpact(definitions[active].newPath,pairs[active].current.left.text,pairs[active].current.right.text,pairs[active].hunks(),tests)});
const sidebar=()=>({type:'state',root:'/fixtures/branchweave',repos:['/fixtures/branchweave'],currentBranch:'feature/current',settings,session:{id:sessionId},active,files:definitions,presets:presets.list(),reviewedFiles:definitions.flatMap((_,i)=>review(i).reviewed?[i]:[]),reviewProgress:{reviewed:review().filesReviewed,total:definitions.length}});
const mutations=['reviewFile','reviewHunk','addNote','deleteNote','stageHunk','unstageHunk','exportReview'];
function message(m:any,kind:string):any[]{
 if(!validateMessage(m))throw Error('Invalid webview message.');
 const p=pairs[active];
 if(m.type==='draft'){
  if(!matchesDraftTarget(m,sessionId,active,p.version,definitions[active].newPath))throw Error('The draft changed. Retry using the updated comparison.');
  if(m.action==='edit'){p.setText(m.side,m.text,m.version);indexRevision++;return [{...file(),type:'edited'}];}
  if(m.action==='undo')p.undo();if(m.action==='redo')p.redo();
 }else if(m.type==='action'){
  if(mutations.includes(m.action)&&!matchesDraftTarget(m,sessionId,active,p.version,definitions[active].newPath))throw Error('The selected file changed.');
  if(m.action==='open')active=m.value;
  if(m.action==='nextFile')active=(active+1)%definitions.length;
  if(m.action==='previousFile')active=(active+definitions.length-1)%definitions.length;
  if(m.action==='reviewFile')reviews.markFile(definitions[active].newPath,snapshot(),m.value??!review().reviewed);
  if(m.action==='reviewHunk')reviews.markHunk(definitions[active].newPath,snapshot(),m.value.index,m.value.reviewed);
  if(m.action==='addNote')reviews.addNote(definitions[active].newPath,snapshot(),m.value.text,m.value.hunk);
  if(m.action==='deleteNote')reviews.deleteNote(definitions[active].newPath,m.value);
  if(m.action==='exportReview'){markdown=exportReviewMarkdown({reference:settings.left,current:settings.right,files:definitions.map((f,i)=>({path:f.newPath,review:review(i)}))});return [file(),{type:'error',message:'QA native-host boundary: Markdown report created in harness memory.'}];}
  if(m.action==='nextUnreviewed'){
   for(let offset=0;offset<definitions.length;offset++){
    const index=(active+offset)%definitions.length,r=review(index);if(r.reviewed)continue;
    active=index;const hunk=Array.from({length:r.totalHunks},(_,i)=>i).find(i=>!r.reviewedHunks.includes(i));
    return kind==='editor'?[{...file(),pendingNavigation:{hunk:hunk??0}}]:[sidebar()];
   }
  }
  if(['focusMode','ignoreWhitespace','highlight','flat'].includes(m.action))settings={...settings,[m.action]:m.value??!(settings as any)[m.action]};
  if(m.action==='upstream')settings.includeUpstream=m.value??!settings.includeUpstream;
  if(m.action==='filter')settings.filter=m.value;
  if(m.action==='savePreset')presets.save(m.value,settings);
  if(m.action==='loadPreset'){const preset=presets.list().find(p=>p.id===m.value);if(preset){const {id:_id,name:_name,...saved}=preset;settings={...settings,...saved};}}
  if(m.action==='deletePreset')presets.remove(m.value);
  if(m.action==='refresh'){reviews=new ReviewStore(reviews.serialize());presets=new PresetStore(presets.serialize());}
  if(m.action==='stageHunk'||m.action==='unstageHunk'){
   if(indexScenario==='stale'){indexScenario='';indexRevision++;return [file(),{type:'error',message:'Index changed. Refresh and retry the selected section.'}];}
   if(m.value.token!==indexToken()||m.value.index!==(m.action==='stageHunk'?17:29))throw Error('Invalid independent index selection.');
   staged=m.action==='stageHunk';indexRevision++;
  }
  if(m.action==='openRelatedTest'){if(!tests.some(t=>t.path===m.value))throw Error('Unknown test');lastOpened=m.value;}
 }
 return [kind==='editor'?file():sidebar()];
}
const server=createServer(async(req,res)=>{try{
 const u=new URL(req.url!,'http://127.0.0.1');
 if(u.pathname==='/message'){
  let body='';for await(const chunk of req)body+=chunk;let output;
  try{output=message(JSON.parse(body),u.searchParams.get('kind')||'editor');}catch(e){output=[{type:'error',message:(e as Error).message}];}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(output));return;
 }
 if(u.pathname==='/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({active,settings,lastOpened,markdown,staging:staging(),review:review(),presets:presets.list(),drafts:pairs.map(p=>p.current)}));return;}
 if(u.pathname.startsWith('/dist/')){const target=resolve(root,'.'+u.pathname);if(!target.startsWith(resolve(root,'dist')+'\\'))throw Error('Invalid asset');res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.ttf':'font/ttf'} as any)[extname(target)]||'application/octet-stream');res.end(await readFile(target));return;}
 const kind=['editor','compare','files'].includes(u.pathname.slice(1))?u.pathname.slice(1):'editor';
 if(u.searchParams.has('fresh')){active=0;sessionId='workflow-qa-'+Date.now();reviews=new ReviewStore();presets=new PresetStore();indexRevision=0;staged=false;indexScenario='';lastOpened='';markdown='';settings={left:'feature/reference',right:'feature/current',includeUpstream:false,highlight:true,flat:false,focusMode:false,ignoreWhitespace:false,filter:''};pairs=definitions.map(f=>new DraftPair(content(f.oldPath,f.left),content(f.newPath,f.right)));}
 if(u.searchParams.has('fixture'))active=Number(u.searchParams.get('fixture'))||0;
 if(u.searchParams.has('scenario'))indexScenario=u.searchParams.get('scenario')||'';
 let source=html({cspSource:"'self'",asWebviewUri:(x:any)=>x},{},kind);const nonce=source.match(/nonce-([^']+)/)![1];
 const bridge=`<script nonce="${nonce}">let queue=Promise.resolve();window.__qaMessages=[];window.acquireVsCodeApi=()=>({postMessage(m){window.__qaMessages.push(m);queue=queue.then(()=>fetch('/message?kind=${kind}',{method:'POST',body:JSON.stringify(m)})).then(r=>r.json()).then(messages=>messages.forEach(data=>window.postMessage(data,location.origin))).catch(console.error);}});</script>`;
 source=source.replace("default-src 'none';","default-src 'none'; connect-src 'self';").replace('<body ','<body class="vscode-dark" ').replace(/<script nonce=/,bridge+'<script nonce=');
 res.setHeader('content-type','text/html');res.end(source);
 }catch(e){res.statusCode=500;res.end(String(e));}});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,url:`http://127.0.0.1:${(server.address() as any).port}`,startedAt:new Date().toISOString()})));
