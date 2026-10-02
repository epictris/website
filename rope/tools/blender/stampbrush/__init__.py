"""Shared by the painted-growth add-ons, tools/blender/ivy and tools/blender/moss:
the stamp brush (brush.py), the stamps' storage (stamps.py) and the mesh helpers
both grow from (geometry.py).

Not an add-on itself. Each add-on reaches it through a symlink inside its own
package (`<add-on>/stampbrush -> ../stampbrush`), so an installed add-on (itself
a symlink into the repo) and the scene exporter (which imports the add-ons from
the repo) both import it as `.stampbrush`."""
