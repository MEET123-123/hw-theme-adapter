/**
 * Reference Hierarchical Layout Plugin (Format C: Macro Container BBoxes).
 *
 * Demonstrates Two-Level Adaptation:
 * 1) This algorithm only needs to arrange high-level Macro Containers (`request.macro_containers`),
 *    such as `header_cluster`, `dock_bar`, `widget_row`, `widget_grid`, `hero`.
 * 2) HwFlex's Level-2 intra-container engine (`solveIntraContainerLayout`) automatically adapts
 *    every container's children using centering, alignment, equal spacing, or grid distribution.
 *
 * Usage:
 *   node src/cli.js validate --theme 假日特调青柠气泡 --algo examples/hierarchical_layout_plugin.js
 */

export const name = 'hierarchical_macro_plugin';

export function solve(request) {
  const { device, macro_containers = [] } = request;
  if (macro_containers.length === 0) return { macro_bboxes: {} };

  if (device.breakpoint !== 'landscape_tablet' && device.breakpoint !== 'landscape_wide') {
    // Delegate portrait & square foldable to built-in hierarchical solver
    return { macro_bboxes: {} };
  }

  const macro_bboxes = {};
  const container_overrides = {};

  const primary = macro_containers.filter(mc => mc.pane === 'left_primary' && mc.kind !== 'dock_bar');
  const secondary = macro_containers.filter(mc => mc.pane !== 'left_primary' && mc.kind !== 'dock_bar');
  const docks = macro_containers.filter(mc => mc.kind === 'dock_bar' || mc.semanticRole.startsWith('dock_'));

  // Place primary containers on the left region, centered vertically
  primary.forEach((mc, idx) => {
    const slotH = Math.floor(720 / Math.max(1, primary.length));
    macro_bboxes[mc.id] = [40, 60 + idx * slotH, 410, Math.max(90, slotH - 20)];
    if (mc.children.length >= 2) {
      container_overrides[mc.id] = { intraLayout: 'flex_col', align: 'center', justify: 'center' };
    }
  });

  // Place secondary macro containers on the right region in equal rows/cards
  secondary.forEach((mc, idx) => {
    const col = secondary.length >= 3 ? idx % 2 : 0;
    const cols = secondary.length >= 3 ? 2 : 1;
    const rows = Math.ceil(secondary.length / cols);
    const r = Math.floor(idx / cols);
    const cellW = cols === 2 ? 230 : 470;
    const cellH = Math.floor(720 / Math.max(1, rows));
    macro_bboxes[mc.id] = [485 + col * 245, 60 + r * cellH, cellW, Math.max(90, cellH - 20)];
  });

  // Stretch or distribute dock containers across bottom without overlapping
  docks.forEach((mc, idx) => {
    const spanW = Math.floor(920 / Math.max(1, docks.length));
    macro_bboxes[mc.id] = [40 + idx * spanW, 820, Math.max(120, spanW - 12), 130];
    if (mc.children.length >= 2) {
      container_overrides[mc.id] = {
        intraLayout: 'flex_row',
        align: 'center',
        justify: mc.children.length === 2 ? 'space_between' : 'space_evenly',
      };
    }
  });

  return {
    coordinate_system: 'normalized_1000',
    macro_bboxes,
    container_overrides,
  };
}
