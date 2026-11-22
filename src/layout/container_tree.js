/**
 * Hierarchical Parent-Child Container Tree & Intra-Container Layout Solver.
 *
 * Implements Two-Level Responsive Layout Architecture:
 * - Level 1 (Macro Container Layout): Groups fine-grained ThemeDOM components into
 *   semantic parent containers (header_cluster, dock_bar, widget_row, widget_grid,
 *   overlay_composite, custom merged containers, or singleton wrappers) so layout
 *   algorithms position macro blocks cleanly across phones, foldables, and tablets.
 * - Level 2 (Intra-Container Layout): Adapts children inside each container's allocated
 *   targetBox using alignment, centering, equal spacing, grid, or proportional scaling:
 *   `proportional` | `flex_col` | `flex_row` | `grid_even` | `center_contain` | `align_edges`.
 */

import { isFullScreenNode } from '../ir/transpiler.js';

export const INTRA_LAYOUT_MODES = [
  'proportional',
  'flex_col',
  'flex_row',
  'grid_even',
  'center_contain',
  'align_edges',
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function boxesOverlapArea(a, b) {
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
  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

function inferHorizontalAlign(children, unionBox) {
  if (children.length <= 1) return 'center';
  const leftDiff = Math.max(...children.map(c => Math.abs(c.bbox.x - unionBox.x)));
  const rightDiff = Math.max(...children.map(c => Math.abs((c.bbox.x + c.bbox.w) - (unionBox.x + unionBox.w))));
  const ucx = unionBox.x + unionBox.w / 2;
  const centerDiff = Math.max(...children.map(c => Math.abs((c.bbox.x + c.bbox.w / 2) - ucx)));
  if (centerDiff <= leftDiff && centerDiff <= rightDiff) return 'center';
  if (leftDiff <= rightDiff) return 'start';
  return 'end';
}

function makeMacroComponentView(container) {
  const firstChild = container.children[0];
  let semanticRole = container.semanticRole;
  if (container.kind === 'dock_bar') {
    const roles = new Set(container.children.map(c => c.semanticRole));
    if (roles.size === 1) semanticRole = [...roles][0];
    else semanticRole = 'dock_center';
  }
  const pane = container.pane || firstChild?.layoutPolicy?.pane || 'right_content';
  const preserveAspect = container.children.every(c => c.layoutPolicy?.preserveAspect !== false);
  return {
    id: container.id,
    scene: container.scene,
    semanticRole,
    variantKey: container.variantKey ?? null,
    bbox: { ...container.bbox },
    layoutPolicy: {
      pane,
      anchor: firstChild?.layoutPolicy?.anchor || 'center',
      preserveAspect,
      focalY: firstChild?.layoutPolicy?.focalY ?? 0.5,
    },
    memberIds: container.children.flatMap(c => c.memberIds || []),
    boundButtonIds: container.children.flatMap(c => c.boundButtonIds || []),
    childIds: [...container.childIds],
  };
}

function clusterSameVariantOverlaps(comps, threshold = 0.35) {
  const n = comps.length;
  const visited = new Array(n).fill(false);
  const groups = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const queue = [i];
    visited[i] = true;
    const group = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      group.push(comps[cur]);
      for (let j = 0; j < n; j++) {
        if (visited[j]) continue;
        if ((comps[cur].variantKey || null) !== (comps[j].variantKey || null)) continue;
        const a = comps[cur].bbox;
        const b = comps[j].bbox;
        const inter = boxesOverlapArea(a, b);
        const minA = Math.max(1, Math.min(a.w * a.h, b.w * b.h));
        if (inter / minA >= threshold) {
          visited[j] = true;
          queue.push(j);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Build hierarchical parent-child ContainerTree for a ThemeDOM.
 */
export function buildContainerTree(themeDOM, mergeConfig = null) {
  const { baseW, baseH } = themeDOM.canvas;
  const allFg = themeDOM.components.filter(
    c => !isFullScreenNode(c) && c.semanticRole !== 'hidden_utility' && c.semanticRole !== 'offscreen_ambient'
  );
  const compById = new Map(allFg.map(c => [c.id, c]));
  for (const c of allFg) {
    if (c.stableKey) compById.set(c.stableKey, c);
  }
  const overrides = mergeConfig?.overrides || {};
  const customGroups = Array.isArray(mergeConfig?.groups) ? mergeConfig.groups : [];

  const containers = [];
  const childToContainer = {};
  const byScene = {};
  let seq = 1;

  for (const scene of themeDOM.scenes) {
    const scComps = allFg.filter(c => c.scene === scene);
    const assigned = new Set();
    const scContainers = [];

    const registerContainer = (spec) => {
      const id = spec.id || `mc_${seq++}`;
      const ov = overrides[id] || {};
      const unionBox = bboxUnion(spec.children.map(c => c.bbox));
      const container = {
        id,
        scene,
        kind: spec.kind,
        label: ov.label || spec.label,
        semanticRole: spec.semanticRole,
        pane: spec.pane,
        variantKey: spec.variantKey ?? null,
        isCustomMerged: Boolean(spec.isCustomMerged),
        explicitOverride: Boolean(Object.keys(ov).length > 0 || spec.isCustomMerged),
        bbox: {
          x: Math.round(unionBox.x * 10) / 10,
          y: Math.round(unionBox.y * 10) / 10,
          w: Math.round(unionBox.w * 10) / 10,
          h: Math.round(unionBox.h * 10) / 10,
        },
        intraLayout: INTRA_LAYOUT_MODES.includes(ov.intraLayout) ? ov.intraLayout : spec.intraLayout,
        align: ov.align ?? spec.align ?? 'center',
        justify: ov.justify ?? spec.justify ?? 'pack',
        gap: ov.gap !== undefined ? Number(ov.gap) : (spec.gap ?? null),
        padding: ov.padding !== undefined ? Number(ov.padding) : (spec.padding ?? 0),
        cols: ov.cols !== undefined ? Number(ov.cols) : (spec.cols ?? null),
        childIds: spec.children.map(c => c.id),
        children: spec.children,
      };
      container.macroComponent = makeMacroComponentView(container);

      for (const ch of spec.children) {
        assigned.add(ch.id);
        childToContainer[ch.id] = id;
      }
      scContainers.push(container);
      containers.push(container);
    };

    // Priority 1: Explicit user custom merged groups
    for (const grp of customGroups) {
      if (grp.scene && grp.scene !== scene) continue;
      const picked = [...new Set((grp.childIds || [])
        .map(id => compById.get(id))
        .filter(c => c && c.scene === scene && !assigned.has(c.id)))];
      if (picked.length === 0) continue;
      const firstPane = picked[0].layoutPolicy?.pane || 'right_content';
      registerContainer({
        id: grp.id || `mc_custom_${seq++}`,
        kind: 'custom_group',
        label: grp.label || `自定义合并容器 (${picked.length})`,
        semanticRole: grp.semanticRole || picked[0].semanticRole || 'widget_card',
        pane: grp.pane || firstPane,
        variantKey: picked.every(c => (c.variantKey || null) === (picked[0].variantKey || null))
          ? (picked[0].variantKey || null)
          : null,
        isCustomMerged: true,
        intraLayout: grp.intraLayout || (picked.length === 1 ? 'center_contain' : 'flex_col'),
        align: grp.align || 'center',
        justify: grp.justify || 'space_evenly',
        gap: grp.gap ?? null,
        padding: grp.padding ?? 0,
        cols: grp.cols ?? null,
        children: picked,
      });
    }

    // Priority 2: Bottom Dock Bar (dock_left / dock_center / dock_right sharing variantKey)
    const unassignedDocks = scComps.filter(c => !assigned.has(c.id) && c.semanticRole.startsWith('dock_'));
    const docksByVar = new Map();
    for (const d of unassignedDocks) {
      const vk = d.variantKey || '__default__';
      if (!docksByVar.has(vk)) docksByVar.set(vk, []);
      docksByVar.get(vk).push(d);
    }
    for (const [vk, list] of docksByVar.entries()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => a.bbox.x - b.bbox.x);
      let hasHorizontalOverlap = false;
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          if (boxesOverlapArea(sorted[i].bbox, sorted[j].bbox) > 1) hasHorizontalOverlap = true;
        }
      }
      const union = bboxUnion(sorted.map(c => c.bbox));
      if (hasHorizontalOverlap || union.w < baseW * 0.45) continue;
      const roles = new Set(sorted.map(c => c.semanticRole));
      const hasLR = roles.has('dock_left') && roles.has('dock_right') && sorted.length === 2;
      registerContainer({
        kind: 'dock_bar',
        label: `底部快捷栏 (${sorted.length})`,
        semanticRole: 'dock_center',
        pane: 'dock',
        variantKey: vk === '__default__' ? null : vk,
        intraLayout: 'flex_row',
        align: 'center',
        justify: hasLR ? 'space_between' : 'space_evenly',
        gap: null,
        children: sorted,
      });
    }

    // Priority 3: Header Info Cluster (clock + date + weather sharing variantKey & spatially contiguous)
    const unassignedHeader = scComps.filter(
      c => !assigned.has(c.id) && (c.semanticRole === 'clock' || c.semanticRole === 'date' || c.semanticRole === 'weather')
    );
    const headerByVar = new Map();
    for (const h of unassignedHeader) {
      const vk = h.variantKey || '__default__';
      if (!headerByVar.has(vk)) headerByVar.set(vk, []);
      headerByVar.get(vk).push(h);
    }
    for (const [vk, list] of headerByVar.entries()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
      // Cluster vertically contiguous items (gap <= baseH * 0.14)
      const cluster = [sorted[0]];
      let curBox = { ...sorted[0].bbox };
      for (let i = 1; i < sorted.length; i++) {
        const cand = sorted[i];
        const vGap = cand.bbox.y - (curBox.y + curBox.h);
        if (vGap <= baseH * 0.14) {
          cluster.push(cand);
          curBox = bboxUnion([curBox, cand.bbox]);
        }
      }
      if (cluster.length >= 2) {
        let hasHeavyOverlap = false;
        for (let i = 0; i < cluster.length; i++) {
          for (let j = i + 1; j < cluster.length; j++) {
            const inter = boxesOverlapArea(cluster[i].bbox, cluster[j].bbox);
            const minA = Math.max(1, Math.min(cluster[i].bbox.w * cluster[i].bbox.h, cluster[j].bbox.w * cluster[j].bbox.h));
            if (inter / minA > 0.20) hasHeavyOverlap = true;
          }
        }
        const union = bboxUnion(cluster.map(c => c.bbox));
        registerContainer({
          kind: 'header_cluster',
          label: `锁屏时间信息组 (${cluster.length})`,
          semanticRole: 'clock',
          pane: 'left_primary',
          variantKey: vk === '__default__' ? null : vk,
          intraLayout: hasHeavyOverlap ? 'proportional' : 'flex_col',
          align: inferHorizontalAlign(cluster, union),
          justify: 'pack',
          gap: null,
          children: cluster,
        });
      }
    }

    // Priority 4: Intentionally overlapping composite elements sharing same pane & variantKey
    const remForOverlap = scComps.filter(c => !assigned.has(c.id));
    for (const grp of clusterSameVariantOverlaps(remForOverlap, 0.35)) {
      if (grp.length < 2) continue;
      const panes = new Set(grp.map(c => c.layoutPolicy?.pane || 'right_content'));
      if (panes.size > 1) continue;
      const primary = grp.find(c => c.semanticRole === 'hero') || grp.find(c => c.semanticRole === 'widget_card') || grp[0];
      registerContainer({
        kind: 'overlay_composite',
        label: `叠加复合组件 (${grp.length})`,
        semanticRole: primary.semanticRole,
        pane: primary.layoutPolicy?.pane || 'right_content',
        variantKey: primary.variantKey ?? null,
        intraLayout: 'proportional',
        align: 'center',
        justify: 'center',
        children: grp,
      });
    }

    // Priority 5: Non-overlapping aligned widget rows / uniform grids
    const remWidgets = scComps.filter(
      c => !assigned.has(c.id) && (c.semanticRole === 'widget_card' || c.semanticRole === 'hero' || c.semanticRole === 'decoration')
    );
    const widgetByVar = new Map();
    for (const w of remWidgets) {
      const vk = w.variantKey || '__default__';
      if (!widgetByVar.has(vk)) widgetByVar.set(vk, []);
      widgetByVar.get(vk).push(w);
    }

    for (const [vk, list] of widgetByVar.entries()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
      const rows = [];
      for (const item of sorted) {
        const icy = item.bbox.y + item.bbox.h / 2;
        let placedRow = null;
        for (const r of rows) {
          const rep = r[r.length - 1];
          const rcy = rep.bbox.y + rep.bbox.h / 2;
          const minH = Math.min(rep.bbox.h, item.bbox.h);
          const maxH = Math.max(rep.bbox.h, item.bbox.h);
          const hGap = item.bbox.x - (rep.bbox.x + rep.bbox.w);
          const inter = boxesOverlapArea(rep.bbox, item.bbox);
          if (
            inter <= 1 &&
            maxH / Math.max(1, minH) <= 1.8 &&
            Math.abs(icy - rcy) <= Math.max(20, minH * 0.45) &&
            hGap >= -8 &&
            hGap <= baseW * 0.14
          ) {
            placedRow = r;
            break;
          }
        }
        if (placedRow) placedRow.push(item);
        else rows.push([item]);
      }

      const validRows = rows.filter(r => r.length >= 2);
      if (validRows.length >= 2 && validRows.every(r => r.length === validRows[0].length)) {
        // Check if stacked vertically as a regular grid
        const rowBoxes = validRows.map(r => bboxUnion(r.map(c => c.bbox)));
        let contiguous = true;
        for (let i = 1; i < rowBoxes.length; i++) {
          if (rowBoxes[i].y - (rowBoxes[i - 1].y + rowBoxes[i - 1].h) > baseH * 0.10) {
            contiguous = false;
            break;
          }
        }
        if (contiguous) {
          const allGridItems = validRows.flat();
          registerContainer({
            kind: 'widget_grid',
            label: `网格组件 (${validRows.length}×${validRows[0].length})`,
            semanticRole: 'widget_card',
            pane: 'right_content',
            variantKey: vk === '__default__' ? null : vk,
            intraLayout: 'grid_even',
            align: 'center',
            justify: 'space_evenly',
            cols: validRows[0].length,
            children: allGridItems,
          });
          continue;
        }
      }

      for (const r of validRows) {
        const sortedRow = [...r].sort((a, b) => a.bbox.x - b.bbox.x);
        registerContainer({
          kind: 'widget_row',
          label: `横向等距组 (${sortedRow.length})`,
          semanticRole: sortedRow[0].semanticRole || 'widget_card',
          pane: sortedRow[0].layoutPolicy?.pane || 'right_content',
          variantKey: vk === '__default__' ? null : vk,
          intraLayout: 'flex_row',
          align: 'center',
          justify: 'space_evenly',
          children: sortedRow,
        });
      }
    }

    // Priority 6: Remaining unassigned components become singleton 1-child Macro Containers
    for (const c of scComps) {
      if (assigned.has(c.id)) continue;
      registerContainer({
        kind: 'singleton',
        label: `${c.semanticRole} (${c.id})`,
        semanticRole: c.semanticRole,
        pane: c.layoutPolicy?.pane || 'right_content',
        variantKey: c.variantKey ?? null,
        intraLayout: 'center_contain',
        align: 'center',
        justify: 'center',
        children: [c],
      });
    }

    byScene[scene] = {
      scene,
      containers: scContainers,
      macroComponents: scContainers.map(c => c.macroComponent),
    };
  }

  const totalChildren = allFg.length;
  const totalMacroContainers = containers.length;
  const mergedContainerCount = containers.filter(c => c.children.length >= 2).length;
  const compressionRatio = totalChildren > 0
    ? Math.round((totalMacroContainers / totalChildren) * 1000) / 1000
    : 1;

  return {
    themeName: themeDOM.themeName,
    summary: {
      totalChildren,
      totalMacroContainers,
      mergedContainerCount,
      compressionRatio,
    },
    byScene,
    containers: containers.map(({ macroComponent, children, ...rest }) => rest),
    childToContainer,
  };
}

function makeChildPlacement(c, x, y, s, parentContainerId, intraLayout, breakpoint) {
  const w = Math.max(1, c.bbox.w) * s;
  const h = Math.max(1, c.bbox.h) * s;
  return {
    sx: s,
    sy: s,
    tx: x,
    ty: y,
    targetBBox: { x, y, w, h },
    mode: `hierarchical:${intraLayout}`,
    breakpoint,
    parentContainerId,
    intraLayout,
  };
}

function avoidChildHinge(x, w, inner, hinges, panelW) {
  if (!hinges?.length || w >= panelW * 0.85) return x;
  let curX = x;
  for (const hg of hinges) {
    const halfGap = (hg.width || 32) / 2 + 2;
    if (curX < hg.pos + halfGap && curX + w > hg.pos - halfGap) {
      const cx = curX + w / 2;
      if (cx <= hg.pos && hg.pos - halfGap - w >= inner.x) {
        curX = hg.pos - halfGap - w;
      } else if (hg.pos + halfGap + w <= inner.x + inner.w) {
        curX = hg.pos + halfGap;
      } else if (hg.pos - halfGap - w >= inner.x) {
        curX = hg.pos - halfGap - w;
      }
    }
  }
  return clamp(curX, inner.x, Math.max(inner.x, inner.x + inner.w - w));
}

/**
 * Level-2 Solver: Compute exact transforms for all children inside a container's targetBox.
 * Guarantees aspect ratio preservation (sx === sy) and hinge clearance.
 */
export function solveIntraContainerLayout(container, targetBox, childComps, deviceProfile, options = {}) {
  const out = new Map();
  if (!childComps || childComps.length === 0) return out;

  const breakpoint = deviceProfile?.breakpoint || 'portrait_tall';
  const hinges = deviceProfile?.hinges || [];
  const vpW = deviceProfile?.w || targetBox.w;
  const panelW = hinges.length > 0 ? vpW / (hinges.length + 1) : vpW;

  const pad = Math.max(0, Number(container.padding) || 0);
  const inner = {
    x: targetBox.x + pad,
    y: targetBox.y + pad,
    w: Math.max(8, targetBox.w - 2 * pad),
    h: Math.max(8, targetBox.h - 2 * pad),
  };

  const origBox = container.bbox || bboxUnion(childComps.map(c => c.bbox));
  const origW = Math.max(1, origBox.w);
  const origH = Math.max(1, origBox.h);

  // Determine effective mode with safety guards
  let mode = container.intraLayout || 'proportional';

  if (childComps.length > 1 && !container.explicitOverride && mode !== 'proportional') {
    let hasIntentionalOverlap = false;
    for (let i = 0; i < childComps.length; i++) {
      for (let j = i + 1; j < childComps.length; j++) {
        const inter = boxesOverlapArea(childComps[i].bbox, childComps[j].bbox);
        const minA = Math.max(1, Math.min(childComps[i].bbox.w * childComps[i].bbox.h, childComps[j].bbox.w * childComps[j].bbox.h));
        if (inter / minA > 0.22) {
          hasIntentionalOverlap = true;
          break;
        }
      }
      if (hasIntentionalOverlap) break;
    }
    if (hasIntentionalOverlap) mode = 'proportional';
  }

  // On portrait-like viewports (portrait_tall & wide_portrait) without explicit override, keep exact proportional layout fidelity
  if (!container.explicitOverride && !options.forceIntra && (breakpoint === 'portrait_tall' || breakpoint === 'wide_portrait') && childComps.length > 1) {
    mode = 'proportional';
  }

  if (childComps.length === 1 || mode === 'center_contain' || mode === 'proportional') {
    const s = clamp(Math.min(inner.w / origW, inner.h / origH), 0.03, 1.5);
    const mappedW = origW * s;
    const mappedH = origH * s;
    const baseOx = inner.x + (inner.w - mappedW) / 2;
    const baseOy = inner.y + (inner.h - mappedH) / 2;
    for (const c of childComps) {
      let cx = baseOx + (c.bbox.x - origBox.x) * s;
      const cy = baseOy + (c.bbox.y - origBox.y) * s;
      cx = avoidChildHinge(cx, Math.max(1, c.bbox.w) * s, inner, hinges, panelW);
      out.set(c.id, makeChildPlacement(c, cx, cy, s, container.id, mode, breakpoint));
    }
    return out;
  }

  if (mode === 'flex_col') {
    const sorted = [...childComps].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    const n = sorted.length;
    const maxChildW = Math.max(...sorted.map(c => Math.max(1, c.bbox.w)));
    const sumChildH = sorted.reduce((acc, c) => acc + Math.max(1, c.bbox.h), 0);

    let origGapSum = 0;
    for (let i = 1; i < n; i++) {
      origGapSum += Math.max(0, sorted[i].bbox.y - (sorted[i - 1].bbox.y + sorted[i - 1].bbox.h));
    }
    const avgOrigGap = n > 1 ? origGapSum / (n - 1) : 0;

    // Fit uniform scale s along width and height
    const baseGap = container.gap !== null && container.gap !== undefined ? container.gap : Math.max(4, Math.min(20, avgOrigGap));
    const tentativeS = Math.min(inner.w / maxChildW, inner.h / Math.max(1, sumChildH + baseGap * (n - 1)));
    const gap = container.gap !== null && container.gap !== undefined
      ? clamp(container.gap, 0, inner.h * 0.25)
      : clamp(avgOrigGap * Math.min(1, tentativeS), 3, Math.max(4, (inner.h - sumChildH * 0.2) / Math.max(1, n)));
    const availH = Math.max(12, inner.h - gap * Math.max(0, n - 1));
    const s = clamp(Math.min(inner.w / maxChildW, availH / Math.max(1, sumChildH), 1.35), 0.03, 1.35);

    const contentH = sumChildH * s;
    const justify = container.justify || 'pack';
    let curY = inner.y;
    let stepGap = gap;
    if (justify === 'center') {
      curY = inner.y + Math.max(0, (inner.h - (contentH + gap * (n - 1))) / 2);
    } else if (justify === 'space_between' && n > 1) {
      stepGap = Math.max(0, (inner.h - contentH) / (n - 1));
    } else if (justify === 'space_evenly') {
      stepGap = Math.max(0, (inner.h - contentH) / (n + 1));
      curY = inner.y + stepGap;
    }

    const align = container.align || 'center';
    for (const c of sorted) {
      const cw = Math.max(1, c.bbox.w) * s;
      const ch = Math.max(1, c.bbox.h) * s;
      let cx = inner.x + (inner.w - cw) / 2;
      if (align === 'start' || align === 'left') cx = inner.x;
      else if (align === 'end' || align === 'right') cx = inner.x + inner.w - cw;
      cx = avoidChildHinge(cx, cw, inner, hinges, panelW);
      out.set(c.id, makeChildPlacement(c, cx, curY, s, container.id, mode, breakpoint));
      curY += ch + stepGap;
    }
    return out;
  }

  if (mode === 'flex_row') {
    const sorted = [...childComps].sort((a, b) => a.bbox.x - b.bbox.x || a.bbox.y - b.bbox.y);
    const n = sorted.length;
    const maxChildH = Math.max(...sorted.map(c => Math.max(1, c.bbox.h)));
    const sumChildW = sorted.reduce((acc, c) => acc + Math.max(1, c.bbox.w), 0);

    let origGapSum = 0;
    for (let i = 1; i < n; i++) {
      origGapSum += Math.max(0, sorted[i].bbox.x - (sorted[i - 1].bbox.x + sorted[i - 1].bbox.w));
    }
    const avgOrigGap = n > 1 ? origGapSum / (n - 1) : 0;
    const gap = container.gap !== null && container.gap !== undefined
      ? clamp(container.gap, 0, inner.w * 0.25)
      : clamp(avgOrigGap * Math.min(1, inner.w / origW), 4, Math.max(6, (inner.w - sumChildW * 0.2) / Math.max(1, n)));
    const availW = Math.max(12, inner.w - gap * Math.max(0, n - 1));
    const s = clamp(Math.min(availW / Math.max(1, sumChildW), inner.h / maxChildH, 1.35), 0.03, 1.35);

    const contentW = sumChildW * s;
    const justify = container.justify || 'space_evenly';
    let curX = inner.x;
    let stepGap = gap;
    if (justify === 'center') {
      curX = inner.x + Math.max(0, (inner.w - (contentW + gap * (n - 1))) / 2);
    } else if (justify === 'space_between' && n > 1) {
      stepGap = Math.max(0, (inner.w - contentW) / (n - 1));
    } else if (justify === 'space_evenly') {
      stepGap = Math.max(0, (inner.w - contentW) / (n + 1));
      curX = inner.x + stepGap;
    }

    const align = container.align || 'center';
    for (const c of sorted) {
      const cw = Math.max(1, c.bbox.w) * s;
      const ch = Math.max(1, c.bbox.h) * s;
      let cy = inner.y + (inner.h - ch) / 2;
      if (align === 'start' || align === 'top') cy = inner.y;
      else if (align === 'end' || align === 'bottom') cy = inner.y + inner.h - ch;
      const safeX = avoidChildHinge(curX, cw, inner, hinges, panelW);
      out.set(c.id, makeChildPlacement(c, safeX, cy, s, container.id, mode, breakpoint));
      curX += cw + stepGap;
    }
    return out;
  }

  if (mode === 'grid_even') {
    const sorted = [...childComps].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    const n = sorted.length;
    const cols = Math.max(1, Math.min(n, Number(container.cols) || Math.ceil(Math.sqrt(n))));
    const rows = Math.ceil(n / cols);
    const gap = container.gap !== null && container.gap !== undefined ? clamp(container.gap, 0, Math.min(inner.w, inner.h) * 0.2) : 8;
    const cellW = Math.max(8, (inner.w - gap * (cols - 1)) / cols);
    const cellH = Math.max(8, (inner.h - gap * (rows - 1)) / rows);

    sorted.forEach((c, idx) => {
      const r = Math.floor(idx / cols);
      const col = idx % cols;
      const s = clamp(Math.min(cellW / Math.max(1, c.bbox.w), cellH / Math.max(1, c.bbox.h), 1.35), 0.03, 1.35);
      const cw = Math.max(1, c.bbox.w) * s;
      const ch = Math.max(1, c.bbox.h) * s;
      const cx0 = inner.x + col * (cellW + gap) + (cellW - cw) / 2;
      const cy0 = inner.y + r * (cellH + gap) + (cellH - ch) / 2;
      const safeX = avoidChildHinge(cx0, cw, inner, hinges, panelW);
      out.set(c.id, makeChildPlacement(c, safeX, cy0, s, container.id, mode, breakpoint));
    });
    return out;
  }

  // align_edges: uniform scale preserving proportional edge anchoring within inner
  const s = clamp(Math.min(inner.w / origW, inner.h / origH), 0.03, 1.35);
  for (const c of childComps) {
    const cw = Math.max(1, c.bbox.w) * s;
    const ch = Math.max(1, c.bbox.h) * s;
    const rx = origW > Math.max(1, c.bbox.w) ? (c.bbox.x - origBox.x) / (origW - c.bbox.w) : 0.5;
    const ry = origH > Math.max(1, c.bbox.h) ? (c.bbox.y - origBox.y) / (origH - c.bbox.h) : 0.5;
    let cx = inner.x + Math.max(0, inner.w - cw) * clamp(rx, 0, 1);
    const cy = inner.y + Math.max(0, inner.h - ch) * clamp(ry, 0, 1);
    cx = avoidChildHinge(cx, cw, inner, hinges, panelW);
    out.set(c.id, makeChildPlacement(c, cx, cy, s, container.id, 'align_edges', breakpoint));
  }
  return out;
}
