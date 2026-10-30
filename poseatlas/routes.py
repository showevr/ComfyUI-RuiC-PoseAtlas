"""给前端图库面板用的 HTTP 路由。

三个图集的图片加起来接近 800 MB，不可能塞进 ComfyUI 的 web 目录再复制一份，
所以直接从节点目录按需读取：
    /poseatlas/media/img/xxx.png            姿势原图
    /poseatlas/media/thumbs/xxx.jpg         姿势缩略图
    /poseatlas/media/costume/img/xxx.webp   衣装原图
    /poseatlas/media/portrait/thumbs/...    人像缩略图
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from aiohttp import web

from .core import COSTUME_FILE, DATA_FILE, PORTRAIT_FILE, ROOT
from .tags import TAG_NAMES

LOGGER = logging.getLogger("RuiCPoseAtlas")

# 只允许访问这些顶层目录，避免任意文件读取
ALLOWED_DIRS = ("img", "thumbs", "costume", "portrait")
MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

_registered = False


def _resolve_media(rel_path: str):
    rel_path = (rel_path or "").replace("\\", "/").lstrip("/")
    parts = [p for p in rel_path.split("/") if p not in ("", ".", "..")]
    if len(parts) < 2 or parts[0] not in ALLOWED_DIRS:
        return None
    target = (ROOT / "/".join(parts)).resolve()
    try:
        target.relative_to(ROOT.resolve())
    except ValueError:
        return None
    if target.is_file():
        return target
    # 人像原图（portrait/img/，约 4.5 GB）不随仓库分发：
    # 前端统一按 full 路径请求，这里悄悄回落到同 id 的缩略图
    if len(parts) == 3 and parts[0] == "portrait" and parts[1] == "img":
        stem = Path(parts[2]).stem
        thumb = (ROOT / "portrait" / "thumbs" / f"{stem}.webp").resolve()
        try:
            thumb.relative_to(ROOT.resolve())
        except ValueError:
            return None
        if thumb.is_file():
            return thumb
    return None


def _json_file(path, missing: str):
    if not path.is_file():
        return web.json_response({"error": missing}, status=500)
    data = json.loads(path.read_text(encoding="utf-8"))
    return web.json_response(data, headers={"Cache-Control": "no-store"})


async def _api_index(request: web.Request) -> web.Response:
    return _json_file(DATA_FILE, "data/poses.json 缺失")


async def _api_costumes(request: web.Request) -> web.Response:
    return _json_file(COSTUME_FILE, "data/costumes.json 缺失")


async def _api_faces(request: web.Request) -> web.Response:
    return _json_file(PORTRAIT_FILE, "data/faces.json 缺失")


async def _api_tags(request: web.Request) -> web.Response:
    # 衣装标签的三语词典（web 目录不暴露 assets/，前端只能从这里拿）
    return web.json_response(TAG_NAMES, headers={"Cache-Control": "no-store"})


async def _media(request: web.Request) -> web.Response:
    target = _resolve_media(request.match_info.get("path", ""))
    if target is None:
        raise web.HTTPNotFound()
    resp = web.FileResponse(target)
    resp.headers["Content-Type"] = MIME.get(target.suffix.lower(), "application/octet-stream")
    # 文件名带编号，内容不会变，长缓存没有风险
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
        routes.get("/poseatlas/api/costumes")(_api_costumes)
        routes.get("/poseatlas/api/faces")(_api_faces)
        routes.get("/poseatlas/api/tags")(_api_tags)
        routes.get("/poseatlas/media/{path:.*}")(_media)
        _registered = True
        LOGGER.info(
            "[RuiC-PoseAtlas] 已注册 /poseatlas/api/{index,costumes,faces,tags} 与 /poseatlas/media/*"
        )
        return True
    except Exception as exc:  # pragma: no cover - 只可能发生在非 ComfyUI 环境
        LOGGER.warning("[RuiC-PoseAtlas] 路由注册失败：%s", exc)
        return False
