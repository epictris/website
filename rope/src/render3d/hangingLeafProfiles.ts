// Geometry data for the three supplied leaf silhouettes. Keep in sync with
// public/hanging-vines/leaves/manifest.json when regenerating the textures.
export type HangingLeafProfile = {
  shape: string;
  geometryAspect: number;
  baseUv: [number, number];
  tipUv: [number, number];
};

export const HANGING_LEAF_PROFILES: HangingLeafProfile[] = [
  {
    shape: 'heart',
    geometryAspect: 0.944444,
    baseUv: [0.5, 0.14899],
    tipUv: [0.459893, 0.954545],
  },
  {
    shape: 'lobed',
    geometryAspect: 1,
    baseUv: [0.5, 0.061934],
    tipUv: [0.397281, 0.941088],
  },
  {
    shape: 'heart-offset',
    geometryAspect: 0.984218,
    baseUv: [0.5, 0.180775],
    tipUv: [0.395044, 0.941176],
  },
];
