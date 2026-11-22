/**
 * Pluggable Custom Layout Algorithm Interface & ConstraintGuard.
 *
 * Allows plugging in custom rule-based solvers, CSS-override layouts, or external Python/VLM
 * predictions (via Format A component transforms or Format B target bboxes).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { areVariantsCompatible, isFullScreenNode } from '../ir/transpiler.js';
import { INTRA_LAYOUT_MODES, solveIntraContainerLayout } from './container_tree.js';

const REGISTRY = new Map();

export function registerAlgorithm(name, solverObj) {
  if (!name || !solverObj || typeof solverObj.solve !== 'function') {
    throw new Error(`Invalid layout algorithm "${name}": must provide { solve(request) }`);
  }
  REGISTRY.set(name, solverObj);
}

export function getAlgorithm(name = 'hwflex') {
  return REGISTRY.get(name) || null;
}

export function listAlgorithms() {
  return [...REGISTRY.keys()];
}

/**
 * Load either a built-in algorithm name, an external JS plugin exporting `solve(request)`,
 * or a static JSON file containing Format A / Format B layout outputs.
 */
export async function loadExternalAlgorithm(spec) {
  if (!spec) return getAlgorithm('hwflex');
  if (REGISTRY.has(spec)) return REGISTRY.get(spec);

  const absPath = path.resolve(spec);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Layout algorithm not found: "${spec}" (registered: ${listAlgorithms().join(', ')})`);
  }

  if (absPath.toLowerCase().endsWith('.json')) {
    const rawJson = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return {
      name: path.basename(absPath),
      solve(request) {
        const deviceResult = rawJson.by_device?.[request.device.id] ?? rawJson;
        return deviceResult.by_scene?.[request.scene] ?? deviceResult;
      },
    };
  }

  const mod = await import(pathToFileURL(absPath).href);
  const fn = typeof mod.solve === 'function' ? mod.solve : (typeof mod.default === 'function' ? mod.default : mod.default?.solve);
  if (typeof fn !== 'function') {
    throw new Error(`Plugin "${spec}" must export a solve(request) function`);
  }
  const plugin = { name: mod.name || path.basename(absPath), solve: fn };
  registerAlgorithm(spec, plugin);
  return plugin;
}

export function isSolverComponent(component, scene) {
  return component.scene === scene && !isFullScreenNode(component) &&
    component.semanticRole !== 'hidden_utility' && component.semanticRole !== 'offscreen_ambient';
}

export function buildLayoutRequest(themeDOM, deviceProfile, scene, cssOverrides = null, containerTree = null) {
  const comps = themeDOM.components.filter(c => isSolverComponent(c, scene));
  const macroContainers = containerTree?.byScene?.[scene]?.containers || [];
  return {
    schema_version: '2.0',
    theme_name: themeDOM.themeName,
    source: themeDOM.source,
    source_canvas: { w: themeDOM.canvas.baseW, h: themeDOM.canvas.baseH },
    device: {
      id: deviceProfile.id,
      label: deviceProfile.label,
      breakpoint: deviceProfile.breakpoint,
      w: deviceProfile.w,
      h: deviceProfile.h,
      safeArea: deviceProfile.safeArea,
      hinges: deviceProfile.hinges || [],
      isCompactCover: Boolean(deviceProfile.isCompactCover),
    },
    scene,
    components: comps.map(c => ({
      id: c.id,
      stableKey: c.stableKey,
      semanticRole: c.semanticRole,
      variantKey: c.variantKey,
      bbox: [c.bbox.x, c.bbox.y, c.bbox.w, c.bbox.h],
      layoutPolicy: c.layoutPolicy,
      cssOverride: cssOverrides?.get(c.stableKey) ?? cssOverrides?.get(c.id) ?? null,
    })),
    macro_containers: macroContainers.map(mc => ({
      id: mc.id,
      kind: mc.kind,
      label: mc.label,
      semanticRole: mc.semanticRole,
      pane: mc.pane,
      variantKey: mc.variantKey,
      bbox: [mc.bbox.x, mc.bbox.y, mc.bbox.w, mc.bbox.h],
      intraLayout: mc.intraLayout,
      align: mc.align,
      justify: mc.justify,
      gap: mc.gap,
      cols: mc.cols,
      layoutPolicy: mc.macroComponent?.layoutPolicy || null,
      children: mc.children.map(ch => ({
        id: ch.id,
        stableKey: ch.stableKey,
        semanticRole: ch.semanticRole,
        bbox: [ch.bbox.x, ch.bbox.y, ch.bbox.w, ch.bbox.h],
      })),
    })),
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function checkedNumber(value, label) {
  if ((typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) || !Number.isFinite(Number(value))) {
    throw new Error(`Layout response has invalid numeric field ${label}`);
  }
  return Number(value);
}

function readTransform(transform, id) {
  if (!isRecord(transform)) throw new Error(`Layout transform for ${id} must be an object`);
  const sx = checkedNumber(transform.sx, `${id}.sx`);
  const sy = checkedNumber(transform.sy === undefined ? sx : transform.sy, `${id}.sy`);
  if (sx <= 0 || sy <= 0) throw new Error(`Layout scales for ${id} must be positive`);
  return { sx, sy, tx: checkedNumber(transform.tx, `${id}.tx`), ty: checkedNumber(transform.ty, `${id}.ty`) };
}

function readBox(box, id, xScale, yScale) {
  if (!Array.isArray(box) || box.length !== 4) throw new Error(`Layout bbox for ${id} must contain [x, y, w, h]`);
  const [x, y, w, h] = box.map((value, index) => checkedNumber(value, `${id}[${index}]`));
  if (w <= 0 || h <= 0) throw new Error(`Layout bbox dimensions for ${id} must be positive`);
  return [x * xScale, y * yScale, w * xScale, h * yScale];
}

function normalizeContainerOverride(override, id) {
  if (override === undefined) return {};
  if (!isRecord(override)) throw new Error(`Container override for ${id} must be an object`);
  const out = {};
  for (const [key, value] of Object.entries(override)) {
    if (key === 'intraLayout' && INTRA_LAYOUT_MODES.includes(value) ||
        key === 'align' && ['start', 'center', 'end', 'stretch'].includes(value) ||
        key === 'justify' && ['pack', 'center', 'space_between', 'space_evenly'].includes(value)) {
      out[key] = value;
    } else if (['gap', 'padding', 'cols'].includes(key) && value === null) {
      out[key] = null;
    } else if (['gap', 'padding', 'cols'].includes(key)) {
      const number = checkedNumber(value, `${id}.${key}`);
      if (number < 0 || (key === 'cols' && (!Number.isInteger(number) || number < 1))) {
        throw new Error(`Invalid container override ${id}.${key}`);
      }
      out[key] = number;
    } else {
      throw new Error(`Unsupported container override ${id}.${key}: ${value}`);
    }
  }
  return { ...out, explicitOverride: true };
}

export function normalizeAlgorithmResponse(rawResponse, comps, deviceProfile, containerTree = null, scene = 'main') {
  const out = new Map();
  if (rawResponse == null) return out;
  if (rawResponse instanceof Map) rawResponse = { components: Object.fromEntries(rawResponse) };
  if (!isRecord(rawResponse)) throw new Error('Layout response must be a synchronous object or Map');

  const compMap = new Map(comps.map(c => [c.id, c]));
  for (const c of comps) {
    if (c.stableKey) compMap.set(c.stableKey, c);
  }
  const { w: vpW, h: vpH } = deviceProfile;
  const coordinates = rawResponse.coordinate_system ?? 'virtual_px';
  if (!['virtual_px', 'normalized_1000'].includes(coordinates)) {
    throw new Error(`Unknown layout coordinate system: ${coordinates}`);
  }
  const normX = coordinates === 'normalized_1000' ? vpW / 1000 : 1;
  const normY = coordinates === 'normalized_1000' ? vpH / 1000 : 1;
  for (const key of ['components', 'bboxes', 'macro_bboxes', 'container_overrides']) {
    if (Object.hasOwn(rawResponse, key) && !isRecord(rawResponse[key])) {
      throw new Error(`Layout response ${key} must be an object`);
    }
  }

  // Format A: { components: { comp_1: { sx, sy, tx, ty } } }
  if (rawResponse.components && typeof rawResponse.components === 'object') {
    for (const [cid, tr] of Object.entries(rawResponse.components)) {
      const c = compMap.get(cid);
      if (!c) continue;
      const { sx, sy, tx, ty } = readTransform(tr, cid);
      out.set(c.id, {
        sx,
        sy,
        tx,
        ty,
        targetBBox: { x: tx, y: ty, w: Math.max(1, c.bbox.w) * sx, h: Math.max(1, c.bbox.h) * sy },
        mode: rawResponse.mode || deviceProfile.breakpoint,
        breakpoint: deviceProfile.breakpoint,
      });
    }
  }

  // Format B: { bboxes: { comp_1: [x, y, w, h] }, coordinate_system?: 'virtual_px' | 'normalized_1000' }
  if (rawResponse.bboxes && typeof rawResponse.bboxes === 'object') {
    for (const [cid, arr] of Object.entries(rawResponse.bboxes)) {
      const c = compMap.get(cid);
      if (!c) continue;
      let [x, y, bw, bh] = readBox(arr, cid, normX, normY);
      const origW = Math.max(1, c.bbox.w);
      const origH = Math.max(1, c.bbox.h);
      let sx = bw / origW;
      let sy = bh / origH;
      if (c.layoutPolicy?.preserveAspect !== false && c.semanticRole !== 'fullscreen_gesture') {
        const s = Math.min(sx, sy);
        sx = s;
        sy = s;
        x = x + (bw - origW * s) / 2;
        y = y + (bh - origH * s) / 2;
      }
      out.set(c.id, {
        sx,
        sy,
        tx: x,
        ty: y,
        targetBBox: { x, y, w: origW * sx, h: origH * sy },
        mode: deviceProfile.breakpoint,
        breakpoint: deviceProfile.breakpoint,
      });
    }
  }

  // Format C: { macro_bboxes: { mc_1: [x, y, w, h] }, container_overrides?: { mc_1: { intraLayout, align, justify, gap } } }
  if (rawResponse.macro_bboxes && typeof rawResponse.macro_bboxes === 'object' && containerTree?.byScene?.[scene]) {
    const scContainers = containerTree.byScene[scene].containers || [];
    const mcMap = new Map(scContainers.map(c => [c.id, c]));
    const cOverrides = rawResponse.container_overrides || {};

    for (const [mcId, arr] of Object.entries(rawResponse.macro_bboxes)) {
      const mc = mcMap.get(mcId);
      if (!mc) continue;
      const [x, y, bw, bh] = readBox(arr, mcId, normX, normY);
      const ov = normalizeContainerOverride(cOverrides[mcId], mcId);
      const mergedMc = { ...mc, ...ov };
      const childMap = solveIntraContainerLayout(
        mergedMc,
        { x, y, w: bw, h: bh },
        mc.children,
        deviceProfile,
        { forceIntra: true },
      );
      for (const [cid, tr] of childMap.entries()) {
        out.set(cid, tr);
      }
    }
  }

  return out;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function boxesOverlapArea(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

/**
 * Enforce fold-hinge crease clearance, uniform aspect ratio, safe-area bounds,
 * and pairwise overlap safety on ANY algorithm output (built-in or custom plugin).
 */
export function applyConstraintGuard(rawTransforms, comps, deviceProfile, fallbackMap, baseCanvas = { baseW: 1080, baseH: 2400 }, cssOverrides = null) {
  const result = new Map();
  result.diagnostics = [];
  const { w: targetW, h: targetH, safeArea = { top: 16, right: 16, bottom: 16, left: 16 }, hinges = [], breakpoint } = deviceProfile;
  const isPortLike = breakpoint === 'portrait_tall' || breakpoint === 'wide_portrait';
  // Preserve legacy portrait positioning for the native solver on symmetric profiles.
  const keepSourceEdges = isPortLike && rawTransforms === fallbackMap && safeArea.left === safeArea.right && safeArea.top === safeArea.bottom;
  const effPadX = keepSourceEdges ? 0 : safeArea.left;
  const effPadY = keepSourceEdges ? 0 : safeArea.top;
  const effRight = keepSourceEdges ? 0 : safeArea.right;
  const effBottom = keepSourceEdges ? 0 : safeArea.bottom;
  const scaleRule = c => cssOverrides?.get(c.stableKey) ?? cssOverrides?.get(c.id);

  // 1. Fill missing components from fallback and enforce aspect preservation
  for (const c of comps) {
    let tr = rawTransforms.get(c.id) || fallbackMap.get(c.id);
    if (!tr) continue;
    tr = { ...tr, targetBBox: { ...tr.targetBBox } };
    if (c.layoutPolicy?.preserveAspect !== false && c.semanticRole !== 'fullscreen_gesture') {
      const s = Math.min(tr.sx, tr.sy);
      tr.sx = s;
      tr.sy = s;
      tr.targetBBox.w = Math.max(1, c.bbox.w) * s;
      tr.targetBBox.h = Math.max(1, c.bbox.h) * s;
    }
    const override = scaleRule(c);
    if (override?.['min-scale'] !== undefined || override?.['max-scale'] !== undefined) {
      const min = override['min-scale'] ?? 0;
      const max = override['max-scale'] ?? Infinity;
      if (!(min >= 0 && max > 0 && min <= max)) throw new Error(`Invalid CSS scale range for ${c.id}`);
      const factor = clamp(1, min / Math.min(tr.sx, tr.sy), max / Math.max(tr.sx, tr.sy));
      tr.sx *= factor;
      tr.sy *= factor;
      tr.targetBBox.w *= factor;
      tr.targetBBox.h *= factor;
    }
    result.set(c.id, tr);
  }

  // 2. Fold-hinge crease avoidance for Dual-Fold & Tri-Fold devices
  const fgComps = comps.filter(c => !isFullScreenNode(c) && c.semanticRole !== 'hidden_utility');
  if (hinges.length > 0) {
    const panelCount = hinges.length + 1;
    const panelW = targetW / panelCount;

    for (const c of fgComps) {
      const tr = result.get(c.id);
      if (!tr) continue;
      const box = tr.targetBBox;
      if (box.w >= panelW * 0.90) continue; // full-panel or multi-panel spanning component

      for (const hg of hinges) {
        const halfGap = (hg.width || 32) / 2;
        const leftZone = hg.pos - halfGap;
        const rightZone = hg.pos + halfGap;
        if (box.x < rightZone && box.x + box.w > leftZone) {
          const cx = box.x + box.w / 2;
          if (cx <= hg.pos && leftZone - box.w >= safeArea.left) {
            box.x = leftZone - box.w;
          } else if (rightZone + box.w <= targetW - safeArea.right) {
            box.x = rightZone;
          } else if (leftZone - box.w >= effPadX) {
            box.x = leftZone - box.w;
          }
          tr.tx = box.x;
        }
      }
    }
  }

  // 3. Re-clamp and resolve any new overlap caused by external plugins or hinge nudging
  const origOverlapping = new Set();
  for (let i = 0; i < fgComps.length; i++) {
    for (let j = i + 1; j < fgComps.length; j++) {
      const a = fgComps[i], b = fgComps[j];
      const inter = boxesOverlapArea(a.bbox, b.bbox);
      const minA = Math.max(0.01, Math.min(a.bbox.w * a.bbox.h, b.bbox.w * b.bbox.h));
      if (inter / minA > 0.14) origOverlapping.add(`${a.id}|${b.id}`);
    }
  }

  const clampTr = (c, tr) => {
    const box = tr.targetBBox;
    const bleedsH = isPortLike && (c.bbox.x < -2 || c.bbox.x + c.bbox.w > baseCanvas.baseW + 2);
    const bleedsV = isPortLike && (c.bbox.y < -2 || c.bbox.y + c.bbox.h > baseCanvas.baseH + 2);
    if (!bleedsH) box.x = clamp(box.x, effPadX, Math.max(effPadX, targetW - effRight - box.w));
    if (!bleedsV) box.y = clamp(box.y, effPadY, Math.max(effPadY, targetH - effBottom - box.h));
    if (hinges.length > 0 && !isPortLike) {
      const panelW = targetW / (hinges.length + 1);
      if (box.w < panelW * 0.90) {
        for (const hg of hinges) {
          const halfGap = (hg.width || 32) / 2 + 2;
          if (box.x < hg.pos - 2 && box.x + box.w > hg.pos + 2 && box.x < hg.pos + halfGap && box.x + box.w > hg.pos - halfGap) {
            const cx = box.x + box.w / 2;
            if (cx <= hg.pos && hg.pos - halfGap - box.w >= effPadX) {
              box.x = hg.pos - halfGap - box.w;
            } else if (hg.pos + halfGap + box.w <= targetW - effRight) {
              box.x = hg.pos + halfGap;
            } else if (hg.pos - halfGap - box.w >= effPadX) {
              box.x = hg.pos - halfGap - box.w;
            } else {
              const avail = cx <= hg.pos ? (hg.pos - halfGap - effPadX) : (targetW - effRight - (hg.pos + halfGap));
              if (avail >= 24 && box.w > avail) {
                const sFix = avail / box.w;
                box.w *= sFix;
                box.h *= sFix;
                tr.sx *= sFix;
                tr.sy *= sFix;
                box.x = cx <= hg.pos ? (hg.pos - halfGap - box.w) : (hg.pos + halfGap);
              }
            }
          }
        }
      }
    }
    tr.tx = box.x;
    tr.ty = box.y;
  };

  for (const c of fgComps) {
    const tr = result.get(c.id);
    if (tr) clampTr(c, tr);
  }

  // Only run extra separation if hinges nudged things or external algorithm introduced overlaps
  if (hinges.length > 0 || rawTransforms !== fallbackMap) {
    for (let iter = 0; iter < 24; iter++) {
      let moved = false;
      for (let i = 0; i < fgComps.length; i++) {
        for (let j = i + 1; j < fgComps.length; j++) {
          const a = fgComps[i], b = fgComps[j];
          if (!areVariantsCompatible(a.variantKey, b.variantKey)) continue;
          if (origOverlapping.has(`${a.id}|${b.id}`)) continue;
          const ta = result.get(a.id), tb = result.get(b.id);
          if (!ta || !tb) continue;
          const ba = ta.targetBBox, bb = tb.targetBBox;
          const inter = boxesOverlapArea(ba, bb);
          const minA = Math.max(0.01, Math.min(ba.w * ba.h, bb.w * bb.h));
          if (inter / minA <= (isPortLike ? 0.14 : 0.02)) continue;

          const oy = Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y);
          const ox = Math.min(ba.x + ba.w, bb.x + bb.w) - Math.max(ba.x, bb.x);
          const margin = 8;
          const panelAvail = hinges.length > 0 && !isPortLike
            ? (targetW / (hinges.length + 1)) - effPadX - ((hinges[0].width || 32) / 2 + 2)
            : targetW;
          const cantFitSideBySide = hinges.length > 0 && !isPortLike && (ba.w + bb.w + margin > panelAvail);
          if (cantFitSideBySide || (hinges.length > 0 ? oy <= ox * 2.5 : oy <= ox)) {
            const push = (oy + margin) / 2;
            if (ba.y + ba.h / 2 <= bb.y + bb.h / 2) { ba.y -= push; bb.y += push; }
            else { ba.y += push; bb.y -= push; }
          } else {
            const push = (ox + margin) / 2;
            if (ba.x + ba.w / 2 <= bb.x + bb.w / 2) { ba.x -= push; bb.x += push; }
            else { ba.x += push; bb.x -= push; }
          }
          clampTr(a, ta);
          clampTr(b, tb);
          const interAfter = boxesOverlapArea(ba, bb);
          const minAreaAfter = Math.max(0.01, Math.min(ba.w * ba.h, bb.w * bb.h));
          if (interAfter / minAreaAfter > 0.12) {
            for (const [comp, trBox] of [[a, ta], [b, tb]]) {
              if (comp.semanticRole.startsWith('dock_')) continue;
              trBox.targetBBox.w *= 0.85;
              trBox.targetBBox.h *= 0.85;
              trBox.sx *= 0.85;
              trBox.sy *= 0.85;
              clampTr(comp, trBox);
            }
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  for (const c of fgComps) {
    const min = scaleRule(c)?.['min-scale'];
    const tr = result.get(c.id);
    if (!tr) continue;
    const box = tr.targetBBox;
    const bleedsH = isPortLike && (c.bbox.x < -2 || c.bbox.x + c.bbox.w > baseCanvas.baseW + 2);
    const bleedsV = isPortLike && (c.bbox.y < -2 || c.bbox.y + c.bbox.h > baseCanvas.baseH + 2);
    const crossesX = !bleedsH && (box.x < effPadX - 0.01 || box.x + box.w > targetW - effRight + 0.01);
    const crossesY = !bleedsV && (box.y < effPadY - 0.01 || box.y + box.h > targetH - effBottom + 0.01);
    if (min !== undefined && (Math.min(tr.sx, tr.sy) + 1e-6 < min || crossesX || crossesY)) {
      throw new Error(`CSS min-scale cannot fit ${c.id} on ${deviceProfile.id}`);
    }
    if (crossesX || crossesY) {
      result.diagnostics.push({ type: 'safe_area', componentId: c.id, stableKey: c.stableKey, box, safeArea });
    }
    if (hinges.length && box.w < targetW / (hinges.length + 1) * 0.9) {
      for (const hinge of hinges) {
        if (box.x < hinge.pos - 2 && box.x + box.w > hinge.pos + 2) {
          result.diagnostics.push({ type: 'hinge_crossing', componentId: c.id, stableKey: c.stableKey, box, hinge });
        }
      }
    }
  }
  return result;
}
