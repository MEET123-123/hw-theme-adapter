/**
 * Frontend-Inspired Transpiler: Raw Huawei Lockscreen XML -> ThemeDOM IR.
 *
 * Concepts borrowed from modern frontend responsive architecture:
 * - Virtual DOM / Node lifting with exact evaluated bounding boxes
 * - Media-role & semantic-role classification (background cover, hero, clock, date, weather, dock, widget_card, modal)
 * - Giant wrapper unwrapping & left/right dock splitting
 * - Scene & mutually-exclusive variant partitioning from visibility/alpha predicates
 * - Button hitbox binding to visual components
 */

import { createHash } from 'node:crypto';
import { walkElements } from '../xml/parser.js';
import {
  buildRuntimeContext,
  parseExprAst,
  evalAst,
  evalSettledExpr,
  evalOpenSlideExpr,
  astCollectVars,
} from '../expr/evaluator.js';

export const VISUAL_TAGS = new Set([
  'image', 'group', 'button', 'text', 'datetime',
  'imagenumber', 'imageseries', 'video', 'wallpaper',
  'rectangle', 'circle', 'arc', 'mediaicon', 'mediaprogressbar',
  'stereogroup', 'edittext', 'virtualscreen', 'slider', 'unlocker',
]);

const DESIGN_HEIGHT_CANDIDATES = [2400, 2340, 2520, 2160, 2600, 2640, 1920, 2244, 2280];

export function inferDesignCanvas(doc, assetIndex) {
  const root = doc.root;
  const baseW = Number(root?.attrs?.screenWidth) || 1080;

  // 1. Scan screen-derived <Var> expressions for design height constants
  const heightVotes = new Map();
  walkElements(root, (node) => {
    if (node.tagLower === 'var' && node.attrs.expression) {
      const expr = node.attrs.expression;
      if (/#screen_height|#h\b|#ysh\b/.test(expr)) {
        for (const h of DESIGN_HEIGHT_CANDIDATES) {
          if (new RegExp(`\\b${h}\\b`).test(expr)) {
            // Note: 1920 is often used as a legacy delta baseline (#screen_height - 1920)
            // Weight 2340/2400/2520 higher if both appear, or verify against assets
            const weight = h === 1920 ? 1 : 3;
            heightVotes.set(h, (heightVotes.get(h) || 0) + weight);
          }
        }
      }
    }
  });

  // 2. Check largest background/wallpaper asset aspect ratio normalized to baseW
  const largest = assetIndex ? assetIndex.findLargestMedia() : null;
  let assetNormH = null;
  if (largest && largest.width > 0 && largest.height > largest.width * 1.35) {
    assetNormH = Math.round((largest.height / largest.width) * baseW);
  }

  let baseH = 2400;
  if (heightVotes.size > 0) {
    const sorted = [...heightVotes.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const topH = sorted[0][0];
    if (topH === 1920 && assetNormH && assetNormH >= 2200) {
      // Legacy delta pattern: #screen_height - 1920 used on modern 2340/2400 phone canvas
      baseH = assetNormH >= 2380 && assetNormH <= 2440 ? 2400 : (assetNormH >= 2300 && assetNormH < 2380 ? 2340 : 2400);
    } else {
      baseH = topH;
    }
  } else if (assetNormH && assetNormH >= 1800 && assetNormH <= 2800) {
    // Snap near standard heights
    if (Math.abs(assetNormH - 2400) <= 60) baseH = 2400;
    else if (Math.abs(assetNormH - 2340) <= 60) baseH = 2340;
    else if (Math.abs(assetNormH - 2520) <= 60) baseH = 2520;
    else if (Math.abs(assetNormH - 1920) <= 60) baseH = 1920;
    else baseH = assetNormH;
  }

  return { baseW, baseH, assetNormH };
}

function splitVisibilityPredicates(ancestors, node) {
  const preds = [];
  const all = [...ancestors, node];
  for (const n of all) {
    if (n.attrs.visibility !== undefined) preds.push(n.attrs.visibility);
    if (n.attrs.alpha !== undefined && /(eq|ne|gt|ge|lt|le|not|ifelse)\s*\(/.test(n.attrs.alpha)) {
      preds.push(n.attrs.alpha);
    }
  }
  return preds;
}

function classifyScene(preds, nodeChain, baseW, bbox, inPagingDrawer = false) {
  if (inPagingDrawer) return 'drawer';
  const joined = preds.join(' ');
  const names = nodeChain.map(n => (n.attrs.name || '').toLowerCase()).join(' ');

  if (/charge_anim|battery_state|charge_level|charge_type|charge_mode|chongdian|cd_/.test(joined) || /charge|chongdian/.test(names)) {
    return 'charging';
  }
  if (/\bguide\b|suopingtips|teach|\byd\b/.test(joined) || /\bguide\b|tips/.test(names)) {
    return 'guide';
  }
  if (/more_st|set_go|set_touch|set_v|kzltc|rltc|wintc|setsho|mbdk|p_set|sec_page|\bpanel\b|\bmenu\b/.test(joined) || /setting|panel|menu/.test(names)) {
    return 'settings';
  }
  if (/oneSec|weightGroup|kp_ani|kpflag/.test(joined) || /weightgroup|drawer/.test(names)) {
    return 'drawer';
  }
  // Check if an ancestor Group has paging slide expression or the whole element lies strictly offscreen as a slide-in panel
  const isStrictlyOffscreen = bbox.x >= baseW * 0.85 || (bbox.x + bbox.w) <= baseW * 0.15;
  for (const n of nodeChain) {
    const xExpr = n.attrs.x || '';
    if (/oneSec|sec_page|page\d|_page/.test(xExpr) || (isStrictlyOffscreen && bbox.x > -4000 && bbox.x < 4000)) {
      return 'drawer';
    }
  }
  return 'main';
}

function extractVariantKey(preds) {
  const keys = [];
  for (const p of preds) {
    // Match eq(#var, 0) / eq(#var, 1) / ne(#var, 0) etc.
    const matches = p.matchAll(/(eq|ne|gt|ge|lt|le)\s*\(\s*#([A-Za-z0-9_.]+)\s*,\s*([^)]+)\)/g);
    for (const m of matches) {
      const fn = m[1];
      const v = m[2];
      const val = m[3].trim();
      // Skip transient step/battery/animation counters; focus on mode switches
      if (/^(steps|step|id|dh\d*|sj|time|second|minute|hour|date|month|year)$/.test(v)) continue;
      keys.push(`${v}:${fn}=${val}`);
    }
    // Also detect simple boolean #flag vs not(#flag)
    const notM = p.matchAll(/not\s*\(\s*#([A-Za-z0-9_.]+)\s*\)/g);
    for (const m of notM) {
      keys.push(`${m[1]}:not=1`);
    }
  }
  if (keys.length === 0) return null;
  return [...new Set(keys)].sort().join('&');
}

function checkCond(cond, x) {
  const [op, raw] = cond.split('=');
  const v = Number(raw);
  if (!Number.isFinite(v)) return true;
  switch (op) {
    case 'eq': return x === v;
    case 'ne': return x !== v;
    case 'gt': return x > v;
    case 'ge': return x >= v;
    case 'lt': return x < v;
    case 'le': return x <= v;
    case 'not': return x === 0;
    default: return true;
  }
}

export function areVariantsCompatible(vKeyA, vKeyB) {
  if (!vKeyA || !vKeyB) return true;
  const mapA = new Map();
  for (const part of vKeyA.split('&')) {
    const idx = part.indexOf(':');
    if (idx > 0) {
      const k = part.slice(0, idx);
      if (!mapA.has(k)) mapA.set(k, []);
      mapA.get(k).push(part.slice(idx + 1));
    }
  }
  const mapB = new Map();
  for (const part of vKeyB.split('&')) {
    const idx = part.indexOf(':');
    if (idx > 0) {
      const k = part.slice(0, idx);
      if (!mapB.has(k)) mapB.set(k, []);
      mapB.get(k).push(part.slice(idx + 1));
    }
  }
  for (const [varName, condsB] of mapB.entries()) {
    if (!mapA.has(varName)) continue;
    const allConds = [...mapA.get(varName), ...condsB];
    let anySatisfied = false;
    for (let x = -2; x <= 20; x++) {
      if (allConds.every(c => checkCond(c, x))) {
        anySatisfied = true;
        break;
      }
    }
    if (!anySatisfied) return false;
  }
  return true;
}

function estimateTextSize(node, ctx, scale = 1) {
  const size = Math.max(12, Number(ctx.eval(node.attrs.size ?? 40)) || 40);
  const wAttr = node.attrs.w !== undefined ? Number(ctx.eval(node.attrs.w)) : (node.attrs.width !== undefined ? Number(ctx.eval(node.attrs.width)) : null);
  const hAttr = node.attrs.h !== undefined ? Number(ctx.eval(node.attrs.h)) : null;

  let textSample = '10:08';
  if (node.tagLower === 'datetime') {
    const fmt = node.attrs.format || 'HH:mm';
    textSample = fmt
      .replace(/NNNN/g, '星期日')
      .replace(/EEEE/g, '星期日')
      .replace(/yyyy/gi, '2026')
      .replace(/MM/g, '11')
      .replace(/dd/g, '22')
      .replace(/HH|hh/g, '10')
      .replace(/mm/g, '08')
      .replace(/ss/g, '30');
  } else if (node.attrs.text) {
    textSample = node.attrs.text;
  } else if (node.attrs.textExp) {
    const evaluated = ctx.eval(node.attrs.textExp);
    if (evaluated !== undefined && evaluated !== null && String(evaluated) !== '0') {
      textSample = String(evaluated);
    } else {
      textSample = 'SampleText';
    }
  }

  // Approximate visual width: CJK ~ 1.0*size, ASCII ~ 0.58*size
  let estW = 0;
  for (const ch of String(textSample)) {
    estW += ch.charCodeAt(0) > 127 ? size * 1.02 : size * 0.58;
  }
  estW = Math.max(size * 1.2, estW);
  const estH = size * 1.25;

  return {
    w: wAttr && wAttr > 0 ? wAttr : estW,
    h: hAttr && hAttr > 0 ? hAttr : estH,
    textSample,
    fontSize: size,
  };
}

function estimateImageSize(node, ctx, assetIndex) {
  const wExplicit = node.attrs.w !== undefined ? Number(ctx.eval(node.attrs.w)) : null;
  const hExplicit = node.attrs.h !== undefined ? Number(ctx.eval(node.attrs.h)) : null;

  const src = node.attrs.src || null;
  const srcid = node.attrs.srcid !== undefined ? ctx.eval(node.attrs.srcid) : null;
  const srcExpVal = node.attrs.srcExp ? String(ctx.eval(node.attrs.srcExp)) : null;

  let resolvedAsset = null;
  let intrinsicDims = null;

  if (assetIndex) {
    resolvedAsset = assetIndex.resolveImageAsset({ src, srcid, srcExpVal });
    if (resolvedAsset) {
      intrinsicDims = assetIndex.getDimensions(resolvedAsset);
    }
  }

  const w = (wExplicit !== null && Number.isFinite(wExplicit) && wExplicit > 0)
    ? wExplicit
    : (intrinsicDims ? intrinsicDims.width : 80);
  const h = (hExplicit !== null && Number.isFinite(hExplicit) && hExplicit > 0)
    ? hExplicit
    : (intrinsicDims ? intrinsicDims.height : 80);

  return {
    w,
    h,
    hasExplicitW: wExplicit !== null && Number.isFinite(wExplicit) && wExplicit > 0,
    hasExplicitH: hExplicit !== null && Number.isFinite(hExplicit) && hExplicit > 0,
    intrinsicW: intrinsicDims ? intrinsicDims.width : w,
    intrinsicH: intrinsicDims ? intrinsicDims.height : h,
    resolvedAsset,
  };
}

function estimateImageNumberSize(node, ctx, assetIndex) {
  const src = node.attrs.src || null;
  const resolved = assetIndex ? assetIndex.resolveImageAsset({ src, srcid: '0' }) : null;
  const dims = resolved && assetIndex ? assetIndex.getDimensions(resolved) : null;
  const glyphW = dims ? dims.width : 48;
  const glyphH = dims ? dims.height : 72;
  const space = Number(ctx.eval(node.attrs.space ?? 0)) || 0;

  let str = '88';
  if (node.tagLower === 'imagenumber' && node.attrs.number !== undefined) {
    str = String(Math.trunc(Number(ctx.eval(node.attrs.number)) || 88));
  } else if (node.tagLower === 'imageseries' && node.attrs.string !== undefined) {
    const val = String(ctx.eval(node.attrs.string) || '88');
    str = val.length > 0 ? val : '88';
  }
  const len = Math.max(1, str.length);
  const wExplicit = node.attrs.w !== undefined ? Number(ctx.eval(node.attrs.w)) : null;
  const hExplicit = node.attrs.h !== undefined ? Number(ctx.eval(node.attrs.h)) : null;

  return {
    w: wExplicit && wExplicit > 0 ? wExplicit : len * glyphW + Math.max(0, len - 1) * space,
    h: hExplicit && hExplicit > 0 ? hExplicit : glyphH,
    glyphW,
    glyphH,
    resolvedAsset: resolved,
  };
}

function applyAlignment(x, y, w, h, align, alignV) {
  let left = x;
  let top = y;
  if (align === 'center') left -= w / 2;
  else if (align === 'right') left -= w;
  if (alignV === 'center') top -= h / 2;
  else if (alignV === 'bottom') top -= h;
  return { left, top };
}

export function classifyDynamicGroupAxis(exprStr, evalVal, refDim, ctx, thresholdRatio = 0.35) {
  if (!exprStr) return 'static';
  const dep = ctx.classifyExpr(exprStr);
  if (dep !== 'dynamic' && dep !== 'mixed') return 'static';
  return Math.abs(evalVal) >= refDim * thresholdRatio ? 'paging' : 'dynamic_inplace';
}

function classifyElementSemantic(node, bbox, baseW, baseH, ctx, inPagingDrawer = false, hasDynamicPos = false, hasOwnDynPos = false) {
  const t = node.tagLower;
  const name = (node.attrs.name || '').toLowerCase();
  const src = (node.attrs.src || node.attrs.srcExp || '').toLowerCase();
  const allAttrText = Object.values(node.attrs).join(' ');

  // Hidden utility elements (edittexts, sentinel -9999/+9999 storage, 1x1 preloads, or offscreen static dummies)
  if (t === 'edittext' || bbox.x <= -3500 || bbox.y <= -3500 || bbox.x >= 4500 || bbox.y >= 4500) {
    return 'hidden_utility';
  }
  if (t === 'image' && bbox.w <= 2 && bbox.h <= 2 && (bbox.x < 0 || bbox.y < 0)) {
    return 'hidden_utility';
  }
  if (!inPagingDrawer && !hasOwnDynPos && (
    bbox.x >= baseW * 1.5 || bbox.y >= baseH * 1.3 ||
    bbox.x + bbox.w <= -baseW * 0.5 || bbox.y + bbox.h <= -baseH * 0.3
  )) {
    return 'hidden_utility';
  }
  if (!inPagingDrawer && !hasDynamicPos && (
    bbox.x >= baseW * 1.5 || bbox.y >= baseH * 1.3 ||
    bbox.x + bbox.w <= -baseW * 0.5 || bbox.y + bbox.h <= -baseH * 0.3
  )) {
    return 'hidden_utility';
  }

  // Fullscreen gesture buttons
  if (t === 'button' && bbox.w >= baseW * 0.78 && bbox.h >= baseH * 0.65) {
    return 'fullscreen_gesture';
  }

  // Background candidates
  if (t === 'wallpaper') return 'background';
  if (t === 'video' && bbox.w >= baseW * 0.80 && bbox.h >= baseH * 0.65) return 'background';
  if (t === 'image') {
    const coversScreen = bbox.w >= baseW * 0.82 && bbox.h >= baseH * 0.65;
    const isCenterCropFull = node.attrs.scaleType === 'center_crop' && bbox.w >= baseW * 0.75 && bbox.h >= baseH * 0.60;
    const isBgName = /(^|\/)(bg|aod|wal|wallpaper|pabg|weightbg|bj|back)/.test(src) || /bg|wallpaper/.test(name);
    if (coversScreen || isCenterCropFull || (isBgName && bbox.w >= baseW * 0.80 && bbox.h >= baseH * 0.50)) {
      return 'background';
    }
  }

  // Clock
  if (t === 'datetime') {
    const fmt = (node.attrs.format || '').toLowerCase();
    if (/[hms]|a/.test(fmt) && !/[ymdne]/.test(fmt.replace(/am|pm/g, ''))) {
      return 'clock';
    }
    return 'date';
  }
  if (/hour|minute|system\.time|time_dot|shijian|clock/.test(allAttrText) || /time|clock/.test(name)) {
    return 'clock';
  }

  // Date / Week / Lunar
  if (/#(month|date|day_of_week|year)\b|date_|week_|lunar|rili|xingqi|cal_/.test(allAttrText) || /date|week|cal/.test(name)) {
    return 'date';
  }

  // Weather
  if (/weather\.|wea_|tq_|tianqi|wendu|currenttem/.test(allAttrText) || /weather|wea/.test(name)) {
    return 'weather';
  }

  // Music / Steps / Widgets
  if (t === 'mediaicon' || t === 'mediaprogressbar' || /media_|music/.test(allAttrText) || /music/.test(name)) {
    return 'widget_card';
  }
  if (/step|healthy|battery|charge|power|dl_/.test(allAttrText) || /step|music|card|widget|kuaijie/.test(name)) {
    return 'widget_card';
  }

  // Bottom dock shortcuts (flashlight, camera, quick actions truly pinned near bottom edge)
  const isCompactDock = bbox.h <= baseH * 0.20 && bbox.w <= baseW * 0.45;
  const distFromBottom = baseH - (bbox.y + bbox.h);
  const onScreenX = bbox.x >= -baseW * 0.2 && bbox.x + bbox.w <= baseW * 1.2;
  const nearBottom = onScreenX && distFromBottom >= -baseH * 0.15 && ((distFromBottom <= 240 && bbox.y >= baseH * 0.72) || (bbox.y >= baseH * 0.86 && bbox.y < baseH * 1.15));
  if (isCompactDock && (nearBottom || (distFromBottom <= 320 && bbox.y >= baseH * 0.78 && /flashlight|sdt|camera|xiangji/.test(allAttrText)))) {
    if (bbox.x + bbox.w / 2 < baseW * 0.38) return 'dock_left';
    if (bbox.x + bbox.w / 2 > baseW * 0.62) return 'dock_right';
    return 'dock_center';
  }

  if (t === 'button') return 'button';

  // Large hero vs smaller decoration
  if (bbox.w * bbox.h >= baseW * baseH * 0.12) return 'hero';
  return 'decoration';
}

export function isFullScreenNode(el) {
  return el.semanticRole === 'background' || el.semanticRole === 'fullscreen_gesture';
}

/**
 * Transpile a parsed Lockscreen XML document + AssetIndex into a ThemeDOM IR.
 */
function indexSourceNodes(root) {
  const paths = new Map();
  function visit(children, parentPath) {
    const occurrences = new Map();
    for (const node of children) {
      if (node.type !== 'element') continue;
      const label = node.attrs.name || node.attrs.id || node.attrs.src || node.attrs.srcExp || '';
      const segment = label ? `${node.tag}[${encodeURIComponent(label)}]` : node.tag;
      const occurrence = (occurrences.get(segment) ?? 0) + 1;
      occurrences.set(segment, occurrence);
      const origin = `${parentPath}/${segment}[${occurrence}]`;
      paths.set(node.nodeId, origin);
      visit(node.children, origin);
    }
  }
  visit([root], '');
  return paths;
}

export function transpileToThemeDOM(doc, assetIndex, themeName = 'unknown', {
  packageName = themeName, manifestPath = 'unlock/lockscreen/manifest.xml',
} = {}) {
  const root = doc.root;
  if (!root || root.tagLower !== 'lockscreen') {
    throw new Error(`Expected <Lockscreen> root in ${themeName}, got <${root?.tag}>`);
  }

  const { baseW, baseH, assetNormH } = inferDesignCanvas(doc, assetIndex);
  const ctx = buildRuntimeContext(root, baseW, baseH, {}, assetIndex);

  const elements = [];
  const nodeById = new Map();
  const pagingGroups = {};

  function traverse(node, ancestors, groupOffsetX, groupOffsetY, inPagingDrawer = false, hasDynamicAncestor = false) {
    if (!node || node.type !== 'element') return;
    nodeById.set(node.nodeId, node);
    const t = node.tagLower;

    // Skip non-rendering metadata/animation/trigger subtrees
    if (
      t === 'externalcommands' || t === 'triggers' || t === 'trigger' ||
      t === 'var' || t === 'vararray' || t === 'weather' || t === 'healthy' ||
      t === 'variablebinders' || t === 'mediacontrol' || t === 'mask' ||
      t.endsWith('animation') || t === 'aniframe' || t === 'source'
    ) {
      return;
    }

    if (t === 'group' || t === 'stereogroup') {
      const gxOrig = node.attrs.x !== undefined ? Number(ctx.eval(node.attrs.x)) || 0 : 0;
      const gyOrig = node.attrs.y !== undefined ? Number(ctx.eval(node.attrs.y)) || 0 : 0;
      let gx = gxOrig;
      let gy = gyOrig;
      const xExpr = node.attrs.x || '';
      const yExpr = node.attrs.y || '';
      const xMode = classifyDynamicGroupAxis(xExpr, gx, baseW, ctx, 0.35);
      const yMode = classifyDynamicGroupAxis(yExpr, gy, baseH, ctx, 0.18);
      const pagingX = xMode === 'paging';
      const pagingY = yMode === 'paging';
      const dynamicX = xMode !== 'static';
      const dynamicY = yMode !== 'static';
      let openX = 0;
      let openY = 0;
      if (pagingX) {
        const sGX = evalSettledExpr(xExpr, ctx);
        if (Number.isFinite(sGX) && sGX >= -baseW * 0.05 && sGX <= baseW * 0.75 && Math.abs(sGX - gxOrig) >= baseW * 0.20) {
          openX = sGX;
        } else {
          const slX = evalOpenSlideExpr(xExpr, ctx, -baseW * 0.05, baseW * 0.75);
          openX = slX ? slX.val : 0;
        }
        gx = openX;
      }
      if (pagingY) {
        const sGY = evalSettledExpr(yExpr, ctx);
        if (Number.isFinite(sGY) && sGY >= -baseH * 0.05 && sGY <= baseH * 0.75 && Math.abs(sGY - gyOrig) >= baseH * 0.20) {
          openY = sGY;
        } else {
          const slY = evalOpenSlideExpr(yExpr, ctx, -baseH * 0.05, baseH * 0.75);
          openY = slY ? slY.val : 0;
        }
        gy = openY;
      }
      if (dynamicX || dynamicY) {
        pagingGroups[node.nodeId] = { pagingX, pagingY, dynamicX, dynamicY, gx: gxOrig, gy: gyOrig, openX, openY };
      }
      const nextAnc = [...ancestors, node];
      const childPaging = inPagingDrawer || pagingX || pagingY;
      const childDyn = hasDynamicAncestor || dynamicX || dynamicY;
      for (const child of node.children) {
        traverse(child, nextAnc, groupOffsetX + gx, groupOffsetY + gy, childPaging, childDyn);
      }
      return;
    }

    if (!VISUAL_TAGS.has(t) || t === 'lockscreen') {
      for (const child of node.children) {
        traverse(child, ancestors, groupOffsetX, groupOffsetY, inPagingDrawer, hasDynamicAncestor);
      }
      return;
    }

    const rawX = node.attrs.x !== undefined ? Number(ctx.eval(node.attrs.x)) || 0 : 0;
    const rawY = node.attrs.y !== undefined ? Number(ctx.eval(node.attrs.y)) || 0 : 0;
    const xDep = node.attrs.x ? ctx.classifyExpr(node.attrs.x) : 'pure_const';
    const yDep = node.attrs.y ? ctx.classifyExpr(node.attrs.y) : 'pure_const';
    const hasOwnDynPos = xDep === 'dynamic' || xDep === 'mixed' || yDep === 'dynamic' || yDep === 'mixed';
    const hasDynamicPos = hasDynamicAncestor || hasOwnDynPos;

    let w = 0, h = 0;
    let extra = {};
    if (t === 'image' || t === 'wallpaper' || t === 'video' || t === 'mediaicon') {
      const info = estimateImageSize(node, ctx, assetIndex);
      w = info.w;
      h = info.h;
      extra = info;
    } else if (t === 'text' || t === 'datetime') {
      const info = estimateTextSize(node, ctx);
      w = info.w;
      h = info.h;
      extra = info;
    } else if (t === 'imagenumber' || t === 'imageseries') {
      const info = estimateImageNumberSize(node, ctx, assetIndex);
      w = info.w;
      h = info.h;
      extra = info;
    } else if (t === 'circle') {
      const r = Number(ctx.eval(node.attrs.r ?? 40)) || 40;
      w = 2 * r;
      h = 2 * r;
      extra = { r };
    } else {
      w = node.attrs.w !== undefined ? Number(ctx.eval(node.attrs.w)) || 0 : (node.attrs.width !== undefined ? Number(ctx.eval(node.attrs.width)) || 0 : 100);
      h = node.attrs.h !== undefined ? Number(ctx.eval(node.attrs.h)) || 0 : 100;
    }

    const align = t === 'button' ? 'left' : (node.attrs.align || 'left').toLowerCase();
    const alignV = t === 'button' ? 'top' : (node.attrs.alignV || 'top').toLowerCase();

    const { left: closedLeft, top: closedTop } = applyAlignment(groupOffsetX + rawX, groupOffsetY + rawY, w, h, align, alignV);
    const closedOffscreenX = (!inPagingDrawer && closedLeft + w <= 2) ? -1 : ((!inPagingDrawer && closedLeft >= baseW - 2) ? 1 : 0);
    const closedOffscreenY = (!inPagingDrawer && closedTop + h <= 2) ? -1 : ((!inPagingDrawer && closedTop >= baseH - 2) ? 1 : 0);

    let localX = rawX;
    let localY = rawY;
    let settledDeltaX = 0;
    let settledDeltaY = 0;
    let openSlideX = null;
    let openSlideY = null;
    let openSlideXVars = null;
    let openSlideYVars = null;

    if (closedOffscreenX !== 0 && (xDep === 'dynamic' || xDep === 'mixed')) {
      const slX = evalOpenSlideExpr(node.attrs.x, ctx, -baseW * 0.15 - groupOffsetX, baseW * 1.15 - groupOffsetX);
      if (slX) {
        localX = slX.val;
        settledDeltaX = slX.val - rawX;
        openSlideX = slX.val;
        openSlideXVars = slX.overrides;
      }
    }
    if (closedOffscreenY !== 0 && (yDep === 'dynamic' || yDep === 'mixed')) {
      const slY = evalOpenSlideExpr(node.attrs.y, ctx, -baseH * 0.15 - groupOffsetY, baseH * 1.15 - groupOffsetY);
      if (slY) {
        localY = slY.val;
        settledDeltaY = slY.val - rawY;
        openSlideY = slY.val;
        openSlideYVars = slY.overrides;
      }
    }

    let absOriginX = groupOffsetX + localX;
    let absOriginY = groupOffsetY + localY;
    let pageShiftX = 0;
    if (openSlideX === null && (xDep === 'dynamic' || xDep === 'mixed') && (absOriginX >= baseW * 1.15 || absOriginX <= -baseW * 0.35)) {
      const pIdx = Math.round(absOriginX / baseW);
      if (pIdx !== 0 && Math.abs(pIdx) <= 3) {
        pageShiftX = pIdx;
        absOriginX -= pIdx * baseW;
      }
    }

    const { left, top } = applyAlignment(absOriginX, absOriginY, w, h, align, alignV);

    const bbox = {
      x: Math.round(left * 100) / 100,
      y: Math.round(top * 100) / 100,
      w: Math.round(Math.max(0, w) * 100) / 100,
      h: Math.round(Math.max(0, h) * 100) / 100,
    };

    const preds = splitVisibilityPredicates(ancestors, node);
    let scene = classifyScene(preds, [...ancestors, node], baseW, bbox, inPagingDrawer || pageShiftX !== 0);
    if (scene === 'main' && (settledDeltaX !== 0 || settledDeltaY !== 0)) {
      scene = 'drawer';
    }
    const variantKey = extractVariantKey(preds);
    let semanticRole = classifyElementSemantic(node, bbox, baseW, baseH, ctx, inPagingDrawer || pageShiftX !== 0, hasDynamicPos, hasOwnDynPos);
    if (
      semanticRole !== 'hidden_utility' &&
      !inPagingDrawer &&
      !settledDeltaX &&
      !settledDeltaY &&
      !pageShiftX &&
      (bbox.x + bbox.w <= 2 || bbox.x >= baseW - 2 || bbox.y + bbox.h <= 2 || bbox.y >= baseH - 2)
    ) {
      semanticRole = 'offscreen_ambient';
    }

    // Inspect child <Mask> if any
    const masks = node.children.filter(c => c.type === 'element' && c.tagLower === 'mask');

    elements.push({
      nodeId: node.nodeId,
      tag: node.tag,
      tagLower: t,
      name: node.attrs.name || null,
      ancestorGroupIds: ancestors.map(a => a.nodeId),
      parentGroupId: ancestors.length > 0 ? ancestors[ancestors.length - 1].nodeId : null,
      bbox,
      originX: absOriginX,
      originY: absOriginY,
      groupOffsetX,
      groupOffsetY,
      settledDeltaX,
      settledDeltaY,
      closedOffscreenX,
      closedOffscreenY,
      closedRawX: rawX,
      closedRawY: rawY,
      openSlideX,
      openSlideY,
      openSlideXVars,
      openSlideYVars,
      pageShiftX,
      hasDynamicPos,
      align,
      alignV,
      scene,
      variantKey,
      semanticRole,
      hasMasks: masks.length > 0,
      masks: masks.map(m => ({
        nodeId: m.nodeId,
        align: (m.attrs.align || 'relative').toLowerCase(),
      })),
      extra,
    });
  }

  for (const child of root.children) {
    traverse(child, [root], 0, 0);
  }

  // Lift Elements into Responsive Components
  const components = liftElementsToComponents(elements, nodeById, baseW, baseH, pagingGroups);
  const sourcePaths = indexSourceNodes(root);
  for (const element of elements) {
    element.sourcePath = sourcePaths.get(element.nodeId);
  }
  for (const component of components) {
    const memberPaths = component.memberIds.map(id => sourcePaths.get(id)).sort();
    const identity = [packageName, manifestPath, component.semanticRole, memberPaths];
    component.stableKey = 'cmp_' + createHash('sha256').update(JSON.stringify(identity)).digest('base64url').slice(0, 22);
  }

  return {
    schemaVersion: '1.0',
    themeName,
    source: { packageName, manifestPath },
    canvas: {
      baseW,
      baseH,
      aspectRatio: Math.round((baseW / baseH) * 10000) / 10000,
      assetNormH,
    },
    scenes: [...new Set(components.map(c => c.scene))],
    pagingGroups,
    elements,
    components,
    stats: {
      totalElements: elements.length,
      totalComponents: components.length,
      backgrounds: components.filter(c => c.semanticRole === 'background').length,
      fullscreenGestures: components.filter(c => c.semanticRole === 'fullscreen_gesture').length,
      foregroundComponents: components.filter(c => !isFullScreenNode(c) && c.semanticRole !== 'hidden_utility' && c.semanticRole !== 'offscreen_ambient').length,
    },
  };
}

function bboxUnion(boxes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (b.w <= 0 && b.h <= 0) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: Math.round(minX * 100) / 100,
    y: Math.round(minY * 100) / 100,
    w: Math.round(Math.max(1, maxX - minX) * 100) / 100,
    h: Math.round(Math.max(1, maxY - minY) * 100) / 100,
  };
}

function intersectionArea(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

function liftElementsToComponents(elements, nodeById, baseW, baseH, pagingGroups = {}) {
  const components = [];
  let compSeq = 1;

  const makeComp = ({ scene, variantKey, semanticRole, members, ownerGroupId = null, isModal = false }) => {
    const id = `comp_${compSeq++}`;
    const bbox = bboxUnion(members.map(m => m.bbox));
    const role = isModal ? 'modal_panel' : semanticRole;
    const comp = {
      id,
      scene,
      variantKey,
      semanticRole: role,
      ownerGroupId,
      bbox,
      memberIds: members.map(m => m.nodeId),
      boundButtonIds: [],
      layoutPolicy: deriveLayoutPolicy(role, bbox, baseW, baseH),
    };
    components.push(comp);
    return comp;
  };

  // 1. Separate out hidden_utility, background, fullscreen_gesture immediately
  const normalVisuals = [];
  const buttons = [];

  for (const el of elements) {
    if (el.semanticRole === 'hidden_utility') {
      continue;
    }
    if (el.semanticRole === 'offscreen_ambient') {
      makeComp({
        scene: el.scene,
        variantKey: el.variantKey,
        semanticRole: 'offscreen_ambient',
        members: [el],
      });
      continue;
    }
    if (el.semanticRole === 'background') {
      makeComp({
        scene: el.scene,
        variantKey: el.variantKey,
        semanticRole: 'background',
        members: [el],
      });
      continue;
    }
    if (el.semanticRole === 'fullscreen_gesture') {
      makeComp({
        scene: el.scene,
        variantKey: el.variantKey,
        semanticRole: 'fullscreen_gesture',
        members: [el],
      });
      continue;
    }
    if (el.semanticRole === 'button') {
      buttons.push(el);
      continue;
    }
    normalVisuals.push(el);
  }

  // 2. Group normalVisuals by their immediate meaningful ancestor group, unwrapping giant screen-sized wrappers!
  // Determine which Groups are giant wrappers: span > 75% W and > 62% H with >= 2 spatially separated sub-clusters,
  // OR dock-splitting Groups with far-left + far-right items.
  const groupMembers = new Map(); // groupId -> elements[]
  for (const el of normalVisuals) {
    // Pick the deepest non-root Group, or root itself if direct child of Lockscreen
    const gId = el.parentGroupId;
    if (!groupMembers.has(gId)) groupMembers.set(gId, []);
    groupMembers.get(gId).push(el);
  }

  // Check if any group (excluding root) should be unwrapped or split
  const rootId = elements[0]?.ancestorGroupIds?.[0] || 'n_1';
  const ungroupedPool = [];

  for (const [gId, members] of groupMembers.entries()) {
    if (gId === rootId || !gId) {
      ungroupedPool.push(...members);
      continue;
    }

    // Always unwrap paging groups or groups containing paged/settled/ambient elements so transforms stay exact
    if (pagingGroups[gId]?.pagingX || pagingGroups[gId]?.pagingY || members.some(m => m.pageShiftX || m.settledDeltaX || m.settledDeltaY || m.openSlideX !== null || m.openSlideY !== null || m.semanticRole === 'offscreen_ambient')) {
      ungroupedPool.push(...members);
      continue;
    }

    const gNode = nodeById.get(gId);
    const box = bboxUnion(members.map(m => m.bbox));
    const scene = members[0].scene;

    // Check if bottom dock Group spans left & right corners -> split into dock_left / dock_right
    const allBottomDock = members.every(m => m.bbox.y >= baseH * 0.78 && m.bbox.h <= baseH * 0.22);
    const hasLeft = members.some(m => m.bbox.x + m.bbox.w / 2 < baseW * 0.35);
    const hasRight = members.some(m => m.bbox.x + m.bbox.w / 2 > baseW * 0.65);
    if (allBottomDock && hasLeft && hasRight && box.w > baseW * 0.65) {
      const leftM = members.filter(m => m.bbox.x + m.bbox.w / 2 < baseW * 0.50);
      const rightM = members.filter(m => m.bbox.x + m.bbox.w / 2 >= baseW * 0.50);
      if (leftM.length) makeComp({ scene, variantKey: leftM[0].variantKey, semanticRole: 'dock_left', members: leftM });
      if (rightM.length) makeComp({ scene, variantKey: rightM[0].variantKey, semanticRole: 'dock_right', members: rightM });
      continue;
    }

    // Check if giant screen-covering wrapper Group -> unwrap into semantic clusters
    const isGiantWrapper = box.w > baseW * 0.78 && box.h > baseH * 0.62 && members.length >= 4;
    if (isGiantWrapper) {
      ungroupedPool.push(...members);
      continue;
    }

    // Otherwise lift the Group as one cohesive component
    const role = pickDominantRole(members, gNode, box, baseW, baseH);
    makeComp({
      scene,
      variantKey: members[0].variantKey,
      semanticRole: role,
      members,
      ownerGroupId: gId,
    });
  }

  // 3. Cluster ungroupedPool elements by (scene, variantKey, semanticRole / spatial proximity)
  const buckets = new Map();
  for (const el of ungroupedPool) {
    const key = `${el.scene}|${el.variantKey || ''}|${el.semanticRole}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(el);
  }

  for (const [, list] of buckets.entries()) {
    const role = list[0].semanticRole;
    const scene = list[0].scene;
    const variantKey = list[0].variantKey;

    // Spatial clustering: merge elements whose expanded bounding boxes (pad 60px) overlap
    const clusters = clusterByProximity(list, role === 'clock' || role === 'date' || role === 'weather' ? 90 : 45);
    for (const cluster of clusters) {
      const box = bboxUnion(cluster.map(m => m.bbox));
      const finalRole = role === 'decoration' && box.w * box.h >= baseW * baseH * 0.10 ? 'hero' : role;
      makeComp({
        scene,
        variantKey,
        semanticRole: finalRole,
        members: cluster,
      });
    }
  }

  // 4. Bind every non-fullscreen Button to its best matching same-state/same-scene visual component
  const fgComps = components.filter(c => !isFullScreenNode(c) && c.semanticRole !== 'offscreen_ambient');
  const elById = new Map(elements.map(e => [e.nodeId, e]));
  const compParentGroups = new Map();
  for (const c of fgComps) {
    const pset = new Set();
    for (const mid of c.memberIds) {
      const m = elById.get(mid);
      if (m && m.parentGroupId && m.parentGroupId !== rootId) pset.add(m.parentGroupId);
    }
    compParentGroups.set(c.id, pset);
  }

  for (const btn of buttons) {
    let bestComp = null;
    let bestScore = 0;

    for (const c of fgComps) {
      if (c.scene !== btn.scene) continue;
      if (btn.variantKey && c.variantKey && !areVariantsCompatible(btn.variantKey, c.variantKey)) continue;

      const sameOwner = Boolean(c.ownerGroupId && btn.parentGroupId === c.ownerGroupId);
      const sameParentGroup = Boolean(btn.parentGroupId && btn.parentGroupId !== rootId && compParentGroups.get(c.id)?.has(btn.parentGroupId));

      // Prevent state-scoped buttons from being hijacked by unscoped Scene-1 components
      if (btn.variantKey !== null && c.variantKey === null && !sameOwner && !sameParentGroup) {
        continue;
      }

      const inter = intersectionArea(btn.bbox, c.bbox);
      if (inter <= 0 && !sameOwner) continue;

      let score = 0;
      if (sameOwner) score += 1000;
      else if (sameParentGroup) score += 500;
      if (btn.variantKey === c.variantKey) score += 800;
      else if (btn.variantKey === null && c.variantKey !== null && !sameOwner && !sameParentGroup) score -= 500;

      if (inter > 0) {
        const btnArea = Math.max(1, btn.bbox.w * btn.bbox.h);
        const cArea = Math.max(1, c.bbox.w * c.bbox.h);
        score += (inter / btnArea) * 100 + (inter / Math.min(btnArea, cArea)) * 50;
      }

      if (score > bestScore) {
        bestScore = score;
        bestComp = c;
      }
    }

    if (bestComp && bestScore > 10) {
      bestComp.boundButtonIds.push(btn.nodeId);
    } else {
      // Standalone interactive button without an overlapping visual component
      const role = classifyElementSemantic(
        { tagLower: 'button', attrs: { name: btn.name || '' } },
        btn.bbox,
        baseW,
        baseH,
        null
      );
      const comp = makeComp({
        scene: btn.scene,
        variantKey: btn.variantKey,
        semanticRole: role === 'button' ? 'decoration' : role,
        members: [btn],
      });
      comp.boundButtonIds.push(btn.nodeId);
    }
  }

  // 5. Enforce exclusive ownerGroupId: a Group can only own a component if all non-hidden
  //    visual descendants inside that Group belong to that single component.
  const activeEls = elements.filter(e => e.semanticRole !== 'hidden_utility');
  for (const c of components) {
    if (!c.ownerGroupId) continue;
    const owned = new Set([...c.memberIds, ...c.boundButtonIds]);
    for (const el of activeEls) {
      if (el.ancestorGroupIds.includes(c.ownerGroupId) && !owned.has(el.nodeId)) {
        c.ownerGroupId = null;
        break;
      }
    }
  }

  // Promote single-component overlay scenes (settings/guide/charging) to modal_panel;
  // multi-component overlay scenes keep distinct semantic roles so components don't pile on each other.
  for (const modalScene of ['settings', 'guide', 'charging']) {
    const scFg = components.filter(c => c.scene === modalScene && !isFullScreenNode(c));
    if (scFg.length === 1) {
      scFg[0].semanticRole = 'modal_panel';
      scFg[0].layoutPolicy = deriveLayoutPolicy('modal_panel', scFg[0].bbox, baseW, baseH);
    }
  }

  return components;
}

function clusterByProximity(items, pad = 50) {
  if (items.length <= 1) return items.map(i => [i]);
  const visited = new Array(items.length).fill(false);
  const clusters = [];

  const boxesOverlap = (a, b) => {
    return !(
      a.x + a.w + pad < b.x ||
      b.x + b.w + pad < a.x ||
      a.y + a.h + pad < b.y ||
      b.y + b.h + pad < a.y
    );
  };

  for (let i = 0; i < items.length; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const queue = [items[i]];
    const cluster = [items[i]];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (let j = 0; j < items.length; j++) {
        if (visited[j]) continue;
        if (boxesOverlap(cur.bbox, items[j].bbox)) {
          visited[j] = true;
          queue.push(items[j]);
          cluster.push(items[j]);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function pickDominantRole(members, groupNode, box, baseW, baseH) {
  const gName = (groupNode?.attrs?.name || '').toLowerCase();
  if (/clock|time|lockgroup/.test(gName)) return 'clock';
  if (/music|step|card|widget|kuaijie|cold/.test(gName)) return 'widget_card';
  if (/weather/.test(gName)) return 'weather';
  if (/date|cal/.test(gName)) return 'date';

  const counts = new Map();
  for (const m of members) {
    counts.set(m.semanticRole, (counts.get(m.semanticRole) || 0) + 1);
  }
  const canBeDock = box.w <= baseW * 0.48 && box.h <= baseH * 0.24 && (baseH - (box.y + box.h) <= 260 || box.y >= baseH * 0.82);
  for (const priority of ['clock', 'weather', 'date', 'widget_card', 'dock_left', 'dock_right', 'dock_center', 'hero']) {
    if (priority.startsWith('dock_') && !canBeDock) continue;
    if (counts.has(priority)) return priority;
  }
  if (box.w * box.h >= baseW * baseH * 0.12) return 'hero';
  return 'decoration';
}

function deriveLayoutPolicy(role, bbox, baseW, baseH) {
  if (role === 'background') {
    return { fit: 'cover', focalY: bbox.h > bbox.w * 1.3 ? 0.38 : 0.5, preserveAspect: true };
  }
  if (role === 'fullscreen_gesture') {
    return { fit: 'stretch_viewport', preserveAspect: false };
  }
  if (role === 'dock_left') {
    return { anchor: 'bottom_left', pane: 'dock', preserveAspect: true };
  }
  if (role === 'dock_right') {
    return { anchor: 'bottom_right', pane: 'dock', preserveAspect: true };
  }
  if (role === 'dock_center') {
    return { anchor: 'bottom_center', pane: 'dock', preserveAspect: true };
  }
  if (role === 'clock' || role === 'date' || role === 'weather') {
    return {
      anchor: bbox.y + bbox.h / 2 < baseH * 0.40 ? 'top' : 'middle',
      pane: 'left_primary',
      preserveAspect: true,
    };
  }
  if (role === 'modal_panel') {
    return { anchor: 'center', pane: 'modal', preserveAspect: true };
  }
  return {
    anchor: bbox.y + bbox.h / 2 < baseH * 0.35 ? 'top' : (bbox.y > baseH * 0.75 ? 'bottom' : 'center'),
    pane: 'right_content',
    preserveAspect: true,
  };
}
