import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwtArchive } from './hwt/zip.js';
import { compileLockscreen, compileOtherLockscreens, listLockscreenManifests, loadLockscreen, loadPrimaryLockscreen, writeLockscreenDelivery } from './hwt/lockscreen.js';
import { TEST_VIEWPORTS } from './validator/validator.js';
import { HUAWEI_DEVICES, resolveDeviceProfile } from './devices/huawei_devices.js';
import { startPreviewServer } from './preview/server.js';
import { solveLayout } from './layout/responsive_engine.js';
import { buildContainerTree } from './layout/container_tree.js';
import { loadExternalAlgorithm } from './layout/algorithm_interface.js';
import { extractInteractionGraph } from './interaction/interaction_adapter.js';
import { analyzeStateLayoutResponses, extractStateMachine, formatStateLayoutAnalysisMd } from './interaction/state_machine.js';
import { replayInteractionSequences } from './interaction/replay.js';
import { emitThemeCss, emitThemeHtml, parseCssOverrides } from './frontend/html_css_ir.js';
import { emitInteractiveFrontendBundle } from './frontend/interactive_bundle.js';
import { extractUiComponents } from './frontend/ui_components.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_HWT_DIR = path.resolve(PROJECT_ROOT, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');

function parseArgs(argv) {
  const cmd = argv[2] || 'audit';
  const opts = {
    cmd,
    all: false,
    repack: false,
    theme: null,
    port: 3800,
    hwtDir: DEFAULT_HWT_DIR,
    outputDir: OUTPUT_DIR,
    reportsDir: REPORTS_DIR,
    algo: 'hwflex',
    css: null,
    merge: null,
    device: null,
    w: null,
    h: null,
    mode: null,
    bundle: false,
  };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--repack') opts.repack = true;
    else if (a === '--bundle') opts.bundle = true;
    else if (a === '--theme' && argv[i + 1]) opts.theme = argv[++i];
    else if (a === '--port' && argv[i + 1]) opts.port = Number(argv[++i]) || 3800;
    else if (a === '--hwt-dir' && argv[i + 1]) opts.hwtDir = path.resolve(argv[++i]);
    else if (a === '--out-dir' && argv[i + 1]) opts.outputDir = path.resolve(argv[++i]);
    else if (a === '--reports-dir' && argv[i + 1]) opts.reportsDir = path.resolve(argv[++i]);
    else if (a === '--algo' && argv[i + 1]) opts.algo = argv[++i];
    else if (a === '--css' && argv[i + 1]) opts.css = path.resolve(argv[++i]);
    else if (a === '--merge' && argv[i + 1]) opts.merge = path.resolve(argv[++i]);
    else if (a === '--device' && argv[i + 1]) opts.device = argv[++i];
    else if (a === '--w' && argv[i + 1]) opts.w = Number(argv[++i]);
    else if (a === '--h' && argv[i + 1]) opts.h = Number(argv[++i]);
    else if (a === '--mode' && argv[i + 1]) opts.mode = argv[++i];
    else throw new Error(`Unknown option or missing argument: ${a}`);
  }
  if (opts.mode && !['target', 'universal'].includes(opts.mode)) throw new Error(`Unknown compile mode: ${opts.mode}`);
  if (opts.device && !Object.hasOwn(HUAWEI_DEVICES, opts.device)) throw new Error(`Unknown device: ${opts.device}`);
  if ((opts.w !== null || opts.h !== null) && ![opts.w, opts.h].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('--w and --h must both be positive numbers');
  }
  return opts;
}

function listHwtFiles(hwtDir, filterTheme) {
  const all = fs.readdirSync(hwtDir)
    .filter(f => f.toLowerCase().endsWith('.hwt'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const matches = filterTheme
    ? all.filter(f => f === filterTheme || f.replace(/\.hwt$/i, '') === filterTheme || f.includes(filterTheme))
    : all;
  if (!matches.length) throw new Error(`No matching HWT themes in ${hwtDir}${filterTheme ? ` for "${filterTheme}"` : ''}`);
  return matches;
}

function writeThemeOutputs(themeOut, { ir, compiled, interactionGraph, stateMachine = null, uiComponents = null, containerTree = null, mergeConfig = null, algorithm, cssOverrides }) {
  fs.mkdirSync(themeOut, { recursive: true });
  const deviceSolutions = TEST_VIEWPORTS.map(dev => ({
    device: dev,
    transforms: solveLayout(ir, dev.w, dev.h, { algorithm, deviceProfile: dev, cssOverrides, mergeConfig, containerTree }),
  }));
  const html = emitThemeHtml(ir, interactionGraph, stateMachine, uiComponents, containerTree);
  const css = emitThemeCss(ir, deviceSolutions, null, uiComponents, containerTree);

  fs.writeFileSync(path.join(themeOut, 'theme_dom.json'), JSON.stringify(ir, null, 2), 'utf8');
  fs.writeFileSync(path.join(themeOut, 'interactions.json'), JSON.stringify(interactionGraph, null, 2), 'utf8');
  if (stateMachine) {
    fs.writeFileSync(path.join(themeOut, 'state_graph.json'), JSON.stringify(stateMachine, null, 2), 'utf8');
  }
  if (uiComponents) {
    fs.writeFileSync(path.join(themeOut, 'ui_components.json'), JSON.stringify(uiComponents, null, 2), 'utf8');
  }
  if (containerTree) {
    fs.writeFileSync(path.join(themeOut, 'container_tree.json'), JSON.stringify(containerTree, null, 2), 'utf8');
  }
  fs.writeFileSync(path.join(themeOut, 'theme.html'), html, 'utf8');
  fs.writeFileSync(path.join(themeOut, 'theme.css'), css, 'utf8');
  fs.writeFileSync(path.join(themeOut, 'manifest.universal.xml'), compiled.xml, 'utf8');
}

function cmdAudit(opts) {
  const files = listHwtFiles(opts.hwtDir, opts.theme);
  console.log(`Auditing ${files.length} .hwt themes in ${opts.hwtDir}...\n`);
  const rows = [];
  for (const f of files) {
    try {
      const archive = HwtArchive.open(path.join(opts.hwtDir, f));
      const { origDoc: doc, assetIndex: assets, themeDOM: ir } = loadPrimaryLockscreen(archive, f);
      const inter = extractInteractionGraph(doc, ir);
      const sm = extractStateMachine(doc, ir, assets);
      const uic = extractUiComponents({ doc, themeDOM: ir, assetIndex: assets, stateMachine: sm });
      rows.push({
        theme: f.replace('.hwt', ''),
        canvas: `${ir.canvas.baseW}x${ir.canvas.baseH}`,
        scripts: listLockscreenManifests(archive).length,
        comps: ir.stats.totalComponents,
        states: sm.summary.discoveredStates,
        drawers: uic.summary.drawerCount,
        imgSwitchers: uic.summary.imageSwitcherCount,
        srcid: uic.summary.srcidSwitcherCount,
        visStack: uic.summary.visStackSwitcherCount,
      });
    } catch (err) {
      rows.push({ theme: f.replace('.hwt', ''), error: err.message });
      process.exitCode = 1;
    }
  }
  console.table(rows);
}

async function cmdAdapt(opts) {
  const files = listHwtFiles(opts.hwtDir, opts.theme);
  const algorithm = await loadExternalAlgorithm(opts.algo);
  const cssOverrides = opts.css ? parseCssOverrides(fs.readFileSync(opts.css, 'utf8')) : null;
  const mergeConfig = opts.merge ? JSON.parse(fs.readFileSync(opts.merge, 'utf8')) : null;
  const hasTarget = Boolean(opts.device || opts.w);
  const targetDev = opts.device ? HUAWEI_DEVICES[opts.device] : hasTarget ? resolveDeviceProfile(opts.w, opts.h) : null;
  const mode = opts.mode || (hasTarget ? 'target' : 'universal');
  if (mode === 'target' && !targetDev) throw new Error('Target mode requires --device or --w and --h');
  const targetLabel = targetDev ? `${targetDev.id}_${targetDev.w}x${targetDev.h}` : null;
  const suffix = targetLabel && mode === 'universal' ? '_universal' : '';

  console.log(`Adapting ${files.length} themes -> ${opts.outputDir} (mode=${mode}, algo=${algorithm?.name || opts.algo}, repack=${opts.repack})`);
  for (const f of files) {
    try {
      const base = f.replace(/\.hwt$/i, '');
      const archive = HwtArchive.open(path.join(opts.hwtDir, f));
      const primary = loadPrimaryLockscreen(archive, f);
      const { origDoc: doc, assetIndex: assets, themeDOM: ir } = primary;
      const containerTree = buildContainerTree(ir, mergeConfig);
      const compileOptions = {
        mode, algorithm, cssOverrides,
        ...(targetDev ? { targetW: targetDev.w, targetH: targetDev.h, deviceProfile: targetDev } : {}),
      };
      const compiledPrimary = compileLockscreen(primary, { ...compileOptions, mergeConfig, containerTree });
      const { adaptedDoc, compiled } = compiledPrimary;
      const variants = [compiledPrimary, ...compileOtherLockscreens(primary, f, {
        ...compileOptions, cssOverrides: null,
      })];
      const interactionGraph = extractInteractionGraph(doc, ir);
      const stateMachine = extractStateMachine(doc, ir, assets);
      const uiComponents = extractUiComponents({ doc, themeDOM: ir, assetIndex: assets, stateMachine });
      const themeOut = targetLabel ? path.join(opts.outputDir, base, targetLabel + suffix) : path.join(opts.outputDir, base);

      if (targetDev || opts.bundle) {
        emitInteractiveFrontendBundle({
          themeFile: f, assetIndex: assets, themeDOM: ir, origDoc: doc, adaptedDoc,
          interactionGraph, stateMachine, uiComponents, containerTree, mergeConfig,
          targetDevice: targetDev || HUAWEI_DEVICES.phone_2400, algorithm, cssOverrides,
          targetTransforms: compiled.targetTransforms,
          outDir: targetDev ? themeOut : path.join(themeOut, 'frontend_bundle'),
        });
      }
      if (targetDev) {
        fs.writeFileSync(path.join(themeOut, 'manifest.xml'), compiled.xml, 'utf8');
        fs.writeFileSync(path.join(themeOut, 'theme_dom.json'), JSON.stringify(ir, null, 2), 'utf8');
        fs.writeFileSync(path.join(themeOut, 'theme.html'), emitThemeHtml(ir, interactionGraph, stateMachine, uiComponents, containerTree), 'utf8');
      } else {
        writeThemeOutputs(themeOut, { ir, compiled, interactionGraph, stateMachine, uiComponents, containerTree, mergeConfig, algorithm, cssOverrides });
      }

      const packageName = opts.repack
        ? (targetLabel ? `${base}_${targetLabel}${suffix}.hwt` : `${base}_adapted.hwt`)
        : null;
      const { audit } = writeLockscreenDelivery(variants, themeOut, {
        packageName, viewports: mode === 'target' ? [targetDev] : TEST_VIEWPORTS,
      });
      console.log(`  [${audit.passed ? 'PASS' : 'CHECK'}] ${f} | manifests=${variants.length} | states=${stateMachine.states.length} | audit=${path.join(themeOut, 'delivery_audit.json')}`);
    } catch (err) {
      console.error(`  [ERROR] ${f}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

async function cmdAnalyze(opts) {
  const files = listHwtFiles(opts.hwtDir, opts.theme);
  const algorithm = await loadExternalAlgorithm(opts.algo);
  const cssOverrides = opts.css ? parseCssOverrides(fs.readFileSync(opts.css, 'utf8')) : null;
  const mergeConfig = opts.merge ? JSON.parse(fs.readFileSync(opts.merge, 'utf8')) : null;
  const target = opts.device ? HUAWEI_DEVICES[opts.device] : opts.w ? resolveDeviceProfile(opts.w, opts.h) : null;
  const mode = opts.mode || 'universal';
  if (mode === 'target' && !target) throw new Error('Target mode requires --device or --w and --h');
  const devices = target ? [target] : TEST_VIEWPORTS;
  const replayDevices = target ? [target] : [HUAWEI_DEVICES.phone_2400, HUAWEI_DEVICES.dual_fold_unfolded, HUAWEI_DEVICES.phone_land];
  fs.mkdirSync(opts.reportsDir, { recursive: true });

  const analyses = [];
  const stateMachines = [];
  const rows = [];
  const replay = [];
  const errors = [];
  for (const f of files) {
    try {
      const archive = HwtArchive.open(path.join(opts.hwtDir, f));
      const manifests = listLockscreenManifests(archive);
      if (!manifests.length) throw new Error('No lockscreen manifest');
      for (const [index, manifestPath] of manifests.entries()) {
        const input = loadLockscreen(archive, f, manifestPath);
        const { origDoc, adaptedDoc, assetIndex, themeDOM } = compileLockscreen(input, {
          mode, algorithm, cssOverrides: index === 0 ? cssOverrides : null, mergeConfig: index === 0 ? mergeConfig : null,
          ...(target ? { targetW: target.w, targetH: target.h, deviceProfile: target } : {}),
        });
        const sm = extractStateMachine(origDoc, themeDOM, assetIndex);
        const analysis = analyzeStateLayoutResponses({ themeDOM, origDoc, adaptedDoc, assetIndex, stateMachine: sm, devices });
        const sequences = replayDevices.map(device => replayInteractionSequences({
          themeDOM, origDoc, adaptedDoc, assetIndex, stateMachine: sm, device,
        }));
        analyses.push({ ...analysis, manifestPath });
        stateMachines.push({ themeName: themeDOM.themeName, manifestPath, ...sm });
        replay.push({ themeName: themeDOM.themeName, manifestPath, sequences });
        rows.push({
          theme: themeDOM.themeName,
          states: sm.states.length,
          sampled: analysis.totalEvaluations,
          sampleAlerts: analysis.cells.filter(cell => !cell.passed).length,
          replaySteps: sequences.reduce((sum, result) => sum + result.steps.length, 0),
          replayDifferences: sequences.reduce((sum, result) => sum + result.steps.length - result.matched, 0),
        });
      }
    } catch (err) {
      errors.push({ themeName: f, message: err.message });
      console.error(`[ERROR] ${f}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  console.table(rows);
  const report = {
    generatedAt: new Date().toISOString(),
    algorithm: algorithm?.name || opts.algo,
    mode,
    totalThemes: files.length,
    totalScripts: analyses.length,
    totalStates: analyses.reduce((sum, analysis) => sum + analysis.stateCount, 0),
    totalEvaluations: analyses.reduce((sum, analysis) => sum + analysis.totalEvaluations, 0),
    passedEvaluations: analyses.reduce((sum, analysis) => sum + analysis.cells.filter(cell => cell.passed).length, 0),
    analyses, stateMachines, replay, errors,
  };

  const replayMd = [
    '## 事件序列回放',
    '',
    '从源脚本当前可见的热区生成点击、长按和滑动，在目标脚本的对应热区回放。此结果受探索深度、事件预算和模拟器能力限制。',
    '',
    '| 主题脚本 | 设备 | 尝试 | 执行步数 | 完全匹配 | 同命令值不同 | 可见内容差异 | 最大深度 |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const item of replay) {
    for (const result of item.sequences) {
      replayMd.push(`| ${item.themeName} | ${result.deviceId} | ${result.attempts} | ${result.steps.length} | ${result.matched} | ${result.valueDifferences} | ${result.visualDifferences} | ${result.depthReached} |`);
    }
  }
  fs.writeFileSync(path.join(opts.reportsDir, 'state_layout_analysis.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(opts.reportsDir, 'state_layout_analysis.md'), formatStateLayoutAnalysisMd(analyses) + '\n' + replayMd.join('\n') + '\n', 'utf8');
  console.log(`\nSaved state layout and event replay report -> ${opts.reportsDir}`);
}

async function cmdValidate(opts) {
  const files = listHwtFiles(opts.hwtDir, opts.theme);
  const algorithm = await loadExternalAlgorithm(opts.algo);
  const cssOverrides = opts.css ? parseCssOverrides(fs.readFileSync(opts.css, 'utf8')) : null;
  const mergeConfig = opts.merge ? JSON.parse(fs.readFileSync(opts.merge, 'utf8')) : null;
  const target = opts.device ? HUAWEI_DEVICES[opts.device] : opts.w ? resolveDeviceProfile(opts.w, opts.h) : null;
  const mode = opts.mode || (target ? 'target' : 'universal');
  if (mode === 'target' && !target) throw new Error('Target mode requires --device or --w and --h');
  const viewports = target ? [target] : TEST_VIEWPORTS;
  fs.mkdirSync(opts.reportsDir, { recursive: true });

  const themes = [];
  for (const themeName of files) {
    try {
      const archive = HwtArchive.open(path.join(opts.hwtDir, themeName));
      const primary = loadPrimaryLockscreen(archive, themeName);
      const { themeDOM: ir, origDoc, assetIndex } = primary;
      const containerTree = buildContainerTree(ir, mergeConfig);
      const compileOptions = {
        mode, algorithm,
        ...(target ? { targetW: target.w, targetH: target.h, deviceProfile: target } : {}),
      };
      const compiledPrimary = compileLockscreen(primary, { ...compileOptions, cssOverrides, mergeConfig, containerTree });
      const variants = [compiledPrimary, ...compileOtherLockscreens(primary, themeName, compileOptions)];
      const base = themeName.replace(/\.hwt$/i, '');
      const targetFolder = target ? `${target.id}_${target.w}x${target.h}${mode === 'universal' ? '_universal' : ''}` : '';
      const themeOut = path.join(opts.outputDir, base, targetFolder);
      const { audit } = writeLockscreenDelivery(variants, themeOut, { viewports });
      const [firstScript] = audit.scripts;
      if (mode === 'universal') {
        const interactionGraph = extractInteractionGraph(origDoc, ir);
        const stateMachine = extractStateMachine(origDoc, ir, assetIndex);
        const uiComponents = extractUiComponents({ doc: origDoc, themeDOM: ir, assetIndex, stateMachine });
        writeThemeOutputs(themeOut, {
          ir, compiled: compiledPrimary.compiled, interactionGraph, stateMachine,
          uiComponents, containerTree, mergeConfig, algorithm, cssOverrides,
        });
      }
      themes.push({
        ...firstScript.validation,
        themeName, canvas: ir.canvas, stats: ir.stats, scenes: ir.scenes,
        passed: audit.passed, scripts: audit.scripts,
      });
      for (const { manifestPath, validation } of audit.scripts) {
        const counts = validation.resources?.counts ?? {};
        const failed = validation.viewports.filter(viewport => !viewport.passed).map(viewport => viewport.id);
        console.log(`[${validation.passed ? 'PASS' : 'FAIL'}] ${themeName} / ${manifestPath} | missing=${counts.missing ?? 0} | failed devices=${failed.join(', ') || '0'}`);
      }
    } catch (err) {
      themes.push({ themeName, passed: false, scripts: [], error: err.message });
      console.error(`[ERROR] ${themeName}: ${err.message}`);
    }
  }

  const scripts = themes.flatMap(theme => theme.scripts);
  const cases = scripts.flatMap(script => script.validation.viewports);
  const report = {
    generatedAt: new Date().toISOString(),
    algorithm: algorithm?.name || opts.algo,
    mode,
    totalThemes: themes.length,
    passedThemes: themes.filter(theme => theme.passed).length,
    totalScripts: scripts.length,
    passedScripts: scripts.filter(script => script.validation.passed).length,
    totalCases: cases.length,
    passedCases: cases.filter(result => result.passed).length,
    themes,
  };

  const mdLines = [
    '# HWT Validation Report',
    '',
    `- Generated ${report.generatedAt}`,
    `- Algorithm \`${report.algorithm}\` · mode \`${mode}\``,
    `- Themes passed ${report.passedThemes} / ${report.totalThemes}`,
    `- Scripts passed ${report.passedScripts} / ${report.totalScripts}`,
    `- Viewport geometry passed ${report.passedCases} / ${report.totalCases}`,
    '',
    '| Theme | Manifest | Result | Missing assets | Dynamic references | External references | Failed viewport geometry |',
    '|---|---|---|---:|---:|---:|---|',
  ];
  for (const theme of themes) {
    if (theme.error) {
      mdLines.push(`| ${theme.themeName} | — | ERROR | — | — | — | ${theme.error.replace(/[|\r\n]/g, ' ')} |`);
    }
    for (const { manifestPath, validation } of theme.scripts) {
      const c = validation.resources?.counts ?? {};
      const failures = validation.viewports.filter(v => !v.passed).map(v => v.id).join(', ');
      mdLines.push(`| ${theme.themeName} | ${manifestPath} | ${validation.passed ? 'PASS' : 'FAIL'} | ${c.missing ?? '—'} | ${c.dynamic ?? '—'} | ${c.external ?? '—'} | ${failures || '—'} |`);
    }
  }
  fs.writeFileSync(path.join(opts.reportsDir, 'validation_report.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(opts.reportsDir, 'validation_report.md'), mdLines.join('\n') + '\n', 'utf8');
  console.log(`\nSummary: ${report.passedThemes}/${report.totalThemes} themes, ${report.passedScripts}/${report.totalScripts} scripts, ${report.passedCases}/${report.totalCases} viewport geometry checks.`);
  if (report.passedThemes !== report.totalThemes) process.exitCode = 1;
}

try {
  const opts = parseArgs(process.argv);
  if (opts.cmd === 'audit') cmdAudit(opts);
  else if (opts.cmd === 'adapt') await cmdAdapt(opts);
  else if (opts.cmd === 'validate') await cmdValidate(opts);
  else if (opts.cmd === 'analyze') await cmdAnalyze(opts);
  else if (opts.cmd === 'preview') startPreviewServer({ hwtDir: opts.hwtDir, port: opts.port, outputRoot: opts.outputDir });
  else throw new Error(`Unknown command: ${opts.cmd}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
