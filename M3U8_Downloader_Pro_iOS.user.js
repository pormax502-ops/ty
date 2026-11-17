
{`// ==UserScript==
// @name         M3U8 Downloader Pro · iOS Edition
// @namespace    https://local.example/m3u8-pro
// @version      1.0.0
// @description  HLS discovery, parallel segment download, AES-128, task dashboard and file saving.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// ==/UserScript==
(() => {
'use strict';
const APP='m3u8-pro-ios';
const MAX_ITEMS=80;
const settings={concurrency:6,retries:4,timeout:25000,saveAs:true};
const state={streams:new Map(),tasks:new Map(),opened:false,ui:null,active:null};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fmtBytes=n=>!Number.isFinite(n)||n<0?'未知':n<1024?\`\${n} B\`:n<1048576?\`\${(n/1024).toFixed(1)} KB\`:n<1073741824?\`\${(n/1048576).toFixed(1)} MB\`:\`\${(n/1073741824).toFixed(2)} GB\`;
const fmtTime=ms=>!Number.isFinite(ms)?'--':ms<1000?\`\${Math.round(ms)} ms\`:\`\${(ms/1000).toFixed(2)} s\`;
const safeName=s=>(s||'video').replace(/[\\\\/:*?"<>|\\x00-\\x1f]/g,'_').slice(0,110);
const resolve=(u,base)=>new URL(u,base).href;
const isM3U8=u=>/\\.m3u8(?:[?#]|$)/i.test(u||'');
const id=()=>Math.random().toString(36).slice(2,11);
function discover(url,source='network'){
  if(!url||!isM3U8(url))return;
  let absolute;
  try{absolute=resolve(url,location.href);}catch{return;}
  if(state.streams.has(absolute))return;
  state.streams.set(absolute,{url:absolute,source,time:Date.now()});
  if(state.streams.size>MAX_ITEMS)state.streams.delete(state.streams.keys().next().value);
  render();
}
function observePerformance(){
  try{
    for(const e of performance.getEntriesByType('resource'))discover(e.name,'resource');
    const po=new PerformanceObserver(list=>{for(const e of list.getEntries())discover(e.name,'resource');});
    po.observe({type:'resource',buffered:true});
  }catch{}
}
function observeDOM(){
  const scan=()=>{
    document.querySelectorAll('video,source,a[href],iframe[src]').forEach(el=>{
      const u=el.currentSrc||el.src||el.href;
      if(u)discover(u,'dom');
    });
  };
  scan();
  new MutationObserver(scan).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href']});
}
function request(url,{responseType='arraybuffer',headers={},timeout=settings.timeout,signal}={}){
 return new Promise((resolvePromise,reject)=>{
  if(signal?.aborted)return reject(new DOMException('Aborted','AbortError'));
  let settled=false,handle;
  const finish=(error,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);error?reject(error):resolvePromise(value);};
  const abort=()=>{try{handle?.abort();}catch{}finish(new DOMException('Aborted','AbortError'));};
  signal?.addEventListener('abort',abort,{once:true});
  try{handle=GM_xmlhttpRequest({method:'GET',url,headers,responseType,timeout,
    onload:r=>r.status>=200&&r.status<300?finish(null,r):finish(Error(\`HTTP \${r.status}: \${url}\`)),
    onerror:()=>finish(Error(\`网络错误: \${url}\`)),ontimeout:()=>finish(Error(\`请求超时: \${url}\`)),
    onabort:()=>finish(new DOMException('Aborted','AbortError'))
  });}catch(e){finish(e);}
 });
}
async function retry(fn,signal){
 let error;
 for(let attempt=0;attempt<=settings.retries;attempt++){
  if(signal?.aborted)throw new DOMException('Aborted','AbortError');
  try{return await fn(attempt);}catch(e){error=e;if(e.name==='AbortError')throw e;if(attempt<settings.retries)await sleep(Math.min(7000,400*2**attempt+Math.random()*300));}
 }
 throw error;
}
function attr(line){
 const out={};const re=/([A-Z0-9-]+)=("(?:[^"\\\\]|\\\\.)*"|[^,]*)/gi;let m;
 while((m=re.exec(line)))out[m[1].toUpperCase()]=m[2].replace(/^"|"$/g,'');
 return out;
}
function parsePlaylist(text,base){
 const lines=text.replace(/\\r/g,'').split('\\n').map(x=>x.trim());
 const variants=[],segments=[];let pendingVariant=null,duration=0,key=null,map=null,range=null,sequence=0,mediaSequence=0,endlist=false;
 for(const line of lines){
  if(!line)continue;
  if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:')){mediaSequence=Number(line.split(':')[1])||0;sequence=mediaSequence;}
  else if(line.startsWith('#EXT-X-STREAM-INF:'))pendingVariant=attr(line.slice(line.indexOf(':')+1));
  else if(line.startsWith('#EXTINF:'))duration=Number(line.slice(8).split(',')[0])||0;
  else if(line.startsWith('#EXT-X-KEY:')){
   const a=attr(line.slice(line.indexOf(':')+1));
   key=a.METHOD==='NONE'?null:{method:a.METHOD,url:a.URI?resolve(a.URI,base):null,iv:a.IV||null};
  }
  else if(line.startsWith('#EXT-X-MAP:')){
   const a=attr(line.slice(line.indexOf(':')+1));map={url:resolve(a.URI,base),range:a.BYTERANGE||null};
  }
  else if(line.startsWith('#EXT-X-BYTERANGE:'))range=line.split(':')[1];
  else if(line==='#EXT-X-ENDLIST')endlist=true;
  else if(!line.startsWith('#')){
   if(pendingVariant){variants.push({url:resolve(line,base),bandwidth:Number(pendingVariant.BANDWIDTH)||0,resolution:pendingVariant.RESOLUTION||''});pendingVariant=null;}
   else{segments.push({url:resolve(line,base),duration,sequence:sequence++,key:key?{...key}:null,map:map?{...map}:null,range});duration=0;range=null;}
  }
 }
 return {variants,segments,endlist,mediaSequence};
}
async function loadPlaylist(url,signal,depth=0){
 if(depth>5)throw Error('主播放列表嵌套过深');
 const response=await retry(()=>request(url,{responseType:'text',signal}),signal);
 const text=typeof response.response==='string'?response.response:response.responseText;
 if(!text?.includes('#EXTM3U'))throw Error('地址未返回有效的 M3U8 播放列表');
 const data=parsePlaylist(text,url);
 if(data.variants.length){
  const best=data.variants.sort((a,b)=>b.bandwidth-a.bandwidth)[0];
  return loadPlaylist(best.url,signal,depth+1);
 }
 if(!data.segments.length)throw Error('播放列表没有媒体分片');
 if(!data.endlist)throw Error('检测到直播或动态播放列表：此版本仅下载静态 VOD');
 return data;
}
function ivBytes(hex,sequence){
 if(hex){const clean=hex.replace(/^0x/i,'').padStart(32,'0');if(!/^[a-f0-9]{32}$/i.test(clean))throw Error('AES IV 格式无效');return Uint8Array.from(clean.match(/../g).map(x=>parseInt(x,16)));}
 const iv=new Uint8Array(16);new DataView(iv.buffer).setUint32(12,sequence>>>0);return iv;
}
const keyCache=new Map();
async function decrypt(bytes,key,sequence,signal){
 if(!key)return bytes;
 if(key.method!=='AES-128')throw Error(\`不支持的加密方式: \${key.method}（DRM 不支持）\`);
 if(!crypto?.subtle)throw Error('当前环境不支持 WebCrypto AES 解密');
 let promise=keyCache.get(key.url);
 if(!promise){promise=retry(async()=>{
  const r=await request(key.url,{signal});
  if(r.response.byteLength!==16)throw Error('AES-128 密钥长度不正确');
  return crypto.subtle.importKey('raw',r.response,{name:'AES-CBC'},false,['decrypt']);
 },signal);keyCache.set(key.url,promise);}
 let cryptoKey;try{cryptoKey=await promise;}catch(e){keyCache.delete(key.url);throw e;}
 return new Uint8Array(await crypto.subtle.decrypt({name:'AES-CBC',iv:ivBytes(key.iv,sequence)},cryptoKey,bytes));
}
function rangeHeader(spec){
 if(!spec)return null;
 const [length,offset]=spec.split('@').map(Number);
 if(!Number.isFinite(length)||!Number.isFinite(offset))throw Error('不支持隐式偏移 BYTERANGE');
 return \`bytes=\${offset}-\${offset+length-1}\`;
}
async function downloadPiece(segment,signal){
 const started=performance.now();
 const range=rangeHeader(segment.range);
 const r=await retry(()=>request(segment.url,{signal,headers:range?{Range:range}:{}}),signal);
 const data=await decrypt(r.response,segment.key,segment.sequence,signal);
 return {bytes:data,elapsed:performance.now()-started};
}
async function workerPool(items,worker,count,signal){
 let next=0;
 const workers=Array.from({length:Math.min(count,items.length)},async()=>{
  while(next<items.length){
   if(signal.aborted)throw new DOMException('Aborted','AbortError');
   const index=next++;
   await worker(items[index],index);
  }
 });
 await Promise.all(workers);
}
function createTask(url){
 const task={id:id(),url,name:safeName(document.title||'video'),status:'准备中',controller:new AbortController(),total:0,done:0,bytes:0,elapsed:0,started:performance.now(),sizeEstimate:null,error:'',blob:null,failed:0};
 state.tasks.set(task.id,task);state.active=task.id;render();
 runTask(task);return task;
}
async function runTask(task){
 const signal=task.controller.signal;
 try{
  task.status='解析播放列表';render();
  const manifest=await loadPlaylist(task.url,signal);
  if(manifest.segments.some(s=>s.map))throw Error('检测到 fMP4/CMAF 分片：此版本不提供 MP4 封装，请使用 TS 格式的 HLS 源');
  if(manifest.segments.some(s=>s.range&&!s.range.includes('@')))throw Error('检测到隐式 BYTERANGE，当前不支持');
  task.total=manifest.segments.length;task.status='下载中';render();
  const pieces=new Array(task.total);
  await workerPool(manifest.segments,async(segment,index)=>{
   const result=await downloadPiece(segment,signal);
   pieces[index]=result.bytes;
   task.done++;task.bytes+=result.bytes.byteLength;task.elapsed+=result.elapsed;
   task.sizeEstimate=task.done?Math.round(task.bytes/task.done*task.total):null;
   render();
  },settings.concurrency,signal);
  if(signal.aborted)throw new DOMException('Aborted','AbortError');
  task.status='合并文件';render();
  task.blob=new Blob(pieces,{type:'video/mp2t'});
  task.status='已完成';render();
  saveTask(task);
 }catch(e){task.status=e.name==='AbortError'?'已取消':'失败';task.error=e.message||String(e);task.failed++;render();}
}
function saveTask(task){
 if(!task.blob)return;
 const filename=safeName(task.name)+'.ts';
 const url=URL.createObjectURL(task.blob);
 const a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';
 document.documentElement.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function cancelTask(task){task.controller.abort();task.status='已取消';render();}
function removeTask(task){if(!['失败','已取消','已完成'].includes(task.status))return;task.blob=null;state.tasks.delete(task.id);render();}
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=String(text);return node;}
function button(label,action,cls=''){const b=el('button','mp-action '+cls,label);b.type='button';b.addEventListener('click',action);return b;}
function render(){
 if(!state.ui)return;
 const {badge,streams,tasks}=state.ui;
 badge.textContent=String(state.streams.size);
 streams.replaceChildren();
 if(!state.streams.size)streams.appendChild(el('p','mp-empty','尚未发现 M3U8。播放视频后再打开面板，或手动粘贴链接。'));
 for(const stream of [...state.streams.values()].reverse()){
  const row=el('div','mp-stream');const details=el('div','mp-details');
  details.append(el('strong','',stream.url.split('/').pop().split('?')[0]||'playlist.m3u8'),el('small','',stream.url));
  row.append(details,button('下载',()=>createTask(stream.url),'mp-primary'));streams.appendChild(row);
 }
 tasks.replaceChildren();
 if(!state.tasks.size)tasks.appendChild(el('p','mp-empty','暂无下载任务'));
 for(const task of [...state.tasks.values()].reverse()){
  const row=el('div','mp-task');const head=el('div','mp-taskhead');
  head.append(el('strong','',task.name),el('span','mp-status',task.status));row.append(head);
  const progress=el('div','mp-progress');const fill=el('div','mp-fill');fill.style.width=\`\${task.total?task.done/task.total*100:0}%\`;progress.append(fill);row.append(progress);
  const stats=el('div','mp-stats');
  const avg=task.done?task.elapsed/task.done:NaN;
  const eta=task.done?(task.total-task.done)*((performance.now()-task.started)/task.done):NaN;
  stats.textContent=\`\${task.done}/\${task.total} 分片 · \${fmtBytes(task.bytes)} / \${fmtBytes(task.status==='已完成'?task.bytes:task.sizeEstimate)} · 平均分片 \${fmtTime(avg)} · 剩余约 \${fmtTime(eta)}\`;
  row.append(stats);
  if(task.error)row.append(el('p','mp-error',task.error));
  const actions=el('div','mp-taskactions');
  if(['准备中','解析播放列表','下载中','合并文件'].includes(task.status))actions.append(button('取消',()=>cancelTask(task)));
  if(task.blob)actions.append(button('重新保存',()=>saveTask(task),'mp-primary'));
  if(['失败','已取消','已完成'].includes(task.status))actions.append(button('移除',()=>removeTask(task)));
  row.append(actions);tasks.append(row);
 }
}
function mount(){
 if(state.ui||!document.documentElement)return;
 const host=el('div');host.id=APP;document.documentElement.appendChild(host);
 const root=host.attachShadow({mode:'closed'});
 const style=el('style');style.textContent=\`
 :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;color:#1d1d1f}
 *,*:before,*:after{box-sizing:border-box}
 .mp-fab{position:fixed;right:20px;bottom:24px;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:#24b46b;color:white;z-index:2147483646;display:grid;place-items:center;cursor:pointer;box-shadow:0 3px 12px #13975866;transition:transform .18s,background .18s}
 .mp-fab:hover{transform:scale(1.08);background:#1b9d59}.mp-fab svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
 .mp-badge{position:absolute;top:-7px;right:-7px;border-radius:10px;background:#fff;color:#168d50;font-size:9px;font-weight:700;min-width:14px;height:14px;line-height:14px;box-shadow:0 1px 5px #0002}
 .mp-panel{position:fixed;right:20px;bottom:60px;width:min(440px,calc(100vw - 32px));max-height:min(680px,calc(100vh - 88px));overflow:auto;z-index:2147483647;border:1px solid #ffffffa8;border-radius:22px;background:#f8f9fbea;backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);box-shadow:0 20px 70px #0003;color:#202127;font-size:13px;display:none}
 .mp-panel.open{display:block}.mp-header{padding:19px 20px 14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e4e6eb}
 .mp-header strong{font-size:18px;letter-spacing:-.5px}.mp-sub{color:#858b98;font-size:11px;margin-top:4px}.mp-close{background:#e9ebf0;border:0;border-radius:50%;width:26px;height:26px;font-size:18px;color:#7c8490;cursor:pointer}
 .mp-body{padding:15px}.mp-title{font-weight:750;font-size:12px;color:#737b87;letter-spacing:.4px;text-transform:uppercase;margin:6px 0 10px}
 .mp-card{border:1px solid #e8eaf0;border-radius:15px;background:#fff;padding:10px;margin-bottom:14px}
 .mp-stream{display:flex;gap:9px;align-items:center;padding:9px 4px;border-bottom:1px solid #f1f2f4}.mp-stream:last-child{border-bottom:0}
 .mp-details{flex:1;min-width:0}.mp-details strong{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mp-details small{display:block;color:#8a909b;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
 .mp-action{background:#f0f1f5;color:#343945;border:0;border-radius:9px;padding:8px 11px;font-weight:650;font-size:11px;cursor:pointer;white-space:nowrap}.mp-primary{background:#20ad65;color:white}.mp-action:hover{filter:brightness(.96)}
 .mp-inputrow{display:flex;gap:7px}.mp-input{flex:1;min-width:0;border:1px solid #e4e6ec;background:#fff;border-radius:10px;padding:10px;font-size:12px;outline:none;color:#24262a}.mp-input:focus{border-color:#2cbd79}
 .mp-task{padding:11px 3px;border-bottom:1px solid #eff0f3}.mp-task:last-child{border:0}.mp-taskhead{display:flex;justify-content:space-between;gap:8px;align-items:center}.mp-taskhead strong{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mp-status{font-size:10px;color:#1e9b60;white-space:nowrap}
 .mp-progress{height:5px;background:#ecedf1;border-radius:8px;overflow:hidden;margin:10px 0 8px}.mp-fill{height:100%;background:linear-gradient(90deg,#1fae67,#55d999);border-radius:8px;transition:width .25s}.mp-stats{color:#858a95;font-size:10px;line-height:1.6}.mp-taskactions{display:flex;gap:6px;margin-top:9px}.mp-error{color:#d74c4c;font-size:11px;overflow-wrap:anywhere}.mp-empty{color:#959ba5;text-align:center;padding:14px 4px;font-size:12px}.mp-foot{font-size:10px;color:#9298a2;line-height:1.6;margin-top:6px}
 @media(prefers-color-scheme:dark){.mp-panel{background:#202126ed;color:#f2f3f5;border-color:#444}.mp-header{border-color:#444}.mp-card{background:#2c2e34;border-color:#41434a}.mp-input{background:#25272d;color:#fff;border-color:#4a4d55}.mp-stream,.mp-task{border-color:#404249}.mp-action{background:#484b54;color:#fff}.mp-primary{background:#20ad65}.mp-progress{background:#474951}}
 \`;
 const fab=el('button','mp-fab');fab.type='button';fab.title='M3U8 下载器';fab.setAttribute('aria-label','打开 M3U8 下载器');
 fab.innerHTML='<svg viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M5 17v3h14v-3"/></svg>';
 const badge=el('span','mp-badge','0');fab.append(badge);
 const panel=el('section','mp-panel');const header=el('div','mp-header');const brand=el('div');brand.append(el('strong','','M3U8 Downloader Pro'),el('div','mp-sub','iOS Edition · HLS Download Manager'));
 const close=el('button','mp-close','×');close.addEventListener('click',()=>{state.opened=false;panel.classList.remove('open');});header.append(brand,close);
 const body=el('div','mp-body');body.append(el('div','mp-title','手动添加链接'));
 const inputrow=el('div','mp-inputrow');const input=el('input','mp-input');input.placeholder='https://example.com/master.m3u8';input.type='url';
 inputrow.append(input,button('添加',()=>{try{const u=new URL(input.value.trim());if(!isM3U8(u.href))throw Error('请输入 M3U8 链接');discover(u.href,'manual');input.value='';}catch(e){alert(e.message);}},'mp-primary'));
 body.append(inputrow,el('div','mp-title','发现的播放列表'));
 const streams=el('div','mp-card');body.append(streams,el('div','mp-title','下载任务'));
 const tasks=el('div','mp-card');body.append(tasks,el('p','mp-foot','仅支持未受 DRM 保护的静态 HLS TS 视频。文件大小为分片累计估算；浏览器可能限制单文件内存占用。保存位置由浏览器下载设置决定。'));
 panel.append(header,body);root.append(style,fab,panel);
 fab.addEventListener('click',()=>{state.opened=!state.opened;panel.classList.toggle('open',state.opened);render();});
 state.ui={badge,streams,tasks};render();
}
function boot(){mount();observePerformance();observeDOM();}
if(document.documentElement)boot();else new MutationObserver((obs)=>{if(document.documentElement){obs.disconnect();boot();}}).observe(document,{childList:true});
})();`}
