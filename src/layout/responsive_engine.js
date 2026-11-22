/**
 * Frontend CSS-Inspired 5-Breakpoint Responsive Layout Engine & Built-in Algorithms.
 *
 * Breakpoints (based on virtual viewport aspect ratio ar = W / H):
 * - portrait_tall:    ar < 0.56          (Phone 20:9 / 19.5:9, Mate XT Single)
 * - wide_portrait:    0.56 <= ar < 0.78  (Pura X 16:10, Pura X MAX, MatePad Portrait, Phone 16:9)
 * - square_fold:      0.78 <= ar < 1.15  (Pura X Cover 1:1, Dual-Fold Mate X6, Tri-Fold Dual)
 * - landscape_tablet: 1.15 <= ar < 1.85  (Pura X Land, Pura X MAX Land, Tri-Fold Triple, MatePad Land)
 * - landscape_wide:   ar >= 1.85         (Phone Ultra-Wide Landscape)
 */

import { areVariantsCompatible } from '../ir/transpiler.js';
import { getDeviceBreakpoint, resolveDeviceProfile } from '../devices/huawei_devices.js';
import { buildContainerTree, solveIntraContainerLayout } from './container_tree.js';
import {
  applyConstraintGuard,
  buildLayoutRequest,
  getAlgorithm,
  isSolverComponent,
  normalizeAlgorithmResponse,
  registerAlgorithm,
} from './algorithm_interface.js';

export function getBreakpoint(w, h) {
  return getDeviceBreakpoint(w, h);
}

function clamp(v, minV, maxV) {
  return Math.max(minV, Math.min(maxV, v));
}

function boxesOverlapArea(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

function layoutDockGroup(dockComps, { baseW, baseH, targetW, targetH, padX, padY, breakpoint, hinges, placements }) {
  if (dockComps.length === 0) return { maxDockH: 0, dockBoxes: [] };

  const leftSlots = groupIntoFlexSlots(dockComps.filter(c => c.semanticRole === 'dock_left').sort((a, b) => a.bbox.x - b.bbox.x));
  const rightSlots = groupIntoFlexSlots(dockComps.filter(c => c.semanticRole === 'dock_right').sort((a, b) => b.bbox.x - a.bbox.x));
  const centerSlots = groupIntoFlexSlots(dockComps.filter(c => c.semanticRole === 'dock_center').sort((a, b) => a.bbox.x - b.bbox.x));

  const isLand = breakpoint === 'landscape_tablet' || breakpoint === 'landscape_wide';
  const maxAllowedH = isLand ? targetH * 0.17 : targetH * 0.14;
  const maxAllowedW = targetW * 0.28;
  const gap = 10;
  let maxDockH = 0;
  const dockBoxes = [];

  const computeSlotScale = (sl) => {
    const sRaw = isLand
      ? Math.min(0.85, maxAllowedH / sl.h, maxAllowedW / sl.w)
      : Math.min(1.05, Math.max(0.65, Math.min(targetW / baseW, targetH / baseH)), maxAllowedH / sl.h, maxAllowedW / sl.w);
    return clamp(sRaw, 0.15, 1.05);
  };

  const placeSlotAt = (sl, xLeft, s) => {
    const slotW = sl.w * s;
    const slotH = sl.h * s;
    maxDockH = Math.max(maxDockH, slotH);

    const rep = sl.items[0];
    const origBottomMargin = Math.max(16, baseH - (rep.bbox.y + rep.bbox.h));
    const bottomMargin = isLand
      ? Math.max(14, Math.min(32, targetH * 0.045))
      : clamp(origBottomMargin * (targetH / baseH), 18, targetH * 0.10);

    const slotTop = targetH - bottomMargin - slotH;
    for (const c of sl.items) {
      const w = c.bbox.w * s;
      const h = c.bbox.h * s;
      const x = xLeft + (slotW - w) / 2;
      const y = slotTop + (slotH - h) / 2;
      const box = { x, y, w, h, sx: s, sy: s };
      placements.set(c.id, box);
      dockBoxes.push(box);
    }
    return slotW;
  };

  const sortedH = hinges.length === 2 ? [...hinges].sort((a, b) => a.pos - b.pos) : [];
  const leftPanelRight = sortedH.length === 2 ? sortedH[0].pos - (sortedH[0].width || 32) / 2 : null;
  const midPanelLeft = sortedH.length === 2 ? sortedH[0].pos + (sortedH[0].width || 32) / 2 : null;
  const midPanelRight = sortedH.length === 2 ? sortedH[1].pos - (sortedH[1].width || 32) / 2 : null;
  const rightPanelLeft = sortedH.length === 2 ? sortedH[1].pos + (sortedH[1].width || 32) / 2 : null;

  const fitRow = (slots, availW) => {
    const items = slots.map(sl => {
      const s = computeSlotScale(sl);
      return { sl, s, w: sl.w * s };
    });
    if (availW != null && items.length > 0) {
      const gaps = gap * Math.max(0, items.length - 1);
      const rawSum = items.reduce((acc, it) => acc + it.w, 0);
      if (rawSum + gaps > availW) {
        const factor = Math.max(0.15, (availW - gaps) / Math.max(1, rawSum));
        for (const it of items) {
          it.s *= factor;
          it.w = it.sl.w * it.s;
        }
      }
    }
    return items;
  };

  let curLeftX = isLand ? Math.max(padX, targetW * 0.035) : padX;
  const leftItems = fitRow(leftSlots, sortedH.length === 2 ? Math.max(40, leftPanelRight - curLeftX) : null);
  for (const it of leftItems) {
    const w = placeSlotAt(it.sl, curLeftX, it.s);
    curLeftX += w + gap;
  }

  let curRightEdge = isLand ? targetW - Math.max(padX, targetW * 0.035) : targetW - padX;
  const rightItems = fitRow(rightSlots, sortedH.length === 2 ? Math.max(40, curRightEdge - rightPanelLeft) : null);
  for (const it of rightItems) {
    placeSlotAt(it.sl, curRightEdge - it.w, it.s);
    curRightEdge -= it.w + gap;
  }

  if (centerSlots.length > 0) {
    const centerScaled = fitRow(centerSlots, sortedH.length === 2 ? Math.max(40, midPanelRight - midPanelLeft) : null);
    const totalCenterW = centerScaled.reduce((acc, it) => acc + it.w, 0) + gap * Math.max(0, centerScaled.length - 1);
    let cx = sortedH.length === 2
      ? midPanelLeft + Math.max(0, (midPanelRight - midPanelLeft - totalCenterW) / 2)
      : clamp((targetW - totalCenterW) / 2, curLeftX, Math.max(curLeftX, curRightEdge - totalCenterW));
    // Avoid centering directly on a single dual-fold center hinge (x = 540) if compact
    if (hinges.length === 1 && totalCenterW < targetW * 0.40) {
      const hg = hinges[0];
      const halfG = (hg.width || 32) / 2;
      if (cx < hg.pos + halfG && cx + totalCenterW > hg.pos - halfG) {
        if (hg.pos - halfG - totalCenterW >= curLeftX) cx = hg.pos - halfG - totalCenterW;
        else if (hg.pos + halfG + totalCenterW <= curRightEdge) cx = hg.pos + halfG;
      }
    }
    for (const it of centerScaled) {
      placeSlotAt(it.sl, cx, it.s);
      cx += it.w + gap;
    }
  }

  return { maxDockH, dockBoxes };
}

function buildPlacementsForScene(comps, baseW, baseH, deviceProfile, { gridFirst = false } = {}) {
  const { w: targetW, h: targetH, safeArea, hinges = [], breakpoint, isCompactCover } = deviceProfile;
  const padX = safeArea?.left ?? Math.max(12, Math.round(targetW * 0.032));
  const padY = safeArea?.top ?? Math.max(12, Math.round(targetH * 0.038));
  const usableW = Math.max(100, targetW - 2 * padX);
  const usableH = Math.max(100, targetH - 2 * padY);

  const placements = new Map();
  const dockComps = comps.filter(c => c.semanticRole.startsWith('dock_'));
  const modalComps = comps.filter(c => c.semanticRole === 'modal_panel');
  const fgComps = comps.filter(c => !c.semanticRole.startsWith('dock_') && c.semanticRole !== 'modal_panel');

  // 1. Modals: always contain + center in safe viewport
  for (const c of modalComps) {
    const bw = Math.max(1, c.bbox.w);
    const bh = Math.max(1, c.bbox.h);
    const s = Math.min(1.05, (usableW * 0.94) / bw, (usableH * 0.94) / bh);
    const w = bw * s;
    const h = bh * s;
    placements.set(c.id, {
      x: (targetW - w) / 2,
      y: (targetH - h) / 2,
      w,
      h,
      sx: s,
      sy: s,
    });
  }

  let maxDockH = 0;
  let dockBoxes = [];
  let contentBottomLimit = targetH - padY;

  // 2. Portrait-like breakpoints (portrait_tall & wide_portrait: Pura X / Pura X MAX portrait / 16:9 / MatePad portrait)
  if ((breakpoint === 'portrait_tall' || breakpoint === 'wide_portrait') && !gridFirst) {
    const s = clamp(Math.min(targetW / baseW, targetH / baseH, 1.0), 0.50, 1.0);
    const ox = (targetW - baseW * s) / 2;

    for (const c of dockComps) {
      const bw = Math.max(1, c.bbox.w);
      const bh = Math.max(1, c.bbox.h);
      const cs = Math.min(s, targetW / bw, targetH / bh);
      const w = bw * cs;
      const h = bh * cs;
      const x = clamp(ox + c.bbox.x * cs, 0, Math.max(0, targetW - w));
      const bottomMargin = Math.max(0, baseH - (c.bbox.y + bh));
      const y = clamp(targetH - bottomMargin * (targetH / baseH) - h, 0, Math.max(0, targetH - h));
      const box = { x, y, w, h, sx: cs, sy: cs };
      placements.set(c.id, box);
      dockBoxes.push(box);
      maxDockH = Math.max(maxDockH, h);
    }

    for (const c of fgComps) {
      const bw = Math.max(1, c.bbox.w);
      const bh = Math.max(1, c.bbox.h);
      const bleedsHoriz = c.bbox.x < -2 || (c.bbox.x + bw) > baseW + 2;
      const bleedsVert = c.bbox.y < -2 || (c.bbox.y + bh) > baseH + 2;
      const cs = (bleedsHoriz || bleedsVert)
        ? s
        : Math.min(s, targetW / bw, targetH / bh);
      const w = bw * cs;
      const h = bh * cs;
      const rawX = ox + c.bbox.x * cs;
      const x = bleedsHoriz ? rawX : clamp(rawX, 0, Math.max(0, targetW - w));
      const rawY = targetH >= baseH ? c.bbox.y * (targetH / baseH) : c.bbox.y * cs;
      const y = bleedsVert ? rawY : clamp(rawY, 0, Math.max(0, targetH - h));
      placements.set(c.id, { x, y, w, h, sx: cs, sy: cs });
    }
    contentBottomLimit = targetH;
  } else {
    const dockRes = layoutDockGroup(dockComps, {
      baseW, baseH, targetW, targetH, padX, padY, breakpoint, hinges, placements,
    });
    maxDockH = dockRes.maxDockH;
    dockBoxes = dockRes.dockBoxes;

    contentBottomLimit = maxDockH > 0
      ? targetH - padY - maxDockH - Math.max(10, targetH * 0.02)
      : targetH - padY;
    const contentUsableH = Math.max(80, contentBottomLimit - padY);

    const isLand = breakpoint === 'landscape_tablet' || breakpoint === 'landscape_wide';
    const hasTwoColFold = breakpoint === 'square_fold' && (hinges.length === 1 || !isCompactCover);

    layoutFlexColumns(fgComps, {
      targetW,
      targetH,
      padX,
      padY,
      usableW,
      usableH: contentUsableH,
      hinges,
      isCompactCover,
      twoColumnThreshold: gridFirst ? 1.0 : 0.56,
      forceTwoColumn: isLand || gridFirst || hasTwoColFold,
      placements,
    });
  }

  resolveCollisionsAndClamp(comps, placements, {
    baseW,
    baseH,
    targetW,
    targetH,
    padX,
    padY,
    contentBottomLimit,
    dockBoxes,
    hinges,
    breakpoint,
  });

  return placements;
}

function groupIntoFlexSlots(comps) {
  const slots = [];
  for (const c of comps) {
    let matchedSlot = null;
    let bestScore = -1;

    if (c.variantKey) {
      for (const slot of slots) {
        const allExclusive = slot.items.every(rep => !areVariantsCompatible(rep.variantKey, c.variantKey));
        if (!allExclusive) continue;

        const rep = slot.items[0];
        const inter = boxesOverlapArea(rep.bbox, c.bbox);
        const minA = Math.max(1, Math.min(rep.bbox.w * rep.bbox.h, c.bbox.w * c.bbox.h));
        const sizeRatio = Math.min(slot.w * slot.h, c.bbox.w * c.bbox.h) / Math.max(1, slot.w * slot.h, c.bbox.w * c.bbox.h);
        const score = (inter / minA) * 100 + (rep.semanticRole === c.semanticRole ? 20 : 0) + sizeRatio * 10;
        if (score > bestScore) {
          bestScore = score;
          matchedSlot = slot;
        }
      }
    }

    if (matchedSlot) {
      matchedSlot.items.push(c);
      matchedSlot.w = Math.max(matchedSlot.w, c.bbox.w);
      matchedSlot.h = Math.max(matchedSlot.h, c.bbox.h);
    } else {
      slots.push({
        items: [c],
        w: Math.max(1, c.bbox.w),
        h: Math.max(1, c.bbox.h),
        origY: c.bbox.y,
        origX: c.bbox.x,
        role: c.semanticRole,
      });
    }
  }
  return slots;
}

function layoutFlexStack(slots, box, gap, placements) {
  if (slots.length === 0) return;
  const totalBaseH = slots.reduce((s, sl) => s + sl.h, 0);
  const maxBaseW = Math.max(...slots.map(sl => sl.w));
  const totalGap = Math.max(0, slots.length - 1) * gap;
  const availH = Math.max(20, box.h - totalGap);

  const s = clamp(Math.min(box.w / maxBaseW, availH / Math.max(1, totalBaseH), 1.05), 0.04, 1.05);
  const usedH = totalBaseH * s + totalGap;
  let curY = box.y + Math.max(0, (box.h - usedH) / 2);

  for (const sl of slots) {
    const slotH = sl.h * s;
    for (const c of sl.items) {
      const w = c.bbox.w * s;
      const h = c.bbox.h * s;
      const x = box.x + (box.w - w) / 2;
      const y = curY + (slotH - h) / 2;
      placements.set(c.id, { x, y, w, h, sx: s, sy: s });
    }
    curY += slotH + gap;
  }
}

function layoutFlexGrid(slots, box, cols, gap, placements) {
  if (slots.length === 0) return;
  const rows = Math.ceil(slots.length / cols);
  const effGap = Math.min(gap, Math.floor(box.h / Math.max(1, rows * 4)), Math.floor(box.w / Math.max(1, cols * 4)));
  const cellW = Math.max(10, (box.w - effGap * (cols - 1)) / cols);
  const cellH = Math.max(10, (box.h - effGap * (rows - 1)) / rows);

  slots.forEach((sl, idx) => {
    const r = Math.floor(idx / cols);
    const col = idx % cols;
    const cx = box.x + col * (cellW + effGap);
    const cy = box.y + r * (cellH + effGap);
    const s = clamp(Math.min(cellW / sl.w, cellH / sl.h, 0.95), 0.04, 0.95);
    for (const c of sl.items) {
      const w = c.bbox.w * s;
      const h = c.bbox.h * s;
      placements.set(c.id, {
        x: cx + (cellW - w) / 2,
        y: cy + (cellH - h) / 2,
        w,
        h,
        sx: s,
        sy: s,
      });
    }
  });
}

function layoutFlexColumns(fgComps, opts) {
  const { targetW, targetH, padX, padY, usableW, usableH, hinges = [], forceTwoColumn, twoColumnThreshold, placements } = opts;
  if (fgComps.length === 0) return;

  const primary = fgComps
    .filter(c => c.layoutPolicy.pane === 'left_primary')
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  const secondary = fgComps
    .filter(c => c.layoutPolicy.pane !== 'left_primary')
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

  const primarySlots = groupIntoFlexSlots(primary);
  const secondarySlots = groupIntoFlexSlots(secondary);
  const allSlots = [...primarySlots, ...secondarySlots];
  const gap = Math.max(8, Math.round(targetH * 0.02));

  // Tri-fold 3-panel hinge-aware layout (hinges at ~360, 720)
  if (hinges.length === 2 && primarySlots.length > 0 && secondarySlots.length > 0) {
    const h1 = hinges[0], h2 = hinges[1];
    const g1 = (h1.width || 32) / 2;
    const g2 = (h2.width || 32) / 2;
    const panel1 = { x: padX, y: padY, w: Math.max(80, h1.pos - g1 - padX), h: usableH };
    const panel2 = { x: h1.pos + g1, y: padY, w: Math.max(80, (h2.pos - g2) - (h1.pos + g1)), h: usableH };
    const panel3 = { x: h2.pos + g2, y: padY, w: Math.max(80, targetW - padX - (h2.pos + g2)), h: usableH };

    if (primarySlots.length >= 6) layoutFlexGrid(primarySlots, panel1, 2, gap, placements);
    else layoutFlexStack(primarySlots, panel1, gap, placements);

    if (secondarySlots.length === 1) {
      layoutFlexStack(secondarySlots, { x: panel2.x, y: padY, w: panel3.x + panel3.w - panel2.x, h: usableH }, gap, placements);
    } else {
      const half = Math.ceil(secondarySlots.length / 2);
      const s2 = secondarySlots.slice(0, half);
      const s3 = secondarySlots.slice(half);
      if (s2.length >= 4) layoutFlexGrid(s2, panel2, 2, gap, placements);
      else layoutFlexStack(s2, panel2, gap, placements);
      if (s3.length >= 4) layoutFlexGrid(s3, panel3, 2, gap, placements);
      else layoutFlexStack(s3, panel3, gap, placements);
    }
    return;
  }

  let useTwoCol = forceTwoColumn;
  if (!useTwoCol && primarySlots.length > 0 && secondarySlots.length > 0) {
    const stackedH = allSlots.reduce((s, sl) => s + sl.h, 0);
    const estScale = usableH / Math.max(1, stackedH);
    if (estScale < twoColumnThreshold) useTwoCol = true;
  }

  if (useTwoCol && primarySlots.length > 0 && secondarySlots.length > 0) {
    let leftBox, rightBox;
    if (hinges.length === 1) {
      const hg = hinges[0];
      const halfGap = (hg.width || 44) / 2;
      leftBox = { x: padX, y: padY, w: Math.max(80, hg.pos - halfGap - padX), h: usableH };
      rightBox = { x: hg.pos + halfGap, y: padY, w: Math.max(80, targetW - padX - (hg.pos + halfGap)), h: usableH };
    } else {
      const colGap = Math.max(18, Math.round(usableW * 0.035));
      const leftW = Math.round((usableW - colGap) * 0.44);
      const rightW = usableW - colGap - leftW;
      leftBox = { x: padX, y: padY, w: leftW, h: usableH };
      rightBox = { x: padX + leftW + colGap, y: padY, w: rightW, h: usableH };
    }

    if (primarySlots.length >= 6) layoutFlexGrid(primarySlots, leftBox, 2, gap, placements);
    else layoutFlexStack(primarySlots, leftBox, gap, placements);

    if (secondarySlots.length >= 3) {
      const cols = secondarySlots.length >= 9 ? 3 : 2;
      layoutFlexGrid(secondarySlots, rightBox, cols, gap, placements);
    } else {
      layoutFlexStack(secondarySlots, rightBox, gap, placements);
    }
    return;
  }

  if (useTwoCol && primarySlots.length > 0 && secondarySlots.length === 0) {
    const leftW = hinges.length >= 1
      ? Math.max(80, hinges[0].pos - (hinges[0].width || 32) / 2 - padX)
      : usableW * 0.48;
    const leftBox = { x: padX + (hinges.length ? 0 : usableW * 0.02), y: padY, w: leftW, h: usableH };
    if (primarySlots.length >= 6) layoutFlexGrid(primarySlots, leftBox, 2, gap, placements);
    else layoutFlexStack(primarySlots, leftBox, gap, placements);
    return;
  }

  if (useTwoCol && primarySlots.length === 0 && secondarySlots.length > 0) {
    const fullBox = { x: padX, y: padY, w: usableW, h: usableH };
    if (secondarySlots.length >= 2) {
      const cols = Math.min(3, secondarySlots.length);
      layoutFlexGrid(secondarySlots, fullBox, cols, gap, placements);
    } else {
      layoutFlexStack(secondarySlots, fullBox, gap, placements);
    }
    return;
  }

  // Single centered column (e.g. Pura X Cover 1:1)
  const colW = Math.min(usableW * 0.90, targetH * 0.85);
  const colBox = { x: (targetW - colW) / 2, y: padY, w: colW, h: usableH };
  if (allSlots.length >= 5) layoutFlexGrid(allSlots, colBox, 2, gap, placements);
  else layoutFlexStack(allSlots, colBox, gap, placements);
}

function resolveCollisionsAndClamp(comps, placements, { baseW, baseH, targetW, targetH, padX, padY, contentBottomLimit, hinges = [], breakpoint }) {
  const isPortLike = breakpoint === 'portrait_tall' || breakpoint === 'wide_portrait';
  const effPadX = isPortLike ? 0 : padX;
  const effPadY = isPortLike ? 0 : padY;

  const origOverlapping = new Set();
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const a = comps[i];
      const b = comps[j];
      const inter = boxesOverlapArea(a.bbox, b.bbox);
      const minA = Math.max(0.01, Math.min(a.bbox.w * a.bbox.h, b.bbox.w * b.bbox.h));
      if (inter / minA > 0.14) {
        origOverlapping.add(`${a.id}|${b.id}`);
      }
    }
  }

  const clampBox = (comp, box) => {
    const isDock = comp.semanticRole.startsWith('dock_');
    const bleedsHoriz = isPortLike && (comp.bbox.x < -2 || comp.bbox.x + comp.bbox.w > baseW + 2);
    const bleedsVert = isPortLike && (comp.bbox.y < -2 || comp.bbox.y + comp.bbox.h > baseH + 2);
    if (bleedsHoriz && bleedsVert) return;

    let maxY = targetH - effPadY;
    if (!isDock && !isPortLike) {
      maxY = contentBottomLimit;
    }
    const minY = effPadY;
    const maxW = Math.max(20, targetW - 2 * effPadX);
    const maxH = Math.max(20, maxY - minY);
    if (!bleedsHoriz && !bleedsVert && (box.w > maxW || box.h > maxH)) {
      const shrink = Math.min(maxW / Math.max(1, box.w), maxH / Math.max(1, box.h));
      box.w *= shrink;
      box.h *= shrink;
      box.sx *= shrink;
      box.sy *= shrink;
    }
    if (!bleedsHoriz) box.x = clamp(box.x, effPadX, Math.max(effPadX, targetW - effPadX - box.w));
    if (!bleedsVert) box.y = clamp(box.y, minY, Math.max(minY, maxY - box.h));
  };

  const enforceHinges = () => {
    if (hinges.length === 0 || isPortLike) return;
    const panelW = targetW / (hinges.length + 1);
    for (const c of comps) {
      const box = placements.get(c.id);
      if (!box || box.w >= panelW * 0.90) continue;
      for (const hg of hinges) {
        const halfG = (hg.width || 32) / 2 + 2;
        if (box.x < hg.pos - 2 && box.x + box.w > hg.pos + 2 && box.x < hg.pos + halfG && box.x + box.w > hg.pos - halfG) {
          const cx = box.x + box.w / 2;
          if (cx <= hg.pos) {
            box.x = Math.max(effPadX, hg.pos - halfG - box.w);
          } else {
            box.x = Math.min(targetW - effPadX - box.w, hg.pos + halfG);
          }
          if (box.x < hg.pos + halfG && box.x + box.w > hg.pos - halfG) {
            const availSide = cx <= hg.pos ? (hg.pos - halfG - effPadX) : (targetW - effPadX - (hg.pos + halfG));
            if (availSide >= 24 && box.w > availSide) {
              const sFix = availSide / box.w;
              box.w *= sFix;
              box.h *= sFix;
              box.sx *= sFix;
              box.sy *= sFix;
              box.x = cx <= hg.pos ? (hg.pos - halfG - box.w) : (hg.pos + halfG);
            }
          }
          clampBox(c, box);
        }
      }
    }
  };

  for (const c of comps) {
    const box = placements.get(c.id);
    if (box) clampBox(c, box);
  }
  enforceHinges();

  for (let iter = 0; iter < 28; iter++) {
    let moved = false;
    for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const a = comps[i];
        const b = comps[j];
        if (!areVariantsCompatible(a.variantKey, b.variantKey)) continue;
        if (origOverlapping.has(`${a.id}|${b.id}`)) continue;

        const ba = placements.get(a.id);
        const bb = placements.get(b.id);
        if (!ba || !bb) continue;

        const inter = boxesOverlapArea(ba, bb);
        const minArea = Math.max(0.01, Math.min(ba.w * ba.h, bb.w * bb.h));
        const sepThreshold = isPortLike ? 0.14 : 0.03;
        if (inter / minArea <= sepThreshold) continue;

        const ox = Math.min(ba.x + ba.w, bb.x + bb.w) - Math.max(ba.x, bb.x);
        const oy = Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y);
        const margin = 8;

        const aIsDock = a.semanticRole.startsWith('dock_');
        const bIsDock = b.semanticRole.startsWith('dock_');

        if (aIsDock && bIsDock) {
          const push = (ox + margin) / 2;
          if (ba.x + ba.w / 2 <= bb.x + bb.w / 2) { ba.x -= push; bb.x += push; }
          else { ba.x += push; bb.x -= push; }
        } else if (aIsDock !== bIsDock) {
          const dockBox = aIsDock ? ba : bb;
          const fgBox = aIsDock ? bb : ba;
          fgBox.y = dockBox.y - fgBox.h - margin;
        } else {
          const panelAvail = hinges.length > 0 && !isPortLike
            ? (targetW / (hinges.length + 1)) - effPadX - ((hinges[0].width || 32) / 2 + 2)
            : targetW;
          const cantFitSideBySide = hinges.length > 0 && !isPortLike && (ba.w + bb.w + margin > panelAvail);
          if (cantFitSideBySide || (hinges.length > 0 && !isPortLike ? oy <= ox * 2.5 : oy <= ox)) {
            const push = (oy + margin) / 2;
            if (ba.y + ba.h / 2 <= bb.y + bb.h / 2) { ba.y -= push; bb.y += push; }
            else { ba.y += push; bb.y -= push; }
          } else {
            const push = (ox + margin) / 2;
            if (ba.x + ba.w / 2 <= bb.x + bb.w / 2) { ba.x -= push; bb.x += push; }
            else { ba.x += push; bb.x -= push; }
          }
        }

        clampBox(a, ba);
        clampBox(b, bb);
        const interAfter = boxesOverlapArea(ba, bb);
        const minAreaAfter = Math.max(0.01, Math.min(ba.w * ba.h, bb.w * bb.h));
        if (interAfter / minAreaAfter > 0.12) {
          for (const [comp, bx] of [[a, ba], [b, bb]]) {
            if (comp.semanticRole.startsWith('dock_')) continue;
            bx.w *= 0.85;
            bx.h *= 0.85;
            bx.sx *= 0.85;
            bx.sy *= 0.85;
            clampBox(comp, bx);
          }
        }
        moved = true;
      }
    }
    enforceHinges();
    if (!moved) break;
  }
}

function runBuiltinSceneSolver(themeDOM, deviceProfile, scene, { gridFirst = false } = {}) {
  const { baseW, baseH } = themeDOM.canvas;
  const sceneComps = themeDOM.components.filter(c => isSolverComponent(c, scene));
  const placements = buildPlacementsForScene(sceneComps, baseW, baseH, deviceProfile, { gridFirst });
  const out = new Map();
  for (const c of sceneComps) {
    const p = placements.get(c.id);
    if (!p) continue;
    out.set(c.id, {
      sx: p.sx,
      sy: p.sy,
      tx: p.x,
      ty: p.y,
      targetBBox: { x: p.x, y: p.y, w: p.w, h: p.h },
      mode: deviceProfile.breakpoint,
      breakpoint: deviceProfile.breakpoint,
    });
  }
  return out;
}

// Register built-in algorithms
registerAlgorithm('hwflex', {
  name: 'hwflex',
  solve(request) {
    return null; // Handled natively via runBuiltinSceneSolver
  },
});

registerAlgorithm('css_grid_v2', {
  name: 'css_grid_v2',
  solve(request) {
    return null; // Handled natively via gridFirst=true
  },
});

registerAlgorithm('hierarchical_v1', {
  name: 'hierarchical_v1',
  solve(request) {
    return null; // Handled natively via solveHierarchicalScene
  },
});

/**
 * Two-Level Hierarchical Solver for a single scene:
 * Level 1: Solve Macro Container bounding boxes
 * Level 2: Adapt internal child elements via centering, alignment, equal spacing, grid, or proportional
 */
export function solveHierarchicalScene(themeDOM, deviceProfile, scene, { mergeConfig = null, gridFirst = false, containerTree = null } = {}) {
  const { baseW, baseH } = themeDOM.canvas;
  const { w: targetW, h: targetH, safeArea, hinges = [], breakpoint } = deviceProfile;
  const padX = safeArea?.left ?? Math.max(12, Math.round(targetW * 0.032));
  const padY = safeArea?.top ?? Math.max(12, Math.round(targetH * 0.038));

  const tree = containerTree || buildContainerTree(themeDOM, mergeConfig);
  const scData = tree.byScene?.[scene];
  if (!scData || scData.macroComponents.length === 0) {
    return { containerTree: tree, macroBoxes: new Map(), childTransforms: new Map() };
  }

  const macroPlacements = buildPlacementsForScene(scData.macroComponents, baseW, baseH, deviceProfile, { gridFirst });
  const macroBoxes = new Map();
  const childPlacements = new Map();
  const scChildren = [];
  const dockBoxes = [];
  let maxDockH = 0;

  const totalDockContainers = scData.containers.filter(
    x => x.kind === 'dock_bar' || x.semanticRole.startsWith('dock_')
  ).length;

  for (const mc of scData.containers) {
    const p = macroPlacements.get(mc.id);
    if (!p) continue;
    let targetBox = { x: p.x, y: p.y, w: p.w, h: p.h };
    // Full-span dock bar in landscape/square when it is the sole dock container in the scene
    if (
      mc.kind === 'dock_bar' &&
      (totalDockContainers === 1 || mc.justify === 'space_between') &&
      mc.children.length >= 2 &&
      breakpoint !== 'portrait_tall' &&
      breakpoint !== 'wide_portrait'
    ) {
      const sidePad = Math.max(padX, targetW * 0.035);
      targetBox = { x: sidePad, y: p.y, w: Math.max(120, targetW - 2 * sidePad), h: p.h };
    }
    macroBoxes.set(mc.id, targetBox);

    const solvedChildren = solveIntraContainerLayout(mc, targetBox, mc.children, deviceProfile);
    for (const c of mc.children) {
      scChildren.push(c);
      const tr = solvedChildren.get(c.id);
      if (!tr) continue;
      const bx = { x: tr.tx, y: tr.ty, w: tr.targetBBox.w, h: tr.targetBBox.h, sx: tr.sx, sy: tr.sy, mode: tr.mode, parentContainerId: tr.parentContainerId, intraLayout: tr.intraLayout };
      childPlacements.set(c.id, bx);
      if (c.semanticRole.startsWith('dock_')) {
        dockBoxes.push(bx);
        maxDockH = Math.max(maxDockH, bx.h);
      }
    }
  }

  const contentBottomLimit = (breakpoint === 'portrait_tall' || breakpoint === 'wide_portrait') && !gridFirst
    ? targetH
    : (maxDockH > 0 ? targetH - padY - maxDockH - Math.max(10, targetH * 0.02) : targetH - padY);

  resolveCollisionsAndClamp(scChildren, childPlacements, {
    baseW,
    baseH,
    targetW,
    targetH,
    padX,
    padY,
    contentBottomLimit,
    dockBoxes,
    hinges,
    breakpoint,
  });

  const childTransforms = new Map();
  for (const [cid, p] of childPlacements.entries()) {
    childTransforms.set(cid, {
      sx: p.sx,
      sy: p.sy,
      tx: p.x,
      ty: p.y,
      targetBBox: { x: p.x, y: p.y, w: p.w, h: p.h },
      mode: p.mode || breakpoint,
      breakpoint,
      parentContainerId: p.parentContainerId,
      intraLayout: p.intraLayout,
    });
  }

  return { containerTree: tree, macroBoxes, childTransforms };
}

/**
 * Solve responsive transforms for ALL components in a ThemeDOM at (targetW, targetH).
 * Supports built-in ('hwflex', 'css_grid_v2', 'hierarchical_v1') and custom external plugins via `algorithm`.
 */
export function solveLayout(themeDOM, targetW, targetH, options = {}) {
  const { baseW, baseH } = themeDOM.canvas;
  const deviceProfile = options.deviceProfile || resolveDeviceProfile(targetW, targetH, options.deviceId);
  const algoSpec = options.algorithm || 'hwflex';
  const algoObj = typeof algoSpec === 'object' ? algoSpec : (getAlgorithm(algoSpec) || getAlgorithm('hwflex'));
  const algoName = algoObj?.name || (typeof algoSpec === 'string' ? algoSpec : 'custom');
  const gridFirst = algoName === 'css_grid_v2';
  const cssOverrides = options.cssOverrides || null;
  const isBuiltin = ['hwflex', 'css_grid_v2', 'hierarchical_v1'].includes(algoName);
  if (cssOverrides && isBuiltin) {
    for (const [id, rule] of cssOverrides) {
      const unsupported = Object.keys(rule).filter(key => !['min-scale', 'max-scale'].includes(key));
      if (unsupported.length) throw new Error(`Layout algorithm ${algoName} cannot apply CSS properties for ${id}: ${unsupported.join(', ')}`);
    }
  }
  const mergeConfig = options.mergeConfig || null;
  const hasCustomMerge = Boolean(
    (mergeConfig?.groups && mergeConfig.groups.length > 0) ||
    (mergeConfig?.overrides && Object.keys(mergeConfig.overrides).length > 0)
  );
  const containerTree = options.containerTree || buildContainerTree(themeDOM, mergeConfig);

  const results = new Map();
  results.diagnostics = [];

  // 1. Background & Fullscreen Gesture components
  for (const c of themeDOM.components) {
    if (c.semanticRole === 'background') {
      const bw = Math.max(1, c.bbox.w);
      const bh = Math.max(1, c.bbox.h);
      const s = Math.max(targetW / bw, targetH / bh);
      const w = bw * s;
      const h = bh * s;
      const focalY = c.layoutPolicy?.focalY ?? 0.5;
      const tx = (targetW - w) / 2;
      const ty = (targetH - h) * focalY;
      results.set(c.id, {
        sx: s,
        sy: s,
        tx,
        ty,
        targetBBox: { x: tx, y: ty, w, h },
        mode: 'cover',
        breakpoint: deviceProfile.breakpoint,
      });
    } else if (c.semanticRole === 'fullscreen_gesture') {
      const sx = targetW / Math.max(1, c.bbox.w);
      const sy = targetH / Math.max(1, c.bbox.h);
      results.set(c.id, {
        sx,
        sy,
        tx: 0,
        ty: 0,
        targetBBox: { x: 0, y: 0, w: targetW, h: targetH },
        mode: 'stretch_viewport',
        breakpoint: deviceProfile.breakpoint,
      });
    }
  }

  // 2. Solve each scene's foreground components via selected algorithm + ConstraintGuard
  for (const scene of themeDOM.scenes) {
    const sceneComps = themeDOM.components.filter(c => isSolverComponent(c, scene));
    if (sceneComps.length === 0) continue;

    const fallbackMap = runBuiltinSceneSolver(themeDOM, deviceProfile, scene, { gridFirst });
    let customMap = fallbackMap;

    if (algoName === 'hierarchical_v1' || (hasCustomMerge && (algoName === 'hwflex' || algoName === 'css_grid_v2'))) {
      const hRes = solveHierarchicalScene(themeDOM, deviceProfile, scene, {
        mergeConfig,
        gridFirst,
        containerTree,
      });
      if (hRes.childTransforms.size > 0) {
        customMap = hRes.childTransforms;
      }
    } else if (algoObj && algoName !== 'hwflex' && algoName !== 'css_grid_v2') {
      const req = buildLayoutRequest(themeDOM, deviceProfile, scene, cssOverrides, containerTree);
      const rawResp = algoObj.solve(req);
      const normalized = normalizeAlgorithmResponse(rawResp, sceneComps, deviceProfile, containerTree, scene);
      if (normalized.size > 0) {
        customMap = normalized;
      }
    }

    const guarded = applyConstraintGuard(customMap, sceneComps, deviceProfile, fallbackMap, { baseW, baseH }, cssOverrides);
    results.diagnostics.push(...guarded.diagnostics.map(issue => ({ ...issue, scene, deviceId: deviceProfile.id })));
    for (const [cid, tr] of guarded.entries()) {
      results.set(cid, tr);
    }
  }

  return results;
}
