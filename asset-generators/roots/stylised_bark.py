"""Natural bark fields in branch coordinates; no external image required."""
import numpy as np


def bark_field(u, v, seed=0, maturity=1.0):
    """Irregular longitudinal fissures, interrupted fibres and quiet worn patches."""
    from sideview_surface import noise, smoothstep
    warp = u + .035*noise(u*5, v*1.7, seed+1) + .018*noise(u*17,v*4,seed+2)
    phase = warp*19 + .55*noise(warp*11,v*2.8,seed+3)
    ridge = .5+.5*np.cos(phase*2*np.pi)
    # Width and depth change along each fissure; some close entirely.
    opening = smoothstep(-.48,.5,noise(warp*35,v*7,seed+4))
    groove = np.exp(-((1-ridge)/(.025+.10*opening))**2)*opening*maturity
    shoulder = np.power(ridge,.65)
    patch = noise(u*6,v*2.1,seed+5)
    worn = smoothstep(.08,.65,noise(u*11,v*3.5,seed+6))
    fine_phase = warp*83 + .75*noise(warp*29,v*9,seed+7)
    fibres = (.5+.5*np.cos(fine_phase*2*np.pi))**14
    fibres *= smoothstep(-.3,.55,noise(warp*67,v*24,seed+8))
    pores = noise(u*185,v*150,seed+9)
    # Sparse short cross fractures tie adjacent fibres together.
    cross = np.exp(-(noise(warp*28,v*32,seed+10)/.065)**2)
    cross *= smoothstep(.38,.7,noise(warp*18,v*15,seed+11))*maturity
    tone = np.clip(.52+.17*patch+.055*shoulder-.32*groove-.065*fibres-.10*cross+.025*pores,0,1)
    dark=np.array([.145,.105,.077]); light=np.array([.49,.415,.335])
    color=dark+(light-dark)*tone[...,None]
    weather=smoothstep(-.1,.65,noise(u*9,v*2,seed+12))*.30
    grey=np.stack([tone*.29+.13,tone*.28+.125,tone*.265+.12],axis=-1)
    color=color*(1-weather[...,None])+grey*weather[...,None]
    relief=(.0007*shoulder-.0026*groove-.00032*fibres-.0006*cross+.00008*pores)*(1-.6*worn)
    roughness=np.clip(.87+.09*groove+.025*pores-.12*worn,.65,.99)
    return np.clip(color,0,1),relief,roughness


def sheet(size=2048, include_roughness=False):
    """Four-band sheet, seamlessly periodic within each band and along its length."""
    width=size//4
    u,v=np.meshgrid(np.arange(width)/width,np.arange(size)/size)
    colors=[];heights=[];roughness=[]
    for band in range(4):
        # Blend shifted copies at opposite edges, preserving the same periodic field.
        color=np.zeros((*u.shape,3));height=np.zeros(u.shape);rough=np.zeros(u.shape)
        for du in (0,1):
            for dv in (0,1):
                weight=(u if du else 1-u)*(v if dv else 1-v)
                c,h,r=bark_field((u-du)*.6,(v-dv)*3,band*7, maturity=(.38,1.0,.85,.65)[band])
                color+=weight[...,None]*c;height+=weight*h;rough+=weight*r
        colors.append(color);heights.append(height);roughness.append(rough)
    result=(np.concatenate(colors,axis=1),np.clip((np.concatenate(heights,axis=1)+.004)/.012,0,1))
    return (*result,np.concatenate(roughness,axis=1)) if include_roughness else result
