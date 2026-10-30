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
def load_tensors(variants: list[dict], device=None):
    """把若干变体读成 IMAGE / MASK 张量。返回 (image, mask)，形状 [B,H,W,C]。"""
    import numpy as np
    import torch
    from PIL import Image, ImageOps

    atlas = get_atlas()
    images, masks = [], []
    for variant in variants:
        path = atlas.image_path(variant)
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            arr = np.asarray(im).astype(np.float32) / 255.0

        img = torch.from_numpy(arr)
        if device is not None:
            img = img.to(device)
        images.append(img.unsqueeze(0))

        # 线稿没有 alpha 通道，这里用「反相亮度」当遮罩：
        # 白底 → 0，线条越深 → 越接近 1。适合直接拿去做局部重绘或叠加。
        lum = arr.mean(axis=2)
        mask = torch.from_numpy(1.0 - lum)
        if device is not None:
            mask = mask.to(device)
        masks.append(mask.unsqueeze(0))

    return torch.cat(images, dim=0), torch.cat(masks, dim=0)


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
