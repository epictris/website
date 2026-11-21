// Bounded, local-only capture of the comparison through the real game renderer.
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {findChromium,holdProcessGroup} from '../../../src/tools/shotRunner';

const output = resolve(process.argv[2] ?? '/tmp/river-lod-comparison');
const baseline = process.argv.includes('--baseline');
const diagnose = process.argv.includes('--diagnose');
const production = process.argv.includes('--production');
const roof = process.argv.includes('--roof');
const probes = process.argv.filter(a=>a.startsWith('--probe=')).map(a=>a.slice(8).split(',').map(Number));
if (probes.some(p=>p.length!==2 || p.some(n=>!Number.isFinite(n)))) throw new Error('Use --probe=x,y in capture pixels');
const assets = process.argv.find(a=>a.startsWith('--assets='))?.slice('--assets='.length)
  ?? (roof?'/generated/lod-roof':production?'/generated/lod-production':null);
mkdirSync(output,{recursive:true});
const root = resolve(import.meta.dirname,'../../..');
const profile = mkdtempSync(join(tmpdir(),'river-lod-chrome-'));
const children: {pid:number;release:()=>void}[] = [];
const logs: unknown[] = [];
let launchError: string | null = null;
const deadline = Date.now()+120000;
const sleep = (n:number) => new Promise(r=>setTimeout(r,n));
const start = (cmd:string,args:string[],env=process.env) => {
  const child = spawn(cmd,args,{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env});
  if (!child.pid) throw new Error(`Could not launch ${cmd}`);
  children.push({pid:child.pid,release:holdProcessGroup(child.pid)});
  child.stderr?.on('data',b=>logs.push({process:cmd,stderr:String(b)}));
  child.stdout?.on('data',b=>logs.push({process:cmd,stdout:String(b)}));
  child.on('exit',code=>{if(code)launchError=`${cmd} exited with code ${code}`;});
  return child;
};
let socket: WebSocket | null = null;
try {
  start('bun',['run','dev','--host','127.0.0.1','--port','5193','--strictPort']);
  while (true) {
    if (launchError) throw new Error(launchError);
    try {if ((await fetch('http://127.0.0.1:5193/tools/blender/lod_prototype/viewer.html')).ok) break;} catch {}
    if (Date.now()>deadline) throw new Error('Preview server did not start');
    await sleep(200);
  }
  const env = {...process.env}; delete env.DISPLAY;delete env.WAYLAND_DISPLAY;
  start(findChromium()!,['--headless','--ozone-platform=headless','--remote-debugging-port=0',`--user-data-dir=${profile}`,
    '--no-first-run','--no-default-browser-check','--disable-extensions','--hide-scrollbars',
    '--use-gl=angle','--use-angle=gl-egl','about:blank'],env);
  const active=join(profile,'DevToolsActivePort');
  while (!existsSync(active)) {if(launchError)throw new Error(launchError);if(Date.now()>deadline) throw new Error('Chromium did not start');await sleep(100);}
  const port=readFileSync(active,'utf8').split('\n')[0];
  const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise<void>((done,reject)=>{socket!.onopen=()=>done();socket!.onerror=()=>reject(new Error('CDP connection failed'));});
  let id=0;
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  socket.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(new Error(JSON.stringify(m.error))):p?.resolve(m.result);}else if(m.method==='Runtime.consoleAPICalled'||m.method==='Runtime.exceptionThrown')logs.push(m);};
  const send=(method:string,params={})=>new Promise<any>((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket!.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async(expression:string)=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
  await send('Runtime.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`http://127.0.0.1:5193/tools/blender/lod_prototype/viewer.html?capture=1${baseline?'&baseline=1':''}${diagnose?'&diagnose=1':''}${roof?'&roof=1':''}${assets?'&assets='+encodeURIComponent(assets):''}`});
  while (!await evaluate('window.shotReady === true')) {
    if(logs.some((x:any)=>x.method==='Runtime.exceptionThrown')) throw new Error('Page exception; see console.json');
    if(Date.now()>deadline) throw new Error('Game preview did not become ready');
    await sleep(250);
  }
  const inspection=await evaluate(`(() => {const p=window.lodPreview;const m=p.target;const c=p.scene.camera;return {report:p.report,views:p.views,
    target:{name:m.name,matrix:m.matrix.toArray(),matrixWorld:m.matrixWorld.toArray(),attributes:Object.fromEntries(Object.entries(m.geometry.attributes).map(([k,a])=>[k,{count:a.count,size:a.itemSize,normalized:a.normalized}]))},
    camera:{position:c.position.toArray(),fov:c.fov},ready:p.ready};})()`);
  writeFileSync(join(output,'inspection.json'),JSON.stringify(inspection,null,2));
  for(const view of diagnose?['opening']:Object.keys(inspection.views)) {
    for(const mode of baseline?['original']:diagnose?['original','adaptive','colourOnly','normalOnly','noNormal','plain','noShadow','normals']:['original','adaptive','geometry','bands']) {
      const png=await evaluate(`window.lodPreview.draw('${mode}','${view}')`);
      writeFileSync(join(output,`${view}-${mode}.png`),Buffer.from(png.split(',')[1],'base64'));
      console.log(`Captured ${view} / ${mode}`);
    }
  }
  if (probes.length) {
    const rays=await evaluate(`${JSON.stringify(probes)}.map(([x,y])=>({pixel:[x,y],hits:window.lodPreview.pick(x,y)}))`);
    writeFileSync(join(output,'rays.json'),JSON.stringify(rays,null,2));
  }
  // Repeat one reference so changing procedural lights cannot masquerade as LOD.
  const repeat=await evaluate("window.lodPreview.draw('original','opening')");
  writeFileSync(join(output,'opening-original-repeat.png'),Buffer.from(repeat.split(',')[1],'base64'));
  if(logs.some((x:any)=>x.method==='Runtime.exceptionThrown'||(x.method==='Runtime.consoleAPICalled'&&x.params.type==='error')))throw new Error('Rendering errors; see console.json');
  console.log('REAL_GAME_CAPTURE_OK',output);
} finally {
  writeFileSync(join(output,'console.json'),JSON.stringify(logs,null,2));
  socket?.close();
  for(const child of children.reverse()) {try{process.kill(-child.pid,'SIGKILL');}catch{}child.release();}
  rmSync(profile,{recursive:true,force:true});
}
