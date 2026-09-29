import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C, bpy
C.clear(); sc = C.setup_scene(); rock = C.build_rock()
C.report("rock_only", [rock])
