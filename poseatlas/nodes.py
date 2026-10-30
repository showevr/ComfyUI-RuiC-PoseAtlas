"""RuiC-PoseAtlas 的 ComfyUI 节点。"""

from __future__ import annotations

from .core import (
    ANGLE_KEYS,
    DEFAULT_LANGUAGE,
    PoseAtlasError,
    build_info,
    get_atlas,
    load_tensors,
)

NODE_CATEGORY = "RuiC/姿态图库 PoseAtlas"

ANGLE_OPTIONS = list(ANGLE_KEYS) + ["all"]


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


class RuiCPoseAtlasLoad:
    """按姿态 + 角度从图库取图。"""

    CATEGORY = NODE_CATEGORY
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "info")
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
        return (image, mask, build_info(record, variants))


class RuiCPoseAtlasRandom:
    """按系列 / 分类随机抽一个姿态，适合批量出图。"""

    CATEGORY = NODE_CATEGORY
    FUNCTION = "pick"
    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "info")
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
        return (image, mask, info)


class RuiCPoseAtlasAngles:
    """把一张姿态的多个角度一次性取出来（多视角对照 / 多视角训练素材）。"""

    CATEGORY = NODE_CATEGORY
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "info")
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
        return (image, mask, build_info(record, variants))


NODE_CLASS_MAPPINGS = {
    "RuiCPoseAtlasLoad": RuiCPoseAtlasLoad,
    "RuiCPoseAtlasRandom": RuiCPoseAtlasRandom,
    "RuiCPoseAtlasAngles": RuiCPoseAtlasAngles,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "RuiCPoseAtlasLoad": "姿态图库 · 加载 (Pose Atlas)",
    "RuiCPoseAtlasRandom": "姿态图库 · 随机 (Pose Atlas Random)",
    "RuiCPoseAtlasAngles": "姿态图库 · 多视角 (Pose Atlas Angles)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
