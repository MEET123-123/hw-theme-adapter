/**
 * Frontend Component Extractor (<hw-drawer> & <hw-image-switcher>).
 *
 * Automatically lifts Huawei Lockscreen MAML interaction patterns into standard,
 * composable frontend UI components without modifying original XML logic:
 * 1. Click/swipe-triggered Slide Drawers & Modal Panels -> <hw-drawer>
 * 2. Embedded Multi-Variant Image Switcher Containers -> <hw-image-switcher>
 *    - Type A: Dynamic `srcid` / `srcExp` driven image switchers
 *    - Type B: Co-located mutually-exclusive visibility-stacked <Image> groups
 */

import { walkElements } from '../xml/parser.js';
import { buildRuntimeContext, evalAst, parseExprAst } from '../expr/evaluator.js';

const IGNORE_VAR_NAMES = new Set([
  'screen_width', 'screen_height', 'view_width', 'view_height',
  'raw_screen_width', 'raw_screen_height',
  'touch_x', 'touch_y', 'touch_begin_x', 'touch_begin_y', 'touch_pressure',
  'time', 'time_sys', 'hour12', 'hour24', 'minute', 'second', 'ampm',
  'year', 'month', 'date', 'day_of_week', 'battery_level', 'step', 'steps',
]);

const SYSTEM_INTERACTIVE_VARS = new Set([
  'flashlight', 'flashlightValue', 'charge_anim', 'battery_state', 'media_play_status',
]);

function bboxUnion(boxes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (!b || (b.w <= 0 && b.h <= 0)) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

function bboxIoU(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const areaA = Math.max(1, a.w * a.h);
  const areaB = Math.max(1, b.w * b.h);
  return inter / Math.max(1, areaA + areaB - inter);
}

function extractVarRefs(expr) {
  const vars = [];
  if (!expr) return vars;
  for (const m of String(expr).matchAll(/[#@]([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const v = m[1];
    if (!IGNORE_VAR_NAMES.has(v) && !v.startsWith('__hw_')) {
      vars.push(v);
    }
  }
  return [...new Set(vars)];
}

/**
 * Extract first concrete (varName, slotValue) pair from ThemeDOM variantKey.
 */
function parsePrimaryVariantSlot(variantKey, preferredVars) {
  if (!variantKey) return null;
  const parts = String(variantKey).split('&');
  const parsed = [];
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const varName = part.slice(0, idx);
    const cond = part.slice(idx + 1);
    if (IGNORE_VAR_NAMES.has(varName)) continue;
    const eqM = /^eq=(-?\d+(?:\.\d+)?)$/.exec(cond);
    if (eqM) {
      parsed.push({ varName, value: Number(eqM[1]) });
      continue;
    }
    if (cond === 'not=1') {
      parsed.push({ varName, value: 0 });
    }
  }
  if (parsed.length === 0) return null;
  if (parsed.length === 1) return parsed[0];
  const pref = parsed.find(p => preferredVars.has(p.varName));
  return pref || parsed[0];
}

export function extractUiComponents({ doc, themeDOM, assetIndex = null, stateMachine = null }) {
  const { baseW, baseH } = themeDOM.canvas;
  const nodeById = new Map();
  const mutatedVars = new Set(SYSTEM_INTERACTIVE_VARS);
  const animVarByTarget = new Map();

  for (const sv of stateMachine?.stateVars || []) {
    mutatedVars.add(sv.name);
  }
  for (const [k, anim] of Object.entries(stateMachine?.animations || {})) {
    mutatedVars.add(anim.varName);
    animVarByTarget.set(k, anim);
  }

  walkElements(doc.root, (node) => {
    nodeById.set(node.nodeId, node);
    if (node.tagLower === 'variablecommand' && node.attrs.name) {
      mutatedVars.add(node.attrs.name);
    }
  });

  const elById = new Map(themeDOM.elements.map(e => [e.nodeId, e]));
  const compById = new Map(themeDOM.components.map(c => [c.id, c]));
  const compIdByNodeId = new Map();
  for (const c of themeDOM.components) {
    for (const mid of c.memberIds) compIdByNodeId.set(mid, c.id);
  }

  // Trigger buttons mapped by stateVar
  const triggersByVar = new Map();
  for (const bt of stateMachine?.triggers || []) {
    for (const tr of bt.triggers || []) {
      for (const cmd of tr.commands || []) {
        let targetVar = cmd.name;
        if (!targetVar && cmd.target && animVarByTarget.has(cmd.target)) {
          targetVar = animVarByTarget.get(cmd.target).varName;
        }
        if (!targetVar) continue;
        if (!triggersByVar.has(targetVar)) triggersByVar.set(targetVar, new Set());
        triggersByVar.get(targetVar).add(bt.buttonNodeId);
      }
    }
  }

  const svByName = new Map((stateMachine?.stateVars || []).map(sv => [sv.name, sv]));

  // =========================================================================
  // 1. Extract Slide Drawers & Popup Panels (<hw-drawer>)
  // =========================================================================
  const rawDrawers = [];

  // Source A: Paging / sliding <Group> containers from ThemeDOM
  for (const [gid, pgInfo] of Object.entries(themeDOM.pagingGroups || {})) {
    const gNode = nodeById.get(gid);
    if (!gNode) continue;

    const varRefs = [
      ...extractVarRefs(gNode.attrs.x),
      ...extractVarRefs(gNode.attrs.y),
    ];
    if (varRefs.length === 0) continue;

    // Prefer a stateVar or animation var
    const primaryVar =
      varRefs.find(v => svByName.has(v)) ||
      varRefs.find(v => animVarByTarget.has(v)) ||
      varRefs.find(v => mutatedVars.has(v)) ||
      varRefs[0];

    const sv = svByName.get(primaryVar);
    const anim = animVarByTarget.get(primaryVar);

    const memberEls = themeDOM.elements.filter(
      el =>
        el.ancestorGroupIds.includes(gid) &&
        el.tagLower !== 'button' &&
        el.semanticRole !== 'hidden_utility' &&
        el.semanticRole !== 'background' &&
        el.semanticRole !== 'fullscreen_gesture'
    );
    if (memberEls.length === 0) continue;

    const memberNodeIds = memberEls.map(e => e.nodeId);
    const componentIds = [...new Set(memberNodeIds.map(id => compIdByNodeId.get(id)).filter(Boolean))];
    const origBBox = bboxUnion(memberEls.map(e => e.bbox));
    if (origBBox.w < 30 && origBBox.h < 30) continue;

    let direction = 'right';
    if (pgInfo.pagingX) {
      direction = (pgInfo.gx ?? 0) >= (pgInfo.openX ?? 0) ? 'right' : 'left';
    } else if (pgInfo.pagingY) {
      direction = (pgInfo.gy ?? 0) >= (pgInfo.openY ?? 0) ? 'bottom' : 'top';
    } else if (pgInfo.openX !== undefined && Math.abs(pgInfo.gx - pgInfo.openX) > 20) {
      direction = pgInfo.gx >= pgInfo.openX ? 'right' : 'left';
    } else if (pgInfo.openY !== undefined && Math.abs(pgInfo.gy - pgInfo.openY) > 20) {
      direction = pgInfo.gy >= pgInfo.openY ? 'bottom' : 'top';
    }

    const closedValue = sv ? sv.initialValue : (anim ? anim.startVal : 0);
    const openValue = sv?.domain?.[0] ?? (anim ? anim.endVal : (closedValue === 0 ? 1 : 0));

    rawDrawers.push({
      kind: 'slide_drawer',
      source: 'paging_group',
      groupNodeId: gid,
      stateVar: primaryVar,
      label: sv?.label || gNode.attrs.name || `滑窗面板 (${primaryVar})`,
      direction,
      sceneHint: 'drawer',
      closedValue,
      openValue,
      triggerButtonIds: [...(triggersByVar.get(primaryVar) || [])],
      memberNodeIds,
      componentIds,
      origBBox: {
        x: Math.round(origBBox.x * 10) / 10,
        y: Math.round(origBBox.y * 10) / 10,
        w: Math.round(origBBox.w * 10) / 10,
        h: Math.round(origBBox.h * 10) / 10,
      },
    });
  }

  // Deduplicate paging group drawers sharing the same primary stateVar (keep largest non-subsumed)
  rawDrawers.sort((a, b) => b.memberNodeIds.length - a.memberNodeIds.length);
  const drawers = [];
  const coveredDrawerSigs = new Set();

  for (const d of rawDrawers) {
    const dup = drawers.find(existing =>
      existing.stateVar === d.stateVar &&
      d.memberNodeIds.every(id => existing.memberNodeIds.includes(id))
    );
    if (dup) continue;
    const compSig = d.componentIds.slice().sort().join(',');
    if (coveredDrawerSigs.has(d.stateVar + '::' + compSig)) continue;
    coveredDrawerSigs.add(d.stateVar + '::' + compSig);
    drawers.push(d);
  }

  // Source B: Click/gesture revealed drawer_slide, modal_panel, or popup states from StateMachine
  for (const st of stateMachine?.states || []) {
    if (st.id === 'S0_default' || !st.primaryVar) continue;
    const isDrawerOrModal =
      st.category === 'drawer_slide' ||
      st.category === 'modal_panel' ||
      (st.addedComponentIds.length >= 2 && st.category !== 'system_state');
    if (!isDrawerOrModal) continue;

    // Collect foreground member nodeIds of added components
    const memberEls = [];
    const compIds = [];
    for (const cid of st.addedComponentIds) {
      const c = compById.get(cid);
      if (!c || c.semanticRole === 'background' || c.semanticRole === 'fullscreen_gesture' || c.semanticRole === 'hidden_utility') continue;
      compIds.push(cid);
      for (const mid of c.memberIds) {
        const el = elById.get(mid);
        if (el && el.tagLower !== 'button') memberEls.push(el);
      }
    }
    if (memberEls.length === 0) continue;

    // Check overlap with already-added drawers for the same stateVar
    const alreadyCovered = drawers.some(ex => {
      if (ex.stateVar !== st.primaryVar) return false;
      const exSet = new Set(ex.componentIds);
      const hits = compIds.filter(id => exSet.has(id)).length;
      return hits >= Math.max(1, compIds.length * 0.6);
    });
    if (alreadyCovered) continue;

    const origBBox = bboxUnion(memberEls.map(e => e.bbox));
    if (origBBox.w < 24 && origBBox.h < 24) continue;

    let direction = 'center';
    if (st.category === 'drawer_slide') {
      const cx = origBBox.x + origBBox.w / 2;
      const cy = origBBox.y + origBBox.h / 2;
      if (cy > baseH * 0.62) direction = 'bottom';
      else if (cy < baseH * 0.35) direction = 'top';
      else direction = cx >= baseW * 0.5 ? 'right' : 'left';
    } else if (origBBox.y > baseH * 0.45 && origBBox.h < baseH * 0.65) {
      direction = 'bottom';
    }

    const sv = svByName.get(st.primaryVar);
    drawers.push({
      kind: st.category === 'drawer_slide' ? 'slide_drawer' : (st.category === 'modal_panel' ? 'modal_panel' : 'popup_sheet'),
      source: 'state_machine',
      groupNodeId: null,
      stateVar: st.primaryVar,
      label: st.label,
      direction,
      sceneHint: st.sceneHint || 'settings',
      closedValue: sv ? sv.initialValue : 0,
      openValue: st.primaryValue,
      triggerButtonIds: [...(triggersByVar.get(st.primaryVar) || [])],
      memberNodeIds: [...new Set(memberEls.map(e => e.nodeId))],
      componentIds: compIds,
      origBBox: {
        x: Math.round(origBBox.x * 10) / 10,
        y: Math.round(origBBox.y * 10) / 10,
        w: Math.round(origBBox.w * 10) / 10,
        h: Math.round(origBBox.h * 10) / 10,
      },
    });
  }

  // Assign stable IDs to top drawers (cap at 12 to avoid micro-animation noise)
  const finalDrawers = drawers.slice(0, 12).map((d, idx) => ({
    id: `drawer_${idx + 1}`,
    tag: 'hw-drawer',
    ...d,
  }));

  // =========================================================================
  // 2. Extract Container-Embedded Image Switchers (<hw-image-switcher>)
  // =========================================================================
  const ctx = buildRuntimeContext(doc.root, baseW, baseH, {}, assetIndex);
  const imageSwitchers = [];
  const capturedNodeIds = new Set();

  // Type A: Dynamic srcid / srcExp <Image> nodes
  walkElements(doc.root, (node) => {
    if (node.tagLower !== 'image') return;
    const el = elById.get(node.nodeId);
    if (!el || el.semanticRole === 'hidden_utility') return;

    const rawSrcid = node.attrs.srcid;
    const rawSrcExp = node.attrs.srcExp;
    if (rawSrcid === undefined && rawSrcExp === undefined) return;

    const varRefs = [
      ...extractVarRefs(rawSrcid),
      ...extractVarRefs(rawSrcExp),
    ].filter(v => mutatedVars.has(v));
    if (varRefs.length === 0) return;

    const primaryVar = varRefs.find(v => svByName.has(v)) || varRefs[0];
    const sv = svByName.get(primaryVar);
    const initVal = sv ? sv.initialValue : (Number(ctx.getVar(primaryVar, '#')) || 0);
    const candidates = [...new Set([
      initVal,
      ...(sv?.domain || []),
      0, 1, 2, 3, 4, 5,
    ])];

    const srcidAst = rawSrcid !== undefined ? parseExprAst(rawSrcid) : null;
    const srcExpAst = rawSrcExp !== undefined ? parseExprAst(rawSrcExp) : null;

    const slots = [];
    const distinctAssets = new Set();
    for (const val of candidates) {
      const localCtx = {
        getVar(name, kind) {
          if (name === primaryVar) return val;
          return ctx.getVar(name, kind);
        },
      };
      const evalSid = srcidAst ? evalAst(srcidAst, localCtx) : null;
      const evalSexp = srcExpAst ? String(evalAst(srcExpAst, localCtx)) : null;
      const resolved = assetIndex
        ? assetIndex.resolveImageAsset({ src: node.attrs.src || null, srcid: evalSid, srcExpVal: evalSexp })
        : (evalSexp || (node.attrs.src && evalSid !== null ? `${node.attrs.src}#${evalSid}` : null));
      if (!resolved) continue;
      if (slots.some(s => String(s.value) === String(val))) continue;
      distinctAssets.add(resolved);
      slots.push({ value: val, asset: resolved, nodeId: node.nodeId });
    }

    if (distinctAssets.size < 2) return;

    capturedNodeIds.add(node.nodeId);
    imageSwitchers.push({
      id: `imgsw_${imageSwitchers.length + 1}`,
      tag: 'hw-image-switcher',
      kind: 'srcid_container',
      stateVar: primaryVar,
      label: sv?.label || node.attrs.name || `动态图源切换 (${primaryVar})`,
      initialValue: initVal,
      transition: 'fade',
      nodeIds: [node.nodeId],
      componentIds: [compIdByNodeId.get(node.nodeId)].filter(Boolean),
      triggerButtonIds: [...(triggersByVar.get(primaryVar) || [])],
      origBBox: { ...el.bbox },
      slots,
    });
  });

  // Type B: Co-located mutually-exclusive stacked <Image> nodes keyed by variantKey
  const byVarClusters = new Map();
  for (const el of themeDOM.elements) {
    if (el.tagLower !== 'image' || el.semanticRole === 'hidden_utility') continue;
    if (capturedNodeIds.has(el.nodeId)) continue;
    if (!el.variantKey || !el.extra?.resolvedAsset) continue;

    const slot = parsePrimaryVariantSlot(el.variantKey, mutatedVars);
    if (!slot) continue;
    if (!mutatedVars.has(slot.varName) && !triggersByVar.has(slot.varName)) continue;

    if (!byVarClusters.has(slot.varName)) byVarClusters.set(slot.varName, []);
    byVarClusters.get(slot.varName).push({ el, value: slot.value });
  }

  for (const [varName, entries] of byVarClusters.entries()) {
    // Cluster co-located images belonging to the same variable switcher
    const clusters = [];
    for (const item of entries) {
      let targetCluster = null;
      const b = item.el.bbox;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;

      for (const cl of clusters) {
        const rep = cl[0].el.bbox;
        const rcx = rep.x + rep.w / 2;
        const rcy = rep.y + rep.h / 2;
        const iou = bboxIoU(b, rep);
        const dist = Math.hypot(cx - rcx, cy - rcy);
        const maxDim = Math.max(b.w, b.h, rep.w, rep.h, 40);
        const sizeRatio = Math.max(b.w / Math.max(1, rep.w), rep.w / Math.max(1, b.w));
        if (iou >= 0.25 || (dist <= maxDim * 0.45 && sizeRatio <= 2.6)) {
          targetCluster = cl;
          break;
        }
      }
      if (targetCluster) targetCluster.push(item);
      else clusters.push([item]);
    }

    for (const cl of clusters) {
      const byVal = new Map();
      for (const it of cl) {
        const key = String(it.value);
        if (!byVal.has(key)) byVal.set(key, it);
      }
      if (byVal.size < 2) continue;

      const slots = [...byVal.values()]
        .sort((a, b) => Number(a.value) - Number(b.value))
        .map(it => ({
          value: it.value,
          asset: it.el.extra.resolvedAsset,
          nodeId: it.el.nodeId,
        }));

      const distinctAssets = new Set(slots.map(s => s.asset));
      if (distinctAssets.size < 2) continue;

      for (const s of slots) capturedNodeIds.add(s.nodeId);
      const sv = svByName.get(varName);
      const unionBox = bboxUnion(cl.map(it => it.el.bbox));

      imageSwitchers.push({
        id: `imgsw_${imageSwitchers.length + 1}`,
        tag: 'hw-image-switcher',
        kind: 'visibility_slot_container',
        stateVar: varName,
        label: sv?.label || `叠层图片容器 (${varName})`,
        initialValue: sv ? sv.initialValue : slots[0].value,
        transition: 'crossfade',
        nodeIds: [...new Set(slots.map(s => s.nodeId))],
        componentIds: [...new Set(slots.map(s => compIdByNodeId.get(s.nodeId)).filter(Boolean))],
        triggerButtonIds: [...(triggersByVar.get(varName) || [])],
        origBBox: {
          x: Math.round(unionBox.x * 10) / 10,
          y: Math.round(unionBox.y * 10) / 10,
          w: Math.round(unionBox.w * 10) / 10,
          h: Math.round(unionBox.h * 10) / 10,
        },
        slots,
      });
    }
  }

  // Build reverse binding lookup by XML nodeId
  const byNodeId = {};
  for (const d of finalDrawers) {
    for (const mid of d.memberNodeIds) {
      byNodeId[mid] = { ...(byNodeId[mid] || {}), drawerId: d.id };
    }
  }
  for (const sw of imageSwitchers) {
    for (const sl of sw.slots) {
      byNodeId[sl.nodeId] = {
        ...(byNodeId[sl.nodeId] || {}),
        imageSwitcherId: sw.id,
        slotValue: sl.value,
      };
    }
  }

  const srcidSwitcherCount = imageSwitchers.filter(s => s.kind === 'srcid_container').length;
  const visStackSwitcherCount = imageSwitchers.filter(s => s.kind === 'visibility_slot_container').length;
  const totalVariantSlots = imageSwitchers.reduce((sum, s) => sum + s.slots.length, 0);

  return {
    themeName: themeDOM.themeName,
    summary: {
      drawerCount: finalDrawers.length,
      imageSwitcherCount: imageSwitchers.length,
      srcidSwitcherCount,
      visStackSwitcherCount,
      totalVariantSlots,
    },
    drawers: finalDrawers,
    imageSwitchers,
    nodeBindings: { byNodeId },
  };
}
