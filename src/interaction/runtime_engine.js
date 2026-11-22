/**
 * Live Huawei MAML Interactive Runtime Engine.
 *
 * Executes authentic pointer interactions (tap, double-tap, long-press, drag/swipe)
 * against a parsed Lockscreen XML + ThemeDOM + extracted StateMachine:
 * - Hit-tests active <Button> elements at evaluated viewport coordinates
 * - Evaluates <Trigger condition> & <VariableCommand condition/expression> via MAML AST
 * - Executes <Command target="..." value="play|stop"/> on <VariableAnimation>s
 * - Detects <ExternCommand command="unlock"/> & <IntentCommand>
 * - Tracks active interactive state ID & state transition trace log
 */

import { astCollectVars, buildRuntimeContext, evalAst, evalExpr, parseExprAst } from '../expr/evaluator.js';
import { evaluateXmlAtViewport } from '../validator/validator.js';
import { buildEvalOptionsForState } from './state_machine.js';

function isHitboxVisible(it, W, H) {
  return Boolean(
    it && it.visible && !it.clippedOut && it.w > 0.5 && it.h > 0.5 &&
    it.x + it.w > 0 && it.x < W && it.y + it.h > 0 && it.y < H
  );
}

function sameStateValue(a, b) {
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? Math.abs(na - nb) < 1e-4 : String(a) === String(b);
}

export function matchActiveState(varsObj, stateMachine) {
  const vars = varsObj || {};
  const initByVar = new Map();
  for (const sv of stateMachine?.stateVars || []) {
    initByVar.set(sv.name, sv.initialValue);
  }
  const changedTracked = Object.keys(vars).filter(name =>
    initByVar.has(name) && !sameStateValue(vars[name], initByVar.get(name))
  );

  let best = null;
  let bestScore = 0;

  for (const st of stateMachine?.states || []) {
    const entries = Object.entries(st.vars || {});
    if (entries.length === 0 || changedTracked.some(name => !Object.hasOwn(st.vars, name))) continue;
    let allMatch = true;
    let score = 0;
    for (const [k, v] of entries) {
      if (!(k in vars)) {
        allMatch = false;
        break;
      }
      if (!sameStateValue(vars[k], v)) {
        allMatch = false;
        break;
      }
      score += 1;
    }
    if (allMatch && score > bestScore) {
      best = st;
      bestScore = score;
    }
  }

  if (best) return best;

  // Check if all tracked state vars are at initial / zero values -> S0_default
  for (const [k, val] of Object.entries(vars)) {
    const init = initByVar.has(k) ? initByVar.get(k) : 0;
    if (!sameStateValue(val, init)) {
      return {
        id: 'custom',
        label: '自定义组合态',
        category: 'custom',
        sceneHint: inferUnmatchedSceneHint(vars, stateMachine),
        vars,
      };
    }
  }
  return stateMachine?.states?.[0] || {
    id: 'S0_default',
    label: '默认主锁屏态',
    category: 'default',
    sceneHint: 'main',
    vars: {},
  };
}

export function inferSceneHintFromVars(varsObj, stateMachine) {
  const vars = varsObj || {};
  return matchActiveState(vars, stateMachine).sceneHint || inferUnmatchedSceneHint(vars, stateMachine);
}

function inferUnmatchedSceneHint(vars, stateMachine) {
  for (const sv of stateMachine?.stateVars || []) {
    if (!(sv.name in vars)) continue;
    if (!sameStateValue(vars[sv.name], sv.initialValue ?? 0)) {
      if (sv.sceneHint && sv.sceneHint !== 'main') return sv.sceneHint;
    }
  }
  for (const [k, v] of Object.entries(vars)) {
    if (!Number(v)) continue;
    const kl = k.toLowerCase();
    if (/onesec|sec_page|drawer|kp_ani|cehua/.test(kl)) return 'drawer';
    if (/more_st|set_go|set_v|p_set|kzltc|setsho|panel/.test(kl)) return 'settings';
    if (/charge|battery_state/.test(kl)) return 'charging';
    if (/guide/.test(kl)) return 'guide';
  }
  return 'main';
}

function getActionsForEventType(eventType) {
  switch (eventType) {
    case 'double':
      return new Set(['double']);
    case 'long':
      return new Set(['long']);
    case 'swipe':
      return new Set(['up', 'move']);
    case 'press_down':
      return new Set(['down']);
    case 'press_up':
      return new Set(['up', 'click']);
    case 'tap':
    default:
      return new Set(['up', 'click', 'tap']);
  }
}

/**
 * Execute an interaction event cleanly against the lockscreen doc & live reactive vars.
 */
export function executeInteraction({
  doc,
  themeDOM,
  assetIndex = null,
  stateMachine,
  viewportW = 1080,
  viewportH = 2400,
  currentVars = {},
  event = {},
  isOrig = false,
  settleForPreview = true,
  evaluated = null,
}) {
  const type = (event.type || 'tap').toLowerCase();
  const prevVars = { ...(currentVars || {}) };
  let nextVars = { ...(currentVars || {}) };
  const executedCommands = [];
  const hitButtons = [];
  let unlocked = false;
  let launchedApp = null;

  if (type === 'reset') {
    nextVars = {};
    const active = matchActiveState(nextVars, stateMachine);
    return {
      vars: nextVars,
      changedVars: {},
      hitButtons,
      executedCommands: [{ type: 'Reset', summary: '重置所有状态变量到默认值' }],
      unlocked: false,
      launchedApp: null,
      activeStateId: active.id,
      activeStateLabel: active.label,
      sceneHint: active.sceneHint || 'main',
    };
  }

  if (type === 'state_select') {
    const st = stateMachine?.states?.find(s => s.id === event.stateId);
    nextVars = st ? { ...(st.vars || {}) } : {};
    const changedVars = {};
    for (const k of new Set([...Object.keys(prevVars), ...Object.keys(nextVars)])) {
      if (prevVars[k] !== nextVars[k]) {
        changedVars[k] = { from: prevVars[k] ?? null, to: nextVars[k] ?? 0 };
      }
    }
    const active = matchActiveState(nextVars, stateMachine);
    return {
      vars: nextVars,
      changedVars,
      hitButtons,
      executedCommands: [{ type: 'StateSelect', stateId: active.id, label: active.label }],
      unlocked: false,
      launchedApp: null,
      activeStateId: active.id,
      activeStateLabel: active.label,
      sceneHint: active.sceneHint || 'main',
    };
  }

  if (type === 'var_set' && event.varName) {
    const val = event.varValue;
    const prev = nextVars[event.varName] ?? null;
    nextVars[event.varName] = val;
    const active = matchActiveState(nextVars, stateMachine);
    return {
      vars: nextVars,
      changedVars: { [event.varName]: { from: prev, to: val } },
      hitButtons,
      executedCommands: [{ type: 'VarSet', name: event.varName, value: val }],
      unlocked: false,
      launchedApp: null,
      activeStateId: active.id,
      activeStateLabel: active.label,
      sceneHint: active.sceneHint || 'main',
    };
  }

  // Pointer event: tap, double, long, swipe, press_down, press_up
  const x = Number(event.x ?? viewportW / 2);
  const y = Number(event.y ?? viewportH / 2);
  const beginX = Number(event.beginX ?? x);
  const beginY = Number(event.beginY ?? y);

  const curSceneHint = inferSceneHintFromVars(nextVars, stateMachine);
  const evalOpts = settleForPreview ? buildEvalOptionsForState(nextVars, themeDOM, { sceneHint: curSceneHint, isOrig }) : {};
  const evalRes = evaluated ?? evaluateXmlAtViewport(doc, assetIndex, viewportW, viewportH, nextVars, evalOpts);

  const triggerByBtnId = new Map();
  for (const bt of stateMachine?.triggers || []) {
    triggerByBtnId.set(bt.buttonNodeId, bt);
  }

  // Gather visible button items topmost-first (reverse render order)
  const visibleBtns = [];
  for (let i = evalRes.items.length - 1; i >= 0; i--) {
    const it = evalRes.items[i];
    if (it.tagLower !== 'button') continue;
    if (!isHitboxVisible(it, viewportW, viewportH)) continue;
    const bt = triggerByBtnId.get(it.nodeId);
    if (!bt) continue;
    const inside =
      beginX >= it.x - 4 && beginX <= it.x + it.w + 4 &&
      beginY >= it.y - 4 && beginY <= it.y + it.h + 4;
    if (!inside) continue;
    visibleBtns.push({ item: it, bt });
  }

  const specificBtns = visibleBtns.filter(b => !b.bt.isFullscreen && b.item.w < viewportW * 0.92);
  const fullscreenBtns = visibleBtns.filter(b => b.bt.isFullscreen || b.item.w >= viewportW * 0.92);
  const orderedCandidates = type === 'swipe'
    ? [...specificBtns, ...fullscreenBtns]
    : [...specificBtns, ...fullscreenBtns];

  const acceptedActions = getActionsForEventType(type);

  // Live context backing the sequential command execution
  const touchVars = {
    touch_begin_x: beginX,
    touch_begin_y: beginY,
    touch_x: x,
    touch_y: y,
    touch_pressure: 1,
  };
  const baseCtx = buildRuntimeContext(doc.root, viewportW, viewportH, { ...nextVars, ...touchVars }, assetIndex);
  const liveOverrides = { ...nextVars, ...touchVars };
  const liveCtx = {
    getVar(name, kind) {
      if (kind !== '@' && name in liveOverrides) return liveOverrides[name];
      return baseCtx.getVar(name, kind);
    },
  };

  function evalTruth(expr) {
    if (!expr || !String(expr).trim()) return true;
    const val = evalAst(parseExprAst(expr), liveCtx);
    return Number(val) !== 0 && !Number.isNaN(Number(val));
  }

  let handledSpecific = false;

  for (const cand of orderedCandidates) {
    const isSpecific = !cand.bt.isFullscreen && cand.item.w < viewportW * 0.92;
    if (handledSpecific && !isSpecific && type !== 'swipe') break;

    let executedForThisBtn = false;

    for (const tr of cand.bt.triggers) {
      if (!acceptedActions.has(tr.action)) continue;
      if (!evalTruth(tr.condition)) continue;

      for (const cmd of tr.commands) {
        if (!evalTruth(cmd.condition)) continue;

        if (cmd.type.toLowerCase() === 'variablecommand' && cmd.name) {
          let newVal;
          const exprStr = String(cmd.expression ?? '').trim();
          // Keep literal numeric/quoted evaluations cleanly
          newVal = evalExpr(exprStr || '0', liveCtx);
          if (typeof newVal === 'number' && !Number.isFinite(newVal)) newVal = 0;

          const prev = liveCtx.getVar(cmd.name, '#');
          liveOverrides[cmd.name] = newVal;
          nextVars[cmd.name] = newVal;
          executedCommands.push({
            type: 'VariableCommand',
            buttonNodeId: cand.bt.buttonNodeId,
            action: tr.action,
            name: cmd.name,
            from: prev,
            to: newVal,
            expression: exprStr,
          });
          executedForThisBtn = true;
        } else if (cmd.type.toLowerCase() === 'command' && cmd.target) {
          const anim = stateMachine?.animations?.[cmd.target];
          const cmdVal = String(cmd.value || 'play').toLowerCase();
          if (anim) {
            const curVal = Number(liveCtx.getVar(anim.varName, '#')) || 0;
            let nextAnimVal = anim.endVal;
            if (cmdVal === 'stop' || cmdVal === 'pause' || cmdVal === 'reset') {
              nextAnimVal = anim.startVal;
            } else if (cmdVal === 'play' || cmdVal === 'start') {
              nextAnimVal = Math.abs(curVal - anim.endVal) < 1e-4 && anim.startVal === curVal ? anim.endVal : anim.endVal;
            }
            liveOverrides[anim.varName] = nextAnimVal;
            nextVars[anim.varName] = nextAnimVal;
            executedCommands.push({
              type: 'Command',
              buttonNodeId: cand.bt.buttonNodeId,
              target: cmd.target,
              value: cmdVal,
              varName: anim.varName,
              from: curVal,
              to: nextAnimVal,
            });
          } else {
            executedCommands.push({
              type: 'Command',
              buttonNodeId: cand.bt.buttonNodeId,
              target: cmd.target,
              value: cmdVal,
            });
          }
          executedForThisBtn = true;
        } else if (cmd.type.toLowerCase() === 'externcommand') {
          if (cmd.command === 'unlock') unlocked = true;
          executedCommands.push({
            type: 'ExternCommand',
            buttonNodeId: cand.bt.buttonNodeId,
            command: cmd.command || 'unknown',
          });
          executedForThisBtn = true;
        } else if (cmd.type.toLowerCase() === 'intentcommand') {
          launchedApp = cmd.package || 'intent';
          executedCommands.push({
            type: 'IntentCommand',
            buttonNodeId: cand.bt.buttonNodeId,
            package: launchedApp,
          });
          executedForThisBtn = true;
        }
      }
    }

    if (executedForThisBtn) {
      hitButtons.push({
        buttonNodeId: cand.bt.buttonNodeId,
        boundComponentId: cand.bt.boundComponentId,
        isFullscreen: cand.bt.isFullscreen,
        bbox: { x: Math.round(cand.item.x), y: Math.round(cand.item.y), w: Math.round(cand.item.w), h: Math.round(cand.item.h) },
      });
      if (isSpecific) handledSpecific = true;
    }
  }

  // Also allow coordinate-gated tap fallback if tap missed specific buttons or screen trigger didn't have 'up'
  // Compute changed vars diff
  const changedVars = {};
  for (const k of new Set([...Object.keys(prevVars), ...Object.keys(nextVars)])) {
    if (prevVars[k] !== nextVars[k]) {
      changedVars[k] = { from: prevVars[k] ?? baseCtx.getVar(k, '#'), to: nextVars[k] };
    }
  }

  const active = matchActiveState(nextVars, stateMachine);
  return {
    vars: nextVars,
    changedVars,
    hitButtons,
    executedCommands,
    unlocked,
    launchedApp,
    activeStateId: active.id,
    activeStateLabel: active.label,
    sceneHint: active.sceneHint || 'main',
    pointer: { type, beginX, beginY, x, y },
  };
}
