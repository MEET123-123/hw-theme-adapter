/**
 * Frontend HTML + CSS Emitter & Stylesheet Override Layer.
 *
 * Bridges Huawei Lockscreen ThemeDOM + InteractionGraph + UiComponents into standard
 * inspectable semantic HTML (<hw-drawer>, <hw-image-switcher>) and CSS @media rules across 5 Huawei breakpoints.
 */

import { HW_COMPONENTS_CSS } from './hw_components.js';

function escapeHtmlAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Emit semantic HTML representing the theme's DOM hierarchy, layout panes, and interaction hit targets.
 */
export function emitThemeHtml(themeDOM, interactionGraph = null, stateMachine = null, uiComponents = null, containerTree = null) {
  const { baseW, baseH } = themeDOM.canvas;
  const hitByComp = new Map();
  if (interactionGraph && interactionGraph.hitTargets) {
    for (const ht of interactionGraph.hitTargets) {
      const key = ht.boundComponentId || '__global__';
      if (!hitByComp.has(key)) hitByComp.set(key, []);
      hitByComp.get(key).push(ht);
    }
  }

  const stateIdsByComp = new Map();
  if (stateMachine && stateMachine.states) {
    for (const st of stateMachine.states) {
      for (const cid of st.visibleComponentIds || []) {
        if (!stateIdsByComp.has(cid)) stateIdsByComp.set(cid, []);
        stateIdsByComp.get(cid).push(st.id);
      }
    }
  }

  const stateAttr = stateMachine ? ` data-state-count="${stateMachine.states.length}" data-state="S0_default"` : '';
  const lines = [
    '<!DOCTYPE html>',
    `<html lang="zh-CN" data-theme="${escapeHtmlAttr(themeDOM.themeName)}" data-base-w="${baseW}" data-base-h="${baseH}"${stateAttr}>`,
    '<head>',
    '  <meta charset="UTF-8" />',
    `  <title>${escapeHtmlAttr(themeDOM.themeName)} · HwFlex ThemeDOM</title>`,
    '  <link rel="stylesheet" href="./theme.css" />',
    '</head>',
    '<body>',
  ];

  if (stateMachine && stateMachine.states?.length) {
    lines.push(`  <nav class="hw-state-graph" data-states="${escapeHtmlAttr(stateMachine.states.map(s => s.id).join(','))}">`);
    for (const st of stateMachine.states) {
      lines.push(`    <button type="button" class="hw-state-pill" data-state-id="${escapeHtmlAttr(st.id)}" data-category="${escapeHtmlAttr(st.category)}" data-vars="${escapeHtmlAttr(JSON.stringify(st.vars || {}))}">${escapeHtmlAttr(st.label)}</button>`);
    }
    lines.push('  </nav>');
  }

  for (const scene of themeDOM.scenes) {
    const comps = themeDOM.components.filter(c => c.scene === scene && c.semanticRole !== 'hidden_utility');
    lines.push(`  <section class="hw-scene" data-scene="${escapeHtmlAttr(scene)}">`);

    const bgs = comps.filter(c => c.semanticRole === 'background');
    const gestures = comps.filter(c => c.semanticRole === 'fullscreen_gesture');
    const primary = comps.filter(c => c.layoutPolicy?.pane === 'left_primary');
    const content = comps.filter(c => c.layoutPolicy?.pane === 'right_content' || c.layoutPolicy?.pane === 'modal');
    const dock = comps.filter(c => c.semanticRole.startsWith('dock_'));

    for (const bg of bgs) {
      lines.push(`    <div id="${bg.id}" class="hw-background" data-role="background" data-variant="${escapeHtmlAttr(bg.variantKey || 'default')}" data-nodes="${bg.memberIds.join(',')}"></div>`);
    }

    if (primary.length) {
      lines.push('    <header class="hw-pane hw-primary-pane" data-pane="left_primary">');
      lines.push(...renderPaneWithContainers(primary, containerTree, scene, hitByComp, stateIdsByComp, '      '));
      lines.push('    </header>');
    }

    if (content.length) {
      lines.push('    <main class="hw-pane hw-content-pane" data-pane="right_content">');
      lines.push(...renderPaneWithContainers(content, containerTree, scene, hitByComp, stateIdsByComp, '      '));
      lines.push('    </main>');
    }

    if (dock.length) {
      lines.push('    <footer class="hw-pane hw-dock-bar" data-pane="dock">');
      lines.push(...renderPaneWithContainers(dock, containerTree, scene, hitByComp, stateIdsByComp, '      '));
      lines.push('    </footer>');
    }

    for (const g of gestures) {
      const hits = hitByComp.get(g.id) || [];
      const gestStr = hits.flatMap(h => h.gestureTypes).join(',') || 'swipe_unlock';
      lines.push(`    <div id="${g.id}" class="hw-fullscreen-gesture" data-role="fullscreen_gesture" data-gestures="${escapeHtmlAttr(gestStr)}" data-nodes="${g.memberIds.join(',')}"></div>`);
    }

    lines.push('  </section>');
  }

  if (uiComponents && ((uiComponents.drawers?.length || 0) > 0 || (uiComponents.imageSwitchers?.length || 0) > 0)) {
    lines.push(`  <section class="hw-ui-components" data-drawers="${uiComponents.drawers.length}" data-image-switchers="${uiComponents.imageSwitchers.length}">`);
    for (const d of uiComponents.drawers || []) {
      lines.push(
        `    <hw-drawer id="${escapeHtmlAttr(d.id)}" drawer-id="${escapeHtmlAttr(d.id)}" state-var="${escapeHtmlAttr(d.stateVar)}" direction="${escapeHtmlAttr(d.direction)}" label="${escapeHtmlAttr(d.label)}" data-kind="${escapeHtmlAttr(d.kind)}" data-nodes="${escapeHtmlAttr(d.memberNodeIds.join(','))}"></hw-drawer>`
      );
    }
    for (const sw of uiComponents.imageSwitchers || []) {
      const box = sw.origBBox || { x: 0, y: 0, w: 0, h: 0 };
      lines.push(
        `    <hw-image-switcher id="${escapeHtmlAttr(sw.id)}" switcher-id="${escapeHtmlAttr(sw.id)}" kind="${escapeHtmlAttr(sw.kind)}" state-var="${escapeHtmlAttr(sw.stateVar)}" active-value="${escapeHtmlAttr(sw.initialValue)}" transition="${escapeHtmlAttr(sw.transition)}" style="left:${fmt(box.x)}px;top:${fmt(box.y)}px;width:${fmt(box.w)}px;height:${fmt(box.h)}px;">`
      );
      for (const sl of sw.slots || []) {
        const activeAttr = String(sl.value) === String(sw.initialValue) ? ' data-active="true"' : ' data-active="false"';
        lines.push(
          `      <figure class="hw-slot" data-val="${escapeHtmlAttr(sl.value)}"${activeAttr}><img src="./assets/${escapeHtmlAttr(sl.asset)}" alt="${escapeHtmlAttr(sw.stateVar)}=${escapeHtmlAttr(sl.value)}" /></figure>`
        );
      }
      lines.push('    </hw-image-switcher>');
    }
    lines.push('  </section>');
  }

  lines.push('</body>', '</html>', '');
  return lines.join('\n');
}

function renderPaneWithContainers(paneComps, containerTree, scene, hitByComp, stateIdsByComp, indent) {
  if (!containerTree || !containerTree.byScene?.[scene]) {
    return paneComps.map(c => renderWidget(c, hitByComp, indent, stateIdsByComp));
  }
  const paneCompSet = new Set(paneComps.map(c => c.id));
  const compById = new Map(paneComps.map(c => [c.id, c]));
  const rendered = new Set();
  const out = [];

  for (const mc of containerTree.byScene[scene].containers || []) {
    const inside = mc.childIds.filter(id => paneCompSet.has(id));
    if (inside.length === 0) continue;
    const mcAttrs = [
      `id="${escapeHtmlAttr(mc.id)}"`,
      `class="hw-container layout-${escapeHtmlAttr(mc.intraLayout)}"`,
      `data-container-kind="${escapeHtmlAttr(mc.kind)}"`,
      `data-container-role="${escapeHtmlAttr(mc.semanticRole)}"`,
      `data-intra-layout="${escapeHtmlAttr(mc.intraLayout)}"`,
      `data-align="${escapeHtmlAttr(mc.align || 'center')}"`,
      `data-justify="${escapeHtmlAttr(mc.justify || 'pack')}"`,
      `data-children="${escapeHtmlAttr(inside.join(','))}"`,
    ];
    if (mc.gap !== null && mc.gap !== undefined) mcAttrs.push(`data-gap="${mc.gap}"`);
    out.push(`${indent}<div ${mcAttrs.join(' ')}>`);
    for (const cid of inside) {
      rendered.add(cid);
      out.push(renderWidget(compById.get(cid), hitByComp, indent + '  ', stateIdsByComp));
    }
    out.push(`${indent}</div>`);
  }

  for (const c of paneComps) {
    if (!rendered.has(c.id)) {
      out.push(renderWidget(c, hitByComp, indent, stateIdsByComp));
    }
  }
  return out;
}

function renderWidget(c, hitByComp, indent, stateIdsByComp = null) {
  const hits = hitByComp.get(c.id) || [];
  const bboxStr = `${fmt(c.bbox.x)},${fmt(c.bbox.y)},${fmt(c.bbox.w)},${fmt(c.bbox.h)}`;
  const stateIds = stateIdsByComp?.get(c.id);
  const attrs = [
    `id="${c.id}"`,
    `class="hw-widget role-${escapeHtmlAttr(c.semanticRole)}"`,
    `data-role="${escapeHtmlAttr(c.semanticRole)}"`,
    `data-anchor="${escapeHtmlAttr(c.layoutPolicy?.anchor || 'center')}"`,
    `data-orig-bbox="${bboxStr}"`,
    `data-nodes="${c.memberIds.join(',')}"`,
  ];
  if (c.variantKey) attrs.push(`data-variant="${escapeHtmlAttr(c.variantKey)}"`);
  if (c.boundButtonIds?.length) attrs.push(`data-buttons="${c.boundButtonIds.join(',')}"`);
  if (stateIds?.length) attrs.push(`data-state-ids="${escapeHtmlAttr(stateIds.join(','))}"`);

  if (hits.length === 0) {
    return `${indent}<article ${attrs.join(' ')}></article>`;
  }

  const inner = hits.map(ht => {
    const actions = ht.actions.map(a => `${a.type}${a.target ? ':' + a.target : ''}`).join(';');
    return `${indent}  <hit-target data-node="${ht.nodeId}" data-gestures="${escapeHtmlAttr(ht.gestureTypes.join(','))}" data-actions="${escapeHtmlAttr(actions)}"></hit-target>`;
  });
  return [`${indent}<article ${attrs.join(' ')}>`, ...inner, `${indent}</article>`].join('\n');
}

/**
 * Emit CSS stylesheet with :root design tokens, 5-breakpoint @media layout rules, and per-state response variables.
 */
export function emitThemeCss(themeDOM, deviceSolutions = [], stateAnalysis = null, uiComponents = null, containerTree = null) {
  const { baseW, baseH } = themeDOM.canvas;
  const lines = [
    '/* HwFlex Responsive Theme Stylesheet (5 Huawei Form-Factor Breakpoints) */',
    ':root {',
    `  --base-canvas-w: ${baseW}px;`,
    `  --base-canvas-h: ${baseH}px;`,
    '  --safe-x: 24px;',
    '  --safe-y: 24px;',
    '  --min-touch-size: 52px;',
    '  --hinge-clearance: 22px;',
    '}',
    '',
    '.hw-scene { position: relative; width: 100vw; height: 100vh; overflow: hidden; }',
    '.hw-background { position: absolute; inset: 0; object-fit: cover; }',
    '.hw-widget { position: absolute; transform-origin: top left; }',
    '.hw-fullscreen-gesture { position: absolute; inset: 0; touch-action: pan-y pan-x; }',
    '',
  ];

  const mediaQueries = {
    portrait_tall: '@media (max-aspect-ratio: 56/100)',
    wide_portrait: '@media (min-aspect-ratio: 56/100) and (max-aspect-ratio: 78/100)',
    square_fold: '@media (min-aspect-ratio: 78/100) and (max-aspect-ratio: 115/100)',
    landscape_tablet: '@media (min-aspect-ratio: 115/100) and (max-aspect-ratio: 185/100)',
    landscape_wide: '@media (min-aspect-ratio: 185/100)',
  };

  for (const sol of deviceSolutions) {
    const dev = sol.device;
    const mq = mediaQueries[dev.breakpoint] || `@media /* ${dev.breakpoint} */`;
    lines.push(`/* Device: ${dev.label} (${dev.w}×${dev.h}) */`);
    lines.push(`${mq} {`);
    lines.push(`  .hw-scene { --vp-w: ${dev.w}px; --vp-h: ${dev.h}px; }`);

    if (dev.breakpoint === 'landscape_tablet' || dev.breakpoint === 'landscape_wide') {
      lines.push('  .hw-primary-pane { display: flex; flex-direction: column; justify-content: center; width: 44%; }');
      lines.push('  .hw-content-pane { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; width: 52%; }');
      lines.push('  .hw-dock-bar { display: flex; justify-content: space-between; padding: 0 var(--safe-x); }');
    } else if (dev.breakpoint === 'square_fold' && dev.hinges?.length) {
      lines.push('  .hw-scene { --hinge-x: 540px; }');
      lines.push('  .hw-widget { avoid-hinge: true; }');
    }

    const fgComps = themeDOM.components.filter(c => c.scene === 'main' && c.semanticRole !== 'background' && c.semanticRole !== 'fullscreen_gesture' && c.semanticRole !== 'hidden_utility');
    for (const c of fgComps.slice(0, 16)) {
      const t = sol.transforms.get(c.id);
      if (!t) continue;
      lines.push(`  #${c.id} { left: ${fmt(t.tx)}px; top: ${fmt(t.ty)}px; width: ${fmt(c.bbox.w * t.sx)}px; height: ${fmt(c.bbox.h * t.sy)}px; /* scale=${fmt(t.sx)} */ }`);
    }
    lines.push('}', '');
  }

  if (stateAnalysis && stateAnalysis.perStateSummary?.length) {
    lines.push('/* Auto-Discovered Interactive State CSS Tokens */');
    for (const s of stateAnalysis.perStateSummary) {
      lines.push(`[data-state="${s.stateId}"] {`);
      lines.push(`  --visible-comps: ${s.avgVisibleComponents};`);
      lines.push(`  --avg-scale: ${s.avgScaleAcrossDevices};`);
      lines.push(`  --peak-fg-coverage: ${s.peakFgCoverage};`);
      lines.push(`  --state-category: "${s.category}";`);
      lines.push('}', '');
    }
  }

  if (containerTree && containerTree.containers?.length) {
    const alignMap = { start: 'flex-start', end: 'flex-end', center: 'center', top: 'flex-start', bottom: 'flex-end', left: 'flex-start', right: 'flex-end' };
    const justifyMap = { pack: 'flex-start', center: 'center', space_between: 'space-between', space_evenly: 'space-evenly' };
    lines.push('/* Two-Level Hierarchical Macro Containers & Intra-Container Layout Rules */');
    lines.push('.hw-container { position: relative; box-sizing: border-box; }');
    lines.push('.layout-flex_col { display: flex; flex-direction: column; }');
    lines.push('.layout-flex_row { display: flex; flex-direction: row; flex-wrap: nowrap; }');
    lines.push('.layout-grid_even { display: grid; place-items: center; }');
    lines.push('.layout-center_contain { display: flex; align-items: center; justify-content: center; }');
    lines.push('');
    for (const mc of containerTree.containers) {
      if ((mc.childIds?.length || 0) < 2 && !mc.explicitOverride) continue;
      const disp = mc.intraLayout === 'grid_even' ? 'grid' : (mc.intraLayout === 'proportional' || mc.intraLayout === 'align_edges' ? 'block' : 'flex');
      const decls = [`display: ${disp};`];
      if (disp === 'flex') {
        if (mc.intraLayout === 'flex_col') decls.push('flex-direction: column;');
        if (mc.intraLayout === 'flex_row') decls.push('flex-direction: row;');
        decls.push(`align-items: ${alignMap[mc.align] || 'center'};`);
        decls.push(`justify-content: ${justifyMap[mc.justify] || 'flex-start'};`);
      } else if (disp === 'grid') {
        decls.push(`grid-template-columns: repeat(${mc.cols || 2}, minmax(0, 1fr));`);
      }
      if (mc.gap !== null && mc.gap !== undefined) decls.push(`gap: ${fmt(mc.gap)}px;`);
      if (mc.padding) decls.push(`padding: ${fmt(mc.padding)}px;`);
      lines.push(`#${mc.id} { ${decls.join(' ')} /* ${mc.label} */ }`);
    }
    lines.push('');
  }

  if (uiComponents || true) {
    lines.push(HW_COMPONENTS_CSS);
  }

  return lines.join('\n');
}

/**
 * Lightweight CSS override parser: parses `#comp_id { prop: val; ... }` blocks into a Map<compId, object>.
 * Built-in solvers consume min-scale and max-scale. The remaining rules are available to JS plugins.
 */
export function parseCssOverrides(cssText) {
  const overrides = new Map();
  if (!cssText || typeof cssText !== 'string') return overrides;

  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleRegex = /#([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = ruleRegex.exec(cleaned)) !== null) {
    const id = m[1];
    const body = m[2];
    const props = overrides.get(id) || {};
    for (const decl of body.split(';')) {
      const colon = decl.indexOf(':');
      if (colon <= 0) {
        if (decl.trim()) throw new Error(`Invalid CSS declaration for ${id}: ${decl.trim()}`);
        continue;
      }
      const key = decl.slice(0, colon).trim().toLowerCase();
      const val = decl.slice(colon + 1).trim();
      if (!val) throw new Error(`Missing CSS value for ${id}.${key}`);
      if (key === 'order' || key === 'max-scale' || key === 'min-scale') {
        const num = Number(val);
        if (!Number.isFinite(num) || (key !== 'order' && num <= 0)) throw new Error(`Invalid CSS value for ${id}.${key}: ${val}`);
        props[key] = num;
      } else if (key === 'avoid-hinge') {
        if (!['true', 'false', '1', '0'].includes(val)) throw new Error(`Invalid avoid-hinge value for ${id}: ${val}`);
        props.avoidHinge = val === 'true' || val === '1';
      } else if (key === 'grid-column') {
        if (!['left', 'right', 'full'].includes(val)) throw new Error(`Invalid grid-column for ${id}: ${val}`);
        props.gridColumn = val;
      } else if (key === 'hidden-on') {
        props.hiddenOn = val.split(/[\s,]+/).filter(Boolean);
      } else throw new Error(`Unknown CSS property for ${id}: ${key}`);
    }
    overrides.set(id, props);
  }
  if (cleaned.replace(ruleRegex, '').trim()) throw new Error('CSS overrides must use #component_id { property: value; } rules');
  return overrides;
}
