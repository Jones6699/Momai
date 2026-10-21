"""从已采用的章节正文提取待人工确认的账本候选，不直接写入资产。"""
from __future__ import annotations

import argparse
import json

from LLM配置 import generate_json
from 共享 import chapter_prose, project_dir, read_text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--chapter", required=True)
    args = parser.parse_args()
    base = project_dir(args.project)
    prose = read_text(chapter_prose(base, args.chapter))
    if not prose.strip():
        raise ValueError("请先采用候选稿，或保存本章正文")
    schema = {
        "type": "object", "required": ["facts"],
        "properties": {"facts": {"type": "array", "maxItems": 8, "items": {
            "type": "object", "required": ["type", "content", "status", "evidence"],
            "properties": {
                "type": {"type": "string", "enum": ["人物知情", "伏笔"]},
                "content": {"type": "string"},
                "status": {"type": "string", "enum": ["已确认", "待验证", "已回收"]},
                "evidence": {"type": "string"},
            },
        }}},
    }
    result = generate_json(
        step_id="validate",
        fields={"task": "只从本章正文识别人物知情变化和伏笔状态变化；不得创作新事实。每条 evidence 必须是正文里连续、逐字相同的短句。没有足够证据则返回空数组。", "chapter": args.chapter},
        context=f"【本章正式正文】\n{prose}\n\n【现有信息账本】\n{read_text(base / '知识库' / '信息账本.md')}",
        json_schema=schema,
    )
    facts = []
    for item in result.get("facts", []) if isinstance(result, dict) else []:
        if not isinstance(item, dict):
            continue
        evidence = str(item.get("evidence") or "").strip()
        content = str(item.get("content") or "").strip()
        if (item.get("type") in {"人物知情", "伏笔"}
                and item.get("status") in {"已确认", "待验证", "已回收"}
                and content and len(content) <= 300 and evidence
                and len(evidence) <= 300 and evidence in prose):
            facts.append({"type": item["type"], "content": content,
                          "status": item["status"], "evidence": evidence})
    print(json.dumps({"facts": facts[:8]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
