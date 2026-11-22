/**
 * Huawei Full-Form-Factor Device Registry & 5-Breakpoint Classifier.
 *
 * Covers standard phones, Huawei Pura X / Pura X MAX (16:10 / ~14:10 wide foldables & cover),
 * Mate X6 Dual-Fold, Mate XT Tri-Fold (Single / Dual / Triple), and MatePad Tablets.
 */

export const BREAKPOINTS = [
  'portrait_tall',     // ar < 0.56
  'wide_portrait',     // 0.56 <= ar < 0.78
  'square_fold',       // 0.78 <= ar < 1.15
  'landscape_tablet',  // 1.15 <= ar < 1.85
  'landscape_wide',    // ar >= 1.85
];

export function getDeviceBreakpoint(w, h) {
  const ar = w / Math.max(1, h);
  if (ar < 0.56) return 'portrait_tall';
  if (ar < 0.78) return 'wide_portrait';
  if (ar < 1.15) return 'square_fold';
  if (ar < 1.85) return 'landscape_tablet';
  return 'landscape_wide';
}

function makeDevice(spec) {
  const virtualW = 1080;
  const virtualH = Math.round((virtualW * spec.physH) / spec.physW);
  const ar = virtualW / Math.max(1, virtualH);
  return {
    ...spec,
    w: virtualW,
    h: virtualH,
    aspectRatio: Math.round(ar * 10000) / 10000,
    breakpoint: getDeviceBreakpoint(virtualW, virtualH),
    safeArea: spec.safeArea || { top: 20, right: 24, bottom: 20, left: 24 },
    hinges: spec.hinges || [],
    isCompactCover: Boolean(spec.isCompactCover),
  };
}

export const HUAWEI_DEVICES = {
  phone_2400: makeDevice({
    id: 'phone_2400',
    label: '直板手机 20:9 (1080×2400)',
    category: 'phone',
    physW: 1080,
    physH: 2400,
    safeArea: { top: 24, right: 16, bottom: 24, left: 16 },
  }),
  phone_2340: makeDevice({
    id: 'phone_2340',
    label: '直板手机 19.5:9 (1080×2340)',
    category: 'phone',
    physW: 1080,
    physH: 2340,
    safeArea: { top: 24, right: 16, bottom: 24, left: 16 },
  }),
  mate_xt_single: makeDevice({
    id: 'mate_xt_single',
    label: '三折叠 Mate XT 单屏态 (1008×2232)',
    category: 'tri_fold_single',
    physW: 1008,
    physH: 2232,
    safeArea: { top: 24, right: 16, bottom: 24, left: 16 },
  }),
  phone_1920: makeDevice({
    id: 'phone_1920',
    label: '直板手机 16:9 (1080×1920)',
    category: 'phone',
    physW: 1080,
    physH: 1920,
    safeArea: { top: 20, right: 16, bottom: 20, left: 16 },
  }),
  pura_x_portrait: makeDevice({
    id: 'pura_x_portrait',
    label: 'Pura X 内屏竖屏 16:10 (1320×2120)',
    category: 'pura_x',
    physW: 1320,
    physH: 2120,
    safeArea: { top: 24, right: 24, bottom: 24, left: 24 },
  }),
  pura_x_max_portrait: makeDevice({
    id: 'pura_x_max_portrait',
    label: 'Pura X MAX 内屏竖屏 (1828×2584)',
    category: 'pura_x_max',
    physW: 1828,
    physH: 2584,
    safeArea: { top: 24, right: 24, bottom: 24, left: 24 },
  }),
  tablet_portrait: makeDevice({
    id: 'tablet_portrait',
    label: 'MatePad 平板竖屏 (1600×2560)',
    category: 'tablet',
    physW: 1600,
    physH: 2560,
    safeArea: { top: 24, right: 28, bottom: 24, left: 28 },
  }),
  pura_x_cover: makeDevice({
    id: 'pura_x_cover',
    label: 'Pura X 外屏 1:1 (980×980)',
    category: 'pura_x_cover',
    physW: 980,
    physH: 980,
    isCompactCover: true,
    safeArea: { top: 24, right: 28, bottom: 24, left: 28 },
  }),
  dual_fold_unfolded: makeDevice({
    id: 'dual_fold_unfolded',
    label: '双折叠 Mate X6 展开态 (2240×2440)',
    category: 'dual_fold',
    physW: 2240,
    physH: 2440,
    hinges: [{ axis: 'x', pos: 540, width: 44 }],
    safeArea: { top: 28, right: 28, bottom: 28, left: 28 },
  }),
  tri_fold_dual: makeDevice({
    id: 'tri_fold_dual',
    label: '三折叠 Mate XT 双屏态 (2048×2232)',
    category: 'tri_fold_dual',
    physW: 2048,
    physH: 2232,
    hinges: [{ axis: 'x', pos: 540, width: 44 }],
    safeArea: { top: 28, right: 28, bottom: 28, left: 28 },
  }),
  pura_x_land: makeDevice({
    id: 'pura_x_land',
    label: 'Pura X 内屏横屏 16:10 (2120×1320)',
    category: 'pura_x_land',
    physW: 2120,
    physH: 1320,
    safeArea: { top: 24, right: 32, bottom: 24, left: 32 },
  }),
  pura_x_max_land: makeDevice({
    id: 'pura_x_max_land',
    label: 'Pura X MAX 内屏横屏 (2584×1828)',
    category: 'pura_x_max_land',
    physW: 2584,
    physH: 1828,
    safeArea: { top: 24, right: 32, bottom: 24, left: 32 },
  }),
  tri_fold_triple: makeDevice({
    id: 'tri_fold_triple',
    label: '三折叠 Mate XT 三屏展开 (3184×2232)',
    category: 'tri_fold_triple',
    physW: 3184,
    physH: 2232,
    hinges: [
      { axis: 'x', pos: 360, width: 32 },
      { axis: 'x', pos: 720, width: 32 },
    ],
    safeArea: { top: 24, right: 28, bottom: 24, left: 28 },
  }),
  tablet_land: makeDevice({
    id: 'tablet_land',
    label: 'MatePad 平板横屏 (2560×1600)',
    category: 'tablet_land',
    physW: 2560,
    physH: 1600,
    safeArea: { top: 24, right: 32, bottom: 24, left: 32 },
  }),
  phone_land: makeDevice({
    id: 'phone_land',
    label: '手机超宽横屏 (2400×1080)',
    category: 'phone_land',
    physW: 2400,
    physH: 1080,
    safeArea: { top: 16, right: 32, bottom: 16, left: 32 },
  }),
};

export const DEFAULT_VALIDATION_DEVICES = [
  HUAWEI_DEVICES.phone_2400,
  HUAWEI_DEVICES.pura_x_portrait,
  HUAWEI_DEVICES.pura_x_max_portrait,
  HUAWEI_DEVICES.pura_x_cover,
  HUAWEI_DEVICES.dual_fold_unfolded,
  HUAWEI_DEVICES.tri_fold_triple,
  HUAWEI_DEVICES.tablet_land,
  HUAWEI_DEVICES.phone_land,
];

export function resolveDeviceProfile(w, h, idOrHint = null) {
  if (idOrHint && Object.hasOwn(HUAWEI_DEVICES, idOrHint)) {
    return HUAWEI_DEVICES[idOrHint];
  }
  for (const dev of Object.values(HUAWEI_DEVICES)) {
    if (dev.w === w && dev.h === h) return dev;
  }
  return makeDevice({
    id: `custom_${w}x${h}`,
    label: `Custom (${w}×${h})`,
    category: 'custom',
    physW: w,
    physH: h,
  });
}
