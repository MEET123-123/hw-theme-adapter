/**
 * Interactive State Machine (FSM) Extractor & Multi-State Layout Response Analyzer.
 *
 * Automatically discovers each Huawei Lockscreen theme's real interactive state machine:
 * - State variables (<Var> mutated by <VariableCommand>, animated via <Command>, or system states)
 * - Executable transitions (<Button> / <Trigger> / *Command / swipe & coordinate expressions)
 * - Visually distinct reachable states (S0_default .. Sk)
 * - State-aware layout response metrics across Huawei device form factors & aspect ratios
 */

import { walkElements } from '../xml/parser.js';
import { buildRuntimeContext, astCollectVars } from '../expr/evaluator.js';
import { areVariantsCompatible, isFullScreenNode, VISUAL_TAGS } from '../ir/transpiler.js';
import { DEFAULT_VALIDATION_DEVICES } from '../devices/huawei_devices.js';
import { evaluateXmlAtViewport } from '../validator/validator.js';

const SYSTEM_STATE_VARS = [
  { name: 'charge_anim', label: '充电动画状态', category: 'system_state', sceneHint: 'charging', values: [1] },
  { name: 'battery_state', label: '充电电量状态', category: 'system_state', sceneHint: 'charging', values: [1] },
  { name: 'media_play_status', label: '媒体播放状态', category: 'system_state', sceneHint: 'main', values: [1] },
  { name: 'flashlight', label: '手电筒状态', category: 'system_state', sceneHint: 'main', values: [1] },
  { name: 'flashlightValue', label: '手电筒开关值', category: 'system_state', sceneHint: 'main', values: [1] },
];

const IGNORE_STATE_VARS = new Set([
  'screen_width', 'screen_height', 'view_width', 'view_height',
  'touch_x', 'touch_y', 'touch_begin_x', 'touch_begin_y', 'touch_pressure',
  'time', 'time_sys', 'hour12', 'hour24', 'minute', 'second', 'ampm',
  'year', 'month', 'date', 'day_of_week', 'battery_level', 'step', 'steps',
  'frame_rate', 'raw_screen_width', 'raw_screen_height',
]);

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
    if (!b || (b.w <= 0 && b.h <= 0)) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

function isVisibleItem(it, W, H) {
  return Boolean(
    it && it.visible && !it.clippedOut && it.w > 1 && it.h > 1 &&
    it.x + it.w > 2 && it.x < W - 2 && it.y + it.h > 2 && it.y < H - 2
  );
}

function inferStateVarMeta(name) {
  const n = name.toLowerCase();
  if (/charge|chongdian|battery_state/.test(n)) {
    return { category: 'system_state', sceneHint: 'charging', label: `充电态 (${name})` };
  }
  if (/flashlight/.test(n)) {
    return { category: 'system_state', sceneHint: 'main', label: `手电筒 (${name})` };
  }
  if (/media_play|music|yyck/.test(n)) {
    return { category: 'system_state', sceneHint: 'main', label: `音乐控制 (${name})` };
  }
  if (/guide|tips|teach/.test(n)) {
    return { category: 'modal_panel', sceneHint: 'guide', label: `引导浮层 (${name})` };
  }
  if (/onesec|sec_page|drawer|kp_ani|kpflag|cehua|cbl/.test(n)) {
    return { category: 'drawer_slide', sceneHint: 'drawer', label: `侧滑/负一屏 (${name})` };
  }
  if (/more_st|set_go|set_v|set_control|p_set|kzltc|rltc|wintc|setsho|mbdk|setting|panel|tan\d|tan_a|tanchuang|menu|edit|qmedit/.test(n)) {
    return { category: 'modal_panel', sceneHint: 'settings', label: `设置/弹窗面板 (${name})` };
  }
  if (/style|bg|backs|theme|color|lockstyle|timestyle|qhym|qhid|qhbz|tcjm|bjjm|page|group|cscd|mode|xq|msym|tqym|tzym|xzym/.test(n)) {
    return { category: 'style_switch', sceneHint: 'main', label: `模式/样式切换 (${name})` };
  }
  return { category: 'widget_toggle', sceneHint: 'main', label: `交互组件态 (${name})` };
}

function inferSceneHintForState(varsObj, stateVarMetaMap) {
  let hint = 'main';
  for (const [k, v] of Object.entries(varsObj || {})) {
    if (v === 0 || v === '0') continue;
    const m = stateVarMetaMap.get(k);
    if (m?.sceneHint && m.sceneHint !== 'main') {
      hint = m.sceneHint;
      break;
    }
    const inferred = inferStateVarMeta(k);
    if (inferred.sceneHint !== 'main') {
      hint = inferred.sceneHint;
      break;
    }
  }
  return hint;
}

/**
 * Collect numeric/toggle candidate values from VariableCommand expressions & animations.
 */
function inferDomainValues(varName, initVal, cmds, animInfo) {
  const vals = new Set();
  const initNum = Number.isFinite(Number(initVal)) ? Number(initVal) : 0;

  if (animInfo) {
    if (Number.isFinite(animInfo.endVal) && Math.abs(animInfo.endVal - initNum) > 1e-4) {
      vals.add(animInfo.endVal);
    }
    if (Number.isFinite(animInfo.startVal) && Math.abs(animInfo.startVal - initNum) > 1e-4) {
      vals.add(animInfo.startVal);
    }
  }

  for (const cmd of cmds || []) {
    const raw = String(cmd.expression ?? '').trim();
    if (!raw) continue;
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      const n = Number(raw);
      if (Math.abs(n - initNum) > 1e-4) vals.add(n);
      continue;
    }
    // Pattern: ifelse(#x == 0, 1, 0) or ifelse(#x, 0, 1)
    const ifelseMatches = [...raw.matchAll(/ifelse\s*\([^,]+,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g)];
    for (const m of ifelseMatches) {
      const a = Number(m[1]), b = Number(m[2]);
      if (Math.abs(a - initNum) > 1e-4) vals.add(a);
      if (Math.abs(b - initNum) > 1e-4) vals.add(b);
    }
    // Pattern: (#x + 1) % N
    const modMatch = /%\s*(\d+)/.exec(raw);
    if (modMatch) {
      const nMod = Math.min(5, Math.max(2, Number(modMatch[1])));
      for (let k = 0; k < nMod; k++) {
        if (k !== initNum) vals.add(k);
      }
    }
    // Fallback ternary comparison or !#x
    if (/!|#\w+\s*==\s*0|eq\s*\(/.test(raw) && vals.size === 0) {
      vals.add(initNum === 0 ? 1 : 0);
    }
  }

  if (vals.size === 0) {
    vals.add(initNum === 0 ? 1 : 0);
  }

  return [...vals].slice(0, 4);
}

/**
 * Evaluate which components / nodes are visibly active at viewport (W, H) given variable overrides.
 */
export function buildEvalOptionsForState(varsObj, themeDOM, { sceneHint = 'main', isOrig = false } = {}) {
  const activeVarNames = new Set(
    Object.entries(varsObj || {})
      .filter(([, v]) => Number(v) !== 0 && String(v) !== '0' && String(v) !== '')
      .map(([k]) => k)
  );
  if (sceneHint === 'main' && activeVarNames.size === 0) {
    return { isOrig };
  }

  const openPagingGroups = {};
  for (const [gid, info] of Object.entries(themeDOM.pagingGroups || {})) {
    let related = false;
    for (const el of themeDOM.elements) {
      if (el.ancestorGroupIds.includes(gid) && (sceneHint !== 'main' && el.scene === sceneHint)) {
        related = true;
        break;
      }
    }
    if (related || sceneHint === 'drawer') {
      openPagingGroups[gid] = info;
    }
  }

  const settledElements = new Map();
  if (sceneHint !== 'main') {
    for (const el of themeDOM.elements) {
      if (
        el.scene === sceneHint &&
        (el.settledDeltaX || el.settledDeltaY || el.pageShiftX || el.openSlideX !== null || el.openSlideY !== null)
      ) {
        settledElements.set(el.nodeId, el);
      }
    }
  }

  return {
    openPagingGroups: Object.keys(openPagingGroups).length > 0 ? openPagingGroups : null,
    settledElements: settledElements.size > 0 ? settledElements : null,
    isOrig,
  };
}

function summarizeRenderSnapshot(evalRes, themeDOM, W, H) {
  const visibleCompIds = [];
  const compCenters = new Map();
  const itemById = evalRes.itemByNodeId;

  for (const c of themeDOM.components) {
    if (c.semanticRole === 'hidden_utility' || c.semanticRole === 'fullscreen_gesture' || c.semanticRole === 'offscreen_ambient') continue;
    const visMembers = c.memberIds
      .map(id => itemById.get(id))
      .filter(it => isVisibleItem(it, W, H));
    if (visMembers.length === 0) continue;
    const u = bboxUnion(visMembers);
    visibleCompIds.push(c.id);
    compCenters.set(c.id, {
      cx: Math.round((u.x + u.w / 2) * 10) / 10,
      cy: Math.round((u.y + u.h / 2) * 10) / 10,
      w: Math.round(u.w),
      h: Math.round(u.h),
    });
  }

  // Also include asset/text signature to catch pure skin/background/image swaps (same bbox, different image)
  const assetSigParts = [];
  for (const it of evalRes.items) {
    if (!isVisibleItem(it, W, H)) continue;
    if (it.tagLower === 'button') continue;
    if (it.resolvedAsset) assetSigParts.push(`${it.nodeId}:${it.resolvedAsset}`);
    else if (it.text) assetSigParts.push(`${it.nodeId}:t=${it.text}`);
  }

  visibleCompIds.sort();
  return {
    visibleCompIds,
    compCenters,
    assetSig: assetSigParts.sort().join('|'),
    structureSig: visibleCompIds.join(','),
  };
}

function diffSnapshots(baseSnap, curSnap) {
  const baseSet = new Set(baseSnap.visibleCompIds);
  const curSet = new Set(curSnap.visibleCompIds);
  const addedComponentIds = curSnap.visibleCompIds.filter(id => !baseSet.has(id));
  const removedComponentIds = baseSnap.visibleCompIds.filter(id => !curSet.has(id));
  const movedComponentIds = [];
  for (const id of curSnap.visibleCompIds) {
    if (!baseSet.has(id)) continue;
    const a = baseSnap.compCenters.get(id);
    const b = curSnap.compCenters.get(id);
    if (!a || !b) continue;
    if (Math.hypot(b.cx - a.cx, b.cy - a.cy) > 15 || Math.abs(b.w - a.w) > 15 || Math.abs(b.h - a.h) > 15) {
      movedComponentIds.push(id);
    }
  }
  const changedAssets = baseSnap.assetSig !== curSnap.assetSig;
  return {
    addedComponentIds,
    removedComponentIds,
    movedComponentIds,
    changedAssets,
    isDifferent:
      addedComponentIds.length > 0 ||
      removedComponentIds.length > 0 ||
      movedComponentIds.length > 0 ||
      changedAssets,
  };
}

/**
 * Extract the interactive Finite State Machine (State Vars, Animations, Triggers, Reachable States, Transitions).
 */
export function extractStateMachine(doc, themeDOM, assetIndex = null) {
  const { baseW, baseH } = themeDOM.canvas;
  const ctx = buildRuntimeContext(doc.root, baseW, baseH, {}, assetIndex);

  const varDecls = new Map();
  const animations = {};
  const cmdsByVar = new Map();
  const visualRefsByVar = new Map(); // varName -> { vis, pos, size, alpha, asset }
  const triggers = [];

  const elById = new Map(themeDOM.elements.map(e => [e.nodeId, e]));
  const compByNodeId = new Map();
  for (const c of themeDOM.components) {
    for (const mid of c.memberIds) compByNodeId.set(mid, c);
    for (const bid of c.boundButtonIds) compByNodeId.set(bid, c);
  }

  function recordVisualRef(varName, kind) {
    if (!varName || IGNORE_STATE_VARS.has(varName) || varName.startsWith('__hw_')) return;
    if (!visualRefsByVar.has(varName)) {
      visualRefsByVar.set(varName, { vis: 0, pos: 0, size: 0, alpha: 0, asset: 0 });
    }
    visualRefsByVar.get(varName)[kind]++;
  }

  function scanVarRefsInAttr(attrVal, kind) {
    if (!attrVal) return;
    for (const m of String(attrVal).matchAll(/[#@]([A-Za-z_][A-Za-z0-9_]*)/g)) {
      recordVisualRef(m[1], kind);
    }
  }

  walkElements(doc.root, (node) => {
    const t = node.tagLower;

    if (t === 'var' && node.attrs.name) {
      const name = node.attrs.name;
      const initRaw = ctx.getVar(name, '#');
      const initVal = Number.isFinite(Number(initRaw)) ? Number(initRaw) : 0;
      varDecls.set(name, {
        name,
        type: node.attrs.type || 'number',
        expression: node.attrs.expression ?? null,
        initialValue: initVal,
      });

      for (const child of node.children || []) {
        if (child.type === 'element' && child.tagLower === 'variableanimation') {
          const frames = (child.children || [])
            .filter(f => f.type === 'element' && f.tagLower === 'aniframe')
            .map(f => ({ value: Number(f.attrs.value), time: Number(f.attrs.time || 0) }))
            .filter(f => Number.isFinite(f.value));
          if (frames.length > 0) {
            const animInfo = {
              varName: name,
              targetName: child.attrs.name || name,
              startVal: frames[0].value,
              endVal: frames[frames.length - 1].value,
              frames,
            };
            animations[name] = animInfo;
            if (child.attrs.name) animations[child.attrs.name] = animInfo;
          }
        }
      }
    }

    if (t === 'variablecommand' && node.attrs.name) {
      const vName = node.attrs.name;
      if (!cmdsByVar.has(vName)) cmdsByVar.set(vName, []);
      cmdsByVar.get(vName).push({
        expression: node.attrs.expression ?? '',
        condition: node.attrs.condition ?? '',
        parentAction: node.parent?.attrs?.action || 'up',
      });
    }

    if (VISUAL_TAGS.has(t) || t === 'group' || t === 'stereogroup') {
      scanVarRefsInAttr(node.attrs.visibility, 'vis');
      scanVarRefsInAttr(node.attrs.x, 'pos');
      scanVarRefsInAttr(node.attrs.y, 'pos');
      scanVarRefsInAttr(node.attrs.w, 'size');
      scanVarRefsInAttr(node.attrs.h, 'size');
      scanVarRefsInAttr(node.attrs.width, 'size');
      scanVarRefsInAttr(node.attrs.size, 'size');
      scanVarRefsInAttr(node.attrs.alpha, 'alpha');
      scanVarRefsInAttr(node.attrs.srcid, 'asset');
      scanVarRefsInAttr(node.attrs.src, 'asset');
      scanVarRefsInAttr(node.attrs.srcExp, 'asset');
      scanVarRefsInAttr(node.attrs.textExp, 'asset');
    }

    if (t === 'button') {
      const el = elById.get(node.nodeId);
      const comp = compByNodeId.get(node.nodeId);
      const btnTriggers = [];

      const scanTriggers = (cur) => {
        for (const ch of cur.children || []) {
          if (ch.type !== 'element') continue;
          if (ch.tagLower === 'triggers') scanTriggers(ch);
          else if (ch.tagLower === 'trigger') {
            const cmds = [];
            for (const cmd of ch.children || []) {
              if (cmd.type !== 'element') continue;
              if (cmd.tagLower === 'variablecommand' || cmd.tagLower === 'command' || cmd.tagLower === 'externcommand' || cmd.tagLower === 'intentcommand') {
                cmds.push({
                  type: cmd.tag,
                  name: cmd.attrs.name || null,
                  target: cmd.attrs.target || null,
                  value: cmd.attrs.value || null,
                  command: cmd.attrs.command || null,
                  package: cmd.attrs.package || cmd.attrs.class || null,
                  expression: cmd.attrs.expression ?? null,
                  condition: cmd.attrs.condition ?? null,
                });
              }
            }
            if (cmds.length > 0) {
              btnTriggers.push({
                action: (ch.attrs.action || 'up').toLowerCase(),
                condition: ch.attrs.condition || null,
                commands: cmds,
              });
            }
          }
        }
      };
      scanTriggers(node);

      if (btnTriggers.length > 0) {
        triggers.push({
          buttonNodeId: node.nodeId,
          boundComponentId: comp?.id || null,
          scene: el?.scene || comp?.scene || 'main',
          isFullscreen: comp?.semanticRole === 'fullscreen_gesture',
          bbox: el?.bbox || { x: 0, y: 0, w: baseW, h: baseH },
          triggers: btnTriggers,
        });
      }
    }
  });

  // Collect candidate state variables
  const candidateVarNames = new Set([
    ...cmdsByVar.keys(),
    ...Object.values(animations).map(a => a.varName),
    ...SYSTEM_STATE_VARS.filter(s => visualRefsByVar.has(s.name)).map(s => s.name),
  ]);

  const stateVars = [];
  const stateVarMetaMap = new Map();

  for (const vName of candidateVarNames) {
    if (IGNORE_STATE_VARS.has(vName) || vName.startsWith('__hw_')) continue;
    const refs = visualRefsByVar.get(vName);
    if (!refs) continue;

    const cmds = cmdsByVar.get(vName) || [];
    const animInfo = animations[vName] || null;
    const sysInfo = SYSTEM_STATE_VARS.find(s => s.name === vName) || null;

    // Exclude transient button-press feedback alpha vars (e.g., app1_alp=255/100 only in alpha on down/up)
    const nonAlphaRefs = refs.vis + refs.pos + refs.size + refs.asset;
    const isTransientAlpha = nonAlphaRefs === 0 && refs.alpha > 0 && (
      /_alp$/i.test(vName) ||
      /app\d+a$/i.test(vName) ||
      cmds.every(c => c.parentAction === 'down' || (c.parentAction === 'up' && /^(100|255|0)$/.test(String(c.expression).trim())))
    );
    if (isTransientAlpha && !sysInfo) continue;

    const decl = varDecls.get(vName);
    const initialValue = decl ? decl.initialValue : (Number(ctx.getVar(vName, '#')) || 0);
    const domain = sysInfo
      ? sysInfo.values.filter(v => v !== initialValue)
      : inferDomainValues(vName, initialValue, cmds, animInfo);

    if (domain.length === 0) continue;

    const meta = sysInfo || inferStateVarMeta(vName);
    const impactScore =
      refs.vis * 4 +
      refs.pos * 3 +
      refs.asset * 2 +
      refs.size * 2 +
      refs.alpha * 1 +
      cmds.length * 0.5 +
      (meta.category === 'drawer_slide' || meta.category === 'modal_panel' ? 6 : 0) +
      (meta.category === 'system_state' ? 5 : 0);

    const sv = {
      name: vName,
      label: meta.label,
      category: meta.category,
      sceneHint: meta.sceneHint,
      initialValue,
      domain,
      visualRefs: refs,
      commandCount: cmds.length,
      hasAnimation: Boolean(animInfo),
      impactScore: Math.round(impactScore * 10) / 10,
    };
    stateVars.push(sv);
    stateVarMetaMap.set(vName, sv);
  }

  // Also ensure varDecls referenced indirectly by animations via <Command> are visible if helpful
  stateVars.sort((a, b) => b.impactScore - a.impactScore);

  // Sample visually distinct states by overriding one variable at a time.
  const states = [];
  const defaultEval = evaluateXmlAtViewport(doc, assetIndex, baseW, baseH, {});
  const defaultSnap = summarizeRenderSnapshot(defaultEval, themeDOM, baseW, baseH);

  states.push({
    id: 'S0_default',
    label: '默认主锁屏态',
    category: 'default',
    sceneHint: 'main',
    vars: {},
    visibleComponentIds: defaultSnap.visibleCompIds,
    addedComponentIds: [],
    removedComponentIds: [],
    movedComponentIds: [],
    changedAssets: false,
    signature: defaultSnap.structureSig + '##' + defaultSnap.assetSig,
  });

  const seenSignatures = new Set([states[0].signature]);
  const seenStructSigs = new Set([defaultSnap.structureSig]);

  // Expand up to top 22 ranked state vars to find up to 11 distinct non-default states
  for (const sv of stateVars.slice(0, 22)) {
    if (states.length >= 12) break;
    for (const val of sv.domain.slice(0, 2)) {
      if (states.length >= 12) break;
      const candVars = { [sv.name]: val };
      const sceneHint = inferSceneHintForState(candVars, stateVarMetaMap);
      const evalOpts = buildEvalOptionsForState(candVars, themeDOM, { sceneHint, isOrig: true });
      const evalRes = evaluateXmlAtViewport(doc, assetIndex, baseW, baseH, candVars, evalOpts);
      const snap = summarizeRenderSnapshot(evalRes, themeDOM, baseW, baseH);
      const sig = snap.structureSig + '##' + snap.assetSig;

      if (seenSignatures.has(sig)) continue;
      const diff = diffSnapshots(defaultSnap, snap);
      if (!diff.isDifferent) continue;

      // Avoid exploding purely identical structural states unless it adds genuine layout/asset variation
      if (seenStructSigs.has(snap.structureSig) && !diff.changedAssets && diff.movedComponentIds.length === 0) {
        continue;
      }

      seenSignatures.add(sig);
      seenStructSigs.add(snap.structureSig);

      const stateId = `S${states.length}_${sv.name}_${String(val).replace(/[^A-Za-z0-9_]/g, '')}`;
      states.push({
        id: stateId,
        label: `${sv.label.replace(/\s*\([^)]+\)/, '')} (${sv.name}=${val})`,
        category: sv.category,
        sceneHint,
        primaryVar: sv.name,
        primaryValue: val,
        vars: candVars,
        visibleComponentIds: snap.visibleCompIds,
        addedComponentIds: diff.addedComponentIds,
        removedComponentIds: diff.removedComponentIds,
        movedComponentIds: diff.movedComponentIds,
        changedAssets: diff.changedAssets,
        signature: sig,
      });
    }
  }

  // Build transitions from triggers -> states
  const transitions = [];
  for (const st of states.slice(1)) {
    const pv = st.primaryVar;
    let matchedTrigger = null;
    for (const bt of triggers) {
      for (const tr of bt.triggers) {
        for (const cmd of tr.commands) {
          if (cmd.name === pv || (animations[cmd.target]?.varName === pv)) {
            matchedTrigger = {
              fromStateId: 'S0_default',
              toStateId: st.id,
              buttonNodeId: bt.buttonNodeId,
              boundComponentId: bt.boundComponentId,
              isFullscreen: bt.isFullscreen,
              gesture: /#touch_(begin_)?y/.test(tr.condition || cmd.condition || '')
                ? 'swipe_y'
                : /#touch_(begin_)?x/.test(tr.condition || cmd.condition || '')
                  ? 'swipe_x'
                  : tr.action,
              variable: pv,
              targetValue: st.primaryValue,
            };
            break;
          }
        }
        if (matchedTrigger) break;
      }
      if (matchedTrigger) break;
    }
    if (!matchedTrigger && st.category === 'system_state') {
      matchedTrigger = {
        fromStateId: 'S0_default',
        toStateId: st.id,
        buttonNodeId: null,
        boundComponentId: null,
        isFullscreen: false,
        gesture: 'system_event',
        variable: pv,
        targetValue: st.primaryValue,
      };
    }
    if (matchedTrigger) transitions.push(matchedTrigger);
  }

  return {
    themeName: themeDOM.themeName,
    summary: {
      totalStateVars: stateVars.length,
      discoveredStates: states.length,
      interactiveButtons: triggers.length,
      animationsCount: Object.keys(animations).length,
      transitionsCount: transitions.length,
    },
    stateVars: stateVars.slice(0, 30),
    animations,
    triggers,
    states: states.map(({ signature, ...rest }) => rest),
    transitions,
    coverage: { method: 'single_variable_sampling', transitionMethod: 'inferred_from_trigger_references' },
  };
}

function classifyLayoutMode(device) {
  const { breakpoint, hinges = [], isCompactCover } = device;
  if (isCompactCover) return 'compact_cover_stack';
  if (hinges.length >= 2) return 'tri_fold_3panel_hinge_aware';
  if (hinges.length === 1) return 'dual_fold_2panel_hinge_split';
  if (breakpoint === 'landscape_wide') return 'landscape_wide_two_col';
  if (breakpoint === 'landscape_tablet') return 'landscape_tablet_two_col';
  if (breakpoint === 'wide_portrait') return 'wide_portrait_adaptive';
  return 'portrait_proportional';
}

/**
 * Analyze adapted layout responses across ALL discovered interactive states and target devices.
 */
export function analyzeStateLayoutResponses({
  themeDOM,
  origDoc,
  adaptedDoc,
  assetIndex,
  stateMachine,
  devices = DEFAULT_VALIDATION_DEVICES,
}) {
  const sm = stateMachine || extractStateMachine(origDoc, themeDOM, assetIndex);
  const allFgComps = themeDOM.components.filter(
    c => !isFullScreenNode(c) && c.semanticRole !== 'hidden_utility' && c.semanticRole !== 'offscreen_ambient'
  );
  const fgById = new Map(allFgComps.map(component => [component.id, component]));
  const mainBgComps = themeDOM.components.filter(c => c.scene === 'main' && c.semanticRole === 'background');
  const origElById = new Map(themeDOM.elements.map(e => [e.nodeId, e]));

  // Precompute original overlaps per component id pair
  const origOverlappingPairs = new Set();
  for (let i = 0; i < allFgComps.length; i++) {
    for (let j = i + 1; j < allFgComps.length; j++) {
      const a = allFgComps[i], b = allFgComps[j];
      const inter = bboxInterArea(a.bbox, b.bbox);
      const minA = Math.max(1, Math.min(a.bbox.w * a.bbox.h, b.bbox.w * b.bbox.h));
      if (inter / minA > 0.15) origOverlappingPairs.add(`${a.id}|${b.id}`);
    }
  }

  const cells = [];
  const sourceSnapshots = new Map();
  const sourceViewport = { w: themeDOM.canvas.baseW, h: themeDOM.canvas.baseH };
  const exceedsViewport = (box, { w, h }) => box.x < -2.5 || box.y < -2.5 ||
    box.x + box.w > w + 2.5 || box.y + box.h > h + 2.5;
  function sourceBoxForState(state, component) {
    if (!sourceSnapshots.has(state.id)) {
      const opts = buildEvalOptionsForState(state.vars, themeDOM, { sceneHint: state.sceneHint, isOrig: true });
      sourceSnapshots.set(state.id, evaluateXmlAtViewport(origDoc, assetIndex, sourceViewport.w, sourceViewport.h, state.vars, opts));
    }
    const source = sourceSnapshots.get(state.id);
    const visible = component.memberIds.map(id => source.itemByNodeId.get(id))
      .filter(it => isVisibleItem(it, sourceViewport.w, sourceViewport.h));
    return visible.length ? bboxUnion(visible) : null;
  }

  for (const dev of devices) {
    const layoutMode = classifyLayoutMode(dev);
    const vpArea = Math.max(1, dev.w * dev.h);
    const hinges = dev.hinges || [];
    const panelW = hinges.length > 0 ? dev.w / (hinges.length + 1) : dev.w;

    let defaultCompBoxes = null;
    let defaultVisSet = new Set();

    for (const st of sm.states) {
      const evalOpts = buildEvalOptionsForState(st.vars, themeDOM, { sceneHint: st.sceneHint, isOrig: false });
      const ev = evaluateXmlAtViewport(adaptedDoc, assetIndex, dev.w, dev.h, st.vars, evalOpts);
      const byId = ev.itemByNodeId;

      // Background coverage
      let bgCoverage = 1.0;
      if (mainBgComps.length > 0) {
        let maxCov = 0;
        const vpBox = { x: 0, y: 0, w: dev.w, h: dev.h };
        for (const bg of mainBgComps) {
          const boxes = bg.memberIds.map(id => byId.get(id)).filter(Boolean);
          if (boxes.length > 0) {
            const u = bboxUnion(boxes);
            maxCov = Math.max(maxCov, bboxInterArea(u, vpBox) / vpArea);
          }
        }
        bgCoverage = Math.round(maxCov * 1000) / 1000;
      }

      const visBoxes = new Map();
      const visibleComponentIds = [];
      const scales = [];
      let oobCount = 0;
      let inheritedOobCount = 0;
      let hingeStraddleCount = 0;
      let buttonDriftCount = 0;
      let fgUnionAreaSum = 0;
      const geometryIssues = [];

      for (const c of allFgComps) {
        const ms = c.memberIds.map(id => byId.get(id)).filter(it => isVisibleItem(it, dev.w, dev.h));
        if (ms.length === 0) continue;
        const cBox = bboxUnion(ms);
        if (cBox.w <= 1 || cBox.h <= 1) continue;

        visBoxes.set(c.id, cBox);
        visibleComponentIds.push(c.id);

        if (c.bbox.w > 4) {
          const s = cBox.w / c.bbox.w;
          if (Number.isFinite(s) && s > 0.05 && s < 5) scales.push(s);
        }

        const clW = Math.max(0, Math.min(dev.w, cBox.x + cBox.w) - Math.max(0, cBox.x));
        const clH = Math.max(0, Math.min(dev.h, cBox.y + cBox.h) - Math.max(0, cBox.y));
        fgUnionAreaSum += clW * clH;

        // OOB
        const origInside = !exceedsViewport(c.bbox, sourceViewport);
        if (origInside && exceedsViewport(cBox, dev)) {
          oobCount++;
          const sourceBox = sourceBoxForState(st, c);
          const presentInSource = Boolean(sourceBox && exceedsViewport(sourceBox, sourceViewport));
          if (presentInSource) inheritedOobCount++;
          geometryIssues.push({
            type: 'out_of_bounds', componentId: c.id, stableKey: c.stableKey, memberIds: ms.map(item => item.nodeId),
            sourceBox, targetBox: cBox, presentInSource,
          });
        }

        // Hinge straddle
        if (hinges.length > 0 && cBox.w < panelW * 0.9) {
          for (const hg of hinges) {
            const halfGap = (hg.width || 32) / 2;
            if (cBox.x < hg.pos - 2 && cBox.x + cBox.w > hg.pos + 2 && (cBox.x < hg.pos + halfGap && cBox.x + cBox.w > hg.pos - halfGap)) {
              hingeStraddleCount++;
              geometryIssues.push({
                type: 'hinge_crossing', componentId: c.id, stableKey: c.stableKey, memberIds: ms.map(item => item.nodeId),
                sourceBox: sourceBoxForState(st, c), targetBox: cBox, hinge: hg,
              });
              break;
            }
          }
        }

        // Button drift
        for (const bid of c.boundButtonIds || []) {
          const bBox = byId.get(bid);
          const origBtn = origElById.get(bid);
          if (!bBox || !origBtn || !bBox.visible) continue;
          const origInter = bboxInterArea(origBtn.bbox, c.bbox) / Math.max(0.01, Math.min(origBtn.bbox.w * origBtn.bbox.h, c.bbox.w * c.bbox.h));
          if (origInter > 0.5) {
            const curInter = bboxInterArea(bBox, cBox) / Math.max(0.01, Math.min(bBox.w * bBox.h, cBox.w * cBox.h));
            if (curInter < Math.min(0.55, origInter * 0.85)) buttonDriftCount++;
          }
        }
      }

      // Intra-state overlap among currently visible compatible components
      let overlapPairs = 0;
      const visComps = visibleComponentIds.map(id => fgById.get(id));
      for (let i = 0; i < visComps.length; i++) {
        for (let j = i + 1; j < visComps.length; j++) {
          const a = visComps[i], b = visComps[j];
          if (!areVariantsCompatible(a.variantKey, b.variantKey)) continue;
          if (origOverlappingPairs.has(`${a.id}|${b.id}`)) continue;
          const ba = visBoxes.get(a.id), bb = visBoxes.get(b.id);
          const inter = bboxInterArea(ba, bb);
          const minA = Math.max(1, Math.min(ba.w * ba.h, bb.w * bb.h));
          if (inter / minA > 0.22) overlapPairs++;
        }
      }

      // Active visible buttons in this state
      const visibleButtons = ev.items.filter(it => it.tagLower === 'button' && isVisibleItem(it, dev.w, dev.h));

      // Compare against S0_default on this device
      if (st.id === 'S0_default') {
        defaultCompBoxes = visBoxes;
        defaultVisSet = new Set(visibleComponentIds);
      }

      let sharedWithDefault = 0;
      let exclusiveToState = 0;
      let shiftedCount = 0;
      let maxShiftPx = 0;
      for (const cid of visibleComponentIds) {
        if (defaultVisSet.has(cid)) {
          sharedWithDefault++;
          const a = defaultCompBoxes?.get(cid);
          const b = visBoxes.get(cid);
          if (a && b) {
            const d = Math.hypot((b.x + b.w / 2) - (a.x + a.w / 2), (b.y + b.h / 2) - (a.y + a.h / 2));
            if (d > 8) {
              shiftedCount++;
              maxShiftPx = Math.max(maxShiftPx, d);
            }
          }
        } else {
          exclusiveToState++;
        }
      }
      const hiddenFromDefault = [...defaultVisSet].filter(id => !visBoxes.has(id)).length;

      const avgScale = scales.length ? scales.reduce((s, x) => s + x, 0) / scales.length : 1;
      const minScale = scales.length ? Math.min(...scales) : 1;
      const maxScale = scales.length ? Math.max(...scales) : 1;

      cells.push({
        stateId: st.id,
        stateLabel: st.label,
        stateCategory: st.category,
        deviceId: dev.id,
        deviceLabel: dev.label,
        breakpoint: dev.breakpoint,
        viewport: { w: dev.w, h: dev.h },
        layoutMode,
        visibleComponentCount: visibleComponentIds.length,
        sharedWithDefault,
        exclusiveToState,
        hiddenFromDefault,
        shiftedCount,
        maxShiftPx: Math.round(maxShiftPx * 10) / 10,
        visibleButtonCount: visibleButtons.length,
        avgScale: Math.round(avgScale * 1000) / 1000,
        minScale: Math.round(minScale * 1000) / 1000,
        maxScale: Math.round(maxScale * 1000) / 1000,
        fgAreaCoverage: Math.round(Math.min(1, fgUnionAreaSum / vpArea) * 1000) / 1000,
        bgCoverage,
        oobCount,
        inheritedOobCount,
        overlapPairs,
        hingeStraddleCount,
        buttonDriftCount,
        nanCount: ev.nanCount,
        geometryIssues,
        passed: ev.nanCount === 0 && oobCount === 0 && hingeStraddleCount === 0 && bgCoverage >= 0.98,
      });
    }
  }

  // Build summaries & insights
  const perStateSummary = sm.states.map(st => {
    const rows = cells.filter(c => c.stateId === st.id);
    const avgVis = rows.reduce((s, r) => s + r.visibleComponentCount, 0) / Math.max(1, rows.length);
    const avgScaleAll = rows.reduce((s, r) => s + r.avgScale, 0) / Math.max(1, rows.length);
    const peakCoverage = Math.max(0, ...rows.map(r => r.fgAreaCoverage));
    const peakDev = rows.find(r => r.fgAreaCoverage === peakCoverage);
    return {
      stateId: st.id,
      label: st.label,
      category: st.category,
      vars: st.vars,
      avgVisibleComponents: Math.round(avgVis * 10) / 10,
      avgScaleAcrossDevices: Math.round(avgScaleAll * 1000) / 1000,
      peakFgCoverage: peakCoverage,
      peakCoverageDevice: peakDev?.deviceId || null,
      allDevicesPassed: rows.every(r => r.passed),
      totalOob: rows.reduce((s, r) => s + r.oobCount, 0),
      totalHingeStraddle: rows.reduce((s, r) => s + r.hingeStraddleCount, 0),
      totalOverlapPairs: rows.reduce((s, r) => s + r.overlapPairs, 0),
    };
  });

  const insights = [];
  const defaultRow = perStateSummary[0];
  if (defaultRow) {
    const highDeltaStates = perStateSummary.filter(s => s.stateId !== 'S0_default' && s.avgVisibleComponents > defaultRow.avgVisibleComponents + 1);
    if (highDeltaStates.length > 0) {
      const top = [...highDeltaStates].sort((a, b) => b.avgVisibleComponents - a.avgVisibleComponents)[0];
      insights.push(`状态「${top.label}」可见组件数升至 ${top.avgVisibleComponents}（默认态 ${defaultRow.avgVisibleComponents}），在紧凑外屏/横屏下需依靠容器缩放与防重叠约束维持可读性。`);
    }
  }
  const coverCells = cells.filter(c => c.breakpoint === 'square_fold' && c.deviceId.includes('cover'));
  if (coverCells.length > 0) {
    const peakCover = [...coverCells].sort((a, b) => b.fgAreaCoverage - a.fgAreaCoverage)[0];
    insights.push(`Pura X 外屏 1:1 (${peakCover.viewport.w}×${peakCover.viewport.h}) 下，状态「${peakCover.stateLabel}」前景面积占屏比最高达 ${(peakCover.fgAreaCoverage * 100).toFixed(1)}%，平均缩放 ${peakCover.avgScale}×。`);
  }
  const foldCells = cells.filter(c => c.deviceId === 'dual_fold_unfolded' || c.deviceId === 'tri_fold_triple');
  if (foldCells.length > 0) {
    const hingeWarns = foldCells.reduce((s, c) => s + c.hingeStraddleCount, 0);
    insights.push(`双/三折叠展开态共检验 ${foldCells.length} 个交互状态×设备组合，折痕跨越冲突=${hingeWarns}。`);
  }
  if (sm.transitions.length > 0) {
    insights.push(`单变量采样得到 ${sm.summary.discoveredStates} 个候选姿态。根据触发器引用推断了 ${sm.transitions.length} 条迁移线索。`);
  }

  return {
    themeName: themeDOM.themeName,
    stateCount: sm.states.length,
    deviceCount: devices.length,
    totalEvaluations: cells.length,
    allPassed: cells.every(c => c.passed),
    cells,
    perStateSummary,
    insights,
  };
}

/**
 * Format single or batch state-layout analysis results as structured Markdown.
 */
export function formatStateLayoutAnalysisMd(analyses) {
  const list = Array.isArray(analyses) ? analyses : [analyses];
  const lines = [
    '# 华为主题多交互状态 × 多分辨率布局响应深度分析报告',
    '',
    `- **分析时间:** ${new Date().toISOString()}`,
    `- **主题总数:** ${list.length}`,
    '',
  ];

  const totalStates = list.reduce((s, a) => s + a.stateCount, 0);
  const totalEvals = list.reduce((s, a) => s + a.totalEvaluations, 0);
  const passedEvals = list.reduce((s, a) => s + a.cells.filter(c => c.passed).length, 0);

  lines.push(
    '## 1. 全局概览',
    `- **候选姿态数** ${totalStates}（平均 ${(totalStates / Math.max(1, list.length)).toFixed(1)} 态/脚本）`,
    `- **状态×分辨率评估矩阵通过率:** ${passedEvals} / ${totalEvals} (${((passedEvals / Math.max(1, totalEvals)) * 100).toFixed(1)}%)`,
    '',
    '## 2. 主题级交互状态概览',
    '| 主题 | 状态数 | 状态变量分布 | 评估数 (状态×设备) | 通过数 | 折痕跨越 | 越界 |',
    '|---|---|---|---|---|---|---|',
  );

  for (const a of list) {
    const cats = new Map();
    for (const st of a.perStateSummary) {
      cats.set(st.category, (cats.get(st.category) || 0) + 1);
    }
    const catStr = [...cats.entries()].map(([k, v]) => `${k}:${v}`).join(', ');
    const passN = a.cells.filter(c => c.passed).length;
    const hErr = a.cells.reduce((s, c) => s + c.hingeStraddleCount, 0);
    const oobErr = a.cells.reduce((s, c) => s + c.oobCount, 0);
    lines.push(`| ${a.themeName} | ${a.stateCount} | ${catStr} | ${a.totalEvaluations} | ${passN} | ${hErr} | ${oobErr} |`);
  }

  lines.push('', '## 3. 各主题分状态布局响应详情');
  for (const a of list) {
    lines.push(
      '',
      `### ${a.themeName} (${a.stateCount} 个状态)`,
      '| 状态ID | 语义分类 | 变量配置 | 平均可见组件 | 平均缩放 | 峰值占屏比 (设备) | 越界 | 重叠 | 折痕 | 状态 |',
      '|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const s of a.perStateSummary) {
      const varsStr = Object.keys(s.vars).length ? JSON.stringify(s.vars) : '{}';
      lines.push(
        `| ${s.stateId} | ${s.category} | \`${varsStr}\` | ${s.avgVisibleComponents} | ${s.avgScaleAcrossDevices}× | ${(s.peakFgCoverage * 100).toFixed(1)}% (${s.peakCoverageDevice || '-'}) | ${s.totalOob} | ${s.totalOverlapPairs} | ${s.totalHingeStraddle} | ${s.allDevicesPassed ? 'PASS' : 'WARN'} |`
      );
    }
    if (a.insights?.length) {
      lines.push('', '**关键响应特征:**');
      for (const ins of a.insights) lines.push(`- ${ins}`);
    }
  }

  return lines.join('\n') + '\n';
}
