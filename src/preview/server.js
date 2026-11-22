/**
 * Interactive Visual Preview Server for Huawei Multi-Form-Factor Adaptation.
 * Serves ThemeDOM IR, Original vs Adapted render trees, live .hwt assets,
 * emitted HTML/CSS/InteractionGraph, and pluggable algorithm switching.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwtArchive } from '../hwt/zip.js';
import { compileLockscreen, compileOtherLockscreens, loadPrimaryLockscreen, writeLockscreenDelivery } from '../hwt/lockscreen.js';
import { evaluateXmlAtViewport, TEST_VIEWPORTS, validateAdaptedTheme } from '../validator/validator.js';
import { HUAWEI_DEVICES, resolveDeviceProfile } from '../devices/huawei_devices.js';
import { solveLayout } from '../layout/responsive_engine.js';
import { buildContainerTree } from '../layout/container_tree.js';
import { listAlgorithms } from '../layout/algorithm_interface.js';
import { extractInteractionGraph } from '../interaction/interaction_adapter.js';
import { analyzeStateLayoutResponses, buildEvalOptionsForState, extractStateMachine } from '../interaction/state_machine.js';
import { executeInteraction, inferSceneHintFromVars, matchActiveState } from '../interaction/runtime_engine.js';
import { emitThemeCss, emitThemeHtml } from '../frontend/html_css_ir.js';
import { emitInteractiveFrontendBundle } from '../frontend/interactive_bundle.js';
import { extractUiComponents } from '../frontend/ui_components.js';
import { HW_COMPONENTS_CSS, HW_COMPONENTS_JS } from '../frontend/hw_components.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

export function createThemeLoader(hwtDir) {
  const baseCache = new Map();
  const mergeConfigByTheme = new Map();

  function getMergeConfig(themeFile) {
    return mergeConfigByTheme.get(themeFile) || { groups: [], overrides: {} };
  }

  function setMergeConfig(themeFile, cfg) {
    mergeConfigByTheme.set(themeFile, cfg);
    baseCache.get(themeFile)?.compiledCache.clear();
  }

  function listThemeFiles() {
    return fs.readdirSync(hwtDir)
      .filter(f => f.toLowerCase().endsWith('.hwt'))
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  function loadBase(themeFile) {
    if (!themeFile.toLowerCase().endsWith('.hwt') || /[/\\]/.test(themeFile) || path.basename(themeFile) !== themeFile) return null;
    const fullPath = path.join(hwtDir, themeFile);
    const stat = fs.statSync(fullPath, { throwIfNoEntry: false });
    if (!stat?.isFile()) return null;
    const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = baseCache.get(themeFile);
    baseCache.delete(themeFile);
    if (cached?.signature === signature) {
      baseCache.set(themeFile, cached);
      return cached;
    }
    const archive = HwtArchive.open(fullPath);
    const lockscreen = loadPrimaryLockscreen(archive, themeFile);
    const { origDoc, assetIndex, themeDOM } = lockscreen;
    const interactionGraph = extractInteractionGraph(origDoc, themeDOM);
    const stateMachine = extractStateMachine(origDoc, themeDOM, assetIndex);
    const uiComponents = extractUiComponents({ doc: origDoc, themeDOM, assetIndex, stateMachine });
    const base = {
      ...lockscreen, themeFile, interactionGraph, stateMachine, uiComponents,
      signature, compiledCache: new Map(),
    };
    baseCache.set(themeFile, base);
    if (baseCache.size > 2) baseCache.delete(baseCache.keys().next().value);
    return base;
  }

  function loadTheme(themeFile, algo = 'hwflex', mode = 'universal', device = HUAWEI_DEVICES.phone_2400) {
    const base = loadBase(themeFile);
    if (!base) return null;
    const { compiledCache } = base;
    const key = JSON.stringify([algo, mode, mode === 'target' ? device.id : null]);
    const cached = compiledCache.get(key);
    if (cached) {
      compiledCache.delete(key);
      compiledCache.set(key, cached);
      return cached;
    }

    const mergeConfig = getMergeConfig(themeFile);
    const containerTree = buildContainerTree(base.themeDOM, mergeConfig);
    const compileOptions = {
      mode, targetW: device.w, targetH: device.h, deviceProfile: device,
      algorithm: algo, mergeConfig,
    };
    const primary = compileLockscreen(base, { ...compileOptions, containerTree });
    const { compiled, adaptedDoc } = primary;
    const viewports = mode === 'target' ? [device] : TEST_VIEWPORTS;
    let validation;
    let css;

    const bundle = {
      primary, compileOptions,
      themeFile, archive: base.archive, origDoc: base.origDoc, themeDOM: base.themeDOM,
      assetIndex: base.assetIndex, interactionGraph: base.interactionGraph,
      stateMachine: base.stateMachine, uiComponents: base.uiComponents,
      algorithm: algo,
      mergeConfig,
      containerTree,
      adaptedXml: compiled.xml,
      adaptedDoc,
      interactionStats: compiled.interactionStats,
      get validation() {
        return validation ??= validateAdaptedTheme({
          origDoc: base.origDoc, adaptedXml: compiled.xml, themeDOM: base.themeDOM,
          assetIndex: base.assetIndex, viewports,
        });
      },
      get html() {
        return emitThemeHtml(base.themeDOM, base.interactionGraph, base.stateMachine, base.uiComponents, containerTree);
      },
      get css() {
        return css ??= emitThemeCss(base.themeDOM, viewports.map(dev => ({
          device: dev,
          transforms: compiled.targetTransforms ?? solveLayout(base.themeDOM, dev.w, dev.h, {
            algorithm: algo, deviceProfile: dev, mergeConfig, containerTree,
          }),
        })), null, base.uiComponents, containerTree);
      },
    };
    compiledCache.set(key, bundle);
    if (compiledCache.size > 6) compiledCache.delete(compiledCache.keys().next().value);
    return bundle;
  }

  return { listThemeFiles, loadBase, loadTheme, getMergeConfig, setMergeConfig };
}

function getSceneOverrides(scene) {
  switch (scene) {
    case 'drawer':
      return { oneSec: 1, sec_page: 1, kp_ani: 1 };
    case 'settings':
      return { more_st: 1, set_go: 1, set_v: 1, p_set: 1, kzltc: 1 };
    case 'charging':
      return { charge_anim: 1, battery_state: 1 };
    case 'guide':
      return { guide: 1 };
    default:
      return { guide: 0, oneSec: 0, more_st: 0, charge_anim: 0, battery_state: 0 };
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', c => {
      len += c.length;
      if (len > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function startPreviewServer({ hwtDir, port = 3800, outputRoot = path.join(PROJECT_ROOT, 'output') }) {
  const loader = createThemeLoader(hwtDir);
  const indexHtmlPath = path.join(__dirname, 'index.html');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = decodeURIComponent(url.pathname);
      const algo = url.searchParams.get('algo') || 'hwflex';

      if (pathname === '/' || pathname === '/index.html') {
        const html = fs.readFileSync(indexHtmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
        res.end(html);
        return;
      }

      if (pathname === '/hw-components.js') {
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.js'] });
        res.end(HW_COMPONENTS_JS);
        return;
      }

      if (pathname === '/hw-components.css') {
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.css'] });
        res.end(HW_COMPONENTS_CSS);
        return;
      }

      if (pathname === '/api/devices') {
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
        res.end(JSON.stringify({
          devices: Object.values(HUAWEI_DEVICES),
          algorithms: listAlgorithms(),
        }));
        return;
      }

      if (pathname === '/api/themes') {
        const files = loader.listThemeFiles();
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
        res.end(JSON.stringify(files.map(file => ({ file }))));
        return;
      }

      const mTheme = /^\/api\/theme\/([^/]+)\/(ir|xml|html|css|interactions|validation|render|states|interact|export|components|containers(?:\/config)?)$/.exec(pathname);
      if (mTheme) {
        const themeFile = mTheme[1];
        const endpoint = mTheme[2];
        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        const reqAlgo = body.algo || algo;
        const requestedW = Math.max(240, Math.min(4000, Number(body.w ?? url.searchParams.get('w')) || 1080));
        const requestedH = Math.max(240, Math.min(4000, Number(body.h ?? url.searchParams.get('h')) || 2400));
        const targetDev = resolveDeviceProfile(requestedW, requestedH, body.deviceId ?? url.searchParams.get('deviceId'));
        const { w, h } = targetDev;
        const requestedMode = body.compileMode ?? url.searchParams.get('compileMode') ?? (endpoint === 'export' ? body.mode ?? 'target' : 'universal');
        const compileMode = requestedMode === 'target' ? 'target' : 'universal';
        const b = loader.loadTheme(themeFile, reqAlgo, compileMode, targetDev);
        if (!b) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Theme not found');
          return;
        }

        if (endpoint === 'ir') {
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
          res.end(JSON.stringify(b.themeDOM, null, 2));
          return;
        }
        if (endpoint === 'xml') {
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.xml'] });
          res.end(b.adaptedXml);
          return;
        }
        if (endpoint === 'html') {
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
          res.end(b.html);
          return;
        }
        if (endpoint === 'css') {
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.css'] });
          res.end(b.css);
          return;
        }
        if (endpoint === 'interactions') {
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
          res.end(JSON.stringify({ summary: b.interactionGraph.summary, stats: b.interactionStats, ...b.interactionGraph }, null, 2));
          return;
        }
        if (endpoint === 'validation') {
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
          res.end(JSON.stringify(b.validation, null, 2));
          return;
        }
        if (endpoint === 'components') {
          const evalMain = evaluateXmlAtViewport(b.adaptedDoc, b.assetIndex, w, h, {});
          const drawerBoxes = {};
          for (const dw of b.uiComponents.drawers) {
            const openVars = { [dw.stateVar]: dw.openValue };
            const evalOpts = buildEvalOptionsForState(openVars, b.themeDOM, { sceneHint: dw.sceneHint, isOrig: false });
            const ev = evaluateXmlAtViewport(b.adaptedDoc, b.assetIndex, w, h, openVars, evalOpts);
            const boxes = dw.memberNodeIds
              .map(id => ev.itemByNodeId.get(id))
              .filter(it => it && it.visible && it.w > 0 && it.h > 0);
            if (boxes.length) {
              const minX = Math.min(...boxes.map(x => x.x));
              const minY = Math.min(...boxes.map(x => x.y));
              const maxX = Math.max(...boxes.map(x => x.x + x.w));
              const maxY = Math.max(...boxes.map(x => x.y + x.h));
              drawerBoxes[dw.id] = {
                x: Math.round(minX * 10) / 10,
                y: Math.round(minY * 10) / 10,
                w: Math.round((maxX - minX) * 10) / 10,
                h: Math.round((maxY - minY) * 10) / 10,
              };
            }
          }
          const switcherBoxes = {};
          for (const sw of b.uiComponents.imageSwitchers) {
            const items = sw.nodeIds.map(id => evalMain.itemByNodeId.get(id)).filter(Boolean);
            const valid = items.filter(it => it.w > 0 && it.h > 0);
            if (valid.length) {
              const minX = Math.min(...valid.map(x => x.x));
              const minY = Math.min(...valid.map(x => x.y));
              const maxX = Math.max(...valid.map(x => x.x + x.w));
              const maxY = Math.max(...valid.map(x => x.y + x.h));
              switcherBoxes[sw.id] = {
                x: Math.round(minX * 10) / 10,
                y: Math.round(minY * 10) / 10,
                w: Math.round((maxX - minX) * 10) / 10,
                h: Math.round((maxY - minY) * 10) / 10,
              };
            }
          }
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
          res.end(JSON.stringify({
            theme: themeFile,
            algo: reqAlgo,
            w,
            h,
            uiComponents: b.uiComponents,
            drawerBoxes,
            switcherBoxes,
          }));
          return;
        }
        if (endpoint === 'containers') {
          const { mergeConfig, containerTree } = b;
          const macroBoxes = {};

          const evalMain = evaluateXmlAtViewport(b.adaptedDoc, b.assetIndex, w, h, {});
          const compById = new Map(b.themeDOM.components.map(c => [c.id, c]));
          for (const mc of containerTree.containers) {
            const ids = mc.childIds.flatMap(id => compById.get(id)?.memberIds || []);
            const boxes = ids.map(id => evalMain.itemByNodeId.get(id))
              .filter(it => it?.visible && it.w > 0 && it.h > 0);
            if (boxes.length) {
              const minX = Math.min(...boxes.map(x => x.x));
              const minY = Math.min(...boxes.map(x => x.y));
              const maxX = Math.max(...boxes.map(x => x.x + x.w));
              const maxY = Math.max(...boxes.map(x => x.y + x.h));
              macroBoxes[mc.id] = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
            }
          }

          res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
          res.end(JSON.stringify({
            theme: themeFile,
            algo: reqAlgo,
            w,
            h,
            mergeConfig,
            containerTree,
            macroBoxes,
          }));
          return;
        }
        if (endpoint === 'containers/config' && req.method === 'POST') {
          const cur = loader.getMergeConfig(themeFile);
          const next = {
            groups: [...(cur.groups || [])],
            overrides: { ...(cur.overrides || {}) },
          };
          const act = body.action || 'update';
          if (act === 'reset') {
            next.groups = [];
            next.overrides = {};
          } else if (act === 'merge' && Array.isArray(body.childIds) && body.childIds.length >= 1) {
            const gid = body.id || `mc_custom_${Date.now().toString(36).slice(-4)}`;
            const pickedSet = new Set(body.childIds);
            // Remove picked childIds from earlier custom groups cleanly
            next.groups = next.groups
              .map(g => ({ ...g, childIds: (g.childIds || []).filter(id => !pickedSet.has(id)) }))
              .filter(g => g.childIds.length > 0);
            next.groups.push({
              id: gid,
              scene: body.scene || 'main',
              label: body.label || `合并容器 (${body.childIds.length})`,
              childIds: body.childIds,
              intraLayout: body.intraLayout || (body.childIds.length === 1 ? 'center_contain' : 'flex_col'),
              align: body.align || 'center',
              justify: body.justify || 'space_evenly',
              gap: body.gap ?? null,
              cols: body.cols ?? null,
            });
          } else if (act === 'unmerge' && body.groupId) {
            next.groups = next.groups.filter(g => g.id !== body.groupId);
            delete next.overrides[body.groupId];
          } else if (act === 'update' && body.containerId) {
            next.overrides[body.containerId] = {
              ...(next.overrides[body.containerId] || {}),
              ...(body.patch || {}),
            };
          }
          loader.setMergeConfig(themeFile, next);
          const containerTree = buildContainerTree(b.themeDOM, next);
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
          res.end(JSON.stringify({ ok: true, mergeConfig: next, containerTree }));
          return;
        }
        if (endpoint === 'states') {
          const layoutAnalysis = analyzeStateLayoutResponses({
            themeDOM: b.themeDOM,
            origDoc: b.origDoc,
            adaptedDoc: b.adaptedDoc,
            assetIndex: b.assetIndex,
            stateMachine: b.stateMachine,
            devices: [targetDev],
          });
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
          res.end(JSON.stringify({
            theme: themeFile,
            algo: reqAlgo,
            device: targetDev,
            stateMachine: b.stateMachine,
            layoutAnalysis,
          }));
          return;
        }
        if (endpoint === 'interact' && req.method === 'POST') {
          const mode = body.mode || 'adapted';
          const doc = mode === 'orig' ? b.origDoc : b.adaptedDoc;
          const result = executeInteraction({
            doc,
            themeDOM: b.themeDOM,
            assetIndex: b.assetIndex,
            stateMachine: b.stateMachine,
            viewportW: w,
            viewportH: h,
            currentVars: body.vars || {},
            event: body.event || {},
            isOrig: mode === 'orig',
          });
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
          res.end(JSON.stringify(result));
          return;
        }
        if (endpoint === 'export' && req.method === 'POST') {
          const repack = body.repack !== false;
          const { mergeConfig, containerTree } = b;

          const baseName = themeFile.replace(/\.hwt$/i, '');
          const suffix = compileMode === 'universal' ? '_universal' : '';
          const outDir = path.join(outputRoot, baseName, `${targetDev.id}_${targetDev.w}x${targetDev.h}${suffix}`);
          const variants = [b.primary, ...compileOtherLockscreens(b.primary, themeFile, {
            ...b.compileOptions, mergeConfig: null,
          })];
          const bundleRes = emitInteractiveFrontendBundle({
            themeFile,
            archive: b.archive,
            assetIndex: b.assetIndex,
            themeDOM: b.themeDOM,
            origDoc: b.origDoc,
            adaptedDoc: b.adaptedDoc,
            interactionGraph: b.interactionGraph,
            stateMachine: b.stateMachine,
            uiComponents: b.uiComponents,
            containerTree,
            mergeConfig,
            targetDevice: targetDev,
            algorithm: reqAlgo,
            targetTransforms: b.primary.compiled.targetTransforms,
            outDir,
          });

          fs.writeFileSync(path.join(outDir, 'manifest.xml'), b.adaptedXml, 'utf8');
          fs.writeFileSync(path.join(outDir, 'theme_dom.json'), JSON.stringify(b.themeDOM, null, 2), 'utf8');
          fs.writeFileSync(path.join(outDir, 'theme.html'), emitThemeHtml(b.themeDOM, b.interactionGraph, b.stateMachine, b.uiComponents, containerTree), 'utf8');

          const exportedFiles = ['manifest.xml', 'theme_dom.json', 'theme.html', ...bundleRes.files];
          const packageName = repack ? `${baseName}_${targetDev.id}_${targetDev.w}x${targetDev.h}${suffix}.hwt` : null;
          const { files, audit } = writeLockscreenDelivery(variants, outDir, {
            packageName, viewports: compileMode === 'target' ? [targetDev] : TEST_VIEWPORTS,
          });
          exportedFiles.push(...files);

          res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
          res.end(JSON.stringify({
            ok: true,
            theme: themeFile,
            algo: reqAlgo,
            mode: compileMode,
            device: targetDev,
            outDir,
            files: exportedFiles,
            assetCount: bundleRes.assetCount,
            summary: {
              stateCount: bundleRes.analysis.stateCount,
              allPassed: bundleRes.analysis.allPassed && audit.passed,
              manifestCount: audit.scripts.length,
            },
          }));
          return;
        }
        if (endpoint === 'render') {
          const mode = url.searchParams.get('mode') || 'adapted';
          const scene = url.searchParams.get('scene') || 'main';
          const stateId = url.searchParams.get('stateId') || null;
          let extraVars = {};
          const varsParam = url.searchParams.get('vars');
          if (varsParam) {
            try { extraVars = JSON.parse(varsParam); } catch {}
          }
          const doc = mode === 'orig' ? b.origDoc : b.adaptedDoc;
          const sceneAutoVars = {};
          if (scene !== 'main') {
            for (const st of b.interactionGraph.stateTransitions || []) {
              if (st.opensScene === scene && st.variable) {
                sceneAutoVars[st.variable] = 1;
              }
            }
          }
          const statePreset = stateId ? b.stateMachine?.states?.find(s => s.id === stateId) : null;
          const overrides = stateId
            ? { ...(statePreset?.vars || {}), ...extraVars }
            : (scene !== 'main' ? { ...getSceneOverrides(scene), ...sceneAutoVars, ...extraVars } : { ...extraVars });

          const resolvedHint = statePreset?.sceneHint || (scene !== 'main' ? scene : inferSceneHintFromVars(overrides, b.stateMachine));
          const evalOptions = buildEvalOptionsForState(overrides, b.themeDOM, {
            sceneHint: resolvedHint,
            isOrig: mode === 'orig',
          });
          const evalRes = evaluateXmlAtViewport(doc, b.assetIndex, w, h, overrides, evalOptions);
          const matchedState = matchActiveState(overrides, b.stateMachine);
          const drawerStates = {};
          for (const dw of b.uiComponents.drawers) {
            const curV = dw.stateVar in overrides ? overrides[dw.stateVar] : dw.closedValue;
            drawerStates[dw.id] = String(curV) === String(dw.openValue) ||
              (resolvedHint === 'drawer' && dw.sceneHint === 'drawer' && String(curV) !== String(dw.closedValue));
          }
          const switcherStates = {};
          for (const sw of b.uiComponents.imageSwitchers) {
            switcherStates[sw.id] = sw.stateVar in overrides ? overrides[sw.stateVar] : sw.initialValue;
          }
          res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
          res.end(JSON.stringify({
            theme: themeFile,
            mode,
            compileMode,
            device: targetDev,
            algo: reqAlgo,
            w,
            h,
            scene: resolvedHint,
            activeStateId: matchedState.id,
            activeStateLabel: matchedState.label,
            resolvedVars: overrides,
            nanCount: evalRes.nanCount,
            items: evalRes.items,
            components: b.themeDOM.components,
            hitTargets: b.interactionGraph.hitTargets,
            nodeBindings: b.uiComponents.nodeBindings,
            drawerStates,
            switcherStates,
          }));
          return;
        }
      }

      const mAsset = /^\/api\/theme\/([^/]+)\/asset\/(.+)$/.exec(pathname);
      if (mAsset) {
        const themeFile = mAsset[1];
        const relPath = mAsset[2];
        const b = loader.loadBase(themeFile);
        if (!b) {
          res.writeHead(404);
          res.end('Theme not found');
          return;
        }
        const resolved = b.assetIndex.resolveRel(relPath);
        if (!resolved) {
          res.writeHead(404);
          res.end('Asset not found');
          return;
        }
        const buf = b.archive.readBuffer(b.assetIndex.basePrefix + resolved);
        const ext = path.extname(resolved).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(buf);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err.stack || err.message);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`HwFlex Previewer running at http://127.0.0.1:${server.address().port}/`);
  });

  return server;
}
