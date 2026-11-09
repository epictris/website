"""Import currently assigned offline recipes into the source-layer editor.
Existing projects are preserved; run again after registering another version.
"""
import copy, json, math, sys
from pathlib import Path
import numpy as np
import audio
ROOT=Path(__file__).resolve().parents[2]; HERE=Path(__file__).resolve().parent
path=HERE/'layer-projects.json'
catalog=json.loads(path.read_text()) if path.exists() else dict(version=1,sources=[],projects=[])
recipes=json.loads((HERE/'recipes.json').read_text()); by={c['name']:c for c in recipes['candidates']}; sr=recipes['sampleRate']
bank=json.loads((ROOT/'src/audio/soundBank.json').read_text()); assets=json.loads((ROOT/'src/audio/soundAssets.json').read_text())
metadata={s['file']:s for f in ['local-sources.json','source-library.json'] for s in json.loads((HERE/f).read_text())}
for entry in catalog['sources']:
 known=metadata.get(Path(entry['file']).name)
 if known:
  for key in ['source','author','license']:entry[key]=known.get(key,'')
fx=dict(gainDb=0,pitch=0,pan=0,highpass=0,lowpass=20000,bass=0,treble=0,fadeIn=0,fadeOut=.01,decay=0,normalize=False,drive=0,delay=.15,delayMix=0,reverb=0,compression=0)
def source(file,c):
 rel=Path(file).as_posix(); found=next((s for s in catalog['sources'] if s['file']==rel),None)
 if found:
  known=metadata.get(Path(rel).name)
  if known:
   for key in ['source','author','license']:found[key]=known.get(key,'')
  return found['id']
 c=metadata.get(Path(rel).name,c)
 x,rate=audio.read_audio(HERE/rel); ident='source-'+str(len(catalog['sources'])+1)
 catalog['sources'].append(dict(id=ident,name=Path(rel).name,file=rel,seconds=len(x)/rate,source=c.get('source',''),author=c.get('author',''),license=c.get('license','')))
 return ident
cache={}
def flatten(c,inherited=1):
 if c['name'] not in cache:
  samples,_=audio.recorded_layers(c,HERE/'recipes.json',sr,round(c['seconds']*sr))
  cache[c['name']]=10**((-3+c.get('outputGainDb',0))/20)/max(float(np.max(np.abs(sum(samples)))),1e-12)
 scale=cache[c['name']]*inherited; layers=[]
 for index,edit in enumerate(c['recordedLayers']):
  ancestor=by.get(Path(edit['file']).stem)
  if ancestor and edit['file'].startswith('out/') and not edit.get('pitch') and not edit.get('start'):
   layers+=flatten(ancestor,scale*edit.get('gain',1));continue
  sid=source(edit['file'],c); original=next(s for s in catalog['sources'] if s['id']==sid)
  start=edit.get('start',0); pitch=edit.get('pitch',0); rate=2**(pitch/12)
  end=min(edit.get('end',original['seconds']),start+edit.get('duration',c['seconds'])*rate,start+c['seconds']*rate)
  effects={**fx,**{k:edit[k] for k in ['pitch','highpass','lowpass','fadeIn','fadeOut','decay','normalize'] if k in edit}}
  effects['gainDb']=20*math.log10(max(1e-3,scale*edit.get('gain',1)))
  effects['gainDb']=max(-60,min(24,effects['gainDb']))
  clips=[dict(id=f'clip-{i+1}',start=start,end=end,at=p.get('at',0),pitch=p.get('pitch',0),gain=p.get('gain',1)) for i,p in enumerate(edit.get('pulses',[{}]))]
  layers.append(dict(id=f'layer-{len(layers)+1}',name=edit['name'],sourceId=sid,clips=clips,effects=effects,mute=False,solo=False))
 return layers
for slot,params in bank['slots'].items():
 for key in params.get('sounds',[]):
  ident=(slot+'--'+key).replace('.','_');
  if any(p['id']==ident for p in catalog['projects']):continue
  name=Path(assets[key]['name']).stem;c=by.get(name)
  if c and c.get('recordedLayers'):
   layers=flatten(c)
   for i,l in enumerate(layers):l['id']=f'layer-{i+1}'
   project=dict(id=ident,name=name,slot=slot,assetKey=key,seconds=c['seconds'],loop=c.get('loop',False),gainDb=0,fadeOut=0 if c.get('loop') else .015,layers=layers)
   catalog['projects'].append(project)
path.write_text(json.dumps(catalog,indent=2)+'\n');print(f"Layer catalog: {len(catalog['projects'])} projects, {len(catalog['sources'])} original sources")
