import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class HandoffError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const maxAssetBytes = 180_000;
const maxProseBytes = 1_000_000;
const chapterName = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\\/:*?"<>|]/.test(value) || value.includes('..')) {
    throw new HandoffError('章节名称不合法');
  }
  return value.trim();
};
const digest = value => createHash('sha256').update(value).digest('hex');
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
const json = path => { try { return JSON.parse(read(path)); } catch { return {}; } };
const recordsDir = base => join(base, '运行记录', '移动候选');
const candidateFile = (base, id) => join(recordsDir(base), `${id}.json`);
const validId = id => {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new HandoffError('候选稿编号不合法');
  return id;
};
const fileAsset = (base, path) => ({ path, content: read(join(base, ...path.split('/'))) });

function prosePath(base, chapter) {
  const name = `${chapterName(chapter)}.txt`;
  const flat = join(base, '正文', name);
  if (existsSync(flat)) return flat;
  const root = join(base, '正文');
  if (existsSync(root)) {
    for (const volume of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory())) {
      const nested = join(root, volume.name, name);
      if (existsSync(nested)) return nested;
    }
  }
  return flat;
}

export function createContextPackage(base, project, chapter) {
  chapter = chapterName(chapter);
  if (!existsSync(base)) throw new HandoffError('项目不存在', 404);
  const state = json(join(base, '运行记录', 'workflow-state.json'));
  if (!Array.isArray(state.chapters) || !state.chapters.some(item => item.name === chapter)) {
    throw new HandoffError('该章节尚未在工作台创建', 404);
  }
  const worldview = existsSync(join(base, '知识库', '世界观.md')) ? '知识库/世界观.md' : '知识库/世界观.json';
  const flatAnchor = `提示词/${chapter}/强制设定锚点.md`;
  let anchor = flatAnchor;
  const promptRoot = join(base, '提示词');
  if (!existsSync(join(base, ...flatAnchor.split('/'))) && existsSync(promptRoot)) {
    for (const volume of readdirSync(promptRoot, { withFileTypes: true }).filter(item => item.isDirectory())) {
      const path = `提示词/${volume.name}/${chapter}/强制设定锚点.md`;
      if (existsSync(join(base, ...path.split('/')))) { anchor = path; break; }
    }
  }
  const paths = [
    worldview, '知识库/语言风格.md', '知识库/信息账本.md', anchor,
  ];
  for (const group of ['角色卡', '关系卡']) {
    const root = join(base, '知识库', group);
    if (existsSync(root)) {
      paths.push(...readdirSync(root).filter(name => name.endsWith('.md')).sort().map(name => `知识库/${group}/${name}`));
    }
  }
  const assets = paths.map(path => fileAsset(base, path)).filter(item => item.content);
  if (!assets.length) throw new HandoffError('项目尚无可导出的设定资产');
  if (Buffer.byteLength(JSON.stringify(assets), 'utf8') > maxAssetBytes) throw new HandoffError('章节资料超过 180KB，请精简角色卡后重试');
  const revision = digest(JSON.stringify({ project, chapter, assets }));
  return { kind: 'wenmai.chapter-context', version: 1, project, chapter, revision, createdAt: new Date().toISOString(), assets };
}

export function stageCandidate(base, project, input) {
  if (!input || input.kind !== 'wenmai.chapter-candidate' || input.version !== 1) throw new HandoffError('候选稿格式或版本不受支持');
  if (input.project !== project) throw new HandoffError('候选稿属于另一小说项目', 409);
  const chapter = chapterName(input.chapter);
  const currentRevision = createContextPackage(base, project, chapter).revision;
  if (input.baseRevision !== currentRevision) throw new HandoffError('桌面设定已变化，请重新导出章节资料并核对手机稿件', 409);
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!content || Buffer.byteLength(content, 'utf8') > maxProseBytes) throw new HandoffError('候选稿为空或超过 1MB');
  const id = randomUUID();
  const draftPath = join(base, '草稿', `${chapter}-移动候选-${id}.txt`);
  mkdirSync(join(base, '草稿'), { recursive: true });
  mkdirSync(recordsDir(base), { recursive: true });
  writeFileSync(draftPath, content + '\n', 'utf8');
  const record = {
    id, project, chapter, baseRevision: input.baseRevision, status: 'staged',
    draftPath: `草稿/${chapter}-移动候选-${id}.txt`,
    source: {
      sessionId: String(input.source?.sessionId || '').slice(0, 120),
      messageId: String(input.source?.messageId || '').slice(0, 120),
      version: Number.isInteger(input.source?.version) ? input.source.version : 0,
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(candidateFile(base, id), JSON.stringify(record, null, 2) + '\n', 'utf8');
  return { ...record, content };
}

export function listCandidates(base) {
  if (!existsSync(recordsDir(base))) return [];
  return readdirSync(recordsDir(base)).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))
    .map(name => json(join(recordsDir(base), name))).filter(item => item.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getCandidate(base, id) {
  const record = json(candidateFile(base, validId(id)));
  if (!record.id) throw new HandoffError('候选稿不存在', 404);
  return { ...record, content: read(join(base, ...record.draftPath.split('/'))) };
}

export function adoptCandidate(base, project, id) {
  const record = getCandidate(base, id);
  if (record.project !== project) throw new HandoffError('候选稿项目不匹配', 409);
  if (record.status !== 'staged') throw new HandoffError('该候选稿已采用');
  if (createContextPackage(base, project, record.chapter).revision !== record.baseRevision) {
    throw new HandoffError('项目设定已变化，请重新核对候选稿', 409);
  }
  const target = prosePath(base, record.chapter);
  mkdirSync(join(base, '正文'), { recursive: true });
  mkdirSync(join(base, '草稿'), { recursive: true });
  if (existsSync(target) && read(target).trim()) {
    copyFileSync(target, join(base, '草稿', `${record.chapter}-采用前备份-${id}.txt`));
  }
  writeFileSync(target, record.content.trimEnd() + '\n', 'utf8');
  const workflowPath = join(base, '运行记录', 'workflow-state.json');
  const workflow = json(workflowPath);
  if (Array.isArray(workflow.chapters)) {
    const item = workflow.chapters.find(chapter => chapter.name === record.chapter);
    if (item) { item.approved = false; item.checked = false; }
    writeFileSync(workflowPath, JSON.stringify(workflow, null, 2) + '\n', 'utf8');
  }
  const next = { ...record, status: 'adopted', adoptedAt: new Date().toISOString() };
  delete next.content;
  writeFileSync(candidateFile(base, id), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { ...next, prosePath: target };
}

export function commitFacts(base, chapter, facts) {
  chapter = chapterName(chapter);
  if (!Array.isArray(facts) || !facts.length || facts.length > 20) throw new HandoffError('请选择 1–20 条事实');
  const state = json(join(base, '运行记录', 'workflow-state.json'));
  if (!Array.isArray(state.chapters) || !state.chapters.some(item => item.name === chapter && item.approved === true)) {
    throw new HandoffError('章节尚未通过工作台验收，不能更新正式账本', 409);
  }
  const prose = read(prosePath(base, chapter));
  if (!prose.trim()) throw new HandoffError('正式正文不存在');
  const ledgerJson = join(base, '知识库', '信息账本.json');
  const ledgerMd = join(base, '知识库', '信息账本.md');
  const ledger = json(ledgerJson);
  if (ledger.entries && !Array.isArray(ledger.entries)) throw new HandoffError('现有信息账本结构异常');
  if (!existsSync(ledgerJson) && read(ledgerMd).replace(/^# 信息账本\s*/, '').trim()) {
    throw new HandoffError('现有账本只有 Markdown，缺少结构化 JSON；请先在工作台整理为结构化账本，避免覆盖旧条目', 409);
  }
  const entries = Array.isArray(ledger.entries) ? [...ledger.entries] : [];
  const added = [];
  for (const fact of facts) {
    const type = fact?.type;
    const content = String(fact?.content || '').trim();
    const evidence = String(fact?.evidence || '').trim();
    const status = String(fact?.status || '已确认');
    if (!['人物知情', '伏笔'].includes(type) || !content || content.length > 300 || !evidence || evidence.length > 300 || !prose.includes(evidence)) {
      throw new HandoffError('事实类型、内容或原文证据不合法');
    }
    if (!['已确认', '待验证', '已回收'].includes(status)) throw new HandoffError('事实状态不合法');
    if (entries.some(item => item.type === type && item.content === content && item.source === chapter)) continue;
    const entry = { id: randomUUID(), type, content, source: chapter, status, evidence, validFromChapter: chapter };
    entries.push(entry); added.push(entry);
  }
  if (!added.length) return { added: [], total: entries.length };
  mkdirSync(join(base, '知识库'), { recursive: true });
  const backup = join(base, '运行记录', '账本备份');
  mkdirSync(backup, { recursive: true });
  const backupId = randomUUID();
  if (existsSync(ledgerJson)) copyFileSync(ledgerJson, join(backup, `${backupId}.json`));
  if (existsSync(ledgerMd)) copyFileSync(ledgerMd, join(backup, `${backupId}.md`));
  writeFileSync(ledgerJson, JSON.stringify({ ...ledger, entries }, null, 2) + '\n', 'utf8');
  const lines = ['# 信息账本', '', ...entries.map(item => `- ${item.type || '条目'}：${item.content || '待补充'}（来源：${item.source || '待补充'}；状态：${item.status || '待补充'}）`)];
  writeFileSync(ledgerMd, lines.join('\n') + '\n', 'utf8');
  return { added, total: entries.length };
}
