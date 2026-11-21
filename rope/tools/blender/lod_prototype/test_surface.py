"""Small CPU-only regression suite: python3 -m unittest discover -s THIS_DIR."""
import math
import unittest

from budget import Band, Budget, high_dof
from surface import Corner, Face, area, boundary_edges, closed_surface, partition, pack, unpack


def sheet(points, triangles):
    # Linear attributes let us check exact interpolation, not just seam matching.
    return [Face(tuple(Corner(i, (0, 0, 1, points[i][0] / 3, points[i][1] / 9)) for i in tri),
                 material=2, facet=.375) for tri in triangles]


def band(lo, hi):
    return Band(lo, hi, 0, .001, 512, 0)


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.budget = Budget(10, .15, *high_dof())

    def test_renderer_coc_conversion(self):
        b = self.budget
        for y in (-1, 0, 1.5, 2, 10, 100):
            pixels = b.max_blur * b.height * max(0, 1 - (b.distance + b.focus_band) / (b.distance + y))
            world_pixel = 2 * (b.distance + y) * b.tan_half / b.height
            self.assertAlmostEqual(2 * pixels * world_pixel, b.blur(y))

    def test_conservative_everywhere_in_band(self):
        b = self.budget
        bands = b.bands(0, 50)
        self.assertLess(len(bands), 10)
        for band_ in bands:
            for i in range(101):
                y = band_.near + (band_.far - band_.near) * i / 100
                self.assertLessEqual(band_.geometry_error, b.footprint(y) * b.sharp_error_pixels + 1e-12)
            self.assertAlmostEqual(band_.texels_per_metre, b.base_texels / 2**band_.level)
        self.assertEqual(bands[0].level, 0)
        self.assertEqual(bands[0].texels_per_metre, 512)
        self.assertGreater(bands[-1].geometry_error, bands[0].geometry_error)

    def test_panning_does_not_enter_policy(self):
        # Only depth matters; lateral camera/point positions are absent by design.
        b = self.budget
        self.assertEqual(b.bands(0, 2), [Band(0, 2, 0, b.plane_pixel / 2, 512, 0)])
        self.assertEqual(len(b.bands(20, 20.01)), 1)

    def test_foreground_and_invalid_ranges(self):
        b = self.budget
        self.assertLess(b.bands(-5, -4)[0].geometry_error, b.bands(0, 1)[0].geometry_error)
        for near, far in ((-10, 0), (2, 1), (0, math.inf), (math.nan, 2)):
            with self.assertRaises(ValueError):
                b.bands(near, far)
        with self.assertRaises(ValueError):
            b.bands(0, 100, max_bands=2)

    def test_zero_dof_and_exact_thresholds(self):
        b = Budget(10, .15, 0, 1.5)
        self.assertEqual([q.near for q in b.bands(0, 35)], [0, 10, 30])
        for level in range(1, 6):
            edge = self.budget.transition(level)
            self.assertEqual(self.budget.bands(edge, edge + .01)[0].level, level)


class PartitionTests(unittest.TestCase):
    def test_shared_cuts_area_attributes_and_source_unchanged(self):
        points = [(0, 0, 0), (3, 0, 0), (3, 9, 0), (0, 9, 0)]
        faces = sheet(points, [(0, 1, 2), (0, 2, 3)])
        new_points, chunks = partition(points, faces, [band(0, 2), band(2, 5), band(5, 9)])
        self.assertEqual(len(points), 4)
        self.assertEqual(len(faces), 2)
        self.assertAlmostEqual(sum(area(new_points, c.faces) for c in chunks), area(points, faces))
        self.assertEqual(len(new_points), 10)  # 3 shared intersections per cut, never 4
        for chunk in chunks:
            self.assertGreater(area(new_points, chunk.faces), 0)
            for face in chunk.faces:
                self.assertEqual((face.material, face.facet), (2, .375))
                self.assertGreater(area(new_points, [face]), 0)
                for corner in face.corners:
                    x, y, _ = new_points[corner.vertex]
                    self.assertLessEqual(chunk.band.near, y)
                    self.assertLessEqual(y, chunk.band.far)
                    self.assertAlmostEqual(corner.attributes[3], x / 3)
                    self.assertAlmostEqual(corner.attributes[4], y / 9)
        for a, b in zip(chunks, chunks[1:]):
            def at_cut(chunk):
                return {e for e in boundary_edges(chunk.faces)
                        if all(new_points[v][1] == a.band.far for v in e)}
            self.assertEqual(at_cut(a), at_cut(b))
            self.assertEqual(len(at_cut(a)), 2)

    def test_plane_through_vertex_and_edge_has_no_duplicate_faces(self):
        points = [(0, 0, 0), (1, 1, 0), (0, 2, 0), (-1, 1, 0)]
        for triangles in ([(0, 1, 2), (0, 2, 3)], [(0, 1, 3), (1, 2, 3)]):
            faces = sheet(points, triangles)
            p, chunks = partition(points, faces, [band(0, 1), band(1, 2)])
            self.assertAlmostEqual(sum(area(p, c.faces) for c in chunks), 2)
            self.assertTrue(all(area(p, [f]) > 0 for c in chunks for f in c.faces))
            self.assertEqual(sum(len(c.faces) for c in chunks), 4 if triangles[0][2] == 2 else 2)

    def test_coplanar_face_assigned_once(self):
        points = [(0, 1, 0), (1, 1, 0), (0, 1, 1)]
        faces = sheet(points, [(0, 1, 2)])
        p, chunks = partition(points, faces, [band(0, 1), band(1, 2)])
        self.assertEqual([len(c.faces) for c in chunks], [1, 0])
        self.assertAlmostEqual(area(p, chunks[0].faces), .5)

    def test_hard_normals_and_uv_seams_are_not_welded(self):
        points = [(0, 0, 0), (1, 0, 0), (1, 2, 0), (0, 2, 1)]
        faces = [Face(tuple(Corner(i, (0, 0, 1, 0, 0)) for i in (0, 1, 2))),
                 Face(tuple(Corner(i, (1, 0, 0, 1, 1)) for i in (0, 2, 3)))]
        p, chunks = partition(points, faces, [band(0, 1), band(1, 2)])
        for chunk in chunks:
            packed = pack(p, chunk)
            self.assertGreater(len(packed['vertices']), len({c.vertex for f in chunk.faces for c in f.corners}))
            restored = unpack(packed, packed['indices'], chunk.band)
            self.assertEqual(boundary_edges(restored.faces), boundary_edges(chunk.faces))
            for face in restored.faces:
                self.assertEqual(len({c.attributes for c in face.corners}), 1)

    def test_empty_and_outside(self):
        self.assertEqual(partition([], [], [band(0, 1)])[1][0].faces, [])
        p = [(0, 0, 0), (1, 0, 0), (0, 5, 0)]
        with self.assertRaises(ValueError):
            partition(p, sheet(p, [(0, 1, 2)]), [band(0, 1)])

    def test_closed_surface_rejects_wrong_winding_and_duplicate_faces(self):
        points = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)]
        faces = sheet(points, [(0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3)])
        self.assertTrue(closed_surface(faces))
        self.assertFalse(closed_surface(faces + [faces[0]]))
        self.assertFalse(closed_surface([Face(tuple(reversed(faces[0].corners))), *faces[1:]]))
        _, chunks = partition(points, faces, [band(0, .3), band(.3, .6), band(.6, 1)])
        self.assertTrue(closed_surface([f for c in chunks for f in c.faces]))


if __name__ == '__main__':
    unittest.main()
