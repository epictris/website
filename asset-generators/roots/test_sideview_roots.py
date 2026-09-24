import copy
import unittest
from collections import Counter
import numpy as np
from polygon_roots_2d import (make_demo_shapes,build_asset_2d,validate_shapes,
                              triangulate,signed_area,segment_distance)
from sideview_surface import inside, boundary_distance, build_surfaces, branch_frame, branch_coordinates
from sideview_outline import resolve_outlines


class SideViewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data=make_demo_shapes()
        cls.asset=build_asset_2d(cls.data,decoration_count=0)

    def test_concave_triangulation_preserves_area(self):
        for root in self.data['roots']:
            p=np.asarray(root['polygon'])
            self.assertAlmostEqual(sum(abs(signed_area(p[t])) for t in triangulate(p)),abs(signed_area(p)))

    def test_rounded_mesh_has_depth_and_exact_projected_boundary(self):
        for part in self.asset['structure']:
            roots=[r for r in self.data['roots'] if r['id'] in part['source_root_ids']]
            polygons=[np.asarray(r['polygon']) for r in roots]
            v=part['vertices']
            self.assertGreater(np.ptp(v[:,1]),max(r['depth'] for r in roots)*.7)
            for p in polygons:
                for a in p:
                    if any(inside(a,q)[0] and boundary_distance(a,q)[0]>1e-7 for q in polygons):continue
                    self.assertLess(np.linalg.norm(v[:,[0,2]]-a,axis=1).min(),1e-8)
            on_edge=v[np.abs(v[:,1])<1e-9][:,[0,2]]
            self.assertLess(np.min([boundary_distance(on_edge,p) for p in polygons],axis=0).max(),1e-8)
            self.assertFalse(any(np.any(inside(on_edge,p)&(boundary_distance(on_edge,p)>1e-8)) for p in polygons))
            triangles=v[part['faces']][:,:,[0,2]]
            centers=triangles.mean(axis=1)
            self.assertTrue(np.all(np.any([inside(centers,p)|(boundary_distance(centers,p)<1e-8) for p in polygons],axis=0)))

    def test_noise_depth_and_seed_cannot_change_gameplay(self):
        changed=copy.deepcopy(self.data)
        for root in changed['roots']: root['depth']*=2
        other=build_asset_2d(changed,seed=9,decoration_count=0)
        self.assertEqual(self.asset['gameplay2d'],other['gameplay2d'])
        self.assertEqual(self.data,self.asset['editor_source'])

    def test_visual_mesh_is_closed_without_duplicate_faces(self):
        for part in self.asset['structure']:
            faces=part['faces']
            edges=Counter(tuple(sorted((int(a),int(b)))) for f in faces for a,b in zip(f,list(f[1:])+[f[0]]))
            self.assertEqual(set(edges.values()),{2})
            self.assertEqual(len(faces),len(set(tuple(sorted(f)) for f in faces)))

    def test_forks_are_one_connected_surface(self):
        self.assertEqual(len(self.asset['structure']),1)
        part=self.asset['structure'][0]
        self.assertEqual(set(part['source_root_ids']),{r['id'] for r in self.data['roots']})
        neighbors=[set() for _ in part['vertices']]
        for a,b,c in part['faces']:
            neighbors[a].update([b,c]);neighbors[b].update([a,c]);neighbors[c].update([a,b])
        seen=set();pending=[0]
        while pending:
            i=pending.pop()
            if i in seen:continue
            seen.add(i);pending.extend(neighbors[i]-seen)
        self.assertEqual(len(seen),len(part['vertices']))

    def test_union_area_and_hole_remain_exact(self):
        def rect(name,x0,y0,x1,y1):
            return dict(id=name,polygon=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],depth=.3)
        # Four overlapping bars enclose a real hole, which must not be filled.
        roots=[rect('bottom',0,0,3,.5),rect('top',0,2.5,3,3),
               rect('left',0,0,.5,3),rect('right',2.5,0,3,3)]
        part=build_surfaces(roots,1234)[0];v=part['vertices'];t=v[part['faces']][:,:,[0,2]]
        area=np.abs((t[:,1,0]-t[:,0,0])*(t[:,2,1]-t[:,0,1])-(t[:,1,1]-t[:,0,1])*(t[:,2,0]-t[:,0,0])).sum()/4
        self.assertAlmostEqual(area,5,places=7)
        centers=t.mean(axis=1)
        self.assertFalse(np.any((centers[:,0]>.5)&(centers[:,0]<2.5)&(centers[:,1]>.5)&(centers[:,1]<2.5)))

    def test_grain_coordinates_rotate_with_the_branch(self):
        root=dict(id='diagonal',polygon=[[0,0],[.2,-.2],[2.2,1.8],[2,2]])
        frame=branch_frame(root)
        q=np.array([[.5,.3],[1,.8],[1.5,1.3]])
        u,v=branch_coordinates(q,frame)
        self.assertLess(np.ptp(u),1e-8)
        self.assertGreater(np.diff(v).min(),.6)

    def test_clockwise_input_preserves_authored_edge_ids(self):
        data=copy.deepcopy(self.data)
        for root in data['roots']: root['polygon'].reverse(); root['grab_edges']=[1]
        asset=build_asset_2d(data,decoration_count=0)
        self.assertEqual(asset['gameplay2d']['roots'][0]['grab_edges'],[1])
        self.assertEqual(asset['gameplay2d']['roots'][0]['polygon'],data['roots'][0]['polygon'])

    def test_invalid_shapes_fail(self):
        for polygon in ([[0,0],[1,1],[0,1],[1,0]],[[0,0],[1,0],[1,0],[0,1]],
                        [[0,0],[1,0],[2,0]],[[0,0],[1,float('nan')],[0,1]]):
            data=copy.deepcopy(self.data); data['roots'][0]['polygon']=polygon; data['roots'][0]['grab_edges']=[]
            with self.assertRaises(ValueError): validate_shapes(data)

    def test_rounding_updates_shared_contour_and_maps_source_edges(self):
        data=copy.deepcopy(self.data)
        for root in data['roots']:root['corner_rounding']=.6;root['grab_edges']=[1]
        resolved=resolve_outlines(data)
        for source,root in zip(data['roots'],resolved['roots']):
            self.assertGreater(len(root['polygon']),len(source['polygon']))
            self.assertEqual(len(root['source_edges']),len(root['polygon']))
            self.assertTrue(all(root['source_edges'][i]==1 for i in root['grab_edges']))
            self.assertEqual(len(root['grab_edges']),1,'rounding must not enable unmarked neighboring corners')

    def test_broken_ends_and_rounding_are_seed_independent(self):
        data=copy.deepcopy(self.data);data['roots']=data['roots'][2:]
        data['roots'][0].update(corner_rounding=.6,broken_edges=[4])
        a=build_asset_2d(data,seed=1,decoration_count=0)
        b=build_asset_2d(data,seed=4,decoration_count=0)
        self.assertEqual(a['gameplay2d'],b['gameplay2d'])
        self.assertNotEqual(a['gameplay2d']['roots'][0]['polygon'],data['roots'][0]['polygon'])
        p=np.asarray(a['gameplay2d']['roots'][0]['polygon'])
        v=a['structure'][0]['vertices'];boundary=v[np.abs(v[:,1])<1e-9][:,[0,2]]
        self.assertLess(boundary_distance(boundary,p).max(),1e-8)
        self.assertEqual(a['editor_source'],data)

    def test_asymmetric_volume_and_exportable_material_maps(self):
        from sideview_surface import bark_atlas,end_fields
        part=self.asset['structure'][0];v=part['vertices']
        self.assertGreater(abs(v[:,1].min()+v[:,1].max()),.005)
        albedo,normal,orm=bark_atlas(part,size=96)
        for image in (albedo,normal,orm):
            self.assertTrue(np.isfinite(image).all());self.assertGreaterEqual(image.min(),0);self.assertLessEqual(image.max(),1)
        self.assertGreater(np.ptp(orm[:,:,1]),.1)
        data=copy.deepcopy(self.data);data['roots'][0]['broken_edges']=[7]
        resolved=resolve_outlines(data);cap=resolved['roots'][0]['end_profiles'][0]
        midpoint=(np.asarray(cap['a'])+cap['b'])/2
        samples=np.array([midpoint+np.asarray(cap['inward'])*cap['band']*.3])
        mask,color,_,__,___=end_fields(samples,resolved['roots'],0)
        self.assertGreater(mask[0],.95);self.assertGreater(color[0,0],.4)

    def test_rounded_fork_intersections_have_no_internal_boundary_slivers(self):
        from sideview_surface import union_tessellation,solve_squared_depth
        data=copy.deepcopy(self.data)
        for root in data['roots']:
            root['corner_rounding']=.78
            root['broken_edges']={'main_root':[0,7],'left_limb':[0],'right_limb':[4]}[root['id']]
        roots=resolve_outlines(data)['roots'];p,faces,boundary=union_tessellation(roots)
        for root in roots:
            polygon=np.asarray(root['polygon'])
            self.assertFalse(np.any(inside(p[boundary],polygon)&(boundary_distance(p[boundary],polygon)>1e-8)))
        height=solve_squared_depth(p,faces,boundary,roots)
        samples=[height[np.linalg.norm(p-[x,2.15],axis=1).argmin()] for x in (1.04,1.09,1.14)]
        self.assertGreater(samples[1],.8*min(samples[0],samples[2]),'source X coordinates must not create a thickness crease')


if __name__=='__main__': unittest.main()
