"""Run with Blender --background --factory-startup --python this_file."""
import math,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import bpy,numpy as np
from mathutils import Vector
import emission_ambient as ambient

bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
scene.render.engine='CYCLES'
scene.cycles.samples=8
scene.cycles.device='CPU'
world=bpy.data.worlds.new('guide.world')
nt=world.node_tree
nt.nodes.clear()
hemi=nt.nodes.new('ShaderNodeMix');hemi.name='Game hemisphere fill';hemi.data_type='RGBA'
ground=(.02,.04,.06,1);sky=(.12,.16,.2,1)
hemi.inputs[6].default_value=ground;hemi.inputs[7].default_value=sky
bg=nt.nodes.new('ShaderNodeBackground');out=nt.nodes.new('ShaderNodeOutputWorld')
nt.links.new(hemi.outputs[2],bg.inputs['Color']);nt.links.new(bg.outputs[0],out.inputs['Surface'])
# Constant environment: its unoccluded diffuse term is radiance * intensity,
# independent of the card normal. The world path must not add it a second time.
sky_image=bpy.data.images.new('test sky',32,16,float_buffer=True)
sky_image.colorspace_settings.name='Linear Rec.709'
sky_image.pixels.foreach_set(np.tile(np.array([.2,.3,.4,1],np.float32),32*16))
texture=nt.nodes.new('ShaderNodeTexImage');texture.image=sky_image
env=nt.nodes.new('ShaderNodeMix');env.data_type='RGBA';env.blend_type='MULTIPLY'
env.inputs['Factor'].default_value=1;env.inputs[7].default_value=(.5,.5,.5,1)
nt.links.new(texture.outputs['Color'],env.inputs[6])
total=nt.nodes.new('ShaderNodeMixRGB');total.blend_type='ADD';total.inputs[0].default_value=1
nt.links.new(hemi.outputs[2],total.inputs[1]);nt.links.new(env.outputs[2],total.inputs[2])
nt.links.new(total.outputs[0],bg.inputs['Color'])
scene.world=world
bpy.ops.mesh.primitive_plane_add(size=4,rotation=(0,math.pi/3,0))
plane=bpy.context.object
mat=bpy.data.materials.new('white diffuse card');plane.data.materials.append(mat)
bsdf=mat.node_tree.nodes['Principled BSDF'];bsdf.inputs['Base Color'].default_value=(1,1,1,1)
bsdf.inputs['Specular IOR Level'].default_value=0
original_links=[(l.from_socket,l.to_socket) for l in mat.node_tree.links]
assert ambient.enable(scene)==1
count=len(mat.node_tree.nodes)
assert ambient.enable(scene)==1 and len(mat.node_tree.nodes)==count
assert scene.world != world and ambient.hemisphere(world).outputs[2].is_linked
# No hemisphere energy remains in the world, so the camera term is not doubled.
assert not ambient.hemisphere(scene.world).outputs[2].is_linked
bpy.ops.object.camera_add(location=(math.sqrt(3),0,1))
cam=bpy.context.object
cam.rotation_euler=(-cam.location).to_track_quat('-Z','Y').to_euler()
cam.data.type='ORTHO';cam.data.ortho_scale=1;scene.camera=cam
scene.render.resolution_x=scene.render.resolution_y=16;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='OPEN_EXR';scene.render.image_settings.color_depth='32'
with tempfile.TemporaryDirectory() as folder:
 scene.render.filepath=folder+'/fill.exr'
 bpy.ops.render.render(write_still=True)
 im=bpy.data.images.load(scene.render.filepath,check_existing=False)
 rgb=np.asarray(im.pixels[:]).reshape(16,16,4)[4:12,4:12,:3].mean(axis=(0,1))
 expected=.75*np.asarray(sky[:3])+.25*np.asarray(ground[:3])+np.array([.1,.15,.2])
 assert np.allclose(rgb,expected,rtol=.015,atol=.001),(rgb,expected)
 bpy.data.images.remove(im)
# A preview fill must not become an emitting source in an exported scene.
ambient.clear(scene)
assert scene.world==world
assert [(l.from_socket,l.to_socket) for l in mat.node_tree.links]==original_links
assert not any(n.get(ambient.MARKER) for n in mat.node_tree.nodes)
assert not any(w.get(ambient.WORLD_SOURCE) for w in bpy.data.worlds)
assert not any(im.get(ambient.MARKER) for im in bpy.data.images)
# A vertical sky gradient has an analytic cosine convolution: .5 + n.z/3.
# This detects flipped sky/ground and using raw radiance without convolution.
latitude=((np.arange(16)+.5)/16-.5)*np.pi
gradient=np.ones((16,32,4),np.float32)
gradient[:,:,:3]=(.5+.5*np.sin(latitude))[:,None,None]
sky_image.pixels.foreach_set(gradient.ravel())
convolved=ambient.diffuse_sky(sky_image,(1,1,1,1),32,16)
rgb=np.asarray(convolved.pixels[:]).reshape(16,32,4)[:,:,:3]
expected=(.5+np.sin(latitude)/3)[:,None,None]
assert np.max(np.abs(rgb-expected))<.003
bpy.data.images.remove(convolved)
print('EMISSION_AMBIENT_OK hemisphere plus diffuse sky match analytic radiance without double counting; repeated enable and restoration preserve authored shaders/world')
