"""The port changes nothing about an approved rock.

A request of the fixture outline and no overrides must become, field by field,
the rock document the fork's server wrote for it: fixtures/ball-body-7.polygon.json
is that document for body 7 of the fork's levels/ball.json (the sidecar of
public/generated-boulders/263a5a5c-58d7-437c-b957-9900893e48b5). Every other
schema knob must ride along at its default, under its own name.

Run by `bun run generators:check`, or directly:

    python tools/blender/boulders/test_params.py
"""
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import rockgen  # noqa: E402
from params import defaults  # noqa: E402

FIXTURE = HERE / "fixtures" / "ball-body-7.polygon.json"

# Two recipe changes landed in the fork's server after this rock was generated
# on 2026-09-24 18:35, and the port follows the server as it is now, not as it
# was then. Each is the fork's current value for this outline:
#   slabs: 8186785 (18:52) replaced the fixed 10 with round(area * 10), and
#          this outline's area is 0.7575 m^2;
#   game_low_poly: ac60655 (2026-09-25) added the low-poly game recipe.
SINCE_FIXTURE = {"slabs": 8, "game_low_poly": True}


def check_fixture():
    fork = json.loads(FIXTURE.read_text(encoding="utf-8"))
    outline = fork["rocks"][0]["outer"]
    ported = rockgen.request_document({"kind": "boulder", "version": 1, "outline": outline, "params": {}})

    for field in ("plane", "units", "rocks"):
        assert ported[field] == fork[field], f"{field}: {ported[field]!r} != {fork[field]!r}"

    expected = dict(fork["defaults"], **SINCE_FIXTURE)
    got = ported["defaults"]
    for key, value in expected.items():
        assert key in got, f"{key} missing from the ported spec"
        # Exact: == on floats, and the same type (1 is not 1.0 in the JSON Blender reads).
        assert got[key] == value and type(got[key]) is type(value), f"{key}: {got[key]!r} != fork {value!r}"

    knobs = {k: v for k, v in defaults().items() if k not in rockgen.LEGACY_NAMES}
    extra = {k: v for k, v in got.items() if k not in expected}
    assert extra == knobs, f"knobs beyond the fork's fields: {sorted(set(extra) ^ set(knobs))}"

    # And the ported document passes the generator's own validation.
    path = HERE / "fixtures" / ".ported.json"
    try:
        path.write_text(json.dumps(ported))
        spec = rockgen.read_specs(path)[0]
    finally:
        path.unlink(missing_ok=True)
    assert spec["slabs"] == 8 and spec["name"] == "boulder"
    return len(expected), len(knobs)


def check_slab_count():
    # The fork's boulder-generator.test.mjs cases, at the default 10 per m^2.
    for area, slabs in [(0.1, 2), (1, 10), (4, 40), (20, 100)]:
        assert rockgen.slab_count(area, 10) == slabs, (area, rockgen.slab_count(area, 10))
    # JavaScript rounds halves up; Python's round() would give 2 here.
    assert rockgen.slab_count(0.25, 10) == 3


def check_tolerance():
    square = [[0, 0], [1, 0], [1, 1], [0, 1]]
    auto = rockgen.request_document({"outline": square, "params": {}})["defaults"]["tolerance"]
    assert auto == min(0.04, math.sqrt(1) * 0.04)
    given = rockgen.request_document({"outline": square, "params": {"tolerance": 0.01}})["defaults"]["tolerance"]
    assert given == 0.01


def check_unknown():
    try:
        rockgen.request_document({"outline": [[0, 0], [1, 0], [0, 1]], "params": {"nope": 1}})
    except ValueError as e:
        assert "nope" in str(e)
    else:
        raise AssertionError("an unknown parameter was accepted")


if __name__ == "__main__":
    fields, knobs = check_fixture()
    check_slab_count()
    check_tolerance()
    check_unknown()
    print(f"boulder params: fixture matches the fork on {fields} fields "
          f"({', '.join(sorted(SINCE_FIXTURE))} at the fork's current values), "
          f"{knobs} schema knobs at their defaults; slab count, tolerance, unknown keys ok")
