import unittest
import numpy as np
from uv_validation import intersection_area, overlapping_faces


class UVOverlapTests(unittest.TestCase):
    def test_shared_edge_and_collapsed_chart_have_no_coverage(self):
        triangles=np.array([[[0,0],[1,0],[0,1]],[[1,0],[1,1],[0,1]],[[.2,.2]]*3])
        self.assertEqual(overlapping_faces(triangles,[0,1,2],1e-12).tolist(),[])

    def test_chart_crossing_and_winding(self):
        a=np.array([[0,0],[1,0],[0,1]])
        b=np.array([[0,0],[.5,0],[0,.5]])
        self.assertAlmostEqual(intersection_area(a,b),.125)
        self.assertAlmostEqual(intersection_area(a,b[::-1]),.125)
        self.assertEqual(overlapping_faces(np.array([a,b]),[0,1],1e-12).tolist(),[0,1])

    def test_rounding_sliver_below_subtexel_tolerance(self):
        a=np.array([[0,0],[1,0],[0,1]],float)
        b=np.array([[1,0],[1,1],[0,1]],float)-1e-8
        self.assertGreater(intersection_area(a,b),0)
        self.assertEqual(overlapping_faces(np.array([a,b]),[0,1],1e-7).tolist(),[])


if __name__=='__main__':unittest.main()
