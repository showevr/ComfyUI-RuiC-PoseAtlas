"""给前端图库面板用的 HTTP 路由。

图片有 654 MB，不可能塞进 ComfyUI 的 web 目录再复制一份，
所以直接从节点目录按需读取：/poseatlas/media/img/xxx.png
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from aiohttp import web

from .core import DATA_FILE, ROOT

LOGGER = logging.getLogger("RuiCPoseAtlas")

# 只允许访问这两个目录，避免任意文件读取
ALLOWED_DIRS = ("img", "thumbs")
MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

_registered = False


def _resolve_media(rel_path: str) -> Path | None:
    rel_path = (rel_path or "").replace("\\", "/").lstrip("/")
    parts = [p for p in rel_path.split("/") if p not in ("", ".", "..")]
    if len(parts) < 2 or parts[0] not in ALLOWED_DIRS:
        return None
    target = (ROOT / Path(*parts)).resolve()
    try:
        target.relative_to(ROOT.resolve())
    except ValueError:
        return None
    return target if target.is_file() else None


async def _api_index(request: web.Request) -> web.Response:
    if not DATA_FILE.is_file():
        return web.json_response({"error": "data/poses.json 缺失"}, status=500)
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    return web.json_response(data, headers={"Cache-Control": "no-store"})


async def _media(request: web.Request) -> web.Response:
    target = _resolve_media(request.match_info.get("path", ""))
    if target is None:
        raise web.HTTPNotFound()
    resp = web.FileResponse(target)
    resp.headers["Content-Type"] = MIME.get(target.suffix.lower(), "application/octet-stream")
    # 文件名带姿态编号，内容不会变，长缓存没有风险
    resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


def register_routes() -> bool:
    """把路由挂到 ComfyUI 的 aiohttp 应用上。重复调用安全。"""
    global _registered
    if _registered:
        return True
    try:
        from server import PromptServer  # 延迟导入，避免被单独 import 时炸掉

        routes = PromptServer.instance.routes
        routes.get("/poseatlas/api/index")(_api_index)
        routes.get("/poseatlas/media/{path:.*}")(_media)
        _registered = True
        LOGGER.info("[RuiC-PoseAtlas] 已注册 /poseatlas/api/index 与 /poseatlas/media/*")
        return True
    except Exception as exc:  # pragma: no cover - 只可能发生在非 ComfyUI 环境
        LOGGER.warning("[RuiC-PoseAtlas] 路由注册失败：%s", exc)
        return False
