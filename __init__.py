"""RuiC-PoseAtlas —— 288 组 / 1,439 张多角度人体姿态参考图库的 ComfyUI 适配层。

原来这里只是一个纯静态站点（index.html + assets + data + img + thumbs），
放进 custom_nodes 也不会被 ComfyUI 识别。现在补上三件事：

  1. 节点：Load / Random / Angles，把姿态参考图直接输出成 IMAGE + MASK；
  2. 路由：/poseatlas/api/index、/poseatlas/media/*，让前端能读到数据和原图；
  3. 前端扩展：侧边栏「姿态图库」面板 + 节点上的「浏览图库」按钮。

静态站点本身仍然可以直接部署到 GitHub Pages / Cloudflare Pages，互不影响。
"""

import logging

from .poseatlas import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS, register_routes

LOGGER = logging.getLogger("RuiCPoseAtlas")

# ComfyUI 会把这里挂到 /extensions/<文件夹名>/ 下
WEB_DIRECTORY = "./web"

# 注册媒体 / 数据路由（失败不影响节点本身可用）
register_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

LOGGER.debug(
    "[RuiC-PoseAtlas] 已加载 %d 个节点：%s",
    len(NODE_CLASS_MAPPINGS),
    ", ".join(NODE_CLASS_MAPPINGS),
)
