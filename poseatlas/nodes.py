"""RuiC-PoseAtlas 的 ComfyUI 节点。"""

from __future__ import annotations

import re

from .core import (
    ANGLE_KEYS,
    DEFAULT_LANGUAGE,
    PoseAtlasError,
    build_costume_info,
    build_info,
    build_portrait_info,
    get_atlas,
    get_costume_atlas,
    get_portrait_atlas,
    load_tensors,
    stack_tensors,
)

NODE_CATEGORY = "RuiC/姿态图库 PoseAtlas"
NODE_CATEGORY_COSTUME = "RuiC/衣装图库 Costume"
NODE_CATEGORY_PORTRAIT = "RuiC/人像图库 Portrait"
NODE_CATEGORY_PROMPT = "RuiC/智能提示词 Smart Prompt"

ANGLE_OPTIONS = list(ANGLE_KEYS) + ["all"]

# ---------------------------------------------------------------- 提示词连接线
# 三个图库节点的最后一个输出是同一条自定义类型，只用「智能连接提示词」节点接收。
# 里面装的是这条参考图的身份（种类 + 编号 + 名称），不含图片本身。
LINK_TYPE = "PA_PROMPT_LINK"
LINK_SLOTS = 6
LINK_LABELS = {"pose": "姿势", "costume": "衣装", "portrait": "人像"}


def make_link(kind: str, record: dict, label: str = "", image=None) -> dict:
    """生成一条「智能连接提示词」连线的数据。

    除了身份（种类 / 编号 / 名称），还会带上这条线对应的图片张量，
    「智能连接提示词」节点靠它拼图，不用再回盘重读一遍。
    """
    return {
        "kind": kind,
        "id": str(record.get("id", "") or ""),
        "label": str(label or record.get("id", "") or ""),
        "image": image,
    }


class _Combo(list):
    """下拉选项列表。

    ComfyUI 校验下拉框时只认「值必须在这个列表里」，而画布上早先放好的节点
    在新增控件后恢复工作流时会拿到空字符串，于是整张图被判无效
    （Value not in list）。这里只放行空值 / None / 语言别名（前端随界面语言
    把选项值翻成了英文或日文），真正填错的照样报错。
    """

    def __init__(self, values=(), aliases=()):
        super().__init__(values)
        self.aliases = set(aliases)

    def __contains__(self, item):
        if item is None:
            return True
        if isinstance(item, str) and not item.strip():
            return True
        if self.aliases and item in self.aliases:
            return True
        return super().__contains__(item)


# 连接词样式：* 会被替换成参考图序号
# 下拉「显示值」随界面语言切换（前端翻译），这里保留中文标准值；
# 各语言变体在 _Combo 的 aliases 里放行，build() 里再归一回中文。
LABEL_STYLES = _Combo(["<image*>", "图片*", "<图片*>", "自定义"])
DEFAULT_CUSTOM_LABEL = "image*"
DEFAULT_LABEL_STYLE = "<image*>"
DEFAULT_TEMPLATE = "指令式（参考图 + 指令）"

TEMPLATE_OPTIONS = _Combo([
    "人物 · 姿势 · 服装（默认）",
    "指令式（参考图 + 指令）",
    "标签式（SDXL / Flux）",
    "自定义",
])
NUMBERING_OPTIONS = _Combo(["按连接顺序（自动紧凑）", "按端口编号（1 – 6）"])

# 拼图：统一高度后从左到右排，每张下面标注「标签样式 + 序号」
MONTAGE_HEIGHT_OPTIONS = _Combo(["自动（取最矮，不放大）", "768", "1024", "1536", "2048"])

# 前端会随界面语言（中 / EN / 日）把这几个下拉框的「值」一起翻译，
# 这里把英文 / 日文变体归一回中文标准值，工作流怎么存都能执行。
OPTION_ALIASES = {
    # 标签样式
    "Image*": "图片*",
    "<Image*>": "<图片*>",
    "Custom": "自定义",
    "画像*": "图片*",
    "<画像*>": "<图片*>",
    "カスタム": "自定义",
    # 句式模板
    "Character · Pose · Outfit (Default)": "人物 · 姿势 · 服装（默认）",
    "Instructional (Refs + Directive)": "指令式（参考图 + 指令）",
    "Tag Style (SDXL / Flux)": "标签式（SDXL / Flux）",
    "人物・ポーズ・衣装（デフォルト）": "人物 · 姿势 · 服装（默认）",
    "指令型（参照画像 + 指示）": "指令式（参考图 + 指令）",
    "タグ形式（SDXL / Flux）": "标签式（SDXL / Flux）",
    # 编号方式
    "By connection order (compact)": "按连接顺序（自动紧凑）",
    "By port number (1 – 6)": "按端口编号（1 – 6）",
    "接続順（自動コンパクト）": "按连接顺序（自动紧凑）",
    "ポート番号順（1 – 6）": "按端口编号（1 – 6）",
    # 拼图高度
    "Auto (shortest, no upscale)": "自动（取最矮，不放大）",
    "自動（最も低い高さに揃える）": "自动（取最矮，不放大）",
}

for _combo in (LABEL_STYLES, TEMPLATE_OPTIONS, NUMBERING_OPTIONS, MONTAGE_HEIGHT_OPTIONS):
    _combo.aliases = {alias for alias, canon in OPTION_ALIASES.items() if canon in _combo}


def _norm_option(value, default=""):
    """把任意语言的选项值归一成中文标准值；空值给默认。"""
    if value is None:
        return default
    text = str(value)
    if not text.strip():
        return default
    return OPTION_ALIASES.get(text, text)


# 每种标签样式在不同语言下实际生成的连接词（* 会被替换成序号）
LABEL_PATTERNS_BY_LANG = {
    "<image*>": {"zh": "<image*>", "en": "<image*>", "ja": "<image*>"},
    "图片*": {"zh": "图片*", "en": "Image*", "ja": "画像*"},
    "<图片*>": {"zh": "<图片*>", "en": "<Image*>", "ja": "<画像*>"},
}

# 生成文本的语言：中文 / English / 日本語（下拉值固定为这三个，便于序列化）
LANG_OPTIONS = _Combo(["中文", "English", "日本語"])
LANG_CODES = {"中文": "zh", "English": "en", "日本語": "ja"}
DEFAULT_LANG = "zh"

# 每种句式按语言提供若干「小句」：缺哪一类参考图就自动省掉那一句，
# 同一类接了多张图时用 multi_sep 并列。模板名（下拉值）保持中文不变，保证旧工作流兼容。
PRESETS = {
    "人物 · 姿势 · 服装（默认）": {
        "zh": {
            "clauses": [
                ("portrait", "{人物}的人物"),
                ("pose", "以{姿势}的姿势"),
                ("costume", "穿上{服装}的服装"),
            ],
            "sep": "",
            "multi_sep": "、",
            "tail": "",
            "join_extra": "，",
        },
        "en": {
            "clauses": [
                ("portrait", "the person from {人物}"),
                ("pose", "in the pose of {姿势}"),
                ("costume", "wearing the outfit from {服装}"),
            ],
            "sep": " ",
            "multi_sep": " & ",
            "tail": "",
            "join_extra": ", ",
        },
        "ja": {
            "clauses": [
                ("portrait", "{人物}の人物が"),
                ("pose", "{姿势}のポーズで"),
                ("costume", "{服装}の衣装を着た"),
            ],
            "sep": "",
            "multi_sep": "と",
            "tail": "",
            "join_extra": "、",
        },
    },
    "指令式（参考图 + 指令）": {
        "zh": {
            "clauses": [
                ("portrait", "参照 {人物} 中的人物外貌与身份"),
                ("pose", "采用 {姿势} 中的姿势与肢体动作"),
                ("costume", "穿着 {服装} 中的整套服装"),
            ],
            "sep": "，",
            "multi_sep": " 与 ",
            "tail": "，生成一张完整的人物照片。",
            "join_extra": "，",
        },
        "en": {
            "clauses": [
                ("portrait", "Reference the person's appearance and identity from {人物}"),
                ("pose", "adopt the pose and body language from {姿势}"),
                ("costume", "dress them in the complete outfit from {服装}"),
            ],
            "sep": ", ",
            "multi_sep": " and ",
            "tail": ", and generate a full photograph of this person.",
            "join_extra": ", ",
        },
        "ja": {
            "clauses": [
                ("portrait", "{人物} の人物の外見と雰囲気を参照し"),
                ("pose", "{姿势} のポーズと身体の動きを採用し"),
                ("costume", "{服装} の衣装一式を着せ"),
            ],
            "sep": "、",
            "multi_sep": " と ",
            "tail": "、この人物の完全な写真を一枚生成してください。",
            "join_extra": "、",
        },
    },
    "标签式（SDXL / Flux）": {
        "zh": {
            "clauses": [
                ("portrait", "person: {人物}"),
                ("pose", "pose: {姿势}"),
                ("costume", "outfit: {服装}"),
            ],
            "sep": ", ",
            "multi_sep": ", ",
            "tail": "",
            "join_extra": ", ",
        },
        "en": {
            "clauses": [
                ("portrait", "person: {人物}"),
                ("pose", "pose: {姿势}"),
                ("costume", "outfit: {服装}"),
            ],
            "sep": ", ",
            "multi_sep": ", ",
            "tail": "",
            "join_extra": ", ",
        },
        "ja": {
            "clauses": [
                ("portrait", "person: {人物}"),
                ("pose", "pose: {姿势}"),
                ("costume", "outfit: {服装}"),
            ],
            "sep": ", ",
            "multi_sep": ", ",
            "tail": "",
            "join_extra": ", ",
        },
    },
}

# 节点预览里 slot 芯片上的角色名（按语言）
LINK_LABELS_BY_LANG = {
    "zh": {"pose": "姿势", "costume": "衣装", "portrait": "人像"},
    "en": {"pose": "Pose", "costume": "Outfit", "portrait": "Portrait"},
    "ja": {"pose": "ポーズ", "costume": "衣装", "portrait": "人物"},
}
# 没接到任何图库节点时的提示（按语言）
EMPTY_HINTS = {
    "zh": "（没有接到任何图库节点：把姿态 / 衣装 / 人像节点的「智能连接提示词」端口拉进来）",
    "en": "(No atlas node connected: drag the \"Smart Prompt\" output of a Pose / Costume / Portrait node into one of the Link slots.)",
    "ja": "（図鑑ノードが接続されていません：ポーズ / 衣装 / ポートレートノードの「スマート接続プロンプト」出力を Link ポートに接続してください）",
}

# 拼图：统一高度后从左到右排，每张下面标注「标签样式 + 序号」
MONTAGE_GAP = 12          # 图与图之间的白边
MONTAGE_BACKGROUND = (255, 255, 255)
MONTAGE_TEXT = (24, 24, 24)
# 尽量挑一个支持中文的字体，没有就退回 PIL 默认位图字体（英文数字也能看）
FONT_CANDIDATES = (
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
)

CUSTOM_TEMPLATE_PLACEHOLDERS = (
    ("{人物}", "portrait"),
    ("{portrait}", "portrait"),
    ("{人像}", "portrait"),
    ("{姿势}", "pose"),
    ("{pose}", "pose"),
    ("{服装}", "costume"),
    ("{衣装}", "costume"),
    ("{costume}", "costume"),
)


def _pose_options() -> list[str]:
    """给 combo 用的姿态列表；数据缺失时也不让节点消失，只在执行时报错。"""
    try:
        return get_atlas().labels(DEFAULT_LANGUAGE)
    except PoseAtlasError as exc:
        return [f"(数据不可用) {exc}".replace("\n", " ")]


def _series_options() -> list[str]:
    try:
        return ["all"] + [s["key"] for s in get_atlas().ensure().series]
    except PoseAtlasError:
        return ["all"]


def _category_options() -> list[str]:
    try:
        return ["all"] + [c["key"] for c in get_atlas().ensure().categories]
    except PoseAtlasError:
        return ["all"]


def _costume_options() -> list[str]:
    try:
        return get_costume_atlas().labels(DEFAULT_LANGUAGE)
    except PoseAtlasError as exc:
        return [f"(数据不可用) {exc}".replace("\n", " ")]


def _costume_cat_options() -> list[str]:
    try:
        return ["all"] + [c["key"] for c in get_costume_atlas().ensure().categories]
    except PoseAtlasError:
        return ["all"]


def _costume_group_options() -> list[str]:
    try:
        return ["all"] + [g["key"] for g in get_costume_atlas().ensure().groups]
    except PoseAtlasError:
        return ["all"]


def _portrait_options() -> list[str]:
    try:
        return get_portrait_atlas().labels(DEFAULT_LANGUAGE)
    except PoseAtlasError as exc:
        return [f"(数据不可用) {exc}".replace("\n", " ")]


def _portrait_section_options() -> list[str]:
    try:
        return ["all"] + [s["key"] for s in get_portrait_atlas().ensure().sections]
    except PoseAtlasError:
        return ["all"]


def _portrait_hair_options() -> list[str]:
    try:
        return ["all"] + [h["key"] for h in get_portrait_atlas().ensure().hairs]
    except PoseAtlasError:
        return ["all"]


class RuiCPoseAtlasLoad:
    """按姿态 + 角度从图库取图。"""

    CATEGORY = NODE_CATEGORY
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK", LINK_TYPE, "STRING")
    RETURN_NAMES = ("image", "mask", "智能连接提示词", "info")
    DESCRIPTION = (
        "从 RuiC-PoseAtlas 读取一张姿态参考图（900×1200 线稿）。\n"
        "pose 里可以搜索编号（P019）或名称；angle 选 all 会输出该姿态全部角度的 batch。\n"
        "也可以用节点上的「浏览图库」按钮从缩略图里挑。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        options = _pose_options()
        return {
            "required": {
                "pose": (options, {"default": options[0]}),
                "angle": (ANGLE_OPTIONS, {"default": "front"}),
            }
        }

    def load(self, pose, angle="front"):
        atlas = get_atlas()
        record = atlas.resolve(pose)
        variants = atlas.variants_of(record, angle)
        image, mask = load_tensors(variants)
        return (image, mask, make_link("pose", record, atlas.label(record), image), build_info(record, variants))


class RuiCPoseAtlasRandom:
    """按系列 / 分类随机抽一个姿态，适合批量出图。"""

    CATEGORY = NODE_CATEGORY
    FUNCTION = "pick"
    RETURN_TYPES = ("IMAGE", "MASK", LINK_TYPE, "STRING")
    RETURN_NAMES = ("image", "mask", "智能连接提示词", "info")
    DESCRIPTION = (
        "在指定系列 / 分类里按 seed 随机抽一个姿态。\n"
        "配合 control_after_generate=randomize，每跑一次换一个姿态。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "series": (_series_options(), {"default": "all"}),
                "category": (_category_options(), {"default": "all"}),
                "angle": (["random"] + ANGLE_OPTIONS, {"default": "front"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "control_after_generate": (
                    ["fixed", "increment", "decrement", "randomize"],
                    {"default": "randomize"},
                ),
            }
        }

    def pick(self, series="all", category="all", angle="front", seed=0, control_after_generate=None):
        atlas = get_atlas()
        record = atlas.pick_random(seed, series, category)

        if angle == "random":
            available = [v.get("angle") for v in record.get("variants") or []]
            if not available:
                raise PoseAtlasError(f"姿态 {record['id']} 没有任何图片。")
            import random as _random

            angle = available[_random.Random(int(seed) & 0xFFFFFFFF).randrange(len(available))]

        variants = atlas.variants_of(record, angle)
        image, mask = load_tensors(variants)
        info = build_info(record, variants) + f"\nseed: {seed}"
        return (image, mask, make_link("pose", record, atlas.label(record), image), info)


class RuiCPoseAtlasAngles:
    """把一张姿态的多个角度一次性取出来（多视角对照 / 多视角训练素材）。"""

    CATEGORY = NODE_CATEGORY
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK", LINK_TYPE, "STRING")
    RETURN_NAMES = ("image", "mask", "智能连接提示词", "info")
    DESCRIPTION = (
        "输出同一姿态的多个角度（batch 顺序固定为 front → diagonal → side → high → low），\n"
        "只保留该姿态实际存在的角度。用来做多视角对照或训练集。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        options = _pose_options()
        return {
            "required": {
                "pose": (options, {"default": options[0]}),
                "angles": (
                    ["all"] + list(ANGLE_KEYS),
                    {"default": "all"},
                ),
            }
        }

    def load(self, pose, angles="all"):
        atlas = get_atlas()
        record = atlas.resolve(pose)
        wanted = list(ANGLE_KEYS) if angles == "all" else [angles]
        variants = [v for v in (record.get("variants") or []) if v.get("angle") in wanted]
        if not variants:
            raise PoseAtlasError(f"姿态 {record['id']} 没有角度 {angles!r} 的图片。")
        order = {k: i for i, k in enumerate(ANGLE_KEYS)}
        variants.sort(key=lambda v: order.get(v.get("angle"), 99))
        image, mask = load_tensors(variants)
        return (image, mask, make_link("pose", record, atlas.label(record), image), build_info(record, variants))


class RuiCCostumeLoad:
    """按编号取一套衣装（无人体的整身搭配）。"""

    CATEGORY = NODE_CATEGORY_COSTUME
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK", LINK_TYPE, "STRING")
    RETURN_NAMES = ("image", "mask", "智能连接提示词", "info")
    DESCRIPTION = (
        "从 RuiC-PoseAtlas 衣装图鉴读取一套无人衣装（1366×2048）。\n"
        "画面本来就没有人体，可以直接套到你已有的角色上，不需要抠图。\n"
        "下拉框可输入编号（SPR-0001）或分类/品类关键词筛选。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        options = _costume_options()
        return {"required": {"costume": (options, {"default": options[0]})}}

    def load(self, costume):
        atlas = get_costume_atlas()
        record = atlas.resolve(costume)
        path = atlas.image_path(record)
        image, mask = stack_tensors([path], "silhouette")
        return (image, mask, make_link("costume", record, atlas.label(record), image), build_costume_info(record))


class RuiCCostumeRandom:
    """按季节 / 品类随机抽一套衣装。"""

    CATEGORY = NODE_CATEGORY_COSTUME
    FUNCTION = "pick"
    RETURN_TYPES = ("IMAGE", "MASK", LINK_TYPE, "STRING")
    RETURN_NAMES = ("image", "mask", "智能连接提示词", "info")
    DESCRIPTION = (
        "在指定季节分类 / 品类里按 seed 随机抽一套衣装。\n"
        "配合 control_after_generate=randomize，每跑一次换一套。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "category": (_costume_cat_options(), {"default": "all"}),
                "group": (_costume_group_options(), {"default": "all"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "control_after_generate": (
                    ["fixed", "increment", "decrement", "randomize"],
                    {"default": "randomize"},
                ),
            }
        }

    def pick(self, category="all", group="all", seed=0, control_after_generate=None):
        atlas = get_costume_atlas()
        record = atlas.pick_random(seed, category, group)
        path = atlas.image_path(record)
        image, mask = stack_tensors([path], "silhouette")
        return (image, mask, make_link("costume", record, atlas.label(record), image), build_costume_info(record) + f"\nseed: {seed}")


class RuiCPortraitLoad:
    """按编号取一张人像参考图。"""

    CATEGORY = NODE_CATEGORY_PORTRAIT
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK", LINK_TYPE, "STRING")
    RETURN_NAMES = ("image", "mask", "智能连接提示词", "info")
    DESCRIPTION = (
        "从 RuiC-PoseAtlas 人像图鉴读取一张 AI 人像。\n"
        "脸部 = 正面纯背景，适合固定角色脸；造型 = 带服装与氛围。\n"
        "仓库只带 400×500 缩略图，想要原图先跑 npm run fetch-faces；info 会标注实际尺寸。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        options = _portrait_options()
        return {"required": {"portrait": (options, {"default": options[0]})}}

    def load(self, portrait):
        atlas = get_portrait_atlas()
        record = atlas.resolve(portrait)
        path, _is_full = atlas.image_path(record)
        image, mask = stack_tensors([path], "full")
        return (image, mask, make_link("portrait", record, atlas.label(record), image), build_portrait_info(record))


class RuiCPortraitRandom:
    """按分区 / 发型随机抽一张人像。"""

    CATEGORY = NODE_CATEGORY_PORTRAIT
    FUNCTION = "pick"
    RETURN_TYPES = ("IMAGE", "MASK", LINK_TYPE, "STRING")
    RETURN_NAMES = ("image", "mask", "智能连接提示词", "info")
    DESCRIPTION = (
        "在指定分区（脸部 / 造型）与发型里按 seed 随机抽一张人像。\n"
        "配合 control_after_generate=randomize，每跑一次换一张。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "section": (_portrait_section_options(), {"default": "all"}),
                "hair": (_portrait_hair_options(), {"default": "all"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "control_after_generate": (
                    ["fixed", "increment", "decrement", "randomize"],
                    {"default": "randomize"},
                ),
            }
        }

    def pick(self, section="all", hair="all", seed=0, control_after_generate=None):
        atlas = get_portrait_atlas()
        record = atlas.pick_random(seed, section, hair)
        path, _is_full = atlas.image_path(record)
        image, mask = stack_tensors([path], "full")
        return (image, mask, make_link("portrait", record, atlas.label(record), image), build_portrait_info(record) + f"\nseed: {seed}")


class RuiCSmartPrompt:
    """把图库节点接进来的参考图整理成一句提示词。

    三个图库节点的「智能连接提示词」输出只带身份（姿势 / 衣装 / 人像 + 编号），
    本节点按接入顺序给它们编号，再套用预置句式拼成一句话。
    """

    CATEGORY = NODE_CATEGORY_PROMPT
    FUNCTION = "build"
    RETURN_TYPES = ("STRING", "IMAGE")
    RETURN_NAMES = ("提示词", "拼图")
    # 标成输出节点：就算下游还没接东西，也会执行并刷新节点里的提示词预览
    OUTPUT_NODE = True
    DESCRIPTION = (
        "把「姿态图库 / 衣装图库 / 人像图库」节点的参考图接进来，自动生成给生图模型的提示词。\n"
        "编号 = 连接到本节点的顺序（第 1 个接进来的图 = <image1>），请把图片送进模型的顺序保持一致；\n"
        "想固定成端口号可以切「按端口编号」。\n"
        "默认标签是 <image1>/<image2>…，默认句式是「指令式（参考图 + 指令）」。\n"
        "同一类接多张图会并列，缺哪一类就自动省掉那一小句。\n"
        "例：姿势 → 衣装 → 人像 接进来 = 「<image3>的人物以<image1>的姿势穿上<image2>的服装」。\n"
        "「拼图」输出会把接入的图片按同一高度从左到右拼成一张，每张下方标注 <image1> 这样的标签，\n"
        "方便喂给只接受一张参考图的模型；拼图高度默认取最矮那张，也可以固定成 768 / 1024 / 1536 / 2048。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        inputs: dict = {}
        # 连线端口放在最前面（全部可选，接几个算几个）
        for i in range(1, LINK_SLOTS + 1):
            inputs[f"连接 {i}"] = (LINK_TYPE,)
        inputs["标签样式"] = (LABEL_STYLES, {"default": DEFAULT_LABEL_STYLE})
        inputs["语言"] = (LANG_OPTIONS, {"default": "中文", "tooltip": "生成提示词的语言（中文 / English / 日本語）"})
        inputs["句式模板"] = (TEMPLATE_OPTIONS, {"default": DEFAULT_TEMPLATE})
        inputs["自定义标签"] = ("STRING", {"default": DEFAULT_CUSTOM_LABEL, "multiline": False})
        inputs["自定义句式"] = (
            "STRING",
            {
                "default": "{人物}的人物以{姿势}的姿势穿上{服装}的服装",
                "multiline": True,
                "placeholder": "用 {人物} / {姿势} / {服装} 占位，例如：{姿势} 姿势的人，穿 {服装}",
            },
        )
        inputs["编号方式"] = (NUMBERING_OPTIONS, {"default": NUMBERING_OPTIONS[0]})
        inputs["拼图高度"] = (MONTAGE_HEIGHT_OPTIONS, {"default": MONTAGE_HEIGHT_OPTIONS[0]})
        inputs["补充提示词"] = (
            "STRING",
            {"default": "", "multiline": True, "placeholder": "可选：追加在末尾，如「全身，工作室灯光，8k」"},
        )
        return {"required": {}, "optional": inputs}

    # ------------------------------------------------------------------ 编号
    @staticmethod
    def _format_ref(index: int, style: str, custom: str, lang: str = "zh") -> str:
        if style in LABEL_STYLES[:3]:
            pattern = LABEL_PATTERNS_BY_LANG.get(style, {}).get(lang) or style
        else:
            pattern = custom or DEFAULT_CUSTOM_LABEL
        if "*" not in pattern:
            pattern = f"{pattern}*"
        return pattern.replace("*", str(index))

    @staticmethod
    def _parse_link(value):
        """连线里的数据可能是 dict，也可能被序列化成 JSON 字符串。"""
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            import json

            try:
                data = json.loads(value)
                if isinstance(data, dict):
                    return data
            except ValueError:
                pass
        return None

    # ------------------------------------------------------------------ 主逻辑
    def build(self, **kwargs):
        # 下拉值可能被前端按界面语言翻成英文 / 日文，这里统一归一回中文标准值
        style = _norm_option(kwargs.get("标签样式"), DEFAULT_LABEL_STYLE)
        custom_label = str(kwargs.get("自定义标签") or "").strip() or DEFAULT_CUSTOM_LABEL
        template_name = _norm_option(kwargs.get("句式模板"), DEFAULT_TEMPLATE)
        custom_tpl = str(kwargs.get("自定义句式") or "").strip()
        compact = _norm_option(kwargs.get("编号方式"), NUMBERING_OPTIONS[0]) == NUMBERING_OPTIONS[0]
        height_mode = _norm_option(kwargs.get("拼图高度"), MONTAGE_HEIGHT_OPTIONS[0])
        extra = str(kwargs.get("补充提示词") or "").strip()
        lang = LANG_CODES.get(str(kwargs.get("语言") or "").strip(), DEFAULT_LANG)
        link_labels = LINK_LABELS_BY_LANG.get(lang, LINK_LABELS_BY_LANG["zh"])

        entries = []  # [(number, role, ref, id, image)]
        order = 0
        for port in range(1, LINK_SLOTS + 1):
            link = self._parse_link(kwargs.get(f"连接 {port}"))
            if not link:
                continue
            role = str(link.get("kind") or "")
            if role not in LINK_LABELS:
                continue
            order += 1
            index = order if compact else port
            entries.append(
                (
                    index,
                    role,
                    self._format_ref(index, style, custom_label, lang),
                    str(link.get("id") or ""),
                    link.get("image"),
                )
            )

        if not entries:
            hint = EMPTY_HINTS.get(lang) or EMPTY_HINTS["zh"]
            return {"ui": {"text": [""], "pa_slots": [hint]}, "result": ("", self._blank_image())}

        refs = {}
        for _index, role, ref, _id, _image in entries:
            refs.setdefault(role, []).append(ref)

        if template_name == "自定义" or template_name not in PRESETS:
            text = self._render_custom(custom_tpl, refs)
            join_extra = "，"
        else:
            lang_presets = PRESETS[template_name]
            preset = lang_presets.get(lang) or lang_presets["zh"]
            parts = []
            for role, pattern in preset["clauses"]:
                if role not in refs:
                    continue
                parts.append(pattern.replace(self._placeholder(role), preset["multi_sep"].join(refs[role])))
            text = preset["sep"].join(parts) + preset["tail"]
            join_extra = preset.get("join_extra") or "，"

        if extra:
            text = f"{text}{join_extra}{extra}" if text else extra

        slots = [
            f"{index} · {link_labels.get(role, role)}" + (f" · {pid}" if pid else "")
            for index, role, _ref, pid, _img in entries
        ]
        montage = self._montage(
            [(index, ref, img) for index, _role, ref, _pid, img in entries if img is not None],
            height_mode,
        )
        return {"ui": {"text": [text], "pa_slots": slots}, "result": (text, montage)}

    @staticmethod
    def _placeholder(role: str) -> str:
        return {"portrait": "{人物}", "pose": "{姿势}", "costume": "{服装}"}[role]

    # ------------------------------------------------------------------ 拼图
    @staticmethod
    def _load_font(size: int):
        from PIL import ImageFont

        for path in FONT_CANDIDATES:
            try:
                return ImageFont.truetype(path, size)
            except Exception:  # noqa: BLE001 - 字体缺失是常态，逐个试过去
                continue
        try:
            return ImageFont.load_default(size=size)
        except TypeError:
            return ImageFont.load_default()

    @staticmethod
    def _to_pil(tensor):
        """ComfyUI 的 IMAGE（[B,H,W,C] 或 [H,W,C]，0–1 float）转 PIL。"""
        import numpy as np
        from PIL import Image

        frame = tensor
        if hasattr(frame, "dim") and frame.dim() == 4:
            frame = frame[0]  # 多视角 / angle=all 的 batch 只取第一张
        array = frame.detach().cpu().numpy()
        if array.dtype != np.uint8:
            array = (np.clip(array, 0.0, 1.0) * 255.0).round().astype(np.uint8)
        if array.shape[-1] == 4:
            array = array[..., :3]
        return Image.fromarray(array)

    @staticmethod
    def _blank_image(width: int = 64, height: int = 64):
        import numpy as np
        import torch

        canvas = np.full((1, height, width, 3), 1.0, dtype=np.float32)
        return torch.from_numpy(canvas)

    def _montage(self, items, height_mode: str):
        """items = [(序号, 标签, 图片张量)] → 一张横向拼图（ComfyUI IMAGE）。"""
        import numpy as np
        import torch
        from PIL import Image, ImageDraw

        tiles = [(label, self._to_pil(image)) for _index, label, image in items if image is not None]
        if not tiles:
            return self._blank_image()

        mode = str(height_mode or "").strip()
        target_h = None
        if mode and mode != MONTAGE_HEIGHT_OPTIONS[0]:
            try:
                target_h = int(mode)
            except ValueError:
                target_h = None
        if not target_h:
            target_h = min(image.height for _label, image in tiles)
        target_h = max(64, int(target_h))

        scaled = []
        for label, image in tiles:
            width = max(1, round(image.width * target_h / image.height))
            scaled.append((label, image.resize((width, target_h), Image.LANCZOS)))

        label_h = int(min(96, max(40, round(target_h * 0.09))))
        total_w = sum(image.width for _label, image in scaled) + MONTAGE_GAP * (len(scaled) - 1)
        canvas = Image.new("RGB", (total_w, target_h + label_h), MONTAGE_BACKGROUND)
        draw = ImageDraw.Draw(canvas)

        x = 0
        for label, image in scaled:
            canvas.paste(image, (x, 0))
            # 标签字号先按标签条高度定，太宽就缩到刚好放得下
            size = int(label_h * 0.72)
            for _ in range(8):
                font = self._load_font(size)
                box = draw.textbbox((0, 0), label, font=font)
                if box[2] - box[0] <= image.width - 6 or size <= 10:
                    break
                size = max(10, int(size * 0.85))
            font = self._load_font(size)
            box = draw.textbbox((0, 0), label, font=font)
            tx = x + (image.width - (box[2] - box[0])) / 2 - box[0]
            ty = target_h + (label_h - (box[3] - box[1])) / 2 - box[1]
            draw.text((tx, ty), label, font=font, fill=MONTAGE_TEXT)
            x += image.width + MONTAGE_GAP

        array = np.asarray(canvas, dtype=np.float32) / 255.0
        return torch.from_numpy(array).unsqueeze(0)

    @classmethod
    def _render_custom(cls, template: str, refs: dict) -> str:
        if not template:
            template = "{人物}的人物以{姿势}的姿势穿上{服装}的服装"
        text = template
        for token, role in CUSTOM_TEMPLATE_PLACEHOLDERS:
            if token not in text:
                continue
            replacement = "、".join(refs.get(role) or [])
            text = text.replace(token, replacement)
        # 占位被清空后把多余的分隔符收一收
        text = re.sub(r"\s{2,}", " ", text)
        text = re.sub(r"(?:，|、|,){2,}", lambda m: m.group(0)[0], text)
        return text.strip()


NODE_CLASS_MAPPINGS = {
    "RuiCPoseAtlasLoad": RuiCPoseAtlasLoad,
    "RuiCPoseAtlasRandom": RuiCPoseAtlasRandom,
    "RuiCPoseAtlasAngles": RuiCPoseAtlasAngles,
    "RuiCCostumeLoad": RuiCCostumeLoad,
    "RuiCCostumeRandom": RuiCCostumeRandom,
    "RuiCPortraitLoad": RuiCPortraitLoad,
    "RuiCPortraitRandom": RuiCPortraitRandom,
    "RuiCSmartPrompt": RuiCSmartPrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "RuiCPoseAtlasLoad": "姿态图库 · 加载 (Pose Atlas)",
    "RuiCPoseAtlasRandom": "姿态图库 · 随机 (Pose Atlas Random)",
    "RuiCPoseAtlasAngles": "姿态图库 · 多视角 (Pose Atlas Angles)",
    "RuiCCostumeLoad": "衣装图库 · 加载 (Costume Atlas)",
    "RuiCCostumeRandom": "衣装图库 · 随机 (Costume Random)",
    "RuiCPortraitLoad": "人像图库 · 加载 (Portrait Atlas)",
    "RuiCPortraitRandom": "人像图库 · 随机 (Portrait Random)",
    "RuiCSmartPrompt": "智能连接提示词 (Smart Prompt)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
