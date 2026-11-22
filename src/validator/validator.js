/**
 * Automated Round-Trip Validator & Render Tree Evaluator.
 *
 * Re-parses compiled Universal Responsive XML from scratch and evaluates all expressions
 * across 6 target devices (portrait, short 16:9, foldable, tablet landscape, phone landscape).
 */

import { parseXml, walkElements } from '../xml/parser.js';
import { buildRuntimeContext, evalAst, evalSettledExpr, inspectExpression, parseExprAst } from '../expr/evaluator.js';
import { areVariantsCompatible, isFullScreenNode, VISUAL_TAGS } from '../ir/transpiler.js';
import { DEFAULT_VALIDATION_DEVICES } from '../devices/huawei_devices.js';
import { validateInteractions } from '../interaction/interaction_adapter.js';
import { auditResourceReferences } from '../hwt/resource_audit.js';

export const TEST_VIEWPORTS = DEFAULT_VALIDATION_DEVICES;
const EXPRESSION_ATTRIBUTES = [
  'expression', 'condition', 'visibility', 'alpha', 'x', 'y', 'w', 'h',
  'size', 'r', 'space', 'srcExp', 'srcid', 'textExp', 'number', 'string',
];

function auditExpressions(doc) {
  const issues = [];
  const inspected = new Map();
  walkElements(doc.root, node => {
    for (const attribute of EXPRESSION_ATTRIBUTES) {
      const expression = node.attrs[attribute];
      if (!expression?.trim()) continue;
      if (!inspected.has(expression)) inspected.set(expression, inspectExpression(expression));
      for (const diagnostic of inspected.get(expression)) {
        issues.push({ nodeId: node.nodeId, tag: node.tag, attribute, expression, ...diagnostic });
      }
    }
  });
  return issues;
}

function bboxInterArea(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
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
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/**
 * Evaluate a parsed XML doc at (W, H) and return per-element evaluated boxes (keyed by nodeId) + expression health.
 */
export function evaluateXmlAtViewport(doc, assetIndex, targetW, targetH, varOverrides = {}, options = {}) {
  const root = doc.root;
  const ctx = buildRuntimeContext(root, targetW, targetH, varOverrides, assetIndex);
  const openPagingGroups = options.openPagingGroups || null;
  const settledElements = options.settledElements || null;

  const items = [];
  const itemByNodeId = new Map();
  let nanCount = 0;

  function evalNum(expr, def = 0, useSettled = false, localOverrides = null) {
    if (expr === undefined || expr === null || expr === '') return def;
    let v;
    if (localOverrides) {
      const ast = parseExprAst(expr);
      v = Number(evalAst(ast, {
        getVar(name, kind) {
          if (kind !== '@' && name in localOverrides) return localOverrides[name];
          return ctx.getVar(name, kind);
        },
      }));
    } else {
      v = Number(useSettled ? evalSettledExpr(expr, ctx) : ctx.eval(expr));
    }
    if (!Number.isFinite(v)) {
      nanCount++;
      return def;
    }
    return v;
  }

  function intersectRect(a, b) {
    if (!a) return b;
    if (!b) return a;
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
  }

  function walk(node, gx, gy, inheritedVis, inheritedAlpha, activeClip) {
    if (!node || node.type !== 'element') return;
    const t = node.tagLower;
    if (
      t === 'externalcommands' || t === 'triggers' || t === 'trigger' ||
      t === 'var' || t === 'vararray' || t === 'weather' || t === 'healthy' ||
      t === 'variablebinders' || t === 'mediacontrol' || t === 'mask' ||
      t.endsWith('animation') || t === 'aniframe' || t === 'source'
    ) {
      return;
    }

    const vis = node.attrs.visibility !== undefined ? Boolean(evalNum(node.attrs.visibility, 1)) : true;
    const alpha = node.attrs.alpha !== undefined ? evalNum(node.attrs.alpha, 255) : 255;
    const activeVis = inheritedVis && vis;
    const activeAlpha = Math.min(inheritedAlpha, alpha);

    if (t === 'group' || t === 'stereogroup') {
      const pg = openPagingGroups ? openPagingGroups[node.nodeId] : null;
      const lx = pg?.pagingX ? (options.isOrig ? (pg.openX || 0) : 0) : evalNum(node.attrs.x, 0);
      const ly = pg?.pagingY ? (options.isOrig ? (pg.openY || 0) : 0) : evalNum(node.attrs.y, 0);
      let nextClip = activeClip;
      if (node.attrs.clip === 'true' && node.attrs.w !== undefined && node.attrs.h !== undefined) {
        const gw = evalNum(node.attrs.w, 0);
        const gh = evalNum(node.attrs.h, 0);
        if (gw > 0 && gh > 0) {
          nextClip = intersectRect(activeClip, { x: gx + lx, y: gy + ly, w: gw, h: gh });
        }
      }
      for (const c of node.children) {
        walk(c, gx + lx, gy + ly, activeVis, activeAlpha, nextClip);
      }
      return;
    }

    if (!VISUAL_TAGS.has(t) || t === 'lockscreen') {
      for (const c of node.children) walk(c, gx, gy, activeVis, activeAlpha, activeClip);
      return;
    }

    const se = settledElements ? settledElements.get(node.nodeId) : null;
    let lx;
    if (se && se.closedOffscreenX !== 0 && se.openSlideX !== null) {
      lx = options.isOrig
        ? se.openSlideX
        : evalNum(node.attrs.x, 0, false, se.openSlideXVars);
    } else {
      lx = evalNum(node.attrs.x, 0, Boolean(se && se.settledDeltaX));
    }
    if (se && se.pageShiftX) lx -= se.pageShiftX * targetW;

    let ly;
    if (se && se.closedOffscreenY !== 0 && se.openSlideY !== null) {
      ly = options.isOrig
        ? se.openSlideY
        : evalNum(node.attrs.y, 0, false, se.openSlideYVars);
    } else {
      ly = evalNum(node.attrs.y, 0, Boolean(se && se.settledDeltaY));
    }
    const ax = gx + lx;
    const ay = gy + ly;

    let w = 0, h = 0, fontSize = null, textVal = null, resolvedAsset = null;
    if (t === 'image' || t === 'wallpaper' || t === 'video' || t === 'mediaicon') {
      const src = node.attrs.src || null;
      const srcid = node.attrs.srcid !== undefined ? ctx.eval(node.attrs.srcid) : null;
      const srcExpVal = node.attrs.srcExp ? String(ctx.eval(node.attrs.srcExp)) : null;
      resolvedAsset = assetIndex?.resolveImageAsset({ src, srcid, srcExpVal }) ??
        (t === 'video' ? assetIndex?.resolveRel(node.attrs.defaultBitmap) ?? null : null);
      const dims = resolvedAsset && assetIndex ? assetIndex.getDimensions(resolvedAsset) : null;
      w = node.attrs.w !== undefined ? evalNum(node.attrs.w, 80) : (dims ? dims.width : 80);
      h = node.attrs.h !== undefined ? evalNum(node.attrs.h, 80) : (dims ? dims.height : 80);
    } else if (t === 'text' || t === 'datetime') {
      fontSize = Math.max(4, evalNum(node.attrs.size, 40));
      if (t === 'datetime') {
        textVal = (node.attrs.format || '10:08').replace(/NNNN|EEEE/g, '星期日').replace(/yyyy/gi, '2026').replace(/MM/g, '11').replace(/dd/g, '22').replace(/HH|hh/g, '10').replace(/mm/g, '08');
      } else if (node.attrs.text) {
        textVal = node.attrs.text;
      } else if (node.attrs.textExp) {
        const evaluated = ctx.eval(node.attrs.textExp);
        textVal = (evaluated !== undefined && evaluated !== null && String(evaluated) !== '0') ? String(evaluated) : 'SampleText';
      } else {
        textVal = '10:08';
      }
      let estW = 0;
      for (const ch of String(textVal)) estW += ch.charCodeAt(0) > 127 ? fontSize * 1.02 : fontSize * 0.58;
      w = node.attrs.w !== undefined ? evalNum(node.attrs.w, estW) : (node.attrs.width !== undefined ? evalNum(node.attrs.width, estW) : Math.max(fontSize, estW));
      h = node.attrs.h !== undefined ? evalNum(node.attrs.h, fontSize * 1.25) : fontSize * 1.25;
    } else if (t === 'imagenumber' || t === 'imageseries') {
      const resolved = assetIndex ? assetIndex.resolveImageAsset({ src: node.attrs.src, srcid: '0' }) : null;
      resolvedAsset = resolved;
      const dims = resolved && assetIndex ? assetIndex.getDimensions(resolved) : null;
      const gw = dims ? dims.width : 48;
      const gh = dims ? dims.height : 72;
      const sp = evalNum(node.attrs.space, 0);
      const valStr = t === 'imagenumber'
        ? String(Math.trunc(evalNum(node.attrs.number, 88)))
        : String(ctx.eval(node.attrs.string ?? "'88'") || '88');
      const nChars = Math.max(1, valStr.length);
      w = node.attrs.w !== undefined ? evalNum(node.attrs.w, nChars * gw + (nChars - 1) * sp) : nChars * gw + Math.max(0, nChars - 1) * sp;
      h = node.attrs.h !== undefined ? evalNum(node.attrs.h, gh) : gh;
    } else if (t === 'circle') {
      const r = evalNum(node.attrs.r, 40);
      w = 2 * r;
      h = 2 * r;
    } else {
      w = node.attrs.w !== undefined ? evalNum(node.attrs.w, 100) : (node.attrs.width !== undefined ? evalNum(node.attrs.width, 100) : 100);
      h = node.attrs.h !== undefined ? evalNum(node.attrs.h, 100) : 100;
    }

    const align = t === 'button' ? 'left' : (node.attrs.align || 'left').toLowerCase();
    const alignV = t === 'button' ? 'top' : (node.attrs.alignV || 'top').toLowerCase();
    let x = ax, y = ay;
    if (align === 'center') x -= w / 2;
    else if (align === 'right') x -= w;
    if (alignV === 'center') y -= h / 2;
    else if (alignV === 'bottom') y -= h;

    const bw = Math.max(0, w);
    const bh = Math.max(0, h);
    const clippedOut = Boolean(
      activeClip && (x + bw <= activeClip.x + 1 || x >= activeClip.x + activeClip.w - 1 || y + bh <= activeClip.y + 1 || y >= activeClip.y + activeClip.h - 1)
    );

    const item = {
      nodeId: node.nodeId,
      tag: node.tag,
      tagLower: t,
      name: node.attrs.name || null,
      x,
      y,
      w: bw,
      h: bh,
      alpha: Math.max(0, Math.min(255, activeAlpha)),
      clippedOut,
      clipRect: activeClip,
      visible: activeVis && activeAlpha > 0 && !clippedOut,
      fontSize,
      text: textVal,
      color: node.attrs.color || null,
      fillColor: node.attrs.fillColor || null,
      scaleType: node.attrs.scaleType || null,
      resolvedAsset,
      src: node.attrs.src || null,
    };
    items.push(item);
    itemByNodeId.set(node.nodeId, item);
  }

  for (const c of root.children) walk(c, 0, 0, true, 255, null);
  return { items, itemByNodeId, nanCount };
}

function countTags(doc) {
  const counts = { total: 0, trigger: 0, command: 0, image: 0, button: 0 };
  walkElements(doc.root, n => {
    counts.total++;
    if (n.tagLower === 'trigger') counts.trigger++;
    if (n.tagLower.endsWith('command')) counts.command++;
    if (n.tagLower === 'image') counts.image++;
    if (n.tagLower === 'button') counts.button++;
  });
  return counts;
}

export function alignAdaptedNodeIds(doc) {
  let seq = 1;
  walkElements(doc.root, n => {
    if (n.tagLower === 'var' && n.attrs.name && n.attrs.name.startsWith('__hw_')) {
      n.nodeId = `gen_${n.attrs.name}`;
    } else {
      n.nodeId = `n_${seq++}`;
    }
  });
  return doc;
}

/**
 * Validate compiled XML against original XML + ThemeDOM across all 6 test viewports.
 */
export function validateAdaptedTheme({ origDoc, adaptedXml, themeDOM, assetIndex, viewports = TEST_VIEWPORTS }) {
  let adaptedDoc;
  let xmlError = null;
  try {
    adaptedDoc = alignAdaptedNodeIds(parseXml(adaptedXml));
  } catch (err) {
    xmlError = err.message;
    return {
      themeName: themeDOM.themeName,
      xmlValid: false,
      xmlError,
      passed: false,
      viewports: [],
    };
  }

  const origCounts = countTags(origDoc);
  const adaptedCounts = countTags(adaptedDoc);
  const resources = auditResourceReferences(adaptedDoc, assetIndex);
  const expressionDiagnostics = {
    source: auditExpressions(origDoc),
    adapted: auditExpressions(adaptedDoc),
  };
  const preservedTags =
    origCounts.trigger === adaptedCounts.trigger &&
    origCounts.command === adaptedCounts.command &&
    origCounts.image === adaptedCounts.image &&
    origCounts.button === adaptedCounts.button;

  // Map original element bboxes by nodeId for aspect-distortion & original-overlap reference
  const origElById = new Map(themeDOM.elements.map(e => [e.nodeId, e]));
  const settledElements = new Map();
  for (const el of themeDOM.elements) {
    if (el.settledDeltaX || el.settledDeltaY || el.pageShiftX || el.openSlideX !== null || el.openSlideY !== null) {
      settledElements.set(el.nodeId, el);
    }
  }
  const allActiveComps = themeDOM.components.filter(c => c.semanticRole !== 'hidden_utility' && c.semanticRole !== 'offscreen_ambient');
  const mainBgComps = allActiveComps.filter(c => c.scene === 'main' && c.semanticRole === 'background');
  const allFgComps = allActiveComps.filter(c => !isFullScreenNode(c));

  const origAtBase = evaluateXmlAtViewport(origDoc, assetIndex, themeDOM.canvas.baseW, themeDOM.canvas.baseH);
  const isVisibleOnScreen = (it, W, H) => Boolean(
    it && it.visible && !it.clippedOut && it.w > 1 && it.h > 1 &&
    it.x + it.w > 2 && it.x < W - 2 && it.y + it.h > 2 && it.y < H - 2
  );

  // Precompute original intra-scene pairwise overlaps between foreground components
  const origOverlappingPairs = new Set();
  for (let i = 0; i < allFgComps.length; i++) {
    for (let j = i + 1; j < allFgComps.length; j++) {
      const a = allFgComps[i], b = allFgComps[j];
      if (a.scene !== b.scene) continue;
      const inter = bboxInterArea(a.bbox, b.bbox);
      const minA = Math.max(1, Math.min(a.bbox.w * a.bbox.h, b.bbox.w * b.bbox.h));
      if (inter / minA > 0.15) origOverlappingPairs.add(`${a.id}|${b.id}`);
    }
  }

  const vpResults = [];
  let allPassed = preservedTags && (resources.counts.missing ?? 0) === 0;
  const hasSecondaryScenes = themeDOM.scenes.some(s => s !== 'main') ||
    Object.values(themeDOM.pagingGroups || {}).some(g => g.pagingX || g.pagingY);

  for (const vp of viewports) {
    const evalMain = evaluateXmlAtViewport(adaptedDoc, assetIndex, vp.w, vp.h);
    const origAtVp = evaluateXmlAtViewport(origDoc, assetIndex, vp.w, vp.h);
    const evalOpen = hasSecondaryScenes
      ? evaluateXmlAtViewport(adaptedDoc, assetIndex, vp.w, vp.h, {}, { openPagingGroups: themeDOM.pagingGroups, settledElements })
      : evalMain;

    let sceneLeakCount = 0;
    for (const el of themeDOM.elements) {
      if (el.semanticRole === 'hidden_utility' || el.semanticRole === 'background' || el.semanticRole === 'fullscreen_gesture') continue;
      const aV = evalMain.itemByNodeId.get(el.nodeId);
      if (!isVisibleOnScreen(aV, vp.w, vp.h)) continue;
      if (el.semanticRole === 'offscreen_ambient') {
        sceneLeakCount++;
        continue;
      }
      const oB = origAtBase.itemByNodeId.get(el.nodeId);
      const oV = origAtVp.itemByNodeId.get(el.nodeId);
      if (!isVisibleOnScreen(oB, themeDOM.canvas.baseW, themeDOM.canvas.baseH) && !isVisibleOnScreen(oV, vp.w, vp.h)) {
        sceneLeakCount++;
      }
    }

    const sceneEvalMap = new Map();
    for (const sc of themeDOM.scenes) {
      sceneEvalMap.set(sc, sc === 'main' ? evalMain : evalOpen);
    }

    const byIdMain = evalMain.itemByNodeId;

    // 1. Background coverage on main scene
    let bgCoverage = 1.0;
    if (mainBgComps.length > 0) {
      let maxCov = 0;
      const vpBox = { x: 0, y: 0, w: vp.w, h: vp.h };
      for (const bg of mainBgComps) {
        const boxes = bg.memberIds.map(id => byIdMain.get(id)).filter(Boolean);
        if (boxes.length > 0) {
          const u = bboxUnion(boxes);
          const cov = bboxInterArea(u, vpBox) / (vp.w * vp.h);
          maxCov = Math.max(maxCov, cov);
        }
      }
      bgCoverage = Math.round(maxCov * 10000) / 10000;
    }

    // 2. Validate EVERY scene: OOB, distortion, intra-scene overlap, and strict button hitbox alignment
    let oobCount = 0;
    let distortionCount = 0;
    let buttonDriftCount = 0;
    let overlapPairs = 0;

    for (const sc of themeDOM.scenes) {
      const ev = sceneEvalMap.get(sc);
      const byId = ev.itemByNodeId;
      const scFg = allFgComps.filter(c => c.scene === sc);
      const compEvalBoxes = new Map();

      for (const c of scFg) {
        const memberBoxes = c.memberIds.map(id => byId.get(id)).filter(Boolean);
        if (memberBoxes.length === 0) continue;
        const cBox = bboxUnion(memberBoxes);
        compEvalBoxes.set(c.id, cBox);

        // OOB check (2.5px rounding tolerance); preserve intentional original edge bleed & wide horizontal scroll/swim tracks
        const { baseW, baseH } = themeDOM.canvas;
        const origInsideHoriz = c.bbox.x >= -2.5 && c.bbox.x + c.bbox.w <= baseW + 2.5;
        const origInside = origInsideHoriz && c.bbox.y >= -2.5 && c.bbox.y + c.bbox.h <= baseH + 2.5;
        const wideSwimTrack = !origInsideHoriz && c.bbox.w >= baseW * 0.90;
        if (cBox.w > 0 && cBox.h > 0 && !wideSwimTrack && (origInside || vp.w / Math.max(1, vp.h) >= 0.72)) {
          if (cBox.x < -2.5 || cBox.y < -2.5 || cBox.x + cBox.w > vp.w + 2.5 || cBox.y + cBox.h > vp.h + 2.5) {
            oobCount++;
          }
        }

        // Aspect ratio distortion check on non-text graphic members
        for (const mid of c.memberIds) {
          const orig = origElById.get(mid);
          const cur = byId.get(mid);
          if (!orig || !cur) continue;
          if (orig.tagLower === 'text' || orig.tagLower === 'datetime' || orig.tagLower === 'imagenumber' || orig.tagLower === 'imageseries') continue;
          if (orig.bbox.w <= 2 || orig.bbox.h <= 2 || cur.w <= 2 || cur.h <= 2) continue;
          const origAr = orig.bbox.w / orig.bbox.h;
          const curAr = cur.w / cur.h;
          const drift = Math.abs(curAr - origAr) / Math.max(0.01, origAr);
          if (drift > 0.03) distortionCount++;
        }

        // Strict button hitbox alignment check (buttons transform identically with their bound component)
        for (const bid of c.boundButtonIds) {
          const bBox = byId.get(bid);
          const origBtn = origElById.get(bid);
          if (!bBox || !origBtn) continue;
          const origInter = bboxInterArea(origBtn.bbox, c.bbox) / Math.max(0.01, Math.min(origBtn.bbox.w * origBtn.bbox.h, c.bbox.w * c.bbox.h));
          if (origInter > 0.5) {
            const curInter = bboxInterArea(bBox, cBox) / Math.max(0.01, Math.min(bBox.w * bBox.h, cBox.w * cBox.h));
            if (curInter < Math.min(0.55, origInter * 0.85)) buttonDriftCount++;
          }
        }
      }

      // Intra-scene overlap check between compatible foreground components in the same scene
      for (let i = 0; i < scFg.length; i++) {
        for (let j = i + 1; j < scFg.length; j++) {
          const a = scFg[i], b = scFg[j];
          if (!areVariantsCompatible(a.variantKey, b.variantKey)) continue;
          if (origOverlappingPairs.has(`${a.id}|${b.id}`)) continue;
          const ba = compEvalBoxes.get(a.id);
          const bb = compEvalBoxes.get(b.id);
          if (!ba || !bb) continue;
          const inter = bboxInterArea(ba, bb);
          const minA = Math.max(1, Math.min(ba.w * ba.h, bb.w * bb.h));
          if (inter / minA > 0.20) {
            overlapPairs++;
          }
        }
      }
    }

    const totalNanCount = Math.max(evalMain.nanCount, evalOpen.nanCount);
    const interCheck = validateInteractions({
      origDoc,
      adaptedDoc,
      themeDOM,
      deviceProfile: vp,
      sceneEvalMap,
    });

    const vpPassed =
      totalNanCount === 0 &&
      bgCoverage >= 0.99 &&
      oobCount === 0 &&
      distortionCount === 0 &&
      overlapPairs === 0 &&
      buttonDriftCount === 0 &&
      sceneLeakCount === 0 &&
      interCheck.mutatedLogicCount === 0 &&
      interCheck.wipedDynamicGroupCount === 0 &&
      interCheck.hingeStraddleCount === 0;

    if (!vpPassed) allPassed = false;

    vpResults.push({
      id: vp.id,
      label: vp.label,
      breakpoint: vp.breakpoint,
      w: vp.w,
      h: vp.h,
      scenesValidated: themeDOM.scenes.length,
      nanCount: totalNanCount,
      bgCoverage,
      oobCount,
      distortionCount,
      overlapPairs,
      buttonDriftCount,
      sceneLeakCount,
      mutatedLogicCount: interCheck.mutatedLogicCount,
      wipedDynamicGroupCount: interCheck.wipedDynamicGroupCount,
      hingeStraddleCount: interCheck.hingeStraddleCount,
      passed: vpPassed,
    });
  }

  return {
    themeName: themeDOM.themeName,
    xmlValid: true,
    preservedTags,
    tagCounts: { orig: origCounts, adapted: adaptedCounts },
    resources,
    expressionDiagnostics,
    passed: allPassed,
    viewports: vpResults,
  };
}
