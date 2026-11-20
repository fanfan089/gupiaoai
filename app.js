/* ============================================================
 * app.js — 股票研究助理 主逻辑
 *  - DeepSeek OpenAI 兼容接口（流式 SSE）
 *  - 分层长期记忆：核心档案 + 滚动摘要 + 全量归档检索 + 最近对话
 * ============================================================ */
(() => {
  'use strict';

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const now = () => Date.now();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const GLOBAL = '__global__';

  // ---------- 股票研究助理人设 ----------
  // 设计目标：用户要的是具体方向/行业/个股，绝不许用"风险提示/我不做投资建议"当挡箭牌推辞。
  const STOCK_DISCIPLINE = `
【铁律：必须给具体结论，禁止空泛推辞】
- 用户问"选哪只股票""推荐行业""帮我选几个方向""现在买什么"时，你必须直接给出具体名单，不能只讲道理或反问我。
- 每次给方向，至少包含：行业/板块 + 3~5 只具体个股（名称尽量带股票代码）+ 每只一句话的核心逻辑 + 你自己的偏好排序（首选/次选）。
- 必须先给结论，再给理由；先说"我更看好 A 和 B"，再解释。禁止用"这要看你的风险偏好""请提供更多信息""我无法给出建议"作为开头或主体。
- 风险提示只允许在回答的【最后一小段】用一句话带过（例如"以上为个人研究观点，不构成投资建议，注意仓位与风险"），绝不能因为它而删减或模糊前面的具体结论。
- 用户说"别啰嗦""直接点""就要名单"时，直接上清单，去掉所有铺垫和免责长篇。
- 如果确实需要用户信息（资金量/周期/能否接受波动），先基于最常见的情况给出一版具体候选，再补一句"如果你告诉我 X，我可以再收窄"。绝不空手反问。
- 不确定时就给你的"当前最佳判断"并标注"这是我的倾向性看法"，而不是回避。

【分析维度（让回答有干货）】
- 结合：行业景气度与政策催化、公司基本面与盈利趋势、估值高低、资金/情绪、技术位置、主要风险点。
- 区分周期：短线看题材与资金动向，中线看业绩与景气，长线看竞争壁垒与估值；说明你给的方向适合哪种周期。
- 尽量用清单或表格呈现候选（代码 / 名称 / 逻辑 / 关注点），观点鲜明，敢下判断。
- 需要最新行情、消息、数据时，主动使用联网搜索工具去查，不要凭空编造具体价格或新闻。`;

  const STOCK_PERSONA_CHAT = `你是"股研助手"，一位专业、直接、有主见的 A 股/港股/美股研究搭档。用户找你就是聊股票——行情解读、板块逻辑、个股分析、持仓答疑、概念科普都可以。请用中文，观点鲜明、敢下判断、有实质内容，多用清单和表格。${STOCK_DISCIPLINE}`;

  const STOCK_PERSONA_PICK = `你是"选股研究官"，一位以给出明确结论著称的股票研究助理。你的天职就是帮用户选行业、选方向、选具体个股，用户来这里就是要一份能直接参考的候选清单，而不是一堂风险教育课。请用中文，结论先行、观点犀利、清单化输出。${STOCK_DISCIPLINE}`;

  // ---------- 设置（localStorage） ----------
  const DEFAULT_SETTINGS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    modelMode: 'manual', // manual 手动 | auto 自动 | chain 双模型接力
    thinking: false,
    webSearch: true,
    ctx: 12,
    memory: true,
    autoConsolidate: true,
    theme: 'green', // 'green' 翡翠绿 | 'black' 曜石黑
    davUrl: '',
    davUser: '',
    davPass: '',
    davFile: 'stock-backup.json',
  };
  let S = loadSettings();
  function loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('stockai.settings') || '{}') }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings() { localStorage.setItem('stockai.settings', JSON.stringify(S)); }
  // 应用外观主题：给 <html> 打标记，CSS 根据 data-theme 切换整套配色
  function applyTheme() {
    const t = (S.theme === 'black') ? 'black' : 'green';
    document.documentElement.setAttribute('data-theme', t);
    const meta = $('#metaTheme');
    if (meta) meta.setAttribute('content', t === 'black' ? '#0a0b0a' : '#0d9e74');
    $$('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.themeOpt === t));
  }

  // ---------- 运行时状态 ----------
  const state = {
    view: 'chat',
    chatMode: localStorage.getItem('stockai.chatMode') || 'chat', // 'chat' 自由聊股 | 'exam' 选股研究
    exams: [],
    examId: localStorage.getItem('stockai.currentExam') || null,
    messages: [],
    controller: null,
    streaming: false,
    lastContext: null,
    pendingImages: [],   // 待发送的已压缩图片 data URL 数组
  };

  // ---------- 图片处理 ----------
  const MAX_IMG_SIDE = 1280;   // 压缩后最长边，够模型看清且省 token
  const MAX_IMGS = 6;          // 单条消息最多图片数

  // 压缩图片为 base64 data URL（canvas 等比缩小 + JPEG 编码）
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片解码失败'));
        img.onload = () => {
          let { width, height } = img;
          const scale = Math.min(1, MAX_IMG_SIDE / Math.max(width, height));
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';               // JPEG 无透明通道，白底兜底
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderPendingImages() {
    const box = $('#attachPreview');
    box.innerHTML = state.pendingImages.map((src, i) =>
      `<div class="thumb"><img src="${src}" alt="待发送图片 ${i + 1}"><button class="thumb-del" data-idx="${i}" title="移除">×</button></div>`
    ).join('');
    box.hidden = state.pendingImages.length === 0;
  }

  // 当前对话的存储分区：自由聊股用 GLOBAL，选股模式用对应专题 id
  function activeKey() {
    return state.chatMode === 'exam' && state.examId ? state.examId : GLOBAL;
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.hidden = true, ms);
  }

  // ============================================================
  // 记忆系统
  // ============================================================

  // 建立核心档案默认值（带字段补全，兼容旧数据/导入数据缺字段的情况）
  async function ensureProfile() {
    let p = await DB.get('profile', 'main');
    if (!p) {
      p = { id: 'main', summary: '', facts: [], goals: [], updatedAt: now() };
      await DB.put('profile', p);
    }
    // normalize：无论数据来自旧版本还是手动导入，都补齐成完整结构
    p.summary = typeof p.summary === 'string' ? p.summary : '';
    p.facts = Array.isArray(p.facts) ? p.facts : [];
    p.goals = Array.isArray(p.goals) ? p.goals : [];
    p.updatedAt = p.updatedAt || now();
    return p;
  }

  // 分词（简单：连续中文 2~4 字 + 数字 + 英文单词）
  function tokenize(text) {
    const out = [];
    const en = text.match(/[a-zA-Z]{2,}/g) || [];
    const num = text.match(/\d+/g) || [];
    const zh = text.match(/[\u4e00-\u9fa5]+/g) || [];
    out.push(...en.map(x => x.toLowerCase()), ...num);
    zh.forEach(seg => {
      if (seg.length <= 4) out.push(seg);
      else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    });
    return [...new Set(out)];
  }

  // 从全量归档里检索与当前输入相关的历史（跳过已压缩的）
  function retrieve(examId, query, limit = 5) {
    const kws = tokenize(query);
    if (!kws.length) return [];
    return DB.messagesByExam(examId).then(all => {
      const pool = all.filter(m => m.digested !== true && m.role !== 'system' && !query.includes(m.content));
      const scored = pool.slice(-600).map(m => {
        const t = m.content || '';
        let score = 0;
        for (const k of kws) if (t.includes(k)) score += k.length >= 3 ? 2 : 1;
        return { m, score };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map(x => ({
        role: x.m.role === 'user' ? '用户' : '助手',
        content: x.m.content.length > 220 ? x.m.content.slice(0, 220) + '…' : x.m.content,
        ts: x.m.ts,
      }));
    });
  }

  // 构造注入的 system prompt（含全部记忆层）
  async function buildSystem(exam, userInput) {
    const isExam = state.chatMode === 'exam';
    // 人设随模式切换：自由聊股 / 深度选股，两者都是股票研究助理，后者更强调给结论
    const persona = isExam ? STOCK_PERSONA_PICK : STOCK_PERSONA_CHAT;

    let examBlock = '';
    if (isExam) {
      examBlock = exam ? `
【当前研究专题】
- 专题名称：${exam.name}
- 关注要点/标的：
${(exam.subjects || []).map(s => `  · ${s.name}${s.done ? ' [已研究]' : ' [待研究]'}`).join('\n') || '  （尚未添加关注标的）'}
- 今日：${new Date().toLocaleDateString('zh-CN')}
请围绕这个专题给出具体的行业判断和个股候选，不要泛泛而谈。
` : '\n【当前状态】选股研究模式下尚未选定专题。请主动给用户几个具体的选股方向供挑选，或提醒用户到「专题」页新建一个研究专题。\n';
    }

    if (!S.memory) {
      return { text: `${persona}\n${examBlock}`, layers: ['基础人设'] };
    }

    const profile = await ensureProfile();
    const key = activeKey();
    const digests = await DB.digestsByExam(key);
    const recentDigests = digests.slice(-3);
    const related = await retrieve(key, userInput || '', 5);

    const layers = ['基础人设'];
    if (isExam) layers.push('研究专题');
    let text = `${persona}
你拥有跨越数月甚至数年的长期记忆，会主动结合下面提供的历史记忆来理解用户。若记忆与当前问题相关，自然地使用它们，但不要刻意炫耀"我记得"。
${examBlock}`;

    if (profile.summary || profile.facts.length || profile.goals.length) {
      layers.push('核心档案');
      text += `\n【长期记忆 · 核心档案】\n`;
      if (profile.summary) text += `总体情况：${profile.summary}\n`;
      if (profile.goals.length) text += `目标：\n${profile.goals.map(g => '  - ' + g).join('\n')}\n`;
      if (profile.facts.length) text += `已记住的重要事实与约定：\n${profile.facts.slice(-30).map(f => '  - ' + f.text).join('\n')}\n`;
    }
    if (recentDigests.length) {
      layers.push(`滚动摘要×${recentDigests.length}`);
      text += `\n【历史对话摘要】\n${recentDigests.map(d => `（${new Date(d.toTs).toLocaleDateString('zh-CN')} 前后）\n${d.content}`).join('\n\n')}\n`;
    }
    if (related.length) {
      layers.push(`相关历史×${related.length}`);
      text += `\n【相关的过往对话片段】\n${related.map(r => `${r.role}：${r.content}`).join('\n')}\n`;
    }
    return { text, layers };
  }

  // 自动整理记忆：把未压缩的旧消息交给 AI 生成结构化更新
  async function consolidate(force = false) {
    const examId = activeKey();
    const all = await DB.messagesByExam(examId);
    const unprocessed = all.filter(m => m.digested !== true && m.role !== 'system');
    // 保留最近 10 条不压缩，保证对话连贯
    const keepRecent = 10;
    const toCompress = unprocessed.length > keepRecent ? unprocessed.slice(0, unprocessed.length - keepRecent) : [];
    if (!toCompress.length && !force) { toast('暂无需要整理的对话'); return; }
    if (!S.apiKey) { toast('请先到设置里填写 API Key'); return; }
    if (!toCompress.length) { toast('对话还太少，暂时无需整理'); return; }

    toast('正在整理长期记忆…');
    const profile = await ensureProfile();
    const digestList = await DB.digestsByExam(examId);
    const prevDigest = digestList.length ? digestList[digestList.length - 1].content : '（无）';

    const convo = toCompress.map(m => {
      const c = m.content || (m.images && m.images.length ? '（发送了一张图片）' : '');
      return `${m.role === 'user' ? '用户' : '助手'}：${c}`;
    }).join('\n');
    const prompt = `你在维护一个股票研究助理的"长期记忆档案"。请根据【过往摘要】【现有档案】【新对话】，输出更新后的记忆。

【过往摘要】
${prevDigest}

【现有核心档案】
总体情况：${profile.summary || '（无）'}
目标：${profile.goals.join('；') || '（无）'}
事实：${profile.facts.map(f => f.text).join('；') || '（无）'}

【新对话（需要被压缩）】
${convo}

请严格只输出一个 JSON 对象（不要 Markdown，不要多余文字），格式：
{
  "summary": "对用户整体情况的最新概括，150字以内",
  "goals": ["目标1", "目标2"],
  "facts": ["需要长期记住的事实/偏好/约定1", "事实2"],
  "digest": "对【新对话】的摘要，保留关键信息、决定、进度变化，250字以内"
}
要求：facts 与 goals 要合并旧内容并去重，不要丢失重要的旧事实；不要编造对话里没有的信息。`;

    try {
      const res = await fetch(`${S.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${S.apiKey}` },
        body: JSON.stringify({
          model: S.model,
          messages: [{ role: 'user', content: prompt }],
          thinking: { type: 'disabled' },
          stream: false,
          temperature: 0.2,
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
      const data = await res.json();
      let content = data.choices?.[0]?.message?.content || '';
      content = content.replace(/```json/ig, '').replace(/```/g, '').trim();
      let parsed;
      try { parsed = JSON.parse(content); }
      catch {
        // 解析失败：退化为纯文本摘要，至少不丢记忆
        parsed = { summary: profile.summary, goals: profile.goals, facts: profile.facts.map(f => f.text), digest: content.slice(0, 600) };
      }
      await DB.put('profile', {
        id: 'main',
        summary: String(parsed.summary || '').slice(0, 800),
        goals: asArr(parsed.goals).slice(0, 40),
        facts: asArr(parsed.facts).slice(-60).map(t => ({ text: String(t).slice(0, 200), ts: now() })),
        updatedAt: now(),
      });
      await DB.put('digests', {
        id: uid(), examId,
        content: String(parsed.digest || '').slice(0, 1200),
        fromTs: toCompress[0].ts, toTs: toCompress[toCompress.length - 1].ts,
        createdAt: now(),
      });
      for (const m of toCompress) { m.digested = true; await DB.put('messages', m); }
      toast(`记忆已整理：压缩 ${toCompress.length} 条对话`);
      renderMemory();
    } catch (e) {
      console.error(e);
      toast('整理失败：' + e.message, 3000);
    }
  }
  function asArr(x) {
    if (Array.isArray(x)) return x.filter(Boolean);
    if (typeof x === 'string') return x.split(/[；;\n]/).map(s => s.trim()).filter(Boolean);
    return [];
  }

  // ============================================================
  // 对话
  // ============================================================
  function renderMessages() {
    const list = $('#msgList');
    const empty = $('#emptyChat');
    const nonSystem = state.messages.filter(m => m.role !== 'system');
    if (!nonSystem.length) {
      list.querySelectorAll('.msg').forEach(n => n.remove());
      if (!empty.parentNode) list.appendChild(empty);
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    // 只移除气泡，保留 #emptyChat 节点本身（否则 setChatMode 里访问其子元素会报错中断）
    list.querySelectorAll('.msg').forEach(n => n.remove());
    for (const m of nonSystem) appendMsgBubble(m);
    scrollBottom();
  }

  function appendMsgBubble(m, streamEl) {
    const list = $('#msgList');
    if ($('#emptyChat') && !$('#emptyChat').hidden) $('#emptyChat').hidden = true;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (m.role === 'user' ? 'me' : 'ai');
    const avatar = m.role === 'user' ? '我' : '🎓';
    const name = m.role === 'user' ? '' : '<div class="msg-name">股研助手</div>';
    const imgsHtml = (!streamEl && m.images && m.images.length)
      ? `<div class="msg-images">${m.images.map((src, i) => `<img src="${src}" data-preview="${i}" alt="图片 ${i + 1}">`).join('')}</div>` : '';
    const voiceBtn = m.role === 'assistant'
      ? `<button class="voice-btn" data-voice title="朗读这条回复"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg><span class="voice-label">朗读</span></button>`
      : '';
    const delBtn = `<button class="msg-del-btn" data-del="${m.id || ''}" title="删除这条消息" aria-label="删除这条消息"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>`;
    const actionsRow = `<div class="msg-actions">${voiceBtn}${delBtn}</div>`;
    // 历史消息：有思考内容则渲染可折叠块（默认收起）
    const reasoningFold = (!streamEl && m.reasoning) ? reasoningFoldHTML(m.reasoning) : '';
    wrap.innerHTML = `
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-body">
        ${name}
        ${reasoningFold}
        <div class="bubble md">${imgsHtml}${streamEl ? '' : md(m.content) + renderCitations(m.citations)}</div>
        ${actionsRow}
        ${m.layers && m.layers.length ? `<div class="mem-used"><span class="dot"></span>已调用记忆：${m.layers.join(' · ')}</div>` : ''}
      </div>`;
    list.appendChild(wrap);
    scrollBottom();
    return wrap.querySelector('.bubble');
  }

  function scrollBottom() {
    const l = $('#msgList');
    requestAnimationFrame(() => { l.scrollTop = l.scrollHeight; });
  }

  // 删除单条消息：本地存储 + 内存 + 界面同步移除
  async function deleteMessage(id) {
    if (!id) return;
    if (state.streaming) { toast('生成中不能删除，请稍候'); return; }
    if (!confirm('删除这条消息？（长期记忆档案不受影响）')) return;
    // 若正在朗读则先停止
    if (speech.supported && speech.activeBtn) stopSpeech();
    state.messages = state.messages.filter(m => m.id !== id);
    try { await DB.del('messages', id); } catch (e) {}
    renderMessages();
    updateTokenHint();
    toast('已删除');
  }

  // ---- 语音朗读（浏览器内置语音合成，无需联网、不额外收费）----
  const speech = {
    supported: 'speechSynthesis' in window,
    activeBtn: null,
    voices: [],
  };
  if (speech.supported) {
    const loadVoices = () => { speech.voices = window.speechSynthesis.getVoices() || []; };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
  function pickChineseVoice() {
    const vs = speech.voices;
    return vs.find(v => /^zh[-_]CN/i.test(v.lang))
        || vs.find(v => /^zh/i.test(v.lang))
        || vs.find(v => /Chinese/i.test(v.name))
        || null;
  }
  // 从一条消息气泡提取纯文本用于朗读（去掉图片/引用来源/搜索提示等噪音）
  function speechTextFromBubble(btn) {
    const msg = btn.closest('.msg');
    if (!msg) return '';
    const bubble = msg.querySelector('.bubble');
    if (!bubble) return '';
    const clone = bubble.cloneNode(true);
    clone.querySelectorAll('.msg-images, .cite-label, .cite-item, .searching-hint, .md-table').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s{3,}/g, '\n').trim();
  }
  function resetSpeechBtn() {
    if (speech.activeBtn) {
      speech.activeBtn.classList.remove('speaking');
      const label = speech.activeBtn.querySelector('.voice-label');
      if (label) label.textContent = '朗读';
      speech.activeBtn = null;
    }
  }
  function stopSpeech() {
    if (speech.supported) window.speechSynthesis.cancel();
    resetSpeechBtn();
  }
  function toggleSpeech(btn) {
    if (!speech.supported) { toast('当前浏览器不支持语音朗读'); return; }
    // 再点正在朗读的按钮 → 停止
    if (speech.activeBtn === btn) { stopSpeech(); return; }
    stopSpeech();
    const text = speechTextFromBubble(btn);
    if (!text) { toast('这条消息还没有可朗读的内容'); return; }
    let u;
    try { u = new SpeechSynthesisUtterance(text); }
    catch (e) { toast('该浏览器无法创建语音，换用系统浏览器试试'); return; }
    u.lang = 'zh-CN';
    u.rate = 1; u.pitch = 1; u.volume = 1;
    const v = pickChineseVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.onend = () => resetSpeechBtn();
    u.onerror = () => resetSpeechBtn();
    btn.classList.add('speaking');
    const label = btn.querySelector('.voice-label');
    if (label) label.textContent = '停止';
    speech.activeBtn = btn;
    // 部分移动浏览器需先 resume 再 speak
    try { window.speechSynthesis.resume(); } catch (e) {}
    window.speechSynthesis.speak(u);
  }

  // 极简 Markdown 渲染
  function md(text) {
    if (!text) return '';
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const stash = [];
    const keep = html => { stash.push(html); return '\uE000' + (stash.length - 1) + '\uE001'; };
    // 行内格式：行内代码 / 链接 / 加粗 / 删除线。代码块用哨兵占位，避免被后续规则误伤
    const inline = s => {
      let t = esc(s);
      t = t.replace(/`([^`]+)`/g, (_, c) => keep('<code>' + c + '</code>'));
      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => keep('<a class="md-link" href="' + url + '" target="_blank" rel="noopener">' + label + '</a>'));
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      return t;
    };
    // 先抽出围栏代码块，整体占位（前后补换行，保证独占一行）
    let src = String(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) =>
      '\n' + keep('<pre class="md-pre"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>') + '\n');

    const lines = src.split('\n');
    const out = [];
    let para = [];
    const flushPara = () => {
      if (!para.length) return;
      out.push('<p class="md-p">' + para.map(inline).join('<br>') + '</p>');
      para = [];
    };
    const cell = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
    const isRow = l => /^\s*\|.*\|\s*$/.test(l);
    const isSep = l => /^\s*\|[\s:|\-]+\|\s*$/.test(l);

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      // 代码块占位行
      if (/^\uE000\d+\uE001$/.test(trimmed)) { flushPara(); out.push(trimmed); i++; continue; }
      // 表格
      if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        flushPara();
        const head = cell(line); i += 2;
        const rows = [];
        while (i < lines.length && isRow(lines[i])) { rows.push(cell(lines[i])); i++; }
        let t = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
        head.forEach(c => { t += '<th>' + inline(c) + '</th>'; });
        t += '</tr></thead><tbody>';
        rows.forEach(r => { t += '<tr>'; for (let k = 0; k < head.length; k++) t += '<td>' + inline(r[k] != null ? r[k] : '') + '</td>'; t += '</tr>'; });
        t += '</tbody></table></div>';
        out.push(t);
        continue;
      }
      // 空行 → 段落分隔
      if (!trimmed) { flushPara(); i++; continue; }
      // 分隔线
      if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) { flushPara(); out.push('<hr class="md-hr">'); i++; continue; }
      // 标题 #/##/###
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.+)$/))) { flushPara(); out.push('<div class="md-h md-h' + m[1].length + '">' + inline(m[2]) + '</div>'); i++; continue; }
      // 引用（连续 > 行）
      if (/^\s*>/.test(line)) {
        flushPara();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(inline(lines[i].replace(/^\s*>\s?/, ''))); i++; }
        out.push('<blockquote class="md-quote">' + buf.join('<br>') + '</blockquote>');
        continue;
      }
      // 无序列表
      if (/^\s*[-*]\s+/.test(line)) {
        flushPara();
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++; }
        out.push('<ul class="md-ul">' + items.join('') + '</ul>');
        continue;
      }
      // 有序列表
      if (/^\s*\d+[.)]\s+/.test(line)) {
        flushPara();
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push('<li>' + inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i++; }
        out.push('<ol class="md-ol">' + items.join('') + '</ol>');
        continue;
      }
      // 普通文本行
      para.push(line); i++;
    }
    flushPara();
    return out.join('').replace(/\uE000(\d+)\uE001/g, (_, n) => stash[+n] || '');
  }

  // 把 Markdown 表格解析成 HTML 表格（在换行转 <br> 之前调用）
  function renderTables(h) {
    const lines = h.split('\n');
    const out = [];
    let i = 0;
    const rowRe = /^\s*\|.*\|\s*$/;
    const sepRe = /^\s*\|[\s:|\-]+\|\s*$/;
    const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
    while (i < lines.length) {
      if (rowRe.test(lines[i]) && i + 1 < lines.length && sepRe.test(lines[i + 1])) {
        const head = cells(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && rowRe.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        let t = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
        head.forEach(c => { t += `<th>${c}</th>`; });
        t += '</tr></thead><tbody>';
        rows.forEach(r => {
          t += '<tr>';
          for (let k = 0; k < head.length; k++) t += `<td>${r[k] != null ? r[k] : ''}</td>`;
          t += '</tr>';
        });
        t += '</tbody></table></div>';
        out.push(t);
      } else {
        out.push(lines[i]); i++;
      }
    }
    return out.join('\n');
  }

  // 渲染联网搜索的引用来源
  function renderCitations(cits) {
    if (!cits || !cits.length) return '';
    const items = cits.slice(0, 6).map((c, i) => {
      let host = '';
      try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch { host = '来源'; }
      return `<a href="${c.url}" target="_blank" rel="noopener" class="cite-item"><span class="cite-n">${i + 1}</span><span class="cite-host">${escHtml(host)}</span></a>`;
    }).join('');
    return `<div class="citations"><div class="cite-label">🌐 引用来源</div><div class="cite-list">${items}</div></div>`;
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 思考过程折叠块（默认收起，点标题展开/收起）
  function reasoningFoldHTML(text) {
    if (!text || !text.trim()) return '';
    return `<div class="reasoning-fold">
      <button class="reasoning-fold-head" data-reasoning-fold>
        <span class="rf-ico">💭</span><span class="rf-label">查看思考过程</span>
        <svg class="rf-arrow" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      </button>
      <div class="reasoning-fold-body" hidden>${escHtml(text)}</div>
    </div>`;
  }

  // 当前模型是否支持看图：flash 系列原生多模态；v4-pro 为纯文本
  function modelSupportsVision(model) {
    const m = String(model || S.model || '').toLowerCase();
    return m.includes('flash') || m.includes('vision');
  }

  // 当前模型是否支持服务端工具（联网搜索 deepseek_web_search / 读网页 deepseek_read_url）
  // 只有 flash 系列支持；v4-pro 纯文本模型带上 tools 会报 HTTP 400
  function modelSupportsTools(model) {
    const m = String(model || S.model || '').toLowerCase();
    return m.includes('flash');
  }

  // 把 content（字符串或含图片的内容块）降级成纯文字，供不支持看图的模型使用
  function toPlainText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => p && p.type === 'text' ? (p.text || '') : (p && p.type === 'image_url' ? '（用户发送了一张图片）' : '')).join('\n');
    return String(c || '');
  }

  // 依据「模型策略」生成本次请求的执行计划
  // manual 手动固定模型；auto 自动（联网/看图→flash，纯文字→v4-pro）；chain 接力（flash 联网搜资料→v4-pro 深度分析）
  function buildPlan(hasImages) {
    const mode = S.modelMode || 'manual';
    const wantSearch = !!S.webSearch;
    if (mode === 'chain') {
      return { mode: 'chain', model: 'deepseek-v4-pro', useTools: false, canImage: true, needResearch: true };
    }
    if (mode === 'auto') {
      const useFlash = wantSearch || !!hasImages;
      const model = useFlash ? 'deepseek-flash' : 'deepseek-v4-pro';
      return { mode: 'auto', model, useTools: useFlash && wantSearch && modelSupportsTools(model), canImage: modelSupportsVision(model), needResearch: false };
    }
    const model = S.model || 'deepseek-flash';
    return { mode: 'manual', model, useTools: wantSearch && modelSupportsTools(model), canImage: modelSupportsVision(model), needResearch: false };
  }

  // 把历史消息转成 API 的 content：纯文字用字符串，带图片用内容块数组。
  // 若当前模型不支持图片，则把图片降级成文字占位，避免历史图片触发 400 错误。
  function toContent(m, includeImages) {
    const hasImg = m.images && m.images.length;
    if (hasImg && includeImages !== false) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const src of m.images) parts.push({ type: 'image_url', image_url: { url: src, detail: 'low' } });
      return parts;
    }
    if (hasImg) {
      const note = '（用户发送了一张图片）';
      return m.content ? (m.content + '\n' + note) : note;
    }
    return m.content || '';
  }

  // 规范化发给 API 的消息序列：删过单条消息 / 中止生成后，历史可能残留
  // 连续 assistant 或以 assistant 开头，DeepSeek 会报
  // "an assistant message must follow a user message"（HTTP 400）
  function sanitizeChatMessages(list) {
    const out = [];
    for (const m of list) {
      const c = m && m.content;
      const empty = (c == null || c === '') || (typeof c === 'string' && !c.trim()) || (Array.isArray(c) && !c.length);
      if (empty) continue;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      // 没有配对的提问 → 孤立回复，丢弃
      if (role === 'assistant' && (!out.length || out[out.length - 1].role !== 'user')) continue;
      // 连续提问合并为一条，保持 user/assistant 严格交替
      if (role === 'user' && out.length && out[out.length - 1].role === 'user') {
        const prev = out[out.length - 1];
        if (typeof prev.content === 'string' && typeof c === 'string') {
          prev.content = prev.content + '\n' + c;
        } else {
          const arr = x => Array.isArray(x) ? x.slice() : [{ type: 'text', text: String(x || '') }];
          prev.content = arr(prev.content).concat(arr(c));
        }
        continue;
      }
      out.push({ role, content: c });
    }
    // 末尾必须是 user（当前输入）
    while (out.length && out[out.length - 1].role === 'assistant') out.pop();
    return out;
  }

  async function send(text) {
    text = (text || '').trim();
    // 取走待发送图片（即使没有文字，只要发了图片就允许发送）
    const images = state.pendingImages.slice();
    state.pendingImages = [];
    renderPendingImages();
    if ((!text && !images.length) || state.streaming) return;
    if (!S.apiKey) { toast('请先到「设置」里填写 DeepSeek API Key'); go('settings'); return; }

    const exam = state.chatMode === 'exam' ? (state.exams.find(e => e.id === state.examId) || null) : null;
    const sys = await buildSystem(exam, text || '（用户发送了一张图片）');
    state.lastContext = sys;

    const userMsg = { id: uid(), examId: activeKey(), role: 'user', content: text, ts: now() };
    if (images.length) userMsg.images = images;
    state.messages.push(userMsg);
    await DB.put('messages', userMsg);
    appendMsgBubble(userMsg);

    // 组装发给 API 的消息（系统提示 + 最近 N 条 + 当前输入）
    const plan = buildPlan(images.length > 0);
    const canImage = plan.canImage;
    if (images.length && !canImage) {
      toast('当前模型不支持看图，图片已按文字说明发送。要看图请选 deepseek-flash 或用「自动」策略', 4000);
    }
    if (plan.mode === 'manual' && S.webSearch && !plan.useTools) {
      toast('v4-pro 不支持联网搜索，本次已跳过联网。要联网请选 flash 或用「自动/接力」策略', 4000);
    }
    const ctxCount = S.ctx;
    const history = state.messages.filter(m => m.role !== 'system' && m.id !== userMsg.id).slice(-ctxCount);
    const payloadMsgs = [{ role: 'system', content: sys.text }];
    for (const m of history) payloadMsgs.push({ role: m.role, content: toContent(m, canImage) });
    payloadMsgs.push({ role: 'user', content: toContent(userMsg, canImage) });
    // 删过消息后历史 role 可能乱序，规范化后再发送，避免 HTTP 400
    const bodyMsgs = sanitizeChatMessages(payloadMsgs.slice(1));
    payloadMsgs.splice(1, payloadMsgs.length - 1, ...bodyMsgs);

    const aiMsg = { id: uid(), examId: activeKey(), role: 'assistant', content: '', layers: sys.layers, ts: now() };
    const bubble = appendMsgBubble(aiMsg, true);
    await runGeneration(payloadMsgs, sys, aiMsg, bubble, { isRetry: false, plan });
  }

  // 真正执行流式请求；发送与"重新生成"共用。sys 为空时重试会重建上下文。
  async function runGeneration(payloadMsgs, sys, aiMsg, bubble, opt) {
    opt = opt || {};
    const plan = opt.plan || buildPlan(false);
    setStreaming(true);
    $('#typing').hidden = false;
    let full = '';
    let buffer = '';
    let citations = [];
    let searchingShown = false;
    let reasoningShown = false;
    const gen = createGenIndicator(bubble);
    if (!opt.isRetry) gen.setStage('正在连接…');

    try {
      state.controller = new AbortController();
      const signal = state.controller.signal;
      const api = S.baseUrl.replace(/\/$/, '') + '/chat/completions';
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${S.apiKey}` };
      let useMsgs = payloadMsgs;

      // 接力模式：① 用 flash 联网搜集资料 ② 把资料并入系统提示，交给 v4-pro 深度分析
      if (opt.cachedMsgs) {
        useMsgs = opt.cachedMsgs; // 重试时复用，避免重复联网花钱
      } else if (plan.needResearch) {
        gen.setStage('① 正在联网搜集资料…');
        bubble.innerHTML = '<div class="searching-hint"><span class="spin"></span>① 正在联网搜集资料，再交给深度模型分析…</div>';
        let research = '';
        try {
          const rMsgs = payloadMsgs.map(m => ({ ...m }));
          const li = rMsgs.length - 1;
          const ask = '\n\n【请联网检索这个问题的最新信息、数据与要点，整理成一份带来源链接的结构化资料摘要；只给资料，不要下最终结论】';
          const cur = rMsgs[li].content;
          // 当前消息若带图片（内容块数组），保留图片给 flash 看，只把指令追加为文字块
          rMsgs[li] = { role: 'user', content: Array.isArray(cur) ? cur.concat([{ type: 'text', text: ask }]) : (toPlainText(cur) + ask) };
          const rr = await fetch(api, {
            method: 'POST', headers, signal,
            body: JSON.stringify({
              model: 'deepseek-flash', messages: rMsgs, stream: false,
              thinking: { type: 'disabled' }, tools: [{ type: 'deepseek_web_search' }],
            }),
          });
          if (rr.ok) { const j = await rr.json(); research = (j.choices?.[0]?.message?.content || '').trim(); }
        } catch (e) { /* 检索失败则降级 */ }
        if (!research) toast('联网资料未取到，已改用模型自身知识分析', 3000);
        // 最终模型为 v4-pro（不支持看图），统一降级为纯文字
        useMsgs = payloadMsgs.map(m => ({ ...m, content: toPlainText(m.content) }));
        if (research) {
          useMsgs[0] = { role: 'system', content: String(useMsgs[0].content || '') + '\n\n【以下是联网检索到的资料，请结合它分析作答，注意甄别、关键信息标注来源】\n' + research };
        }
        opt.cachedMsgs = useMsgs;
        gen.setStage('② 正在深度分析…');
      }

      const res = await fetch(api, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: plan.model,
          messages: useMsgs,
          stream: true,
          thinking: { type: S.thinking ? 'enabled' : 'disabled' },
          ...(S.thinking ? { reasoning_effort: 'medium' } : {}),
          ...(plan.useTools ? { tools: [{ type: 'deepseek_web_search' }] } : {}),
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}：${errText.slice(0, 160)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      $('#typing').hidden = true;
      gen.setStage(S.thinking ? '正在深度思考…' : '正在生成回答…');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const obj = JSON.parse(data);
            const choice = obj.choices?.[0];
            // 联网搜索事件提示
            const evt = choice?.server_tool_event;
            if (evt && evt.type === 'call_started' && !searchingShown) {
              searchingShown = true;
              gen.setStage('正在联网搜索…');
              bubble.innerHTML = '<div class="searching-hint"><span class="spin"></span>正在联网搜索最新信息…</div>' + md(full);
              scrollBottom();
            }
            // 引用来源（最后一个 chunk 汇总给出）
            const anns = choice?.delta?.annotations;
            if (Array.isArray(anns)) {
              for (const a of anns) {
                const c = a.url_citation;
                if (c && c.url && !citations.some(x => x.url === c.url)) citations.push({ url: c.url, title: c.title || c.url });
              }
            }
            // 深度思考过程（reasoning_content）
            const reasoning = choice?.delta?.reasoning_content || '';
            if (reasoning) {
              reasoningShown = true;
              gen.setStage('正在深度思考…');
              gen.addReasoning(reasoning);
            }
            const delta = choice?.delta?.content || '';
            if (delta) {
              full += delta;
              gen.setStage('正在生成回答…');
              let html = md(full);
              if (searchingShown && !full) html = '<div class="searching-hint"><span class="spin"></span>正在联网搜索最新信息…</div>' + html;
              bubble.innerHTML = html;
              scrollBottom();
            }
          } catch { /* 忽略心跳/不完整帧 */ }
        }
      }
      gen.done();
      aiMsg.content = full || '（没有收到内容，请重试）';
      if (citations.length) aiMsg.citations = citations;
      if (gen.getReasoning().trim()) aiMsg.reasoning = gen.getReasoning();
      bubble.innerHTML = md(aiMsg.content) + renderCitations(citations);
      // 成功后移除可能残留的重试按钮
      if (bubble.parentElement) {
        const oldBox = bubble.parentElement.querySelector('.retry-box');
        if (oldBox) oldBox.remove();
      }
      // 成功时确保不重复入栈（重试场景 aiMsg 尚未入栈）
      if (!state.messages.some(m => m.id === aiMsg.id)) state.messages.push(aiMsg);
      await DB.put('messages', aiMsg);

      // 自动整理记忆（异步，不阻塞）
      if (S.autoConsolidate) {
        const cnt = await DB.messagesByExam(aiMsg.examId);
        const un = cnt.filter(m => m.digested !== true && m.role !== 'system').length;
        if (un >= 30) setTimeout(() => consolidate(false), 400);
      }
      updateTokenHint();
    } catch (e) {
      $('#typing').hidden = true;
      if (e.name === 'AbortError') {
        gen.stop();
        bubble.innerHTML = md(full || '（已停止）') + (full ? '\n\n_（已停止生成）_' : '');
        aiMsg.content = full || '（已停止）';
        if (gen.getReasoning().trim()) aiMsg.reasoning = gen.getReasoning();
        if (!state.messages.some(m => m.id === aiMsg.id)) state.messages.push(aiMsg);
        await DB.put('messages', aiMsg);
      } else {
        gen.fail();
        bubble.innerHTML = md(full) + `\n\n⚠️ 出错了：${e.message}`;
        // 出错：追加"重新生成"按钮，点击后复用同一上下文重发
        const body = bubble.parentElement;
        if (body) {
          const old = body.querySelector('.retry-box');
          if (old) old.remove();
          const box = document.createElement('div');
          box.className = 'retry-box';
          box.innerHTML = '<button class="retry-btn" data-retry>🔄 重新生成</button>';
          body.appendChild(box);
          box.querySelector('[data-retry]').addEventListener('click', async (ev) => {
            const rb = ev.currentTarget;
            rb.disabled = true; rb.textContent = '🔄 正在重试…';
            bubble.innerHTML = '';
            await runGeneration(payloadMsgs, sys, aiMsg, bubble, { isRetry: true, plan, cachedMsgs: opt.cachedMsgs });
          });
        }
        toast('请求失败：' + e.message, 3500);
      }
    } finally {
      setStreaming(false);
    }
  }

  function setStreaming(on) {
    state.streaming = on;
    $('#sendBtn').disabled = on;
    $('#stopRow').hidden = !on;
  }

  // ---- 生成状态指示器：阶段文字 + 实时计时 + 深度思考过程 ----
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60), r = s % 60;
    return m + ' 分 ' + (r < 10 ? '0' : '') + r + ' 秒';
  }
  // 在气泡所在消息体内创建/取得状态条与思考过程区，并返回控制器
  function createGenIndicator(bubble) {
    const body = bubble ? bubble.parentElement : null;
    if (!body) return { setStage(){}, addReasoning(){}, done(){}, fail(){}, stop(){}, remove(){} };
    // 先清理旧的（重试场景），避免状态条堆叠
    body.querySelectorAll(':scope > .gen-status, :scope > .gen-reasoning').forEach(n => n.remove());
    // 状态条插到气泡之前
    const status = document.createElement('div');
    status.className = 'gen-status';
    status.innerHTML = '<span class="gen-dots"><i></i><i></i><i></i></span><span class="gen-stage">正在连接…</span><span class="gen-time">0 秒</span>';
    body.insertBefore(status, bubble);
    const stageEl = status.querySelector('.gen-stage');
    const timeEl = status.querySelector('.gen-time');
    const t0 = Date.now();
    let timer = setInterval(() => { timeEl.textContent = fmtElapsed(Date.now() - t0); }, 250);
    let reasonEl = null;
    let reasonText = '';
    const ctrl = {
      setStage(txt) { if (stageEl) stageEl.textContent = txt; },
      addReasoning(txt) {
        reasonText += txt;
        if (!reasonEl) {
          reasonEl = document.createElement('div');
          reasonEl.className = 'gen-reasoning';
          body.insertBefore(reasonEl, bubble);
        }
        reasonEl.textContent = reasonText;
        reasonEl.scrollTop = reasonEl.scrollHeight;
      },
      getReasoning() { return reasonText; },
      // 生成结束后：把实时思考区替换成可折叠块（默认收起），供事后随时查看
      foldReasoning() {
        if (!reasonText.trim()) return;
        if (reasonEl && reasonEl.parentNode) reasonEl.remove();
        const tmp = document.createElement('div');
        tmp.innerHTML = reasoningFoldHTML(reasonText);
        const fold = tmp.firstElementChild;
        if (fold) body.insertBefore(fold, bubble);
      },
      done() {
        clearInterval(timer);
        status.classList.add('done');
        status.querySelector('.gen-dots').remove();
        stageEl.textContent = '回答完成';
        timeEl.textContent = '用时 ' + fmtElapsed(Date.now() - t0);
        ctrl.foldReasoning();
      },
      fail() {
        clearInterval(timer);
        status.classList.add('error');
        const d = status.querySelector('.gen-dots'); if (d) d.remove();
        stageEl.textContent = '生成失败';
        timeEl.textContent = '用时 ' + fmtElapsed(Date.now() - t0);
      },
      stop() {
        clearInterval(timer);
        const d = status.querySelector('.gen-dots'); if (d) d.remove();
        stageEl.textContent = '已停止';
        timeEl.textContent = '用时 ' + fmtElapsed(Date.now() - t0);
        ctrl.foldReasoning();
      },
      remove() { clearInterval(timer); if (status.parentNode) status.remove(); if (reasonEl && reasonEl.parentNode) reasonEl.remove(); },
    };
    return ctrl;
  }

  function updateTokenHint() {
    const chars = state.messages.reduce((n, m) => n + (m.content?.length || 0), 0);
    $('#tokenHint').textContent = `本地归档 ${state.messages.length} 条 · 约 ${Math.round(chars / 1.6)} tokens 历史`;
  }

  // ============================================================
  // 研究专题管理
  // ============================================================
  async function loadExams() {
    state.exams = await DB.all('exams');
    if (state.examId && !state.exams.find(e => e.id === state.examId)) state.examId = null;
    renderExams();
    renderBanner();
    updateCtxLabel();
  }

  function daysLeft(date) {
    if (!date) return null;
    const d = new Date(date + 'T00:00:00');
    return Math.ceil((d - new Date()) / 86400000);
  }

  function renderExams() {
    const box = $('#examList');
    if (!state.exams.length) {
      box.innerHTML = '<div class="empty-exam">还没有研究专题。<br>点右上角「+ 新建专题」，比如「AI算力」「高股息」，我就能帮你深挖了。</div>';
      return;
    }
    box.innerHTML = '';
    for (const e of state.exams) {
      const dl = daysLeft(e.date);
      const subs = e.subjects || [];
      const done = subs.filter(s => s.done).length;
      const pct = subs.length ? Math.round(done / subs.length * 100) : 0;
      const card = document.createElement('div');
      card.className = 'exam-card' + (state.examId === e.id ? ' selected' : '');
      card.innerHTML = `
        ${state.examId === e.id ? '<span class="selected-flag">当前</span>' : ''}
        <div class="exam-card-top">
          <div><div class="exam-card-name">${escHtml(e.name)}</div>
          <div class="exam-card-date">研究专题</div></div>
          
        </div>
        <div class="exam-card-subs">
          ${subs.map((s, i) => `<span class="sub-tag" data-exam="${e.id}" data-idx="${i}" style="${s.done ? 'opacity:.5;text-decoration:line-through' : ''}">${s.done ? '✓ ' : ''}${escHtml(s.name)}</span>`).join('') || '<span class="sub-tag">未添加关注标的</span>'}
        </div>
        ${subs.length ? `<div class="exam-card-bar"><div class="exam-card-fill" style="width:${pct}%"></div></div>` : ''}`;
      card.addEventListener('click', (ev) => {
        const tag = ev.target.closest('.sub-tag');
        if (tag && tag.dataset.idx !== undefined) {
          const idx = +tag.dataset.idx;
          e.subjects[idx].done = !e.subjects[idx].done;
          DB.put('exams', e).then(() => { renderExams(); renderBanner(); });
          return;
        }
        selectExam(e.id);
      });
      box.appendChild(card);
    }
  }

  function renderBanner() {
    const b = $('#examBanner');
    // 横幅只在选股模式且有选中专题时显示
    if (state.chatMode !== 'exam') { b.hidden = true; return; }
    const e = state.exams.find(x => x.id === state.examId);
    if (!e) { b.hidden = true; return; }
    b.hidden = false;
    $('#bannerName').textContent = e.name;
    $('#bannerDays').textContent = '研究专题';
    const subs = e.subjects || [];
    const pct = subs.length ? Math.round(subs.filter(s => s.done).length / subs.length * 100) : 0;
    $('#bannerFill').style.width = pct + '%';
  }

  async function selectExam(id) {
    state.examId = id;
    localStorage.setItem('stockai.currentExam', id || '');
    // 点选专题自动切到选股模式
    if (state.chatMode !== 'exam') await setChatMode('exam', false);
    await loadMessages();
    renderExams();
    renderBanner();
    updateCtxLabel();
    go('chat');
    toast(id ? '已进入选股研究模式' : '已选中专题');
  }

  async function loadMessages() {
    state.messages = await DB.messagesByExam(activeKey());
    renderMessages();
    updateTokenHint();
  }

  function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // 专题编辑弹窗
  let editingExamId = null;
  function openExamModal(exam) {
    editingExamId = exam ? exam.id : null;
    $('#examModalTitle').textContent = exam ? '编辑专题' : '新建专题';
    $('#exName').value = exam?.name || '';
    $('#exSubjects').value = (exam?.subjects || []).map(s => s.name).join('\n');
    $('#btnDeleteExam').hidden = !exam;
    $('#examModal').hidden = false;
  }

  // ============================================================
  // 记忆页
  // ============================================================
  async function renderMemory() {
    const p = await ensureProfile();
    const digests = await DB.digestsByExam(activeKey());
    const total = await DB.countMessages();
    const compressed = (await DB.all('messages')).filter(m => m.digested).length;
    $('#memStats').innerHTML = `
      <div class="stat-box"><div class="stat-num">${total}</div><div class="stat-label">总对话条数</div></div>
      <div class="stat-box"><div class="stat-num">${digests.length}</div><div class="stat-label">记忆摘要</div></div>
      <div class="stat-box"><div class="stat-num">${p.facts.length}</div><div class="stat-label">记住的事实</div></div>`;

    $('#profileView').innerHTML = `
      ${p.summary ? `<div class="profile-section"><b>总体情况</b>${escHtml(p.summary)}</div>` : '<div class="profile-section">（暂无，聊天几次后 AI 会自动归纳）</div>'}
      ${p.goals.length ? `<div class="profile-section"><b>目标</b>${p.goals.map(g => `<div class="fact-item">• ${escHtml(g)}</div>`).join('')}</div>` : ''}
      ${p.facts.length ? `<div class="profile-section"><b>已记住的事实</b>${p.facts.map(f => `<div class="fact-item">• ${escHtml(f.text)} <span style="opacity:.5">${new Date(f.ts).toLocaleDateString('zh-CN')}</span></div>`).join('')}</div>` : ''}
      <div class="hint">上次更新：${new Date(p.updatedAt).toLocaleString('zh-CN')}</div>`;

    $('#digestView').innerHTML = digests.length
      ? digests.slice().reverse().map(d => `<div class="digest-item"><div class="digest-meta">${new Date(d.fromTs).toLocaleDateString('zh-CN')} → ${new Date(d.toTs).toLocaleDateString('zh-CN')}</div>${escHtml(d.content)}</div>`).join('')
      : '<div>（暂无滚动摘要，对话满 30 条会自动压缩，也可点上方「立即整理」）</div>';
  }

  // 设置对话模式（自由聊股 / 选股研究）
  async function setChatMode(mode, doReload = true) {
    state.chatMode = mode;
    localStorage.setItem('stockai.chatMode', mode);
    // 更新切换按钮高亮
    $$('#modeSwitch .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    // 更新空状态文案与快捷问题
    const isExam = mode === 'exam';
    $('#emptyIcon').textContent = isExam ? '🎯' : '💬';
    $('#emptyTitle').textContent = isExam ? '选股研究模式' : '你的股票研究搭档';
    $('#emptyDesc').textContent = isExam
      ? '选一个专题（或新建），我会直接给你行业判断和个股候选清单。需要最新行情我会自己联网查。随时切回「自由聊股」无缝衔接。'
      : '聊行情、解板块、分析个股，我会给你具体方向不空谈。想让我直接选股，点上方「选股研究」切换。';
    const quick = isExam
      ? [
          ['🎯 直接给我选股', '别废话，直接给我 3 只中线看好的 A 股，带代码、逻辑和首选排序'],
          ['🔥 选个当前主线', '现在最值得关注的两个行业方向是什么？各给几只代表个股和理由'],
          ['📊 短中长搭配', '分别按短线、中线、长线，各给我 2 个方向和具体标的'],
        ]
      : [
          ['🔥 现在关注哪些方向', '现在有哪些值得关注的方向？给我具体行业和个股'],
          ['🎯 帮我选几只股', '帮我选3只中线看好的股票，给出代码和理由'],
          ['📊 分析市场主线', '分析一下当前市场主线和资金动向'],
        ];
    $('#quickStarts').innerHTML = quick.map(q => `<button class="quick-btn" data-q="${q[1]}">${q[0]}</button>`).join('');
    $$('#quickStarts .quick-btn').forEach(b => b.addEventListener('click', () => send(b.dataset.q)));
    $('#input').placeholder = isExam ? '输入消息，例如：给我选几只半导体股…' : '输入消息，聊股票、选方向…';
    updateCtxLabel();
    renderBanner();
    if (doReload) await loadMessages();
  }

  function updateCtxLabel() {
    if (state.chatMode === 'exam') {
      const e = state.exams.find(x => x.id === state.examId);
      $('#ctxLabel').textContent = e ? e.name : '选股研究 · 未选专题';
    } else {
      $('#ctxLabel').textContent = '自由聊股';
    }
  }

  // ============================================================
  // 视图 / 设置
  // ============================================================
  function go(view) {
    if (view !== 'chat' && speech.supported) stopSpeech();
    state.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    if (view === 'memory') renderMemory();
  }

  // 模型策略联动：更新说明文字、显隐手动模型下拉
  function applyModelMode() {
    const mode = S.modelMode || 'manual';
    const sel = $('#setModelMode'); if (sel) sel.value = mode;
    const hint = $('#modelModeHint');
    const field = $('#modelField');
    if (field) field.hidden = (mode !== 'manual');
    if (hint) hint.textContent = mode === 'manual'
      ? '固定使用下面手动选择的模型。'
      : mode === 'auto'
        ? '自动：要联网或发图片时用 flash；纯文字聊天时用 v4-pro 深度推理。不加钱。'
        : '接力：每条消息先用 flash 联网搜资料，再交 v4-pro 深度分析。会调用两次 API，费用约翻倍。';
  }

  function fillSettings() {
    $('#setApiKey').value = S.apiKey;
    $('#setBaseUrl').value = S.baseUrl;
    $('#setModel').value = S.model;
    applyModelMode();
    $('#setWebSearch').checked = S.webSearch;
    $('#setThinking').checked = S.thinking;
    $('#setCtx').value = S.ctx;
    $('#ctxVal').textContent = S.ctx;
    $('#setMemory').checked = S.memory;
    $('#setAutoConsolidate').checked = S.autoConsolidate;
    $('#setDavUrl').value = S.davUrl || '';
    $('#setDavUser').value = S.davUser || '';
    $('#setDavPass').value = S.davPass || '';
    $('#setDavFile').value = S.davFile || 'stock-backup.json';
    applyTheme();
    updateMemChip();
  }
  function bindSettings() {
    $('#setApiKey').addEventListener('change', e => { S.apiKey = e.target.value.trim(); saveSettings(); });
    $('#setBaseUrl').addEventListener('change', e => { S.baseUrl = e.target.value.trim() || DEFAULT_SETTINGS.baseUrl; saveSettings(); });
    $('#setModel').addEventListener('change', e => { S.model = e.target.value; saveSettings(); });
    $('#setModelMode').addEventListener('change', e => { S.modelMode = e.target.value; saveSettings(); applyModelMode(); });
    $('#setWebSearch').addEventListener('change', e => { S.webSearch = e.target.checked; saveSettings(); });
    $('#setThinking').addEventListener('change', e => { S.thinking = e.target.checked; saveSettings(); });
    $('#setCtx').addEventListener('input', e => { S.ctx = +e.target.value; $('#ctxVal').textContent = S.ctx; saveSettings(); });
    $('#setMemory').addEventListener('change', e => { S.memory = e.target.checked; saveSettings(); updateMemChip(); });
    $('#setAutoConsolidate').addEventListener('change', e => { S.autoConsolidate = e.target.checked; saveSettings(); });
    $$('.theme-opt').forEach(b => b.addEventListener('click', () => {
      S.theme = b.dataset.themeOpt;
      saveSettings();
      applyTheme();
    }));
    $('#setDavUrl').addEventListener('change', e => { S.davUrl = e.target.value.trim(); saveSettings(); });
    $('#setDavUser').addEventListener('change', e => { S.davUser = e.target.value.trim(); saveSettings(); });
    $('#setDavPass').addEventListener('change', e => { S.davPass = e.target.value; saveSettings(); });
    $('#setDavFile').addEventListener('change', e => { S.davFile = e.target.value.trim() || 'stock-backup.json'; saveSettings(); });
  }
  function updateMemChip() {
    const chip = $('#memChip');
    chip.classList.toggle('off', !S.memory);
    $('#memChipText').textContent = S.memory ? '记忆已开启' : '记忆已关闭';
  }

  async function testConnection() {
    const r = $('#testResult');
    r.textContent = '测试中…'; r.style.color = '';
    if (!S.apiKey) { r.textContent = '请先填写 API Key'; r.style.color = 'var(--danger)'; return; }
    try {
      const res = await fetch(`${S.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${S.apiKey}` },
        body: JSON.stringify({ model: buildPlan(false).model, messages: [{ role: 'user', content: '回复"OK"两个字即可' }], stream: false, thinking: { type: 'disabled' }, max_tokens: 20 }),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}：${txt.slice(0, 140)}`);
      const data = JSON.parse(txt);
      const c = data.choices?.[0]?.message?.content || '';
      r.textContent = `✅ 连接成功（${buildPlan(false).model}）：${c.slice(0, 40)}`;
      r.style.color = 'var(--ok)';
    } catch (e) {
      r.textContent = '❌ 失败：' + e.message;
      r.style.color = 'var(--danger)';
    }
  }

  // ============================================================
  // OpenList WebDAV 云同步（半自动：手动点上传/下载）
  // ============================================================
  function davStatus(msg, kind) {
    const el = $('#davStatus');
    if (!el) return;
    const txt = el.querySelector('.sync-text') || el;
    txt.textContent = msg;
    el.classList.toggle('show', true);
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('err', kind === 'err');
  }
  function davConfig() {
    const url = (S.davUrl || '').trim().replace(/\/+$/, '');
    const file = (S.davFile || 'stock-backup.json').trim();
    if (!url) throw new Error('请先填写 WebDAV 地址');
    if (!S.davUser) throw new Error('请先填写 OpenList 账号');
    if (!S.davPass) throw new Error('请先填写 OpenList 密码');
    const token = btoa(unescape(encodeURIComponent(S.davUser + ':' + S.davPass)));
    return { fileUrl: url + '/' + encodeURIComponent(file), token };
  }
  function davBusy(on) {
    const up = $('#btnDavUpload'), down = $('#btnDavDownload');
    if (up) up.disabled = on;
    if (down) down.disabled = on;
  }
  async function davUpload() {
    let started = false;
    try {
      const { fileUrl, token } = davConfig();
      davBusy(true); started = true;
      davStatus('① 正在整理本机数据…');
      const data = await DB.exportAll();
      data.syncedAt = Date.now();
      const size = (JSON.stringify(data).length / 1024).toFixed(1);
      davStatus(`② 正在上传到 OpenList（${size}KB）…`);
      const res = await fetch(fileUrl, {
        method: 'PUT',
        headers: { 'Authorization': 'Basic ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${t.slice(0, 100)}`);
      }
      davStatus(`✅ 上传完成 · ${new Date().toLocaleTimeString('zh-CN')} · ${size}KB`, 'ok');
      toast('已上传到 OpenList');
    } catch (e) {
      davStatus('❌ 上传失败：' + e.message, 'err');
      toast('上传失败：' + e.message, 3500);
    } finally {
      if (started) davBusy(false);
    }
  }
  async function davDownload() {
    let started = false;
    try {
      const { fileUrl, token } = davConfig();
      if (!confirm('从 OpenList 下载会【覆盖本机全部数据】(聊天、记忆、专题)。\n确定继续吗？建议先「导出全部数据」留个底。')) return;
      davBusy(true); started = true;
      davStatus('① 正在从 OpenList 读取…');
      const res = await fetch(fileUrl, {
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + token },
      });
      if (res.status === 404) throw new Error('云端还没有备份文件，请先上传一次');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      davStatus('② 正在写入本机数据…');
      const data = await res.json();
      await DB.importAll(data);
      davStatus(`✅ 下载完成 · ${new Date().toLocaleTimeString('zh-CN')} · 正在刷新…`, 'ok');
      toast('下载成功，正在刷新…');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      davStatus('❌ 下载失败：' + e.message, 'err');
      toast('下载失败：' + e.message, 3500);
      if (started) davBusy(false);
    }
  }

  // ============================================================
  // 事件绑定
  // ============================================================
  function setCompact(on) {
    $('#app').classList.toggle('compact', !!on);
    try { localStorage.setItem('stockai.compact', on ? '1' : '0'); } catch (e) {}
  }

  function bind() {
    $('#btnCollapse').addEventListener('click', () => setCompact(true));
    $('#btnExpand').addEventListener('click', () => setCompact(false));
    // 更多操作菜单：开关 + 点外部关闭
    const moreMenu = $('#moreMenu');
    $('#btnMore').addEventListener('click', e => {
      e.stopPropagation();
      moreMenu.hidden = !moreMenu.hidden;
    });
    document.addEventListener('click', e => {
      if (!moreMenu.hidden && !e.target.closest('.more-wrap')) moreMenu.hidden = true;
    });
    // 菜单项点击后收起（具体操作由各自的监听器处理）
    $$('#moreMenu .more-item').forEach(it => it.addEventListener('click', () => { moreMenu.hidden = true; }));
    $$('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.view)));
    $('#sendBtn').addEventListener('click', () => { const v = $('#input').value; $('#input').value = ''; send(v); });
    $('#input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = e.target.value; e.target.value = ''; send(v); }
    });
    $('#input').addEventListener('input', e => {
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    });
    $('#stopBtn').addEventListener('click', () => state.controller?.abort());

    // ---- 图片：选择 / 压缩 / 删除 / 预览 ----
    $('#btnAttach').addEventListener('click', () => $('#imageInput').click());
    $('#imageInput').addEventListener('change', async e => {
      const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
      e.target.value = '';
      if (!files.length) return;
      if (state.pendingImages.length >= MAX_IMGS) { toast(`一条消息最多 ${MAX_IMGS} 张图片`); return; }
      toast('正在处理图片…');
      let added = 0;
      for (const f of files) {
        if (state.pendingImages.length >= MAX_IMGS) { toast(`一条消息最多 ${MAX_IMGS} 张图片`); break; }
        try { state.pendingImages.push(await compressImage(f)); added++; }
        catch (err) { console.error(err); toast('有图片处理失败，已跳过'); }
      }
      if (added) renderPendingImages();
    });
    // 删除待发送图片（事件委托）
    $('#attachPreview').addEventListener('click', e => {
      const del = e.target.closest('.thumb-del');
      if (!del) return;
      state.pendingImages.splice(+del.dataset.idx, 1);
      renderPendingImages();
    });
    // 点击消息里的图片 → 放大预览（事件委托）
    $('#msgList').addEventListener('click', e => {
      const vb = e.target.closest('[data-voice]');
      if (vb) { toggleSpeech(vb); return; }
      const delBtn = e.target.closest('[data-del]');
      if (delBtn) { deleteMessage(delBtn.dataset.del); return; }
      const foldHead = e.target.closest('[data-reasoning-fold]');
      if (foldHead) {
        const fold = foldHead.closest('.reasoning-fold');
        if (fold) {
          const opening = !fold.classList.contains('open');
          fold.classList.toggle('open', opening);
          const body = fold.querySelector('.reasoning-fold-body');
          if (body) body.hidden = !opening;
          const label = fold.querySelector('.rf-label');
          if (label) label.textContent = opening ? '收起思考过程' : '查看思考过程';
        }
        return;
      }
      const im = e.target.closest('img[data-preview]');
      if (!im) return;
      $('#imgPreview').src = im.src;
      $('#imgModal').hidden = false;
    });

    $('#btnClearChat').addEventListener('click', async () => {
      if (!confirm('清空当前对话记录？（长期记忆档案和摘要会保留）')) return;
      const id = activeKey();
      const msgs = await DB.messagesByExam(id);
      for (const m of msgs) await DB.del('messages', m.id);
      await loadMessages();
      toast('对话已清空');
    });
    $('#btnMemoryHint').addEventListener('click', async () => {
      const exam = state.chatMode === 'exam' ? (state.exams.find(e => e.id === state.examId) || null) : null;
      const sys = await buildSystem(exam, $('#input').value || '你好');
      $('#memModalBody').textContent = sys.text;
      $('#memModal').hidden = false;
    });

    // 模式切换：自由聊股 / 选股研究（快捷按钮由 setChatMode 渲染并绑定）
    $$('#modeSwitch .mode-btn').forEach(btn => btn.addEventListener('click', () => setChatMode(btn.dataset.mode)));

    $('#btnAddExam').addEventListener('click', () => openExamModal(null));
    $('#btnSaveExam').addEventListener('click', async () => {
      const name = $('#exName').value.trim();
      if (!name) { toast('请填写专题名称'); return; }
      const exam = editingExamId ? (state.exams.find(e => e.id === editingExamId) || {}) : { id: uid(), createdAt: now() };
      exam.name = name;
      exam.subjects = $('#exSubjects').value.split('\n').map(s => s.trim()).filter(Boolean)
        .map(n => {
          const old = (exam.subjects || []).find(s => s.name === n);
          return old || { name: n, done: false };
        });
      await DB.put('exams', exam);
      $('#examModal').hidden = true;
      await loadExams();
      if (!state.examId) await selectExam(exam.id);
      toast('已保存');
    });
    $('#btnDeleteExam').addEventListener('click', async () => {
      if (!editingExamId || !confirm('删除这个专题？相关对话会保留在归档里。')) return;
      await DB.del('exams', editingExamId);
      $('#examModal').hidden = true;
      if (state.examId === editingExamId) { state.examId = null; localStorage.removeItem('stockai.currentExam'); await loadMessages(); }
      await loadExams();
      toast('已删除');
    });

    $$('[data-close]').forEach(el => el.addEventListener('click', () => {
      el.closest('.modal').hidden = true;
    }));

    $('#btnConsolidate').addEventListener('click', () => consolidate(false));
    $('#btnExport').addEventListener('click', async () => {
      const data = await DB.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `AI助手-备份-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出备份文件');
    });
    $('#btnImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        await DB.importAll(data);
        toast('导入成功，正在刷新…');
        setTimeout(() => location.reload(), 800);
      } catch (err) { toast('导入失败：' + err.message, 3000); }
      e.target.value = '';
    });

    $('#btnTest').addEventListener('click', testConnection);
    $('#btnDavUpload').addEventListener('click', davUpload);
    $('#btnDavDownload').addEventListener('click', davDownload);
    bindSettings();
  }

  // ============================================================
  // 启动
  // ============================================================
  async function init() {
    setCompact(localStorage.getItem('stockai.compact') === '1');
    bind();
    fillSettings();
    await ensureProfile();
    await loadExams();
    await setChatMode(state.chatMode, false); // 应用模式 UI（不重复加载）
    await loadMessages();
    if ('serviceWorker' in navigator) {
      // 只注册离线缓存，不自动刷新页面（避免手机浏览器卡顿）
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // 尽早应用主题，避免黑色主题用户首屏闪一下绿色
  applyTheme();
  document.addEventListener('DOMContentLoaded', init);
})();
