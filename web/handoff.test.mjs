import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptCandidate, commitFacts, createContextPackage, getCandidate, listCandidates, stageCandidate } from './handoff.mjs';

test('工作台与 InkFlow 的候选稿和事实入账闭环', () => {
  const base = mkdtempSync(join(tmpdir(), 'wenmai-handoff-'));
  const write = (path, content) => {
    const target = join(base, ...path.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  };
  try {
    write('运行记录/workflow-state.json', JSON.stringify({ chapters: [{ name: '第1章', approved: false }] }));
    write('知识库/世界观.md', '# 世界观\n不允许魔法');
    write('知识库/信息账本.json', JSON.stringify({ entries: [{ type: '历史', content: '旧事实', source: '序章', status: '已确认' }] }));
    write('知识库/信息账本.md', '# 信息账本\n- 历史：旧事实（来源：序章；状态：已确认）');
    write('正文/第一卷/第1章.txt', '旧正文');
    write('提示词/第一卷/第1章/强制设定锚点.md', '# 锚点\n角色不能知道秘密');
    const context = createContextPackage(base, '原创-测试', '第1章');
    assert.equal(context.kind, 'wenmai.chapter-context');
    assert.ok(context.assets.some(asset => asset.path.includes('第一卷/第1章')));
    assert.throws(() => stageCandidate(base, '原创-测试', { kind: 'wenmai.chapter-candidate', version: 1, project: '原创-测试', chapter: '第1章', baseRevision: 'old', content: '正文' }), /设定已变化/);
    const candidate = stageCandidate(base, '原创-测试', {
      kind: 'wenmai.chapter-candidate', version: 1, project: '原创-测试', chapter: '第1章',
      baseRevision: context.revision, content: '阿青发现了密钥。\n夜里灯光闪了三下。',
      source: { sessionId: 's1', messageId: 'm1', version: 2 },
    });
    assert.equal(listCandidates(base).length, 1);
    assert.match(getCandidate(base, candidate.id).content, /阿青发现/);
    adoptCandidate(base, '原创-测试', candidate.id);
    assert.match(readFileSync(join(base, '正文', '第一卷', '第1章.txt'), 'utf8'), /灯光闪了三下/);
    assert.equal(JSON.parse(readFileSync(join(base, '运行记录', 'workflow-state.json'), 'utf8')).chapters[0].approved, false);
    assert.throws(() => commitFacts(base, '第1章', [{ type: '伏笔', content: '灯闪三下', evidence: '灯光闪了三下。' }]), /尚未通过/);
    write('运行记录/workflow-state.json', JSON.stringify({ chapters: [{ name: '第1章', approved: true }] }));
    assert.throws(() => commitFacts(base, '第1章', [{ type: '伏笔', content: '灯闪三下', evidence: '不存在的句子' }]), /证据不合法/);
    const result = commitFacts(base, '第1章', [
      { type: '人物知情', content: '阿青知道密钥', evidence: '阿青发现了密钥。' },
      { type: '伏笔', content: '灯闪三下', evidence: '灯光闪了三下。', status: '待验证' },
    ]);
    assert.equal(result.added.length, 2);
    assert.equal(commitFacts(base, '第1章', [{ type: '伏笔', content: '灯闪三下', evidence: '灯光闪了三下。' }]).added.length, 0);
    const ledger = JSON.parse(readFileSync(join(base, '知识库', '信息账本.json'), 'utf8'));
    assert.equal(ledger.entries.length, 3);
    assert.equal(ledger.entries[1].validFromChapter, '第1章');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('只有 Markdown 的旧账本不会被静默覆盖', () => {
  const base = mkdtempSync(join(tmpdir(), 'wenmai-ledger-'));
  try {
    mkdirSync(join(base, '运行记录'), { recursive: true });
    mkdirSync(join(base, '知识库'), { recursive: true });
    mkdirSync(join(base, '正文'), { recursive: true });
    writeFileSync(join(base, '运行记录', 'workflow-state.json'), JSON.stringify({ chapters: [{ name: '第1章', approved: true }] }));
    writeFileSync(join(base, '知识库', '信息账本.md'), '# 信息账本\n- 历史：旧事实（来源：序章；状态：已确认）');
    writeFileSync(join(base, '正文', '第1章.txt'), '阿青发现了密钥。');
    assert.throws(() => commitFacts(base, '第1章', [{ type: '人物知情', content: '阿青知道密钥', evidence: '阿青发现了密钥。' }]), /只有 Markdown/);
    assert.match(readFileSync(join(base, '知识库', '信息账本.md'), 'utf8'), /旧事实/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
