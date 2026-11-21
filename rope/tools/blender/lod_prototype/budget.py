"""Use the production policy without importing the Blender add-on package."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'formations'))
try:
    from depth_budget import Band, Budget, high_dof
finally:
    sys.path.pop(0)

__all__ = ['Band', 'Budget', 'high_dof']
