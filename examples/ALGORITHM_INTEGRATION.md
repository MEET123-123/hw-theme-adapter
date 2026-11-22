# 接入自定义布局算法接口指南（LayoutAlgorithmAdapter）

本项目通过 `src/layout/algorithm_interface.js` 提供统一的布局算法插槽，支持接入：
1. JavaScript 插件模块（`.js`，导出 `solve(request)`）；
2. 外部 Python / 多模态大模型生成的布局 JSON 文件（`.json`）。

---

## 一、输入契约（`LayoutRequest`）

框架按 `(场景 × 设备形态)` 调用算法时，会传入标准 JSON：

```json
{
  "schema_version": "2.0",
  "theme_name": "假日特调青柠气泡.hwt",
  "source": { "packageName": "假日特调青柠气泡.hwt", "manifestPath": "unlock/lockscreen/manifest.xml" },
  "source_canvas": { "w": 1080, "h": 2400 },
  "device": {
    "id": "tri_fold_triple",
    "label": "三折叠 Mate XT 三屏展开 (3184×2232)",
    "breakpoint": "landscape_tablet",
    "w": 1080,
    "h": 757,
    "safeArea": { "top": 24, "right": 28, "bottom": 24, "left": 28 },
    "hinges": [
      { "axis": "x", "pos": 360, "width": 32 },
      { "axis": "x", "pos": 720, "width": 32 }
    ],
    "isCompactCover": false
  },
  "scene": "main",
  "components": [
    {
      "id": "comp_13",
      "semanticRole": "clock",
      "variantKey": null,
      "bbox": [57, 259, 965, 667],
      "layoutPolicy": { "anchor": "top", "pane": "left_primary", "preserveAspect": true },
      "cssOverride": null
    }
  ]
}
```

---

请求中的组件有 `id` 和 `stableKey`。旧插件可以继续用 `comp_N`。保存布局 JSON、人工分组或训练标注时可以使用 `stableKey`，它由主题包名、脚本路径、组件角色和成员节点路径生成。同名同类节点的相对顺序、成员变更和主题包重命名可能改变此键。组件成员的 `sourcePath` 可从 ThemeDOM 的 `elements` 查找。

## 二、输出契约

### 格式 A · 组件仿射变换

```json
{
  "components": {
    "comp_13": { "sx": 0.42, "sy": 0.42, "tx": 40, "ty": 120 }
  }
}
```

### 格式 B：目标 BBox 坐标（适合多模态模型 / Python 约束求解器直接输出）

```json
{
  "coordinate_system": "normalized_1000",
  "bboxes": {
    "comp_13": [40, 120, 420, 320]
  }
}
```

### 格式 C · 宏容器目标框

```json
{
  "coordinate_system": "normalized_1000",
  "macro_bboxes": { "mc_1": [40, 120, 420, 320] },
  "container_overrides": { "mc_1": { "intraLayout": "flex_col", "align": "center", "gap": 12 } }
}
```

- 框坐标为 `[x, y, w, h]`。坐标系支持 `virtual_px` 和 `normalized_1000`，后者按目标画布两轴独立换算。格式 A 的变换值使用目标逻辑坐标。
- `components`、`bboxes` 的键支持 `id` 或 `stableKey`。省略项由内置求解器补全。已识别组件的非数值、非正尺寸和不支持的坐标系会报出具体字段。
- 静态 JSON 可使用 `by_device.<设备 ID>.by_scene.<场景名>`，也可以只按设备或场景提供结果。
- XML 回写要求前景等比缩放。等比组件会收敛到统一尺度，其他仍要求两轴不同的变换将在编译时明确拒绝。

---

## 三、ConstraintGuard 安全护栏

任意外部算法输出都会经过 `applyConstraintGuard(...)`：
1. **等比锁定**：`preserveAspect: true` 的前景组件自动对齐 `sx === sy`。
2. **折叠屏折痕避让**：双折叠（`x=540`）、三折叠（`x=360, 720`）下，窄于单屏面板的组件若跨越折痕，会自动向更近的一侧面板推开。
3. **安全区与碰撞修复**：读取四边独立边距。内置算法保留对称竖屏档案的旧定位和源稿允许出屏的组件。无法消除的安全区或折痕冲突会记录在交付审计中。

内置算法支持通过 `--css` 指定 `min-scale` 和 `max-scale`。目标模式对选定设备执行约束，通用模式在参考设备上应用约束后进行插值。其他已解析的 CSS 属性仅通过 `cssOverride` 传给自定义 JS 求解器。

---

## 四、命令行接入方式

```powershell
# 运行自带示例插件
node src/cli.js validate --theme 假日特调青柠气泡 --algo examples/custom_layout_plugin.js

# 使用内置 CSS Grid 备选算法
node src/cli.js adapt --theme 假日特调青柠气泡 --algo css_grid_v2

# 接入外部 Python/VLM 产出的 JSON 布局文件
node src/cli.js adapt --theme 假日特调青柠气泡 --algo path/to/vlm_layout.json --repack

# 在单独目录核验目标设备并生成诊断报告
node src/cli.js validate --theme 波蓝 --device pura_x_cover --out-dir ./output/check --reports-dir ./reports/check

# 生成形态采样和事件序列回放
node src/cli.js analyze --theme 非凡之境 --reports-dir ./reports/check
```

HWT 导出会回读普通和 UCD manifest，并在 `delivery_audit.json` 记录每份脚本的资源、表达式和布局检查。资源检查会区分静态缺失、动态引用和设备外部资源。`validate` 在主题核验失败时以非零退出码返回。`analyze` 的回放受事件预算、动画近似和设备模拟器能力限制。
