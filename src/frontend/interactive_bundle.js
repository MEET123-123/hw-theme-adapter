/**
 * Standalone Interactive Frontend Adaptation Bundle Emitter.
 *
 * Exports a self-contained runnable frontend package for any target device/resolution:
 * - interactive.html (works via file:// or any static server; embeds <hw-drawer> & <hw-image-switcher>)
 * - theme.css (responsive CSS + state tokens + Web Component animations)
 * - state_graph.json (extracted interactive FSM: stateVars, triggers, animations, states, transitions)
 * - ui_components.json (extracted <hw-drawer> & <hw-image-switcher> frontend component definitions)
 * - state_layout_analysis.json & state_layout_analysis.md (per-state layout response metrics)
 * - assets/* (copied PNG/JPG/WEBP assets referenced across all interactive states & variant slots)
 */

import fs from 'node:fs';
import path from 'node:path';
import { solveLayout } from '../layout/responsive_engine.js';
import { evaluateXmlAtViewport } from '../validator/validator.js';
import {
  analyzeStateLayoutResponses,
  buildEvalOptionsForState,
  extractStateMachine,
  formatStateLayoutAnalysisMd,
} from '../interaction/state_machine.js';
import { emitThemeCss } from './html_css_ir.js';
import { extractUiComponents } from './ui_components.js';
import { HW_COMPONENTS_CSS, HW_COMPONENTS_JS } from './hw_components.js';
import { buildContainerTree } from '../layout/container_tree.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function copyAssetIfValid(relPath, assetIndex, assetsOutRoot, copiedAssets) {
  const cleanRel = assetIndex.resolveRel(relPath);
  if (!cleanRel || !/\.(png|jpg|jpeg|webp|gif|mp4)$/i.test(cleanRel)) return null;
  const dst = path.resolve(assetsOutRoot, cleanRel);
  const relative = path.relative(assetsOutRoot, dst);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  if (!copiedAssets.has(cleanRel)) {
    const buf = assetIndex.archive.readBuffer(assetIndex.basePrefix + cleanRel);
    if (!buf) return null;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    copiedAssets.add(cleanRel);
  }
  return './assets/' + relative.split(path.sep).map(encodeURIComponent).join('/');
}

export function emitInteractiveFrontendBundle({
  themeFile,
  assetIndex,
  themeDOM,
  origDoc,
  adaptedDoc,
  interactionGraph = null,
  stateMachine = null,
  uiComponents = null,
  containerTree = null,
  mergeConfig = null,
  targetDevice,
  algorithm = 'hwflex',
  cssOverrides = null,
  targetTransforms = null,
  outDir,
}) {
  fs.mkdirSync(outDir, { recursive: true });
  const assetsOutRoot = path.join(outDir, 'assets');
  fs.mkdirSync(assetsOutRoot, { recursive: true });

  const sm = stateMachine || extractStateMachine(origDoc, themeDOM, assetIndex);
  const uic = uiComponents || extractUiComponents({ doc: origDoc, themeDOM, assetIndex, stateMachine: sm });
  const cTree = containerTree || buildContainerTree(themeDOM, mergeConfig);
  const analysis = analyzeStateLayoutResponses({
    themeDOM,
    origDoc,
    adaptedDoc,
    assetIndex,
    stateMachine: sm,
    devices: [targetDevice],
  });

  const devSolutions = [{
    device: targetDevice,
    transforms: targetTransforms ?? solveLayout(themeDOM, targetDevice.w, targetDevice.h, {
      algorithm,
      deviceProfile: targetDevice,
      mergeConfig,
      cssOverrides,
      containerTree: cTree,
    }),
  }];
  const cssText = emitThemeCss(themeDOM, devSolutions, analysis, uic, cTree);

  // Pre-evaluate every discovered state at targetDevice (w, h)
  const triggerByBtnId = new Map();
  for (const bt of sm.triggers || []) {
    triggerByBtnId.set(bt.buttonNodeId, bt);
  }

  const copiedAssets = new Set();
  const stateSnapshots = {};

  // Copy all variant slot assets for embedded <hw-image-switcher> containers
  const localizedSwitchers = (uic.imageSwitchers || []).map(sw => ({
    ...sw,
    slots: (sw.slots || []).map(sl => ({
      ...sl,
      assetUrl: copyAssetIfValid(sl.asset, assetIndex, assetsOutRoot, copiedAssets),
    })),
  }));

  for (const st of sm.states) {
    const evalOpts = buildEvalOptionsForState(st.vars, themeDOM, {
      sceneHint: st.sceneHint,
      isOrig: false,
    });
    const ev = evaluateXmlAtViewport(
      adaptedDoc,
      assetIndex,
      targetDevice.w,
      targetDevice.h,
      st.vars,
      evalOpts,
    );

    const layers = [];
    const hitboxes = [];

    for (const it of ev.items) {
      if (!it.visible || it.clippedOut || it.w <= 0 || it.h <= 0) continue;

      if (it.tagLower === 'button') {
        const bt = triggerByBtnId.get(it.nodeId);
        if (!bt) continue;
        hitboxes.push({
          nodeId: it.nodeId,
          boundComponentId: bt.boundComponentId,
          isFullscreen: bt.isFullscreen,
          x: Math.round(it.x * 100) / 100,
          y: Math.round(it.y * 100) / 100,
          w: Math.round(it.w * 100) / 100,
          h: Math.round(it.h * 100) / 100,
          triggers: bt.triggers,
        });
        continue;
      }

      const assetUrl = copyAssetIfValid(it.resolvedAsset, assetIndex, assetsOutRoot, copiedAssets);
      const binding = uic.nodeBindings?.byNodeId?.[it.nodeId] || null;

      layers.push({
        nodeId: it.nodeId,
        tag: it.tagLower,
        x: Math.round(it.x * 100) / 100,
        y: Math.round(it.y * 100) / 100,
        w: Math.round(it.w * 100) / 100,
        h: Math.round(it.h * 100) / 100,
        alpha: Math.round(it.alpha ?? 255),
        asset: assetUrl,
        scaleType: it.scaleType || null,
        text: it.text || null,
        fontSize: it.fontSize || null,
        color: it.color || null,
        fillColor: it.fillColor || null,
        drawerId: binding?.drawerId || null,
        imageSwitcherId: binding?.imageSwitcherId || null,
        slotValue: binding?.slotValue ?? null,
      });
    }

    stateSnapshots[st.id] = {
      id: st.id,
      label: st.label,
      category: st.category,
      vars: st.vars,
      layers,
      hitboxes,
    };
  }

  const interactiveHtml = buildStandaloneInteractiveHtml({
    themeName: themeDOM.themeName,
    targetDevice,
    stateMachine: sm,
    uiComponents: { ...uic, imageSwitchers: localizedSwitchers },
    analysis,
    stateSnapshots,
  });

  const mdReport = formatStateLayoutAnalysisMd(analysis);

  fs.writeFileSync(path.join(outDir, 'state_graph.json'), JSON.stringify(sm, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'ui_components.json'), JSON.stringify(uic, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'container_tree.json'), JSON.stringify(cTree, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'state_layout_analysis.json'), JSON.stringify(analysis, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'state_layout_analysis.md'), mdReport, 'utf8');
  fs.writeFileSync(path.join(outDir, 'theme.css'), cssText, 'utf8');
  fs.writeFileSync(path.join(outDir, 'interactive.html'), interactiveHtml, 'utf8');

  return {
    outDir,
    files: [
      'interactive.html',
      'theme.css',
      'state_graph.json',
      'ui_components.json',
      'container_tree.json',
      'state_layout_analysis.json',
      'state_layout_analysis.md',
    ],
    analysis,
    uiComponents: uic,
    assetCount: copiedAssets.size,
  };
}

function buildStandaloneInteractiveHtml({
  themeName,
  targetDevice,
  stateMachine,
  uiComponents,
  analysis,
  stateSnapshots,
}) {
  const payload = JSON.stringify({
    themeName,
    device: targetDevice,
    states: stateMachine.states,
    transitions: stateMachine.transitions,
    uiComponents,
    analysis,
    snapshots: stateSnapshots,
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-state="S0_default">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(themeName)} · ${escapeHtml(targetDevice.label)} 交互式组件化适配包</title>
  <link rel="stylesheet" href="./theme.css" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; grid-template-columns: 1fr 440px; min-height: 100vh; }
    .stage-col { padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .state-pills { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; max-width: 720px; }
    .pill { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 999px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
    .pill.active { background: #38bdf8; color: #0f172a; border-color: #38bdf8; font-weight: 600; }
    .canvas { position: relative; background: #020617; border: 2px solid #475569; border-radius: 12px; overflow: hidden; user-select: none; touch-action: none; }
    .layer { position: absolute; pointer-events: none; }
    .layer img { width: 100%; height: 100%; display: block; }
    .hinge { position: absolute; top: 0; bottom: 0; border-left: 2px dashed rgba(244, 114, 182, 0.8); background: rgba(244, 114, 182, 0.14); pointer-events: none; z-index: 900; }
    .hitbox { position: absolute; border: 1px dashed rgba(34, 197, 94, 0.55); background: rgba(34, 197, 94, 0.06); z-index: 950; pointer-events: none; }
    .panel { background: #1e293b; border-left: 1px solid #334155; padding: 16px; overflow: auto; font-size: 12px; }
    h1 { font-size: 15px; margin: 0 0 6px; color: #38bdf8; }
    .meta { color: #94a3b8; font-size: 12px; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11px; }
    th, td { border-bottom: 1px solid #334155; padding: 5px 4px; text-align: left; }
    .trace { background: #0f172a; border-radius: 8px; padding: 8px 10px; font-family: monospace; font-size: 11px; min-height: 44px; margin-top: 8px; }
    .comp-card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 8px; margin-top: 8px; }
    .slot-btn { background: #1e293b; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 2px 6px; font-size: 11px; cursor: pointer; margin: 4px 4px 0 0; }
    .slot-btn.active { background: #38bdf8; color: #0f172a; border-color: #38bdf8; font-weight: 600; }
    ${HW_COMPONENTS_CSS}
    @media (max-width: 960px) { body { grid-template-columns: 1fr; } .panel { border-left: none; border-top: 1px solid #334155; } }
  </style>
  <script>${HW_COMPONENTS_JS}</script>
</head>
<body>
  <div class="stage-col">
    <h1>${escapeHtml(themeName)} · ${escapeHtml(targetDevice.label)}</h1>
    <div class="meta">虚拟画布 ${targetDevice.w}×${targetDevice.h} · 物理 ${targetDevice.physW || targetDevice.w}×${targetDevice.physH || targetDevice.h} · 滑窗组件 ${uiComponents.drawers.length} · 图片切换容器 ${uiComponents.imageSwitchers.length}</div>
    <div class="state-pills" id="pills"></div>
    <div class="canvas" id="stage"></div>
    <div style="font-size:11px;color:#94a3b8;">提示: 直接点击/滑动交互画布，或通过右侧 &lt;hw-drawer&gt; / &lt;hw-image-switcher&gt; 组件调试滑窗与嵌入式图源切换</div>
  </div>
  <aside class="panel">
    <h1>交互执行追踪 (Interaction Trace)</h1>
    <div class="trace" id="trace">当前状态: S0_default (默认主锁屏态)</div>
    <h1 style="margin-top:16px;">前端组件快捷调试 (&lt;hw-drawer&gt; / &lt;hw-image-switcher&gt;)</h1>
    <div id="compDebug"></div>
    <h1 style="margin-top:16px;">多交互状态布局响应分析</h1>
    <table>
      <thead><tr><th>状态</th><th>可见组件</th><th>变化(±)</th><th>均缩放</th><th>占屏比</th><th>结果</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div id="insights" style="margin-top:12px;color:#cbd5e1;line-height:1.5;"></div>
  </aside>
  <script>
    const DATA = ${payload};
    let curStateId = DATA.states[0]?.id || 'S0_default';
    let manualVars = {};
    let downPt = null;

    const pillsEl = document.getElementById('pills');
    const stageEl = document.getElementById('stage');
    const traceEl = document.getElementById('trace');

    function getScale() {
      return Math.min(540 / DATA.device.w, 640 / DATA.device.h);
    }

    function createLayerEl(l, sc) {
      const d = document.createElement('div');
      d.className = 'layer';
      d.style.left = (l.x * sc) + 'px';
      d.style.top = (l.y * sc) + 'px';
      d.style.width = (l.w * sc) + 'px';
      d.style.height = (l.h * sc) + 'px';
      if (l.alpha < 255) d.style.opacity = String(Math.max(0, l.alpha / 255));
      if (l.asset) {
        const isVideo = /\.mp4$/i.test(l.asset);
        const media = document.createElement(isVideo ? 'video' : 'img');
        media.src = l.asset;
        media.style.cssText = 'width:100%;height:100%;object-fit:' + (l.scaleType === 'center_crop' ? 'cover' : 'fill');
        if (isVideo) Object.assign(media, { muted: true, loop: true, autoplay: true, playsInline: true });
        d.appendChild(media);
      } else if (l.text) {
        d.style.color = l.color || '#fff';
        d.style.fontSize = Math.max(9, (l.fontSize || 30) * sc) + 'px';
        d.style.fontWeight = '600';
        d.style.whiteSpace = 'nowrap';
        d.textContent = l.text;
      } else if (l.fillColor) {
        d.style.background = l.fillColor;
      }
      return d;
    }

    function renderPills() {
      pillsEl.innerHTML = DATA.states.map(s =>
        '<button class="pill ' + (s.id === curStateId ? 'active' : '') + '" data-id="' + s.id + '">' + s.label + '</button>'
      ).join('');
      pillsEl.querySelectorAll('.pill').forEach(btn => {
        btn.onclick = () => switchState(btn.dataset.id, '状态栏切换');
      });
    }

    function switchState(id, reason) {
      curStateId = id;
      const stObj = DATA.states.find(s => s.id === id);
      manualVars = { ...(stObj?.vars || {}) };
      document.documentElement.setAttribute('data-state', id);
      traceEl.textContent = '[' + reason + '] -> ' + id;
      renderPills();
      renderStage();
      renderCompDebug();
    }

    function renderStage() {
      const snap = DATA.snapshots[curStateId] || DATA.snapshots[DATA.states[0].id];
      const sc = getScale();
      stageEl.style.width = Math.round(DATA.device.w * sc) + 'px';
      stageEl.style.height = Math.round(DATA.device.h * sc) + 'px';
      stageEl.innerHTML = '';

      const handledSwitcherIds = new Set();
      const drawerMap = new Map();

      // Pre-create <hw-drawer> shells
      for (const dw of DATA.uiComponents.drawers || []) {
        const el = document.createElement('hw-drawer');
        el.setAttribute('drawer-id', dw.id);
        el.setAttribute('state-var', dw.stateVar);
        el.setAttribute('direction', dw.direction);
        el.setAttribute('label', dw.label);
        el.setAttribute('show-handle', 'true');
        const isOpen = String(manualVars[dw.stateVar] ?? 0) === String(dw.openValue) ||
          (curStateId !== 'S0_default' && snap.layers.some(l => l.drawerId === dw.id));
        if (isOpen) el.setAttribute('open', '');
        el.addEventListener('hw-drawer-dismiss', () => {
          manualVars[dw.stateVar] = dw.closedValue;
          if (curStateId !== 'S0_default') switchState('S0_default', '滑窗收起');
          else renderStage();
        });
        drawerMap.set(dw.id, el);
      }

      const mountLayer = (parent, l) => {
        if (l.imageSwitcherId) {
          if (handledSwitcherIds.has(l.imageSwitcherId)) return;
          const sw = (DATA.uiComponents.imageSwitchers || []).find(s => s.id === l.imageSwitcherId);
          if (sw) {
            handledSwitcherIds.add(sw.id);
            const swEl = document.createElement('hw-image-switcher');
            swEl.setAttribute('switcher-id', sw.id);
            swEl.setAttribute('state-var', sw.stateVar);
            swEl.setAttribute('transition', sw.transition || 'fade');
            swEl.setAttribute('show-dots', 'true');
            const activeVal = manualVars[sw.stateVar] ?? l.slotValue ?? sw.initialValue;
            swEl.setAttribute('active-value', String(activeVal));
            swEl.style.left = (l.x * sc) + 'px';
            swEl.style.top = (l.y * sc) + 'px';
            swEl.style.width = (l.w * sc) + 'px';
            swEl.style.height = (l.h * sc) + 'px';
            for (const sl of sw.slots) {
              const fig = document.createElement('figure');
              fig.className = 'hw-slot';
              fig.setAttribute('data-val', String(sl.value));
              const img = document.createElement('img');
              img.src = sl.assetUrl || l.asset || '';
              fig.appendChild(img);
              swEl.appendChild(fig);
            }
            swEl.addEventListener('hw-image-switch', (ev) => {
              manualVars[ev.detail.stateVar] = ev.detail.value;
              swEl.setAttribute('active-value', String(ev.detail.value));
              traceEl.textContent = '[容器切图] ' + ev.detail.stateVar + '=' + ev.detail.value;
              renderCompDebug();
            });
            parent.appendChild(swEl);
            return;
          }
        }
        parent.appendChild(createLayerEl(l, sc));
      };

      for (const l of snap.layers) {
        if (l.drawerId && drawerMap.has(l.drawerId)) {
          const dwEl = drawerMap.get(l.drawerId);
          mountLayer(dwEl.surface, l);
        } else {
          mountLayer(stageEl, l);
        }
      }

      for (const dwEl of drawerMap.values()) {
        stageEl.appendChild(dwEl);
      }

      for (const hg of DATA.device.hinges || []) {
        const hl = document.createElement('div');
        hl.className = 'hinge';
        const hw = Math.max(4, (hg.width || 32) * sc);
        hl.style.left = (hg.pos * sc - hw / 2) + 'px';
        hl.style.width = hw + 'px';
        stageEl.appendChild(hl);
      }

      for (const hb of snap.hitboxes) {
        if (hb.isFullscreen) continue;
        const h = document.createElement('div');
        h.className = 'hitbox';
        h.style.left = (hb.x * sc) + 'px';
        h.style.top = (hb.y * sc) + 'px';
        h.style.width = Math.max(8, hb.w * sc) + 'px';
        h.style.height = Math.max(8, hb.h * sc) + 'px';
        stageEl.appendChild(h);
      }
    }

    function renderCompDebug() {
      const box = document.getElementById('compDebug');
      const dws = DATA.uiComponents.drawers || [];
      const sws = DATA.uiComponents.imageSwitchers || [];
      let html = '';
      for (const d of dws) {
        html += '<div class="comp-card"><strong>&lt;hw-drawer&gt; ' + d.id + '</strong> (' + d.direction + ', var=<code>' + d.stateVar + '</code>)<div>' +
          '<button class="slot-btn" data-open-dw="' + d.id + '">切换滑窗状态</button></div></div>';
      }
      for (const sw of sws.slice(0, 8)) {
        const curV = manualVars[sw.stateVar] ?? sw.initialValue;
        html += '<div class="comp-card"><strong>&lt;hw-image-switcher&gt; ' + sw.id + '</strong> (' + sw.kind + ', var=<code>' + sw.stateVar + '</code>)<div>' +
          sw.slots.map(sl => '<button class="slot-btn ' + (String(curV) === String(sl.value) ? 'active' : '') + '" data-sw-var="' + sw.stateVar + '" data-sw-val="' + sl.value + '">' + sl.value + '</button>').join('') +
          '</div></div>';
      }
      box.innerHTML = html || '<div style="color:#94a3b8">未检测到显式滑窗或嵌入式图片容器</div>';
      box.querySelectorAll('[data-open-dw]').forEach(btn => {
        btn.onclick = () => {
          const d = dws.find(x => x.id === btn.dataset.openDw);
          const tr = DATA.states.find(s => s.primaryVar === d.stateVar);
          if (tr) switchState(curStateId === tr.id ? 'S0_default' : tr.id, '组件滑窗切换');
        };
      });
      box.querySelectorAll('[data-sw-var]').forEach(btn => {
        btn.onclick = () => {
          const v = Number.isFinite(Number(btn.dataset.swVal)) ? Number(btn.dataset.swVal) : btn.dataset.swVal;
          manualVars[btn.dataset.swVar] = v;
          const matchSt = DATA.states.find(s => String(s.primaryVar) === String(btn.dataset.swVar) && String(s.primaryValue) === String(v));
          if (matchSt) curStateId = matchSt.id;
          traceEl.textContent = '[容器切图] ' + btn.dataset.swVar + '=' + v;
          document.querySelectorAll('hw-image-switcher[state-var="' + btn.dataset.swVar + '"]').forEach(el => {
            el.setAttribute('active-value', String(v));
          });
          renderCompDebug();
        };
      });
    }

    function renderAnalysis() {
      const tbody = document.getElementById('rows');
      tbody.innerHTML = DATA.analysis.cells.map(c =>
        '<tr><td>' + c.stateId + '</td><td>' + c.visibleComponentCount + '</td><td>+' + c.exclusiveToState + '/-' + c.hiddenFromDefault + '</td><td>' + c.avgScale + '×</td><td>' + (c.fgAreaCoverage * 100).toFixed(0) + '%</td><td>' + (c.passed ? 'PASS' : 'WARN') + '</td></tr>'
      ).join('');
      document.getElementById('insights').innerHTML = DATA.analysis.insights.map(i => '<div>• ' + i + '</div>').join('');
    }

    stageEl.addEventListener('pointerdown', e => {
      const r = stageEl.getBoundingClientRect();
      const sc = getScale();
      downPt = { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
    });

    stageEl.addEventListener('pointerup', e => {
      if (!downPt) return;
      const r = stageEl.getBoundingClientRect();
      const sc = getScale();
      const upPt = { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
      const dist = Math.hypot(upPt.x - downPt.x, upPt.y - downPt.y);
      const snap = DATA.snapshots[curStateId];
      const pt = downPt;
      downPt = null;

      if (dist > 28) {
        const swipeTr = DATA.transitions.find(t => t.gesture === 'swipe_y' || t.gesture === 'swipe_x');
        if (swipeTr && curStateId === 'S0_default') {
          switchState(swipeTr.toStateId, '滑动手势');
        } else if (curStateId !== 'S0_default') {
          switchState('S0_default', '滑动返回默认态');
        } else {
          traceEl.textContent = '[滑动 ' + Math.round(dist) + 'px] 触发解锁/交互检测';
        }
        return;
      }

      const hits = snap.hitboxes.filter(hb => !hb.isFullscreen && pt.x >= hb.x && pt.x <= hb.x + hb.w && pt.y >= hb.y && pt.y <= hb.y + hb.h);
      const topHit = hits[hits.length - 1];
      if (topHit) {
        const tr = DATA.transitions.find(t => t.buttonNodeId === topHit.nodeId && t.toStateId !== curStateId);
        if (tr) {
          switchState(tr.toStateId, '点击热区 ' + topHit.nodeId);
        } else if (curStateId !== 'S0_default') {
          switchState('S0_default', '点击热区 ' + topHit.nodeId + ' 返回');
        } else {
          traceEl.textContent = '[点击 ' + topHit.nodeId + '] 触发组件交互命令';
        }
      }
    });

    renderPills();
    renderStage();
    renderCompDebug();
    renderAnalysis();
  </script>
</body>
</html>`;
}
