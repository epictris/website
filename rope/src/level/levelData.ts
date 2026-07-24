// AUTO-GENERATED from scenes/levels/Level2.tscn — do not edit by hand.
export interface LevelBodyData {
  kind: "static" | "impermeable" | "killzone";
  x: number;
  y: number;
  rot: number;
  shape: { kind: "rect"; w: number; h: number } | { kind: "circle"; r: number };
}
export interface LevelData {
  player: { x: number; y: number; radius: number };
  bodies: LevelBodyData[];
}

// Level geometry is authored in Godot/scene pixels; the simulation runs in
// metres. Scale every length by `factor` (pass PX = 1 / PIXELS_PER_METER) at
// load, leaving rotations and kinds untouched. Returns a fresh copy so the
// exported level constants stay pristine.
export function scaleLevelData(data: LevelData, factor: number): LevelData {
  return {
    player: {
      x: data.player.x * factor,
      y: data.player.y * factor,
      radius: data.player.radius * factor,
    },
    bodies: data.bodies.map((b) => ({
      kind: b.kind,
      x: b.x * factor,
      y: b.y * factor,
      rot: b.rot,
      shape:
        b.shape.kind === "rect"
          ? { kind: "rect", w: b.shape.w * factor, h: b.shape.h * factor }
          : { kind: "circle", r: b.shape.r * factor },
    })),
  };
}
export const LEVEL_2: LevelData = {
  "player": {
    "x": -394,
    "y": 16,
    "radius": 8
  },
  "bodies": [
    {
      "kind": "static",
      "x": -144,
      "y": -314,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 600,
        "h": 72
      }
    },
    {
      "kind": "static",
      "x": 332,
      "y": -70,
      "rot": 0.5235988,
      "shape": {
        "kind": "rect",
        "w": 600,
        "h": 72
      }
    },
    {
      "kind": "static",
      "x": 362.5,
      "y": 395.5,
      "rot": 0.6981317,
      "shape": {
        "kind": "rect",
        "w": 600,
        "h": 72
      }
    },
    {
      "kind": "static",
      "x": -144,
      "y": 211,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 600,
        "h": 72
      }
    },
    {
      "kind": "static",
      "x": 754,
      "y": 81,
      "rot": 1.5707964,
      "shape": {
        "kind": "rect",
        "w": 600,
        "h": 72
      }
    },
    {
      "kind": "static",
      "x": 574,
      "y": -214,
      "rot": 1.5707964,
      "shape": {
        "kind": "rect",
        "w": 600,
        "h": 72
      }
    },
    {
      "kind": "static",
      "x": -64,
      "y": -85,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 16,
        "h": 80
      }
    },
    {
      "kind": "static",
      "x": 147,
      "y": 80,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 16,
        "h": 80
      }
    },
    {
      "kind": "static",
      "x": 495,
      "y": 160,
      "rot": 0.5235988,
      "shape": {
        "kind": "rect",
        "w": 16,
        "h": 80
      }
    },
    {
      "kind": "static",
      "x": 134,
      "y": 6.999996,
      "rot": -0.3926991,
      "shape": {
        "kind": "rect",
        "w": 16,
        "h": 80
      }
    },
    {
      "kind": "static",
      "x": -436,
      "y": -93,
      "rot": -0.1308997,
      "shape": {
        "kind": "rect",
        "w": 16,
        "h": 300
      }
    },
    {
      "kind": "static",
      "x": -553,
      "y": 267,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 16,
        "h": 150
      }
    },
    {
      "kind": "static",
      "x": -291,
      "y": -21,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 16,
        "h": 50
      }
    },
    {
      "kind": "static",
      "x": -316,
      "y": 22,
      "rot": 1.0471976,
      "shape": {
        "kind": "rect",
        "w": 16,
        "h": 50
      }
    },
    {
      "kind": "static",
      "x": -378,
      "y": 100,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 100,
        "h": 150
      }
    },
    {
      "kind": "static",
      "x": -695,
      "y": 200,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 300,
        "h": 16
      }
    },
    {
      "kind": "static",
      "x": -1005,
      "y": 384,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 150,
        "h": 16
      }
    },
    {
      "kind": "static",
      "x": -1325,
      "y": 224,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 1000,
        "h": 16
      }
    },
    {
      "kind": "static",
      "x": 55,
      "y": -117,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 16,
        "h": 16
      }
    },
    {
      "kind": "static",
      "x": -575,
      "y": 86,
      "rot": 0,
      "shape": {
        "kind": "circle",
        "r": 10
      }
    },
    {
      "kind": "static",
      "x": -183,
      "y": 15,
      "rot": 0,
      "shape": {
        "kind": "circle",
        "r": 68.51
      }
    },
    {
      "kind": "killzone",
      "x": -227,
      "y": 125,
      "rot": 0,
      "shape": {
        "kind": "rect",
        "w": 200,
        "h": 100
      }
    },
    {
      "kind": "static",
      "x": 440,
      "y": 215.00003,
      "rot": 1.0471976,
      "shape": {
        "kind": "rect",
        "w": 16,
        "h": 80
      }
    }
  ]
};
