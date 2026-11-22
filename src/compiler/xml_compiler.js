/**
 * Adaptive Huawei Lockscreen XML Compiler.
 *
 * Compiles ThemeDOM IR + Multi-Breakpoint Layout Solver into:
 * 1) Universal Responsive `manifest.xml` (default): single adaptive XML using `#screen_width`,
 *    `#screen_height`, and breakpoint `<Var>`s across portrait, foldable, and landscape.
 * 2) Targeted Static `manifest.xml` (`mode: 'target'`): specialized for a concrete (targetW, targetH).
 */

import { cloneXmlDoc, serializeXml, setNodeAttr, walkElements } from '../xml/parser.js';
import { astCollectVars, buildRuntimeContext, formatNum, freezeScreenVarsExpr, rewriteExprForTransform } from '../expr/evaluator.js';
import { solveLayout } from '../layout/responsive_engine.js';
import { classifyDynamicGroupAxis, VISUAL_TAGS } from '../ir/transpiler.js';
import { HUAWEI_DEVICES, resolveDeviceProfile } from '../devices/huawei_devices.js';
import { buildContainerTree } from '../layout/container_tree.js';

function makeVarNode(name, expression) {
  return {
    type: 'element',
    nodeId: `gen_${name}`,
    tag: 'Var',
    tagLower: 'var',
    attrs: { name, expression: String(expression) },
    attrOrder: ['name', 'expression'],
    children: [],
    selfClosing: true,
    parent: null,
  };
}

function addStaticOffsetExpr(rawExpr, extraOffset) {
  if (!extraOffset || Math.abs(extraOffset) < 1e-6) {
    return rawExpr !== undefined ? String(rawExpr) : '0';
  }
  const base = rawExpr !== undefined ? String(rawExpr).trim() : '0';
  if (base === '0' || base === '') return formatNum(extraOffset);
  const sign = extraOffset >= 0 ? `+${formatNum(extraOffset)}` : formatNum(extraOffset);
  return `(${base})${sign}`;
}

function isPagingGroupAttr(expr, evalVal, refDim, ctx) {
  if (!expr) return false;
  const dep = ctx.classifyExpr(expr);
  return Math.abs(evalVal) >= refDim * 0.80 && (dep === 'mixed' || dep === 'dynamic');
}

/**
 * Compile ThemeDOM + XML Document into an adaptive `manifest.xml`.
 */
export function compileAdaptiveXml(doc, themeDOM, {
  mode = 'universal',
  targetW = 1080,
  targetH = 2400,
  algorithm = 'hwflex',
  cssOverrides = null,
  deviceProfile = null,
  mergeConfig = null,
  containerTree = buildContainerTree(themeDOM, mergeConfig),
} = {}) {
  const outDoc = cloneXmlDoc(doc);
  const root = outDoc.root;
  const { baseW, baseH } = themeDOM.canvas;
  const ctx = buildRuntimeContext(root, baseW, baseH);

  // Build element lookup from ThemeDOM
  const elById = new Map(themeDOM.elements.map(e => [e.nodeId, e]));
  const nodeById = new Map();
  walkElements(root, n => nodeById.set(n.nodeId, n));

  // Keep screenWidth at baseW (1080) so Huawei's virtual width system keeps #screen_width = baseW
  // and scales #screen_height dynamically with physical aspect ratio!
  setNodeAttr(root, 'screenWidth', String(baseW));

  // Solve layouts across all 5 Huawei form-factor breakpoints
  const isUniversal = mode === 'universal';
  if (!isUniversal && mode !== 'target') throw new Error(`Unsupported compile mode: ${mode}`);
  const solveOpts = (dev) => ({ algorithm, deviceProfile: dev, cssOverrides, mergeConfig, containerTree });
  const fullscreenIds = new Set(themeDOM.components.filter(c => c.semanticRole === 'fullscreen_gesture').map(c => c.id));
  const layoutDiagnostics = [];
  function solveForXml(width, height, device) {
    const plan = solveLayout(themeDOM, width, height, solveOpts(device));
    layoutDiagnostics.push(...plan.diagnostics);
    for (const [id, { sx, sy }] of plan) {
      if (!fullscreenIds.has(id) && Math.abs(sx - sy) > 1e-6) {
        throw new Error(`XML compilation requires equal x/y scales for ${id} on ${device.id}`);
      }
    }
    return plan;
  }
  const p2400 = isUniversal ? solveForXml(baseW, 2400, HUAWEI_DEVICES.phone_2400) : null;
  const p1920 = isUniversal ? solveForXml(baseW, 1920, HUAWEI_DEVICES.phone_1920) : null;
  const wp1527 = isUniversal ? solveForXml(baseW, 1527, HUAWEI_DEVICES.pura_x_max_portrait) : null;
  const sqRef = isUniversal ? solveForXml(baseW, 1177, HUAWEI_DEVICES.dual_fold_unfolded) : null;
  const ltRef = isUniversal ? solveForXml(baseW, 757, HUAWEI_DEVICES.tri_fold_triple) : null;
  const lwRef = isUniversal ? solveForXml(baseW, 486, HUAWEI_DEVICES.phone_land) : null;
  const targetDev = !isUniversal ? (deviceProfile || resolveDeviceProfile(targetW, targetH)) : null;
  const staticPlan = !isUniversal ? solveForXml(targetW, targetH, targetDev) : null;

  // Map component ID -> runtime var prefix or static transform
  const compTransformMap = new Map();
  const injectedVars = [];

  if (isUniversal) {
    injectedVars.push(
      makeVarNode('__hw_sw', '#screen_width'),
      makeVarNode('__hw_sh', '#screen_height'),
      makeVarNode('__hw_ar', '#screen_width/max(#screen_height,1)'),
      makeVarNode('__hw_is_lw', 'ge(#__hw_ar,1.85)'),
      makeVarNode('__hw_is_lt', 'ge(#__hw_ar,1.15)*lt(#__hw_ar,1.85)'),
      makeVarNode('__hw_is_sq', 'ge(#__hw_ar,0.78)*lt(#__hw_ar,1.15)'),
      makeVarNode('__hw_is_wp', 'ge(#__hw_ar,0.56)*lt(#__hw_ar,0.78)'),
      makeVarNode('__hw_pt', 'min(1,max(0,(#__hw_sh-1920)/480))'),
      makeVarNode('__hw_wpt', 'min(1,max(0,(#__hw_sh-1527)/393))'),
      makeVarNode('__hw_sq_k', `min(#__hw_sw/${baseW},#__hw_sh/1177)`),
      makeVarNode('__hw_sq_ox', `(#__hw_sw-${baseW}*#__hw_sq_k)/2`),
      makeVarNode('__hw_sq_oy', `(#__hw_sh-1177*#__hw_sq_k)/2`),
      makeVarNode('__hw_lt_k', `min(#__hw_sw/${baseW},#__hw_sh/757)`),
      makeVarNode('__hw_lt_ox', `(#__hw_sw-${baseW}*#__hw_lt_k)/2`),
      makeVarNode('__hw_lt_oy', `(#__hw_sh-757*#__hw_lt_k)/2`),
      makeVarNode('__hw_lw_k', `min(#__hw_sw/${baseW},#__hw_sh/486)`),
      makeVarNode('__hw_lw_ox', `(#__hw_sw-${baseW}*#__hw_lw_k)/2`),
      makeVarNode('__hw_lw_oy', `(#__hw_sh-486*#__hw_lw_k)/2`),
    );

    let bgIdx = 1;
    let fgIdx = 1;

    for (const c of themeDOM.components) {
      if (c.semanticRole === 'fullscreen_gesture') {
        compTransformMap.set(c.id, { kind: 'fullscreen_gesture' });
        continue;
      }
      if (c.semanticRole === 'offscreen_ambient') {
        compTransformMap.set(c.id, { kind: 'offscreen_ambient' });
        continue;
      }

      if (c.semanticRole === 'background') {
        const prefix = `__hw_bg${bgIdx++}`;
        const w0 = Math.max(1, c.bbox.w);
        const h0 = Math.max(1, c.bbox.h);
        const x0 = c.bbox.x;
        const y0 = c.bbox.y;
        const focalY = c.layoutPolicy?.focalY ?? 0.5;

        const sExpr = `max(#__hw_sw/${formatNum(w0)},#__hw_sh/${formatNum(h0)})`;
        const txExpr = `(#__hw_sw-${formatNum(w0)}*#${prefix}_s)/2`;
        const tyExpr = `(#__hw_sh-${formatNum(h0)}*#${prefix}_s)*${formatNum(focalY)}`;
        const oxExpr = `#${prefix}_tx-${formatNum(x0)}*#${prefix}_s`;
        const oyExpr = `#${prefix}_ty-${formatNum(y0)}*#${prefix}_s`;

        injectedVars.push(
          makeVarNode(`${prefix}_s`, sExpr),
          makeVarNode(`${prefix}_tx`, txExpr),
          makeVarNode(`${prefix}_ty`, tyExpr),
          makeVarNode(`${prefix}_ox`, oxExpr),
          makeVarNode(`${prefix}_oy`, oyExpr),
        );
        compTransformMap.set(c.id, {
          kind: 'uniform',
          scaleVar: `#${prefix}_s`,
          oxVar: `#${prefix}_ox`,
          oyVar: `#${prefix}_oy`,
        });
        continue;
      }

      const p24 = p2400.get(c.id);
      const p19 = p1920.get(c.id);
      const wp15 = wp1527.get(c.id);
      const sq = sqRef.get(c.id);
      const lt = ltRef.get(c.id);
      const lw = lwRef.get(c.id);
      if (!p24 || !p19 || !wp15 || !sq || !lt || !lw) continue;

      const prefix = `__hw_c${fgIdx++}`;
      const x0 = c.bbox.x;
      const y0 = c.bbox.y;
      const w0 = Math.max(1, c.bbox.w);
      const h0 = Math.max(1, c.bbox.h);

      // Scale expression across all 5 breakpoints
      const sPort = buildLerpExpr(p19.sx, p24.sx, '#__hw_pt');
      const sWidePort = buildLerpExpr(wp15.sx, p19.sx, '#__hw_wpt');
      const sSq = `${formatNum(sq.sx)}*#__hw_sq_k`;
      const sLt = `${formatNum(lt.sx)}*#__hw_lt_k`;
      const sLw = `${formatNum(lw.sx)}*#__hw_lw_k`;
      const sExpr = `ifelse(#__hw_is_lw,${sLw},#__hw_is_lt,${sLt},#__hw_is_sq,${sSq},#__hw_is_wp,${sWidePort},${sPort})`;

      // Target top-left X expression
      let txPort;
      let txWidePort;
      if (c.semanticRole === 'dock_right') {
        const rightMargin = Math.max(0, baseW - (p24.tx + w0 * p24.sx));
        txPort = `#__hw_sw-${formatNum(rightMargin)}-${formatNum(w0)}*#${prefix}_s`;
        txWidePort = `(${buildLerpExpr(wp15.tx, p19.tx, '#__hw_wpt')})*(#__hw_sw/${baseW})`;
      } else {
        txPort = `(${buildLerpExpr(p19.tx, p24.tx, '#__hw_pt')})*(#__hw_sw/${baseW})`;
        txWidePort = `(${buildLerpExpr(wp15.tx, p19.tx, '#__hw_wpt')})*(#__hw_sw/${baseW})`;
      }
      const txSq = `#__hw_sq_ox+${formatNum(sq.tx)}*#__hw_sq_k`;
      const txLt = buildLandX(c, lt, w0, baseW, prefix, '#__hw_lt_k', '#__hw_lt_ox');
      const txLw = buildLandX(c, lw, w0, baseW, prefix, '#__hw_lw_k', '#__hw_lw_ox');
      const txExpr = `ifelse(#__hw_is_lw,${txLw},#__hw_is_lt,${txLt},#__hw_is_sq,${txSq},#__hw_is_wp,${txWidePort},${txPort})`;

      // Target top-left Y expression
      let tyPort;
      let tyWidePort;
      if (c.semanticRole.startsWith('dock_')) {
        const botMargin = Math.max(0, 2400 - (p24.ty + h0 * p24.sx));
        const portLerpY = buildLerpExpr(p19.ty, p24.ty, '#__hw_pt');
        tyPort = `ifelse(gt(#__hw_sh,2400),#__hw_sh-${formatNum(botMargin)}-${formatNum(h0)}*#${prefix}_s,${portLerpY})`;
        tyWidePort = buildLerpExpr(wp15.ty, p19.ty, '#__hw_wpt');
      } else {
        tyPort = buildLerpExpr(p19.ty, p24.ty, '#__hw_pt');
        tyWidePort = buildLerpExpr(wp15.ty, p19.ty, '#__hw_wpt');
      }
      const tySq = `#__hw_sq_oy+${formatNum(sq.ty)}*#__hw_sq_k`;
      const tyLt = c.semanticRole.startsWith('dock_')
        ? `#__hw_sh-max(14,min(32,#__hw_sh*0.045))-${formatNum(h0)}*#${prefix}_s`
        : `#__hw_lt_oy+${formatNum(lt.ty)}*#__hw_lt_k`;
      const tyLw = c.semanticRole.startsWith('dock_')
        ? `#__hw_sh-max(14,min(32,#__hw_sh*0.045))-${formatNum(h0)}*#${prefix}_s`
        : `#__hw_lw_oy+${formatNum(lw.ty)}*#__hw_lw_k`;
      const tyExpr = `ifelse(#__hw_is_lw,${tyLw},#__hw_is_lt,${tyLt},#__hw_is_sq,${tySq},#__hw_is_wp,${tyWidePort},${tyPort})`;

      const oxExpr = `#${prefix}_tx-${formatNum(x0)}*#${prefix}_s`;
      const oyExpr = `#${prefix}_ty-${formatNum(y0)}*#${prefix}_s`;

      injectedVars.push(
        makeVarNode(`${prefix}_s`, sExpr),
        makeVarNode(`${prefix}_tx`, txExpr),
        makeVarNode(`${prefix}_ty`, tyExpr),
        makeVarNode(`${prefix}_ox`, oxExpr),
        makeVarNode(`${prefix}_oy`, oyExpr),
      );

      compTransformMap.set(c.id, {
        kind: 'uniform',
        scaleVar: `#${prefix}_s`,
        oxVar: `#${prefix}_ox`,
        oyVar: `#${prefix}_oy`,
      });
    }
  } else {
    // Target static mode
    setNodeAttr(root, 'screenWidth', String(targetW));
    injectedVars.push(
      makeVarNode('__hw_sw', '#screen_width'),
      makeVarNode('__hw_sh', '#screen_height'),
    );
    for (const c of themeDOM.components) {
      if (c.semanticRole === 'fullscreen_gesture') {
        compTransformMap.set(c.id, { kind: 'fullscreen_gesture' });
        continue;
      }
      if (c.semanticRole === 'offscreen_ambient') {
        compTransformMap.set(c.id, { kind: 'offscreen_ambient' });
        continue;
      }
      const p = staticPlan.get(c.id);
      if (!p) continue;
      if (c.semanticRole === 'background') {
        const sx = p.sx;
        const ox = p.tx - c.bbox.x * sx;
        const oy = p.ty - c.bbox.y * p.sy;
        compTransformMap.set(c.id, {
          kind: 'uniform',
          scaleVar: formatNum(sx),
          oxVar: formatNum(ox),
          oyVar: formatNum(oy),
        });
        continue;
      }
      const ox = p.tx - c.bbox.x * p.sx;
      const oy = p.ty - c.bbox.y * p.sy;
      compTransformMap.set(c.id, {
        kind: 'uniform',
        scaleVar: formatNum(p.sx),
        oxVar: formatNum(ox),
        oyVar: formatNum(oy),
      });
    }
  }

  // Insert injected <Var> nodes right at the start of <Lockscreen>
  if (injectedVars.length > 0) {
    root.children.unshift(...injectedVars);
    for (const v of injectedVars) v.parent = root;
  }

  // Identify owned groups vs unwrapped container groups
  const ownedGroupIds = new Set(themeDOM.components.map(c => c.ownerGroupId).filter(Boolean));
  const nodeToComp = new Map();
  for (const c of themeDOM.components) {
    for (const mid of c.memberIds) nodeToComp.set(mid, c);
    for (const bid of c.boundButtonIds) nodeToComp.set(bid, c);
  }

  // Determine which Group nodes are ancestors of any component member
  const activeContainerGroupIds = new Set();
  for (const el of themeDOM.elements) {
    if (el.semanticRole === 'hidden_utility') continue;
    for (const gid of el.ancestorGroupIds) {
      if (gid !== root.nodeId) activeContainerGroupIds.add(gid);
    }
  }

  // Identify command-mutated variables whose initial formula is anchored to #screen_height/#h
  const heightAnchoredDynVars = new Set();
  for (const name of ctx.mutatedVarNames || []) {
    const meta = ctx.varMeta.get(name);
    if (!meta?.ast) continue;
    const refs = astCollectVars(meta.ast);
    if (refs.has('screen_height') || refs.has('view_height') || refs.has('h') || refs.has('sh') || refs.has('ysh') || refs.has('sph') || refs.has('mjui_h')) {
      heightAnchoredDynVars.add(name);
    }
  }

  let preservedDynamicGroups = 0;
  let preservedBoundButtons = 0;
  for (const c of themeDOM.components) {
    preservedBoundButtons += (c.boundButtonIds || []).length;
  }

  // Compute cumulative unwrapped offset above each node so owned groups & split members keep exact reference coords
  function applyTransforms(node, unwrappedOffX, unwrappedOffY, insideOwnedComp) {
    if (!node || node.type !== 'element') return;
    const t = node.tagLower;

    // Skip metadata/command subtrees
    if (
      t === 'externalcommands' || t === 'triggers' || t === 'trigger' ||
      t === 'var' || t === 'vararray' || t === 'weather' || t === 'healthy' ||
      t === 'variablebinders' || t === 'mediacontrol' ||
      t.endsWith('animation') || t === 'aniframe' || t === 'source'
    ) {
      return;
    }

    if (t === 'lockscreen' || (!VISUAL_TAGS.has(t) && t !== 'group' && t !== 'stereogroup')) {
      for (const child of node.children) {
        if (!String(child.nodeId).startsWith('gen_')) {
          applyTransforms(child, unwrappedOffX, unwrappedOffY, insideOwnedComp);
        }
      }
      return;
    }

    // Group or StereoGroup
    if (t === 'group' || t === 'stereogroup') {
      if (insideOwnedComp) {
        // Nested sub-group inside an owned component: scale local x, y, w, h by component scale, offset 0
        const tr = compTransformMap.get(insideOwnedComp.id);
        if (tr && tr.kind === 'uniform') {
          rewriteGroupLocalProps(node, ctx, tr.scaleVar, '0', '0');
        }
        for (const child of node.children) {
          applyTransforms(child, 0, 0, insideOwnedComp);
        }
        return;
      }

      if (ownedGroupIds.has(node.nodeId)) {
        const comp = themeDOM.components.find(c => c.ownerGroupId === node.nodeId);
        const tr = comp ? compTransformMap.get(comp.id) : null;
        if (tr && tr.kind === 'uniform') {
          const xRaw = addStaticOffsetExpr(node.attrs.x, unwrappedOffX);
          const yRaw = addStaticOffsetExpr(node.attrs.y, unwrappedOffY);
          setNodeAttr(node, 'x', rewriteExprForTransform({ exprStr: xRaw, ctx, scaleExpr: tr.scaleVar, offsetExpr: tr.oxVar, isSize: false }));
          setNodeAttr(node, 'y', rewriteExprForTransform({ exprStr: yRaw, ctx, scaleExpr: tr.scaleVar, offsetExpr: tr.oyVar, isSize: false }));
          if (node.attrs.w !== undefined) {
            setNodeAttr(node, 'w', rewriteExprForTransform({ exprStr: node.attrs.w, ctx, scaleExpr: tr.scaleVar, isSize: true }));
          }
          if (node.attrs.h !== undefined) {
            setNodeAttr(node, 'h', rewriteExprForTransform({ exprStr: node.attrs.h, ctx, scaleExpr: tr.scaleVar, isSize: true }));
          }
          rewriteAnimationChildren(node, ctx, tr.scaleVar);
        }
        for (const child of node.children) {
          applyTransforms(child, 0, 0, comp);
        }
        return;
      }

      // Unwrapped container group (e.g. giant wrapper or paging wrapper or dynamic animation container)
      let gx = node.attrs.x !== undefined ? Number(ctx.eval(node.attrs.x)) || 0 : 0;
      let gy = node.attrs.y !== undefined ? Number(ctx.eval(node.attrs.y)) || 0 : 0;
      const xMode = classifyDynamicGroupAxis(node.attrs.x, gx, baseW, ctx, 0.35);
      const yMode = classifyDynamicGroupAxis(node.attrs.y, gy, baseH, ctx, 0.18);

      if (activeContainerGroupIds.has(node.nodeId)) {
        const pgInfo = themeDOM.pagingGroups?.[node.nodeId];
        const openX = pgInfo?.openX || 0;
        const openY = pgInfo?.openY || 0;
        if (xMode === 'paging') {
          const closedGx = pgInfo?.gx ?? gx;
          const spanX = Math.abs(closedGx - openX);
          gx = openX;
          preservedDynamicGroups++;
          const rw = rewritePagingScreenVar(node.attrs.x, '#screen_width', ctx);
          const alreadyScreen = rw !== node.attrs.x || /#screen_(width|height)/.test(rw);
          if (alreadyScreen && Math.abs(openX) < 1e-4 && spanX >= baseW * 0.95) {
            setNodeAttr(node, 'x', rw);
          } else {
            const denomX = Math.max(1, Math.min(spanX, baseW));
            const frozenX = freezeScreenVarsExpr(node.attrs.x, ctx);
            const normX = Math.abs(openX) > 1e-4 ? `((${frozenX})-(${formatNum(openX)}))` : `(${frozenX})`;
            setNodeAttr(node, 'x', `(${normX}/${formatNum(denomX)})*#__hw_sw`);
          }
        } else if (xMode === 'dynamic_inplace') {
          preservedDynamicGroups++;
          const frozen = freezeScreenVarsExpr(node.attrs.x, ctx);
          setNodeAttr(
            node,
            'x',
            Math.abs(gx) < 1e-4 ? `(${frozen})*(#__hw_sw/${baseW})` : `((${frozen})-(${formatNum(gx)}))*(#__hw_sw/${baseW})`
          );
        } else if (node.attrs.x !== undefined) {
          setNodeAttr(node, 'x', '0');
        }

        if (yMode === 'paging') {
          const closedGy = pgInfo?.gy ?? gy;
          const spanY = Math.abs(closedGy - openY);
          gy = openY;
          preservedDynamicGroups++;
          const rw = rewritePagingScreenVar(node.attrs.y, '#screen_width', ctx);
          const alreadyScreen = rw !== node.attrs.y || /#screen_height/.test(rw);
          if (alreadyScreen && Math.abs(openY) < 1e-4 && spanY >= baseH * 0.95) {
            setNodeAttr(node, 'y', rw);
          } else {
            const denomY = Math.max(1, Math.min(spanY, baseH));
            const frozenY = freezeScreenVarsExpr(node.attrs.y, ctx);
            const normY = Math.abs(openY) > 1e-4 ? `((${frozenY})-(${formatNum(openY)}))` : `(${frozenY})`;
            setNodeAttr(node, 'y', `(${normY}/${formatNum(denomY)})*#__hw_sh`);
          }
        } else if (yMode === 'dynamic_inplace') {
          preservedDynamicGroups++;
          const frozen = freezeScreenVarsExpr(node.attrs.y, ctx);
          setNodeAttr(
            node,
            'y',
            Math.abs(gy) < 1e-4 ? `(${frozen})*(#__hw_sh/${baseH})` : `((${frozen})-(${formatNum(gy)}))*(#__hw_sh/${baseH})`
          );
        } else if (node.attrs.y !== undefined) {
          setNodeAttr(node, 'y', '0');
        }

        if (node.attrs.w !== undefined && (node.attrs.clip === 'true' || Number(ctx.eval(node.attrs.w)) >= baseW * 0.75)) {
          setNodeAttr(node, 'w', '#screen_width');
        }
        if (node.attrs.h !== undefined && (node.attrs.clip === 'true' || Number(ctx.eval(node.attrs.h)) >= baseH * 0.65)) {
          setNodeAttr(node, 'h', '#screen_height');
        }
      }

      for (const child of node.children) {
        applyTransforms(child, unwrappedOffX + gx, unwrappedOffY + gy, null);
      }
      return;
    }

    // Visual leaf element
    const comp = insideOwnedComp || nodeToComp.get(node.nodeId);
    if (!comp) return; // e.g., hidden_utility

    const tr = compTransformMap.get(comp.id);
    if (!tr) return;

    if (tr.kind === 'fullscreen_gesture') {
      setNodeAttr(node, 'x', '0');
      setNodeAttr(node, 'y', '0');
      setNodeAttr(node, 'w', '#screen_width');
      setNodeAttr(node, 'h', '#screen_height');
      return;
    }

    if (tr.kind === 'offscreen_ambient') {
      const elAmb = elById.get(node.nodeId);
      const ambSx = isUniversal ? `#__hw_sw/${baseW}` : formatNum(targetW / baseW);
      const ambSy = isUniversal ? `#__hw_sh/${baseH}` : formatNum(targetH / baseH);
      const ambS = isUniversal ? `min(${ambSx},${ambSy})` : formatNum(Math.min(targetW / baseW, targetH / baseH));
      const rawX = addStaticOffsetExpr(node.attrs.x, unwrappedOffX);
      const rawY = addStaticOffsetExpr(node.attrs.y, unwrappedOffY);
      setNodeAttr(node, 'x', rewriteExprForTransform({ exprStr: rawX, ctx, scaleExpr: ambSx, offsetExpr: '0', isSize: false }));
      setNodeAttr(node, 'y', rewriteExprForTransform({ exprStr: rawY, ctx, scaleExpr: ambSy, offsetExpr: '0', isSize: false }));
      const wExpr = node.attrs.w !== undefined ? node.attrs.w : (elAmb?.extra?.w ? formatNum(elAmb.extra.w) : null);
      const hExpr = node.attrs.h !== undefined ? node.attrs.h : (elAmb?.extra?.h ? formatNum(elAmb.extra.h) : null);
      if (wExpr !== null) setNodeAttr(node, 'w', rewriteExprForTransform({ exprStr: wExpr, ctx, scaleExpr: ambS, isSize: true }));
      if (hExpr !== null) setNodeAttr(node, 'h', rewriteExprForTransform({ exprStr: hExpr, ctx, scaleExpr: ambS, isSize: true }));
      if (node.attrs.size !== undefined) setNodeAttr(node, 'size', rewriteExprForTransform({ exprStr: node.attrs.size, ctx, scaleExpr: ambS, isSize: true }));
      rewriteAnimationChildren(node, ctx, ambS);
      return;
    }

    const el = elById.get(node.nodeId);
    const useLocalOrigin = Boolean(insideOwnedComp);
    const scaleExpr = tr.scaleVar;
    const oxExpr = useLocalOrigin ? '0' : tr.oxVar;
    const oyExpr = useLocalOrigin ? '0' : tr.oyVar;

    const pageShiftX = (!useLocalOrigin && el?.pageShiftX) ? el.pageShiftX : 0;
    const hasOpenSlideX = !useLocalOrigin && el && el.closedOffscreenX !== 0 && el.openSlideX !== null;
    const hasOpenSlideY = !useLocalOrigin && el && el.closedOffscreenY !== 0 && el.openSlideY !== null;

    const rawX = useLocalOrigin
      ? (node.attrs.x ?? '0')
      : hasOpenSlideX
        ? formatNum(unwrappedOffX + el.openSlideX)
        : addStaticOffsetExpr(node.attrs.x, unwrappedOffX - pageShiftX * baseW);
    const rawY = useLocalOrigin
      ? (node.attrs.y ?? '0')
      : hasOpenSlideY
        ? formatNum(unwrappedOffY + el.openSlideY)
        : addStaticOffsetExpr(node.attrs.y, unwrappedOffY);

    if (t !== 'unlocker' && t !== 'slider') {
      let xExpr = rewriteExprForTransform({ exprStr: rawX, ctx, scaleExpr, offsetExpr: oxExpr, isSize: false });
      if (hasOpenSlideX) {
        const spanX = Math.max(1, Math.abs(el.closedRawX - el.openSlideX));
        const denomX = Math.min(spanX, baseW);
        const frozenRawX = freezeScreenVarsExpr(node.attrs.x, ctx);
        xExpr = `(${xExpr})+(((${frozenRawX})-(${formatNum(el.openSlideX)}))/${formatNum(denomX)})*#__hw_sw`;
      } else if (pageShiftX > 0) {
        xExpr = `${xExpr}+${pageShiftX}*#__hw_sw`;
      } else if (pageShiftX < 0) {
        xExpr = `${xExpr}-${-pageShiftX}*#__hw_sw`;
      }
      setNodeAttr(node, 'x', xExpr);

      let yExpr = rewriteExprForTransform({ exprStr: rawY, ctx, scaleExpr, offsetExpr: oyExpr, isSize: false });
      if (hasOpenSlideY) {
        const spanY = Math.max(1, Math.abs(el.closedRawY - el.openSlideY));
        const denomY = Math.min(spanY, baseH);
        const frozenRawY = freezeScreenVarsExpr(node.attrs.y, ctx);
        yExpr = `(${yExpr})+(((${frozenRawY})-(${formatNum(el.openSlideY)}))/${formatNum(denomY)})*#__hw_sh`;
      } else if (heightAnchoredDynVars.size > 0 && yExpr) {
        yExpr = yExpr.replace(/#([A-Za-z0-9_]+)/g, (m, vn) =>
          heightAnchoredDynVars.has(vn) ? `(#${vn}-(#screen_height-${baseH}))` : m
        );
      }
      setNodeAttr(node, 'y', yExpr);
    } else {
      if (node.attrs.x !== undefined) setNodeAttr(node, 'x', rewriteExprForTransform({ exprStr: rawX, ctx, scaleExpr, offsetExpr: oxExpr, isSize: false }));
      if (node.attrs.y !== undefined) setNodeAttr(node, 'y', rewriteExprForTransform({ exprStr: rawY, ctx, scaleExpr, offsetExpr: oyExpr, isSize: false }));
    }

    // Width / Height / Size / Radius / Pivots
    if (t === 'image' || t === 'wallpaper' || t === 'video' || t === 'mediaicon') {
      const wExpr = node.attrs.w !== undefined ? node.attrs.w : (el?.extra?.w ? formatNum(el.extra.w) : null);
      const hExpr = node.attrs.h !== undefined ? node.attrs.h : (el?.extra?.h ? formatNum(el.extra.h) : null);
      if (wExpr !== null) {
        setNodeAttr(node, 'w', rewriteExprForTransform({ exprStr: wExpr, ctx, scaleExpr, isSize: true }));
      }
      if (hExpr !== null) {
        setNodeAttr(node, 'h', rewriteExprForTransform({ exprStr: hExpr, ctx, scaleExpr, isSize: true }));
      }
    } else if (t === 'text' || t === 'datetime') {
      const szExpr = node.attrs.size !== undefined ? node.attrs.size : (el?.extra?.fontSize ? formatNum(el.extra.fontSize) : null);
      if (szExpr !== null) {
        setNodeAttr(node, 'size', rewriteExprForTransform({ exprStr: szExpr, ctx, scaleExpr, isSize: true }));
      }
      if (node.attrs.w !== undefined) {
        setNodeAttr(node, 'w', rewriteExprForTransform({ exprStr: node.attrs.w, ctx, scaleExpr, isSize: true }));
      }
      if (node.attrs.width !== undefined) {
        setNodeAttr(node, 'width', rewriteExprForTransform({ exprStr: node.attrs.width, ctx, scaleExpr, isSize: true }));
      }
      if (node.attrs.h !== undefined) {
        setNodeAttr(node, 'h', rewriteExprForTransform({ exprStr: node.attrs.h, ctx, scaleExpr, isSize: true }));
      }
    } else if (t === 'circle') {
      if (node.attrs.r !== undefined) {
        setNodeAttr(node, 'r', rewriteExprForTransform({ exprStr: node.attrs.r, ctx, scaleExpr, isSize: true }));
      }
      if (node.attrs.w !== undefined) setNodeAttr(node, 'w', rewriteExprForTransform({ exprStr: node.attrs.w, ctx, scaleExpr, isSize: true }));
      if (node.attrs.h !== undefined) setNodeAttr(node, 'h', rewriteExprForTransform({ exprStr: node.attrs.h, ctx, scaleExpr, isSize: true }));
    } else if (t === 'imagenumber' || t === 'imageseries') {
      const wExpr = node.attrs.w !== undefined ? node.attrs.w : (el?.extra?.w ? formatNum(el.extra.w) : null);
      const hExpr = node.attrs.h !== undefined ? node.attrs.h : (el?.extra?.h ? formatNum(el.extra.h) : null);
      if (wExpr !== null) setNodeAttr(node, 'w', rewriteExprForTransform({ exprStr: wExpr, ctx, scaleExpr, isSize: true }));
      if (hExpr !== null) setNodeAttr(node, 'h', rewriteExprForTransform({ exprStr: hExpr, ctx, scaleExpr, isSize: true }));
      if (node.attrs.space !== undefined) setNodeAttr(node, 'space', rewriteExprForTransform({ exprStr: node.attrs.space, ctx, scaleExpr, isSize: true }));
    } else {
      if (node.attrs.w !== undefined) setNodeAttr(node, 'w', rewriteExprForTransform({ exprStr: node.attrs.w, ctx, scaleExpr, isSize: true }));
      if (node.attrs.h !== undefined) setNodeAttr(node, 'h', rewriteExprForTransform({ exprStr: node.attrs.h, ctx, scaleExpr, isSize: true }));
      if (node.attrs.cornerRadius !== undefined) {
        const parts = String(node.attrs.cornerRadius).split(',').map(p =>
          rewriteExprForTransform({ exprStr: p.trim(), ctx, scaleExpr, isSize: true })
        );
        setNodeAttr(node, 'cornerRadius', parts.join(','));
      }
    }

    for (const pAttr of ['pivotX', 'pivotY', 'centerX', 'centerY', 'iconWidth', 'iconHeight', 'progressWidth', 'roundedCorners']) {
      if (node.attrs[pAttr] !== undefined) {
        setNodeAttr(node, pAttr, rewriteExprForTransform({ exprStr: node.attrs[pAttr], ctx, scaleExpr, isSize: true }));
      }
    }

    // Rewrite child <Mask> & Animations
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (child.tagLower === 'mask') {
        const mAlign = (child.attrs.align || 'relative').toLowerCase();
        const mOx = mAlign === 'absolute' ? oxExpr : '0';
        const mOy = mAlign === 'absolute' ? oyExpr : '0';
        if (child.attrs.x !== undefined) {
          setNodeAttr(child, 'x', rewriteExprForTransform({ exprStr: child.attrs.x, ctx, scaleExpr, offsetExpr: mOx, isSize: mAlign !== 'absolute' }));
        }
        if (child.attrs.y !== undefined) {
          setNodeAttr(child, 'y', rewriteExprForTransform({ exprStr: child.attrs.y, ctx, scaleExpr, offsetExpr: mOy, isSize: mAlign !== 'absolute' }));
        }
        if (child.attrs.w !== undefined) {
          setNodeAttr(child, 'w', rewriteExprForTransform({ exprStr: child.attrs.w, ctx, scaleExpr, isSize: true }));
        }
        if (child.attrs.h !== undefined) {
          setNodeAttr(child, 'h', rewriteExprForTransform({ exprStr: child.attrs.h, ctx, scaleExpr, isSize: true }));
        }
      }
    }
    rewriteAnimationChildren(node, ctx, scaleExpr);
  }

  applyTransforms(root, 0, 0, null);
  const interactionStats = {
    mutatedLogicCount: 0,
    preservedDynamicGroups,
    preservedBoundButtons,
  };

  return {
    xml: serializeXml(outDoc),
    doc: outDoc,
    targetTransforms: staticPlan,
    layoutDiagnostics,
    interactionStats,
  };
}

function buildLandX(c, plan, w0, baseW, prefix, kVar, oxVar) {
  if (c.semanticRole === 'dock_left') {
    return `max(12,${formatNum(plan.tx)}*${kVar})`;
  }
  if (c.semanticRole === 'dock_right') {
    const rightMargin = Math.max(12, baseW - (plan.tx + w0 * plan.sx));
    return `#__hw_sw-${formatNum(rightMargin)}*${kVar}-${formatNum(w0)}*#${prefix}_s`;
  }
  return `${oxVar}+${formatNum(plan.tx)}*${kVar}`;
}

function rewriteGroupLocalProps(node, ctx, scaleExpr, oxExpr, oyExpr) {
  if (node.attrs.x !== undefined) {
    setNodeAttr(node, 'x', rewriteExprForTransform({ exprStr: node.attrs.x, ctx, scaleExpr, offsetExpr: oxExpr, isSize: oxExpr === '0' }));
  }
  if (node.attrs.y !== undefined) {
    setNodeAttr(node, 'y', rewriteExprForTransform({ exprStr: node.attrs.y, ctx, scaleExpr, offsetExpr: oyExpr, isSize: oyExpr === '0' }));
  }
  if (node.attrs.w !== undefined) {
    setNodeAttr(node, 'w', rewriteExprForTransform({ exprStr: node.attrs.w, ctx, scaleExpr, isSize: true }));
  }
  if (node.attrs.h !== undefined) {
    setNodeAttr(node, 'h', rewriteExprForTransform({ exprStr: node.attrs.h, ctx, scaleExpr, isSize: true }));
  }
  rewriteAnimationChildren(node, ctx, scaleExpr);
}

function rewriteAnimationChildren(node, ctx, scaleExpr) {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.tagLower === 'positionanimation') {
      for (const pos of child.children) {
        if (pos.type !== 'element' || pos.tagLower !== 'position') continue;
        if (pos.attrs.x !== undefined) {
          setNodeAttr(pos, 'x', rewriteExprForTransform({ exprStr: pos.attrs.x, ctx, scaleExpr, isSize: true }));
        }
        if (pos.attrs.y !== undefined) {
          setNodeAttr(pos, 'y', rewriteExprForTransform({ exprStr: pos.attrs.y, ctx, scaleExpr, isSize: true }));
        }
      }
    } else if (child.tagLower === 'sizeanimation') {
      for (const sz of child.children) {
        if (sz.type !== 'element' || sz.tagLower !== 'size') continue;
        if (sz.attrs.w !== undefined) {
          setNodeAttr(sz, 'w', rewriteExprForTransform({ exprStr: sz.attrs.w, ctx, scaleExpr, isSize: true }));
        }
        if (sz.attrs.h !== undefined) {
          setNodeAttr(sz, 'h', rewriteExprForTransform({ exprStr: sz.attrs.h, ctx, scaleExpr, isSize: true }));
        }
      }
    }
  }
}

function rewritePagingScreenVar(exprStr, screenVar, ctx) {
  // Replace screen-derived width/height var tokens like #w or #sw with #screen_width
  return String(exprStr).replace(/#([A-Za-z0-9_]+)/g, (m, name) => {
    const meta = ctx.varMeta.get(name);
    if (meta && meta.depClass === 'screen_derived') {
      if (name === 'w' || name === 'sw' || name === 'ysw' || name === 'mjui_w' || name === 'spw') return screenVar;
      if (name === 'h' || name === 'sh' || name === 'ysh' || name === 'mjui_h' || name === 'sph') return '#screen_height';
    }
    return m;
  });
}

function buildLerpExpr(v0, v1, tVar) {
  const diff = v1 - v0;
  if (Math.abs(diff) < 0.0005) return formatNum(v0);
  if (Math.abs(v0) < 0.0005) return `${formatNum(diff)}*${tVar}`;
  return diff >= 0
    ? `${formatNum(v0)}+${formatNum(diff)}*${tVar}`
    : `${formatNum(v0)}-${formatNum(-diff)}*${tVar}`;
}
