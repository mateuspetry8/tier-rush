// ---------------------------------------------------------------------------
// TIER RUSH — servidor
//
// Isso aqui é o "backend": um programa que fica rodando na sua máquina,
// guarda o estado de cada sala na memória, e conversa com cada jogador em
// tempo real usando WebSockets (biblioteca socket.io). Cada evento que o
// navegador manda (ex: "quero criar uma sala", "essa é minha resposta")
// chega aqui, o servidor atualiza o estado do jogo, e manda de volta pra
// cada jogador só a parte do estado que ele tem permissão de ver (por
// exemplo, ninguém recebe o tier secreto dos outros).
// ---------------------------------------------------------------------------

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const TIERS = ['S', 'A', 'B', 'C', 'D'];
const THEMES = [
  'Sabores de pizza', 'Animes', 'Frutas', 'Jogos de videogame',
  'Personagens', 'Mapas', 'Doces',
  'Salgados de festa', 'Musicas', 'Séries e Filmes', 'Pokemons',
  'Refrigerantes', 'Super-heróis', 'Poderes', 'Morte dos animes',
  'Emojis', 'Tipos de pokemon (pode ser 2)', 'Desenhos',
  'Trilhas sonoras de jogos', 'Instrumentos musicais',
  'Bosses de Hollow knight', 'Modos de Rocket League', 'Aliens do Ben 10',
  'Luta dos animes', 'Lugares dos animes'
];

// Todas as salas ativas vivem aqui, na memória do processo. Se você reiniciar
// o servidor, as salas somem — é assim mesmo para um jogo casual como este.
const rooms = {}; // code -> room object

function randomTier() {
  return TIERS[Math.floor(Math.random() * TIERS.length)];
}

function pickTheme(room) {
  const active = (room.activeThemes && room.activeThemes.length > 0) ? room.activeThemes : THEMES;
  const avail = active.filter((t) => !room.usedThemes.includes(t));
  const pool = avail.length ? avail : active;
  return pool[Math.floor(Math.random() * pool.length)];
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms[code]);
  return code;
}

function newRoom(code, hostId) {
  return {
    code,
    hostId,
    mode: 'guess_tier', // 'guess_tier' | 'guess_creator'
    players: {}, // id -> {name, score, connected, socketId}
    phase: 'lobby', // lobby | writing | making_tier_lists | guessing | guessing_all | reveal | scoreboard | end
    round: 0,
    maxRounds: 6,
    theme: '',
    usedThemes: [],
    activeThemes: [...THEMES],
    tiers: {}, // id -> tier, only for current round
    submissions: {}, // id -> text, only for current round
    tierLists: {}, // id -> { [itemId]: tier } (guess_creator mode)
    order: [], // ids in guessing order for current round
    turnIndex: 0,
    guesses: {}, // submitterId -> { guesserId: tier/playerId }
    lastReveal: null,
    autoTimer: null,      // setTimeout handle para avanço automático
    autoAdvanceAt: null,  // epoch ms de quando o auto-avanço dispara (enviado ao cliente)
  };
}

function playerList(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, score: p.score, connected: p.connected,
  }));
}

function connectedCount(room) {
  return Object.values(room.players).filter((p) => p.connected).length;
}

// Constrói o que UM jogador específico tem permissão de ver. Isso é o que
// impede trapaça: o servidor nunca manda o tier ou a resposta de quem ainda
// não deve ser revelado.
function buildView(room, forId) {
  const base = {
    code: room.code,
    mode: room.mode,
    phase: room.phase,
    round: room.round,
    maxRounds: room.maxRounds,
    theme: room.theme,
    hostId: room.hostId,
    you: forId,
    players: playerList(room),
    autoAdvanceAt: room.autoAdvanceAt || null,
    allThemes: THEMES,
    activeThemes: room.activeThemes || [...THEMES],
  };

  if (room.phase === 'writing') {
    if (room.mode === 'guess_tier') {
      base.myTier = room.tiers[forId] || null;
    }
    base.mySubmitted = !!room.submissions[forId];
    base.submittedCount = Object.keys(room.submissions).length;
  }

  if (room.phase === 'making_tier_lists') {
    // Envia todas as submissões, mas sem o nome do autor
    base.allSubmissions = Object.entries(room.submissions).map(([id, text]) => ({ id, text }));
    base.myTierListSubmitted = !!room.tierLists[forId];
    base.tierListsSubmittedCount = Object.keys(room.tierLists).length;
  }

  if (room.phase === 'guessing' || room.phase === 'reveal') {
    const submitterId = room.order[room.turnIndex];
    const submitterName = room.players[submitterId]?.name || '???';
    const guessMap = room.guesses[submitterId] || {};
    base.turnIndex = room.turnIndex;
    base.totalTurns = room.order.length;
    base.currentSubmitterId = submitterId;
    base.currentSubmitterName = submitterName;
    base.isCurrentSubmitter = submitterId === forId;

    if (room.mode === 'guess_tier') {
      base.currentSubmissionText = room.submissions[submitterId] || '';
    } else {
      base.currentTierList = room.tierLists[submitterId] || {};
      base.allSubmissions = Object.entries(room.submissions).map(([id, text]) => ({ id, text }));
    }

    base.guessCount = Object.keys(guessMap).length;
    base.guessTotal = Math.max(0, playerList(room).length - 1);
    base.myGuess = guessMap[forId] || null;
  }

  if (room.phase === 'reveal' && room.lastReveal) {
    base.lastReveal = room.lastReveal;
  }

  // Fase de adivinhação coletiva (guess_creator): todos votam em todas as tier lists
  // antes de qualquer revelação, para evitar processo de eliminação.
  if (room.phase === 'guessing_all') {
    // Envia as tier lists indexadas sem revelar o autor
    base.allTierListsForGuessing = room.order.map((submitterId, idx) => ({
      index: idx,
      tierList: room.tierLists[submitterId] || {},
    }));
    base.allSubmissions = Object.entries(room.submissions).map(([id, text]) => ({ id, text }));
    base.ownTierListIndex = room.order.indexOf(forId);

    // Meus votos até agora: { índice -> playerId votado }
    const myVotes = {};
    room.order.forEach((submitterId, idx) => {
      const v = room.guesses[submitterId]?.[forId];
      if (v !== undefined) myVotes[idx] = v;
    });
    base.myVotes = myVotes;
    base.tierListsToVote = room.order.filter((id) => id !== forId).length;

    // Progresso geral: quantos jogadores já votaram em tudo
    const connectedEntries = Object.entries(room.players).filter(([, p]) => p.connected);
    const finishedCount = connectedEntries.filter(([pid]) =>
      room.order.every((sid) => sid === pid || room.guesses[sid]?.[pid] !== undefined)
    ).length;
    base.guessingAllFinishedCount = finishedCount;
    base.guessingAllTotal = connectedEntries.length;
  }

  return base;
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  Object.entries(room.players).forEach(([id, p]) => {
    if (p.socketId) {
      io.to(p.socketId).emit('state', buildView(room, id));
    }
  });
}

function assignTiersForRound(room) {
  const tierData = {};
  if (room.mode === 'guess_tier') {
    Object.keys(room.players).forEach((pid) => { tierData[pid] = randomTier(); });
  }
  room.tiers = tierData;
  room.submissions = {};
  room.tierLists = {};
  room.guesses = {};
}

// ---------------------------------------------------------------------------
// Auto-avanço — agenda transições automáticas, anfitrião ainda pode
// adiantar manualmente a qualquer momento (cancela o timer pendente).
// ---------------------------------------------------------------------------

function clearRoomTimer(room) {
  if (room.autoTimer) {
    clearTimeout(room.autoTimer);
    room.autoTimer = null;
  }
  room.autoAdvanceAt = null;
}

// Agenda um avanço automático e avisa os clientes via broadcastRoom
// para que eles exibam o countdown.
function scheduleAuto(room, delayMs, fn) {
  clearRoomTimer(room);
  room.autoAdvanceAt = Date.now() + delayMs;
  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;
    room.autoAdvanceAt = null;
    fn();
  }, delayMs);
  broadcastRoom(room.code);
}

// ---- Transições compartilhadas (clique do anfitrião ou auto-avanço) ----

function doGoToTierMaking(room) {
  if (room.phase !== 'writing') return;
  clearRoomTimer(room);
  room.phase = 'making_tier_lists';
  room.tierLists = {};
  broadcastRoom(room.code);
}

function doGoToGuessingFromTierMaking(room) {
  if (room.phase !== 'making_tier_lists') return;
  clearRoomTimer(room);
  room.order = shuffle(Object.keys(room.tierLists));
  room.turnIndex = 0;
  room.guesses = {};
  room.lastReveal = null;
  // No modo guess_creator todos votam em tudo de uma vez antes de qualquer revelação
  room.phase = 'guessing_all';
  broadcastRoom(room.code);
}

function doGoToGuessing(room) {
  if (room.phase !== 'writing') return;
  clearRoomTimer(room);
  room.order = shuffle(Object.keys(room.submissions));
  room.turnIndex = 0;
  room.guesses = {};
  room.lastReveal = null;
  room.phase = 'guessing';
  broadcastRoom(room.code);
}

// Calcula e aplica os resultados de revelação para o turnIndex atual,
// atualiza pontuações e seta room.lastReveal. Não altera room.phase.
function computeRevealForTurn(room) {
  const submitterId = room.order[room.turnIndex];
  const guessMap = room.guesses[submitterId] || {};
  const results = [];
  let submitterGain = 0;

  if (room.mode === 'guess_tier') {
    const actualTier = room.tiers[submitterId];
    Object.entries(guessMap).forEach(([guesserId, guess]) => {
      const correct = guess === actualTier;
      if (correct) {
        room.players[guesserId].score += 1;
        submitterGain += 1;
      }
      results.push({ guesserId, name: room.players[guesserId]?.name || '???', guess, correct });
    });
    if (submitterGain > 0) room.players[submitterId].score += submitterGain;
    room.lastReveal = {
      submitterId,
      submitterName: room.players[submitterId]?.name || '???',
      actualTier,
      submitterGain,
      results,
    };
  } else {
    // guess_creator mode
    const actualCreator = submitterId;
    Object.entries(guessMap).forEach(([guesserId, guess]) => {
      const correct = guess === actualCreator;
      if (correct) {
        room.players[guesserId].score += 1;
      }
      const guessedName = room.players[guess]?.name || '???';
      results.push({ guesserId, name: room.players[guesserId]?.name || '???', guess: guessedName, correct });
    });
    // O criador da tier list não ganha pontos
    room.lastReveal = {
      submitterId,
      submitterName: room.players[submitterId]?.name || '???',
      actualTier: null,
      submitterGain: 0,
      results,
    };
  }
}

// Inicia a fase de revelação.
// Para guess_tier: chamado a partir de 'guessing' (um turno por vez).
// Para guess_creator: chamado a partir de 'guessing_all' (todos os votos já coletados).
function doReveal(room) {
  if (room.phase !== 'guessing' && room.phase !== 'guessing_all') return;
  clearRoomTimer(room);
  computeRevealForTurn(room);
  room.phase = 'reveal';
  // Após a revelação avança automaticamente em 10s
  scheduleAuto(room, 10000, () => doNextTurn(room));
}

function doNextTurn(room) {
  if (room.phase !== 'reveal') return;
  clearRoomTimer(room);
  const nextIndex = room.turnIndex + 1;
  room.lastReveal = null;
  if (nextIndex >= room.order.length) {
    room.phase = 'scoreboard';
    broadcastRoom(room.code);
    // Placar fica 5s antes de ir para próxima rodada
    scheduleAuto(room, 5000, () => doNextRound(room));
  } else {
    room.turnIndex = nextIndex;
    if (room.mode === 'guess_creator') {
      // Todos os votos já foram coletados na fase guessing_all;
      // basta calcular e exibir o próximo reveal sem voltar para guessing.
      computeRevealForTurn(room);
      // phase permanece 'reveal'; scheduleAuto faz o broadcastRoom
      scheduleAuto(room, 10000, () => doNextTurn(room));
    } else {
      room.phase = 'guessing';
      broadcastRoom(room.code);
    }
  }
}

function doNextRound(room) {
  if (room.phase !== 'scoreboard') return;
  clearRoomTimer(room);
  const nextRound = room.round + 1;
  if (nextRound > room.maxRounds) {
    room.phase = 'end';
    broadcastRoom(room.code);
    return;
  }
  room.round = nextRound;
  room.theme = pickTheme(room);
  room.usedThemes.push(room.theme);
  assignTiersForRound(room);
  room.order = [];
  room.turnIndex = 0;
  room.lastReveal = null;
  room.phase = 'writing';
  broadcastRoom(room.code);
}

// ---- Verificações de condição para auto-avanço ----
// Retorna true se agendou um timer (já chamou broadcastRoom via scheduleAuto).

function tryAutoWriting(room) {
  if (room.phase !== 'writing' || room.autoTimer) return false;
  const submitted = Object.keys(room.submissions).length;
  const connected = connectedCount(room);
  if (connected >= 1 && submitted >= connected) {
    if (room.mode === 'guess_tier') {
      scheduleAuto(room, 2000, () => doGoToGuessing(room));
    } else {
      scheduleAuto(room, 2000, () => doGoToTierMaking(room));
    }
    return true;
  }
  return false;
}

function tryAutoTierMaking(room) {
  if (room.phase !== 'making_tier_lists' || room.autoTimer) return false;
  const submitted = Object.keys(room.tierLists).length;
  const connected = connectedCount(room);
  if (connected >= 1 && submitted >= connected) {
    scheduleAuto(room, 2000, () => doGoToGuessingFromTierMaking(room));
    return true;
  }
  return false;
}

function tryAutoGuessing(room) {
  if (room.phase !== 'guessing' || room.autoTimer) return false;
  const submitterId = room.order[room.turnIndex];
  const guessMap = room.guesses[submitterId] || {};
  // Jogadores conectados que não são o autor da submissão atual
  const connectedNonSubmitters = Object.values(room.players)
    .filter((p) => p.connected)
    .length - (room.players[submitterId]?.connected ? 1 : 0);
  if (connectedNonSubmitters >= 1 && Object.keys(guessMap).length >= connectedNonSubmitters) {
    scheduleAuto(room, 2000, () => doReveal(room));
    return true;
  }
  return false;
}

// Verifica se todos os jogadores conectados já votaram em todas as tier lists
// na fase guessing_all (modo guess_creator). Avança para revelação se sim.
function tryAutoGuessingAll(room) {
  if (room.phase !== 'guessing_all' || room.autoTimer) return false;
  const connectedEntries = Object.entries(room.players).filter(([, p]) => p.connected);
  if (connectedEntries.length < 1) return false;
  const allDone = connectedEntries.every(([pid]) =>
    room.order.every((sid) => sid === pid || room.guesses[sid]?.[pid] !== undefined)
  );
  if (allDone) {
    scheduleAuto(room, 2000, () => doReveal(room));
    return true;
  }
  return false;
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ clientId, name, maxRounds }) => {
    const code = makeRoomCode();
    const room = newRoom(code, clientId);
    room.maxRounds = Math.max(2, Math.min(15, Number(maxRounds) || 6));
    room.players[clientId] = { name: (name || 'Jogador').slice(0, 18), score: 0, connected: true, socketId: socket.id };
    rooms[code] = room;
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.clientId = clientId;
    broadcastRoom(code);
  });

  socket.on('join_room', ({ clientId, name, code }) => {
    const room = rooms[(code || '').toUpperCase()];
    if (!room) {
      socket.emit('join_error', 'Sala não encontrada. Confira o código com quem te chamou.');
      return;
    }
    if (!room.players[clientId]) {
      room.players[clientId] = { name: (name || 'Jogador').slice(0, 18), score: 0, connected: true, socketId: socket.id };
    } else {
      room.players[clientId].connected = true;
      room.players[clientId].socketId = socket.id;
      if (name) room.players[clientId].name = name.slice(0, 18);
    }
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.clientId = clientId;
    broadcastRoom(room.code);
  });

  socket.on('start_game', () => {
    const room = currentRoom(socket);
    if (!room || room.hostId !== socket.data.clientId) return;
    if (Object.keys(room.players).length < 2) return;
    if (!room.activeThemes || room.activeThemes.length === 0) return;
    room.round = 1;
    room.theme = pickTheme(room);
    room.usedThemes = [room.theme];
    assignTiersForRound(room);
    room.order = [];
    room.turnIndex = 0;
    room.lastReveal = null;
    room.phase = 'writing';
    broadcastRoom(room.code);
  });

  socket.on('submit_answer', ({ text }) => {
    const room = currentRoom(socket);
    if (!room || room.phase !== 'writing') return;
    const clean = (text || '').trim().slice(0, 60);
    if (!clean) return;
    room.submissions[socket.data.clientId] = clean;
    // Se todos enviaram, agenda auto-avanço. Se não, apenas atualiza o estado.
    if (!tryAutoWriting(room)) broadcastRoom(room.code);
  });

  socket.on('change_mode', ({ mode }) => {
    const room = currentRoom(socket);
    if (!room || room.hostId !== socket.data.clientId || (room.phase !== 'lobby' && room.phase !== 'end')) return;
    if (mode === 'guess_tier' || mode === 'guess_creator') {
      room.mode = mode;
      broadcastRoom(room.code);
    }
  });

  socket.on('submit_tier_list', ({ tierList }) => {
    const room = currentRoom(socket);
    if (!room || room.phase !== 'making_tier_lists') return;
    room.tierLists[socket.data.clientId] = tierList;
    if (!tryAutoTierMaking(room)) broadcastRoom(room.code);
  });

  // Anfitrião pode avançar manualmente antes do timer
  socket.on('go_to_guessing', () => {
    const room = currentRoom(socket);
    if (!room || room.hostId !== socket.data.clientId) return;
    if (room.phase === 'writing' && room.mode === 'guess_tier') doGoToGuessing(room);
    else if (room.phase === 'writing' && room.mode === 'guess_creator') doGoToTierMaking(room);
    else if (room.phase === 'making_tier_lists') doGoToGuessingFromTierMaking(room);
  });

  socket.on('submit_guess', ({ guess, listIndex }) => {
    const room = currentRoom(socket);
    if (!room) return;

    if (room.phase === 'guessing') {
      // Modo guess_tier: vota no tier de um jogador por vez
      const submitterId = room.order[room.turnIndex];
      if (submitterId === socket.data.clientId) return;
      if (room.mode === 'guess_tier' && !TIERS.includes(guess)) return;
      if (room.mode === 'guess_creator' && !room.players[guess]) return;
      if (!room.guesses[submitterId]) room.guesses[submitterId] = {};
      room.guesses[submitterId][socket.data.clientId] = guess;
      if (!tryAutoGuessing(room)) broadcastRoom(room.code);
    } else if (room.phase === 'guessing_all') {
      // Modo guess_creator: vota em uma tier list específica pelo índice
      if (listIndex === undefined || listIndex < 0 || listIndex >= room.order.length) return;
      const submitterId = room.order[listIndex];
      if (submitterId === socket.data.clientId) return; // não pode votar na própria
      if (!room.players[guess]) return;
      if (!room.guesses[submitterId]) room.guesses[submitterId] = {};
      room.guesses[submitterId][socket.data.clientId] = guess;
      if (!tryAutoGuessingAll(room)) broadcastRoom(room.code);
    }
  });

  // Anfitrião pode revelar antes do timer
  // Aceita tanto 'guessing' (guess_tier) quanto 'guessing_all' (guess_creator)
  socket.on('reveal', () => {
    const room = currentRoom(socket);
    if (!room || room.hostId !== socket.data.clientId) return;
    if (room.phase !== 'guessing' && room.phase !== 'guessing_all') return;
    doReveal(room);
  });

  // Anfitrião pode avançar de turno antes do timer
  socket.on('next_turn', () => {
    const room = currentRoom(socket);
    if (!room || room.hostId !== socket.data.clientId || room.phase !== 'reveal') return;
    doNextTurn(room);
  });

  // Anfitrião pode ir para próxima rodada antes do timer
  socket.on('next_round', () => {
    const room = currentRoom(socket);
    if (!room || room.hostId !== socket.data.clientId || room.phase !== 'scoreboard') return;
    doNextRound(room);
  });

  socket.on('toggle_theme', ({ theme }) => {
    const room = currentRoom(socket);
    if (!room || (room.phase !== 'lobby' && room.phase !== 'end')) return;
    if (!THEMES.includes(theme)) return;
    if (!room.activeThemes) room.activeThemes = [...THEMES];
    const index = room.activeThemes.indexOf(theme);
    if (index > -1) {
      room.activeThemes.splice(index, 1);
    } else {
      room.activeThemes.push(theme);
    }
    broadcastRoom(room.code);
  });

  socket.on('set_all_themes', ({ selectAll }) => {
    const room = currentRoom(socket);
    if (!room || (room.phase !== 'lobby' && room.phase !== 'end')) return;
    if (selectAll) {
      room.activeThemes = [...THEMES];
    } else {
      room.activeThemes = [];
    }
    broadcastRoom(room.code);
  });

  socket.on('play_again', () => {
    const room = currentRoom(socket);
    if (!room || room.hostId !== socket.data.clientId || room.phase !== 'end') return;
    clearRoomTimer(room);
    Object.values(room.players).forEach((p) => { p.score = 0; });
    room.round = 0;
    room.theme = '';
    room.usedThemes = [];
    room.activeThemes = [...THEMES];
    room.tiers = {};
    room.submissions = {};
    room.tierLists = {};
    room.order = [];
    room.turnIndex = 0;
    room.guesses = {};
    room.lastReveal = null;
    room.phase = 'lobby';
    broadcastRoom(room.code);
  });

  socket.on('disconnect', () => {
    const room = currentRoom(socket);
    if (!room) return;
    const p = room.players[socket.data.clientId];
    if (p && p.socketId === socket.id) {
      p.connected = false;
      // Quando alguém desconecta, o threshold cai — pode ser que todos os
      // que restaram já tenham enviado/votado.
      if (!tryAutoWriting(room) && !tryAutoTierMaking(room) && !tryAutoGuessing(room) && !tryAutoGuessingAll(room)) {
        broadcastRoom(room.code);
      }
    }
  });
});

function currentRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms[code] : null;
}

server.listen(PORT, () => {
  console.log(`Tier Rush rodando! Abra http://localhost:${PORT} no navegador.`);
});
