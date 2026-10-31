<div align="center">

# ComfyUI-RuiC-PoseAtlas

**把「姿势 / 衣装 / 人像」三套参考图鉴直接装进 ComfyUI 的节点包**

288 组人体姿态 · 1,439 张多角度线稿　|　1,407 套无人衣装 · 8 个分类　|　1,499 张 AI 人像 · 脸部 / 造型

![ComfyUI](https://img.shields.io/badge/ComfyUI-custom%20node-8fb4ff?style=flat-square)
![version](https://img.shields.io/badge/version-1.4.1-c3d5ff?style=flat-square)
![nodes](https://img.shields.io/badge/nodes-8-e3c8ff?style=flat-square)
![languages](https://img.shields.io/badge/UI-中文%20%7C%20EN%20%7C%20日本語-ffd7b0?style=flat-square)
![dependencies](https://img.shields.io/badge/dependencies-0-2ea44f?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

[功能优势](#功能优势) · [安装](#安装) · [八个节点](#八个节点) · [智能连接提示词](#智能连接提示词节点) · [三语界面](#中en日三语界面联动) · [图库面板](#侧边栏图库面板)

</div>

> **内容提示**：本项目面向成年创作者，部分内容不适合未成年人。请遵守所在地法律法规与平台规范，未成年人请勿使用。

---

## 这是什么

**ComfyUI-RuiC-PoseAtlas** 是 [RuiC-PoseAtlas](https://github.com/HRuiCcc/RuiC-PoseAtlas) 三图鉴参考库的 **ComfyUI 节点发行版**：把 3,000+ 张姿势线稿、无人衣装和 AI 人像作为**即插即用的生图参考源**接入 ComfyUI，配合一个专门解决多参考图生图痛点的「智能连接提示词」节点。

数据与缩略图随仓库自带，克隆进 `custom_nodes/` 重启即用——**零第三方依赖、零额外配置、启动开销几乎为零**。

---

## 功能优势

### 🎯 八个节点，覆盖「姿势定骨架、衣装定皮相、人像定脸」

- 三个图鉴各有 **加载 + 随机** 节点，姿势图鉴另有 **多视角** 节点（一个姿态的正面/斜侧/侧面/俯视/仰视可 batch 输出）；
- 每个图库节点输出四路：`image`、`mask`、`智能连接提示词`、`info`，直接对接 ControlNet / IPAdapter / 参考图生图工作流。

### 🖼️ 三种「量身定制」的遮罩，不是敷衍的全黑

| 图鉴 | mask 口径 | 用途 |
| --- | --- | --- |
| 姿势 | `1 − 亮度` 线稿遮罩（白底=0，线条越深越接近 1） | 局部重绘 / lineart ControlNet 直接可用 |
| 衣装 | 背景色距离遮罩（自动取边框中位色） | 衣服轮廓干净，抠装套用无需再处理 |
| 人像 | 全 1（照片无天然遮罩） | 需要 cutout 时另接 `rembg` 类节点 |

### 🔌 智能连接提示词：多参考图生图不再「对不上哪张是哪张」

Qwen-Image-Edit / Nano Banana / Flux Kontext 这类多参考图模型，最难的就是告诉模型「第几张图管什么」。这个节点把图库节点的参考**按连接顺序自动编号**，套进现成句式生成一句可复制的提示词：

```
姿势 → 衣装 → 人像 接进 1 / 2 / 3
→ 参照 <image3> 中的人物外貌与身份，采用 <image1> 中的姿势与肢体动作，
  穿着 <image2> 中的整套服装，生成一张完整的人物照片。
```

- 四种句式模板（人物·姿势·服装 / 指令式 / 标签式 / 自定义），`<image*>` / `图片*` / `<图片*>` / 自定义四种标签样式；
- 每个图库节点**只需连一根线**（`智能连接提示词` 输出），图片引用随线走，不额外拷贝数据；
- 节点内实时预览生成结果，一键复制。

### 🧩 拼图输出：一张图喂饱「只认单参考图」的模型

第二个输出把接入的参考图**等高横拼成一张**，白底分隔，并在**每张图下方标注它的标签**（与提示词里的 `<image1>` 写法一一对应），模型一眼就能对上「哪块是哪张」。高度可选自动（取最矮、不放大）或固定 768–2048。

### 🌐 中 / EN / 日三语界面联动（本版本重点强化）

侧边栏面板右上角的语言开关**总管整个插件的所有可见文本**：

- 节点标题：`姿态图库 · 加载` ↔ `Pose Atlas · Load` ↔ `ポーズ図鑑・ロード`
- 控件标签与下拉框：`句式模板 / 指令式（参考图 + 指令）` ↔ `Template / Instructional (Refs + Directive)`（**选项列表和当前值一起翻译**，输出内容同步变化）
- 端口显示名：`连接 1–6` ↔ `Link 1–6` ↔ `参考 1–6`；`提示词 / 拼图` ↔ `Prompt / Montage`
- 侧边栏按钮标题：`参考图鉴` ↔ `Atlas` ↔ `図鑑`，实时切换
- 生成提示词本身也随语言切换：`图片*` 在 EN 下生成 `Image1`、日文下生成 `画像1`

**兼容性做到了极致**：切语言只改显示文本——控件 key、连线类型、端口内部 name 全部保持标准值；下拉框值无论以哪种语言存进工作流，Python 端都会**归一成标准值再执行**。旧工作流恢复、英文工作流在中文界面打开，都不会报 `Value not in list`，随时来回切。

### 👀 节点内实时预览

图库节点下方直接显示当前选中参考图（多视角显示 batch），预览层宽度每帧钳制在节点内，**不会溢出节点边界**遮挡画布。

### 📚 侧边栏图库面板 + 智能节点复用

- 左侧工具栏新增「参考图鉴」入口，姿势 / 衣装 / 人像一键切换，支持搜索、按系列/分类/季节/发型筛选；
- 点缩略图开大图：`←→` 换角度、`↑↓` 换姿态、`Enter` 插入节点；
- **插入不堆节点**：工作流里已有对应图鉴节点时，「插入节点」只把新图写进现有节点（选中谁更新谁），连线保持不动；没有才新建。

### ⚡ 工程质量

- **零依赖**：只用 ComfyUI 自带的 torch / Pillow / aiohttp；
- 数据 JSON 惰性加载，不预扫几千张图；
- 图片通过服务端路由直读（7 天强缓存 + 路径穿越防护），不复制文件；
- 子路径部署友好（`/comfyui/` 子路径下正常工作）；样式全 `pa-` 前缀，深浅主题自适应；
- 下拉框空值自愈、旧工作流端口自动迁移，版本升级不断线。

---

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/showevr/ComfyUI-RuiC-PoseAtlas.git
```

或直接把解压后的文件夹放进 `custom_nodes/`（保证 `__init__.py`、`poseatlas/`、`web/`、`data/`、`img/`、`thumbs/`、`costume/`、`portrait/` 在一起）。然后**重启 ComfyUI**（Python 有改动时必须重启；只改前端 JS 时 Ctrl+F5 刷新即可）。

节点在右键菜单的四个分类下：

- **`RuiC/姿态图库 PoseAtlas`** —— 姿势三件套
- **`RuiC/衣装图库 Costume`** —— 衣装两件套
- **`RuiC/人像图库 Portrait`** —— 人像两件套
- **`RuiC/智能提示词 Smart Prompt`** —— 智能连接提示词

> 人像图鉴随仓库只带 400×500 缩略图（原图约 4.5 GB 不入库）。节点优先读 `portrait/img/` 原图，缺失时自动回落缩略图。想用原图：`npm run fetch-faces`，或运行 `scripts/fetch-faces.ps1`（PowerShell 一键下载，详见仓库内说明）。

---

## 八个节点

| 图鉴 | 节点 | 类名 | 关键输入 | 输出 |
| --- | --- | --- | --- | --- |
| 姿势 | 姿态图库 · 加载 | `RuiCPoseAtlasLoad` | `pose`、`angle` | image / mask / 智能连接提示词 / info |
| 姿势 | 姿态图库 · 随机 | `RuiCPoseAtlasRandom` | `series`、`category`、`angle`、`seed` | 同上 |
| 姿势 | 姿态图库 · 多视角 | `RuiCPoseAtlasAngles` | `pose`、`angles` | 同上 |
| 衣装 | 衣装图库 · 加载 | `RuiCCostumeLoad` | `costume` | 同上 |
| 衣装 | 衣装图库 · 随机 | `RuiCCostumeRandom` | `category`（季节）、`group`（品类）、`seed` | 同上 |
| 人像 | 人像图鉴 · 加载 | `RuiCPortraitLoad` | `portrait` | 同上 |
| 人像 | 人像图鉴 · 随机 | `RuiCPortraitRandom` | `section`（脸部/造型）、`hair`（发型）、`seed` | 同上 |
| 智能提示词 | 智能连接提示词 | `RuiCSmartPrompt` | `连接 1`–`连接 6` + 8 个控件 | 提示词 / 拼图 |

下拉框均可输入筛选：`P019`、`full_std`、`坐姿`、`M字` 等中日英关键词都能命中；编号（`P001` 等）是稳定标识，名称随语言变不影响已保存的工作流。

**输出规格**

| 输出 | 内容 |
| --- | --- |
| `image` | `B × 1200 × 900 × 3`，float32 `0–1`，原图不缩放 |
| `mask` | 见上文「三种遮罩」 |
| `智能连接提示词` | 参考图身份（图鉴类型 + 编号）+ 图片引用，供智能连接提示词节点使用 |
| `info` | 多行文本：id、编号、系列、分类、三语名称、角度、文件名，可接字符串节点或拼进文件名 |

`angle` 选 `all` 会把该姿态**全部可用角度**作为一个 batch 输出；衣装图本来就没有人体，可直接套到已有角色上，无需抠图。

---

## 智能连接提示词节点

**用法**

1. 把图库节点的 `智能连接提示词` 输出拖到本节点的 `连接 1`–`连接 6`（最多 6 路，同类可接多张）；
2. 选 `标签样式`（默认 `<image*>`）和 `句式模板`（默认「指令式（参考图 + 指令）」）；
3. 生成的 `提示词` 接正面提示词即可，节点内实时预览、可复制；需要单图参考就再接 `拼图` 输出。

**四种句式**

| 句式 | 输出示例 | 适合 |
| --- | --- | --- |
| 人物 · 姿势 · 服装 | `<image3>的人物以<image1>的姿势穿上<image2>的服装` | Qwen / Nano Banana 等中文指令模型 |
| 指令式（参考图 + 指令）**（默认）** | `参照 <image3> 中的人物外貌与身份，采用 <image1> 中的姿势与肢体动作，……生成一张完整的人物照片。` | 需要完整指令句的模型 |
| 标签式（SDXL / Flux） | `person: <image3>, pose: <image1>, outfit: <image2>` | 吃英文标签的模型 |
| 自定义 | 自己写，`{人物}` / `{姿势}` / `{服装}` 占位 | 任意 |

**规则**

- **编号**默认按连接顺序自动紧凑编号（先接的 = `<image1>`），要让图片送进模型的顺序与连接顺序一致；想固定成端口号就切 `编号方式` → `按端口编号（1 – 6）`；
- 同类多张并列：两个姿势 = `以<image1>、<image2>的姿势…`；
- 缺哪类省哪句：只接衣装 + 人像 = 只生成服装那一句；
- `补充提示词` 追加在末尾；旧工作流里下拉框为空不报错，按默认值跑。

**`语言` 参数 —— 提示词本身的三语输出**

| 语言 | 指令式示例 |
| --- | --- |
| 中文 | `参照 <image3> 中的人物外貌与身份，……生成一张完整的人物照片。` |
| English | `Reference the person's appearance and identity from <image3>, … generate a full photograph of this person.` |
| 日本語 | `<image3> の人物の外見と雰囲気を参照し、……完全な写真を一枚生成してください。` |

`语言` 控件默认跟随面板语言总开关（也可单独手动改）。`自定义` 句式不受语言影响，占位符原样替换。

**`拼图` 输出**

- 参考图按同一高度从左到右横拼，白底、图间 12px 白缝，**每张图下方标注它的标签**（与提示词写法完全一致）；
- `拼图高度`：`自动（取最矮，不放大）` 最保真；也可固定 `768` / `1024` / `1536` / `2048`；
- 三张典型参考（姿势 900×1200 + 衣装 1366×2048 + 人像 1122×1402）在「自动」下约 1132×545，固定 1024 时约 2294×1116；
- batch 输出（多视角 / `angle=all`）只取第一张；拼图不写盘，接 `Preview Image` / `Save Image` 查看即可。

---

## 中 / EN / 日三语界面联动

面板右上角 `中 / EN / 日` 开关的效果范围：

| 层面 | 示例 |
| --- | --- |
| 节点标题 | `姿态图库 · 加载` ↔ `Pose Atlas · Load` ↔ `ポーズ図鑑・ロード` |
| 控件标签 | `句式模板` ↔ `Template` 等 |
| 下拉框选项 + 当前值 | `指令式（参考图 + 指令）` ↔ `Instructional (Refs + Directive)`（**值一起翻，输出同步变**） |
| 输入端口 | `连接 1–6` ↔ `Link 1–6` ↔ `参考 1–6` |
| 输出端口 | `图像/遮罩/智能连接提示词/信息` ↔ `image/mask/Smart Prompt/info`；`提示词/拼图` ↔ `Prompt/Montage` |
| 侧边栏按钮 | `参考图鉴` ↔ `Atlas` ↔ `図鑑`（实时切换） |
| 提示词输出 | 全套句式三语生成，标签样式 `图片*` → `Image1` / `画像1` |

**兼容性保证**：切语言只改显示文本，控件 key、连线类型、端口内部 name 不变；工作流里保存的任何语言的下拉值，Python 端执行前统一归一成标准值——**怎么存都能跑，随时来回切**。

两个小限制：新建节点搜索菜单里的名字在页面刷新后才跟随当前语言；用户自己写的 `自定义` 内容不做翻译。

---

## 侧边栏图库面板

<p align="center">
  <img src="docs/preview-comfyui-picker.jpg" alt="ComfyUI 弹窗图库" width="100%">
</p>

<p align="center">
  <img src="docs/preview-comfyui-lightbox.jpg" alt="ComfyUI 大图浏览" width="72%">
</p>

- 左侧工具栏「参考图鉴」入口：姿势 / 衣装 / 人像一键切换，可搜索、按系列/分类筛选，右上角切 中 / EN / 日；
- 点缩略图开大图：`←→` 换角度、`↑↓` 换姿态、`Enter` 插入节点、`Esc` 关闭；缩略图右下角有悬浮「插入节点」按钮；
- **智能复用**：已有对应图鉴节点时只更新现有节点的图（画布选中谁就更新谁），连线不动，不产生节点堆山；
- 节点上的「浏览图库」按钮打开弹窗版图库，挑完写回当前节点；画布空白处右键菜单也有入口。

---

## 项目结构

```text
ComfyUI-RuiC-PoseAtlas/
├── __init__.py            # ComfyUI 入口：节点映射 + WEB_DIRECTORY + 路由注册
├── poseatlas/
│   ├── core.py            # 三套数据索引、选项解析、读图转张量（三种遮罩）
│   ├── tags.py            # 衣装标签三语词典
│   ├── nodes.py           # 8 个节点（7 图库 + 智能连接提示词）+ 拼图合成
│   └── routes.py          # /poseatlas/api/* 与 /poseatlas/media/*
├── web/
│   ├── poseatlas.js       # 前端扩展：侧边栏图库 / 灯箱 / 插入节点 / 节点内预览 / 三语切换
│   └── poseatlas.css      # 面板样式（pa- 前缀，跟随 ComfyUI 主题）
├── data/                  # poses.json / costumes.json / faces.json（三语数据）
├── img/ · thumbs/         # 姿势线稿原图与缩略图
├── costume/               # 衣装缩略图 + 全尺寸 WEBP
├── portrait/              # 人像缩略图（原图可脚本下载）
├── scripts/               # 数据构建与原图下载脚本（含 fetch-faces.ps1）
└── index/costume/face.html + assets/   # 原静态图鉴站（可选部署）
```

---

## 常见问题

**装完没看到节点？** 确认整个文件夹（含 `data/`、`img/` 等）在 `custom_nodes/` 下，并完全重启 ComfyUI（控制台出现 `Import times for custom nodes` 且无报错）。

**旧工作流恢复时报下拉框错误？** 1.4.0 起下拉框空值自愈 + 选项值任意语言归一，正常不会出现；若更早版本的工作流报错，重新打开保存一次即可。

**改了端口顺序的老工作流连线错位？** 前端会在加载时按「序号 + 类型」自动迁移连线（`智能连接提示词` ↔ `info` 互换的老图自动纠正）。

**人像图只有缩略图清晰度？** 运行 `npm run fetch-faces` 或 `scripts/fetch-faces.ps1` 下载原图（约 4.5 GB），节点会自动优先使用。

---

## 致谢与版权

- 图鉴数据与静态站来自 **[HRuiCcc/RuiC-PoseAtlas](https://github.com/HRuiCcc/RuiC-PoseAtlas)**（及其上游 lxxpqxxl/RuiC-PoseAtlas），本项目在其基础上做 ComfyUI 节点发行与功能增强；
- 代码部分以 MIT 许可发布（见 [LICENSE](LICENSE)），数据与图片版权归原作者所有，使用请遵循原仓库的版权与免责声明；
- 人像图为 AI 生成的虚构人物，如有雷同纯属巧合。

## 上游同步

```bash
git remote add upstream https://github.com/HRuiCcc/RuiC-PoseAtlas.git
git fetch upstream && git merge upstream/main
```
