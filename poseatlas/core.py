"""RuiC-PoseAtlas 数据层。

只做三件事：
1. 读取 data/poses.json 并建立索引；
2. 把 combo 里的字符串解析回姿态 / 角度；
3. 把图片加载成 ComfyUI 的 IMAGE / MASK 张量。

设计原则：模块导入时不做任何重活，全部懒加载，避免拖慢 ComfyUI 启动。
"""

from __future__ import annotations

import json
import random
import re
import threading
from pathlib import Path

# 节点根目录（RuiC-PoseAtlas/）
ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "poses.json"
IMAGE_DIR = ROOT / "img"
THUMB_DIR = ROOT / "thumbs"

# 衣装图鉴 / 人像图鉴
COSTUME_FILE = ROOT / "data" / "costumes.json"
PORTRAIT_FILE = ROOT / "data" / "faces.json"
COSTUME_DIR = ROOT / "costume"
PORTRAIT_DIR = ROOT / "portrait"

# 稳定的角度 key（与 data/poses.json 中 variants[].angle 一致，顺序即展示顺序）
ANGLE_KEYS = ("front", "diagonal", "side", "high", "low")
LANGUAGES = ("zh", "en", "ja")
DEFAULT_LANGUAGE = "zh"

# combo 字符串的分隔符：  "P001 / full_sexy / S形站姿・胯部侧顶"
LABEL_SEP = " / "
# 解析时只看前两段（编号 + 系列 key），这两个字段是稳定的机器标识，
# 所以即使名称改了、界面语言换了，旧工作流里存的值仍然能解析回同一个姿态。
_LABEL_RE = re.compile(r"^\s*([A-Za-z0-9]+)\s*/\s*([A-Za-z0-9_]+)")


class PoseAtlasError(RuntimeError):
    """数据缺失或选项无法解析时抛出，消息会直接显示在 ComfyUI 里。"""


class PoseAtlas:
    """poses.json 的只读索引。整个进程共用一个实例。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._ready = False
        self.data: dict = {}
        self.poses: list[dict] = []
        self.by_id: dict[str, dict] = {}
        self.by_series_no: dict[tuple[str, str], dict] = {}
        self.series: list[dict] = []
        self.series_by_key: dict[str, dict] = {}
        self.categories: list[dict] = []
        self.angle_names: dict[str, dict] = {}
        self.totals: dict = {}

    # ------------------------------------------------------------------ 加载
    def ensure(self) -> "PoseAtlas":
        if self._ready:
            return self
        with self._lock:
            if self._ready:
                return self
            if not DATA_FILE.is_file():
                raise PoseAtlasError(
                    f"找不到数据文件：{DATA_FILE}\n"
                    "请确认 RuiC-PoseAtlas 完整下载（data/poses.json 与 img/ 图片需要一起存在）。"
                )
            data = json.loads(DATA_FILE.read_text(encoding="utf-8"))

            self.data = data
            self.poses = list(data.get("poses") or [])
            self.by_id = {p["id"]: p for p in self.poses}
            # 注意：id 的前缀并不等于 series（例如 full_single_P019 属于 full_std），
            # 所以另外建一份 (series, no) 索引，label 解析一律走这里。
            self.by_series_no = {
                (p.get("series", ""), str(p.get("no", "")).upper()): p for p in self.poses
            }
            self.series = list(data.get("series") or [])
            self.series_by_key = {s["key"]: s for s in self.series}
            self.categories = list(data.get("categories") or [])
            self.angle_names = {a["key"]: a.get("names", {}) for a in (data.get("angles") or [])}
            self.totals = data.get("totals") or {}

            if not self.poses:
                raise PoseAtlasError(f"{DATA_FILE} 里没有任何姿态记录。")

            # 补一个便于 UI 使用的字段：每组的可用角度
            for p in self.poses:
                p.setdefault("variants", [])
                p["_angles"] = [v.get("angle") for v in p["variants"]]

            self._ready = True
            return self

    # ------------------------------------------------------------------ 命名
    @staticmethod
    def label(pose: dict, lang: str = DEFAULT_LANGUAGE) -> str:
        """生成 combo 里显示的名字：P001 / full_sexy / S形站姿・胯部侧顶"""
        names = pose.get("names") or {}
        name = names.get(lang) or names.get("zh") or names.get("en") or pose["id"]
        return f"{pose.get('no', pose['id'])}{LABEL_SEP}{pose.get('series', '')}{LABEL_SEP}{name}"

    def labels(self, lang: str = DEFAULT_LANGUAGE) -> list[str]:
        self.ensure()
        return [self.label(p, lang) for p in self.poses]

    def angle_label(self, key: str, lang: str = DEFAULT_LANGUAGE) -> str:
        names = self.angle_names.get(key) or {}
        return names.get(lang) or key

    # ------------------------------------------------------------------ 解析
    def resolve(self, value) -> dict:
        """把任意形式的选项字符串解析成 pose 记录。支持：
        - 姿态 id            "full_sexy_P001"
        - combo 标签          "P001 / full_sexy / 任意名称"
        - 编号 + 系列         "P001 / full_sexy"
        - 姿态名称            "S形站姿・胯部侧顶"
        """
        self.ensure()
        text = (value or "").strip() if isinstance(value, str) else ""
        if not text:
            raise PoseAtlasError("没有选择姿态（pose 为空）。")

        # 1) 直接命中 id
        if text in self.by_id:
            return self.by_id[text]

        # 2) 命中 "编号 / 系列" 前缀（名称部分随语言变化也不影响）
        m = _LABEL_RE.match(text)
        if m:
            pose = self.by_series_no.get((m.group(2), m.group(1).upper()))
            if pose:
                return pose

        # 3) 形如 "full_sexy_P019" 的宽松匹配：先当 id，再拆成系列 + 编号
        m = re.search(r"([A-Za-z0-9_]+?)_(P\d+)", text, re.IGNORECASE)
        if m:
            prefix, no = m.group(1), m.group(2).upper()
            pose = self.by_id.get(f"{prefix}_{no}") or self.by_series_no.get((prefix, no))
            if pose:
                return pose

        # 4) 按名称匹配（三语）
        for pose in self.poses:
            if text in (pose.get("names") or {}).values():
                return pose

        # 5) 只有一个系列时允许只给编号
        m = re.fullmatch(r"\s*(P\d+)\s*", text, re.IGNORECASE)
        if m:
            hits = [p for p in self.poses if str(p.get("no", "")).upper() == m.group(1).upper()]
            if len(hits) == 1:
                return hits[0]
            if hits:
                raise PoseAtlasError(
                    f"编号 {m.group(1)} 在多个系列里都存在，请使用完整写法，例如 "
                    f"{self.label(hits[0])}"
                )

        raise PoseAtlasError(
            f"无法识别的姿态选项：{text!r}。\n"
            "请在节点的下拉框里重新选择，或使用形如 \"P001 / full_sexy\" 的写法。"
        )

    def variants_of(self, pose: dict, angle) -> list[dict]:
        """取某个角度的变体；angle 为 all/空 时返回全部可用角度。"""
        variants = pose.get("variants") or []
        order = {k: i for i, k in enumerate(ANGLE_KEYS)}
        variants = sorted(variants, key=lambda v: order.get(v.get("angle"), 99))

        if angle in (None, "", "all", "*"):
            return variants

        for v in variants:
            if v.get("angle") == angle:
                return [v]
        available = ", ".join(v.get("angle", "?") for v in variants)
        raise PoseAtlasError(
            f"姿态 {self.label(pose)} 没有角度 {angle!r}（可用角度：{available}）。"
        )

    # ------------------------------------------------------------------ 筛选
    def filter_poses(self, series: str = "all", category: str = "all") -> list[dict]:
        self.ensure()
        out = self.poses
        if series and series != "all":
            out = [p for p in out if p.get("series") == series]
        if category and category != "all":
            out = [p for p in out if p.get("category") == category]
        return out

    def pick_random(self, seed: int, series: str = "all", category: str = "all") -> dict:
        pool = self.filter_poses(series, category)
        if not pool:
            raise PoseAtlasError(
                f"筛选条件下没有姿态（series={series!r}, category={category!r}）。"
            )
        return pool[random.Random(int(seed) & 0xFFFFFFFFFFFFFFFF).randrange(len(pool))]

    # ------------------------------------------------------------------ 图片
    def image_path(self, variant: dict) -> Path:
        rel = variant.get("full") or variant.get("thumb") or ""
        path = (ROOT / rel).resolve()
        if not path.is_file():
            raise PoseAtlasError(
                f"图片文件缺失：{rel}\n请重新完整拉取仓库图片资源（npm run fetch-images）。"
            )
        return path


_INSTANCE = PoseAtlas()


def get_atlas() -> PoseAtlas:
    return _INSTANCE


# ---------------------------------------------------------------------- 转张量
def read_tensor(path: Path, mask_mode: str = "line", device=None):
    """读一张图，返回 (image[H,W,C], mask[H,W])。

    mask_mode：
      - ``line``       姿态线稿：mask = 1 - 亮度（白底=0，线条越深越接近 1）
      - ``silhouette`` 衣装：按边框估背景色，mask = 背景比图片亮多少（白底=0，衣服接近 1）
      - ``full``       照片：整张全 1（人像没有天然遮罩）
    图片自带 alpha 时一律用 alpha 当 mask，忽略 mask_mode。
    """
    import numpy as np
    import torch
    from PIL import Image, ImageOps

    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        alpha = None
        if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
            alpha = np.asarray(im.convert("RGBA").getchannel("A")).astype(np.float32) / 255.0
        arr = np.asarray(im.convert("RGB")).astype(np.float32) / 255.0

    img = torch.from_numpy(arr)
    if device is not None:
        img = img.to(device)

    if alpha is not None:
        m = alpha
    elif mask_mode == "full":
        m = np.ones(arr.shape[:2], dtype=np.float32)
    elif mask_mode == "silhouette":
        # 衣装图是浅灰摄影棚背景，用「离背景色有多远」比单纯亮度靠谱得多：
        # 取边框一圈的中位色当背景，再按 RGB 距离归一化，衣服轮廓相当干净。
        ring = np.concatenate(
            [arr[:6].reshape(-1, 3), arr[-6:].reshape(-1, 3),
             arr[:, :6].reshape(-1, 3), arr[:, -6:].reshape(-1, 3)]
        )
        bg = np.median(ring, axis=0) if ring.size else np.array([1.0, 1.0, 1.0])
        dist = np.linalg.norm(arr - bg[None, None, :], axis=2)
        m = np.clip(dist / 0.45, 0.0, 1.0)
    else:  # line
        m = 1.0 - arr.mean(axis=2)

    mask = torch.from_numpy(np.ascontiguousarray(m))
    if device is not None:
        mask = mask.to(device)
    return img, mask


def stack_tensors(paths: list[Path], mask_mode: str = "line", device=None):
    """把多张图堆成 batch：[B,H,W,C] / [B,H,W]。"""
    import torch

    images, masks = [], []
    for path in paths:
        img, mask = read_tensor(path, mask_mode, device)
        images.append(img.unsqueeze(0))
        masks.append(mask.unsqueeze(0))
    return torch.cat(images, dim=0), torch.cat(masks, dim=0)


def load_tensors(variants: list[dict], device=None):
    """姿态变体 → IMAGE / MASK 张量。返回 (image, mask)，形状 [B,H,W,C]。"""
    atlas = get_atlas()
    paths = [atlas.image_path(v) for v in variants]
    return stack_tensors(paths, "line", device)



def build_info(pose: dict, variants: list[dict], lang: str = DEFAULT_LANGUAGE) -> str:
    """节点输出的可读文本，方便接到字符串节点或直接看。"""
    names = pose.get("names") or {}
    lines = [
        f"id: {pose['id']}",
        f"no: {pose.get('no', '')}",
        f"series: {pose.get('series', '')}",
        f"category: {pose.get('category', '')}",
    ]
    for key in LANGUAGES:
        value = names.get(key)
        if value:
            lines.append(f"name_{key}: {value}")
    lines.append(f"label: {PoseAtlas.label(pose, lang)}")
    lines.append("angles: " + ", ".join(v.get("angle", "?") for v in variants))
    if variants:
        lines.append("files: " + ", ".join(Path(v.get("full", "")).name for v in variants))
    return "\n".join(lines)


# ====================================================================== 衣装图鉴
class CostumeAtlas:
    """costumes.json 的只读索引（1,407 套无人衣装）。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._ready = False
        self.data: dict = {}
        self.costumes: list[dict] = []
        self.by_id: dict[str, dict] = {}
        self.categories: list[dict] = []
        self.category_names: dict[str, dict] = {}
        self.groups: list[dict] = []
        self.group_names: dict[str, dict] = {}
        self.colors: list[dict] = []
        self.totals: dict = {}

    def ensure(self) -> "CostumeAtlas":
        if self._ready:
            return self
        with self._lock:
            if self._ready:
                return self
            if not COSTUME_FILE.is_file():
                raise PoseAtlasError(
                    f"找不到衣装数据文件：{COSTUME_FILE}\n"
                    "请确认仓库完整（data/costumes.json 与 costume/ 图片需要一起存在）。"
                )
            data = json.loads(COSTUME_FILE.read_text(encoding="utf-8"))
            self.data = data
            self.costumes = list(data.get("costumes") or [])
            self.by_id = {c["id"].upper(): c for c in self.costumes}
            self.categories = list(data.get("categories") or [])
            self.category_names = {c["key"]: c.get("names") or {} for c in self.categories}
            self.groups = list(data.get("groups") or [])
            self.group_names = {g["key"]: g.get("names") or {} for g in self.groups}
            self.colors = list(data.get("colors") or [])
            self.totals = data.get("totals") or {}
            if not self.costumes:
                raise PoseAtlasError(f"{COSTUME_FILE} 里没有任何衣装记录。")
            self._ready = True
            return self

    # ------------------------------------------------------------------ 命名
    def category_label(self, key: str, lang: str = DEFAULT_LANGUAGE) -> str:
        names = self.category_names.get(key) or {}
        return names.get(lang) or names.get("zh") or names.get("en") or key

    def group_label(self, key: str, lang: str = DEFAULT_LANGUAGE) -> str:
        names = self.group_names.get(key) or {}
        return names.get(lang) or names.get("zh") or names.get("en") or key

    def color_label(self, key: str, lang: str = DEFAULT_LANGUAGE) -> str:
        from .tags import tag_name

        return tag_name(key, lang)

    def label(self, costume: dict, lang: str = DEFAULT_LANGUAGE) -> str:
        """SPR-0001 / spring / 春・连衣裙"""
        head = f"{costume.get('id', '')}{LABEL_SEP}{costume.get('cat', '')}"
        name = f"{self.category_label(costume.get('cat', ''), lang)}・{self.group_label(costume.get('group', ''), lang)}"
        return f"{head}{LABEL_SEP}{name}"

    def labels(self, lang: str = DEFAULT_LANGUAGE) -> list[str]:
        self.ensure()
        return [self.label(c, lang) for c in self.costumes]

    # ------------------------------------------------------------------ 解析
    def resolve(self, value) -> dict:
        """支持 `SPR-0001`、`SPR-0001 / spring / 春・连衣裙`、`spr-0001`。"""
        self.ensure()
        text = (value or "").strip() if isinstance(value, str) else ""
        if not text:
            raise PoseAtlasError("没有选择衣装（costume 为空）。")

        first = text.split("/")[0].strip()
        hit = self.by_id.get(first.upper())
        if hit:
            return hit

        m = re.search(r"([A-Za-z]{2,4}-\d{2,5})", text)
        if m and m.group(1).upper() in self.by_id:
            return self.by_id[m.group(1).upper()]

        raise PoseAtlasError(
            f"无法识别的衣装选项：{text!r}。\n请在节点的下拉框里重新选择，或使用形如 \"SPR-0001\" 的编号。"
        )

    # ------------------------------------------------------------------ 筛选
    def filter_costumes(self, cat: str = "all", group: str = "all") -> list[dict]:
        self.ensure()
        out = self.costumes
        if cat and cat != "all":
            out = [c for c in out if c.get("cat") == cat]
        if group and group != "all":
            out = [c for c in out if c.get("group") == group]
        return out

    def pick_random(self, seed: int, cat: str = "all", group: str = "all") -> dict:
        pool = self.filter_costumes(cat, group)
        if not pool:
            raise PoseAtlasError(f"筛选条件下没有衣装（cat={cat!r}, group={group!r}）。")
        return pool[random.Random(int(seed) & 0xFFFFFFFFFFFFFFFF).randrange(len(pool))]

    # ------------------------------------------------------------------ 图片
    def image_path(self, costume: dict, prefer_full: bool = True) -> Path:
        candidates = [costume.get("image"), costume.get("thumb")]
        if not prefer_full:
            candidates.reverse()
        for rel in candidates:
            if not rel:
                continue
            path = (ROOT / rel).resolve()
            if path.is_file():
                return path
        raise PoseAtlasError(
            f"衣装图片缺失：{costume.get('image') or costume.get('thumb')}\n"
            "请重新完整拉取仓库（costume/ 目录共 2,814 个文件）。"
        )


# ====================================================================== 人像图鉴
class PortraitAtlas:
    """faces.json 的只读索引（1,499 张 AI 人像）。

    注意：`portrait/img/` 全尺寸原图（约 4.5 GB）不随仓库分发，只带 400×500 缩略图。
    节点优先用原图，没有就回落到缩略图，并在 info 里标注实际尺寸。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._ready = False
        self.data: dict = {}
        self.images: list[dict] = []
        self.by_id: dict[str, dict] = {}
        self.sections: list[dict] = []
        self.section_names: dict[str, dict] = {}
        self.hairs: list[dict] = []
        self.hair_names: dict[str, dict] = {}
        self.totals: dict = {}

    def ensure(self) -> "PortraitAtlas":
        if self._ready:
            return self
        with self._lock:
            if self._ready:
                return self
            if not PORTRAIT_FILE.is_file():
                raise PoseAtlasError(
                    f"找不到人像数据文件：{PORTRAIT_FILE}\n"
                    "请确认仓库完整（data/faces.json 与 portrait/thumbs 需要一起存在）。"
                )
            data = json.loads(PORTRAIT_FILE.read_text(encoding="utf-8"))
            self.data = data
            self.images = list(data.get("images") or [])
            self.by_id = {str(i["id"]): i for i in self.images}
            self.sections = list(data.get("sections") or [])
            self.section_names = {s["key"]: s.get("names") or {} for s in self.sections}
            self.hairs = list(data.get("hairs") or [])
            self.hair_names = {h["key"]: h.get("names") or {} for h in self.hairs}
            self.totals = data.get("totals") or {}
            if not self.images:
                raise PoseAtlasError(f"{PORTRAIT_FILE} 里没有任何人像记录。")
            self._ready = True
            return self

    # ------------------------------------------------------------------ 命名
    def section_label(self, key: str, lang: str = DEFAULT_LANGUAGE) -> str:
        names = self.section_names.get(key) or {}
        return names.get(lang) or names.get("zh") or names.get("en") or key

    def hair_label(self, key: str, lang: str = DEFAULT_LANGUAGE) -> str:
        names = self.hair_names.get(key) or {}
        return names.get(lang) or names.get("zh") or names.get("en") or key

    def label(self, image: dict, lang: str = DEFAULT_LANGUAGE) -> str:
        """f71f980dde3 / face / 脸部・短发"""
        head = f"{image.get('id', '')}{LABEL_SEP}{image.get('sec', '')}"
        name = f"{self.section_label(image.get('sec', ''), lang)}・{self.hair_label(image.get('hair', ''), lang)}"
        return f"{head}{LABEL_SEP}{name}"

    def labels(self, lang: str = DEFAULT_LANGUAGE) -> list[str]:
        self.ensure()
        return [self.label(i, lang) for i in self.images]

    # ------------------------------------------------------------------ 解析
    def resolve(self, value) -> dict:
        self.ensure()
        text = (value or "").strip() if isinstance(value, str) else ""
        if not text:
            raise PoseAtlasError("没有选择人像（portrait 为空）。")

        first = text.split("/")[0].strip()
        if first in self.by_id:
            return self.by_id[first]

        m = re.search(r"\b([0-9a-f]{8,})\b", text, re.IGNORECASE)
        if m:
            hit = self.by_id.get(m.group(1).lower()) or self.by_id.get(m.group(1))
            if hit:
                return hit

        raise PoseAtlasError(
            f"无法识别的人像选项：{text!r}。\n请在节点的下拉框里重新选择。"
        )

    # ------------------------------------------------------------------ 筛选
    def filter_images(self, section: str = "all", hair: str = "all") -> list[dict]:
        self.ensure()
        out = self.images
        if section and section != "all":
            out = [i for i in out if i.get("sec") == section]
        if hair and hair != "all":
            out = [i for i in out if i.get("hair") == hair]
        return out

    def pick_random(self, seed: int, section: str = "all", hair: str = "all") -> dict:
        pool = self.filter_images(section, hair)
        if not pool:
            raise PoseAtlasError(f"筛选条件下没有人像（section={section!r}, hair={hair!r}）。")
        return pool[random.Random(int(seed) & 0xFFFFFFFFFFFFFFFF).randrange(len(pool))]

    # ------------------------------------------------------------------ 图片
    def image_path(self, image: dict) -> tuple[Path, bool]:
        """返回 (路径, 是否是原图)。原图不在仓库里时回落到缩略图。"""
        for rel, is_full in ((image.get("full"), True), (image.get("thumb"), False)):
            if not rel:
                continue
            path = (ROOT / rel).resolve()
            if path.is_file():
                return path, is_full
        raise PoseAtlasError(
            f"人像图片缺失：{image.get('thumb') or image.get('full')}\n"
            "请重新完整拉取仓库（portrait/thumbs 目录）。"
        )

    def image_size(self, image: dict) -> tuple[int, int]:
        path, is_full = self.image_path(image)
        if is_full:
            return int(image.get("w") or 0), int(image.get("h") or 0)
        return int(image.get("thumb_w") or 0), int(image.get("thumb_h") or 0)


_COSTUME_INSTANCE = CostumeAtlas()
_PORTRAIT_INSTANCE = PortraitAtlas()


def get_costume_atlas() -> CostumeAtlas:
    return _COSTUME_INSTANCE


def get_portrait_atlas() -> PortraitAtlas:
    return _PORTRAIT_INSTANCE


# ---------------------------------------------------------------------- 信息文本
def build_costume_info(costume: dict, lang: str = DEFAULT_LANGUAGE) -> str:
    from .tags import tag_name

    atlas = get_costume_atlas()
    tags = [tag_name(t, lang) for t in (costume.get("tags") or [])]
    lines = [
        f"id: {costume.get('id', '')}",
        f"category: {costume.get('cat', '')}",
        f"group: {costume.get('group', '')}",
        f"color: {costume.get('color', '')}",
        f"main: {costume.get('main', '')}",
        f"label: {atlas.label(costume, lang)}",
        "tags: " + ", ".join(tags),
    ]
    try:
        path = atlas.image_path(costume)
        lines.append(f"files: {path.name}")
    except PoseAtlasError:
        pass
    return "\n".join(lines)


def build_portrait_info(image: dict, lang: str = DEFAULT_LANGUAGE) -> str:
    atlas = get_portrait_atlas()
    style = (image.get("style") or "").strip()
    lines = [
        f"id: {image.get('id', '')}",
        f"section: {image.get('sec', '')}",
        f"hair: {image.get('hair', '')}",
        f"label: {atlas.label(image, lang)}",
    ]
    if style:
        lines.append(f"style: {style}")
    try:
        path, is_full = atlas.image_path(image)
        lines.append(f"files: {path.name}")
        w, h = atlas.image_size(image)
        lines.append(f"size: {w} × {h}" + ("" if is_full else "  (缩略图；原图未下载)"))
    except PoseAtlasError:
        pass
    return "\n".join(lines)
