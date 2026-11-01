// Généré par scripts/sync-da.mjs depuis D:\Mazz Laef\src\tokens. Ne pas modifier à la main.
export const MAZZ_EASINGS = {
  "mazzOrganic": "cubic-bezier(0.25, 0.1, 0.25, 1.0)",
  "mazzPrecision": "cubic-bezier(0.12, 0.98, 0.22, 1.0)",
  "mazzSoftSnap": "cubic-bezier(0.16, 1.0, 0.3, 1.0)",
  "mazzGerminate": "cubic-bezier(0.34, 1.25, 0.42, 1.0)",
  "mazzPropagate": "cubic-bezier(0.2, 0.8, 0.2, 1.0)",
  "mazzMechanical": "cubic-bezier(0.4, 0.0, 0.2, 1.0)",
  "mazzInhale": "cubic-bezier(0.42, 0.0, 0.58, 1.0)",
  "mazzExhale": "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
  "mazzElasticSoft": "cubic-bezier(0.175, 0.885, 0.32, 1.05)",
  "mazzCinematic": "cubic-bezier(0.65, 0.0, 0.15, 1.0)"
} as const;

export const MAZZ_SPRINGS = {
  "SOFT_ORGANIC": {
    "mass": 1,
    "stiffness": 75,
    "damping": 14
  },
  "MEDIUM_ORGANIC": {
    "mass": 0.8,
    "stiffness": 120,
    "damping": 18
  },
  "PRECISION": {
    "mass": 0.5,
    "stiffness": 240,
    "damping": 26
  },
  "MECHANICAL": {
    "mass": 1.4,
    "stiffness": 300,
    "damping": 34
  },
  "HEAVY": {
    "mass": 2.2,
    "stiffness": 180,
    "damping": 42
  },
  "MICRO": {
    "mass": 0.2,
    "stiffness": 420,
    "damping": 24
  }
} as const;

export type MazzSpring = keyof typeof MAZZ_SPRINGS;
