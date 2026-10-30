#!/usr/bin/env node
/**
 * 把 assets/js/costume-tags.js 的 TAG_NAMES 导出成 poseatlas/tags.py。
 * 上游新增/修改衣装标签后重跑：node scripts/export-costume-tags.mjs
 */
import { writeFileSync } from "node:fs";
import { TAG_NAMES } from "../assets/js/costume-tags.js";

const keys = Object.keys(TAG_NAMES).sort();
const rows = keys.map((k) => {
  const v = TAG_NAMES[k];
  return `    "${k}": {"zh": "${v.zh || ""}", "en": "${v.en || ""}", "ja": "${v.ja || ""}"},`;
});

const out = `"""衣装标签的三语词典（${keys.length} 个关键词）。

数据来源：assets/js/costume-tags.js 的 TAG_NAMES，由脚本一次性导出，
避免 Python 侧去解析 JS。上游新增标签时重跑 scripts/export-costume-tags.mjs 即可，
未收录的标签会回落到英文 key。
"""

from __future__ import annotations

TAG_NAMES: dict[str, dict[str, str]] = {
${rows.join("\n")}
}


def tag_name(tag: str, lang: str = "zh") -> str:
    names = TAG_NAMES.get(tag)
    if not names:
        return tag
    return names.get(lang) or names.get("zh") or names.get("en") or tag
`;

writeFileSync(new URL("../poseatlas/tags.py", import.meta.url), out);
console.log(`poseatlas/tags.py · ${keys.length} tags`);
