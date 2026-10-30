"""RuiC-PoseAtlas 的 ComfyUI 集成包。

静态站点部分（index.html / assets / data / img / thumbs）保持原样，
这里只加一层「让 ComfyUI 能用」的适配：节点 + 图片路由 + 图库面板。
"""

from .core import ANGLE_KEYS, PoseAtlas, PoseAtlasError, get_atlas
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .routes import register_routes

__all__ = [
    "ANGLE_KEYS",
    "PoseAtlas",
    "PoseAtlasError",
    "get_atlas",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "register_routes",
]
