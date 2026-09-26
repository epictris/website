import copy
import unittest
import numpy as np

import polygon_roots as roots


def box():
    # +Y face is the broad grab panel.
    return dict(version=1,units='meters',up_axis='Z',roots=[dict(
        id='box',vertices=[[-1,-.2,0],[1,-.2,0],[1,.2,0],[-1,.2,0],
                           [-1,-.2,2],[1,-.2,2],[1,.2,2],[-1,.2,2]],
        faces=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]],
        grab_faces=[4])])


class PolygonRootTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.demo = roots.build_asset(roots.make_demo_blockout(),decoration_count=8)
        cls.box = roots.build_asset(box(),decoration_count=0)

    def test_grain_is_continuous_across_cage_faces(self):
        asset=roots.build_asset(roots.make_demo_blockout(),bark_depth=0,decoration_count=0)
        for part in asset['structure']:
            samples={}
            source=next(r for r in asset['source']['roots'] if r['id']==part['id'])
            cage=np.asarray(source['vertices'])
            sides=[i for i,f in enumerate(source['faces']) if np.ptp(cage[f,2])>1e-7]
            indices=np.unique(part['faces'][np.isin(part['source_faces'],sides)])
            for point,uv in zip(part['vertices'][indices],part['uv'][indices]):
                key=tuple(np.round(point,9))
                # A full circumference is one quarter of the four-band sheet.
                wrapped=np.array([(uv[0]*4)%1,uv[1]])
                if key in samples:
                    diff=np.abs(wrapped-samples[key])
                    self.assertLess(min(diff[0],abs(diff[0]-1)),1e-7)
                    self.assertLess(diff[1],1e-7)
                samples[key]=wrapped

    def test_grab_geometry_matches_authored_polygon(self):
        for part,source in zip(self.demo['structure'],self.demo['source']['roots']):
            original=np.asarray(source['vertices'])
            for fi in source['grab_faces']:
                face=original[source['faces'][fi]]
                triangles=part['vertices'][part['faces'][part['source_faces']==fi]]
                n=roots.face_normal(face)
                self.assertLess(np.abs((triangles-face[0])@n).max(),1e-10)
                for a,b in zip(face,np.roll(face,-1,axis=0)):
                    self.assertGreaterEqual((np.cross(b-a,triangles-a)@n).min(),-1e-10)
                area=np.linalg.norm(np.cross(triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0]),axis=1).sum()/2
                expected=np.linalg.norm(np.cross(face,np.roll(face,-1,axis=0)).sum(axis=0))/2
                self.assertAlmostEqual(area,expected,places=10)

    def test_reproducible(self):
        other=roots.build_asset(roots.make_demo_blockout(),decoration_count=8)
        for a,b in zip(self.demo['structure'],other['structure']):
            np.testing.assert_array_equal(a['vertices'],b['vertices'])
        self.assertEqual(len(self.demo['decorations']),len(other['decorations']))
        for a,b in zip(self.demo['decorations'],other['decorations']):
            np.testing.assert_array_equal(a['branch'].points,b['branch'].points)

    def test_seed_cannot_move_grab_surfaces(self):
        other=roots.build_asset(self.demo['source'],seed=91,decoration_count=0)
        self.assertEqual(roots.grab_manifest(self.demo),roots.grab_manifest(other))
        for a,b in zip(self.demo['structure'],other['structure']):
            np.testing.assert_array_equal(a['vertices'][a['grab']>0],b['vertices'][b['grab']>0])

    def test_decorations_clear_hands_in_both_lods(self):
        self.assertGreater(len(self.demo['decorations']),0)
        triangles,_=roots.source_triangles(self.demo['source'],True)
        for item in self.demo['decorations']:
            self.assertLessEqual(max(item['branch'].radii),.032)
            for lod in (0,1):
                v,f,_,_=roots.decoration_mesh(item['branch'],lod)
                self.assertTrue(roots.clearance_ok(v,f,triangles,self.demo['hand_clearance']))

    def test_clearance_detects_triangle_crossing_with_distant_vertices(self):
        grab=np.array([[[-.1,0,-.1],[.1,0,-.1],[0,0,.1]]])
        v=np.array([[-1,-1,0],[1,-1,0],[0,1,0]])
        self.assertFalse(roots.clearance_ok(v,np.array([[0,1,2]]),grab,.1))

    def test_front_grab_and_snapping(self):
        grab=roots.query_grab(self.box,[0,.35,1])
        self.assertIsNotNone(grab)
        np.testing.assert_allclose(grab['point'],[0,.2,1],atol=1e-10)
        self.assertEqual(grab['source_face'],4)
        self.assertEqual(grab['root_id'],'box')

    def test_reject_backside_reach_edge_and_unmarked_face(self):
        for point in ([0,0,1],[0,1,1],[.99,.25,1],[0,-.3,1]):
            self.assertIsNone(roots.query_grab(self.box,point),point)

    def test_polygon_diagonal_is_not_a_false_boundary(self):
        self.assertIsNotNone(roots.query_grab(self.box,[0,.3,1],hand_radius=.12))

    def test_every_demo_panel_fits_the_default_hand(self):
        for face in roots.grab_manifest(self.demo)['faces']:
            center=np.mean(face['polygon'],axis=0)
            approach=center+np.array(face['normal'])*.12
            self.assertIsNotNone(roots.query_grab(self.demo,approach),
                                 f'{face["root_id"]}:{face["source_face"]}')

    def test_other_geometry_blocks_hand_or_approach(self):
        panel=np.array([[[-1,.3,0],[1,.3,0],[1,.3,2]],[[-1,.3,0],[1,.3,2],[-1,.3,2]]])
        self.assertIsNone(roots.query_grab(self.box,[0,.4,1],extra_obstacles=panel))
        shifted=panel.copy(); shifted[:,:,1]=.23
        self.assertIsNone(roots.query_grab(self.box,[0,.21,1],extra_obstacles=shifted))

    def test_invalid_input_is_rejected(self):
        cases=[]
        d=box(); d['roots'][0]['faces'].pop(); cases.append(d)
        d=box(); d['roots'][0]['vertices'][6][1]+=.1; cases.append(d)
        d=box(); d['roots'][0]['grab_faces']=[99]; cases.append(d)
        d=box(); d['roots'][0]['faces']=[list(reversed(f)) for f in d['roots'][0]['faces']]; cases.append(d)
        d=box(); d['roots'][0]['vertices'][0][0]=float('nan'); cases.append(d)
        for data in cases:
            with self.assertRaises(ValueError):
                roots.validate_blockout(data)

    def test_no_grabs_does_not_enable_any_by_size(self):
        data=box(); data['roots'][0]['grab_faces']=[]
        asset=roots.build_asset(data,decoration_count=0)
        self.assertEqual(roots.grab_manifest(asset)['faces'],[])
        self.assertIsNone(roots.query_grab(asset,[0,.3,1]))


if __name__=='__main__':
    unittest.main()
