/**
 * RuiC-PoseAtlas · ComfyUI 前端扩展
 *
 * 侧边栏「参考图鉴」标签页 + 节点上的「浏览图库」按钮，覆盖三套图鉴：
 *   - 姿势（288 组 / 1,439 张）  → RuiCPoseAtlasLoad / RuiCPoseAtlasAngles
 *   - 衣装（1,407 套）           → RuiCCostumeLoad
 *   - 人像（1,499 张）           → RuiCPortraitLoad
 *
 * 图片走 /poseatlas/media/*（直接从节点目录读取，不复制文件），
 * 数据走 /poseatlas/api/{index,costumes,faces}。
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const LOG = "[PoseAtlas]";
const EXT_NAME = "RuiC.PoseAtlas";
const TAB_ID = "ruic-poseatlas";

const NODE_POSE_LOAD = "RuiCPoseAtlasLoad";
const NODE_POSE_ANGLES = "RuiCPoseAtlasAngles";
const NODE_COSTUME_LOAD = "RuiCCostumeLoad";
const NODE_PORTRAIT_LOAD = "RuiCPortraitLoad";
const NODE_SMART_PROMPT = "RuiCSmartPrompt";

// 智能连接提示词节点：哪个下拉框选中哪个值，才显示哪个自定义输入框
// （值随界面语言翻译，所以「自定义」要认全三种语言的写法）
const PROMPT_TOGGLES = [
  { watch: "句式模板", when: ["自定义", "Custom", "カスタム"], target: "自定义句式" },
  { watch: "标签样式", when: ["自定义", "Custom", "カスタム"], target: "自定义标签" },
];

/**
 * 下拉框的默认值。旧工作流在新版里恢复时，新增/改过默认的控件可能拿到空值，
 * 服务端会直接判「Value not in list」并拒绝整张图，所以加载节点时纠一遍。
 */
const PROMPT_COMBO_DEFAULTS = {
  标签样式: "<image*>",
  句式模板: "指令式（参考图 + 指令）",
  编号方式: "按连接顺序（自动紧凑）",
  拼图高度: "自动（取最矮，不放大）",
};

/** 七个图库节点（用来判断连线的源头是不是我们自己的节点） */
const ATLAS_NODE_TYPES = new Set([
  NODE_POSE_LOAD,
  "RuiCPoseAtlasRandom",
  NODE_POSE_ANGLES,
  NODE_COSTUME_LOAD,
  "RuiCCostumeRandom",
  NODE_PORTRAIT_LOAD,
  "RuiCPortraitRandom",
]);

/**
 * 端口顺序调整（智能连接提示词 从 info 下面挪到 mask 下面）之后，
 * 旧工作流里连好的线会错位到 info 端口，这里在加载时把它们拨回新端口。
 */
function migratePromptLinks(node) {
  const graph = node.graph;
  if (!graph || !graph.links) return false;
  let fixed = 0;
  (node.inputs || []).forEach((input) => {
    const linkId = input.link;
    if (linkId == null) return;
    const link = typeof graph.links.get === "function" ? graph.links.get(linkId) : graph.links[linkId];
    if (!link || link.origin_id == null) return;
    const origin = graph.getNodeById ? graph.getNodeById(link.origin_id) : null;
    if (!origin || !origin.outputs) return;
    const kind = origin.constructor?.nodeData?.name || origin.type;
    if (!ATLAS_NODE_TYPES.has(kind)) return;
    // 端口名会随语言翻译，这里按固定序号判断，不按名字找
    if (link.origin_slot === NEW_LINK_SLOT) return;
    // 只搬「旧版本连到 info 端口」的线，别的错位不动，免得误伤
    if (link.origin_slot !== OLD_INFO_SLOT) return;
    const cur = origin.outputs[link.origin_slot];
    if (cur && Array.isArray(cur.links)) cur.links = cur.links.filter((id) => id !== linkId);
    const out = origin.outputs[NEW_LINK_SLOT];
    out.links = Array.isArray(out.links) ? out.links : [];
    if (!out.links.includes(linkId)) out.links.push(linkId);
    link.origin_slot = NEW_LINK_SLOT;
    if (out.type) link.type = out.type;
    fixed += 1;
  });
  if (fixed) node.setDirtyCanvas?.(true, true);
  return fixed > 0;
}

/**
 * 端口顺序调整前的旧序号 → 新序号。旧版是 image/mask/info/智能连接提示词，
 * 新版把「智能连接提示词」提到了 mask 下面，info 挪到最后。
 * 按连线上记录的类型来判断，避免把新版本保存的线又拨回去。
 */
const OLD_LINK_SLOT = 3;   // 旧版「智能连接提示词」
const NEW_LINK_SLOT = 2;
const OLD_INFO_SLOT = 2;   // 旧版 info
const NEW_INFO_SLOT = 3;

function migrateLegacyLinkSlots(data) {
  if (!data || !Array.isArray(data.links) || !Array.isArray(data.nodes)) return 0;
  const ids = new Set();
  data.nodes.forEach((n) => {
    if (n && ATLAS_NODE_TYPES.has(n.type)) ids.add(String(n.id));
  });
  if (!ids.size) return 0;
  let fixed = 0;
  data.links.forEach((l) => {
    if (!l) return;
    const isArray = Array.isArray(l);
    const originId = isArray ? l[1] : l.origin_id;
    if (!ids.has(String(originId))) return;
    const slot = isArray ? l[2] : l.origin_slot;
    const type = isArray ? l[5] : l.type;
    let next = null;
    if (type === "PA_PROMPT_LINK" && slot === OLD_LINK_SLOT) next = NEW_LINK_SLOT;
    else if (type === "STRING" && slot === OLD_INFO_SLOT) next = NEW_INFO_SLOT;
    if (next == null) return;
    if (isArray) l[2] = next;
    else l.origin_slot = next;
    fixed += 1;
  });
  return fixed;
}

function normalizePromptCombos(node) {
  if (!node) return false;
  let changed = false;
  Object.entries(PROMPT_COMBO_DEFAULTS).forEach(([name, fallback]) => {
    const w = findWidget(node, [name]);
    if (!w) return;
    const values = Array.isArray(w.options?.values) ? w.options.values : null;
    if (values && values.length) {
      if (values.includes(w.value)) return;
      w.value = values.includes(fallback) ? fallback : values[0];
    } else if (w.value !== "" && w.value != null) {
      return;
    } else {
      w.value = fallback;
    }
    changed = true;
    try {
      w.callback?.(w.value, app.canvas, node);
    } catch (err) {
      /* 回调只是顺手通知，失败无碍 */
    }
  });
  if (changed) node.setDirtyCanvas?.(true, true);
  return changed;
}

/** 带「浏览图库」按钮 + 节点内预览的节点 */
const PICKER_NODES = [NODE_POSE_LOAD, NODE_POSE_ANGLES, NODE_COSTUME_LOAD, NODE_PORTRAIT_LOAD];

const ANGLE_ORDER = ["front", "diagonal", "side", "high", "low"];
const LANG_KEY = "ruic-poseatlas.lang";
const CSS_URL = new URL("./poseatlas.css", import.meta.url).href;

/* ------------------------------------------------------------------ 图集定义 */
const ATLAS = {
  pose: {
    key: "pose",
    api: "/poseatlas/api/index",
    loadNode: NODE_POSE_LOAD,
    nodeTypes: [NODE_POSE_LOAD, NODE_POSE_ANGLES],
    widget: "pose",
    cardClass: "",
    chipField: "series",
    selectField: "category",
    minRatio: 3 / 4, // 卡片宽高比
  },
  costume: {
    key: "costume",
    api: "/poseatlas/api/costumes",
    loadNode: NODE_COSTUME_LOAD,
    nodeTypes: [NODE_COSTUME_LOAD],
    widget: "costume",
    cardClass: "pa-card--costume",
    chipField: "series",
    selectField: "category",
    minRatio: 2 / 3,
  },
  portrait: {
    key: "portrait",
    api: "/poseatlas/api/faces",
    loadNode: NODE_PORTRAIT_LOAD,
    nodeTypes: [NODE_PORTRAIT_LOAD],
    widget: "portrait",
    cardClass: "pa-card--portrait",
    chipField: "series",
    selectField: "category",
    minRatio: 4 / 5,
  },
};

/** 节点类型 → 预览规格（atlas / 形态 / 宽高比） */
const PREVIEW_SPECS = {
  [NODE_POSE_LOAD]: { atlas: "pose", mode: "single", ratio: 3 / 4 },
  [NODE_POSE_ANGLES]: { atlas: "pose", mode: "strip" },
  [NODE_COSTUME_LOAD]: { atlas: "costume", mode: "single", ratio: 2 / 3 },
  [NODE_PORTRAIT_LOAD]: { atlas: "portrait", mode: "single", ratio: 4 / 5 },
};

/* ------------------------------------------------------------------ 文案 */
const I18N = {
  zh: {
    tabTitle: "参考图鉴",
    tabTooltip: "RuiC PoseAtlas · 浏览姿势 / 衣装 / 人像，点击插入节点",
    pickerPose: "姿态图库",
    pickerCostume: "衣装图库",
    pickerPortrait: "人像图库",
    atlasPose: "姿势",
    atlasCostume: "衣装",
    atlasPortrait: "人像",
    searchPose: "搜索编号 / 名称 / 分类…",
    searchCostume: "搜索编号 / 标签，如 knit、黑色…",
    searchPortrait: "搜索编号 / 风格描述…",
    all: "全部",
    seriesLabel: "系列",
    categoryLabel: "分类",
    groupLabel: "品类",
    colorLabel: "颜色",
    mainLabel: "主单品",
    sectionLabel: "分区",
    hairLabel: "发型",
    styleLabel: "风格",
    tagsLabel: "标签",
    selectLabelPose: "分类",
    selectLabelCostume: "品类",
    selectLabelPortrait: "发型",
    insert: "插入节点",
    quickInsert: "插入节点",
    reusedTitle: "已更新现有节点",
    use: "使用该图",
    download: "下载原图",
    close: "关闭",
    empty: "没有匹配的结果",
    loadFail: "图鉴数据加载失败",
    retry: "重试",
    modalTitle: "选择参考图 · RuiC-PoseAtlas",
    angles: "角度",
    info: "信息",
    hint: [
      ["← →", "切换角度"],
      ["↑ ↓", "切换图片"],
      ["Esc", "关闭"],
    ],
    countPose: (p, i) => `${p} 组姿态 · ${i} 张图`,
    countCostume: (p) => `${p} 套衣装`,
    countPortrait: (p) => `${p} 张人像`,
  },
  en: {
    tabTitle: "Atlas",
    tabTooltip: "RuiC PoseAtlas · browse poses / outfits / portraits",
    pickerPose: "Pose Atlas",
    pickerCostume: "Costume Atlas",
    pickerPortrait: "Portrait Atlas",
    atlasPose: "Poses",
    atlasCostume: "Outfits",
    atlasPortrait: "Portraits",
    searchPose: "Search number / name / category…",
    searchCostume: "Search id / tag, e.g. knit, black…",
    searchPortrait: "Search id / style note…",
    all: "All",
    seriesLabel: "Series",
    categoryLabel: "Category",
    groupLabel: "Type",
    colorLabel: "Color",
    mainLabel: "Main item",
    sectionLabel: "Section",
    hairLabel: "Hair",
    styleLabel: "Style",
    tagsLabel: "Tags",
    selectLabelPose: "Category",
    selectLabelCostume: "Type",
    selectLabelPortrait: "Hair",
    insert: "Insert node",
    quickInsert: "Insert",
    reusedTitle: "Updated existing node",
    use: "Use this image",
    download: "Download PNG",
    close: "Close",
    empty: "No matching item",
    loadFail: "Failed to load atlas data",
    retry: "Retry",
    modalTitle: "Pick a reference · RuiC-PoseAtlas",
    angles: "Angles",
    info: "Info",
    hint: [
      ["← →", "angle"],
      ["↑ ↓", "image"],
      ["Esc", "close"],
    ],
    countPose: (p, i) => `${p} poses · ${i} images`,
    countCostume: (p) => `${p} outfits`,
    countPortrait: (p) => `${p} portraits`,
  },
  ja: {
    tabTitle: "図鑑",
    tabTooltip: "RuiC PoseAtlas · ポーズ / 衣装 / 人像を選んでノードを挿入",
    pickerPose: "ポーズ図鑑",
    pickerCostume: "衣装図鑑",
    pickerPortrait: "ポートレート図鑑",
    atlasPose: "ポーズ",
    atlasCostume: "衣装",
    atlasPortrait: "ポートレート",
    searchPose: "番号 / 名前 / カテゴリで検索…",
    searchCostume: "番号 / タグで検索（knit、黒 など）…",
    searchPortrait: "番号 / 風格メモで検索…",
    all: "すべて",
    seriesLabel: "シリーズ",
    categoryLabel: "カテゴリ",
    groupLabel: "種類",
    colorLabel: "色",
    mainLabel: "メイン",
    sectionLabel: "セクション",
    hairLabel: "髪型",
    styleLabel: "スタイル",
    tagsLabel: "タグ",
    selectLabelPose: "カテゴリ",
    selectLabelCostume: "種類",
    selectLabelPortrait: "髪型",
    insert: "ノードを挿入",
    quickInsert: "挿入",
    reusedTitle: "既存ノードを更新",
    use: "この画像を使う",
    download: "原寸PNG",
    close: "閉じる",
    empty: "該当する画像がありません",
    loadFail: "データの読み込みに失敗しました",
    retry: "再試行",
    modalTitle: "参考画像を選択 · RuiC-PoseAtlas",
    angles: "アングル",
    info: "情報",
    hint: [
      ["← →", "アングル"],
      ["↑ ↓", "画像"],
      ["Esc", "閉じる"],
    ],
    countPose: (p, i) => `${p} ポーズ · ${i} 枚`,
    countCostume: (p) => `${p} 衣装`,
    countPortrait: (p) => `${p} 枚のポートレート`,
  },
};

/* ------------------------------------------------------------------ 基础工具 */
function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && I18N[saved]) return saved;
  } catch (e) {
    /* localStorage 可能被禁用 */
  }
  const nav = (navigator.language || "en").toLowerCase();
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("ja")) return "ja";
  return "en";
}

const store = {
  lang: detectLang(),
  atlas: "pose", // 面板的默认图集
  atlases: {}, // key → { ready, items, byId, chips, selects, ... }
  panels: new Set(),
};

function t(key) {
  const dict = I18N[store.lang] || I18N.en;
  return dict[key] ?? I18N.en[key] ?? key;
}

function pickName(obj, lang = store.lang) {
  const names = (obj && obj.names) || {};
  return names[lang] || names.zh || names.en || names.ja || (obj && obj.key) || "";
}

/* ------------------------------------------------------------------ 节点界面翻译
   跟随面板语言开关（中 / EN / 日）切换节点标题、控件标签与输出端口名的「显示文本」。
   只改显示：控件 key（widget.name）、下拉框选项值、端口类型都不动，工作流完全兼容。 */
const NODE_I18N = {
  [NODE_POSE_LOAD]: { zh: "姿态图库 · 加载", en: "Pose Atlas · Load", ja: "ポーズ図鑑・ロード" },
  "RuiCPoseAtlasRandom": { zh: "姿态图库 · 随机", en: "Pose Atlas · Random", ja: "ポーズ図鑑・ランダム" },
  [NODE_POSE_ANGLES]: { zh: "姿态图库 · 多视角", en: "Pose Atlas · Angles", ja: "ポーズ図鑑・多アングル" },
  [NODE_COSTUME_LOAD]: { zh: "衣装图库 · 加载", en: "Costume Atlas · Load", ja: "衣装図鑑・ロード" },
  "RuiCCostumeRandom": { zh: "衣装图库 · 随机", en: "Costume Atlas · Random", ja: "衣装図鑑・ランダム" },
  [NODE_PORTRAIT_LOAD]: { zh: "人像图库 · 加载", en: "Portrait Atlas · Load", ja: "ポートレート図鑑・ロード" },
  "RuiCPortraitRandom": { zh: "人像图库 · 随机", en: "Portrait Atlas · Random", ja: "ポートレート図鑑・ランダム" },
  [NODE_SMART_PROMPT]: { zh: "智能连接提示词", en: "Smart Prompt Link", ja: "スマート接続プロンプト" },
};

const WIDGET_I18N = {
  en: {
    pose: "Pose", angle: "Angle", series: "Series", category: "Category",
    group: "Group", seed: "Seed", angles: "Angles", costume: "Costume",
    portrait: "Portrait", section: "Section", hair: "Hair",
    "连接 1": "Link 1", "连接 2": "Link 2", "连接 3": "Link 3",
    "连接 4": "Link 4", "连接 5": "Link 5", "连接 6": "Link 6",
    "标签样式": "Label Style", "语言": "Language", "句式模板": "Template",
    "自定义标签": "Custom Label", "自定义句式": "Custom Template",
    "编号方式": "Numbering", "拼图高度": "Montage Height", "补充提示词": "Extra Prompt",
  },
  ja: {
    pose: "ポーズ", angle: "アングル", series: "シリーズ", category: "カテゴリ",
    group: "カテゴリ", seed: "シード", angles: "アングル一覧", costume: "衣装",
    portrait: "ポートレート", section: "パーツ", hair: "髪型",
    "连接 1": "参考 1", "连接 2": "参考 2", "连接 3": "参考 3",
    "连接 4": "参考 4", "连接 5": "参考 5", "连接 6": "参考 6",
    "标签样式": "ラベル形式", "语言": "言語", "句式模板": "テンプレート",
    "自定义标签": "カスタムラベル", "自定义句式": "カスタムテンプレート",
    "编号方式": "採番方式", "拼图高度": "モンタージュ高さ", "补充提示词": "追加プロンプト",
  },
};
const WIDGET_I18N_KEYS = new Set(Object.keys(WIDGET_I18N.en));

/* 智能连接提示词四个下拉框的三语选项（与 Python 端 OPTION_ALIASES 一一对应，
   标准值 = 中文）。切换界面语言时把「选项列表」和「当前值」一起翻过去，
   Python 端会把任何语言的值归一回中文标准值，所以工作流怎么存都能执行。 */
const COMBO_I18N = {
  "标签样式": {
    zh: ["<image*>", "图片*", "<图片*>", "自定义"],
    en: ["<image*>", "Image*", "<Image*>", "Custom"],
    ja: ["<image*>", "画像*", "<画像*>", "カスタム"],
  },
  "句式模板": {
    zh: ["人物 · 姿势 · 服装（默认）", "指令式（参考图 + 指令）", "标签式（SDXL / Flux）", "自定义"],
    en: ["Character · Pose · Outfit (Default)", "Instructional (Refs + Directive)", "Tag Style (SDXL / Flux)", "Custom"],
    ja: ["人物・ポーズ・衣装（デフォルト）", "指令型（参照画像 + 指示）", "タグ形式（SDXL / Flux）", "カスタム"],
  },
  "编号方式": {
    zh: ["按连接顺序（自动紧凑）", "按端口编号（1 – 6）"],
    en: ["By connection order (compact)", "By port number (1 – 6)"],
    ja: ["接続順（自動コンパクト）", "ポート番号順（1 – 6）"],
  },
  "拼图高度": {
    zh: ["自动（取最矮，不放大）", "768", "1024", "1536", "2048"],
    en: ["Auto (shortest, no upscale)", "768", "1024", "1536", "2048"],
    ja: ["自動（最も低い高さに揃える）", "768", "1024", "1536", "2048"],
  },
};

/** 节点「语言」控件的值（固定中文写法，便于序列化），随界面语言同步 */
const LANG_WIDGET_VALUE = { zh: "中文", en: "English", ja: "日本語" };

/* 端口显示名（label）。name 保持中文标准值不动（恢复工作流按序号匹配），
   label 才是新前端 / 画布实际渲染的文本，两种渲染路径都优先显示 label。 */
const PORT_I18N = {
  zh: {
    image: "图像", mask: "遮罩", "智能连接提示词": "智能连接提示词", info: "信息",
    "提示词": "提示词", "拼图": "拼图",
  },
  en: {
    image: "image", mask: "mask", "智能连接提示词": "Smart Prompt", info: "info",
    "提示词": "Prompt", "拼图": "Montage",
  },
  ja: {
    image: "画像", mask: "マスク", "智能连接提示词": "スマート接続プロンプト", info: "情報",
    "提示词": "プロンプト", "拼图": "モンタージュ",
  },
};

// 图库按钮在三种语言下的文案（反查按钮 widget 用）
const PICKER_LABELS = new Set([
  "姿态图库", "衣装图库", "人像图库",
  "Pose Atlas", "Costume Atlas", "Portrait Atlas",
  "ポーズ図鑑", "衣装図鑑", "ポートレート図鑑",
]);

// 输出端口方案：按「序号 + 类型」匹配，不受端口名被翻译的影响
const ATLAS_OUTPUT_PLAN = [
  { type: "IMAGE", name: "image" },
  { type: "MASK", name: "mask" },
  { type: "PA_PROMPT_LINK", name: "智能连接提示词" },
  { type: "STRING", name: "info" },
];
const SMART_OUTPUT_PLAN = [
  { type: "STRING", name: "提示词" },
  { type: "IMAGE", name: "拼图" },
];

/** 把下拉框的值按界面语言翻译（任何语言的值都能认出来）。认不出就原样返回。 */
function translateComboValue(widgetName, value, lang) {
  const table = COMBO_I18N[widgetName];
  if (!table || value == null) return value;
  const str = String(value);
  for (const code of Object.keys(table)) {
    const idx = table[code].indexOf(str);
    if (idx !== -1) return table[lang][idx];
  }
  return str;
}

/** 把一个节点的标题 / 控件标签 / 端口名应用成当前语言。返回是否有改动。 */
function applyNodeLang(node) {
  if (!node) return false;
  const lang = store.lang;
  let changed = false;

  // 标题：只覆盖「默认标题」或我们上次写入的标题；用户自己改名过的节点不动
  const titles = NODE_I18N[node.type];
  if (titles) {
    const want = titles[lang] || titles.zh;
    if (!node.__paTitleApplied || node.title === node.__paTitleApplied) {
      if (node.title !== want) changed = true;
      node.title = want;
      node.__paTitleApplied = want;
    }
  }

  // 控件标签：widget.name 是工作流 key，保持不变；只换显示用的 label
  // 注意：新前端的 widget 是访问器对象，label 不一定是自有属性，delete 不可靠，
  // 所以中文模式直接把 label 设回 name 本身。
  const portNames = PORT_I18N[lang] || {};
  // 「浏览图库」按钮跟着切语言（按钮不序列化，按三语文案反查它）
  const pickerSpec = PREVIEW_SPECS[node.type];
  if (pickerSpec) {
    const key = `picker${pickerSpec.atlas[0].toUpperCase()}${pickerSpec.atlas.slice(1)}`;
    const want = t(key);
    for (const w of node.widgets || []) {
      if (!w || w.type !== "button" || !PICKER_LABELS.has(w.name)) continue;
      if ((w.label ?? w.name) !== want) changed = true;
      w.label = want;
    }
  }
  for (const w of node.widgets || []) {
    if (!w || !w.name || w.type === "button") continue;
    if (!WIDGET_I18N_KEYS.has(w.name)) continue;
    const want = (WIDGET_I18N[lang] && WIDGET_I18N[lang][w.name]) || w.name;
    const cur = w.label ?? w.name;
    if (cur !== want) changed = true;
    w.label = want;

    // 这四个下拉框的「选项列表 + 当前值」一起翻译（值翻译 = 输出内容跟着切语言；
    // Python 端会把任何语言的值归一回中文标准值，序列化兼容）
    const table = COMBO_I18N[w.name];
    if (table) {
      const wantValues = table[lang] || table.zh;
      if (w.options && Array.isArray(w.options.values)) {
        w.options.values = wantValues.slice();
      }
      const translated = translateComboValue(w.name, w.value, lang);
      if (translated !== w.value) {
        w.value = translated;
        changed = true;
      }
    }
    // 「语言」控件跟界面总开关同步（仍可手动改，只影响该节点输出）
    if (w.name === "语言" && w.value !== LANG_WIDGET_VALUE[lang]) {
      w.value = LANG_WIDGET_VALUE[lang];
      changed = true;
    }
  }

  // 输入端口名（连接 1–6 这类纯连线端口）：name 是标准值不动，显示走 label
  for (const inp of node.inputs || []) {
    if (!inp || inp.widget || !inp.name) continue;
    if (!/^连接 \d+$/.test(inp.name)) continue;
    const want = (WIDGET_I18N[lang] && WIDGET_I18N[lang][inp.name]) || inp.name;
    const cur = inp.label ?? inp.name;
    if (cur !== want) changed = true;
    inp.label = want;
  }

  // 输出端口名：按「序号 + 类型」匹配（端口名被翻译过也不会错位），
  // name 重置回中文标准值（序列化稳定），显示文本放 label
  const plan = ATLAS_NODE_TYPES.has(node.type)
    ? ATLAS_OUTPUT_PLAN
    : node.type === NODE_SMART_PROMPT
      ? SMART_OUTPUT_PLAN
      : null;
  if (plan) {
    (node.outputs || []).forEach((o, i) => {
      if (!o) return;
      const spec = plan[i] || plan.find((p) => p.type === o.type);
      if (!spec) return;
      if (o.name !== spec.name) {
        o.name = spec.name;
        changed = true;
      }
      const wantLabel = portNames[spec.name] || spec.name;
      if ((o.label ?? o.name) !== wantLabel) changed = true;
      o.label = wantLabel;
    });
  }
  return changed;
}

/** 画布上所有我们的节点都应用一遍当前语言（切换语言时调用）。 */
function applyAllNodeLang() {
  try {
    const graph = app.graph;
    const nodes = (graph && (graph._nodes || graph.nodes)) || [];
    let changed = false;
    for (const n of nodes) changed = applyNodeLang(n) || changed;
    if (changed) app.canvas?.setDirtyCanvas?.(true, true);
  } catch (err) {
    console.warn(LOG, "节点语言切换失败", err);
  }
}


function mediaUrl(relPath) {
  const clean = String(relPath || "").replace(/^\/+/, "");
  return api.apiURL(`/poseatlas/media/${clean}`);
}

function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let styleLink = null;

function ensureStyle() {
  if (styleLink && styleLink.isConnected) return;
  styleLink = document.createElement("link");
  styleLink.rel = "stylesheet";
  styleLink.href = CSS_URL;
  styleLink.dataset.poseatlas = "1";
  document.head.appendChild(styleLink);
}

/* ------------------------------------------------------------------ 数据 */
const dataPromises = {};

function loadAtlas(key) {
  const def = ATLAS[key];
  if (!def) return Promise.reject(new Error(`未知图集 ${key}`));
  const container = store.atlases[key];
  if (container?.ready) return Promise.resolve(container);
  if (dataPromises[key]) return dataPromises[key];

  dataPromises[key] = api
    .fetchApi(def.api)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const built = key === "pose" ? ingestPose(data) : key === "costume" ? ingestCostume(data) : ingestPortrait(data);
      store.atlases[key] = built;
      return built;
    })
    .catch((err) => {
      dataPromises[key] = null;
      throw err;
    });
  return dataPromises[key];
}

/** 通用条目形态：{ id, no, series, category, names, variants:[{angle,full,thumb}], _hay } */
function makeHay(parts) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function singleVariant(full, thumb) {
  return [{ angle: "full", full: full || thumb || "", thumb: thumb || full || "" }];
}

function ingestPose(data) {
  const poses = (data.poses || []).map((pose) => {
    pose.variants = (pose.variants || []).slice().sort((a, b) => {
      const ia = ANGLE_ORDER.indexOf(a.angle);
      const ib = ANGLE_ORDER.indexOf(b.angle);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    pose._hay = makeHay([
      pose.id,
      pose.no,
      pose.series,
      pose.category,
      pickName(pose, "zh"),
      pickName(pose, "en"),
      pickName(pose, "ja"),
    ]);
    return pose;
  });
  const seriesList = data.series || [];
  const categoryList = data.categories || [];
  const categoriesBySeries = data.categoriesBySeries || {};
  const angleNames = {};
  (data.angles || []).forEach((a) => {
    angleNames[a.key] = a.names || {};
  });
  return {
    ready: true,
    items: poses,
    byId: new Map(poses.map((p) => [p.id, p])),
    chips: seriesList,
    selects: categoryList,
    categoriesBySeries,
    seriesByKey: Object.fromEntries(seriesList.map((s) => [s.key, s])),
    categoryNames: Object.fromEntries(categoryList.map((c) => [c.key, c.names || {}])),
    angleNames,
    data,
  };
}

function ingestCostume(data) {
  const catNames = Object.fromEntries((data.categories || []).map((c) => [c.key, c.names || {}]));
  const groupNames = Object.fromEntries((data.groups || []).map((g) => [g.key, g.names || {}]));
  const tagNames = window.__PA_TAG_NAMES__ || {};

  const items = (data.costumes || []).map((c) => {
    const cat = catNames[c.cat] || {};
    const group = groupNames[c.group] || {};
    const nameOf = (lang) => `${cat[lang] || cat.zh || c.cat}・${group[lang] || group.zh || c.group}`;
    const tags = (c.tags || []).map((tg) => tagNames[tg]?.[store.lang] || tagNames[tg]?.zh || tg);
    return {
      ...c,
      no: c.id,
      series: c.cat,
      category: c.group,
      names: { zh: nameOf("zh"), en: nameOf("en"), ja: nameOf("ja") },
      variants: singleVariant(c.image, c.thumb),
      _tags: tags,
      _hay: makeHay([c.id, c.cat, c.group, c.color, c.main, nameOf("zh"), nameOf("en"), nameOf("ja"), c.tags?.join(" ")]),
    };
  });
  return {
    ready: true,
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    chips: data.categories || [],
    selects: data.groups || [],
    catNames,
    groupNames,
    tagNames,
    data,
  };
}

function ingestPortrait(data) {
  const secNames = Object.fromEntries((data.sections || []).map((s) => [s.key, s.names || {}]));
  const hairNames = Object.fromEntries((data.hairs || []).map((h) => [h.key, h.names || {}]));

  const items = (data.images || []).map((img) => {
    const sec = secNames[img.sec] || {};
    const hair = hairNames[img.hair] || {};
    const nameOf = (lang) => `${sec[lang] || sec.zh || img.sec}・${hair[lang] || hair.zh || img.hair}`;
    return {
      ...img,
      no: img.id,
      series: img.sec,
      category: img.hair,
      names: { zh: nameOf("zh"), en: nameOf("en"), ja: nameOf("ja") },
      variants: singleVariant(img.full, img.thumb),
      _hay: makeHay([img.id, img.sec, img.hair, img.style, nameOf("zh"), nameOf("en"), nameOf("ja")]),
    };
  });
  return {
    ready: true,
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    chips: data.sections || [],
    selects: data.hairs || [],
    secNames,
    hairNames,
    data,
  };
}

/** 衣装/人像标签词典：走 /poseatlas/api/tags（web 目录不暴露 assets/，只能从后端拿） */
async function loadTagNames() {
  if (window.__PA_TAG_NAMES__) return;
  try {
    const res = await api.fetchApi("/poseatlas/api/tags");
    window.__PA_TAG_NAMES__ = res.ok ? await res.json() : {};
  } catch (e) {
    window.__PA_TAG_NAMES__ = {};
  }
}

function variantOf(item, angle) {
  if (!item || !item.variants?.length) return null;
  return item.variants.find((v) => v.angle === angle) || item.variants[0];
}

function thumbOf(item, angle) {
  const v = variantOf(item, angle);
  return v ? mediaUrl(v.thumb || v.full) : "";
}

/** 与 Python 端 label 格式一致：id / series / 名称 */
function itemLabel(item, atlasKey = "pose") {
  if (atlasKey === "pose") {
    return `${item.no} / ${item.series} / ${pickName(item) || item.id}`;
  }
  // 衣装 / 人像用中文段，Python 端按第一段 id 解析，语言不影响
  return `${item.id} / ${item.series} / ${item.names.zh || item.id}`;
}

function chipLabel(atlasKey, key) {
  const c = store.atlases[atlasKey];
  if (atlasKey === "pose") {
    const s = c?.seriesByKey?.[key];
    if (!s) return key;
    return s.short?.[store.lang] || s.short?.en || pickName(s);
  }
  const hit = c?.chips?.find((x) => x.key === key);
  return hit ? pickName(hit) : key;
}

function selectOptionLabel(atlasKey, key) {
  const c = store.atlases[atlasKey];
  const hit = c?.selects?.find((x) => x.key === key);
  return hit ? pickName(hit) : key;
}

function angleLabel(key) {
  const names = store.atlases.pose?.angleNames?.[key];
  return names ? names[store.lang] || names.en || names.zh || key : key;
}

/** 侧边栏 tab 按钮的标题 / 提示跟随语言切换。
 *  registerSidebarTab 的 title 是注册时一次性写入的，切换语言后从
 *  extensionManager.sidebarTab.sidebarTabs（Vue 响应式数组）里拿回同一个
 *  tab 对象的代理，直接改 title / tooltip 即可让按钮文字实时更新。 */
function refreshSidebarTabLang() {
  try {
    const svc = app.extensionManager?.sidebarTab;
    const tabs = svc?.sidebarTabs;
    if (!tabs || typeof tabs.find !== "function") return;
    const tab = tabs.find((x) => x && x.id === TAB_ID);
    if (!tab) return;
    const wantTitle = t("tabTitle");
    const wantTooltip = t("tabTooltip");
    if (tab.title !== wantTitle) tab.title = wantTitle;
    if (wantTooltip && tab.tooltip !== wantTooltip) tab.tooltip = wantTooltip;
  } catch (err) {
    console.warn(LOG, "侧边栏标题切换失败", err);
  }
}

function setLang(lang) {
  if (!I18N[lang] || lang === store.lang) return;
  store.lang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch (e) {
    /* ignore */
  }
  Array.from(store.panels).forEach((panel) => {
    try {
      panel.refresh();
    } catch (err) {
      console.warn(LOG, err);
    }
  });
  // 画布上的节点标题 / 控件标签 / 端口名同步切换
  applyAllNodeLang();
  // 侧边栏按钮下方的文字同步切换
  refreshSidebarTabLang();
}

/* ------------------------------------------------------------------ 图库面板 */
function createPanel({ target = null, atlas = null } = {}) {
  const lockedAtlas = target ? atlasOfNode(target) : null;
  const filter = {
    atlas: lockedAtlas || atlas || store.atlas || "pose",
    chips: "all",
    select: "all",
    q: "",
  };
  let visible = [];
  let searchTimer = null;

  const root = document.createElement("div");
  root.className = "pa-root";
  root.innerHTML = `
    <div class="pa-head">
      <div class="pa-title-row">
        <span class="pa-title"></span>
        <span class="pa-count"></span>
        <div class="pa-langs">
          <button type="button" data-lang="zh">中</button>
          <button type="button" data-lang="en">EN</button>
          <button type="button" data-lang="ja">日</button>
        </div>
      </div>
      <div class="pa-tabs" role="tablist">
        <button type="button" data-atlas="pose"></button>
        <button type="button" data-atlas="costume"></button>
        <button type="button" data-atlas="portrait"></button>
      </div>
      <input class="pa-search" type="search" spellcheck="false" />
      <div class="pa-chips pa-series"></div>
      <select class="pa-select pa-category"></select>
    </div>
    <div class="pa-body"><div class="pa-grid"></div></div>`;

  const $ = (sel) => root.querySelector(sel);
  const countEl = $(".pa-count");
  const searchEl = $(".pa-search");
  const chipsEl = $(".pa-series");
  const catEl = $(".pa-category");
  const gridEl = $(".pa-grid");
  const bodyEl = $(".pa-body");
  const tabsEl = $(".pa-tabs");

  if (lockedAtlas) tabsEl.style.display = "none"; // 从节点进来时锁定图集

  const def = () => ATLAS[filter.atlas];
  const container = () => store.atlases[filter.atlas];

  function renderTabs() {
    tabsEl.querySelectorAll("button").forEach((btn) => {
      const key = btn.dataset.atlas;
      btn.textContent = t(`atlas${key[0].toUpperCase()}${key.slice(1)}`);
      btn.classList.toggle("is-on", key === filter.atlas);
    });
  }

  function renderChips() {
    const c = container();
    const list = c?.chips || [];
    const items = [{ key: "all", label: t("all") }].concat(
      list.map((s) => ({ key: s.key, label: chipLabel(filter.atlas, s.key) }))
    );
    chipsEl.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="pa-chip${filter.chips === it.key ? " is-on" : ""}" ` +
          `data-key="${esc(it.key)}">${esc(it.label)}</button>`
      )
      .join("");
  }

  function renderSelect() {
    const c = container();
    let keys = (c?.selects || []).map((s) => s.key);
    if (filter.atlas === "pose" && filter.chips !== "all") {
      const narrowed = c?.categoriesBySeries?.[filter.chips];
      if (narrowed) keys = narrowed;
    }
    if (filter.select !== "all" && !keys.includes(filter.select)) filter.select = "all";

    const label = t(`selectLabel${filter.atlas[0].toUpperCase()}${filter.atlas.slice(1)}`);
    catEl.innerHTML =
      `<option value="all">${esc(label)}：${esc(t("all"))}</option>` +
      keys.map((k) => `<option value="${esc(k)}">${esc(selectOptionLabel(filter.atlas, k))}</option>`).join("");
    catEl.value = filter.select;
  }

  function applyFilter() {
    const c = container();
    const q = filter.q.trim().toLowerCase();
    const items = c?.items || [];
    visible = items.filter((item) => {
      if (filter.chips !== "all" && item.series !== filter.chips) return false;
      if (filter.select !== "all" && item.category !== filter.select) return false;
      if (q && !item._hay.includes(q)) return false;
      return true;
    });
    renderGrid();
    const fmt = (n) => Number(n || 0).toLocaleString();
    const counter = t(`count${filter.atlas[0].toUpperCase()}${filter.atlas.slice(1)}`);
    if (filter.atlas === "pose") {
      countEl.textContent = counter(fmt(c?.data?.totals?.poses ?? items.length), fmt(c?.data?.totals?.images ?? 0));
    } else {
      countEl.textContent = counter(fmt(items.length));
    }
  }

  function renderGrid() {
    gridEl.innerHTML = "";
    if (!visible.length) {
      gridEl.innerHTML = `<div class="pa-empty">${esc(t("empty"))}</div>`;
      return;
    }
    const cls = def().cardClass;
    const frag = document.createDocumentFragment();
    visible.forEach((item) => {
      // div + role=button：卡片里要嵌悬浮的「插入节点」按钮，button 套 button 不合法
      const card = document.createElement("div");
      card.className = `pa-card${cls ? ` ${cls}` : ""}`;
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.dataset.id = item.id;
      card.innerHTML =
        `<span class="pa-shot">` +
        `<img loading="lazy" decoding="async" src="${esc(thumbOf(item))}" alt="">` +
        `<span class="pa-no">${esc(item.no || item.id || "")}</span>` +
        `<span class="pa-quick">${esc(t("quickInsert"))}</span>` +
        `</span>` +
        `<span class="pa-name">${esc(pickName(item))}</span>`;
      frag.appendChild(card);
    });
    gridEl.appendChild(frag);
  }

  async function switchAtlas(key) {
    if (!ATLAS[key] || key === filter.atlas) return;
    filter.atlas = key;
    filter.chips = "all";
    filter.select = "all";
    searchEl.value = "";
    filter.q = "";
    gridEl.innerHTML = "";
    renderTabs();
    renderChips();
    renderSelect();
    try {
      await ensureAtlasData(key);
    } catch (err) {
      showPanelError(panel, err);
      return;
    }
    applyFilter();
    bodyEl.scrollTop = 0;
  }

  async function ensureAtlasData(key) {
    if (key === "costume") await loadTagNames();
    await loadAtlas(key);
  }

  searchEl.addEventListener("input", () => {
    filter.q = searchEl.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilter, 120);
  });

  chipsEl.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".pa-chip");
    if (!chip) return;
    filter.chips = chip.dataset.key || "all";
    filter.select = "all";
    renderChips();
    renderSelect();
    applyFilter();
    bodyEl.scrollTop = 0;
  });

  catEl.addEventListener("change", () => {
    filter.select = catEl.value || "all";
    applyFilter();
    bodyEl.scrollTop = 0;
  });

  tabsEl.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-atlas]");
    if (btn) switchAtlas(btn.dataset.atlas);
  });

  $(".pa-langs").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-lang]");
    if (btn) setLang(btn.dataset.lang);
  });

  gridEl.addEventListener("click", (ev) => {
    const card = ev.target.closest(".pa-card");
    if (!card) return;
    const item = container()?.byId.get(card.dataset.id);
    if (!item) return;
    // 悬浮按钮：直接插入节点，不进灯箱
    if (ev.target.closest(".pa-quick")) {
      ev.stopPropagation();
      try {
        insertAtlasItem(filter.atlas, item, item.variants[0]?.angle);
        if (modalEl) closeModal(); // 从弹窗图鉴里快捷插入后把弹窗一起收掉
      } catch (err) {
        console.error(LOG, err);
        window.alert?.(String(err?.message || err));
      }
      return;
    }
    openLightbox({ atlas: filter.atlas, item, list: visible, target });
  });

  function syncLangButtons() {
    root.querySelectorAll(".pa-langs button").forEach((b) => {
      b.classList.toggle("is-on", b.dataset.lang === store.lang);
    });
  }

  const panel = {
    root,
    get atlas() {
      return filter.atlas;
    },
    refresh() {
      $(".pa-title").textContent = t("tabTitle");
      searchEl.placeholder = t(`search${filter.atlas[0].toUpperCase()}${filter.atlas.slice(1)}`);
      syncLangButtons();
      renderTabs();
      renderChips();
      renderSelect();
      applyFilter();
    },
    async ensure() {
      await ensureAtlasData(filter.atlas);
    },
    destroy() {
      clearTimeout(searchTimer);
      store.panels.delete(panel);
      root.remove();
    },
  };

  store.panels.add(panel);
  syncLangButtons();
  return panel;
}

/* ------------------------------------------------------------------ 灯箱 */
let lightboxEl = null;
let lightboxState = null;

function closeLightbox() {
  if (!lightboxEl) return;
  document.removeEventListener("keydown", onLightboxKey, true);
  lightboxEl.remove();
  lightboxEl = null;
  lightboxState = null;
  document.body.classList.remove("pa-lightbox-open");
}

function onLightboxKey(ev) {
  const st = lightboxState;
  if (!st) return;
  const key = ev.key;

  if (key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    closeLightbox();
    return;
  }

  const angles = st.item.variants.map((v) => v.angle);
  const ai = Math.max(0, angles.indexOf(st.angle));

  if ((key === "ArrowRight" || key === "ArrowLeft") && angles.length > 1) {
    ev.preventDefault();
    ev.stopPropagation();
    const step = key === "ArrowRight" ? 1 : -1;
    st.angle = angles[(ai + step + angles.length) % angles.length];
    syncLightbox();
    return;
  }

  if ((key === "ArrowDown" || key === "ArrowUp") && st.list && st.list.length > 1) {
    ev.preventDefault();
    ev.stopPropagation();
    stepItem(key === "ArrowDown" ? 1 : -1);
    return;
  }

  if (key === "Enter" && !String(ev.target?.tagName || "").match(/INPUT|TEXTAREA|SELECT/)) {
    ev.preventDefault();
    confirmPick();
  }
}

function openLightbox({ atlas = "pose", item, list = null, target = null, angle = null }) {
  ensureStyle();
  closeLightbox();

  const index = list ? list.findIndex((p) => p.id === item.id) : -1;
  lightboxState = {
    atlas,
    item,
    angle: angle || item.variants[0]?.angle || "full",
    list,
    index: index < 0 ? 0 : index,
    target,
  };

  lightboxEl = document.createElement("div");
  lightboxEl.className = "pa-lightbox";
  lightboxEl.innerHTML = `
    <div class="pa-lb-panel pa-root" role="dialog" aria-modal="true">
      <div class="pa-lb-head">
        <div class="pa-lb-title">
          <strong class="pa-lb-name"></strong>
          <span class="pa-lb-sub"></span>
        </div>
        <div class="pa-lb-actions">
          <button type="button" class="pa-btn pa-btn-primary pa-pick"></button>
          <a class="pa-btn pa-dl" target="_blank" rel="noopener"></a>
          <button type="button" class="pa-btn pa-btn-icon pa-close" aria-label="close">✕</button>
        </div>
      </div>
      <div class="pa-lb-body">
        <div class="pa-lb-stage">
          <button type="button" class="pa-nav prev" aria-label="previous">‹</button>
          <img class="pa-lb-img" alt="">
          <button type="button" class="pa-nav next" aria-label="next">›</button>
        </div>
        <div class="pa-lb-side">
          <div class="pa-lb-angles">
            <div class="pa-side-label pa-angles-label"></div>
            <div class="pa-angle-list"></div>
          </div>
          <div>
            <div class="pa-side-label pa-info-label"></div>
            <div class="pa-meta"></div>
          </div>
          <div class="pa-hint"></div>
        </div>
      </div>
    </div>`;

  const $ = (sel) => lightboxEl.querySelector(sel);

  lightboxEl.addEventListener("click", (ev) => {
    if (ev.target === lightboxEl) closeLightbox();
  });
  $(".pa-close").addEventListener("click", closeLightbox);
  $(".pa-pick").addEventListener("click", confirmPick);
  $(".pa-nav.prev").addEventListener("click", () => stepItem(-1));
  $(".pa-nav.next").addEventListener("click", () => stepItem(1));
  $(".pa-angle-list").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".pa-angle");
    if (!btn) return;
    lightboxState.angle = btn.dataset.angle;
    syncLightbox();
  });

  document.body.appendChild(lightboxEl);
  document.body.classList.add("pa-lightbox-open");
  document.addEventListener("keydown", onLightboxKey, true);

  syncLightbox();
}

function stepItem(step) {
  const st = lightboxState;
  if (!st || !st.list || st.list.length < 2) return;
  st.index = (st.index + step + st.list.length) % st.list.length;
  st.item = st.list[st.index];
  st.angle = st.item.variants[0]?.angle || "full";
  syncLightbox();
}

function syncLightbox() {
  const st = lightboxState;
  if (!st || !lightboxEl) return;
  const { item, atlas } = st;
  const v = variantOf(item, st.angle);
  if (v) st.angle = v.angle;

  const $ = (sel) => lightboxEl.querySelector(sel);
  const subParts = [];
  if (item.series) subParts.push(chipLabel(atlas, item.series));
  if (item.category) subParts.push(selectOptionLabel(atlas, item.category));
  // 多角度只有姿势图鉴有；单图图集把角度区整块藏掉
  const hasAngles = item.variants.length > 1;

  $(".pa-lb-name").textContent = `${item.no || item.id} · ${pickName(item)}`;
  $(".pa-lb-sub").textContent = subParts.join(" · ");

  const img = $(".pa-lb-img");
  img.src = mediaUrl(v?.full || v?.thumb || "");
  img.alt = pickName(item);

  $(".pa-pick").textContent = st.target ? t("use") : t("insert");

  const dl = $(".pa-dl");
  const fullPath = v?.full || v?.thumb || "";
  dl.href = mediaUrl(fullPath);
  dl.setAttribute("download", fullPath.split("/").pop() || "image.png");
  dl.textContent = t("download");

  $(".pa-info-label").textContent = t("info");
  $(".pa-hint").innerHTML = t("hint")
    .filter(([keys]) => hasAngles || keys !== "← →")
    .map(([keys, label]) => `<div><kbd>${esc(keys)}</kbd> ${esc(label)}</div>`)
    .join("");

  lightboxEl.querySelector(".pa-lb-angles").style.display = hasAngles ? "" : "none";
  if (hasAngles) {
    $(".pa-angles-label").textContent = t("angles");
    $(".pa-angle-list").innerHTML = item.variants
      .map(
        (variant) =>
          `<button type="button" class="pa-angle${variant.angle === st.angle ? " is-on" : ""}" ` +
          `data-angle="${esc(variant.angle)}" title="${esc(angleLabel(variant.angle))}">` +
          `<img loading="lazy" decoding="async" src="${esc(mediaUrl(variant.thumb || variant.full))}" alt="">` +
          `<span>${esc(angleLabel(variant.angle))}</span>` +
          `</button>`
      )
      .join("");
  }

  const meta = [];
  if (atlas === "pose") {
    meta.push(
      [t("angles"), angleLabel(st.angle)],
      [t("seriesLabel"), chipLabel(atlas, item.series)],
      [t("categoryLabel"), selectOptionLabel(atlas, item.category)],
      ["ID", item.id],
      ["size", "900 × 1200"]
    );
  } else if (atlas === "costume") {
    const c = store.atlases.costume;
    const tags = item._tags || [];
    meta.push(
      [t("categoryLabel"), chipLabel(atlas, item.series)],
      [t("groupLabel"), selectOptionLabel(atlas, item.category)],
      [t("colorLabel"), c?.tagNames?.[item.color]?.[store.lang] || item.color || ""],
      [t("mainLabel"), c?.tagNames?.[item.main]?.[store.lang] || item.main || ""],
      [t("tagsLabel"), tags.slice(0, 6).join("、") + (tags.length > 6 ? "…" : "")],
      ["ID", item.id],
      ["size", "1366 × 2048"]
    );
  } else {
    const p = store.atlases.portrait;
    meta.push(
      [t("sectionLabel"), chipLabel(atlas, item.series)],
      [t("hairLabel"), selectOptionLabel(atlas, item.category)],
      item.style ? [t("styleLabel"), item.style] : null,
      ["ID", item.id]
    );
    void p;
  }
  if (st.list && st.list.length > 1) meta.push(["#", `${st.index + 1} / ${st.list.length}`]);

  $(".pa-meta").innerHTML = meta
    .filter(Boolean)
    .map(([k, val]) => `<div><span>${esc(k)}</span><b>${esc(val)}</b></div>`)
    .join("");

  const hide = !st.list || st.list.length < 2;
  lightboxEl.querySelectorAll(".pa-nav").forEach((n) => {
    n.style.display = hide ? "none" : "";
  });
}

function confirmPick() {
  const st = lightboxState;
  if (!st) return;
  try {
    if (st.target) {
      applyToNode(st.target, st.item, st.angle);
      closeLightbox();
      // 从节点按钮进来的弹窗也要一起关掉
      closeModal();
    } else {
      insertAtlasItem(st.atlas, st.item, st.angle);
      closeLightbox();
    }
  } catch (err) {
    console.error(LOG, err);
    window.alert?.(String(err?.message || err));
  }
}

/* ------------------------------------------------------------------ 节点操作 */
function findWidget(node, names) {
  const list = node?.widgets || [];
  for (const name of names) {
    const hit = list.find((item) => item.name === name);
    if (hit) return hit;
  }
  return null;
}

function setWidgetValue(widget, value, node) {
  if (!widget) return;
  widget.value = value;
  // 兼容不同版本前端的 callback 签名，失败也不影响取值
  try {
    widget.callback?.(value, app.canvas, node);
  } catch (e) {
    /* 部分自定义 widget 的 callback 依赖完整画布事件，忽略 */
  }
}

/** 节点类型属于哪个图集（找不到返回 null） */
function atlasOfNode(node) {
  const type = String(node?.type || "");
  for (const def of Object.values(ATLAS)) {
    if (def.nodeTypes.includes(type)) return def.key;
  }
  return null;
}

function applyToNode(node, item, angle) {
  const atlasKey = atlasOfNode(node);
  if (!atlasKey) throw new Error(`节点 ${node.type} 不是 RuiC-PoseAtlas 图库节点`);

  setWidgetValue(findWidget(node, [ATLAS[atlasKey].widget]), itemLabel(item, atlasKey), node);

  if (atlasKey === "pose") {
    const angleWidget = findWidget(node, ["angle", "angles"]);
    const options = angleWidget?.options?.values || [];
    const hasVariant = (a) => !!a && (item.variants || []).some((v) => v.angle === a);
    const cur = String(angleWidget?.value || "").trim();
    let wanted;
    if (node.type === NODE_POSE_ANGLES) {
      // 多视角：all 直接保留；指定角度在新姿态里没有就回落到 all，避免后端报错
      wanted = cur === "all" || hasVariant(cur) ? cur : "all";
    } else {
      // 加载：优先用点击的角度；新姿态没有该角度就依次回落 当前值 → 第一个角度
      wanted = hasVariant(angle) ? angle : hasVariant(cur) ? cur : item.variants?.[0]?.angle || angle;
    }
    if (options.length && !options.includes(wanted)) wanted = options[0];
    setWidgetValue(angleWidget, wanted, node);
  }

  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

/** 找可以复用的同图集节点：当前选中的优先，否则取最近创建的那个 */
function findReuseTarget(atlasKey) {
  const types = ATLAS[atlasKey]?.nodeTypes || [];
  const nodes = app.graph?._nodes || [];
  const candidates = nodes.filter((n) => types.includes(n.type) && !n.mode); // mode 0=正常；过滤掉 muted/bypass
  if (!candidates.length) return null;
  const sel = app.canvas?.selected_nodes;
  const selList = Array.isArray(sel) ? sel : sel ? Object.values(sel) : [];
  const selHit = selList.find((n) => n && candidates.includes(n));
  if (selHit) return selHit;
  return candidates.reduce((a, b) => (Number(a.id) > Number(b.id) ? a : b));
}

/** 复用节点后给它一点存在感：选中；如果不在视口里就居中过来 */
function flashNode(node) {
  try {
    app.canvas?.selectNode?.(node, false);
    const el = app.canvas?.canvas;
    const ds = app.canvas?.ds;
    if (el && ds && node.pos) {
      const w = el.clientWidth || 0;
      const h = el.clientHeight || 0;
      const x1 = -ds.offset[0] / ds.scale;
      const y1 = -ds.offset[1] / ds.scale;
      const [nx, ny] = node.pos;
      const nw = node.size?.[0] || 0;
      const nh = node.size?.[1] || 0;
      const visible =
        nx + nw > x1 && nx < x1 + w / ds.scale && ny + nh > y1 && ny < y1 + h / ds.scale;
      if (!visible) app.canvas.centerOnNode?.(node);
    }
    app.canvas?.setDirty?.(true, true);
  } catch (err) {
    /* ignore */
  }
}

function toastReused(item) {
  try {
    app.extensionManager?.toast?.add?.({
      severity: "info",
      summary: t("reusedTitle"),
      detail: `${item.no || ""} · ${pickName(item)}`.trim(),
      life: 2600,
    });
  } catch (err) {
    /* 旧前端没有 toast 就静默 */
  }
}

function nextNodePos() {
  const canvas = app.canvas;
  const ds = canvas?.ds;
  let pos = canvas?.graph_mouse;
  if (!pos || (!pos[0] && !pos[1])) {
    const el = canvas?.canvas;
    const w = el?.clientWidth || 1000;
    const h = el?.clientHeight || 700;
    pos = ds
      ? [(-ds.offset[0] + w * 0.45) / ds.scale, (-ds.offset[1] + h * 0.32) / ds.scale]
      : [200, 160];
  }
  const n = (app.graph?._nodes?.length || 0) % 6;
  return [Math.round(pos[0] + n * 14), Math.round(pos[1] + n * 14)];
}

function insertAtlasItem(atlasKey, item, angle, { forceNew = false } = {}) {
  // 工作流里已经有同图集节点：只把图写进去，不再新建（选中谁就更新谁，否则更新最近的）
  if (!forceNew) {
    const target = findReuseTarget(atlasKey);
    if (target) {
      applyToNode(target, item, angle);
      flashNode(target);
      toastReused(item);
      return target;
    }
  }

  const LG = globalThis.LiteGraph;
  const nodeType = ATLAS[atlasKey].loadNode;
  if (!LG?.createNode) throw new Error("LiteGraph 不可用，无法创建节点");
  const node = LG.createNode(nodeType);
  if (!node) throw new Error(`节点 ${nodeType} 未注册，请重启 ComfyUI`);
  node.pos = nextNodePos();
  app.graph.add(node);
  applyToNode(node, item, angle);
  app.canvas?.selectNode?.(node, false);
  app.canvas?.setDirty?.(true, true);
  app.graph.setDirtyCanvas(true, true);
  return node;
}

/* ------------------------------------------------------------------ 节点内预览 */
/**
 * 给四个 Load 类节点挂一个 DOM widget 预览区，
 * 选中条目（不必运行工作流）就用 /poseatlas/media/* 的图显示出来。
 */

/** 把 widget 的值解析回图鉴条目 */
function resolveItemByLabel(atlasKey, label) {
  const c = store.atlases[atlasKey];
  if (!c || !label) return null;
  const text = String(label).trim();
  if (!text) return null;

  if (atlasKey === "pose") {
    const parts = text.split("/").map((s) => s.trim());
    if (parts.length >= 2) {
      const hit = c.items.find((p) => p.no === parts[0] && p.series === parts[1]);
      if (hit) return hit;
    }
    return (
      c.items.find((p) => p.id === text) ||
      c.items.find((p) =>
        [pickName(p, "zh"), pickName(p, "en"), pickName(p, "ja")].some((n) => n && n === text)
      ) ||
      c.items.find((p) => p.no && parts[0] && p.no === parts[0]) ||
      null
    );
  }

  // 衣装 / 人像：label 第一段就是 id
  const first = text.split("/")[0].trim();
  return c.byId.get(first) || c.byId.get(first.toUpperCase()) || c.byId.get(first.toLowerCase()) || null;
}

function refreshPreview(node) {
  const pv = node?.__paPreview;
  if (!pv) return;

  const spec = PREVIEW_SPECS[node.type];
  if (!spec) return;
  const atlasKey = spec.atlas;

  // 图鉴数据还没到就先等一次，到了再画
  const c = store.atlases[atlasKey];
  if (!c?.ready) {
    if (pv.waiting) return;
    pv.waiting = true;
    loadAtlas(atlasKey)
      .then(() => {
        pv.waiting = false;
        refreshPreview(node);
      })
      .catch(() => {
        pv.waiting = false;
      });
    return;
  }

  const item = resolveItemByLabel(atlasKey, findWidget(node, [ATLAS[atlasKey].widget])?.value);
  const el = pv.el;

  if (!item || !item.variants?.length) {
    if (pv._key) el.innerHTML = "";
    pv._key = "";
    node.__paVariantCount = 0;
    node.setDirtyCanvas?.(true, true);
    return;
  }

  if (spec.mode === "single") {
    const angleVal = String(findWidget(node, ["angle"])?.value || "").trim();
    const v = variantOf(item, angleVal) || item.variants[0];
    const key = `${item.id}|${v.angle}`;
    if (pv._key === key) return;
    pv._key = key;
    node.__paVariantCount = 1;
    const tag = atlasKey === "pose" ? angleLabel(v.angle) : pickName(item);
    el.innerHTML =
      `<div class="pa-np" title="${esc(pickName(item))}">` +
      `<img decoding="async" src="${esc(mediaUrl(v.full || v.thumb))}" alt="">` +
      `<span class="pa-np-tag">${esc(tag)}</span></div>`;
  } else {
    const raw = String(findWidget(node, ["angles"])?.value || "").trim().toLowerCase();
    const selected = raw === "all" ? null : raw.split(/[,\s]+/).filter(Boolean);
    const key = `${item.id}|${raw}`;
    if (pv._key === key) return;
    pv._key = key;
    node.__paVariantCount = item.variants.length;
    el.innerHTML = item.variants
      .map((variant) => {
        const on = !selected || selected.includes(variant.angle.toLowerCase());
        return (
          `<div class="pa-np${on ? " is-on" : ""}" data-angle="${esc(variant.angle)}" ` +
          `title="${esc(angleLabel(variant.angle))}">` +
          `<img decoding="async" src="${esc(mediaUrl(variant.thumb || variant.full))}" alt="">` +
          `<span class="pa-np-tag">${esc(angleLabel(variant.angle))}</span></div>`
        );
      })
      .join("");
  }

  applyPreviewHeight(node);
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function previewHeight(node) {
  const spec = PREVIEW_SPECS[node.type];
  if (!spec) return 120;
  if (spec.mode === "strip") return 150; // 多视角 = 固定高度的一排角度缩略图
  // 单图：跟随节点宽度，按图集自己的宽高比撑高
  const w = Number(node?.size?.[0]) || 320;
  const h = Math.round((w - 40) / spec.ratio);
  return Math.min(Math.max(h, 180), 520);
}

function applyPreviewHeight(node) {
  const h = previewHeight(node);
  const state = node.__paPreview;
  const el = state?.el;
  if (!el) return;
  // 新版前端从元素上的 CSS 变量读取 DOM widget 高度
  el.style.setProperty("--comfy-widget-min-height", `${h}px`);
  el.style.setProperty("--comfy-widget-max-height", `${h}px`);
  el.style.setProperty("--comfy-widget-height", `${h}px`);
  clampWidgetLayer(node, state.widget, el);
}

/**
 * DOM widget 层尺寸保护。
 * 前端每帧用 `widget.width ?? node.width` 决定层的宽度：某些状态下 widget 上会残留
 * 旧的 width（或绑定错乱），层就会比节点宽，预览图直接画出节点外。
 * 这里在节点绘制时把层宽钳回节点宽度，并清掉残留的 widget.width。
 */
function clampWidgetLayer(node, widget, el) {
  if (!node || !el) return;
  const layer = el.parentElement;
  if (!layer || !layer.style) return;
  if (widget && widget.width != null) widget.width = undefined;
  const m = (Number(widget?.margin) || 10) * 2;
  const targetW = Math.max(60, node.size[0] - m);
  const curW = parseFloat(layer.style.width);
  if (!isNaN(curW) && Math.abs(curW - targetW) > 1) layer.style.width = `${targetW}px`;
}

/** 每帧钳一次层宽，节点画到哪层就跟到哪 */
function hookWidgetLayerClamp(nodeType) {
  const onDrawForeground = nodeType.prototype.onDrawForeground;
  nodeType.prototype.onDrawForeground = function (...args) {
    const r = onDrawForeground?.apply(this, arguments);
    try {
      clampWidgetLayer(this, this.__paPreview?.widget, this.__paPreview?.el);
      clampWidgetLayer(this, this.__paPrompt?.widget, this.__paPrompt?.el);
    } catch (err) {
      /* 尺寸保护失败不影响绘制 */
    }
    return r;
  };
}

/** 加载旧工作流时节点存的高度可能装不下预览，撑到能装下（只放大不缩小） */
function fitNodeToWidgets(node) {
  try {
    const need = node.computeSize?.();
    if (need && need[1] > node.size[1] + 0.5) {
      node.size[1] = need[1];
      node.setDirtyCanvas?.(true, true);
    }
  } catch (err) {
    /* ignore */
  }
}

function hookPreviewWidget(node, nodeKind) {
  node.__paKind = nodeKind;
  const spec = PREVIEW_SPECS[nodeKind];
  if (!spec) return;

  try {
    if (typeof node.addDOMWidget !== "function") {
      console.warn(LOG, "当前前端不支持 addDOMWidget，跳过节点内预览");
      return;
    }
    const el = document.createElement("div");
    el.className = "pa-npreview";
    const widget = node.addDOMWidget("pose_preview", "PoseAtlasPreview", el, {
      serialize: false,
      hideOnZoom: false,
      // 新版前端（Vue DOM widget 层）用这两个回调决定槽位高度
      getMinHeight: () => previewHeight(node),
      getMaxHeight: () => previewHeight(node),
    });
    widget.serialize = false;
    if (widget.options) widget.options.serialize = false;
    // 旧版前端走 computeSize
    if (widget.computeSize) {
      widget.computeSize = (width) => [width, previewHeight(node)];
    }

    node.__paPreview = { el, widget, waiting: false, _key: "" };
    applyPreviewHeight(node);

    // 加载节点：点预览直接打开选图弹窗；多视角节点：点缩略图切换 angles
    el.addEventListener("click", (ev) => {
      const np = ev.target.closest(".pa-np");
      if (!np) return;
      if (spec.mode === "single") {
        openModal({ target: node });
        return;
      }
      const angle = np.dataset.angle;
      const w = angle && findWidget(node, ["angles"]);
      if (w) {
        setWidgetValue(w, angle, node);
        node.setDirtyCanvas?.(true, true);
      }
    });
  } catch (err) {
    console.warn(LOG, "添加节点内预览失败", err);
    return;
  }

  // widget 值变化时刷新预览
  const widgetNames =
    spec.mode === "strip" ? ["pose", "angles"] : spec.atlas === "pose" ? ["pose", "angle"] : [ATLAS[spec.atlas].widget];
  widgetNames.forEach((name) => {
    const w = (node.widgets || []).find((x) => x.name === name);
    if (!w) return;
    const orig = w.callback;
    w.callback = function (...args) {
      const r = orig?.apply(this, args);
      try {
        refreshPreview(node);
      } catch (e) {
        /* 预览失败不影响主流程 */
      }
      return r;
    };
  });

  refreshPreview(node);
}

/* ---------------------------------------------------- 智能连接提示词 · 文本预览 */
const PROMPT_PREVIEW_MIN = 78;
const PROMPT_PREVIEW_MAX = 340;

function applyPromptHeight(node) {
  const state = node.__paPrompt;
  const el = state?.el;
  if (!el) return;
  el.style.setProperty("--comfy-widget-min-height", `${state.height}px`);
  el.style.setProperty("--comfy-widget-max-height", `${state.height}px`);
  el.style.setProperty("--comfy-widget-height", `${state.height}px`);
  clampWidgetLayer(node, state.widget, el);
}

function setPromptPreview(node, payload = {}) {
  const state = node.__paPrompt;
  if (!state) return;
  if (Array.isArray(payload.slots)) {
    state.slotsEl.textContent = "";
    if (payload.slots.length) {
      payload.slots.forEach((text) => {
        const chip = document.createElement("span");
        chip.className = "pa-ppreview__chip";
        chip.textContent = text;
        state.slotsEl.appendChild(chip);
      });
    } else {
      state.slotsEl.textContent = "";
    }
  }
  if (typeof payload.text === "string") {
    state.text = payload.text;
    state.textEl.textContent = payload.text || "（没有接到图库节点：把图库节点的「智能连接提示词」端口拉进来）";
    state.copyEl.style.display = payload.text ? "" : "none";
  }
  const h = Math.min(Math.max(Math.ceil(state.el.scrollHeight || PROMPT_PREVIEW_MIN) + 8, PROMPT_PREVIEW_MIN), PROMPT_PREVIEW_MAX);
  if (h !== state.height) {
    state.height = h;
    applyPromptHeight(node);
    node.setDirtyCanvas?.(true, true);
  }
}

function addPromptPreview(node) {
  if (typeof node.addDOMWidget !== "function") {
    console.warn(LOG, "当前前端不支持 addDOMWidget，跳过提示词预览");
    return;
  }
  const el = document.createElement("div");
  el.className = "pa-ppreview";

  const headEl = document.createElement("div");
  headEl.className = "pa-ppreview__head";
  const slotsEl = document.createElement("div");
  slotsEl.className = "pa-ppreview__slots";
  const copyEl = document.createElement("button");
  copyEl.type = "button";
  copyEl.className = "pa-ppreview__copy";
  copyEl.textContent = "复制";
  copyEl.style.display = "none";
  const textEl = document.createElement("div");
  textEl.className = "pa-ppreview__text";
  textEl.textContent = "（运行工作流后在这里显示提示词）";

  headEl.append(slotsEl, copyEl);
  el.append(headEl, textEl);

  const state = { el, slotsEl, textEl, copyEl, height: PROMPT_PREVIEW_MIN, text: "" };
  node.__paPrompt = state;

  copyEl.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!state.text) return;
    const done = () => {
      copyEl.textContent = "已复制";
      setTimeout(() => (copyEl.textContent = "复制"), 1200);
    };
    try {
      navigator.clipboard?.writeText(state.text)?.then(done, done) ?? done();
    } catch (err) {
      done();
    }
  });

  const widget = node.addDOMWidget("smart_prompt_preview", "提示词预览", el, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => state.height,
    getMaxHeight: () => state.height,
  });
  widget.serialize = false;
  if (widget.options) widget.options.serialize = false;
  if (widget.computeSize) widget.computeSize = (width) => [width, state.height];
  state.widget = widget;
  applyPromptHeight(node);
}

function syncPromptToggles(node) {
  PROMPT_TOGGLES.forEach(({ watch, when, target }) => {
    const src = findWidget(node, [watch]);
    const dst = findWidget(node, [target]);
    if (!src || !dst) return;
    const show = when.includes(String(src.value));
    dst.hidden = !show;
    try {
      if (dst.element) dst.element.style.display = show ? "" : "none";
      if (dst.inputElement) dst.inputElement.style.display = show ? "" : "none";
    } catch (err) {
      /* 新旧前端字段不同，忽略 */
    }
  });
  node.setDirtyCanvas?.(true, true);
}

function hookSmartPromptNode(nodeType) {
  hookWidgetLayerClamp(nodeType);
  const onNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function (...args) {
    const result = onNodeCreated?.apply(this, args);
    const node = this;
    try {
      applyNodeLang(node);
      addPromptPreview(node);
      normalizePromptCombos(node);
      syncPromptToggles(node);
      ["句式模板", "标签样式"].forEach((name) => {
        const w = findWidget(node, [name]);
        if (!w) return;
        const orig = w.callback;
        w.callback = function (...cbArgs) {
          const r = orig?.apply(this, cbArgs);
          try {
            syncPromptToggles(node);
          } catch (err) {
            /* ignore */
          }
          return r;
        };
      });
    } catch (err) {
      console.warn(LOG, "智能连接提示词节点初始化失败", err);
    }
    return result;
  };

  const onExecuted = nodeType.prototype.onExecuted;
  nodeType.prototype.onExecuted = function (message) {
    const result = onExecuted?.apply(this, arguments);
    try {
      const raw = Array.isArray(message?.text) ? message.text[0] : message?.text;
      setPromptPreview(this, { text: typeof raw === "string" ? raw : "", slots: message?.pa_slots });
    } catch (err) {
      console.warn(LOG, "提示词预览更新失败", err);
    }
    return result;
  };

  const onConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function (...args) {
    const result = onConfigure?.apply(this, args);
    try {
      // 旧工作流恢复后：先把错位的连线拨回新端口，下拉框空值纠成默认，再联动显示
      applyNodeLang(this);
      migratePromptLinks(this);
      normalizePromptCombos(this);
      syncPromptToggles(this);
      fitNodeToWidgets(this);
      const cached = app.nodeOutputs?.[String(this.id)] ?? app.nodeOutputs?.[this.id];
      if (cached?.text) {
        const raw = Array.isArray(cached.text) ? cached.text[0] : cached.text;
        setPromptPreview(this, { text: String(raw), slots: cached.pa_slots });
      }
    } catch (err) {
      /* ignore */
    }
    return result;
  };
}

/* ------------------------------------------------------------------ 弹窗图鉴 */
let modalEl = null;
let modalPanel = null;

function closeModal() {
  if (!modalEl) return;
  modalPanel?.destroy();
  modalEl.remove();
  modalEl = null;
  modalPanel = null;
}

function openModal({ target = null } = {}) {
  ensureStyle();
  closeModal();

  modalEl = document.createElement("div");
  modalEl.className = "pa-modal";
  modalEl.innerHTML = `
    <div class="pa-modal-panel pa-root" role="dialog" aria-modal="true">
      <div class="pa-modal-bar">
        <strong></strong>
        <span class="pa-spacer"></span>
        <button type="button" class="pa-btn pa-btn-icon pa-close" aria-label="close">✕</button>
      </div>
      <div class="pa-modal-body"></div>
    </div>`;

  modalEl.querySelector("strong").textContent = t("modalTitle");
  modalEl.querySelector(".pa-close").addEventListener("click", closeModal);
  modalEl.addEventListener("click", (ev) => {
    if (ev.target === modalEl) closeModal();
  });

  modalPanel = createPanel({ target, atlas: target ? atlasOfNode(target) : null });
  modalEl.querySelector(".pa-modal-body").appendChild(modalPanel.root);
  document.body.appendChild(modalEl);

  modalPanel
    .ensure()
    .then(() => modalPanel?.refresh())
    .catch((err) => showPanelError(modalPanel, err));
}

function showPanelError(panel, err) {
  if (!panel) return;
  console.error(LOG, err);
  const box = document.createElement("div");
  box.className = "pa-error";
  const msg = document.createElement("div");
  msg.textContent = `${t("loadFail")}\n${err?.message || err}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = t("retry");
  btn.addEventListener("click", () => {
    box.remove();
    panel
      .ensure()
      .then(() => panel.refresh())
      .catch((e2) => showPanelError(panel, e2));
  });
  box.append(msg, btn);
  panel.root.querySelector(".pa-body").appendChild(box);
}

/* ------------------------------------------------------------------ 侧边栏 */
function mountSidebarTab(container) {
  ensureStyle();
  container.style.height = "100%";
  container.replaceChildren();
  const panel = createPanel({});
  container.appendChild(panel.root);
  panel
    .ensure()
    .then(() => panel.refresh())
    .catch((err) => showPanelError(panel, err));
  return panel;
}

function mountFab() {
  ensureStyle();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pa-fab";
  btn.title = t("tabTooltip");
  btn.textContent = "P";
  btn.addEventListener("click", () => openModal({}));
  document.body.appendChild(btn);
  return btn;
}

/* ------------------------------------------------------------------ 注册 */
app.registerExtension({
  name: EXT_NAME,

  async beforeRegisterNodeDef(nodeType, nodeData) {
    // 注册时把搜索菜单 / 默认标题翻成当前语言（注册只发生一次，切换语言后要刷新页面才影响新建菜单）
    const titles = NODE_I18N[nodeData?.name];
    if (titles) {
      try {
        nodeData.display_name = titles[store.lang] || titles.zh;
      } catch (err) {
        /* ignore */
      }
    }
    if (nodeData?.name === NODE_SMART_PROMPT) {
      hookSmartPromptNode(nodeType);
      return;
    }
    if (!PICKER_NODES.includes(nodeData?.name)) return;
    const nodeKind = nodeData.name;
    const spec = PREVIEW_SPECS[nodeKind];
    hookWidgetLayerClamp(nodeType);

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      const node = this;
      try {
        applyNodeLang(node);
        const widget = node.addWidget("button", t(`picker${spec.atlas[0].toUpperCase()}${spec.atlas.slice(1)}`), null, () => {
          openModal({ target: node });
        });
        widget.serialize = false;
        if (widget.options) widget.options.serialize = false;
      } catch (err) {
        console.warn(LOG, "添加图库按钮失败", err);
      }
      try {
        hookPreviewWidget(node, nodeKind);
      } catch (err) {
        console.warn(LOG, "初始化节点内预览失败", err);
      }
      return result;
    };

    // 加载保存的工作流时，按恢复出来的 widget 值重建预览
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      try {
        applyNodeLang(this);
        this.__paPreview && (this.__paPreview._key = "");
        fitNodeToWidgets(this);
        refreshPreview(this);
      } catch (err) {
        /* ignore */
      }
      return result;
    };
  },

  // 旧工作流里「智能连接提示词」连线的端口序号要对齐，必须在连线建立之前改
  async beforeConfigureGraph(data) {
    try {
      const fixed = migrateLegacyLinkSlots(data);
      if (fixed) console.log(LOG, `已把旧工作流里的 ${fixed} 根参考图连线改到新端口`);
    } catch (err) {
      console.warn(LOG, "参考图连线迁移失败", err);
    }
  },

  async setup() {
    ensureStyle();
    loadTagNames(); // 预热衣装标签词典，失败无碍

    let mounted = false;
    try {
      if (app.extensionManager?.registerSidebarTab) {
        app.extensionManager.registerSidebarTab({
          id: TAB_ID,
          icon: "pi pi-images",
          title: t("tabTitle"),
          tooltip: t("tabTooltip"),
          type: "custom",
          render: (el) => {
            mountSidebarTab(el);
          },
          destroy: () => {
            Array.from(store.panels).forEach((p) => p.destroy());
            store.panels.clear();
          },
        });
        mounted = true;
      }
    } catch (err) {
      console.warn(LOG, "侧边栏注册失败，改用浮动按钮", err);
    }

    if (!mounted) mountFab();

    // 画布右键菜单里也留个入口
    try {
      const orig = app.canvas?.getCanvasMenuOptions;
      if (typeof orig === "function") {
        app.canvas.getCanvasMenuOptions = function (...args) {
          const options = orig.apply(this, args) || [];
          options.push(null, {
            content: t("modalTitle"),
            callback: () => openModal({}),
          });
          return options;
        };
      }
    } catch (err) {
      console.warn(LOG, "右键菜单注入失败", err);
    }

    console.log(LOG, "extension ready");
  },
});
