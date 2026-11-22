import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import { HwtArchive } from '../src/hwt/zip.js';
import { AssetIndex, parseMediaDimensions } from '../src/hwt/image_meta.js';
import { parseXml, serializeXml, walkElements } from '../src/xml/parser.js';
import { buildRuntimeContext, evalExpr, inspectExpression, rewriteExprForTransform } from '../src/expr/evaluator.js';
import { transpileToThemeDOM } from '../src/ir/transpiler.js';
import { getBreakpoint, solveHierarchicalScene, solveLayout } from '../src/layout/responsive_engine.js';
import { buildContainerTree, solveIntraContainerLayout } from '../src/layout/container_tree.js';
import { compileAdaptiveXml } from '../src/compiler/xml_compiler.js';
import { validateAdaptedTheme } from '../src/validator/validator.js';
import { auditResourceReferences } from '../src/hwt/resource_audit.js';
import { startPreviewServer } from '../src/preview/server.js';
import { replayInteractionSequences } from '../src/interaction/replay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HWT_DIR = path.resolve(__dirname, '..', '..');

function assertRealThemeValidation(validation, origDoc, assets) {
  assert.equal(validation.xmlValid, true);
  assert.equal(validation.preservedTags, true);
  assert.ok(validation.viewports.every(viewport => viewport.passed), JSON.stringify(validation.viewports, null, 2));
  const missing = auditResourceReferences(origDoc, assets).issues.filter(issue => issue.status === 'missing');
  assert.deepEqual(validation.resources.issues.filter(issue => issue.status === 'missing'), missing);
  assert.equal(validation.passed, missing.length === 0);
}

test('Expression parser & evaluator handles Huawei functions and multi-branch ifelse', () => {
  const ctx = {
    getVar(name, kind) {
      if (name === 'hour') return 14;
      if (name === 'OVH') return 2;
      if (name === 'title') return 'Hello World';
      return kind === '@' ? '' : 0;
    },
  };
  assert.equal(evalExpr('100 + 20 * 3', ctx), 160);
  assert.equal(evalExpr('ifelse(eq(#OVH,0),10,eq(#OVH,2),25,99)', ctx), 25);
  assert.equal(evalExpr('digit(14, 1) * 10 + digit(14, 2)', ctx), 41);
  assert.equal(evalExpr("strContains(@title, 'World')", ctx), 1);
  assert.equal(evalExpr('max(1080/1080, 1920/2400)', ctx), 1);
});

test('XML parser & serializer preserves tag casing, comments, and entities', () => {
  const raw = `<?xml version="1.0" encoding="utf-8"?>\n<Lockscreen screenWidth="1080">\n  <!-- keep comment -->\n  <group x="10" y="20">\n    <Image src="a.png" visibility="lt(#x,100)&amp;gt(1,0)" />\n  </group>\n</Lockscreen>`;
  const doc = parseXml(raw);
  assert.equal(doc.root.tag, 'Lockscreen');
  const tags = [];
  walkElements(doc.root, n => tags.push(n.tag));
  assert.deepEqual(tags, ['Lockscreen', 'group', 'Image']);
  const out = serializeXml(doc);
  const doc2 = parseXml(out);
  assert.equal(doc2.root.children.find(c => c.type === 'element').tag, 'group');
});

test('Symbolic expression rewriter freezes screen_derived vars and avoids double-scaling .actual_w', () => {
  const doc = parseXml(`<Lockscreen screenWidth="1080">
    <Var name="w" expression="#screen_width" />
    <Var name="ratio" expression="max(#w/1080,#screen_height/2400)" />
    <Var name="pianyi_x" expression="#w/2-1080*#ratio/2" />
    <Image name="dl_zs" x="155" y="566" w="100" h="80" src="a.png" />
  </Lockscreen>`);
  const ctx = buildRuntimeContext(doc.root, 1080, 2400);
  assert.equal(ctx.varMeta.get('ratio').depClass, 'screen_derived');
  assert.equal(ctx.varMeta.get('pianyi_x').depClass, 'screen_derived');

  const rewrittenStatic = rewriteExprForTransform({
    exprStr: '57*#ratio+#pianyi_x',
    ctx,
    scaleExpr: '#__hw_c1_s',
    offsetExpr: '#__hw_c1_ox',
    isSize: false,
  });
  assert.equal(rewrittenStatic, '#__hw_c1_ox+57*#__hw_c1_s');

  const rewrittenActual = rewriteExprForTransform({
    exprStr: '155+#dl_zs.actual_w-41',
    ctx,
    scaleExpr: '#s',
    offsetExpr: '#ox',
    isSize: false,
  });
  assert.ok(rewrittenActual.includes('#dl_zs.actual_w'), rewrittenActual);
  assert.ok(!rewrittenActual.includes('#dl_zs.actual_w*#s'), rewrittenActual);
});

import os from 'node:os';
import { HUAWEI_DEVICES } from '../src/devices/huawei_devices.js';
import { emitThemeCss, emitThemeHtml, parseCssOverrides } from '../src/frontend/html_css_ir.js';
import { emitInteractiveFrontendBundle } from '../src/frontend/interactive_bundle.js';
import { extractUiComponents } from '../src/frontend/ui_components.js';
import { extractInteractionGraph, validateInteractions } from '../src/interaction/interaction_adapter.js';
import { analyzeStateLayoutResponses, extractStateMachine } from '../src/interaction/state_machine.js';
import { executeInteraction } from '../src/interaction/runtime_engine.js';
import { applyConstraintGuard, loadExternalAlgorithm, normalizeAlgorithmResponse } from '../src/layout/algorithm_interface.js';
import { alignAdaptedNodeIds, evaluateXmlAtViewport } from '../src/validator/validator.js';

test('Huawei 5-breakpoint classifier and fold-hinge avoidance work across Pura X, Dual-Fold, and Tri-Fold', () => {
  assert.equal(getBreakpoint(1080, 2400), 'portrait_tall');
  assert.equal(getBreakpoint(HUAWEI_DEVICES.pura_x_portrait.w, HUAWEI_DEVICES.pura_x_portrait.h), 'wide_portrait');
  assert.equal(getBreakpoint(HUAWEI_DEVICES.pura_x_max_portrait.w, HUAWEI_DEVICES.pura_x_max_portrait.h), 'wide_portrait');
  assert.equal(getBreakpoint(HUAWEI_DEVICES.pura_x_cover.w, HUAWEI_DEVICES.pura_x_cover.h), 'square_fold');
  assert.equal(getBreakpoint(HUAWEI_DEVICES.dual_fold_unfolded.w, HUAWEI_DEVICES.dual_fold_unfolded.h), 'square_fold');
  assert.equal(getBreakpoint(HUAWEI_DEVICES.tri_fold_triple.w, HUAWEI_DEVICES.tri_fold_triple.h), 'landscape_tablet');
  assert.equal(getBreakpoint(1080, 486), 'landscape_wide');

  const sampleThemeDOM = {
    themeName: 'sample',
    canvas: { baseW: 1080, baseH: 2400 },
    scenes: ['main'],
    components: [
      { id: 'c_bg', scene: 'main', variantKey: null, semanticRole: 'background', bbox: { x: 0, y: 0, w: 1080, h: 2400 }, layoutPolicy: { focalY: 0.5 } },
      { id: 'c_clk', scene: 'main', variantKey: null, semanticRole: 'clock', bbox: { x: 100, y: 200, w: 400, h: 220 }, layoutPolicy: { pane: 'left_primary', anchor: 'top', preserveAspect: true } },
      { id: 'c_hero', scene: 'main', variantKey: null, semanticRole: 'hero', bbox: { x: 140, y: 700, w: 420, h: 480 }, layoutPolicy: { pane: 'right_content', anchor: 'center', preserveAspect: true } },
      { id: 'c_dl', scene: 'main', variantKey: null, semanticRole: 'dock_left', bbox: { x: 80, y: 2130, w: 120, h: 120 }, layoutPolicy: { pane: 'dock', anchor: 'bottom_left', preserveAspect: true } },
      { id: 'c_dr', scene: 'main', variantKey: null, semanticRole: 'dock_right', bbox: { x: 880, y: 2130, w: 120, h: 120 }, layoutPolicy: { pane: 'dock', anchor: 'bottom_right', preserveAspect: true } },
    ],
  };

  // Tri-Fold 3-panel hinge check (hinges at 360 and 720)
  const tri = solveLayout(sampleThemeDOM, HUAWEI_DEVICES.tri_fold_triple.w, HUAWEI_DEVICES.tri_fold_triple.h, {
    deviceProfile: HUAWEI_DEVICES.tri_fold_triple,
  });
  const clk = tri.get('c_clk');
  const hero = tri.get('c_hero');
  assert.ok(clk.targetBBox.x + clk.targetBBox.w <= 360 - 14, 'Clock stays cleanly inside left Tri-Fold panel');
  assert.ok(hero.targetBBox.x >= 360 + 14, 'Hero stays outside left hinge');
  assert.equal(clk.sx, clk.sy);
  assert.equal(hero.sx, hero.sy);
});

test('Interaction preservation keeps triggers, swipe thresholds, and dynamic groups intact', () => {
  const rawXml = `<Lockscreen screenWidth="1080">
    <Var name="oneSec" expression="0" />
    <Group x="#screen_width*(1-#oneSec)" y="0">
      <Image name="card_bg" x="100" y="300" w="880" h="420" src="bg.png" />
      <Button x="100" y="300" w="880" h="420">
        <Triggers>
          <Trigger action="up">
            <VariableCommand name="oneSec" expression="0" condition="gt(#touch_begin_y-#touch_y,250)*le(abs(#touch_begin_x-#touch_x),20)" />
          </Trigger>
        </Triggers>
      </Button>
    </Group>
  </Lockscreen>`;
  const origDoc = parseXml(rawXml);
  const ir = transpileToThemeDOM(origDoc, null, 'drawer_test.hwt');
  assert.ok(ir.scenes.includes('drawer'), 'Paging drawer scene must be discovered, not dropped');

  const compiled = compileAdaptiveXml(origDoc, ir, { mode: 'universal' });
  assert.equal(compiled.interactionStats.mutatedLogicCount, 0);
  assert.ok(compiled.xml.includes('gt(#touch_begin_y-#touch_y,250)'), 'Original swipe condition must be byte-for-byte preserved');
  assert.ok(compiled.xml.includes('#screen_width*(1-#oneSec)'), 'Dynamic paging Group expression must be preserved');

  const val = validateAdaptedTheme({ origDoc, adaptedXml: compiled.xml, themeDOM: ir, assetIndex: null });
  assert.equal(val.passed, true, JSON.stringify(val.viewports, null, 2));
  assert.equal(val.viewports[0].mutatedLogicCount, 0);
  assert.equal(val.viewports[0].wipedDynamicGroupCount, 0);

  const cssRules = parseCssOverrides('#comp_1 { order: 2; max-scale: 0.85; avoid-hinge: true; }');
  assert.equal(cssRules.get('comp_1').order, 2);
  assert.equal(cssRules.get('comp_1').maxScale === undefined ? cssRules.get('comp_1')['max-scale'] : cssRules.get('comp_1').maxScale, 0.85);
  assert.equal(cssRules.get('comp_1').avoidHinge, true);
});

test('Pluggable custom layout algorithm plugin integrates cleanly via ConstraintGuard', async t => {
  const samplePath = path.join(HWT_DIR, '假日特调青柠气泡.hwt');
  if (!fs.existsSync(samplePath)) return t.skip('Missing sample HWT');

  const plugin = await loadExternalAlgorithm(path.join(__dirname, '..', 'examples', 'custom_layout_plugin.js'));
  const archive = HwtArchive.open(samplePath);
  const origDoc = parseXml(archive.readText('unlock/lockscreen/manifest.xml'));
  const assets = new AssetIndex(archive);
  const ir = transpileToThemeDOM(origDoc, assets, '假日特调青柠气泡.hwt');

  const compiled = compileAdaptiveXml(origDoc, ir, { mode: 'universal', algorithm: plugin });
  const val = validateAdaptedTheme({ origDoc, adaptedXml: compiled.xml, themeDOM: ir, assetIndex: assets });
  assert.equal(val.xmlValid, true);
  assertRealThemeValidation(val, origDoc, assets);

  const html = emitThemeHtml(ir, extractInteractionGraph(origDoc, ir));
  assert.ok(html.includes('data-scene="main"'));
  const css = emitThemeCss(ir, [{ device: HUAWEI_DEVICES.tri_fold_triple, transforms: solveLayout(ir, HUAWEI_DEVICES.tri_fold_triple.w, HUAWEI_DEVICES.tri_fold_triple.h, { algorithm: plugin, deviceProfile: HUAWEI_DEVICES.tri_fold_triple }) }]);
  assert.ok(css.includes('@media'));
});

test('Real .hwt end-to-end round-trip ZIP + Transpile + Compile + Validate', t => {
  const samplePath = path.join(HWT_DIR, '假日特调青柠气泡.hwt');
  if (!fs.existsSync(samplePath)) return t.skip('Missing sample HWT');

  const archive = HwtArchive.open(samplePath);
  const rawXml = archive.readText('unlock/lockscreen/manifest.xml');
  const origDoc = parseXml(rawXml);
  const assets = new AssetIndex(archive);

  const imgDims = parseMediaDimensions(archive.readBuffer('unlock/lockscreen/aod.jpg'), 'aod.jpg');
  assert.equal(imgDims.width, 1080);
  assert.equal(imgDims.height, 2400);

  const ir = transpileToThemeDOM(origDoc, assets, '假日特调青柠气泡.hwt');
  assert.equal(ir.canvas.baseW, 1080);
  assert.equal(ir.canvas.baseH, 2400);

  const compiled = compileAdaptiveXml(origDoc, ir, { mode: 'universal' });
  const val = validateAdaptedTheme({
    origDoc,
    adaptedXml: compiled.xml,
    themeDOM: ir,
    assetIndex: assets,
  });

  assert.equal(val.xmlValid, true);
  assert.equal(val.preservedTags, true);
  assertRealThemeValidation(val, origDoc, assets);

  // Verify ZIP repack round-trip
  const repacked = archive.repack(new Map([
    ['unlock/lockscreen/manifest.xml', Buffer.from(compiled.xml, 'utf8')],
  ]));
  const archive2 = new HwtArchive(repacked);
  assert.equal(archive2.readText('unlock/lockscreen/manifest.xml'), compiled.xml);
});

test('Scene isolation prevents offscreen drawers/particles from leaking into Scene 1 and isolates state buttons', () => {
  const rawXml = `<Lockscreen screenWidth="1080">
    <Var name="set_run" expression="0" />
    <Var name="slide" expression="0" />
    <Var name="mode_a" expression="0" />
    <Image name="hero_main" x="100" y="200" w="880" h="400" src="hero.png" />
    <Button x="100" y="200" w="200" h="200" visibility="eq(#mode_a,1)">
      <Triggers><Trigger action="up"><VariableCommand name="mode_a" expression="0" /></Trigger></Triggers>
    </Button>
    <Group x="0" y="1170-1170*sin(#set_run)">
      <Image name="drawer_card" x="100" y="1400" w="600" h="300" src="card.png" />
    </Group>
    <Image name="leaf_slide" x="57+650*(#slide-1)" y="700" w="200" h="80" src="leaf.png" />
    <Image name="snow" x="300" y="-100" w="48" h="48" src="snow.png">
      <PositionAnimation><Position x="0" y="2500" time="3000" /></PositionAnimation>
    </Image>
  </Lockscreen>`;
  const origDoc = parseXml(rawXml);
  const ir = transpileToThemeDOM(origDoc, null, 'scene_leak_test.hwt');

  // State-scoped button (eq(#mode_a,1)) must NOT bind to unscoped hero_main
  const heroComp = ir.components.find(c => c.memberIds.length === 1 && ir.elements.find(e => e.nodeId === c.memberIds[0])?.name === 'hero_main');
  assert.equal(heroComp.boundButtonIds.length, 0);

  // Offscreen ambient particle stays offscreen_ambient
  const snowComp = ir.components.find(c => c.semanticRole === 'offscreen_ambient');
  assert.ok(snowComp, 'Offscreen particle should be classified offscreen_ambient');

  const compiled = compileAdaptiveXml(origDoc, ir, { mode: 'universal' });
  const val = validateAdaptedTheme({ origDoc, adaptedXml: compiled.xml, themeDOM: ir, assetIndex: null });
  assert.equal(val.passed, true, JSON.stringify(val.viewports, null, 2));
  for (const vp of val.viewports) {
    assert.equal(vp.sceneLeakCount, 0, `Viewport ${vp.id} leaked offscreen scenes into Scene 1`);
  }
});

test('extractStateMachine auto-discovers interactive states, animations, and transitions across real themes', t => {
  const sampleNames = ['假日特调青柠气泡.hwt', '波蓝.hwt', '景深双色鱼缸 步数感知.hwt', '华UI新.hwt'];
  if (!sampleNames.some(file => fs.existsSync(path.join(HWT_DIR, file)))) return t.skip('Missing sample HWTs');
  for (const f of sampleNames) {
    const p = path.join(HWT_DIR, f);
    if (!fs.existsSync(p)) {
      t.diagnostic(`Missing sample: ${f}`);
      continue;
    }
    const archive = HwtArchive.open(p);
    const doc = parseXml(archive.readText('unlock/lockscreen/manifest.xml'));
    const assets = new AssetIndex(archive);
    const ir = transpileToThemeDOM(doc, assets, f);
    const sm = extractStateMachine(doc, ir, assets);
    assert.ok(sm.states.length >= 2, `${f} should discover >= 2 reachable states, got ${sm.states.length}`);
    assert.equal(sm.states[0].id, 'S0_default');
    assert.ok(sm.stateVars.length >= 1, `${f} should have stateVars`);
  }
});

test('executeInteraction executes live tap, swipe unlock, animation command, and reset', () => {
  const rawXml = `<Lockscreen screenWidth="1080">
    <Var name="drawer_open" expression="0" />
    <Var name="anim_x" expression="0">
      <VariableAnimation name="open_anim">
        <AniFrame value="0" time="0" />
        <AniFrame value="1" time="300" />
      </VariableAnimation>
    </Var>
    <Image name="bg" x="0" y="0" w="1080" h="2400" src="bg.png" />
    <Image name="drawer_panel" x="0" y="200" w="800" h="600" src="drawer.png" visibility="eq(#drawer_open,1)*eq(#anim_x,1)" />
    <Button name="btn_open" x="100" y="1800" w="200" h="120">
      <Triggers>
        <Trigger action="up">
          <VariableCommand name="drawer_open" expression="ifelse(#drawer_open,0,1)" />
          <Command target="open_anim" value="play" />
        </Trigger>
      </Triggers>
    </Button>
    <Button name="btn_unlock" x="0" y="0" w="#screen_width" h="#screen_height">
      <Triggers>
        <Trigger action="up" condition="gt(#touch_begin_y-#touch_y,200)">
          <ExternCommand command="unlock" />
        </Trigger>
      </Triggers>
    </Button>
  </Lockscreen>`;
  const doc = parseXml(rawXml);
  const ir = transpileToThemeDOM(doc, null, 'runtime_test.hwt');
  const sm = extractStateMachine(doc, ir, null);

  // 1. Tap button -> mutates drawer_open and runs VariableAnimation open_anim -> anim_x=1
  const tapRes = executeInteraction({
    doc,
    themeDOM: ir,
    stateMachine: sm,
    viewportW: 1080,
    viewportH: 2400,
    currentVars: {},
    event: { type: 'tap', x: 150, y: 1850 },
  });
  assert.equal(tapRes.vars.drawer_open, 1);
  assert.equal(tapRes.vars.anim_x, 1);

  // 2. Vertical swipe -> triggers fullscreen unlock
  const swipeRes = executeInteraction({
    doc,
    themeDOM: ir,
    stateMachine: sm,
    viewportW: 1080,
    viewportH: 2400,
    currentVars: tapRes.vars,
    event: { type: 'swipe', beginX: 540, beginY: 2000, x: 540, y: 1500 },
  });
  assert.equal(swipeRes.unlocked, true);

  // 3. Reset
  const resetRes = executeInteraction({
    doc,
    themeDOM: ir,
    stateMachine: sm,
    viewportW: 1080,
    viewportH: 2400,
    currentVars: tapRes.vars,
    event: { type: 'reset' },
  });
  assert.deepEqual(resetRes.vars, {});
  assert.equal(resetRes.activeStateId, 'S0_default');
});

test('compileAdaptiveXml mode target produces clean XML with __hw_sw/__hw_sh across form factors', t => {
  const samplePath = path.join(HWT_DIR, '假日特调青柠气泡.hwt');
  if (!fs.existsSync(samplePath)) return t.skip('Missing sample HWT');
  const archive = HwtArchive.open(samplePath);
  const origDoc = parseXml(archive.readText('unlock/lockscreen/manifest.xml'));
  const assets = new AssetIndex(archive);
  const ir = transpileToThemeDOM(origDoc, assets, '假日特调青柠气泡.hwt');

  for (const dev of [HUAWEI_DEVICES.pura_x_cover, HUAWEI_DEVICES.dual_fold_unfolded, HUAWEI_DEVICES.tablet_land]) {
    const compiled = compileAdaptiveXml(origDoc, ir, {
      mode: 'target',
      targetW: dev.w,
      targetH: dev.h,
      deviceProfile: dev,
    });
    assert.ok(compiled.xml.includes('name="__hw_sw"'));
    assert.ok(compiled.xml.includes('name="__hw_sh"'));
    const adaptedDoc = alignAdaptedNodeIds(parseXml(compiled.xml));
    const ev = evaluateXmlAtViewport(adaptedDoc, assets, dev.w, dev.h);
    assert.equal(ev.nanCount, 0, `${dev.id} had NaN expressions`);
  }
});

test('analyzeStateLayoutResponses and emitInteractiveFrontendBundle export valid standalone outputs', t => {
  const samplePath = path.join(HWT_DIR, '假日特调青柠气泡.hwt');
  if (!fs.existsSync(samplePath)) return t.skip('Missing sample HWT');
  const archive = HwtArchive.open(samplePath);
  const origDoc = parseXml(archive.readText('unlock/lockscreen/manifest.xml'));
  const assets = new AssetIndex(archive);
  const ir = transpileToThemeDOM(origDoc, assets, '假日特调青柠气泡.hwt');
  const sm = extractStateMachine(origDoc, ir, assets);
  const dev = HUAWEI_DEVICES.dual_fold_unfolded;

  const compiled = compileAdaptiveXml(origDoc, ir, {
    mode: 'target',
    targetW: dev.w,
    targetH: dev.h,
    deviceProfile: dev,
  });
  const adaptedDoc = alignAdaptedNodeIds(parseXml(compiled.xml));

  const analysis = analyzeStateLayoutResponses({
    themeDOM: ir,
    origDoc,
    adaptedDoc,
    assetIndex: assets,
    stateMachine: sm,
    devices: [HUAWEI_DEVICES.phone_2400, dev],
  });
  assert.equal(analysis.totalEvaluations, sm.states.length * 2);
  assert.ok(analysis.cells.every(c => c.nanCount === 0));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwflex-bundle-'));
  try {
    const res = emitInteractiveFrontendBundle({
      themeFile: '假日特调青柠气泡.hwt',
      archive,
      assetIndex: assets,
      themeDOM: ir,
      origDoc,
      adaptedDoc,
      interactionGraph: extractInteractionGraph(origDoc, ir),
      stateMachine: sm,
      targetDevice: dev,
      outDir: tmpDir,
    });
    for (const f of ['interactive.html', 'theme.css', 'state_graph.json', 'ui_components.json', 'state_layout_analysis.json', 'state_layout_analysis.md']) {
      assert.ok(fs.existsSync(path.join(tmpDir, f)), `Missing ${f}`);
    }
    assert.ok(res.assetCount > 0, 'Should extract visual assets into assets/');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('extractUiComponents lifts drawers (<hw-drawer>) and imageSwitchers (<hw-image-switcher>) across real themes', t => {
  const checks = [
    { file: '假日特调青柠气泡.hwt', minDrawers: 1, minSwitchers: 1 },
    { file: '波蓝.hwt', minDrawers: 0, minSwitchers: 2 },
    { file: '五福临门 3D动态.hwt', minDrawers: 1, minSwitchers: 2 },
    { file: '半岛日记改.hwt', minDrawers: 1, minSwitchers: 1 },
  ];
  if (!checks.some(({ file }) => fs.existsSync(path.join(HWT_DIR, file)))) return t.skip('Missing sample HWTs');
  for (const ch of checks) {
    const p = path.join(HWT_DIR, ch.file);
    if (!fs.existsSync(p)) {
      t.diagnostic(`Missing sample: ${ch.file}`);
      continue;
    }
    const archive = HwtArchive.open(p);
    const doc = parseXml(archive.readText('unlock/lockscreen/manifest.xml'));
    const assets = new AssetIndex(archive);
    const ir = transpileToThemeDOM(doc, assets, ch.file);
    const sm = extractStateMachine(doc, ir, assets);
    const uic = extractUiComponents({ doc, themeDOM: ir, assetIndex: assets, stateMachine: sm });

    assert.ok(uic.drawers.length >= ch.minDrawers, `${ch.file} drawers ${uic.drawers.length} < ${ch.minDrawers}`);
    assert.ok(uic.imageSwitchers.length >= ch.minSwitchers, `${ch.file} imageSwitchers ${uic.imageSwitchers.length} < ${ch.minSwitchers}`);
    for (const sw of uic.imageSwitchers) {
      const distinct = new Set(sw.slots.map(s => s.asset));
      assert.ok(distinct.size >= 2, `${ch.file} switcher ${sw.id} should have >= 2 distinct assets`);
    }

    const html = emitThemeHtml(ir, extractInteractionGraph(doc, ir), sm, uic);
    if (uic.drawers.length) assert.ok(html.includes('<hw-drawer '), `${ch.file} HTML missing <hw-drawer>`);
    if (uic.imageSwitchers.length) {
      assert.ok(html.includes('<hw-image-switcher '), `${ch.file} HTML missing <hw-image-switcher>`);
      assert.ok(html.includes('<figure class="hw-slot"'), `${ch.file} HTML missing <figure class="hw-slot">`);
    }
    const css = emitThemeCss(ir, [], null, uic);
    assert.ok(css.includes('.hw-drawer-surface') && css.includes('.hw-slot'));
  }
});

test('Unsampled and combined interaction states return a scene without recursion', () => {
  const stateMachine = {
    stateVars: [{ name: 'drawer_open', initialValue: 0, sceneHint: 'drawer' }, { name: 'style', initialValue: 0 }],
    states: [{ id: 'S0_default', vars: {}, sceneHint: 'main' }, { id: 'known', vars: { style: 1 }, sceneHint: 'main' }],
  };
  const result = executeInteraction({
    stateMachine, currentVars: { style: 1 }, event: { type: 'var_set', varName: 'drawer_open', varValue: 2 },
  });
  assert.equal(result.activeStateId, 'custom');
  assert.equal(result.sceneHint, 'drawer');
  assert.deepEqual(result.vars, { style: 1, drawer_open: 2 });
  assert.equal(executeInteraction({ stateMachine, event: { type: 'var_set', varName: 'style', varValue: 0 } }).activeStateId, 'S0_default');
});

test('Expression and XML diagnostics identify malformed and unsupported input', () => {
  assert.throws(() => parseXml('<Lockscreen/><Lockscreen/>'), /second root/);
  assert.throws(() => parseXml('<Lockscreen screenWidth="1080" screenWidth="1000"/>'), /Duplicate attribute/);
  assert.equal(inspectExpression('2+')[0].kind, 'syntax');
  assert.deepEqual(inspectExpression('unknownFunction(2)'), [{ kind: 'unsupported_function', reason: 'unknownFunction' }]);
  assert.deepEqual(inspectExpression('ifelse(gt(#level,0),3,1)'), []);
});

function emptyArchive() {
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50);
  return new HwtArchive(endOfCentralDirectory);
}

test('A static missing asset fails validation with its source node', () => {
  const archive = emptyArchive();
  const assets = new AssetIndex(archive);
  const origDoc = parseXml('<Lockscreen><Image w="50" h="50" src="missing.png"/></Lockscreen>');
  const themeDOM = transpileToThemeDOM(origDoc, assets);
  const adaptedXml = compileAdaptiveXml(origDoc, themeDOM).xml;
  const result = validateAdaptedTheme({ origDoc, adaptedXml, themeDOM, assetIndex: assets });
  assert.equal(result.passed, false);
  assert.deepEqual(result.resources.issues, [
    { nodeId: 'n_2', tag: 'Image', attribute: 'src', value: 'missing.png', status: 'missing' },
  ]);
});

test('Layout contracts enforce safe insets, scale overrides, and XML scale support', () => {
  const doc = parseXml('<Lockscreen><Image name="widget" x="100" y="100" w="100" h="50" src="widget.png"/></Lockscreen>');
  const ir = transpileToThemeDOM(doc, null, 'constraints.hwt');
  const [c] = ir.components;
  const device = {
    id: 'asymmetric', w: 1000, h: 800, breakpoint: 'landscape_tablet',
    safeArea: { left: 10, right: 90, top: 20, bottom: 100 }, hinges: [],
  };
  const proposed = normalizeAlgorithmResponse({ bboxes: { [c.stableKey]: [950, 760, 100, 50] } }, [c], device);
  const guarded = applyConstraintGuard(proposed, [c], device, new Map()).get(c.id);
  assert.deepEqual(guarded.targetBBox, { x: 810, y: 650, w: 100, h: 50 });
  assert.throws(() => normalizeAlgorithmResponse(new Map([[c.id, { sx: -1, sy: 1, tx: 0, ty: 0 }]]), [c], device), /positive/);
  assert.throws(() => normalizeAlgorithmResponse({ coordinate_system: 'pixels' }, [c], device), /coordinate system/);

  const cover = HUAWEI_DEVICES.pura_x_cover;
  const cssOverrides = parseCssOverrides(`#${c.stableKey} { max-scale: 0.2; }`);
  const compiled = compileAdaptiveXml(doc, ir, { mode: 'target', targetW: cover.w, targetH: cover.h, deviceProfile: cover, cssOverrides });
  const adaptedDoc = alignAdaptedNodeIds(parseXml(compiled.xml));
  assert.equal(evaluateXmlAtViewport(adaptedDoc, null, cover.w, cover.h).items[0].w, 20);
  c.layoutPolicy.preserveAspect = false;
  const algorithm = { name: 'nonuniform', solve: () => ({ components: { [c.id]: { sx: 2, sy: 1, tx: 250, ty: 300 } } }) };
  assert.throws(() => compileAdaptiveXml(doc, ir, { mode: 'target', targetW: cover.w, targetH: cover.h, deviceProfile: cover, algorithm }), /equal x\/y scales/);
});

test('Stable component keys survive an unrelated earlier XML node', () => {
  const widget = '<Image name="widget" x="100" y="100" w="100" h="50" src="widget.png"/>';
  const extras = '<Image name="background" x="0" y="0" w="1080" h="2400" src="bg.png"/>';
  const before = transpileToThemeDOM(parseXml(`<Lockscreen>${widget}</Lockscreen>`), null, 'fixture.hwt');
  const after = transpileToThemeDOM(parseXml(`<Lockscreen>${extras}${widget}</Lockscreen>`), null, 'fixture.hwt');
  const key = before.components[0].stableKey;
  const match = after.components.find(component => component.stableKey === key);
  assert.ok(match);
  assert.notEqual(match.id, before.components[0].id);
  assert.equal(after.elements.find(el => el.name === 'widget').sourcePath, before.elements[0].sourcePath);
});

test('Replay follows a real click and return sequence on the adapted document', () => {
  const origDoc = parseXml(`<Lockscreen screenWidth="1080">
    <Var name="panel_open" expression="0"/>
    <Rectangle x="100" y="300" w="300" h="150" visibility="#panel_open"/>
    <Button name="open" x="100" y="150" w="100" h="80" visibility="not(#panel_open)">
      <Triggers><Trigger action="up"><VariableCommand name="panel_open" expression="1"/></Trigger></Triggers>
    </Button>
    <Button name="close" x="100" y="150" w="100" h="80" visibility="#panel_open">
      <Triggers><Trigger action="up"><VariableCommand name="panel_open" expression="0"/></Trigger></Triggers>
    </Button>
  </Lockscreen>`);
  const themeDOM = transpileToThemeDOM(origDoc, null);
  const device = HUAWEI_DEVICES.phone_2400;
  const adaptedDoc = alignAdaptedNodeIds(parseXml(compileAdaptiveXml(origDoc, themeDOM).xml));
  const stateMachine = extractStateMachine(origDoc, themeDOM, null);
  const result = replayInteractionSequences({ origDoc, adaptedDoc, themeDOM, assetIndex: null, stateMachine, device });
  assert.ok(result.steps.some(step => step.path.length === 2 && step.status === 'matched' && step.targetChanges.panel_open?.to === 0));
});

test('Preview selects the same target XML as the exported HWT and checks both manifests', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hwflex-preview-'));
  const input = path.join(workspace, 'fixtures');
  fs.mkdirSync(input);
  const outDir = path.join(workspace, 'output');
  const manifestPath = 'unlock/lockscreen/manifest.xml';
  const ucdPath = 'unlock/ucdlockscreen/manifest.xml';
  const manifest = Buffer.from('<Lockscreen screenWidth="1080"><Rectangle x="100" y="220" w="180" h="65"/></Lockscreen>');
  const ucd = Buffer.from('<Lockscreen screenWidth="1080"><Rectangle x="100" y="290" w="180" h="65"/></Lockscreen>');
  fs.writeFileSync(path.join(input, 'fixture.hwt'), emptyArchive().repack(new Map([[manifestPath, manifest], [ucdPath, ucd]])));
  fs.writeFileSync(path.join(input, 'invalid.hwt'), 'unused sample');
  const server = startPreviewServer({ hwtDir: input, outputRoot: outDir, port: 0 });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const host = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(host + '/api/themes')).json(), [{ file: 'fixture.hwt' }, { file: 'invalid.hwt' }]);

  const base = host + '/api/theme/fixture.hwt';
  const options = { algo: 'hwflex', compileMode: 'target', w: 1600, h: 900 };
  const query = new URLSearchParams(options);
  const previewXml = await (await fetch(base + '/xml?' + query)).text();
  const rendered = await (await fetch(base + '/render?' + query)).json();
  const response = await fetch(base + '/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const exported = await response.json();
  assert.equal(exported.summary.manifestCount, 2);
  assert.equal(rendered.device.id, exported.device.id);
  assert.deepEqual([rendered.w, rendered.h], [1080, 608]);
  const repacked = HwtArchive.open(path.join(exported.outDir, exported.files.find(file => file.endsWith('.hwt'))));
  assert.equal(repacked.readText(manifestPath), previewXml);
  assert.notEqual(repacked.readText(ucdPath), ucd.toString());
  const audit = JSON.parse(fs.readFileSync(path.join(exported.outDir, 'delivery_audit.json'), 'utf8'));
  assert.equal(audit.packageReadBack, true);
  assert.deepEqual(audit.scripts.map(script => script.manifestPath), [manifestPath, ucdPath]);
});

test('buildContainerTree auto-merges header_cluster, dock_bar, widget_row and supports custom mergeConfig', () => {
  const sampleDOM = {
    themeName: 'hier_sample',
    canvas: { baseW: 1080, baseH: 2400 },
    scenes: ['main'],
    components: [
      { id: 'c_clk', scene: 'main', semanticRole: 'clock', variantKey: null, bbox: { x: 240, y: 200, w: 600, h: 180 }, memberIds: ['n1'], boundButtonIds: [], layoutPolicy: { pane: 'left_primary' } },
      { id: 'c_dt', scene: 'main', semanticRole: 'date', variantKey: null, bbox: { x: 340, y: 400, w: 400, h: 60 }, memberIds: ['n2'], boundButtonIds: [], layoutPolicy: { pane: 'left_primary' } },
      { id: 'c_w1', scene: 'main', semanticRole: 'widget_card', variantKey: null, bbox: { x: 80, y: 900, w: 420, h: 240 }, memberIds: ['n3'], boundButtonIds: [], layoutPolicy: { pane: 'right_content' } },
      { id: 'c_w2', scene: 'main', semanticRole: 'widget_card', variantKey: null, bbox: { x: 580, y: 900, w: 420, h: 240 }, memberIds: ['n4'], boundButtonIds: [], layoutPolicy: { pane: 'right_content' } },
      { id: 'c_dl', scene: 'main', semanticRole: 'dock_left', variantKey: null, bbox: { x: 80, y: 2150, w: 120, h: 120 }, memberIds: ['n5'], boundButtonIds: [], layoutPolicy: { pane: 'dock' } },
      { id: 'c_dr', scene: 'main', semanticRole: 'dock_right', variantKey: null, bbox: { x: 880, y: 2150, w: 120, h: 120 }, memberIds: ['n6'], boundButtonIds: [], layoutPolicy: { pane: 'dock' } },
    ],
  };

  const tree = buildContainerTree(sampleDOM);
  assert.equal(tree.summary.totalChildren, 6);
  assert.equal(tree.summary.totalMacroContainers, 3, 'Should merge into dock_bar + header_cluster + widget_row');
  const kinds = tree.containers.map(c => c.kind).sort();
  assert.deepEqual(kinds, ['dock_bar', 'header_cluster', 'widget_row']);

  // Custom merge override combining c_w1 + c_w2 with flex_col
  const customTree = buildContainerTree(sampleDOM, {
    groups: [{ id: 'custom_box', scene: 'main', label: '自定义纵向栈', childIds: ['c_w1', 'c_w2'], intraLayout: 'flex_col', align: 'center', justify: 'center' }],
  });
  const customMc = customTree.containers.find(c => c.id === 'custom_box');
  assert.ok(customMc && customMc.isCustomMerged && customMc.intraLayout === 'flex_col');

  // HTML + CSS emission includes nested hw-container wrappers and CSS Flexbox rules
  const html = emitThemeHtml(sampleDOM, null, null, null, customTree);
  assert.ok(html.includes('class="hw-container layout-flex_col"'), html);
  const css = emitThemeCss(sampleDOM, [], null, null, customTree);
  assert.ok(css.includes('#custom_box { display: flex; flex-direction: column; align-items: center; justify-content: center;'), css);
});

test('solveIntraContainerLayout aligns, centers, and spaces children cleanly across flex_col, flex_row, and grid_even', () => {
  const c1 = { id: 'a', bbox: { x: 0, y: 0, w: 100, h: 100 } };
  const c2 = { id: 'b', bbox: { x: 150, y: 0, w: 200, h: 100 } };
  const targetBox = { x: 100, y: 50, w: 600, h: 300 };

  // flex_col centered
  const colRes = solveIntraContainerLayout(
    { id: 'mc_col', bbox: { x: 0, y: 0, w: 400, h: 200 }, intraLayout: 'flex_col', align: 'center', justify: 'center', gap: 20, explicitOverride: true },
    targetBox,
    [c1, c2],
    HUAWEI_DEVICES.tablet_land,
  );
  const aCol = colRes.get('a').targetBBox;
  const bCol = colRes.get('b').targetBBox;
  assert.ok(Math.abs((aCol.x + aCol.w / 2) - (bCol.x + bCol.w / 2)) < 0.5, 'flex_col center align');
  assert.ok(Math.abs((bCol.y - (aCol.y + aCol.h)) - 20) < 0.5, 'flex_col exact equal gap=20');

  // flex_row space_between
  const rowRes = solveIntraContainerLayout(
    { id: 'mc_row', bbox: { x: 0, y: 0, w: 400, h: 100 }, intraLayout: 'flex_row', align: 'center', justify: 'space_between', gap: 10, explicitOverride: true },
    targetBox,
    [c1, c2],
    HUAWEI_DEVICES.tablet_land,
  );
  const aRow = rowRes.get('a').targetBBox;
  const bRow = rowRes.get('b').targetBBox;
  assert.ok(Math.abs(aRow.x - targetBox.x) < 1, 'space_between pins first child to left edge');
  assert.ok(Math.abs((bRow.x + bRow.w) - (targetBox.x + targetBox.w)) < 1, 'space_between pins last child to right edge');

  // grid_even 2 cols
  const gridRes = solveIntraContainerLayout(
    { id: 'mc_grid', bbox: { x: 0, y: 0, w: 400, h: 100 }, intraLayout: 'grid_even', cols: 2, gap: 20, explicitOverride: true },
    targetBox,
    [c1, c2],
    HUAWEI_DEVICES.tablet_land,
  );
  assert.equal(gridRes.size, 2);
  assert.ok(gridRes.get('a').targetBBox.x < gridRes.get('b').targetBBox.x);
});

test('Format C hierarchical plugin (macro_bboxes) adapts real .hwt theme cleanly across all 8 viewports', async t => {
  const samplePath = path.join(HWT_DIR, '假日特调青柠气泡.hwt');
  if (!fs.existsSync(samplePath)) return t.skip('Missing sample HWT');

  const plugin = await loadExternalAlgorithm(path.join(__dirname, '..', 'examples', 'hierarchical_layout_plugin.js'));
  const archive = HwtArchive.open(samplePath);
  const origDoc = parseXml(archive.readText('unlock/lockscreen/manifest.xml'));
  const assets = new AssetIndex(archive);
  const ir = transpileToThemeDOM(origDoc, assets, '假日特调青柠气泡.hwt');

  const compiled = compileAdaptiveXml(origDoc, ir, { mode: 'universal', algorithm: plugin });
  const val = validateAdaptedTheme({ origDoc, adaptedXml: compiled.xml, themeDOM: ir, assetIndex: assets });
  assert.equal(val.xmlValid, true);
  assertRealThemeValidation(val, origDoc, assets);
});
