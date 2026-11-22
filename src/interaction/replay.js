import { executeInteraction } from './runtime_engine.js';
import { evaluateXmlAtViewport } from '../validator/validator.js';

function onScreen(item, { w, h }) {
  return item?.visible && !item.clippedOut && item.w > 1 && item.h > 1 &&
    item.x < w && item.y < h && item.x + item.w > 0 && item.y + item.h > 0;
}

function gesturesForTrigger(trigger) {
  const { action, condition, commands } = trigger;
  const expressions = [condition, ...commands.flatMap(command => [command.condition, command.expression])].join(' ');
  const horizontal = /#touch_(?:begin_)?x\b/.test(expressions);
  const vertical = /#touch_(?:begin_)?y\b/.test(expressions);
  if (action === 'move' || (action === 'up' && (horizontal || vertical))) {
    const gestures = [];
    if (horizontal || !vertical) gestures.push('left', 'right');
    if (vertical || !horizontal) gestures.push('up', 'down');
    return gestures;
  }
  if (action === 'double' || action === 'long') return [action];
  if (action === 'down') return ['press_down'];
  return ['tap'];
}

function eventAt(item, viewport, gesture) {
  if (!onScreen(item, viewport)) return null;
  const x = (Math.max(0, item.x) + Math.min(viewport.w, item.x + item.w)) / 2;
  const y = (Math.max(0, item.y) + Math.min(viewport.h, item.y + item.h)) / 2;
  const horizontal = gesture === 'left' || gesture === 'right';
  const vertical = gesture === 'up' || gesture === 'down';
  if (!horizontal && !vertical) return { type: gesture, x, y };

  const sign = ['left', 'up'].includes(gesture) ? -1 : 1;
  return {
    type: 'swipe', beginX: x, beginY: y,
    x: horizontal ? Math.max(1, Math.min(viewport.w - 1, x + sign * viewport.w * 0.6)) : x,
    y: vertical ? Math.max(1, Math.min(viewport.h - 1, y + sign * viewport.h * 0.6)) : y,
  };
}

function commandSignature(result, includeValues) {
  return JSON.stringify(result.executedCommands.map(command => [
    command.buttonNodeId, command.action, command.type, command.name, command.target,
    command.command, command.package, command.value,
    ...(includeValues ? [command.to] : []),
  ]));
}

function stateSignature(sourceVars, targetVars) {
  const entries = vars => Object.keys(vars).sort().map(name => [name, vars[name]]);
  return JSON.stringify([entries(sourceVars), entries(targetVars)]);
}

function compareSnapshots(source, target, sourceViewport, targetViewport) {
  const sourceItems = source.items.filter(item => item.tagLower !== 'button' && onScreen(item, sourceViewport));
  const targetItems = target.items.filter(item => item.tagLower !== 'button' && onScreen(item, targetViewport));
  const sourceVisible = new Set(sourceItems.map(item => item.nodeId));
  const targetVisible = new Set(targetItems.map(item => item.nodeId));
  const sourceOnly = [...sourceVisible].filter(id => !targetVisible.has(id));
  const targetOnly = [...targetVisible].filter(id => !sourceVisible.has(id));
  const changedAssets = sourceItems.filter(item =>
    targetVisible.has(item.nodeId) && item.resolvedAsset !== target.itemByNodeId.get(item.nodeId).resolvedAsset
  ).map(item => item.nodeId);
  return { sourceOnly, targetOnly, changedAssets };
}

export function replayInteractionSequences({
  themeDOM, origDoc, adaptedDoc, assetIndex, stateMachine, device,
  maxDepth = 3, maxStates = 10, maxAttempts = 40, maxAttemptsPerState = 12,
}) {
  const sourceViewport = { w: themeDOM.canvas.baseW, h: themeDOM.canvas.baseH };
  const control = [...stateMachine.triggers].sort((a, b) => Number(a.isFullscreen) - Number(b.isFullscreen))
    .map(button => ({
      nodeId: button.buttonNodeId,
      gestures: [...new Set(button.triggers.flatMap(gesturesForTrigger))],
    }));

  function snapshot(doc, viewport, vars) {
    return evaluateXmlAtViewport(doc, assetIndex, viewport.w, viewport.h, vars);
  }

  function run(doc, viewport, vars, event, evaluated) {
    return executeInteraction({
      doc, themeDOM, assetIndex, stateMachine, viewportW: viewport.w, viewportH: viewport.h,
      currentVars: vars, event, evaluated, settleForPreview: false,
    });
  }

  const explored = new Set([stateSignature({}, {})]);
  const queue = [{
    sourceVars: {}, targetVars: {}, path: [],
    source: snapshot(origDoc, sourceViewport, {}), target: snapshot(adaptedDoc, device, {}),
  }];
  const steps = [];
  let attempts = 0;
  let deepest = 0;
  let budgetReached = false;
  let statesWithPrunedControls = 0;

  while (queue.length && !budgetReached) {
    const current = queue.shift();
    let stateAttempts = 0;
    controls: for (const { nodeId, gestures } of control) {
      for (const gesture of gestures) {
        const sourceEvent = eventAt(current.source.itemByNodeId.get(nodeId), sourceViewport, gesture);
        if (!sourceEvent) continue;
        if (attempts >= maxAttempts) {
          budgetReached = true;
          break controls;
        }
        if (stateAttempts >= maxAttemptsPerState) {
          statesWithPrunedControls++;
          break controls;
        }
        attempts++;
        stateAttempts++;
        const source = run(origDoc, sourceViewport, current.sourceVars, sourceEvent, current.source);
        if (!source.hitButtons.some(button => button.buttonNodeId === nodeId)) continue;
        const targetEvent = eventAt(current.target.itemByNodeId.get(nodeId), device, gesture);
        const target = targetEvent ? run(adaptedDoc, device, current.targetVars, targetEvent, current.target) : null;
        const triggerMatched = Boolean(target?.hitButtons.some(button => button.buttonNodeId === nodeId));
        const commandsMatch = triggerMatched && commandSignature(source, false) === commandSignature(target, false);
        const valuesMatch = commandsMatch && commandSignature(source, true) === commandSignature(target, true);
        const path = [...current.path, { nodeId, gesture }];
        const sourceAfter = snapshot(origDoc, sourceViewport, source.vars);
        const targetAfter = target ? snapshot(adaptedDoc, device, target.vars) : current.target;
        const visibility = compareSnapshots(sourceAfter, targetAfter, sourceViewport, device);
        const visualsMatch = Object.values(visibility).every(ids => ids.length === 0);
        steps.push({
          path, sourceEvent, targetEvent,
          status: !targetEvent ? 'target_hidden' : !triggerMatched ? 'target_unhandled' :
            !commandsMatch ? 'commands_differ' : !valuesMatch ? 'values_differ' : 'matched',
          sourceChanges: source.changedVars, targetChanges: target?.changedVars ?? {},
          sourceCommands: source.executedCommands, targetCommands: target?.executedCommands ?? [],
          visualsMatch, visibility,
        });
        deepest = Math.max(deepest, path.length);
        if (!commandsMatch || source.unlocked || source.launchedApp) continue;
        const signature = stateSignature(source.vars, target.vars);
        if (explored.has(signature)) continue;
        if (path.length >= maxDepth || explored.size >= maxStates) continue;
        explored.add(signature);
        queue.push({ sourceVars: source.vars, targetVars: target.vars, source: sourceAfter, target: targetAfter, path });
      }
    }
  }

  return {
    deviceId: device.id,
    limits: { maxDepth, maxStates, maxAttempts, maxAttemptsPerState },
    attempts, budgetReached, statesWithPrunedControls, depthReached: deepest, statesDiscovered: explored.size,
    matched: steps.filter(step => step.status === 'matched').length,
    valueDifferences: steps.filter(step => step.status === 'values_differ').length,
    visualDifferences: steps.filter(step => !step.visualsMatch).length,
    steps,
  };
}
