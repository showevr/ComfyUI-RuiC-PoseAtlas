/**
 * RuiC-PoseAtlas · ComfyUI 前端扩展
 *
 * 提供两件事：
 *   1. 侧边栏「姿态图库」标签页 —— 浏览 288 组姿态、看大图，选中后
 *      直接把 RuiCPoseAtlasLoad 节点插到画布上；
 *   2. 节点上的「姿态图库」按钮 —— 在弹窗里挑图，挑完写回该节点的 pose / angle。
 *
 * 图片走 /poseatlas/media/*（直接从节点目录读取，不复制文件），
 * 数据走 /poseatlas/api/index。
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const LOG = "[PoseAtlas]";
const EXT_NAME = "RuiC.PoseAtlas";
const TAB_ID = "ruic-poseatlas";

const NODE_LOAD = "RuiCPoseAtlasLoad";
const NODE_RANDOM = "RuiCPoseAtlasRandom";
const NODE_ANGLES = "RuiCPoseAtlasAngles";
/** 带 pose 输入的节点才挂「选图」按钮 */
const PICKER_NODES = [NODE_LOAD, NODE_ANGLES];

const ANGLE_ORDER = ["front", "diagonal", "side", "high", "low"];
const LANG_KEY = "ruic-poseatlas.lang";
const CSS_URL = new URL("./poseatlas.css", import.meta.url).href;

/* ------------------------------------------------------------------ 文案 */
const I18N = {
  zh: {
    tabTitle: "姿态图库",
    tabTooltip: "RuiC PoseAtlas · 浏览姿态，点击插入节点",
    search: "搜索编号 / 名称 / 分类…",
    all: "全部",
    seriesLabel: "系列",
    categoryLabel: "分类",
    insert: "插入节点",
    quickInsert: "插入节点",
    reusedTitle: "已更新现有节点",
    use: "使用该姿态",
    download: "下载原图",
    close: "关闭",
    empty: "没有匹配的姿态",
    loadFail: "图库数据加载失败",
    retry: "重试",
    modalTitle: "选择姿态 · Pose Atlas",
    angles: "角度",
    info: "信息",
    hint: [
      ["← →", "切换角度"],
      ["↑ ↓", "切换姿态"],
      ["Esc", "关闭"],
    ],
    count: (p, i) => `${p} 组姿态 · ${i} 张图`,
  },
  en: {
    tabTitle: "Pose Atlas",
    tabTooltip: "RuiC PoseAtlas · browse poses, click to insert a node",
    search: "Search number / name / category…",
    all: "All",
    seriesLabel: "Series",
    categoryLabel: "Category",
    insert: "Insert node",
    quickInsert: "Insert",
    reusedTitle: "Updated existing node",
    use: "Use this pose",
    download: "Download PNG",
    close: "Close",
    empty: "No matching pose",
    loadFail: "Failed to load atlas data",
    retry: "Retry",
    modalTitle: "Pick a pose · Pose Atlas",
    angles: "Angles",
    info: "Info",
    hint: [
      ["← →", "angle"],
      ["↑ ↓", "pose"],
      ["Esc", "close"],
    ],
    count: (p, i) => `${p} poses · ${i} images`,
  },
  ja: {
    tabTitle: "ポーズ図鑑",
    tabTooltip: "RuiC PoseAtlas · ポーズを選んでノードを挿入",
    search: "番号 / 名前 / カテゴリで検索…",
    all: "すべて",
    seriesLabel: "シリーズ",
    categoryLabel: "カテゴリ",
    insert: "ノードを挿入",
    quickInsert: "挿入",
    reusedTitle: "既存ノードを更新",
    use: "このポーズを使う",
    download: "原寸PNG",
    close: "閉じる",
    empty: "該当するポーズがありません",
    loadFail: "データの読み込みに失敗しました",
    retry: "再試行",
    modalTitle: "ポーズを選択 · Pose Atlas",
    angles: "アングル",
    info: "情報",
    hint: [
      ["← →", "アングル"],
      ["↑ ↓", "ポーズ"],
      ["Esc", "閉じる"],
    ],
    count: (p, i) => `${p} ポーズ · ${i} 枚`,
  },
};

/* ------------------------------------------------------------------ 状态 */
const store = {
  data: null,
  poses: [],
  byId: new Map(),
  seriesList: [],
  categoryList: [],
  categoriesBySeries: {},
  angleNames: {},
  seriesByKey: {},
  categoryNames: {},
  lang: detectLang(),
  panels: new Set(),
};

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

function t(key) {
  const dict = I18N[store.lang] || I18N.en;
  return dict[key] ?? I18N.en[key] ?? key;
}

function pickName(obj, lang = store.lang) {
  const names = (obj && obj.names) || {};
  return names[lang] || names.zh || names.en || names.ja || (obj && obj.key) || "";
}

function seriesLabel(key) {
  const s = store.seriesByKey[key];
  if (!s) return key;
  return s.short?.[store.lang] || s.short?.en || pickName(s);
}

function categoryLabel(key) {
  const names = store.categoryNames[key];
  return names ? pickName({ names }) : key;
}

function angleLabel(key) {
  const names = store.angleNames[key];
  return names ? names[store.lang] || names.en || names.zh || key : key;
}

/** 与 Python 端 core.PoseAtlas.label 完全一致的格式：no / series / 名称 */
function poseLabel(pose) {
  return `${pose.no} / ${pose.series} / ${pickName(pose) || pose.id}`;
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

/* ------------------------------------------------------------------ 样式 */
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
let dataPromise = null;

function loadData() {
  if (!dataPromise) {
    dataPromise = api
      .fetchApi("/poseatlas/api/index")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ingest(await res.json());
        return store.data;
      })
      .catch((err) => {
        dataPromise = null;
        throw err;
      });
  }
  return dataPromise;
}

function ingest(data) {
  store.data = data;
  store.poses = (data.poses || []).map((pose) => {
    pose.variants = (pose.variants || []).slice().sort((a, b) => {
      const ia = ANGLE_ORDER.indexOf(a.angle);
      const ib = ANGLE_ORDER.indexOf(b.angle);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    pose._hay = [
      pose.id,
      pose.no,
      pose.series,
      pose.category,
      pickName(pose, "zh"),
      pickName(pose, "en"),
      pickName(pose, "ja"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return pose;
  });
  store.byId = new Map(store.poses.map((p) => [p.id, p]));
  store.seriesList = data.series || [];
  store.categoryList = data.categories || [];
  store.categoriesBySeries = data.categoriesBySeries || {};
  store.seriesByKey = {};
  store.seriesList.forEach((s) => {
    store.seriesByKey[s.key] = s;
  });
  store.categoryNames = {};
  store.categoryList.forEach((c) => {
    store.categoryNames[c.key] = c.names || {};
  });
  store.angleNames = {};
  (data.angles || []).forEach((a) => {
    store.angleNames[a.key] = a.names || {};
  });
}

function variantOf(pose, angle) {
  if (!pose || !pose.variants?.length) return null;
  return pose.variants.find((v) => v.angle === angle) || pose.variants[0];
}

function thumbOf(pose, angle) {
  const v = variantOf(pose, angle);
  return v ? mediaUrl(v.thumb || v.full) : "";
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
}

/* ------------------------------------------------------------------ 图库面板 */
function createPanel({ target = null } = {}) {
  const filter = { series: "all", category: "all", q: "" };
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
      <input class="pa-search" type="search" spellcheck="false" />
      <div class="pa-chips pa-series"></div>
      <select class="pa-select pa-category"></select>
    </div>
    <div class="pa-body"><div class="pa-grid"></div></div>`;

  const $ = (sel) => root.querySelector(sel);
  const countEl = $(".pa-count");
  const searchEl = $(".pa-search");
  const seriesEl = $(".pa-series");
  const catEl = $(".pa-category");
  const gridEl = $(".pa-grid");
  const bodyEl = $(".pa-body");

  function renderSeriesChips() {
    const items = [{ key: "all", label: t("all") }].concat(
      store.seriesList.map((s) => ({ key: s.key, label: seriesLabel(s.key) }))
    );
    seriesEl.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="pa-chip${filter.series === it.key ? " is-on" : ""}" ` +
          `data-series="${esc(it.key)}">${esc(it.label)}</button>`
      )
      .join("");
  }

  function renderCategorySelect() {
    const cats =
      filter.series === "all"
        ? store.categoryList.map((c) => c.key)
        : store.categoriesBySeries[filter.series] || store.categoryList.map((c) => c.key);

    if (filter.category !== "all" && !cats.includes(filter.category)) filter.category = "all";

    catEl.innerHTML =
      `<option value="all">${esc(t("categoryLabel"))}：${esc(t("all"))}</option>` +
      cats.map((k) => `<option value="${esc(k)}">${esc(categoryLabel(k))}</option>`).join("");
    catEl.value = filter.category;
  }

  function applyFilter() {
    const q = filter.q.trim().toLowerCase();
    visible = store.poses.filter((pose) => {
      if (filter.series !== "all" && pose.series !== filter.series) return false;
      if (filter.category !== "all" && pose.category !== filter.category) return false;
      if (q && !pose._hay.includes(q)) return false;
      return true;
    });
    renderGrid();
    const fmt = (n) => Number(n || 0).toLocaleString();
    countEl.textContent = t("count")(
      fmt(store.data?.totals?.poses ?? store.poses.length),
      fmt(store.data?.totals?.images ?? 0)
    );
  }

  function renderGrid() {
    gridEl.innerHTML = "";
    if (!visible.length) {
      gridEl.innerHTML = `<div class="pa-empty">${esc(t("empty"))}</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    visible.forEach((pose) => {
      // div + role=button：卡片里要嵌悬浮的「插入节点」按钮，button 套 button 不合法
      const card = document.createElement("div");
      card.className = "pa-card";
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.dataset.id = pose.id;
      card.innerHTML =
        `<span class="pa-shot">` +
        `<img loading="lazy" decoding="async" src="${esc(thumbOf(pose))}" alt="">` +
        `<span class="pa-no">${esc(pose.no || "")}</span>` +
        `<span class="pa-quick">${esc(t("quickInsert"))}</span>` +
        `</span>` +
        `<span class="pa-name">${esc(pickName(pose))}</span>`;
      frag.appendChild(card);
    });
    gridEl.appendChild(frag);
  }

  searchEl.addEventListener("input", () => {
    filter.q = searchEl.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilter, 120);
  });

  seriesEl.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".pa-chip");
    if (!chip) return;
    filter.series = chip.dataset.series || "all";
    filter.category = "all";
    renderSeriesChips();
    renderCategorySelect();
    applyFilter();
    bodyEl.scrollTop = 0;
  });

  catEl.addEventListener("change", () => {
    filter.category = catEl.value || "all";
    applyFilter();
    bodyEl.scrollTop = 0;
  });

  $(".pa-langs").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-lang]");
    if (btn) setLang(btn.dataset.lang);
  });

  gridEl.addEventListener("click", (ev) => {
    const card = ev.target.closest(".pa-card");
    if (!card) return;
    const pose = store.byId.get(card.dataset.id);
    if (!pose) return;
    // 悬浮按钮：直接插入节点，不进灯箱
    if (ev.target.closest(".pa-quick")) {
      ev.stopPropagation();
      try {
        createPoseNode(pose, pose.variants[0]?.angle || "front");
        if (modalEl) closeModal(); // 从弹窗图库里快捷插入后把弹窗一起收掉
      } catch (err) {
        console.error(LOG, err);
        window.alert?.(String(err?.message || err));
      }
      return;
    }
    openLightbox({ pose, list: visible, target });
  });

  function syncLangButtons() {
    root.querySelectorAll(".pa-langs button").forEach((b) => {
      b.classList.toggle("is-on", b.dataset.lang === store.lang);
    });
  }

  const panel = {
    root,
    refresh() {
      $(".pa-title").textContent = t("tabTitle");
      searchEl.placeholder = t("search");
      syncLangButtons();
      renderSeriesChips();
      renderCategorySelect();
      applyFilter();
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

  const angles = st.pose.variants.map((v) => v.angle);
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
    stepPose(key === "ArrowDown" ? 1 : -1);
    return;
  }

  if (key === "Enter" && !String(ev.target?.tagName || "").match(/INPUT|TEXTAREA|SELECT/)) {
    ev.preventDefault();
    confirmPick();
  }
}

function openLightbox({ pose, list = null, target = null, angle = null }) {
  ensureStyle();
  closeLightbox();

  const index = list ? list.findIndex((p) => p.id === pose.id) : -1;
  lightboxState = {
    pose,
    angle: angle || pose.variants[0]?.angle || "front",
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
          <div>
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
  $(".pa-nav.prev").addEventListener("click", () => stepPose(-1));
  $(".pa-nav.next").addEventListener("click", () => stepPose(1));
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

function stepPose(step) {
  const st = lightboxState;
  if (!st || !st.list || st.list.length < 2) return;
  st.index = (st.index + step + st.list.length) % st.list.length;
  st.pose = st.list[st.index];
  st.angle = st.pose.variants[0]?.angle || "front";
  syncLightbox();
}

function syncLightbox() {
  const st = lightboxState;
  if (!st || !lightboxEl) return;
  const { pose } = st;
  const v = variantOf(pose, st.angle);
  if (v) st.angle = v.angle;

  const $ = (sel) => lightboxEl.querySelector(sel);

  $(".pa-lb-name").textContent = `${pose.no || pose.id} · ${pickName(pose)}`;
  $(".pa-lb-sub").textContent = `${seriesLabel(pose.series)} · ${categoryLabel(pose.category)}`;

  const img = $(".pa-lb-img");
  img.src = mediaUrl(v?.full || v?.thumb || "");
  img.alt = pickName(pose);

  $(".pa-pick").textContent = st.target ? t("use") : t("insert");

  const dl = $(".pa-dl");
  const fullPath = v?.full || "";
  dl.href = mediaUrl(fullPath);
  dl.setAttribute("download", fullPath.split("/").pop() || "pose.png");
  dl.textContent = t("download");

  $(".pa-angles-label").textContent = t("angles");
  $(".pa-info-label").textContent = t("info");
  $(".pa-hint").innerHTML = t("hint")
    .map(([keys, label]) => `<div><kbd>${esc(keys)}</kbd> ${esc(label)}</div>`)
    .join("");

  $(".pa-angle-list").innerHTML = pose.variants
    .map(
      (item) =>
        `<button type="button" class="pa-angle${item.angle === st.angle ? " is-on" : ""}" ` +
        `data-angle="${esc(item.angle)}" title="${esc(angleLabel(item.angle))}">` +
        `<img loading="lazy" decoding="async" src="${esc(mediaUrl(item.thumb || item.full))}" alt="">` +
        `<span>${esc(angleLabel(item.angle))}</span>` +
        `</button>`
    )
    .join("");

  const meta = [
    [t("angles"), angleLabel(st.angle)],
    [t("seriesLabel"), seriesLabel(pose.series)],
    [t("categoryLabel"), categoryLabel(pose.category)],
    ["ID", pose.id],
    ["size", "900 × 1200"],
  ];
  if (st.list && st.list.length > 1) meta.push(["#", `${st.index + 1} / ${st.list.length}`]);
  $(".pa-meta").innerHTML = meta
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
      applyToNode(st.target, st.pose, st.angle);
      closeLightbox();
      // 从节点按钮进来的弹窗也要一起关掉
      closeModal();
    } else {
      createPoseNode(st.pose, st.angle);
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

function applyToNode(node, pose, angle) {
  setWidgetValue(findWidget(node, ["pose"]), poseLabel(pose), node);
  const angleWidget = findWidget(node, ["angle", "angles"]);
  const options = angleWidget?.options?.values || [];
  const hasVariant = (a) => !!a && (pose.variants || []).some((v) => v.angle === a);
  const cur = String(angleWidget?.value || "").trim();
  let wanted;
  if (node.type === NODE_ANGLES) {
    // 多视角：all 直接保留；指定角度在新姿态里没有就回落到 all，避免后端报错
    wanted = cur === "all" || hasVariant(cur) ? cur : "all";
  } else {
    // 加载：优先用点击的角度；新姿态没有该角度就依次回落 当前值 → 第一个角度
    wanted = hasVariant(angle) ? angle : hasVariant(cur) ? cur : pose.variants?.[0]?.angle || angle;
  }
  if (options.length && !options.includes(wanted)) wanted = options[0];
  setWidgetValue(angleWidget, wanted, node);

  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

/** 找可以复用的图库节点：当前选中的优先，否则取最近创建的那个 */
function findReuseTarget() {
  const nodes = app.graph?._nodes || [];
  const candidates = nodes.filter(
    (n) => (n.type === NODE_LOAD || n.type === NODE_ANGLES) && !n.mode // mode 0=正常；过滤掉 muted/bypass
  );
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

function toastReused(pose) {
  try {
    app.extensionManager?.toast?.add?.({
      severity: "info",
      summary: t("reusedTitle"),
      detail: `${pose.no || ""} · ${pickName(pose)}`.trim(),
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

function createPoseNode(pose, angle, { forceNew = false } = {}) {
  // 工作流里已经有图库节点：只把图写进去，不再新建（选中谁就更新谁，否则更新最近的）
  if (!forceNew) {
    const target = findReuseTarget();
    if (target) {
      applyToNode(target, pose, angle);
      flashNode(target);
      toastReused(pose);
      return target;
    }
  }

  const LG = globalThis.LiteGraph;
  if (!LG?.createNode) throw new Error("LiteGraph 不可用，无法创建节点");
  const node = LG.createNode(NODE_LOAD);
  if (!node) throw new Error(`节点 ${NODE_LOAD} 未注册，请重启 ComfyUI`);
  node.pos = nextNodePos();
  app.graph.add(node);
  applyToNode(node, pose, angle);
  app.canvas?.selectNode?.(node, false);
  app.canvas?.setDirty?.(true, true);
  app.graph.setDirtyCanvas(true, true);
  return node;
}

/* ------------------------------------------------------------------ 节点内预览 */
/**
 * 给 RuiCPoseAtlasLoad / RuiCPoseAtlasAngles 挂一个 DOM widget 预览区，
 * 选中姿态（不必运行工作流）就用 /poseatlas/media/* 的图显示出来。
 */

/** 把 pose widget 的值（no / series / 名称）解析回姿态对象 */
function resolvePoseByLabel(label) {
  if (!label || !store.poses.length) return null;
  const text = String(label).trim();
  const parts = text.split("/").map((s) => s.trim());
  if (parts.length >= 2) {
    const hit = store.poses.find((p) => p.no === parts[0] && p.series === parts[1]);
    if (hit) return hit;
  }
  const hit =
    store.poses.find((p) => p.id === text) ||
    store.poses.find((p) =>
      [pickName(p, "zh"), pickName(p, "en"), pickName(p, "ja")].some((n) => n && n === text)
    ) ||
    store.poses.find((p) => p.no && parts[0] && p.no === parts[0]);
  return hit || null;
}

function refreshPreview(node) {
  const pv = node?.__paPreview;
  if (!pv) return;

  // 图库数据还没到就先等一次，到了再画
  if (!store.data) {
    if (pv.waiting) return;
    pv.waiting = true;
    loadData()
      .then(() => {
        pv.waiting = false;
        refreshPreview(node);
      })
      .catch(() => {
        pv.waiting = false;
      });
    return;
  }

  const pose = resolvePoseByLabel(findWidget(node, ["pose"])?.value);
  const el = pv.el;

  if (!pose || !pose.variants?.length) {
    if (pv._key) el.innerHTML = "";
    pv._key = "";
    node.__paVariantCount = 0;
    node.setDirtyCanvas?.(true, true);
    return;
  }

  if (node.__paKind === NODE_LOAD) {
    const angleVal = String(findWidget(node, ["angle"])?.value || "").trim();
    const v = variantOf(pose, angleVal) || pose.variants[0];
    const key = `${pose.id}|${v.angle}`;
    if (pv._key === key) return;
    pv._key = key;
    node.__paVariantCount = 1;
    el.innerHTML =
      `<div class="pa-np" title="${esc(pickName(pose))}">` +
      `<img decoding="async" src="${esc(mediaUrl(v.full || v.thumb))}" alt="">` +
      `<span class="pa-np-tag">${esc(angleLabel(v.angle))}</span></div>`;
  } else {
    const raw = String(findWidget(node, ["angles"])?.value || "").trim().toLowerCase();
    const selected = raw === "all" ? null : raw.split(/[,\s]+/).filter(Boolean);
    const key = `${pose.id}|${raw}`;
    if (pv._key === key) return;
    pv._key = key;
    node.__paVariantCount = pose.variants.length;
    el.innerHTML = pose.variants
      .map((item) => {
        const on = !selected || selected.includes(item.angle.toLowerCase());
        return (
          `<div class="pa-np${on ? " is-on" : ""}" data-angle="${esc(item.angle)}" ` +
          `title="${esc(angleLabel(item.angle))}">` +
          `<img decoding="async" src="${esc(mediaUrl(item.thumb || item.full))}" alt="">` +
          `<span class="pa-np-tag">${esc(angleLabel(item.angle))}</span></div>`
        );
      })
      .join("");
  }

  applyPreviewHeight(node);
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function previewHeight(node) {
  // 加载节点 = 单张 3:4 大图（跟随宽度）；多视角 = 固定高度的一排角度缩略图
  const w = Number(node?.size?.[0]) || 320;
  if (node?.__paKind !== NODE_LOAD) return 150;
  return Math.round(Math.min(Math.max((w - 40) * (4 / 3), 180), 440));
}

function applyPreviewHeight(node) {
  const h = previewHeight(node);
  const el = node.__paPreview?.el;
  if (!el) return;
  // 新版前端从元素上的 CSS 变量读取 DOM widget 高度
  el.style.setProperty("--comfy-widget-min-height", `${h}px`);
  el.style.setProperty("--comfy-widget-max-height", `${h}px`);
  el.style.setProperty("--comfy-widget-height", `${h}px`);
}

function hookPreviewWidget(node, nodeKind) {
  node.__paKind = nodeKind;

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

    node.__paPreview = { el, waiting: false, _key: "" };
    applyPreviewHeight(node);

    // 加载节点：点预览直接打开选图弹窗；多视角节点：点缩略图切换 angles
    el.addEventListener("click", (ev) => {
      const np = ev.target.closest(".pa-np");
      if (!np) return;
      if (node.__paKind === NODE_LOAD) {
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

  // pose / angle / angles 变化时刷新预览
  ["pose", "angle", "angles"].forEach((name) => {
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

/* ------------------------------------------------------------------ 弹窗图库 */
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

  modalPanel = createPanel({ target });
  modalEl.querySelector(".pa-modal-body").appendChild(modalPanel.root);
  document.body.appendChild(modalEl);

  loadData()
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
    loadData()
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
  loadData()
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
    if (!PICKER_NODES.includes(nodeData?.name)) return;
    const nodeKind = nodeData.name;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      const node = this;
      try {
        const widget = node.addWidget("button", t("tabTitle"), null, () => {
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
        this.__paPreview && (this.__paPreview._key = "");
        refreshPreview(this);
      } catch (err) {
        /* ignore */
      }
      return result;
    };
  },

  async setup() {
    ensureStyle();

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
