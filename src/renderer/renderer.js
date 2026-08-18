'use strict';

(() => {
  const api = window.aashi;
  const $ = (id) => document.getElementById(id);
  const el = {
    startupView: $('startupView'), workspace: $('workspace'), commandTab: document.querySelector('.command-tab'),
    groqKey: $('groqKeyInput'), toggleGroqKey: $('toggleGroqBtn'),
    apiKey: $('apiKeyInput'), toggleKey: $('toggleKeyBtn'), qualityBoot: $('qualityMode'), modelBoot: $('modelSelectBoot'), skillBoot: $('skillSelectBoot'), screenshotModeBoot: $('screenshotModeBoot'),
    start: $('startButton'), verify: $('verifyBtn'), bootSteps: $('bootSteps'), bootLog: $('bootLog'), healthDot: $('healthDot'), startupStatus: $('startupStatus'),
    micTest: $('micTestBtn'), micTestText: $('micTestText'), meterInterviewer: $('meterInterviewer'), meterUser: $('meterUser'),
    setupTerminalPanel: $('setupTerminalPanel'), setupTerminalOut: $('setupTerminalOut'), setupTerminalInput: $('setupTerminalInput'), setupTerminalState: $('setupTerminalState'), setupTerminalMeta: $('setupTerminalMeta'), setupTerminalClear: $('setupTerminalClearBtn'), setupTerminalClose: $('setupTerminalCloseBtn'), setupTerminalToggle: $('setupTerminalToggleBtn'),
    record: $('recordButton'), askToggle: $('askToggle'), askBox: $('askBox'), askInput: $('askInput'), send: $('sendButton'), skill: $('skillSelect'),
    answerPanel: $('answerPanel'), answerState: $('answerState'), responseMeta: $('responseMeta'), liveTranscript: $('liveTranscript'),
    chatScroll: $('chatScroll'), chatMessages: $('chatMessages'), status: $('statusLine'), copy: $('copyAnswerBtn'), clear: $('clearChatBtn'), closeAnswer: $('closeAnswerBtn'),
    scrollLeft: $('scrollLeftBtn'), scrollUp: $('scrollUpBtn'), scrollDown: $('scrollDownBtn'), scrollRight: $('scrollRightBtn'),
    stage: $('stageButton'), badge: $('stagedBadge'), sendStaged: $('sendStagedButton'), stopAI: $('stopAIButton'), helpCircle: $('shortcutsHelpButton'), tray: $('stagingTrayPopover'), trayCount: $('trayCount'), trayThumbs: $('trayThumbs'), trayClear: $('trayClearBtn'), trayPopLast: $('trayPopLastBtn'), traySend: $('traySendAllBtn'),
    settings: $('settingsButton'), settingsPopover: $('settingsPopover'), settingsClose: $('settingsClose'),
    usageButton: $('usageButton'), usageClose: $('usageClose'), usageTrackerPanel: $('usageTrackerPanel'),
    sttTrackerContent: $('sttTrackerContent'), llmTrackerContent: $('llmTrackerContent'),
    sttTrackerSettings: $('sttTrackerSettings'), llmTrackerSettings: $('llmTrackerSettings'),
    lastRoutingDecision: $('lastRoutingDecision'),
    resumeInput: $('resumeInput'),
    qualityOverlay: $('qualityModeOverlay'), modelOverlay: $('modelSelectOverlay'), screenshotModeOverlay: $('screenshotModeOverlay'), opacity: $('opacityRange'),
    sttModel: $('sttModelSelect'),
    modelTier1: $('modelTier1Select'), modelTier1Fb: $('modelTier1FbSelect'),
    modelTier2: $('modelTier2Select'), modelTier2Fb: $('modelTier2FbSelect'),
    modelTier3: $('modelTier3Select'), modelTier3Fb: $('modelTier3FbSelect'),
    tier1Extras: $('tier1Extras'), tier2Extras: $('tier2Extras'), tier3Extras: $('tier3Extras'),
    fastAnswerModel: $('fastAnswerModelSelect'),
    refreshGemini: $('refreshGeminiModelsBtn'), geminiCatalogMeta: $('geminiCatalogMeta'),
    reset: $('resetWindowButton'), close: $('closeButton'),
    terminalPanel: $('terminalPanel'), terminalOut: $('terminalOut'),
    terminalInput: $('terminalInput'), terminalPrompt: $('terminalPrompt'), terminalState: $('terminalState'),
    terminalMeta: $('terminalMeta'), terminalKill: $('terminalKillBtn'), terminalClear: $('terminalClearBtn'), terminalClose: $('terminalCloseBtn'),
    adminBadge: $('adminBadge'), elevate: $('elevateButton'), adminNote: $('adminNote'),
    shortcutsPopover: $('shortcutsPopover'), shortcutsClose: $('shortcutsClose'),
    shortcutsList: $('shortcutsList'), shortcutsPinBadge: $('shortcutsPinBadge')
  };

  let currentAssistant = null;
  let currentRaw = '';
  let lastAssistantRaw = '';
  let upgradeTarget = null; // assistant bubble waiting for the Tier-3 upgrade
  let currentRequestId = ''; // matches background Tier-3 upgrade events to this question
  let autoFollow = true;
  let recording = false;
  let placeholderVisible = false;
  let responseStartedAt = 0;
  let firstChunkSeen = false;
  let renderQueued = false;
  let verticalScrollAnimation = 0;
  let manualVerticalNavigation = false;
  let terminalRunning = false;
  let terminalHistory = [];
  let healAttempted = false;
  let terminalHistoryIndex = -1;
  let llmModelBadge = null;
  // Shortcuts help: "pinned" means the panel stays open through popover
  // toggles, outside clicks and overlay hide/show — only the × button,
  // Ctrl+Shift+/ or clicking ? again closes it.
  let shortcutsPinned = false;
  let shortcutsLoaded = false;

      function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function inlineMarkdown(value) {
    return value
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  }

  function renderMarkdown(markdown) {
    const safe = escapeHtml(markdown).replace(/\r/g, '');
    const codeBlocks = [];
    const tokenized = safe.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const token = `@@AASHI_CODE_${codeBlocks.length}@@`;
      codeBlocks.push(`<pre data-language="${lang.trim()}"><code>${code.replace(/\n$/, '')}</code></pre>`);
      return token;
    });
    const lines = tokenized.split('\n');
    const out = [];
    let list = null;
    let paragraph = [];
    const flushParagraph = () => {
      if (paragraph.length) out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };

    const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      if (/^@@AASHI_CODE_\d+@@$/.test(line.trim())) {
        flushParagraph(); closeList(); out.push(line.trim()); continue;
      }
      if (line.includes('|') && i + 1 < lines.length && tableRule.test(lines[i + 1])) {
        flushParagraph(); closeList();
        const headers = cells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(cells(lines[i]));
          i += 1;
        }
        i -= 1;
        out.push(
          '<div class="table-wrap"><table><thead><tr>' +
          headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((row) => `<tr>${headers.map((_, index) => `<td>${inlineMarkdown(row[index] || '')}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>'
        );
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flushParagraph(); closeList();
        const n = heading[1].length;
        out.push(`<h${n}>${inlineMarkdown(heading[2])}</h${n}>`);
        continue;
      }
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const type = ordered ? 'ol' : 'ul';
        if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
        out.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
        continue;
      }
      if (/^&gt;\s?/.test(line)) {
        flushParagraph(); closeList(); out.push(`<blockquote>${inlineMarkdown(line.replace(/^&gt;\s?/, ''))}</blockquote>`); continue;
      }
      if (!line.trim()) { flushParagraph(); closeList(); continue; }
      paragraph.push(line.trim());
    }
    flushParagraph(); closeList();
    let html = out.join('');
    codeBlocks.forEach((code, index) => { html = html.replace(`@@AASHI_CODE_${index}@@`, code); });
    return html;
  }

  function openAnswerPanel() {
    el.answerPanel.classList.add('open');
    requestResize();
  }

  function closeAnswerPanel() {
    el.answerPanel.classList.remove('open');
    if (recording) {
      try { api.toggleRecording().catch(() => {}); } catch (_) { }
    }
    try { if (el.liveTranscript) el.liveTranscript.replaceChildren(); } catch (_) { }
    requestResize();
  }

  function requestResize() {
    requestAnimationFrame(() => {
      const ask = el.askBox.classList.contains('open') ? el.askBox.offsetHeight + 5 : 0;
      const answer = el.answerPanel.classList.contains('open') ? 565 : 0;
      const terminal = el.terminalPanel.classList.contains('open') ? 300 + 6 : 0;
      const contentHeight = 36 + ask + answer + terminal + 10;
      const openPopover = el.tray.classList.contains('open')
        ? Math.min(208, el.tray.scrollHeight) + 46
        : el.settingsPopover.classList.contains('open')
          ? Math.min(260, el.settingsPopover.scrollHeight) + 46
          : el.usageTrackerPanel.classList.contains('open')
            ? Math.min(360, el.usageTrackerPanel.scrollHeight) + 46
            : 0;
      // The shortcuts help panel is measured separately: it may be pinned open
      // alongside another popover, and the window must be tall enough to show
      // EVERY row of it — otherwise the list gets clipped by the overlay edge.
      const helpPopover = el.shortcutsPopover && el.shortcutsPopover.classList.contains('open')
        ? Math.min(430, el.shortcutsPopover.scrollHeight) + 46
        : 0;
      api.resizeOverlay(Math.min(760, Math.max(contentHeight, openPopover, helpPopover, 36)));
    });
  }

  function showTranscriptPlaceholder() {
    placeholderVisible = true;
    el.liveTranscript.classList.add('live');
    el.liveTranscript.innerHTML = '<span class="listening">Listening — real transcription will appear here…</span>';
  }

  function clearTranscriptPlaceholder() {
    if (!placeholderVisible) return;
    placeholderVisible = false;
    el.liveTranscript.textContent = '';
  }

  function appendTranscript(text, stream) {
    clearTranscriptPlaceholder();
    el.liveTranscript.classList.add('live');
    const line = document.createElement('div');
    line.textContent = `${stream === 'interviewer' ? 'Interviewer' : 'You'}: ${text}`;
    el.liveTranscript.appendChild(line);
    const cap = el.liveTranscript.classList.contains('live') ? 40 : 12;
    while (el.liveTranscript.children.length > cap) el.liveTranscript.firstChild.remove();
    el.liveTranscript.scrollTop = el.liveTranscript.scrollHeight;
  }

  function appendToAskBox(text) {
    const next = String(text || '').trim();
    if (!next) return;
    el.askInput.value = el.askInput.value.trim() ? `${el.askInput.value.trim()}\n${next}` : next;
    el.askInput.dataset.source = 'voice';
    el.askBox.classList.add('open');
    autoGrowInput();
    requestResize();
    el.askInput.focus();
  }

  function messageBody(node) {
    return node?.querySelector('.message-body') || node;
  }

  function addMessage(role, raw = '') {
    const node = document.createElement('article');
    node.className = `message ${role}`;
    node.dataset.raw = raw;

    const head = document.createElement('header');
    head.className = 'message-head';
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'assistant' ? 'A' : 'Y';
    const identity = document.createElement('span');
    identity.className = 'message-identity';
    identity.textContent = role === 'assistant' ? 'NetworkCap AI' : 'You';
    const meta = document.createElement('span');
    meta.className = 'message-meta';
    meta.textContent = role === 'assistant' ? 'Preparing response' : 'Question';
    head.append(avatar, identity, meta);

    if (role === 'assistant') {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'message-copy';
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        const value = node.dataset.raw || '';
        if (value) await navigator.clipboard.writeText(value);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1100);
      });
      head.appendChild(copy);
    }

    const body = document.createElement('div');
    body.className = 'message-body';
    if (role === 'assistant') body.innerHTML = renderMarkdown(raw);
    else body.textContent = raw;
    node.append(head, body);
    el.chatMessages.appendChild(node);
    scrollToBottom(true);
    return node;
  }

  function modelBadgeHtml(model) {
    const cls = String(model || '').startsWith('gemini') ? 'gemini' : 'groq';
    const label = String(model || '').includes('/') ? model.split('/').pop() : model;
    return `<span class="model-badge ${cls}">${escapeHtml(label)}</span>`;
  }

  function setAssistantModelBadge(model) {
    if (!currentAssistant) return;
    const meta = currentAssistant.querySelector('.message-meta');
    if (meta) meta.innerHTML = `Answered ${modelBadgeHtml(model)}`;
  }

  function renderStreamingAnswer() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!currentAssistant) return;
      currentAssistant.dataset.raw = currentRaw;
      messageBody(currentAssistant).innerHTML = renderMarkdown(currentRaw);
      currentAssistant.classList.add('streaming');
      scrollToBottom();
    });
  }

  function scrollToBottom(force = false) {
    if (!autoFollow && !force) return;
    el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
  }

  function scrollChat(direction) {
    const start = el.chatScroll.scrollTop;
    const maximum = Math.max(0, el.chatScroll.scrollHeight - el.chatScroll.clientHeight);
    const amount = Math.max(24, Math.min(40, Math.round(el.chatScroll.clientHeight * .07)));
    const target = Math.max(0, Math.min(maximum, start + direction * amount));
    if (Math.abs(target - start) < 1) return;
    autoFollow = false;
    manualVerticalNavigation = true;
    if (verticalScrollAnimation) cancelAnimationFrame(verticalScrollAnimation);
    const startedAt = performance.now();
    const duration = 240;
    const animate = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.chatScroll.scrollTop = start + (target - start) * eased;
      if (progress < 1) {
        verticalScrollAnimation = requestAnimationFrame(animate);
      } else {
        verticalScrollAnimation = 0;
        if (target >= maximum - 1) {
          manualVerticalNavigation = false;
          autoFollow = true;
        }
      }
    };
    verticalScrollAnimation = requestAnimationFrame(animate);
  }

  function visibleHorizontalScroller(direction) {
    const chatRect = el.chatScroll.getBoundingClientRect();
    const candidates = [...el.chatMessages.querySelectorAll('pre, .table-wrap')]
      .filter((node) => node.scrollWidth > node.clientWidth + 2)
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > chatRect.top && rect.top < chatRect.bottom;
      });
    const movable = candidates.filter((node) => direction < 0
      ? node.scrollLeft > 1
      : node.scrollLeft < node.scrollWidth - node.clientWidth - 1);
    const pool = movable.length ? movable : candidates;
    const center = (chatRect.top + chatRect.bottom) / 2;
    return pool.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return Math.abs((ar.top + ar.bottom) / 2 - center) - Math.abs((br.top + br.bottom) / 2 - center);
    })[0] || null;
  }

  function scrollWideContent(direction) {
    const target = visibleHorizontalScroller(direction);
    if (!target) {
      el.status.textContent = 'No horizontally clipped code or table is visible.';
      return;
    }
    const amount = Math.max(48, Math.min(120, Math.round(target.clientWidth * .18)));
    target.scrollBy({ left: direction * amount, behavior: 'smooth' });
  }

  async function sendQuestion() {
    const text = el.askInput.value.trim();
    if (!text) return;
    const fromVoice = el.askInput.dataset.source === 'voice';
    addMessage('user', text);
    openAnswerPanel();
    el.askInput.value = '';
    el.askInput.dataset.source = '';
    autoGrowInput();
    el.answerState.textContent = 'Routing…';
    try {
      await api.askQuestion({ query: text, skill: el.skill.value });
    } catch (error) {
      el.status.textContent = error.message;
    }
  }

  function autoGrowInput() {
    el.askInput.style.height = 'auto';
    el.askInput.style.height = `${Math.min(115, Math.max(40, el.askInput.scrollHeight))}px`;
    requestResize();
  }

  // ---- built-in terminal ----
  function appendTerminalText(text, stream) {
    const span = document.createElement('span');
    if (stream === 'err') span.className = 'term-err';
    else if (stream === 'sys') span.className = 'term-sys';
    span.textContent = text;
    if (el.terminalOut) {
      el.terminalOut.appendChild(span.cloneNode(true));
      el.terminalOut.scrollTop = el.terminalOut.scrollHeight;
      while (el.terminalOut.childNodes.length > 4000) el.terminalOut.firstChild.remove();
    }
    if (el.setupTerminalOut) {
      el.setupTerminalOut.appendChild(span);
      el.setupTerminalOut.scrollTop = el.setupTerminalOut.scrollHeight;
      while (el.setupTerminalOut.childNodes.length > 4000) el.setupTerminalOut.firstChild.remove();
    }
  }

  function appendSetupTerminalText(text, stream) {
    const span = document.createElement('span');
    if (stream === 'err') span.className = 'term-err';
    else if (stream === 'sys') span.className = 'term-sys';
    else if (stream === 'healing') span.className = 'term-sys';
    span.textContent = text;
    if (el.setupTerminalOut) {
      el.setupTerminalOut.appendChild(span);
      el.setupTerminalOut.scrollTop = el.setupTerminalOut.scrollHeight;
      while (el.setupTerminalOut.childNodes.length > 4000) el.setupTerminalOut.firstChild.remove();
    }
    if (el.terminalOut) {
      const clone = span.cloneNode(true);
      el.terminalOut.appendChild(clone);
      el.terminalOut.scrollTop = el.terminalOut.scrollHeight;
      while (el.terminalOut.childNodes.length > 4000) el.terminalOut.firstChild.remove();
    }
  }

  function shortPath(dir) {
    if (!dir) return '';
    const parts = dir.replace(/\\/g, '/').split('/');
    const tail = parts.slice(-2).join('/');
    return parts.length > 2 ? `…/${tail}` : dir;
  }

  function setTerminalCwd(cwd) {
    el.terminalMeta.textContent = cwd || '';
  }

  function openTerminal() {
    el.terminalPanel.classList.add('open');
    requestResize();
    el.terminalInput.focus();
  }

  function closeTerminal() {
    el.terminalPanel.classList.remove('open');
    requestResize();
  }

  function toggleTerminal() {
    if (el.terminalPanel.classList.contains('open')) closeTerminal();
    else openTerminal();
  }

  async function runTerminalCommand(commandLine) {
    const cmd = String(commandLine || '').trim();
    if (!cmd) return;
    appendTerminalText(`${cmd}\r\n`, 'sys');
    el.terminalInput.value = '';
    terminalHistory.push(cmd);
    terminalHistoryIndex = terminalHistory.length;
    try {
      const result = await api.terminalExec(cmd);
      if (result.cwd) setTerminalCwd(result.cwd);
      if (!result.ok) {
        if (result.reason !== 'busy') appendTerminalText(`${result.reason}\r\n`, 'err');
        else appendTerminalText('A command is still running — wait or press Stop.\r\n', 'err');
        terminalRunning = false;
        el.terminalState.textContent = 'Terminal';
      } else if (result.spawned) {
        terminalRunning = true;
        el.terminalState.textContent = 'Running…';
      } else {
        terminalRunning = false;
        el.terminalState.textContent = 'Terminal';
      }
    } catch (error) {
      appendTerminalText(`${error.message}\r\n`, 'err');
      terminalRunning = false;
      el.terminalState.textContent = 'Terminal';
    }
  }

  function renderPrivileges(elevated, platform) {
    const isWin = platform === 'win32';
    el.adminBadge.textContent = elevated ? 'Administrator' : 'Standard user';
    el.adminBadge.classList.toggle('elevated', Boolean(elevated));
    el.elevate.style.display = elevated ? 'none' : 'block';
    if (elevated) {
      el.adminNote.textContent = 'Running elevated — terminal commands have full administrator rights.';
    } else if (isWin) {
      el.adminNote.textContent = 'Not elevated. Restart as Administrator to give terminal commands full rights.';
    } else {
      el.adminNote.textContent = 'Running as a normal user. Use the button to relaunch elevated.';
    }
  }

  const MODEL_LABELS = {
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite — ultra fast',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite — fastest',
    'gemini-3.5-flash': 'Gemini 3.5 Flash — balanced',
    'gemini-3.6-flash': 'Gemini 3.6 Flash — fast + capable',
    'gemini-3.7-flash': 'Gemini 3.7 Flash — NEWEST latest & most capable',
    'openai/gpt-oss-20b': 'GPT-OSS 20B (Groq) — fastest simple answers',
    'openai/gpt-oss-120b': 'GPT-OSS 120B (Groq) — fast + capable',
    'qwen/qwen3.6-27b': 'Qwen 3.6 27B (Groq) — fast',
    'meta-llama/llama-3.3-70b-versatile': 'Llama 3.3 70B (Groq) — versatile',
    'whisper-large-v3-turbo': 'Whisper Large V3 Turbo — fast & accurate (default)',
    'whisper-large-v3': 'Whisper Large V3 — most accurate'
  };

  // Current runtime state for the Model Routing panel.
  let bootInfo = null;           // payload from getBootStatus
  let currentConfig = {};        // payload from getConfig
  let currentTierOverrides = {}; // editable copy of tierOverrides
  let geminiCatalog = [];        // latest Gemini model list (fresh or cached)

  function modelOption(id) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = MODEL_LABELS[id] || id;
    return option;
  }

  // Fill one routing select with Groq + Gemini options and pick `value`.
  function populateModelSelect(select, value) {
    if (!select) return;
    const groqIds = Array.isArray(bootInfo && bootInfo.groqModels) ? bootInfo.groqModels.map((g) => g.id) : [];
    const geminiIds = geminiCatalog.length ? geminiCatalog : Object.keys(MODEL_LABELS).filter((m) => m.startsWith('gemini-'));
    select.replaceChildren();
    const groqGroup = document.createElement('optgroup');
    groqGroup.label = 'Groq (fast)';
    for (const id of groqIds) groqGroup.appendChild(modelOption(id));
    const geminiGroup = document.createElement('optgroup');
    geminiGroup.label = 'Gemini';
    for (const id of geminiIds) geminiGroup.appendChild(modelOption(id));
    select.appendChild(groqGroup);
    select.appendChild(geminiGroup);
    if (value && [...select.options].some((o) => o.value === value)) select.value = value;
  }

  function populateModelRouting(c = {}) {
    const tov = (c.tierOverrides && typeof c.tierOverrides === 'object') ? c.tierOverrides : {};
    currentTierOverrides = JSON.parse(JSON.stringify(tov));
    const td = (bootInfo && bootInfo.tierDefaults) || {};
    const d = (key, which) => ((td[key] || {})[which]) || '';
    const pairs = [
      [el.modelTier1, (tov.simple && tov.simple.primary) || d('simple', 'primary')],
      [el.modelTier1Fb, (tov.simple && tov.simple.fallback) || d('simple', 'fallback')],
      [el.modelTier2, (tov.moderate && tov.moderate.primary) || d('moderate', 'primary')],
      [el.modelTier2Fb, (tov.moderate && tov.moderate.fallback) || d('moderate', 'fallback')],
      [el.modelTier3, (tov.hard && tov.hard.primary) || d('hard', 'primary')],
      [el.modelTier3Fb, (tov.hard && tov.hard.fallback) || d('hard', 'fallback')],
      [el.fastAnswerModel, c.fastAnswerModel || 'openai/gpt-oss-20b']
    ];
    for (const [select, value] of pairs) populateModelSelect(select, value);
    // Show the automatic extra failover models per tier (read-only).
    const extrasMap = { simple: el.tier1Extras, moderate: el.tier2Extras, hard: el.tier3Extras };
    for (const [key, target] of Object.entries(extrasMap)) {
      if (!target) continue;
      const ex = ((td[key] || {}).extras) || [];
      target.textContent = ex.length ? `Auto-failover → ${ex.join(' · ')}` : '';
    }
  }

  function renderGeminiCatalogMeta(info) {
    if (!el.geminiCatalogMeta) return;
    const n = info && info.ok ? info.count : (geminiCatalog.length || 0);
    const at = info && info.updatedAt ? new Date(info.updatedAt) : null;
    el.geminiCatalogMeta.textContent = at
      ? `${n} Gemini models · updated ${at.toLocaleTimeString()}`
      : `${n} Gemini models cached`;
  }

  function setTierOverride(tierKey, which, modelId) {
    currentTierOverrides = { ...currentTierOverrides };
    currentTierOverrides[tierKey] = { ...(currentTierOverrides[tierKey] || {}) };
    currentTierOverrides[tierKey][which] = modelId;
    api.setConfig({ tierOverrides: currentTierOverrides }).then((r) => {
      if (r && r.ok) el.status.textContent = `Saved: ${tierKey} ${which} → ${modelId}`;
    }).catch(() => {});
  }

  function populateModels(models, selected) {
    const available = Array.isArray(models) && models.length ? models : Object.keys(MODEL_LABELS);
    for (const select of [el.modelBoot, el.modelOverlay]) {
      select.replaceChildren();
      for (const model of available) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = MODEL_LABELS[model] || model;
        select.appendChild(option);
      }
      select.value = available.includes(selected) ? selected : available[0];
    }
  }

  async function loadConfig() {
    const [c, boot] = await Promise.all([api.getConfig(), api.getBootStatus()]);
    bootInfo = boot;
    currentConfig = c;
    el.skill.value = c.skill || 'interview';
    el.skillBoot.value = c.skill || 'interview';
    const mode = ['instant', 'fast', 'verified'].includes(c.qualityMode) ? c.qualityMode : 'instant';
    el.qualityBoot.value = mode;
    el.qualityOverlay.value = mode;
    populateModels(boot.availableModels, c.model);
    geminiCatalog = Array.isArray(boot.gemini && boot.gemini.catalog) && boot.gemini.catalog.length
      ? boot.gemini.catalog
      : (Array.isArray(boot.availableModels) ? boot.availableModels : []);
    populateModelRouting(c);
    renderGeminiCatalogMeta(null);
    if (el.sttModel && boot.groq && Array.isArray(boot.groq.availableModels)) {
      el.sttModel.replaceChildren();
      for (const id of boot.groq.availableModels) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = MODEL_LABELS[id] || id;
        el.sttModel.appendChild(option);
      }
      if (c.sttModel && [...el.sttModel.options].some((o) => o.value === c.sttModel)) el.sttModel.value = c.sttModel;
    }
    el.opacity.value = c.opacity ?? 1;
    const sMode = ['normal', 'hard', 'only-hard'].includes(c.screenshotMode) ? c.screenshotMode : 'hard';
    if (el.screenshotModeBoot) el.screenshotModeBoot.value = sMode;
    if (el.screenshotModeOverlay) el.screenshotModeOverlay.value = sMode;
    if (c.geminiApiKeyMasked) el.apiKey.placeholder = `Configured (${c.geminiApiKeyMasked}) — paste to replace`;
    if (c.groqApiKeyMasked) el.groqKey.placeholder = `Configured (${c.groqApiKeyMasked}) — paste to replace`;
    if (el.resumeInput) el.resumeInput.value = c.resume || '';
    renderPrivileges(boot.elevated, boot.platform);
    api.terminalStatus().then((s) => setTerminalCwd(s.cwd));
    try { const sm = await api.getScreenshotMode(); if (el.screenshotModeBoot) el.screenshotModeBoot.value = sm; if (el.screenshotModeOverlay) el.screenshotModeOverlay.value = sm; } catch (_) { }
  }

  async function saveBootConfig() {
    const patch = {
      qualityMode: el.qualityBoot.value,
      model: el.modelBoot.value,
      skill: el.skillBoot.value,
      screenshotMode: el.screenshotModeBoot ? el.screenshotModeBoot.value : 'hard'
    };
    if (el.groqKey.value.trim()) patch.groqApiKey = el.groqKey.value.trim();
    if (el.apiKey.value.trim()) patch.geminiApiKey = el.apiKey.value.trim();
    if (el.resumeInput) patch.resume = el.resumeInput.value;
    await api.setConfig(patch);
    try { await api.setScreenshotMode(patch.screenshotMode); } catch (_) { }
  }

  async function verifyEnvironment() {
    el.startupStatus.textContent = 'Running checks…';
    el.bootSteps.innerHTML = '';
    appendSetupTerminalText('=== Running checks — Groq STT + 3-tier LLM router live ===', 'sys');
    const report = await api.verifyEnvironment();
    el.healthDot.className = `health-dot ${report.ok ? 'ok' : 'bad'}`;
    for (const step of report.steps || []) {
      const p = document.createElement('p');
      p.className = step.ok ? 'ok' : step.optional ? 'warn' : 'bad';
      p.textContent = `${step.ok ? '✓' : step.optional ? '○' : '•'} ${step.name} — ${step.detail}`;
      el.bootSteps.appendChild(p);
      appendSetupTerminalText(`${step.ok ? '✓' : step.optional ? '○' : '•'} ${step.name}: ${step.detail}`, step.ok ? 'sys' : 'err');
    }
    el.startupStatus.textContent = report.ok ? 'All checks passed' : 'Some checks need attention (add API keys)';
    return report;
  }

  el.toggleKey.addEventListener('click', () => {
    const visible = el.apiKey.type === 'text';
    el.apiKey.type = visible ? 'password' : 'text';
    el.toggleKey.textContent = visible ? 'Show' : 'Hide';
  });
  el.toggleGroqKey.addEventListener('click', () => {
    const visible = el.groqKey.type === 'text';
    el.groqKey.type = visible ? 'password' : 'text';
    el.toggleGroqKey.textContent = visible ? 'Show' : 'Hide';
  });
  el.verify.addEventListener('click', async () => {
    healAttempted = false;
    await saveBootConfig();
    await verifyEnvironment().catch((error) => { el.startupStatus.textContent = error.message; });
  });
  el.start.addEventListener('click', async () => {
    el.start.disabled = true;
    try {
      await saveBootConfig();
      el.skill.value = el.skillBoot.value;
      el.qualityOverlay.value = el.qualityBoot.value;
      el.modelOverlay.value = el.modelBoot.value;
      await api.startAashi();
      el.startupView.style.setProperty('display', 'none', 'important');
      el.workspace.style.display = 'block';
      el.commandTab.style.setProperty('display', 'flex', 'important');
      await api.resizeOverlay(36);
    } catch (error) {
      el.startupStatus.textContent = error.message;
      el.start.disabled = false;
    }
  });

  el.micTest.addEventListener('click', async () => {
    el.micTest.disabled = true;
    el.micTestText.textContent = 'Listening for 3 seconds…';
    try {
      await saveBootConfig();
      const result = await api.runMicTest(3);
      if (!result.ok) {
        el.micTestText.textContent = result.reason || 'Microphone test could not start.';
        el.micTest.disabled = false;
      }
    } catch (error) {
      el.micTestText.textContent = error.message;
      el.micTest.disabled = false;
    }
  });

  el.askToggle.addEventListener('click', () => {
    el.askBox.classList.toggle('open');
    requestResize();
    if (el.askBox.classList.contains('open')) el.askInput.focus();
  });
  el.send.addEventListener('click', sendQuestion);
  el.askInput.addEventListener('input', () => { el.askInput.dataset.source = ''; autoGrowInput(); });
  el.askInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendQuestion(); }
  });
  el.skill.addEventListener('change', () => api.setConfig({ skill: el.skill.value }));
  el.record.addEventListener('click', () => api.toggleRecording());
  el.close.addEventListener('click', () => api.quit());

  el.chatScroll.addEventListener('scroll', () => {
    const fromBottom = el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight;
    if (fromBottom <= .5) {
      manualVerticalNavigation = false;
      autoFollow = true;
    } else if (manualVerticalNavigation) {
      autoFollow = false;
    } else {
      autoFollow = fromBottom < 42;
    }
  });
  el.scrollUp.addEventListener('click', () => { openAnswerPanel(); scrollChat(-1); });
  el.scrollDown.addEventListener('click', () => { openAnswerPanel(); scrollChat(1); });
  el.scrollLeft.addEventListener('click', () => { openAnswerPanel(); scrollWideContent(-1); });
  el.scrollRight.addEventListener('click', () => { openAnswerPanel(); scrollWideContent(1); });
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      openAnswerPanel();
      scrollChat(event.key === 'ArrowUp' ? -1 : 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      openAnswerPanel();
      scrollWideContent(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }, true);

  el.copy.addEventListener('click', async () => {
    if (!lastAssistantRaw) return;
    await navigator.clipboard.writeText(lastAssistantRaw);
    el.status.textContent = 'Answer copied.';
  });
  el.clear.addEventListener('click', () => {
    el.chatMessages.replaceChildren();
    el.liveTranscript.replaceChildren();
    lastAssistantRaw = '';
    api.setConfig({});
    el.status.textContent = 'Chat cleared.';
  });
  if (el.closeAnswer) {
    el.closeAnswer.addEventListener('click', () => {
      closeAnswerPanel();
      el.status.textContent = 'Response overlay closed.';
    });
  }
  api.onCloseResponseOverlay(() => {
    closeAnswerPanel();
    el.status.textContent = 'Response overlay closed (Ctrl+Shift+O)';
  });

  el.stage.addEventListener('click', async () => {
    el.status.textContent = 'Capturing screenshot…';
    const result = await api.stageScreenshot();
    if (!result.ok) el.status.textContent = result.reason || 'Capture failed.';
    el.settingsPopover.classList.remove('open');
    el.tray.classList.add('open');
    requestResize();
  });
  el.sendStaged.addEventListener('click', () => {
    el.tray.classList.remove('open');
    openAnswerPanel(); // ensure the response window opens when sending screenshots
    requestResize();
    api.sendStagedImages(el.skill.value);
  });
  el.traySend.addEventListener('click', () => {
    el.tray.classList.remove('open');
    openAnswerPanel(); // ensure the response window opens when sending screenshots
    requestResize();
    api.sendStagedImages(el.skill.value);
  });
  el.trayClear.addEventListener('click', async () => {
    await api.clearStagedImages();
    requestResize();
  });
  if (el.trayPopLast) {
    el.trayPopLast.addEventListener('click', async () => {
      const res = await api.removeLastStagedImage();
      if (!res.ok) el.status.textContent = 'No staged images to pop.';
      else el.status.textContent = `Removed: ${res.removed?.label || 'last image'}`;
      requestResize();
    });
  }

  if (el.stopAI) {
    el.stopAI.addEventListener('click', async () => {
      await api.stopGeneration();
      el.status.textContent = 'AI stopped.';
    });
  }

  // -------------------------------------------------------------------------
  // Shortcuts help panel
  //   hover ?            → transient peek (closes on mouse-out)
  //   click ? / Ctrl+Shift+L → PIN open (survives other popovers, outside
  //                            clicks, Esc and overlay hide/show)
  //   Ctrl+Shift+/ (or ?) / × button → close + unpin
  // -------------------------------------------------------------------------
  async function loadShortcutsList(force = false) {
    if (shortcutsLoaded && !force) return;
    if (!el.shortcutsList || !api.getShortcuts) return;
    let list = [];
    try { list = await api.getShortcuts(); } catch (_) { list = []; }
    if (!Array.isArray(list) || !list.length) return;
    el.shortcutsList.replaceChildren();
    for (const item of list) {
      const row = document.createElement('div');
      if (item.registered === false) row.classList.add('shortcut-dead');
      const key = document.createElement('kbd');
      key.textContent = item.accel;
      const label = document.createElement('span');
      label.textContent = item.registered === false ? `${item.label} — hotkey taken by another app` : item.label;
      row.append(key, label);
      el.shortcutsList.appendChild(row);
    }
    shortcutsLoaded = true;
  }

  function syncShortcutsPinUi() {
    el.shortcutsPopover.classList.toggle('pinned', shortcutsPinned);
    if (el.shortcutsPinBadge) el.shortcutsPinBadge.classList.toggle('show', shortcutsPinned);
    if (el.helpCircle) {
      el.helpCircle.classList.toggle('active', shortcutsPinned);
      el.helpCircle.setAttribute('aria-pressed', String(shortcutsPinned));
    }
  }

  function showShortcutsHelp({ pin = false } = {}) {
    if (pin) shortcutsPinned = true;
    // A pinned help panel coexists with the other popovers; a transient peek
    // still takes over the corner so nothing overlaps.
    if (!shortcutsPinned) {
      el.settingsPopover.classList.remove('open');
      el.tray.classList.remove('open');
      el.usageTrackerPanel.classList.remove('open');
    }
    el.shortcutsPopover.classList.add('open');
    syncShortcutsPinUi();
    loadShortcutsList().then(() => requestResize()).catch(() => {});
    requestResize();
  }

  function hideShortcutsHelp({ force = false } = {}) {
    // Transient peeks close freely; a pinned panel only closes on an explicit
    // close action (× button, Ctrl+Shift+/, or clicking ? again).
    if (shortcutsPinned && !force) return;
    shortcutsPinned = false;
    el.shortcutsPopover.classList.remove('open');
    syncShortcutsPinUi();
    requestResize();
  }

  function toggleShortcutsHelp() {
    if (shortcutsPinned) hideShortcutsHelp({ force: true });
    else showShortcutsHelp({ pin: true });
  }

  // Small grace period so the pointer can travel from the ? button into the
  // panel without the transient peek collapsing mid-way.
  let peekCloseTimer = 0;
  const cancelPeekClose = () => { if (peekCloseTimer) { clearTimeout(peekCloseTimer); peekCloseTimer = 0; } };
  const schedulePeekClose = () => {
    cancelPeekClose();
    if (shortcutsPinned) return;
    peekCloseTimer = setTimeout(() => { peekCloseTimer = 0; hideShortcutsHelp(); }, 260);
  };

  if (el.helpCircle) {
    el.helpCircle.addEventListener('click', () => { cancelPeekClose(); toggleShortcutsHelp(); });
    el.helpCircle.addEventListener('mouseenter', () => { cancelPeekClose(); showShortcutsHelp(); });
    el.helpCircle.addEventListener('mouseleave', schedulePeekClose);
  }
  if (el.shortcutsPopover) {
    el.shortcutsPopover.addEventListener('mouseenter', cancelPeekClose);
    // Leaving the panel itself ends a transient peek — a pinned panel stays.
    el.shortcutsPopover.addEventListener('mouseleave', schedulePeekClose);
  }
  if (el.shortcutsClose) {
    el.shortcutsClose.addEventListener('click', () => hideShortcutsHelp({ force: true }));
  }
  loadShortcutsList().catch(() => {});

  if (el.screenshotModeBoot) {
    el.screenshotModeBoot.addEventListener('change', async () => {
      await api.setScreenshotMode(el.screenshotModeBoot.value);
      if (el.screenshotModeOverlay) el.screenshotModeOverlay.value = el.screenshotModeBoot.value;
      el.status.textContent = `Screenshot mode: ${el.screenshotModeBoot.value}`;
    });
  }
  if (el.screenshotModeOverlay) {
    el.screenshotModeOverlay.addEventListener('change', async () => {
      await api.setScreenshotMode(el.screenshotModeOverlay.value);
      if (el.screenshotModeBoot) el.screenshotModeBoot.value = el.screenshotModeOverlay.value;
      el.status.textContent = `Screenshot mode: ${el.screenshotModeOverlay.value}`;
    });
  }

  api.onScreenshotModeChanged((m) => {
    const mode = m?.mode || 'hard';
    if (el.screenshotModeBoot) el.screenshotModeBoot.value = mode;
    if (el.screenshotModeOverlay) el.screenshotModeOverlay.value = mode;
    const labels = { normal: 'Normal', hard: 'Hard', 'only-hard': 'Only Hard' };
    el.status.textContent = `Screenshot mode cycled to: ${labels[mode] || mode}`;
  });
  // Ctrl+Shift+L pins/unpins the help panel; Ctrl+Shift+/ (or ?) always closes it.
  api.onShowShortcuts(() => { toggleShortcutsHelp(); });
  if (api.onCloseShortcuts) api.onCloseShortcuts(() => { hideShortcutsHelp({ force: true }); });
  // Overlay hidden then re-shown (Ctrl+Shift+H): a pinned help panel comes back.
  api.onShowOverlay(() => {
    if (shortcutsPinned) { el.shortcutsPopover.classList.add('open'); syncShortcutsPinUi(); requestResize(); }
  });

  function renderTray(state) {
    el.badge.textContent = state.count;
    el.badge.classList.toggle('show', state.count > 0);
    el.trayCount.textContent = `${state.count} image${state.count === 1 ? '' : 's'}`;
    el.trayThumbs.replaceChildren();
    for (const image of state.images || []) {
      const item = document.createElement('div');
      item.className = 'tray-item';
      item.title = `${image.label} · ${Math.round(image.bytes / 1024)} KB`;
      const img = document.createElement('img');
      img.src = image.thumbnail;
      img.alt = image.label;
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Remove image';
      del.addEventListener('click', (event) => { event.stopPropagation(); api.removeStagedImage(image.id); });
      item.append(img, del);
      el.trayThumbs.appendChild(item);
    }
    if (el.tray.classList.contains('open')) requestResize();
  }

  el.settings.addEventListener('click', () => {
    el.tray.classList.remove('open');
    if (!shortcutsPinned) el.shortcutsPopover.classList.remove('open');
    el.usageTrackerPanel.classList.remove('open');
    el.settingsPopover.classList.toggle('open');
    requestResize();
  });
  el.settingsClose.addEventListener('click', () => {
    el.settingsPopover.classList.remove('open');
    requestResize();
  });
  el.qualityOverlay.addEventListener('change', () => {
    el.qualityBoot.value = el.qualityOverlay.value;
    api.setConfig({ qualityMode: el.qualityOverlay.value });
  });
  el.modelOverlay.addEventListener('change', () => {
    el.modelBoot.value = el.modelOverlay.value;
    api.setConfig({ model: el.modelOverlay.value });
  });

  // Speech-to-text (Whisper) model selector.
  if (el.sttModel) {
    el.sttModel.addEventListener('change', () => {
      api.setConfig({ sttModel: el.sttModel.value });
      el.status.textContent = `STT model: ${el.sttModel.value}`;
    });
  }

  // Resume: save instantly so every model (Tier 1/2/3, fast partner) can use it.
  if (el.resumeInput) {
    el.resumeInput.addEventListener('change', () => {
      api.setConfig({ resume: el.resumeInput.value });
      el.status.textContent = 'Resume saved — all AI models will use it.';
    });
  }

  // Model Routing: default + fallback per tier, and the Tier-3 fast partner.
  if (el.modelTier1) el.modelTier1.addEventListener('change', () => setTierOverride('simple', 'primary', el.modelTier1.value));
  if (el.modelTier1Fb) el.modelTier1Fb.addEventListener('change', () => setTierOverride('simple', 'fallback', el.modelTier1Fb.value));
  if (el.modelTier2) el.modelTier2.addEventListener('change', () => setTierOverride('moderate', 'primary', el.modelTier2.value));
  if (el.modelTier2Fb) el.modelTier2Fb.addEventListener('change', () => setTierOverride('moderate', 'fallback', el.modelTier2Fb.value));
  if (el.modelTier3) el.modelTier3.addEventListener('change', () => setTierOverride('hard', 'primary', el.modelTier3.value));
  if (el.modelTier3Fb) el.modelTier3Fb.addEventListener('change', () => setTierOverride('hard', 'fallback', el.modelTier3Fb.value));
  if (el.fastAnswerModel) {
    el.fastAnswerModel.addEventListener('change', () => {
      currentConfig.fastAnswerModel = el.fastAnswerModel.value;
      api.setConfig({ fastAnswerModel: el.fastAnswerModel.value });
      el.status.textContent = `Fast first-answer model: ${el.fastAnswerModel.value}`;
    });
  }

  // Update Gemini models list (models keep shipping).
  if (el.refreshGemini) {
    el.refreshGemini.addEventListener('click', async () => {
      const original = el.refreshGemini.textContent;
      el.refreshGemini.disabled = true;
      el.refreshGemini.textContent = 'Updating…';
      const res = await api.refreshGeminiModels();
      el.refreshGemini.disabled = false;
      el.refreshGemini.textContent = original;
      if (res && res.ok) {
        geminiCatalog = res.models || [];
        populateModels(geminiCatalog, el.modelOverlay.value);
        populateModelRouting(currentConfig);
        renderGeminiCatalogMeta(res);
        el.status.textContent = `Gemini models updated — ${res.count} available`;
      } else {
        renderGeminiCatalogMeta(null);
        el.geminiCatalogMeta.textContent = res && res.reason ? `⚠ ${res.reason}` : '⚠ Update failed';
        el.status.textContent = 'Gemini model update failed';
      }
    });
  }

  el.opacity.addEventListener('input', () => api.setOpacity(Number(el.opacity.value)));
  el.reset.addEventListener('click', () => api.resetWindow());

  // Usage tracker popover
  if (el.usageButton) {
    el.usageButton.addEventListener('click', () => {
      el.settingsPopover.classList.remove('open');
      if (!shortcutsPinned) el.shortcutsPopover.classList.remove('open');
      el.tray.classList.remove('open');
      el.usageTrackerPanel.classList.toggle('open');
      requestResize();
    });
  }
  if (el.usageClose) {
    el.usageClose.addEventListener('click', () => { el.usageTrackerPanel.classList.remove('open'); requestResize(); });
  }

  // ---- terminal + privileges wiring ----
  el.terminalClose.addEventListener('click', closeTerminal);
  el.terminalClear.addEventListener('click', () => { el.terminalOut.replaceChildren(); });
  el.terminalKill.addEventListener('click', async () => {
    const result = await api.terminalKill();
    if (!result.ok) el.status.textContent = result.reason;
  });
  el.terminalInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (terminalRunning) {
        api.terminalInput(`${el.terminalInput.value}\r\n`);
        appendTerminalText(`${el.terminalInput.value}\r\n`, 'sys');
        el.terminalInput.value = '';
      } else {
        runTerminalCommand(el.terminalInput.value);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (terminalHistoryIndex > 0) {
        terminalHistoryIndex -= 1;
        el.terminalInput.value = terminalHistory[terminalHistoryIndex] || '';
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (terminalHistoryIndex < terminalHistory.length - 1) {
        terminalHistoryIndex += 1;
        el.terminalInput.value = terminalHistory[terminalHistoryIndex] || '';
      } else {
        terminalHistoryIndex = terminalHistory.length;
        el.terminalInput.value = '';
      }
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && terminalRunning) {
      event.preventDefault();
      api.terminalKill();
    }
  });
  el.elevate.addEventListener('click', async () => {
    el.elevate.disabled = true;
    el.elevate.textContent = 'Relaunching…';
    const result = await api.relaunchAsAdmin();
    if (!result.ok) {
      el.elevate.disabled = false;
      el.elevate.textContent = 'Restart as Administrator';
      el.status.textContent = result.reason || 'Elevation failed.';
    }
  });

  if (el.setupTerminalToggle) {
    el.setupTerminalToggle.addEventListener('click', () => {
      el.setupTerminalPanel.style.display = el.setupTerminalPanel.style.display === 'none' ? 'flex' : 'none';
    });
  }
  if (el.setupTerminalClose) {
    el.setupTerminalClose.addEventListener('click', () => { el.setupTerminalPanel.style.display = 'none'; });
  }
  if (el.setupTerminalClear) {
    el.setupTerminalClear.addEventListener('click', () => { el.setupTerminalOut.replaceChildren(); });
  }
  if (el.setupTerminalInput) {
    el.setupTerminalInput.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const cmd = el.setupTerminalInput.value.trim();
        if (!cmd) return;
        appendSetupTerminalText(`> ${cmd}`, 'sys');
        el.setupTerminalInput.value = '';
        try {
          const result = await api.terminalExec(cmd);
          if (result.cwd && el.setupTerminalMeta) el.setupTerminalMeta.textContent = result.cwd;
        } catch (e) {
          appendSetupTerminalText(e.message, 'err');
        }
      }
    });
  }

  api.onTerminalToggle(() => toggleTerminal());
  api.onTerminalOutput((m) => appendTerminalText(m.data, m.stream));
  api.onTerminalExit((m) => {
    terminalRunning = false;
    el.terminalState.textContent = 'Terminal';
    if (Number(m.code) !== 0) el.terminalMeta.textContent = `exit ${m.code}`;
  });
  api.onTerminalClear(() => { el.terminalOut.replaceChildren(); });
  document.addEventListener('pointerdown', (event) => {
    let changed = false;
    if (el.tray.classList.contains('open') && !el.tray.contains(event.target) && !el.stage.contains(event.target)) {
      el.tray.classList.remove('open'); changed = true;
    }
    if (el.settingsPopover.classList.contains('open') && !el.settingsPopover.contains(event.target) && !el.settings.contains(event.target) && !el.shortcutsPopover.contains(event.target) && !el.usageTrackerPanel.contains(event.target)) {
      el.settingsPopover.classList.remove('open'); changed = true;
    }
    if (el.usageTrackerPanel.classList.contains('open') && !el.usageTrackerPanel.contains(event.target) && !el.usageButton.contains(event.target)) {
      el.usageTrackerPanel.classList.remove('open'); changed = true;
    }
    if (!shortcutsPinned && el.shortcutsPopover.classList.contains('open') && !el.shortcutsPopover.contains(event.target) && !el.helpCircle.contains(event.target) && !el.settings.contains(event.target)) {
      el.shortcutsPopover.classList.remove('open'); changed = true;
    }
    if (changed) requestResize();
  });
  window.addEventListener('keydown', (event) => {
    // Ctrl/Cmd+Shift+/ (or ?) — dedicated "close the shortcuts help" key.
    // Handled here too so it works even if the global accelerator is taken.
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === '/' || event.key === '?')) {
      event.preventDefault();
      hideShortcutsHelp({ force: true });
      return;
    }
    if (event.key !== 'Escape') return;
    const changed = el.tray.classList.contains('open') || el.settingsPopover.classList.contains('open') || el.usageTrackerPanel.classList.contains('open') || (!shortcutsPinned && el.shortcutsPopover.classList.contains('open'));
    el.tray.classList.remove('open');
    el.settingsPopover.classList.remove('open');
    el.usageTrackerPanel.classList.remove('open');
    // Esc never kills a PINNED help panel — that is what Ctrl+Shift+/ is for.
    if (!shortcutsPinned) el.shortcutsPopover.classList.remove('open');
    if (changed) requestResize();
  });

  // ---- Recording / transcription state ----
  api.onRecordingState((active) => {
    recording = Boolean(active);
    el.record.classList.toggle('active', recording);
    el.record.setAttribute('aria-pressed', String(recording));
    el.record.setAttribute('aria-label', recording ? 'Stop microphone' : 'Start microphone');
    el.record.title = recording ? 'Stop microphone (Ctrl+Shift+V)' : 'Start microphone (Ctrl+Shift+V)';
    const glyph = el.record.querySelector('.mic-glyph');
    if (glyph) glyph.textContent = recording ? '■' : '🎙';
    el.answerPanel.classList.add('open');
    el.answerState.textContent = recording ? 'MIC ON · Listening…' : 'MIC OFF · Transcribing…';
    if (recording) showTranscriptPlaceholder();
    requestResize();
  });

  // STT result → route to the LLM router
  api.onSttResult((m) => {
    clearTranscriptPlaceholder();
    const text = (m && m.text || '').trim();
    if (!text) {
      el.status.textContent = "Couldn't hear that, try again.";
      return;
    }
    el.status.textContent = `Transcribed via ${m.model || 'Groq Whisper'} (${Math.round(m.latencyMs || 0)}ms)`;
    addMessage('user', text);
    openAnswerPanel();
    el.answerState.textContent = 'Routing…';
    api.askQuestion({ query: text, skill: el.skill.value }).catch((e) => { el.status.textContent = e.message; });
  });

  api.onSttRateLimited((m) => {
    const secs = Math.ceil((Number(m.retryAfterMs) || 60) / 1000);
    el.status.textContent = `🔴 STT paused — rate limit. Resuming in ${secs}s`;
  });

  api.onSttTrackerUpdate((m) => renderSttTracker(m.snapshot));

  // ---- LLM routing events ----
  api.onLlmRouted((r) => {
    currentRaw = '';
    upgradeTarget = null;
    currentRequestId = (r && r.requestId) || '';
    responseStartedAt = performance.now();
    firstChunkSeen = false;
    llmModelBadge = r.model;
    currentAssistant = addMessage('assistant', '');
    currentAssistant.classList.add('streaming');
    openAnswerPanel(); // every routed answer opens the response window
    const tierLabel = r.tier === 1 ? 'Tier 1 (Simple)' : r.tier === 2 ? 'Tier 2 (Moderate)' : 'Tier 3 (Hard)';
    const via = r.method === 'heuristic' ? 'heuristic' : 'LLM classifier';
    const meta = currentAssistant.querySelector('.message-meta');
    if (meta) meta.innerHTML = `${tierLabel} · ${via} · ${modelBadgeHtml(r.model)}`;
    el.answerState.textContent = `Routing: ${tierLabel}…`;
    if (el.lastRoutingDecision) {
      el.lastRoutingDecision.textContent = `Last: ⚡ ${tierLabel} (${via}: ${r.reason || '—'})`;
    }
  });

  // Tier-3 fast path: a fast partner model starts streaming immediately.
  api.onLlmFastStart((f) => {
    if (!f || (f.requestId && f.requestId !== currentRequestId)) return;
    if (!currentAssistant) currentAssistant = addMessage('assistant', '');
    upgradeTarget = currentAssistant;
    const meta = currentAssistant.querySelector('.message-meta');
    if (meta) meta.innerHTML = `⚡ Fast answer · ${modelBadgeHtml(f.model)} <span class="upgrading-badge">⏳ Tier-3 upgrade running…</span>`;
    el.answerState.textContent = '⚡ Fast answer streaming…';
  });

  api.onLlmChunk((chunk) => {
    if (!currentAssistant) currentAssistant = addMessage('assistant', '');
    if (chunk && chunk.done) {
      // Blank answer = failure. Without this the bubble stayed empty and was
      // labelled "Complete", which is what "the AI is not responding" looked
      // like from the outside.
      if (currentAssistant && !String(currentRaw || '').trim() && !chunk.upgradePending) {
        currentAssistant.classList.remove('streaming', 'upgrading');
        messageBody(currentAssistant).innerHTML =
          '<div class="response-error"><strong>No answer returned</strong>'
          + `<span>${escapeHtml(chunk.model || llmModelBadge || 'The model')} sent an empty response. Press Send again, or pick a different model for this tier in Settings.</span></div>`;
        const failMeta = currentAssistant.querySelector('.message-meta');
        if (failMeta) failMeta.textContent = 'Empty response';
        currentAssistant = null;
        upgradeTarget = null;
        el.answerState.textContent = 'Empty response';
        el.status.textContent = 'Model returned no text — try again.';
        scrollToBottom();
        return;
      }
      if (currentAssistant) {
        currentAssistant.dataset.raw = currentRaw;
        messageBody(currentAssistant).innerHTML = renderMarkdown(currentRaw);
        const model = chunk.model || llmModelBadge;
        const meta = currentAssistant.querySelector('.message-meta');
        if (chunk.upgradePending) {
          // Fast answer finished — the Tier-3 default model is still running.
          upgradeTarget = currentAssistant;
          currentAssistant.classList.add('streaming', 'upgrading');
          if (meta) meta.innerHTML = `Fast answer · ${modelBadgeHtml(model)} <span class="upgrading-badge">⏳ Tier-3 refining…</span>`;
          lastAssistantRaw = currentRaw;
          el.answerState.textContent = '⏳ Tier-3 refining answer…';
          el.responseMeta.textContent = `${model} · upgrade pending`;
          return;
        }
        currentAssistant.classList.remove('streaming', 'upgrading');
        if (meta) meta.innerHTML = `Answered ${modelBadgeHtml(model)}`;
      }
      lastAssistantRaw = currentRaw;
      currentAssistant = null;
      el.answerState.textContent = 'Complete';
      const elapsed = responseStartedAt ? ` · ${((performance.now() - responseStartedAt) / 1000).toFixed(1)}s` : '';
      el.responseMeta.textContent = `${chunk.model || llmModelBadge || ''}${elapsed}`;
      scrollToBottom();
      return;
    }
    if (!firstChunkSeen) {
      firstChunkSeen = true;
      el.answerState.textContent = 'Answering…';
      const firstTextSeconds = ((performance.now() - responseStartedAt) / 1000).toFixed(1);
      el.responseMeta.textContent = `${firstTextSeconds}s first text`;
    }
    currentRaw += (chunk && chunk.text) || '';
    renderStreamingAnswer();
  });

  // Tier-3 upgrade complete: replace the fast answer with the better one.
  api.onLlmUpgrade((u) => {
    if (!u || (u.requestId && u.requestId !== currentRequestId)) return;
    if (upgradeTarget && upgradeTarget.isConnected) {
      upgradeTarget.classList.remove('streaming', 'upgrading');
      currentRaw = (u && u.text) || currentRaw;
      upgradeTarget.dataset.raw = currentRaw;
      messageBody(upgradeTarget).innerHTML = renderMarkdown(currentRaw);
      const meta = upgradeTarget.querySelector('.message-meta');
      if (meta) meta.innerHTML = `Answered (Tier-3) · ${modelBadgeHtml((u && u.model) || llmModelBadge)}`;
      lastAssistantRaw = currentRaw;
      upgradeTarget = null;
      currentAssistant = null;
      el.answerState.textContent = 'Complete';
      const elapsed = responseStartedAt ? ` · ${((performance.now() - responseStartedAt) / 1000).toFixed(1)}s` : '';
      el.responseMeta.textContent = `${(u && u.model) || ''}${elapsed}`;
      scrollToBottom();
    }
  });

  api.onLlmUpgradeFailed((m) => {
    if (!m || (m.requestId && m.requestId !== currentRequestId)) return;
    if (upgradeTarget && upgradeTarget.isConnected) {
      upgradeTarget.classList.remove('streaming', 'upgrading');
      const meta = upgradeTarget.querySelector('.message-meta');
      if (meta) meta.innerHTML = `Kept fast answer · ${modelBadgeHtml(llmModelBadge)} <span class="upgrading-badge">Tier-3 upgrade failed</span>`;
      upgradeTarget = null;
      currentAssistant = null;
      el.answerState.textContent = 'Complete';
      el.status.textContent = `Tier-3 upgrade failed — kept the fast answer${m && m.error ? ` (${m.error})` : ''}`;
    }
  });

  // Stop button / Ctrl+Shift+K: mark the partial answer as stopped.
  api.onLlmStopped(() => {
    const target = (upgradeTarget && upgradeTarget.isConnected) ? upgradeTarget : (currentAssistant || null);
    if (target) {
      target.classList.remove('streaming', 'upgrading');
      const meta = target.querySelector('.message-meta');
      if (meta) meta.innerHTML = 'Stopped';
    }
    upgradeTarget = null;
    currentAssistant = null;
    el.answerState.textContent = 'Stopped';
    el.status.textContent = 'AI response stopped.';
  });

  api.onLlmFallback((f) => {
    llmModelBadge = f.toModel;
    appendSetupTerminalText(`\n[FALLBACK] ${f.fromModel} → ${f.toModel}`, 'healing');
    if (currentAssistant) {
      const meta = currentAssistant.querySelector('.message-meta');
      if (meta) meta.innerHTML = `Answered ${modelBadgeHtml(f.toModel)}`;
    }
  });

  api.onLlmTrackerUpdate((m) => renderLlmTracker(m.snapshot, m.classifierCalls));

  api.onLlmError((m) => {
    if (currentAssistant) {
      currentAssistant.classList.remove('streaming');
      messageBody(currentAssistant).innerHTML = `<div class="response-error"><strong>Request failed</strong><span>${escapeHtml(m.error || 'Unknown error')}</span></div>`;
      const meta = currentAssistant.querySelector('.message-meta');
      if (meta) meta.textContent = 'Failed · Check key/network';
    }
    currentAssistant = null;
    el.answerState.textContent = 'Error';
    el.status.textContent = m.error;
  });

  api.onAudioLevel((m) => {
    const meter = m.stream === 'interviewer' ? el.meterInterviewer : el.meterUser;
    if (meter) meter.style.width = `${Math.max(2, Math.min(100, Math.sqrt(Number(m.rms) || 0) * 560))}%`;
  });
  api.onMicTestLevel((m) => { el.meterUser.style.width = `${Math.max(2, Math.min(100, Math.sqrt(Number(m.rms) || 0) * 560))}%`; });
  api.onMicTestResult((m) => {
    el.micTest.disabled = false;
    if (m.transcript) el.micTestText.textContent = `Verified: “${m.transcript.slice(0, 90)}”`;
    else el.micTestText.textContent = m.verify_reason || m.reason || 'No speech was recognized.';
  });

  api.onStatus((m) => { el.status.textContent = m.message || String(m); });
  api.onOpacityChanged((m) => {
    const value = Number(m?.value);
    if (Number.isFinite(value)) el.opacity.value = String(value);
  });
  api.onStagedImagesUpdated(renderTray);
  api.onBootProgress((m) => { el.startupStatus.textContent = `${m.ok ? '✓' : '•'} ${m.name}`; });
  api.onBootLog((m) => {
    const line = document.createElement('div');
    line.textContent = m.message || `${m.stage || 'worker'} ${m.loaded === false ? 'failed' : ''}`;
    el.bootLog.appendChild(line);
    appendSetupTerminalText(`[BOOT] ${m.message || JSON.stringify(m)}`, 'sys');
  });
  api.onHealing((m) => {
    appendSetupTerminalText(`\n[HEALING AGENT] Strategy: ${m.strategy}`, 'healing');
    appendSetupTerminalText(`[HEALING] OK: ${m.ok}`, m.ok ? 'sys' : 'err');
    for (const a of (m.actions || [])) {
      appendSetupTerminalText(`[HEALING] • ${a}`, 'healing');
    }
    if (m.diagnosis) appendSetupTerminalText(`[DIAG] ${m.diagnosis.message}`, 'sys');
  });

  // ---- Usage tracker rendering ----
  function dotClass(remaining, limit) {
    if (limit == null || !Number.isFinite(limit) || limit <= 0) return '';
    const pct = remaining / limit;
    if (pct > 0.5) return 'green';
    if (pct >= 0.1) return 'amber';
    return 'red';
  }

  function renderSttTracker(snapshot) {
    if (!snapshot) return;
    const order = ['whisper-large-v3-turbo', 'whisper-large-v3'];
    const html = order.map((id) => {
      const e = snapshot[id];
      if (!e) return '';
      const r = e.remaining;
      const l = e.limits;
      const dot = dotClass(r.rpm, l.rpm) || 'blue';
      const rpm = l.rpm != null ? `${l.rpm - r.rpm}/${l.rpm}` : '—';
      const rpd = l.rpd != null ? `${l.rpd - r.rpd}/${l.rpd}` : '—';
      const audioHr = l.audioSecPerHr != null ? `${Math.round(r.audioSecHr)}s/${l.audioSecPerHr}s` : '—';
      return `<div class="tracker-row"><span class="dot ${dot}"></span><span class="name">${id}</span><span class="val">RPM ${rpm} · Day ${rpd} · ${audioHr}</span></div>`;
    }).join('');
    const active = snapshot['whisper-large-v3-turbo'] && snapshot['whisper-large-v3']
      ? (snapshot['whisper-large-v3-turbo'].remaining.rpm > 1 ? 'whisper-large-v3-turbo' : 'whisper-large-v3')
      : '—';
    const out = `${html}<div class="tracker-row"><span class="name">Active</span><span class="val">${active}</span></div>`;
    if (el.sttTrackerContent) el.sttTrackerContent.innerHTML = out;
    if (el.sttTrackerSettings) el.sttTrackerSettings.innerHTML = out;
  }

  function renderLlmTracker(snapshot, classifierCalls) {
    if (!snapshot) return;
    // Group models by tier for display.
    const tierModels = [
      { label: 'Tier 1 (Simple)', ids: ['openai/gpt-oss-20b', 'gemini-3.1-flash-lite'] },
      { label: 'Tier 2 (Moderate)', ids: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b'] },
      { label: 'Tier 3 (Hard)', ids: ['gemini-3.7-flash', 'gemini-3.6-flash'] }
    ];
    let html = '';
    for (const tier of tierModels) {
      for (const id of tier.ids) {
        const e = snapshot[id];
        if (!e) continue;
        const r = e.remaining;
        const l = e.limits;
        const dot = dotClass(r.rpm, l.rpm) || (l.rpm == null ? 'blue' : 'red');
        const rpm = l.rpm != null ? `${l.rpm - r.rpm}/${l.rpm}` : '—';
        const rpd = l.rpd != null ? `${l.rpd - r.rpd}/${l.rpd}` : '—';
        const label = id.includes('/') ? id.split('/').pop() : id;
        html += `<div class="tracker-row"><span class="dot ${dot}"></span><span class="name">${label}<span class="tier"> · ${tier.label}</span></span><span class="val">RPM ${rpm} · Day ${rpd}</span></div>`;
      }
    }
    html += `<div class="tracker-row"><span class="dot blue"></span><span class="name">Classifier</span><span class="val">calls: ${classifierCalls || 0} today</span></div>`;
    if (el.llmTrackerContent) el.llmTrackerContent.innerHTML = html;
    if (el.llmTrackerSettings) el.llmTrackerSettings.innerHTML = html;
  }

  window.addEventListener('aashi-capture-status', (event) => {
    if (!event.detail?.ok) {
      const message = `Microphone permission/capture failed: ${event.detail.message}`;
      el.status.textContent = message;
      el.micTestText.textContent = message;
      el.micTest.disabled = false;
    }
  });
  window.addEventListener('aashi-capture-level', (event) => {
    const rms = Number(event.detail?.rms) || 0;
    el.meterUser.style.width = `${Math.max(2, Math.min(100, Math.sqrt(rms) * 560))}%`;
  });

  Promise.all([loadConfig(), api.getStagedImages().then(renderTray)]).then(() => {
    setTimeout(() => {
      el.startupStatus.textContent = 'Running checks — verifying Groq + Gemini…';
      verifyEnvironment().catch((error) => {
        el.startupStatus.textContent = error.message;
        appendSetupTerminalText(`Auto check failed: ${error.message}`, 'err');
      });
    }, 1200);
  }).catch((error) => {
    el.startupStatus.textContent = error.message;
  });
})();
