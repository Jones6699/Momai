(() => {
  const $ = id => document.getElementById(id);
  const modal = $('handoffModal');
  let selected = null;
  const project = () => window.novelLocal?.active?.();
  const chapter = () => $('handoffChapter').value;
  const status = message => { $('handoffStatus').textContent = message; };
  const api = async (url, body) => {
    const response = await fetch(url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作失败');
    return data;
  };
  const query = (path, params) => `${path}?${new URLSearchParams(params)}`;
  const run = async action => { try { await action(); } catch (error) { status(error.message); } };
  const download = (name, data) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const appendFact = fact => {
    const row = document.createElement('div'); row.className = 'handoff-fact';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.className = 'handoff-fact-check';
    const type = document.createElement('select');
    for (const value of ['人物知情', '伏笔']) { const option = new Option(value, value); type.add(option); }
    type.value = fact.type || '人物知情';
    const state = document.createElement('select');
    for (const value of ['已确认', '待验证', '已回收']) state.add(new Option(value, value));
    state.value = fact.status || '已确认';
    const content = document.createElement('input'); content.type = 'text'; content.placeholder = '确认后的事实'; content.value = fact.content || '';
    const evidence = document.createElement('input'); evidence.type = 'text'; evidence.placeholder = '正式正文中逐字相同的证据'; evidence.value = fact.evidence || '';
    row.append(checkbox, type, state, content, evidence); $('handoffFacts').append(row);
  };
  async function refresh(preferredChapter = '') {
    const item = project();
    $('handoffChapter').replaceChildren(); $('handoffCandidates').replaceChildren();
    $('handoffPreview').value = ''; $('handoffFacts').replaceChildren(); selected = null;
    if (!item) { status('请先选择一个小说项目'); return; }
    for (const entry of item.chapters || []) $('handoffChapter').add(new Option(entry.displayName || entry.name, entry.name));
    const current = item.chapters?.find(entry => entry.id === item.chapterId);
    if (preferredChapter && item.chapters?.some(entry => entry.name === preferredChapter)) $('handoffChapter').value = preferredChapter;
    else if (current) $('handoffChapter').value = current.name;
    if (!chapter()) { status('请先创建章节'); return; }
    const result = await api(query('/api/handoff/candidates', { project: item.diskName }));
    for (const record of result.candidates.filter(entry => entry.chapter === chapter())) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${new Date(record.createdAt).toLocaleString()} · ${record.status === 'adopted' ? '已采用' : '待采用'} · ${record.id.slice(0, 8)}`;
      button.addEventListener('click', () => run(async () => {
        selected = await api(query('/api/handoff/candidate', { project: item.diskName, id: record.id }));
        $('handoffPreview').value = selected.content;
        status(`已预览 ${selected.chapter} 的候选稿`);
      }));
      $('handoffCandidates').append(button);
    }
    status('章节资料与候选稿通过 JSON 文件传递，不会自动覆盖正式正文。');
  }
  $('handoffOpen').addEventListener('click', () => { modal.classList.remove('hidden'); run(refresh); });
  $('handoffClose').addEventListener('click', () => modal.classList.add('hidden'));
  $('handoffChapter').addEventListener('change', () => { const name = chapter(); run(() => refresh(name)); });
  $('handoffExport').addEventListener('click', () => run(async () => {
    const item = project(); if (!item || !chapter()) throw new Error('请先选择项目与章节');
    const data = await api(query('/api/handoff/context', { project: item.diskName, chapter: chapter() }));
    download(`${item.diskName}-${chapter()}-文脉资料.json`, data);
    status(`已导出 ${data.assets.length} 份设定资料，版本 ${data.revision.slice(0, 12)}`);
  }));
  $('handoffLanPair').addEventListener('click', () => run(async () => {
    const item = project(); if (!item || !chapter()) throw new Error('请先选择项目与章节');
    const pair = await api('/api/lan/pair', { project: item.diskName, chapter: chapter() });
    $('handoffLanInfo').classList.remove('hidden');
    $('handoffLanQr').src = pair.qrDataUrl || '';
    $('handoffLanUrl').textContent = pair.urls[0] || '未发现局域网地址';
    $('handoffLanToken').textContent = pair.token;
    status('局域网配对已生成，请在手机墨脉中输入地址和配对码');
  }));
  $('handoffImport').addEventListener('change', event => run(async () => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > 1_100_000) throw new Error('候选稿文件不能超过 1MB');
      const data = JSON.parse(await file.text());
      if (data.chapter !== chapter()) throw new Error('候选稿章节与当前选择不一致');
      await api('/api/handoff/candidate', { project: project().diskName, package: data });
      await refresh(data.chapter); status('候选稿已存入草稿区；请预览并决定是否采用');
    } finally { event.target.value = ''; }
  }));
  $('handoffAdopt').addEventListener('click', () => run(async () => {
    if (!selected || selected.status !== 'staged') throw new Error('请先选择待采用的候选稿');
    if (!project()?.initialized) throw new Error('请先完成项目初始化');
    if (window.novelSettings?.isStepEnabled?.('validate') === false) throw new Error('请先在设置中启用「校验与验收」步骤');
    if (!confirm(`采用 ${selected.chapter} 的手机候选稿？现有正文会备份到草稿区。`)) return;
    await api('/api/handoff/adopt', { project: project().diskName, id: selected.id });
    const path = window.novelLocal.prosePathOf(project(), selected.chapter);
    await window.novelLocal.markCandidateAdopted(selected.chapter, selected.content, path);
    await refresh(selected.chapter); status('候选稿已采用并进入原有校验流程；通过验收后再更新账本');
  }));
  $('handoffSuggest').addEventListener('click', () => run(async () => {
    const item = project(); if (!item || !chapter()) throw new Error('请先选择章节');
    status('正在根据正式正文提取候选事实…');
    const result = await api('/api/handoff/facts/suggest', { project: item.diskName, chapter: chapter() });
    $('handoffFacts').replaceChildren(); result.facts.forEach(appendFact);
    status(`提取到 ${result.facts.length} 条候选；请核对并勾选`);
  }));
  $('handoffAddFact').addEventListener('click', () => appendFact({}));
  $('handoffCommit').addEventListener('click', () => run(async () => {
    const rows = [...$('handoffFacts').querySelectorAll('.handoff-fact')].filter(row => row.querySelector('input[type=checkbox]').checked);
    const facts = rows.map(row => ({
      type: row.querySelectorAll('select')[0].value,
      status: row.querySelectorAll('select')[1].value,
      content: row.querySelectorAll('input[type=text]')[0].value.trim(),
      evidence: row.querySelectorAll('input[type=text]')[1].value.trim(),
    }));
    if (!facts.length) throw new Error('请先勾选要入账的事实');
    if (!confirm(`确认将 ${facts.length} 条有原文证据的事实写入正式信息账本？`)) return;
    const result = await api('/api/handoff/facts/commit', { project: project().diskName, chapter: chapter(), facts });
    $('handoffFacts').replaceChildren(); status(`已入账 ${result.added.length} 条；重复事实已跳过。请刷新工作台查看新账本。`);
  }));
  document.addEventListener('novel:chapter-approved', event => {
    if (modal.classList.contains('hidden')) modal.classList.remove('hidden');
    run(async () => { await refresh(event.detail.chapter); status('本章验收通过。现在可提取并确认事实。'); });
  });
})();
