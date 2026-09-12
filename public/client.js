// ---------------------------------------------------------------------------
// TIER RUSH — cliente
//
// Esse arquivo roda no navegador de cada jogador. Ele:
// 1) mantém uma conexão em tempo real com o servidor (socket.io)
// 2) manda eventos quando você clica em algo ("start_game", "submit_answer"...)
// 3) recebe um evento "state" toda vez que algo muda no jogo, e redesenha a tela
// ---------------------------------------------------------------------------

const TIER_COLORS = { S: 'var(--s)', A: 'var(--a)', B: 'var(--b)', C: 'var(--c)', D: 'var(--d)' };
const TIERS = ['S', 'A', 'B', 'C', 'D'];

function uid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => (b % 36).toString(36)).join('');
}
function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// clientId sobrevive a um F5 (fica salvo no navegador), assim seu placar
// e sua identidade não se perdem se a página recarregar.
let clientId = localStorage.getItem('tierrush_id');
if (!clientId) {
  clientId = uid();
  localStorage.setItem('tierrush_id', clientId);
}

const state = {
  socket: null,
  connected: false,
  joined: false,
  screen: 'landing', // landing | join
  myName: localStorage.getItem('tierrush_name') || '',
  roomCode: '',
  maxRoundsInput: 6,
  draftText: '',
  themeSearch: '',
  error: '',
  loading: false,
  server: null, // last "state" payload from server
};

function connectSocket() {
  state.socket = io();
  state.socket.on('connect', () => { state.connected = true; render(); });
  state.socket.on('disconnect', () => { state.connected = false; render(); });
  state.socket.on('state', (payload) => {
    state.server = payload;
    state.joined = true;
    state.error = '';
    render();
  });
  state.socket.on('join_error', (msg) => {
    state.error = msg;
    state.loading = false;
    render();
  });
}
connectSocket();

// ---------------------------------------------------------------------------
// Countdown — re-renderiza a cada 500ms enquanto há um auto-avanço agendado.
// ---------------------------------------------------------------------------
let _cdInterval = null;

function syncCountdown() {
  const target = state.server?.autoAdvanceAt || null;
  if (target && Date.now() < target) {
    if (!_cdInterval) {
      _cdInterval = setInterval(() => {
        if (!state.server?.autoAdvanceAt || Date.now() >= state.server.autoAdvanceAt) {
          clearInterval(_cdInterval);
          _cdInterval = null;
        }
        render();
      }, 500);
    }
  } else {
    if (_cdInterval) { clearInterval(_cdInterval); _cdInterval = null; }
  }
}

// Banner de contagem regressiva exibido abaixo dos controles.
function renderAutoBanner(label) {
  const target = state.server?.autoAdvanceAt;
  if (!target) return null;
  const remaining = target - Date.now();
  if (remaining <= 0) return null;
  const secs = Math.ceil(remaining / 1000);
  return el(`<div class="auto-banner">${label} <strong>${secs}s</strong>…</div>`);
}

// ---------------- actions ----------------
function createRoom() {
  if (!state.myName.trim()) { state.error = 'Digite seu nome primeiro.'; render(); return; }
  localStorage.setItem('tierrush_name', state.myName.trim());
  state.loading = true; render();
  state.socket.emit('create_room', {
    clientId, name: state.myName.trim(),
    maxRounds: Math.max(2, Math.min(15, Number(state.maxRoundsInput) || 6)),
  });
}
function joinRoom() {
  if (!state.myName.trim()) { state.error = 'Digite seu nome primeiro.'; render(); return; }
  if (!state.roomCode.trim()) { state.error = 'Digite o código da sala.'; render(); return; }
  localStorage.setItem('tierrush_name', state.myName.trim());
  state.loading = true; render();
  state.socket.emit('join_room', {
    clientId, name: state.myName.trim(), code: state.roomCode.trim().toUpperCase(),
  });
}
function leaveRoom() {
  state.joined = false;
  state.server = null;
  state.roomCode = '';
  state.screen = 'landing';
  state.loading = false;  // evita botões travados em "Criando..." / "Entrando..."
  state.error = '';
  if (state.socket) state.socket.disconnect();
  connectSocket();
  render();
}
function isHost() { return state.server && state.server.hostId === clientId; }

function hostStartGame() { state.socket.emit('start_game'); }
function submitAnswer() {
  const text = state.draftText.trim();
  if (!text) return;
  state.socket.emit('submit_answer', { text });
  state.draftText = '';
}
function hostGoToGuessing() { state.socket.emit('go_to_guessing'); }
function submitGuess(tier) { state.socket.emit('submit_guess', { tier }); }
function hostReveal() { state.socket.emit('reveal'); }
function hostNextTurn() { state.socket.emit('next_turn'); }
function hostNextRound() { state.socket.emit('next_round'); }
function hostPlayAgain() { state.socket.emit('play_again'); }
function toggleTheme(theme) { state.socket?.emit('toggle_theme', { theme }); }
function setAllThemes(selectAll) { state.socket?.emit('set_all_themes', { selectAll }); }

// ---------------- render ----------------
function render() {
  const app = document.getElementById('app');
  const wasSearchFocused = document.activeElement && document.activeElement.classList.contains('theme-search-input');
  const searchSelStart = wasSearchFocused ? document.activeElement.selectionStart : null;
  const searchSelEnd = wasSearchFocused ? document.activeElement.selectionEnd : null;

  app.innerHTML = '';
  if (!state.joined || !state.server) {
    const entryWrap = el(`<div class="center-content"></div>`);
    entryWrap.appendChild(renderEntry());
    app.appendChild(entryWrap);
  } else {
    app.appendChild(renderTopbar());
    if (!state.connected) {
      const warnWrap = el(`<div class="center-content"></div>`);
      warnWrap.appendChild(el(`<div class="conn-warning">Conexão perdida — tentando reconectar...</div>`));
      app.appendChild(warnWrap);
    }
    app.appendChild(renderGame());
  }

  if (wasSearchFocused) {
    const searchInp = app.querySelector('.theme-search-input');
    if (searchInp) {
      searchInp.focus();
      if (searchSelStart !== null) {
        try { searchInp.setSelectionRange(searchSelStart, searchSelEnd); } catch (_) {}
      }
    }
  }

  syncCountdown();
}

function renderEntry() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`
    <div class="hero">
      <div class="logo">
        <div class="bits">
          <div class="bit" style="background:var(--s)"></div>
          <div class="bit" style="background:var(--a)"></div>
          <div class="bit" style="background:var(--b)"></div>
          <div class="bit" style="background:var(--c)"></div>
          <div class="bit" style="background:var(--d)"></div>
        </div>
        TIER RUSH
      </div>
      <h1>Todo mundo recebe um tier secreto.<br>Só a escrita denuncia.</h1>
      <p>Você ganha um tier (S, A, B, C ou D) que só você conhece. Escreva algo do tema que combine com ele — os outros tentam adivinhar qual foi. Acertou, ganha ponto. Enganou todo mundo, ganha ainda mais.</p>
      <div class="tier-strip">${TIERS.map((t) => `<span style="background:${TIER_COLORS[t]}">${t}</span>`).join('')}</div>
    </div>
  `));

  const card = el(`<div class="card"></div>`);
  if (state.error) card.appendChild(el(`<div class="error">${escapeHtml(state.error)}</div>`));

  const tabs = el(`
    <div class="tabs">
      <div class="tab ${state.screen !== 'join' ? 'active' : ''}" data-tab="create">Criar sala</div>
      <div class="tab ${state.screen === 'join' ? 'active' : ''}" data-tab="join">Entrar com código</div>
    </div>
  `);
  tabs.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      state.screen = t.dataset.tab === 'join' ? 'join' : 'landing';
      state.error = '';
      render();
    });
  });
  card.appendChild(tabs);

  const nameField = el(`<div class="field"><label>Seu nome</label><input type="text" id="nameInput" placeholder="Como te chamam?" maxlength="18" /></div>`);
  nameField.querySelector('input').value = state.myName;
  nameField.querySelector('input').addEventListener('input', (e) => { state.myName = e.target.value; });
  card.appendChild(nameField);

  if (state.screen === 'join') {
    const codeField = el(`<div class="field"><label>Código da sala</label><input type="text" id="codeInput" placeholder="EX: PXKQ" maxlength="4" style="text-transform:uppercase; letter-spacing:0.15em;" /></div>`);
    codeField.querySelector('input').value = state.roomCode;
    codeField.querySelector('input').addEventListener('input', (e) => { state.roomCode = e.target.value.toUpperCase(); });
    card.appendChild(codeField);

    const btn = el(`<button class="btn btn-brand btn-block">${state.loading ? 'Entrando...' : 'Entrar na sala'}</button>`);
    btn.disabled = state.loading;
    btn.addEventListener('click', joinRoom);
    card.appendChild(btn);
  } else {
    const roundsField = el(`<div class="field"><label>Quantas rodadas?</label><input type="number" id="roundsInput" min="2" max="15" /></div>`);
    roundsField.querySelector('input').value = state.maxRoundsInput;
    roundsField.querySelector('input').addEventListener('input', (e) => { state.maxRoundsInput = e.target.value; });
    card.appendChild(roundsField);

    const btn = el(`<button class="btn btn-brand btn-block">${state.loading ? 'Criando...' : 'Criar sala e chamar a galera'}</button>`);
    btn.disabled = state.loading;
    btn.addEventListener('click', createRoom);
    card.appendChild(btn);
  }

  wrap.appendChild(card);
  return wrap;
}

function renderTopbar() {
  const bar = el(`
    <div class="topbar">
      <div class="logo">
        <div class="bits">
          <div class="bit" style="background:var(--s)"></div>
          <div class="bit" style="background:var(--a)"></div>
          <div class="bit" style="background:var(--b)"></div>
        </div>
        TIER RUSH
      </div>
      <div class="roomchip">Sala <span class="code">${state.server.code}</span><button id="leaveBtn">sair</button></div>
    </div>
  `);
  bar.querySelector('#leaveBtn').addEventListener('click', leaveRoom);
  return bar;
}

function renderSidebar() {
  const card = el(`
    <aside class="game-sidebar card">
      <div class="sidebar-header">
        <div class="eyebrow">Placar</div>
        <div class="sidebar-code">Sala <strong>${escapeHtml(state.server.code)}</strong></div>
      </div>
      <ul class="sidebar-player-list"></ul>
    </aside>
  `);
  const list = card.querySelector('.sidebar-player-list');
  playersSorted().forEach((p, i) => {
    const isYou = p.id === clientId;
    const isHost = p.id === state.server.hostId;
    list.appendChild(el(`
      <li class="sidebar-player-item ${isYou ? 'is-you' : ''}">
        <div class="sidebar-rank">${i + 1}</div>
        <div class="avatar">${initials(p.name)}</div>
        <div class="sidebar-player-info">
          <div class="sidebar-name" title="${escapeHtml(p.name)}">
            ${escapeHtml(p.name)}
            ${isYou ? '<span class="tag-you">(você)</span>' : ''}
            ${!p.connected ? '<span class="tag-off">off</span>' : ''}
          </div>
          ${isHost ? '<span class="tag-host">host</span>' : ''}
        </div>
        <div class="sidebar-score">${p.score || 0}</div>
      </li>
    `));
  });
  return card;
}

function renderGame() {
  const s = state.server;
  let mainContent;
  switch (s.phase) {
    case 'lobby': mainContent = renderLobby(); break;
    case 'writing': mainContent = renderWriting(); break;
    case 'guessing': mainContent = renderGuessing(); break;
    case 'reveal': mainContent = renderReveal(); break;
    case 'scoreboard': mainContent = renderScoreboard(); break;
    case 'end': mainContent = renderEnd(); break;
    default: mainContent = el(`<div class="card">Fase desconhecida.</div>`); break;
  }

  // Se for durante o jogo (writing, guessing, reveal), exibe sidebar à esquerda
  const showSidebar = ['writing', 'guessing', 'reveal'].includes(s.phase);
  if (showSidebar) {
    const layout = el(`<div class="game-layout"></div>`);
    layout.appendChild(renderSidebar());
    const mainWrap = el(`<main class="game-main"></main>`);
    mainWrap.appendChild(mainContent);
    layout.appendChild(mainWrap);
    // Espaçador à direita com a mesma largura da sidebar para manter o centro exato
    layout.appendChild(el(`<div class="game-layout-spacer" aria-hidden="true"></div>`));
    return layout;
  }

  const centerWrap = el(`<div class="center-content"></div>`);
  centerWrap.appendChild(mainContent);
  return centerWrap;
}

function playersSorted() {
  return state.server.players.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
}

function renderThemeSelector() {
  const s = state.server;
  const all = s.allThemes || [];
  const activeSet = new Set(s.activeThemes || []);
  const activeCount = activeSet.size;
  const totalCount = all.length;

  const card = el(`
    <div class="card theme-selector-card">
      <div class="theme-selector-header">
        <div class="theme-header-text">
          <div class="eyebrow">Configuração da Sala</div>
          <h3 class="theme-selector-title">Temas da Partida</h3>
          <p class="theme-selector-desc">Todos os jogadores podem clicar para ativar ou desativar temas em tempo real.</p>
        </div>
        <div class="theme-count-badge ${activeCount === 0 ? 'badge-empty' : ''}">
          <span class="count-num">${activeCount}</span> de ${totalCount} ativos
        </div>
      </div>

      <div class="theme-controls">
        <div class="theme-search-box">
          <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input type="text" class="theme-search-input" placeholder="Filtrar temas..." value="${escapeHtml(state.themeSearch)}" />
          ${state.themeSearch ? '<button type="button" class="clear-search-btn" title="Limpar busca">×</button>' : ''}
        </div>
        <div class="theme-actions">
          <button type="button" class="btn-theme-action" id="selectAllThemesBtn">Marcar todos</button>
          <button type="button" class="btn-theme-action" id="deselectAllThemesBtn">Desmarcar todos</button>
        </div>
      </div>

      ${activeCount === 0 ? '<div class="theme-warning-banner">⚠️ Nenhum tema selecionado! Pelo menos 1 tema deve estar ativo para iniciar o jogo.</div>' : ''}

      <div class="theme-grid"></div>
    </div>
  `);

  const searchInput = card.querySelector('.theme-search-input');
  searchInput.addEventListener('input', (e) => {
    state.themeSearch = e.target.value;
    render();
  });

  const clearBtn = card.querySelector('.clear-search-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.themeSearch = '';
      render();
    });
  }

  card.querySelector('#selectAllThemesBtn').addEventListener('click', () => setAllThemes(true));
  card.querySelector('#deselectAllThemesBtn').addEventListener('click', () => setAllThemes(false));

  const grid = card.querySelector('.theme-grid');
  const term = state.themeSearch.trim().toLowerCase();
  const filtered = all.filter((t) => !term || t.toLowerCase().includes(term));

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="theme-empty-search">Nenhum tema encontrado com "<strong>${escapeHtml(state.themeSearch)}</strong>"</div>`;
  } else {
    filtered.forEach((t) => {
      const isActive = activeSet.has(t);
      const item = el(`
        <button type="button" class="theme-chip ${isActive ? 'is-active' : 'is-inactive'}" title="${isActive ? 'Clique para desativar' : 'Clique para ativar'}">
          <span class="theme-check-icon">${isActive ? '✓' : ''}</span>
          <span class="theme-chip-label">${escapeHtml(t)}</span>
        </button>
      `);
      item.addEventListener('click', () => toggleTheme(t));
      grid.appendChild(item);
    });
  }

  return card;
}

function renderLobby() {
  const s = state.server;
  const wrap = el(`<div></div>`);
  const card = el(`
    <div class="card">
      <div class="eyebrow">Sala de espera</div>
      <h2 style="font-size:22px; margin-bottom:14px;">Chame a galera com o código <strong style="color:var(--brand)">${s.code}</strong></h2>
      <ul class="player-list" id="pList"></ul>
    </div>
  `);
  const list = card.querySelector('#pList');
  playersSorted().forEach((p) => {
    list.appendChild(el(`
      <li>
        <div class="player-name">
          <div class="avatar">${initials(p.name)}</div>
          <span>${escapeHtml(p.name)}</span>
          ${p.id === clientId ? '<span class="tag-you">(você)</span>' : ''}
          ${!p.connected ? '<span class="tag-off">offline</span>' : ''}
        </div>
        ${p.id === s.hostId ? '<span class="tag-host">anfitrião</span>' : ''}
      </li>
    `));
  });
  wrap.appendChild(card);

  wrap.appendChild(renderThemeSelector());

  if (isHost()) {
    const count = s.players.length;
    const activeThemesCount = (s.activeThemes || []).length;
    const canStart = count >= 2 && activeThemesCount > 0;
    let hintText = `${s.maxRounds} rodadas configuradas. Precisa de pelo menos 2 jogadores.`;
    if (activeThemesCount === 0) {
      hintText = `Selecione pelo menos 1 tema ativo para iniciar a partida.`;
    } else if (count < 2) {
      hintText = `Aguardando mais jogadores (mínimo 2). ${activeThemesCount} tema(s) selecionado(s).`;
    }
    const host = el(`
      <div class="card">
        <span class="host-tag">Painel do anfitrião</span>
        <p class="small">${hintText}</p>
        <button class="btn btn-brand btn-block" ${!canStart ? 'disabled' : ''} id="startBtn">Iniciar jogo</button>
      </div>
    `);
    host.querySelector('#startBtn').addEventListener('click', hostStartGame);
    wrap.appendChild(host);
  } else {
    wrap.appendChild(el(`<div class="card center small">Esperando o anfitrião iniciar a partida...</div>`));
  }
  return wrap;
}

function renderWriting() {
  const s = state.server;
  const wrap = el(`<div></div>`);
  const banner = el(`
    <div class="card">
      <div class="theme-banner">
        <div>
          <div class="round">Rodada ${s.round} de ${s.maxRounds}</div>
          <div class="theme-title">${escapeHtml(s.theme)}</div>
        </div>
      </div>
      <div class="tier-card" style="background:${TIER_COLORS[s.myTier] || '#333'}">
        <div class="label">Seu tier secreto</div>
        <div class="big">${s.myTier || '?'}</div>
      </div>
    </div>
  `);
  wrap.appendChild(banner);

  const writeCard = el(`<div class="card"></div>`);
  if (s.mySubmitted) {
    writeCard.appendChild(el(`<div class="status-line">Resposta enviada. Esperando os outros escreverem a deles...</div>`));
  } else {
    writeCard.appendChild(el(`
      <div>
        <label>Escreva algo de "${escapeHtml(s.theme)}" que combine com o tier ${s.myTier || ''}</label>
        <div class="field"><textarea id="answerInput" placeholder="Ex: Calabresa" maxlength="60"></textarea></div>
      </div>
    `));
    const input = writeCard.querySelector('#answerInput');
    input.value = state.draftText;
    input.addEventListener('input', (e) => { state.draftText = e.target.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAnswer(); } });
    const btn = el(`<button class="btn btn-brand btn-block">Enviar resposta</button>`);
    btn.addEventListener('click', submitAnswer);
    writeCard.appendChild(btn);
  }
  wrap.appendChild(writeCard);

  const total = s.players.length;
  const done = s.submittedCount || 0;
  const progressCard = el(`
    <div class="card">
      <div class="small">${done} de ${total} jogadores já enviaram</div>
      <div class="progress"><div style="width:${total ? Math.round((done / total) * 100) : 0}%"></div></div>
    </div>
  `);
  const writingBanner = renderAutoBanner('Indo para os palpites em');
  if (writingBanner) progressCard.appendChild(writingBanner);
  wrap.appendChild(progressCard);

  if (isHost()) {
    const host = el(`
      <div class="card">
        <span class="host-tag">Painel do anfitrião</span>
        <button class="btn btn-brand btn-block" id="goGuess">Ir para os palpites agora (${done}/${total})</button>
        <div class="copy-hint">Pode avançar mesmo sem todo mundo — quem não enviou fica de fora dessa rodada de palpites.</div>
      </div>
    `);
    host.querySelector('#goGuess').addEventListener('click', hostGoToGuessing);
    wrap.appendChild(host);
  }
  return wrap;
}

function renderGuessing() {
  const s = state.server;
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`
    <div class="card">
      <div class="round">Rodada ${s.round} · Palpite ${s.turnIndex + 1} de ${s.totalTurns}</div>
      <div class="theme-title" style="margin-bottom:14px;">${escapeHtml(s.theme)}</div>
      <div class="submission-box"><strong>${escapeHtml(s.currentSubmitterName)}</strong>&nbsp;escreveu:&nbsp;"${escapeHtml(s.currentSubmissionText)}"</div>
    </div>
  `));

  const actionCard = el(`<div class="card"></div>`);
  if (s.isCurrentSubmitter) {
    actionCard.appendChild(el(`
      <div>
        <div class="status-line">É a vez de todo mundo tentar adivinhar o SEU tier. Só espera!</div>
        <div class="small mt">${s.guessCount} de ${s.guessTotal} já palpitaram</div>
        <div class="progress"><div style="width:${s.guessTotal ? Math.round((s.guessCount / s.guessTotal) * 100) : 0}%"></div></div>
      </div>
    `));
  } else if (s.myGuess) {
    actionCard.appendChild(el(`
      <div>
        <div class="status-line">Palpite enviado: <strong style="color:${TIER_COLORS[s.myGuess]}">${s.myGuess}</strong>. Esperando os outros...</div>
        <div class="small mt">${s.guessCount} de ${s.guessTotal} já palpitaram</div>
        <div class="progress"><div style="width:${s.guessTotal ? Math.round((s.guessCount / s.guessTotal) * 100) : 0}%"></div></div>
      </div>
    `));
  } else {
    actionCard.appendChild(el(`<label>Em qual tier ${escapeHtml(s.currentSubmitterName)} caiu?</label>`));
    const btnRow = el(`<div class="tier-btns"></div>`);
    TIERS.forEach((t) => {
      const b = el(`<button class="tier-btn" style="background:${TIER_COLORS[t]}">${t}</button>`);
      b.addEventListener('click', () => submitGuess(t));
      btnRow.appendChild(b);
    });
    actionCard.appendChild(btnRow);
  }
  wrap.appendChild(actionCard);

  // Banner de countdown (visível a todos)
  const guessBanner = renderAutoBanner('Revelando tier em');
  if (guessBanner) wrap.appendChild(guessBanner);

  if (isHost()) {
    const host = el(`
      <div class="card">
        <span class="host-tag">Painel do anfitrião</span>
        <button class="btn btn-brand btn-block" id="revealBtn">Revelar tier agora (${s.guessCount}/${s.guessTotal} palpitaram)</button>
      </div>
    `);
    host.querySelector('#revealBtn').addEventListener('click', hostReveal);
    wrap.appendChild(host);
  }
  return wrap;
}

function renderReveal() {
  const s = state.server;
  const rev = s.lastReveal;
  const wrap = el(`<div></div>`);
  if (!rev) return el(`<div class="card">Carregando revelação...</div>`);

  const card = el(`
    <div class="card">
      <div class="round">Rodada ${s.round} · Revelação</div>
      <div class="submission-box">"${escapeHtml(s.currentSubmissionText)}"</div>
      <div class="tier-card" style="background:${TIER_COLORS[rev.actualTier]}">
        <div class="label">${escapeHtml(rev.submitterName)} recebeu o tier</div>
        <div class="big">${rev.actualTier}</div>
      </div>
      <div class="small">+${rev.submitterGain} ponto(s) para ${escapeHtml(rev.submitterName)}</div>
      <div class="divider"></div>
    </div>
  `);
  const guessList = el(`<div></div>`);
  rev.results.forEach((r) => {
    guessList.appendChild(el(`
      <div class="guess-row">
        <span>${escapeHtml(r.name)}</span>
        <span class="pill" style="background:${TIER_COLORS[r.guess]}">${r.guess}</span>
        <span class="${r.correct ? 'result-ok' : 'result-bad'}">${r.correct ? 'acertou +1' : 'errou'}</span>
      </div>
    `));
  });
  card.appendChild(guessList);
  wrap.appendChild(card);

  const isLast = s.turnIndex + 1 >= s.totalTurns;
  const revealBannerLabel = isLast ? 'Vendo placar em' : 'Próximo palpite em';
  const revealBanner = renderAutoBanner(revealBannerLabel);
  if (revealBanner) wrap.appendChild(revealBanner);

  if (isHost()) {
    const host = el(`
      <div class="card">
        <span class="host-tag">Painel do anfitrião</span>
        <button class="btn btn-brand btn-block" id="nextBtn">${isLast ? 'Ver placar agora' : 'Próximo palpite agora'}</button>
      </div>
    `);
    host.querySelector('#nextBtn').addEventListener('click', hostNextTurn);
    wrap.appendChild(host);
  } else {
    wrap.appendChild(el(`<div class="card center small">Avançando automaticamente...</div>`));
  }
  return wrap;
}

function renderScoreboard() {
  const s = state.server;
  const wrap = el(`<div></div>`);
  const card = el(`<div class="card"><div class="eyebrow">Placar · fim da rodada ${s.round}</div><ul class="rank-list" id="rankList"></ul></div>`);
  const list = card.querySelector('#rankList');
  playersSorted().forEach((p, i) => {
    list.appendChild(el(`
      <li class="rank-item ${i === 0 ? 'top1' : ''}">
        <div class="rank-num">${i + 1}</div>
        <div class="avatar">${initials(p.name)}</div>
        <div class="name">${escapeHtml(p.name)} ${p.id === clientId ? '<span class="tag-you">(você)</span>' : ''}</div>
        <div class="score">${p.score || 0}</div>
      </li>
    `));
  });
  wrap.appendChild(card);

  const isLastRound = s.round >= s.maxRounds;
  const scoreBannerLabel = isLastRound ? 'Resultado final em' : 'Próxima rodada em';
  const scoreBanner = renderAutoBanner(scoreBannerLabel);
  if (scoreBanner) wrap.appendChild(scoreBanner);

  if (isHost()) {
    const host = el(`
      <div class="card">
        <span class="host-tag">Painel do anfitrião</span>
        <button class="btn btn-brand btn-block" id="nextRoundBtn">${isLastRound ? 'Ver resultado final agora' : 'Próxima rodada agora'}</button>
      </div>
    `);
    host.querySelector('#nextRoundBtn').addEventListener('click', hostNextRound);
    wrap.appendChild(host);
  } else {
    wrap.appendChild(el(`<div class="card center small">Avançando automaticamente...</div>`));
  }
  return wrap;
}

function renderEnd() {
  const s = state.server;
  const ranked = playersSorted();
  const winner = ranked[0];
  const wrap = el(`<div></div>`);
  const card = el(`
    <div class="card center">
      <div class="trophy">🏆</div>
      <div class="eyebrow">Fim de jogo</div>
      <h2 style="font-size:24px;">${winner ? escapeHtml(winner.name) + ' venceu!' : 'Jogo encerrado'}</h2>
      <ul class="rank-list" id="rankList" style="text-align:left; margin-top:18px;"></ul>
    </div>
  `);
  const list = card.querySelector('#rankList');
  ranked.forEach((p, i) => {
    list.appendChild(el(`
      <li class="rank-item ${i === 0 ? 'top1' : ''}">
        <div class="rank-num">${i + 1}</div>
        <div class="avatar">${initials(p.name)}</div>
        <div class="name">${escapeHtml(p.name)} ${p.id === clientId ? '<span class="tag-you">(você)</span>' : ''}</div>
        <div class="score">${p.score || 0}</div>
      </li>
    `));
  });
  wrap.appendChild(card);

  wrap.appendChild(renderThemeSelector());

  if (isHost()) {
    const host = el(`
      <div class="card">
        <span class="host-tag">Painel do anfitrião</span>
        <button class="btn btn-brand btn-block" id="againBtn">Jogar de novo (mesma sala)</button>
      </div>
    `);
    host.querySelector('#againBtn').addEventListener('click', hostPlayAgain);
    wrap.appendChild(host);
  } else {
    wrap.appendChild(el(`<div class="card center small">Esperando o anfitrião reiniciar a partida...</div>`));
  }
  return wrap;
}

render();
