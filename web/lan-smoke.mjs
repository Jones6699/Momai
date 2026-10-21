import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('局域网章节资料、手机候选稿、桌面采用和事实入账', async () => {
  const root = mkdtempSync(join(tmpdir(), 'momai-lan-e2e-'));
  const web = join(root, 'web');
  mkdirSync(web);
  for (const name of ['server.mjs', 'handoff.mjs']) copyFileSync(new URL(name, import.meta.url), join(web, name));
  const port = await freePort();
  const childEnv = { ...process.env, NOVEL_LAN: '1', NOVEL_PORT: String(port) };
  delete childEnv.NODE_TEST_CONTEXT;
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: web, env: childEnv, stdio: 'ignore', windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { await request('/api/projects'); ready = true; break; } catch { await delay(100); }
    }
    assert.ok(ready, '局域网服务未启动');
    const project = '原创-局域网通路验收';
    const chapter = '第1章';
    assert.equal((await request('/api/projects', 'POST', { type: '原创', name: '局域网通路验收', defaultAssets: [] })).status, 201);
    const save = async (path, content) => assert.equal((await request('/api/file', 'PUT', { project, path, content })).status, 200);
    await save('运行记录/workflow-state.json', JSON.stringify({ chapters: [{ name: chapter, approved: false }] }));
    await save('知识库/世界观.md', '# 世界观\n潮汐塔每天午夜发出三次蓝光，城里没有魔法。');
    await save('知识库/信息账本.json', JSON.stringify({ entries: [] }));
    await save('正文/第1章.txt', '旧正文：黎舟还没有登上潮汐塔。');
    const pair = await request('/api/lan/pair', 'POST', { project, chapter });
    assert.equal(pair.status, 200);
    assert.match(pair.data.token, /^[A-F0-9]{12}$/);
    const forbidden = await request('/api/lan/context?token=WRONG');
    assert.equal(forbidden.status, 400);
    const context = await request(`/api/lan/context?token=${pair.data.token}`);
    assert.equal(context.status, 200);
    assert.match(context.data.assets[0].content, /潮汐塔/);
    const prose = '午夜，黎舟登上潮汐塔。塔顶连闪三次蓝光，他在铜钟背面发现一行刻字：第七码头的门只在退潮时开启。\n他把这条线索记进随身的航海日志。';
    const candidate = {
      kind: 'wenmai.chapter-candidate', version: 1, project, chapter,
      baseRevision: context.data.revision, content: prose,
      source: { sessionId: '模拟手机对话', messageId: '模拟回复', version: 0 },
    };
    const sent = await request('/api/lan/candidate', 'POST', { token: pair.data.token, package: candidate });
    assert.equal(sent.status, 201);
    const listed = await request(`/api/handoff/candidates?project=${encodeURIComponent(project)}`);
    assert.equal(listed.data.candidates.length, 1);
    const preview = await request(`/api/handoff/candidate?project=${encodeURIComponent(project)}&id=${sent.data.id}`);
    assert.match(preview.data.content, /第七码头/);
    const blocked = await request('/api/handoff/facts/commit', 'POST', { project, chapter, facts: [{ type: '伏笔', content: '退潮之门', evidence: '第七码头的门只在退潮时开启。' }] });
    assert.equal(blocked.status, 409);
    const adopted = await request('/api/handoff/adopt', 'POST', { project, id: sent.data.id });
    assert.equal(adopted.status, 200);
    const projectRoot = join(root, '小说项目', project);
    assert.match(readFileSync(join(projectRoot, '正文', `${chapter}.txt`), 'utf8'), /第七码头/);
    assert.ok(existsSync(join(projectRoot, '草稿', `${chapter}-采用前备份-${sent.data.id}.txt`)));
    assert.equal(JSON.parse(readFileSync(join(projectRoot, '运行记录', 'workflow-state.json'), 'utf8')).chapters[0].approved, false);
    // 真实校验需要模型；此处模拟作者在工作台完成验收后的状态，验证入账接口。
    await save('运行记录/workflow-state.json', JSON.stringify({ chapters: [{ name: chapter, approved: true }] }));
    const fact = { type: '伏笔', content: '第七码头的门只在退潮时开启', evidence: '第七码头的门只在退潮时开启。', status: '待验证' };
    const committed = await request('/api/handoff/facts/commit', 'POST', { project, chapter, facts: [fact] });
    assert.equal(committed.status, 200);
    assert.equal(committed.data.added.length, 1);
    const ledger = JSON.parse(readFileSync(join(projectRoot, '知识库', '信息账本.json'), 'utf8'));
    assert.equal(ledger.entries[0].evidence, fact.evidence);
  } finally {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
