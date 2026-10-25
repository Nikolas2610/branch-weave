/** Local-only rendered-webview QA. Does not emulate VS Code lifecycle or native prompts. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { DraftPair } from '../../src/draft';
import { validateMessage, matchesDraftTarget } from '../../src/messages';

const root=resolve(import.meta.dirname,'../..');
const compiled=await build({entryPoints:[resolve(root,'src/webview.ts')],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'vscode-stub',setup(b){b.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'qa'}));b.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:'exports.Uri={joinPath:(_base,...parts)=>({toString:()=>"/"+parts.join("/")})}',loader:'js'}));}}]});
const module={exports:{} as any};new Function('module','exports','require',compiled.outputFiles[0].text)(module,module.exports,await import('node:module').then(m=>m.createRequire(import.meta.url)));
const html=module.exports.html;
const longTail=Array.from({length:90},(_,i)=>`// shared context ${i+1}\n`).join('');
const content=(path:string,text:string,exists=true)=>({path,text,exists,mode:'100644'});
const definitions=[
 {status:'M',oldPath:'src/example.ts',newPath:'src/example.ts',additions:2,deletions:2,left:`export const value = 1;\nconsole.log("left");\n${longTail}export const end = 10;\n`,right:`export const value = 2;\nconsole.log("right");\n${longTail}export const end = 20;\n`},
 {status:'R',oldPath:'docs/old name.md',newPath:'docs/new name.md',additions:1,deletions:1,left:'# Old title\n',right:'# New title\n'},
 {status:'A',oldPath:'src/added.ts',newPath:'src/added.ts',additions:1,deletions:0,left:'',right:'export const added = true;\n'},
 {status:'D',oldPath:'src/deleted.ts',newPath:'src/deleted.ts',additions:0,deletions:1,left:'export const removed = true;\n',right:''},
 {status:'M',oldPath:'assets/image.png',newPath:'assets/image.png',additions:null,deletions:null,left:'',right:'',unsupported:'Binary files cannot be edited as text.'},
 {status:'M',oldPath:'src/ambiguous.ts',newPath:'src/ambiguous.ts',additions:1,deletions:2,left:'const first = 1;\nconst second = 2;\n',right:'const combined = 3;\n'},
];
let active=0;let includeUpstream=false;let highlight=true;let flat=false;let error='';let id='qa-session';
let pairs=definitions.map(f=>new DraftPair(content(f.oldPath,f.left,f.status!=='A'),content(f.newPath,f.right,f.status!=='D')));
let savedRight=pairs.map(p=>JSON.stringify(p.current.right));
const status=()=>({leftDirty:pairs[active].dirty('left'),rightUnsaved:JSON.stringify(pairs[active].current.right)!==savedRight[active]});
const sidebar=()=>({type:'state',root:'/fixtures/branchlens',repos:['/fixtures/branchlens'],currentBranch:'feature/current',settings:{left:'feature/reference',right:'feature/current',includeUpstream,highlight,flat},session:{id},active,files:definitions,error});
const file=()=>{const f=definitions[active],p=pairs[active];return {type:'file',sessionId:id,index:active,total:definitions.length,path:f.status==='R'?f.oldPath+' → '+f.newPath:f.newPath,...p.current,leftLabel:includeUpstream?'feature/reference · 11111111':'Merge base (feature/reference ↔ feature/current) · 11111111',rightLabel:'feature/current',rightWorkingTree:true,...status(),version:p.version,hunks:p.hunks(),dirty:p.dirty(),unsupported:f.unsupported,highlight};};
function message(m:any,kind:string){
 if(!validateMessage(m))return [{type:'error',message:'Invalid webview message.'}];
 const p=pairs[active];
 if(m.type==='draft'){
  if(!matchesDraftTarget(m,id,active,p.version))throw Error('The draft changed. Retry using the updated comparison.');
  if(definitions[active].unsupported)throw Error('This content cannot be edited.');
  if(m.action==='edit'){p.setText(m.side,m.text,m.version);return [{type:'edited',sessionId:id,index:active,version:p.version,hunks:p.hunks(),dirty:p.dirty(),...status()}];}
  if(m.action==='undo')p.undo();if(m.action==='redo')p.redo();
  if(m.action==='transferLine')p.transferLine(m.side,m.line,m.version);
  if(m.action==='transferHunk')p.transferHunk(m.side,m.hunk,m.version);
 }else if(m.type==='action'){
  if(m.action==='open')active=m.value;
  if(m.action==='nextFile')active=(active+1)%definitions.length;
  if(m.action==='previousFile')active=(active+definitions.length-1)%definitions.length;
  if(m.action==='reset')p.reset(m.value);
  // UI-only simulation: no VS Code TextDocument or disk write occurs in this harness.
  if(m.action==='save'){savedRight[active]=JSON.stringify(p.current.right);return [{type:'globalstatus',sessionId:id,index:active,...status()}];}
  if(m.action==='flat')flat=m.value??!flat;
  if(m.action==='highlight')highlight=m.value??!highlight;
  if(m.action==='upstream'){includeUpstream=m.value??!includeUpstream;error='';}
  if(m.action==='swap')error='QA fixture: branch selection and swap native host handlers are outside this harness.';
  if(['left','right','repository','apply','export','fileOperation'].includes(m.action))error='QA fixture: this action requires native VS Code host UI.';
 }
 return [kind==='editor'?file():sidebar()];
}
const server=createServer(async(req,res)=>{try{
 const u=new URL(req.url!,'http://127.0.0.1');
 if(u.pathname==='/message'){
  let text='';for await(const c of req)text+=c;let output;
  try{output=message(JSON.parse(text),u.searchParams.get('kind')||'editor');}catch(e){output=[{type:'error',message:(e as Error).message}];}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(output));return;
 }
 if(u.pathname==='/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({active,includeUpstream,highlight,flat,drafts:pairs.map(p=>p.current)}));return;}
 if(u.pathname.startsWith('/dist/')){
  const target=resolve(root,'.'+u.pathname);if(!target.startsWith(resolve(root,'dist')+'\\')&&!target.startsWith(resolve(root,'dist')+'/'))throw Error('Invalid asset');
  res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.ttf':'font/ttf'} as any)[extname(target)]||'application/octet-stream');res.end(await readFile(target));return;
 }
 const kind=['editor','compare','files'].includes(u.pathname.slice(1))?u.pathname.slice(1):'editor';
 if(u.searchParams.has('fixture')){
  active=Number(u.searchParams.get('fixture'))||0;
  if(u.searchParams.has('fresh')){id='qa-session-'+Date.now();pairs=definitions.map(f=>new DraftPair(content(f.oldPath,f.left,f.status!=='A'),content(f.newPath,f.right,f.status!=='D')));savedRight=pairs.map(p=>JSON.stringify(p.current.right));error='';highlight=true;includeUpstream=false;}
  if(u.searchParams.get('error')==='1')error='No common ancestor. Use direct comparison to compare unrelated histories.';
 }
 let source=html({cspSource:"'self'",asWebviewUri:(x:any)=>x},{},kind);
 const nonce=source.match(/nonce-([^']+)/)![1];
 const bridge=`<script nonce="${nonce}">let queue=Promise.resolve();window.__qaMessages=[];const log=document.createElement('pre');log.id='qa-protocol';log.hidden=true;document.body.append(log);window.acquireVsCodeApi=()=>({postMessage(m){window.__qaMessages.push(m);log.textContent=JSON.stringify(window.__qaMessages);queue=queue.then(()=>fetch('/message?kind=${kind}',{method:'POST',body:JSON.stringify(m)})).then(r=>r.json()).then(messages=>messages.forEach(data=>window.postMessage(data,location.origin))).catch(e=>console.error(e));}});</script>`;
 const rgbaStyle=u.searchParams.has('rgba')?' style="--vscode-diffEditor-insertedTextBackground:rgba(155,185,85,0.2);--vscode-diffEditor-removedTextBackground:rgba(255,0,0,0.2);--vscode-diffEditor-insertedLineBackground:rgba(155,185,85,0.13);--vscode-diffEditor-removedLineBackground:rgba(255,0,0,0.13)"':'';
 source=source.replace("default-src 'none';","default-src 'none'; connect-src 'self';").replace('<body ',`<body class="vscode-dark"${rgbaStyle} `).replace(/<script nonce=/,bridge+'<script nonce=');
 res.setHeader('content-type','text/html');res.end(source);
 }catch(e){res.statusCode=500;res.end(String(e));}});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,url:`http://127.0.0.1:${(server.address() as any).port}`,startedAt:new Date().toISOString()})));
