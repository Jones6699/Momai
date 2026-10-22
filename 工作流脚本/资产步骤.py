"""世界观、语言风格、角色卡、关系卡、剧情书/卷和信息账本的真实步骤实现。"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any
from LLM配置 import generate_markdown, policy_for
from 共享 import checked_write, context, fail, read_text, run_reference, safe_name, stage_project, worldview_path
import 结构化JSON

def _relation_batch(base: Path, relations: list[dict[str, Any]], data: dict[str, Any]) -> list[str]:
    """逐张落盘；默认复用完整卡片，单项失败不丢弃其余结果。"""
    outputs: list[str] = []
    failures: list[str] = []
    progress_path = base / "运行记录" / "关系卡生成进度.json"
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []
    def save_progress() -> None:
        temporary = progress_path.with_suffix('.tmp')
        temporary.write_text(json.dumps({"total": len(relations), "completed": sum(x['status'] == 'completed' for x in items), "items": items}, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(progress_path)
    for rel in relations:
        a, b = safe_name(rel['character_a'], '角色 A'), safe_name(rel['character_b'], '角色 B')
        items.append({"character_a": a, "character_b": b, "status": "pending"})
    save_progress()
    for rel, item in zip(relations, items):
        a, b = item['character_a'], item['character_b']
        payload = {"character_a": a, "character_b": b, "relationship": rel.get('relationship') or '',
                   "output_guidance": "仅生成这一对角色的关系卡；每个描述字段不超过150字，不扩写其他角色，不新增无依据的经历。"}
        if data.get('user_input'):
            payload['user_input'] = data['user_input']
        item['status'] = 'running'
        save_progress()
        try:
            reused = None
            if not data.get('regenerate'):
                for left, right in ((a, b), (b, a)):
                    jp, mp = 结构化JSON.output_paths('compile_relation', base, {'character_a': left, 'character_b': right})
                    try:
                        card = json.loads(jp.read_text(encoding='utf-8'))
                        if (card.get('character_a'), card.get('character_b')) == (left, right) and all(isinstance(card.get(k), str) and card[k].strip() for k in ('称呼','关系','情感','共同经历','当前态度')) and mp.is_file() and mp.stat().st_size:
                            reused = [str(mp.relative_to(base)), str(jp.relative_to(base))]
                            break
                    except (OSError, ValueError, AttributeError):
                        pass
            if reused:
                outputs.extend(reused)
                item['reused'] = True
            else:
                sources = [base / '知识库' / '小说简介.md', worldview_path(base), base / '知识库' / '信息账本.md']
                for name in (a, b):
                    jp, mp = 结构化JSON.output_paths('generate_character', base, {'name': name})
                    sources.append(mp if mp.exists() else jp)
                outputs.extend(结构化JSON.run('compile_relation', base, payload, context(base, sources)))
            item['status'] = 'completed'
        except Exception as error:
            item['status'] = 'failed'
            item['error'] = str(error)
            failures.append(f'{a}—{b}：{error}')
        save_progress()
    if failures:
        fail(f'关系卡已完成 {sum(x["status"] == "completed" for x in items)}/{len(items)}。已完成卡片已保存，再次重试只补未完成项。失败详情：' + '；'.join(failures))
    return outputs

def _generate(base: Path, task: str, data: dict[str, Any], output: Path, contract: str, sources: list[Path]) -> list[str]:
    common = [base / "知识库" / "小说简介.md", base / "运行记录" / "初始化资料.md"]
    checked_write(base, task, output, generate_markdown(step_id=task, fields=data, context=context(base, [*common, *sources]), output_contract=contract))
    return [str(output.relative_to(base))]
def _json(base: Path, task: str, data: dict[str, Any], sources: list[Path]) -> list[str]:
    common = [base / "知识库" / "小说简介.md", base / "运行记录" / "初始化资料.md"]
    return 结构化JSON.run(task, base, data, context(base, [*common, *sources]))
def run(task: str, base: Path, data: dict[str, Any]) -> list[str]:
    if task == "compile_intro":
        summary = str(data.get("summary") or "").strip()
        if len(summary) > 100:
            fail("小说简介不能超过100字")
        return _json(base, task, data, [base / "运行记录" / "初始化资料.md"])
    if task == "generate_worldview":
        return _generate(base, task, data, base / "知识库" / "世界观.md", """# 世界观

## 小说类型

## 世界观基础

## 力量体系

## 势力
- 名称：
- 地位：
- 位置：
- 关键角色：角色名｜势力内身份｜境界/能力

## 资源设定""", [base / "剧情" / "剧情书.md", base / "知识库" / "信息账本.md"])
    if task == "generate_character":
        return _json(base, task, data, [worldview_path(base), base / "知识库" / "信息账本.md", base / "词汇库" / "人物词库.md"])
    if task == "compile_style":
        if not any(data.get(k) for k in ("narrative_rhythm", "tone", "sentence_paragraph", "psychology", "punctuation", "technique", "description", "person", "dialogue", "vocabulary")) and not data.get("user_input"): fail("语言风格至少需要一项")
        return _json(base, task, data, [worldview_path(base), base / "提取" / "原文风格.md"])
    if task == "compile_relation":
        return _json(base, task, data, [worldview_path(base), base / "知识库" / "信息账本.md"])
    if task in {"compile_plot", "compile_volume"}:
        if task == "compile_volume":
            data["kind"] = "volume"
        else:
            data.setdefault("kind", "book")
        sources = [worldview_path(base), base / "知识库" / "信息账本.md"]
        if task == "compile_volume":
            # PRD §7.2：剧情卷读取剧情书与知识库。
            sources.append(base / "剧情" / "剧情书.md")
        return _json(base, task, data, sources)
    if task == "compile_ledger":
        if "entries" in data and not isinstance(data.get("entries"), list): fail("entries 必须是数组")
        volume_dir = base / "剧情" / "剧情卷"
        return _json(base, task, data, [base / "剧情" / "剧情书.md", *(sorted(volume_dir.glob("*.md")) if volume_dir.exists() else [])])
    if task == "generate_characters_batch":
        roster_path = base / "知识库" / "角色名单.json"
        if not roster_path.exists():
            fail("缺少角色名单，请先生成角色名单")
        roster = json.loads(roster_path.read_text(encoding="utf-8"))
        characters = roster.get("characters") or []
        if not characters:
            fail("角色名单为空")
        outputs: list[str] = []
        for char in characters:
            if not isinstance(char, dict) or not str(char.get("name") or "").strip():
                continue
            payload = {"name": str(char["name"]).strip()}
            for key, value in char.items():
                if key != "name" and value not in (None, ""):
                    payload[key] = value
            if data.get("user_input"):
                payload["user_input"] = data["user_input"]
            outputs += _json(base, "generate_character", payload, [worldview_path(base), base / "知识库" / "信息账本.md", base / "词汇库" / "人物词库.md"])
        if not outputs:
            fail("角色名单中没有可生成的角色")
        return outputs
    if task == "generate_relations_batch":
        relations: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        roster_path = base / "知识库" / "角色名单.json"
        if roster_path.exists():
            roster = json.loads(roster_path.read_text(encoding="utf-8"))
            for char in roster.get("characters") or []:
                if not isinstance(char, dict) or not str(char.get("name") or "").strip():
                    continue
                a = str(char["name"]).strip()
                for rel in char.get("relations") or []:
                    if not isinstance(rel, dict) or not str(rel.get("target") or "").strip():
                        continue
                    b = str(rel["target"]).strip()
                    key = tuple(sorted([a, b]))
                    if key in seen:
                        continue
                    seen.add(key)
                    relations.append({"character_a": a, "character_b": b, "relationship": rel.get("relationship") or ""})
        if not relations:
            relation_dir = base / "知识库" / "关系卡"
            if relation_dir.exists():
                for path in sorted(relation_dir.glob("关系卡-*.json")):
                    try:
                        rel = json.loads(path.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    if not isinstance(rel, dict) or not str(rel.get("character_a") or "").strip() or not str(rel.get("character_b") or "").strip():
                        continue
                    a, b = str(rel["character_a"]).strip(), str(rel["character_b"]).strip()
                    key = tuple(sorted([a, b]))
                    if key in seen:
                        continue
                    seen.add(key)
                    relations.append({"character_a": a, "character_b": b, "relationship": rel.get("关系") or rel.get("relationship") or ""})
        if not relations:
            fail("没有可生成的关系：角色名单中缺少 relations，也没有已有关系卡可更新")
        return _relation_batch(base, relations, data)
    fail("资产步骤不支持：" + task)
