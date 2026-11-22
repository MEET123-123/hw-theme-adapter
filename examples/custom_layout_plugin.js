/**
 * Example Custom Layout Algorithm Plugin for HwFlex.
 *
 * Usage:
 *   node src/cli.js adapt --theme 假日特调青柠气泡 --algo examples/custom_layout_plugin.js
 *   node src/cli.js validate --theme 假日特调青柠气泡 --algo examples/custom_layout_plugin.js
 *
 * You can return EITHER:
 *   Format A: { components: { [compId]: { sx, sy, tx, ty } } }
 *   Format B: { bboxes: { [compId]: [x, y, w, h] }, coordinate_system: 'virtual_px' | 'normalized_1000' }
 *
 * Any omitted components are filled by the default solver, and ConstraintGuard automatically
 * enforces aspect ratio preservation, fold-hinge crease avoidance, safe areas, and collision safety.
 */

export const name = 'example_custom_plugin';

export function solve(request) {
  const { device, components } = request;
  const bboxes = {};

  // Example: on landscape / tri-fold screens, arrange primary info (clock/date/weather)
  // in the left panel and widgets in the right panel using normalized_1000 coordinates.
  if (device.breakpoint === 'landscape_tablet' || device.breakpoint === 'landscape_wide') {
    const primary = components.filter(c => c.layoutPolicy?.pane === 'left_primary');
    const secondary = components.filter(c => c.layoutPolicy?.pane === 'right_content');

    primary.forEach((c, idx) => {
      const slotH = Math.floor(720 / Math.max(1, primary.length));
      bboxes[c.id] = [40, 80 + idx * slotH, 400, Math.max(80, slotH - 20)];
    });

    secondary.forEach((c, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const rows = Math.ceil(secondary.length / 2);
      const cellH = Math.floor(720 / Math.max(1, rows));
      bboxes[c.id] = [500 + col * 240, 80 + row * cellH, 220, Math.max(80, cellH - 20)];
    });

    return {
      coordinate_system: 'normalized_1000',
      bboxes,
    };
  }

  // Return empty components on portrait/foldable to delegate cleanly to built-in solver
  return { components: {} };
}
