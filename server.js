const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Настройка загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ------------------ Хранилища ------------------
const users = {};
const parties = {};
const queues = {
  '1v1_unranked': [], '1v1_ranked': [],
  '2v2_unranked': [], '2v2_ranked': [],
  '5v5_unranked': [], '5v5_ranked': []
};
const pendingMatches = [];
const chatMessages = [];
const privateMessages = [];
const socketToUser = {};
const userSockets = {};

// Баны и муты
const bans = {};
const mutes = {};

// Топ игроков
const winHistory = [];
const leaderboardCache = { day: [], week: [], month: [] };
let lastLeaderboardUpdate = 0;

// Кланы
const clans = {};

// Вспомогательные переменные для драфта и голосования
const drafts = {};
const mapVotes = {};

// ------------------ Вспомогательные функции ------------------
function generateUserId() {
  let id;
  do { id = Math.floor(Math.random() * 1000000).toString().padStart(6, '0'); }
  while (users[id]);
  return id;
}

function generatePartyId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function getDefaultStats() {
  return {
    mmr_1v1: 100, matches_1v1: 0, wins_1v1: 0, losses_1v1: 0, placement_1v1: 0,
    mmr_2v2: 100, matches_2v2: 0, wins_2v2: 0, losses_2v2: 0, placement_2v2: 0,
    mmr_5v5: 100, matches_5v5: 0, wins_5v5: 0, losses_5v5: 0, placement_5v5: 0,
    totalRankedWins: 0,
    matchHistory: [],
    avatar: '',
    streak: 0
  };
}

function getLevelByMmr(mmr) {
  if (mmr >= 2001) return 10;
  if (mmr >= 1751) return 9;
  if (mmr >= 1531) return 8;
  if (mmr >= 1351) return 7;
  if (mmr >= 1201) return 6;
  if (mmr >= 1051) return 5;
  if (mmr >= 901) return 4;
  if (mmr >= 751) return 3;
  if (mmr >= 501) return 2;
  return 1;
}

function canPlayRanked(userId, mode) {
  const user = users[userId];
  if (!user) return false;
  const placementKey = `placement_${mode}`;
  return user.stats[placementKey] >= 3;
}

function findMatchInQueue(mode, ranked) {
  const key = `${mode}_${ranked ? 'ranked' : 'unranked'}`;
  const queue = queues[key];
  if (queue.length === 0) return null;

  const needed = mode === '1v1' ? 2 : mode === '2v2' ? 4 : 10;
  if (!ranked) {
    if (queue.length >= needed) {
      const participants = queue.splice(0, needed);
      return participants.map(p => p.userId);
    }
    return null;
  } else {
    const sorted = [...queue].sort((a, b) => users[a.userId].stats[`mmr_${mode}`] - users[b.userId].stats[`mmr_${mode}`]);
    for (let i = 0; i <= sorted.length - needed; i++) {
      const group = sorted.slice(i, i + needed);
      const mmrs = group.map(p => users[p.userId].stats[`mmr_${mode}`]);
      const min = Math.min(...mmrs);
      const max = Math.max(...mmrs);
      if (max - min <= 100) {
        const removed = [];
        for (const p of group) {
          const idx = queue.findIndex(e => e.userId === p.userId);
          if (idx !== -1) removed.push(...queue.splice(idx, 1));
        }
        return removed.map(p => p.userId);
      }
    }
    return null;
  }
}

function broadcastQueueState() {
  io.emit('queueUpdate', queues);
}

function broadcastChatMessage(msg) {
  io.emit('chatMessage', msg);
}

function sendPrivateMessage(toUserId, fromUserId, text) {
  const msg = {
    from: fromUserId,
    to: toUserId,
    text,
    timestamp: Date.now(),
    date: new Date().toLocaleString()
  };
  privateMessages.push(msg);
  if (privateMessages.length > 1000) privateMessages.shift();
  const toSocketId = userSockets[toUserId];
  if (toSocketId) {
    io.to(toSocketId).emit('privateMessage', { from: fromUserId, text, date: msg.date });
  }
}

function isBanned(userId) {
  const ban = bans[userId];
  if (ban && ban.until > Date.now()) return true;
  if (ban && ban.until <= Date.now()) delete bans[userId];
  return false;
}

function isMuted(userId) {
  const mute = mutes[userId];
  if (mute && mute.until > Date.now()) return true;
  if (mute && mute.until <= Date.now()) delete mutes[userId];
  return false;
}

function updateLeaderboard() {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

  const dayWins = {};
  const weekWins = {};
  const monthWins = {};

  winHistory.forEach(entry => {
    if (entry.timestamp >= dayAgo) dayWins[entry.userId] = (dayWins[entry.userId] || 0) + 1;
    if (entry.timestamp >= weekAgo) weekWins[entry.userId] = (weekWins[entry.userId] || 0) + 1;
    if (entry.timestamp >= monthAgo) monthWins[entry.userId] = (monthWins[entry.userId] || 0) + 1;
  });

  const sortFn = (obj) => Object.entries(obj).sort((a,b) => b[1] - a[1]).slice(0, 10);
  leaderboardCache.day = sortFn(dayWins).map(([uid, wins]) => ({ userId: uid, wins, userData: users[uid] }));
  leaderboardCache.week = sortFn(weekWins).map(([uid, wins]) => ({ userId: uid, wins, userData: users[uid] }));
  leaderboardCache.month = sortFn(monthWins).map(([uid, wins]) => ({ userId: uid, wins, userData: users[uid] }));
  lastLeaderboardUpdate = now;
}

function addWinToHistory(userId) {
  winHistory.push({ userId, timestamp: Date.now() });
  if (winHistory.length > 10000) winHistory.splice(0, 1000);
  updateLeaderboard();
}

// ------------------ REST API ------------------
app.post('/api/register', (req, res) => {
  const { username, password, inGameNick, inGameId } = req.body;
  if (!username || !password || !inGameNick || !inGameId) {
    return res.status(400).json({ success: false, message: 'Все поля обязательны' });
  }
  if (Object.values(users).some(u => u.username === username)) {
    return res.status(400).json({ success: false, message: 'Пользователь с таким логином уже существует' });
  }
  const userId = generateUserId();
  users[userId] = {
    username,
    password,
    inGameNick,
    inGameId,
    friends: [],
    pendingRequests: [],
    isAdmin: false,
    clanId: null,
    stats: getDefaultStats()
  };
  const adminLogins = ['q', 'bogpvp', 'admin', 'Smirkycarp34119'];
  if (adminLogins.includes(username)) users[userId].isAdmin = true;
  res.json({ success: true, message: `Регистрация успешна! Ваш ID: ${userId}`, userId });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const entry = Object.entries(users).find(([_, u]) => u.username === username && u.password === password);
  if (!entry) return res.status(400).json({ success: false, message: 'Неверный логин или пароль' });
  const [userId, userData] = entry;
  if (isBanned(userId)) {
    return res.status(403).json({ success: false, message: `Вы забанены до ${new Date(bans[userId].until).toLocaleString()}. Причина: ${bans[userId].reason}` });
  }
  res.json({ success: true, userData: { id: userId, ...userData, stats: userData.stats } });
});

app.get('/api/user/:id', (req, res) => {
  const user = users[req.params.id];
  if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  res.json({ success: true, userData: { id: req.params.id, ...user, stats: user.stats } });
});

app.get('/api/user-by-gameid/:gameId', (req, res) => {
  const gameId = req.params.gameId;
  const entry = Object.entries(users).find(([_, u]) => u.inGameId === gameId);
  if (!entry) return res.status(404).json({ success: false, message: 'Игрок не найден' });
  const [userId, userData] = entry;
  res.json({ success: true, userData: { id: userId, ...userData, stats: userData.stats } });
});

app.post('/api/update-stats', (req, res) => {
  const { userId, stats } = req.body;
  if (users[userId]) {
    users[userId].stats = stats;
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false });
  }
});

app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
  const { userId } = req.body;
  if (!req.file) return res.status(400).json({ success: false });
  if (!users[userId]) return res.status(404).json({ success: false });
  const avatarUrl = `/uploads/${req.file.filename}`;
  users[userId].stats.avatar = avatarUrl;
  res.json({ success: true, avatarUrl });
});

app.get('/api/check-admin', (req, res) => {
  const userId = req.query.userId;
  if (!userId || !users[userId]) return res.status(401).json({ isAdmin: false });
  res.json({ isAdmin: users[userId].isAdmin });
});

app.post('/api/admin-action', (req, res) => {
  const { adminId, targetUserId, action, reason, durationHours } = req.body;
  if (!users[adminId] || !users[adminId].isAdmin) return res.status(403).json({ success: false, message: 'Недостаточно прав' });
  if (!users[targetUserId]) return res.status(404).json({ success: false, message: 'Целевой пользователь не найден' });
  if (users[targetUserId].isAdmin && action !== 'unmute' && action !== 'unban') {
    return res.status(403).json({ success: false, message: 'Нельзя банить/мутить другого администратора' });
  }
  const durationMs = durationHours * 60 * 60 * 1000;
  const until = Date.now() + durationMs;

  if (action === 'mute') {
    mutes[targetUserId] = { until, reason };
    const sid = userSockets[targetUserId];
    if (sid) io.to(sid).emit('muted', { until, reason });
  } else if (action === 'ban') {
    bans[targetUserId] = { until, reason };
    const sid = userSockets[targetUserId];
    if (sid) {
      io.to(sid).emit('banned', { until, reason });
      io.sockets.sockets.get(sid)?.disconnect();
    }
  } else {
    return res.status(400).json({ success: false, message: 'Неизвестное действие' });
  }
  res.json({ success: true, message: `${action === 'mute' ? 'Мут' : 'Бан'} применён до ${new Date(until).toLocaleString()}` });
});

app.post('/api/cancel-match', (req, res) => {
  const { adminId, matchId } = req.body;
  if (!users[adminId] || !users[adminId].isAdmin) return res.status(403).json({ success: false, message: 'Недостаточно прав' });
  const idx = pendingMatches.findIndex(m => m.id === matchId);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Матч не найден' });
  const match = pendingMatches[idx];
  const otherAdmins = match.participants.filter(pid => pid !== adminId && users[pid]?.isAdmin);
  if (otherAdmins.length) {
    return res.status(403).json({ success: false, message: 'Нельзя отменить матч, в котором участвует другой администратор' });
  }
  pendingMatches.splice(idx, 1);
  match.participants.forEach(pid => {
    const sid = userSockets[pid];
    if (sid) io.to(sid).emit('matchCancelled', { matchId });
  });
  res.json({ success: true, message: 'Матч отменён' });
});

app.get('/api/top-players', (req, res) => {
  if (Date.now() - lastLeaderboardUpdate > 5 * 60 * 1000) updateLeaderboard();
  res.json({ success: true, data: leaderboardCache });
});

app.post('/api/change-nick', (req, res) => {
  const { userId, newNick } = req.body;
  if (!users[userId]) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  if (!newNick || newNick.trim().length === 0) return res.status(400).json({ success: false, message: 'Ник не может быть пустым' });
  users[userId].inGameNick = newNick;
  res.json({ success: true });
});

// --- Кланы ---
app.get('/api/clan-info', (req, res) => {
  const { userId } = req.query;
  if (!users[userId]) return res.status(404).json({ success: false });
  const clanId = users[userId].clanId;
  if (!clanId) return res.json({ success: true, clan: null });
  const clan = clans[clanId];
  if (!clan) return res.json({ success: true, clan: null });
  const membersData = clan.members.map(mid => {
    const m = users[mid];
    return { id: mid, username: m?.username, inGameNick: m?.inGameNick, avatar: m?.stats.avatar };
  });
  res.json({ success: true, clan: { ...clan, members: membersData } });
});

app.post('/api/create-clan', (req, res) => {
  const { userId, clanTag, clanName } = req.body;
  const user = users[userId];
  if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  if (user.clanId) return res.status(400).json({ success: false, message: 'Вы уже состоите в клане' });
  if (!clanTag || clanTag.length > 5) return res.status(400).json({ success: false, message: 'Тег клана должен быть до 5 символов' });
  if (!clanName || clanName.length > 32) return res.status(400).json({ success: false, message: 'Название клана должно быть до 32 символов' });
  if (!user.isAdmin && user.stats.totalRankedWins < 10) {
    return res.status(400).json({ success: false, message: 'Для создания клана необходимо 10 побед в рейтинговых матчах' });
  }
  const clanId = Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  clans[clanId] = {
    name: clanName,
    tag: clanTag,
    ownerId: userId,
    members: [userId],
    created: Date.now(),
    maxMembers: 50
  };
  user.clanId = clanId;
  res.json({ success: true, clanId });
});

app.post('/api/join-clan', (req, res) => {
  const { userId, clanId } = req.body;
  const user = users[userId];
  if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  if (user.clanId) return res.status(400).json({ success: false, message: 'Вы уже в клане' });
  const clan = clans[clanId];
  if (!clan) return res.status(404).json({ success: false, message: 'Клан не найден' });
  if (clan.members.length >= clan.maxMembers) {
    return res.status(400).json({ success: false, message: 'Клан заполнен' });
  }
  clan.members.push(userId);
  user.clanId = clanId;
  res.json({ success: true });
});

app.post('/api/leave-clan', (req, res) => {
  const { userId } = req.body;
  const user = users[userId];
  if (!user || !user.clanId) return res.status(400).json({ success: false, message: 'Вы не состоите в клане' });
  const clan = clans[user.clanId];
  if (clan) {
    clan.members = clan.members.filter(mid => mid !== userId);
    if (clan.members.length === 0) delete clans[user.clanId];
  }
  user.clanId = null;
  res.json({ success: true });
});

// --- Пати ---
app.post('/api/create-party', (req, res) => {
  const { leaderId } = req.body;
  if (Object.values(parties).some(p => p.members.includes(leaderId))) return res.json({ success: false, message: 'Вы уже в пати' });
  const partyId = generatePartyId();
  parties[partyId] = { leaderId, members: [leaderId] };
  res.json({ success: true, partyId });
});

app.post('/api/join-party', (req, res) => {
  const { partyId, userId } = req.body;
  const party = parties[partyId];
  if (!party) return res.status(404).json({ success: false, message: 'Пати не найдена' });
  if (party.members.includes(userId)) return res.json({ success: false, message: 'Уже в пати' });
  party.members.push(userId);
  party.members.forEach(m => {
    const s = userSockets[m];
    if (s) io.to(s).emit('partyUpdate', party);
  });
  res.json({ success: true });
});

app.post('/api/leave-party', (req, res) => {
  const { partyId, userId } = req.body;
  const party = parties[partyId];
  if (!party) return res.status(404).json({ success: false, message: 'Пати не найдена' });
  const idx = party.members.indexOf(userId);
  if (idx === -1) return res.json({ success: false, message: 'Вы не в этой пати' });
  party.members.splice(idx, 1);
  if (party.members.length === 0) {
    delete parties[partyId];
  } else {
    if (party.leaderId === userId) party.leaderId = party.members[0];
    party.members.forEach(m => {
      const s = userSockets[m];
      if (s) io.to(s).emit('partyUpdate', party);
    });
  }
  res.json({ success: true });
});

// ------------------ WebSocket ------------------
io.on('connection', (socket) => {
  console.log('Клиент подключился:', socket.id);

  socket.on('auth', (userId) => {
    if (isBanned(userId)) {
      socket.emit('banned', { until: bans[userId].until, reason: bans[userId].reason });
      socket.disconnect();
      return;
    }
    socketToUser[socket.id] = userId;
    userSockets[userId] = socket.id;
    console.log(`Пользователь ${userId} авторизован`);
    socket.emit('queueUpdate', queues);
    socket.emit('chatHistory', chatMessages.slice(-50));
    const userPrivate = privateMessages.filter(m => m.to === userId || m.from === userId);
    socket.emit('privateHistory', userPrivate.slice(-50));
    const user = users[userId];
    if (user) socket.emit('friendList', { friends: user.friends, requests: user.pendingRequests });
    for (const pid in parties) {
      if (parties[pid].members.includes(userId)) {
        socket.emit('partyUpdate', parties[pid]);
        break;
      }
    }
  });

  socket.on('joinQueue', ({ mode, ranked, partyId }) => {
    const userId = socketToUser[socket.id];
    if (!userId) return;
    if (isMuted(userId)) {
      socket.emit('queueError', { message: 'Вы замьючены и не можете встать в очередь' });
      return;
    }
    const user = users[userId];
    if (!user) return;
    if (ranked && !canPlayRanked(userId, mode)) {
      socket.emit('queueError', { message: `Вы не можете играть ранговый режим, пока не выиграете 3 матча в обычном ${mode}` });
      return;
    }
    let participants = [userId];
    if (partyId && parties[partyId] && parties[partyId].members.includes(userId)) {
      participants = parties[partyId].members;
    }
    const key = `${mode}_${ranked ? 'ranked' : 'unranked'}`;
    const queue = queues[key];
    participants.forEach(pid => {
      if (!queue.some(entry => entry.userId === pid)) {
        queue.push({ userId: pid, mmr: users[pid].stats[`mmr_${mode}`] });
      }
    });
    broadcastQueueState();
    const matchParticipants = findMatchInQueue(mode, ranked);
    if (matchParticipants && matchParticipants.length >= (mode === '1v1' ? 2 : mode === '2v2' ? 4 : 10)) {
      const maps = ['Sandstone', 'Rust', 'Province', 'Dune', 'Breeze'];
      const map = maps[Math.floor(Math.random() * maps.length)];
      const match = {
        id: Date.now().toString(),
        mode,
        ranked,
        map,
        participants: matchParticipants,
        timestamp: Date.now(),
        status: 'waiting_accept'
      };
      pendingMatches.push(match);
      console.log('Матч создан:', match.id, 'участники:', matchParticipants);
      matchParticipants.forEach(pid => {
        const sid = userSockets[pid];
        if (sid) {
          io.to(sid).emit('matchFound', { matchId: match.id, mode, ranked, map, participants: matchParticipants, timeout: 15000 });
        }
      });
      setTimeout(() => {
        const m = pendingMatches.find(m => m.id === match.id);
        if (m && m.status === 'waiting_accept') {
          m.status = 'cancelled';
          const idx = pendingMatches.findIndex(m2 => m2.id === match.id);
          if (idx !== -1) pendingMatches.splice(idx, 1);
          matchParticipants.forEach(pid => {
            const sid = userSockets[pid];
            if (sid) io.to(sid).emit('matchCancelled', { matchId: match.id });
          });
        }
      }, 15000);
    }
  });

  socket.on('leaveQueue', ({ mode, ranked }) => {
    const userId = socketToUser[socket.id];
    if (!userId) return;
    const key = `${mode}_${ranked ? 'ranked' : 'unranked'}`;
    const queue = queues[key];
    const idx = queue.findIndex(entry => entry.userId === userId);
    if (idx !== -1) {
      queue.splice(idx, 1);
      broadcastQueueState();
    }
  });

  socket.on('acceptMatch', ({ matchId }) => {
    const userId = socketToUser[socket.id];
    const match = pendingMatches.find(m => m.id === matchId);
    if (!match || match.status !== 'waiting_accept') return;
    if (!match.accepted) match.accepted = [];
    if (!match.accepted.includes(userId)) match.accepted.push(userId);
    const needed = match.mode === '1v1' ? 2 : match.mode === '2v2' ? 4 : 10;
    console.log(`Приняли матч ${matchId}: ${match.accepted.length}/${needed}`);
    if (match.accepted.length === needed) {
      match.status = 'draft';
      const shuffled = [...match.participants];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const captains = [shuffled[0], shuffled[1]];
      drafts[match.id] = {
        captains,
        turn: 0,
        remainingPlayers: shuffled.slice(2),
        teamA: [captains[0]],
        teamB: [captains[1]]
      };
      match.participants.forEach(pid => {
        const sid = userSockets[pid];
        if (sid) {
          io.to(sid).emit('draftStart', {
            matchId,
            captains,
            remainingPlayers: drafts[match.id].remainingPlayers,
            teamA: drafts[match.id].teamA,
            teamB: drafts[match.id].teamB
          });
        }
      });
    } else {
      socket.emit('matchAccepted', { matchId });
    }
  });

  socket.on('draftPick', ({ matchId, pickedUserId }) => {
    const userId = socketToUser[socket.id];
    const draft = drafts[matchId];
    if (!draft) return;
    const match = pendingMatches.find(m => m.id === matchId);
    if (!match || match.status !== 'draft') return;
    const currentCaptain = draft.captains[draft.turn % 2];
    if (userId !== currentCaptain) return;
    if (!draft.remainingPlayers.includes(pickedUserId)) return;
    draft.remainingPlayers = draft.remainingPlayers.filter(pid => pid !== pickedUserId);
    if (draft.turn % 2 === 0) draft.teamA.push(pickedUserId);
    else draft.teamB.push(pickedUserId);
    draft.turn++;
    if (draft.remainingPlayers.length === 0) {
      match.status = 'map_vote';
      const maps = ['Sandstone', 'Rust', 'Province', 'Dune', 'Breeze'];
      mapVotes[match.id] = { votes: {}, totalVoters: 0 };
      match.participants.forEach(pid => {
        const sid = userSockets[pid];
        if (sid) io.to(sid).emit('mapVoteStart', { matchId, maps });
      });
    } else {
      match.participants.forEach(pid => {
        const sid = userSockets[pid];
        if (sid) io.to(sid).emit('draftUpdate', {
          remainingPlayers: draft.remainingPlayers,
          teamA: draft.teamA,
          teamB: draft.teamB,
          nextCaptain: draft.captains[draft.turn % 2]
        });
      });
    }
  });

  socket.on('mapVote', ({ matchId, mapName }) => {
    const userId = socketToUser[socket.id];
    const match = pendingMatches.find(m => m.id === matchId);
    if (!match || match.status !== 'map_vote') return;
    const votes = mapVotes[match.id];
    if (!votes) return;
    votes.votes[mapName] = (votes.votes[mapName] || 0) + 1;
    votes.totalVoters++;
    if (votes.totalVoters === match.participants.length) {
      let bestMap = null, bestCount = 0;
      for (const [map, cnt] of Object.entries(votes.votes)) {
        if (cnt > bestCount) { bestCount = cnt; bestMap = map; }
      }
      const finalMap = bestMap || 'Sandstone';
      match.map = finalMap;
      match.status = 'lobby';
      delete drafts[match.id];
      delete mapVotes[match.id];
      match.participants.forEach(pid => {
        const sid = userSockets[pid];
        if (sid) io.to(sid).emit('lobbyOpen', {
          matchId,
          mode: match.mode,
          ranked: match.ranked,
          map: finalMap,
          participants: match.participants,
          teamA: drafts[match.id]?.teamA || [],
          teamB: drafts[match.id]?.teamB || []
        });
      });
    }
  });

  socket.on('declineMatch', ({ matchId }) => {
    const userId = socketToUser[socket.id];
    const match = pendingMatches.find(m => m.id === matchId);
    if (match && match.status === 'waiting_accept') {
      match.status = 'cancelled';
      const idx = pendingMatches.findIndex(m => m.id === matchId);
      if (idx !== -1) pendingMatches.splice(idx, 1);
      match.participants.forEach(pid => {
        const sid = userSockets[pid];
        if (sid) io.to(sid).emit('matchCancelled', { matchId });
      });
    }
  });

  socket.on('lobbyChat', ({ matchId, text }) => {
    const userId = socketToUser[socket.id];
    if (isMuted(userId)) {
      socket.emit('queueError', { message: 'Вы замьючены и не можете писать в чат' });
      return;
    }
    const match = pendingMatches.find(m => m.id === matchId);
    if (!match || match.status !== 'lobby') return;
    const user = users[userId];
    match.participants.forEach(pid => {
      const sid = userSockets[pid];
      if (sid) io.to(sid).emit('lobbyMessage', { from: user.inGameNick, text, date: new Date().toLocaleString() });
    });
  });

  socket.on('chatMessage', (text) => {
    const userId = socketToUser[socket.id];
    if (!userId) return;
    if (isMuted(userId)) {
      socket.emit('queueError', { message: 'Вы замьючены и не можете писать в чат' });
      return;
    }
    const user = users[userId];
    if (!user) return;
    const msg = {
      userId,
      username: user.username,
      avatar: user.stats.avatar,
      text,
      timestamp: Date.now(),
      date: new Date().toLocaleString()
    };
    chatMessages.push(msg);
    if (chatMessages.length > 100) chatMessages.shift();
    broadcastChatMessage(msg);
  });

  socket.on('privateMessage', ({ toUserId, text }) => {
    const fromUserId = socketToUser[socket.id];
    if (!fromUserId || !users[toUserId]) return;
    if (isMuted(fromUserId)) {
      socket.emit('queueError', { message: 'Вы замьючены и не можете отправлять личные сообщения' });
      return;
    }
    sendPrivateMessage(toUserId, fromUserId, text);
  });

  socket.on('inviteToParty', ({ partyId, targetUserId }) => {
    const fromUserId = socketToUser[socket.id];
    if (!fromUserId) return;
    const party = parties[partyId];
    if (!party) return;
    const targetSocket = userSockets[targetUserId];
    if (targetSocket) {
      io.to(targetSocket).emit('partyInvite', { fromUserId, fromName: users[fromUserId].inGameNick, partyId });
    }
  });

  socket.on('acceptPartyInvite', ({ partyId }) => {
    const userId = socketToUser[socket.id];
    if (!userId) return;
    const party = parties[partyId];
    if (!party) return;
    if (!party.members.includes(userId)) {
      party.members.push(userId);
      party.members.forEach(m => {
        const s = userSockets[m];
        if (s) io.to(s).emit('partyUpdate', party);
      });
    }
  });

  socket.on('disconnect', () => {
    const userId = socketToUser[socket.id];
    if (userId) {
      delete userSockets[userId];
      delete socketToUser[socket.id];
      for (const key in queues) {
        const idx = queues[key].findIndex(entry => entry.userId === userId);
        if (idx !== -1) queues[key].splice(idx, 1);
      }
      broadcastQueueState();
      for (const pid in parties) {
        const party = parties[pid];
        if (party.members.includes(userId)) {
          party.members = party.members.filter(id => id !== userId);
          if (party.members.length === 0) delete parties[pid];
          else {
            if (party.leaderId === userId) party.leaderId = party.members[0];
            party.members.forEach(m => {
              const s = userSockets[m];
              if (s) io.to(s).emit('partyUpdate', party);
            });
          }
          break;
        }
      }
      console.log(`Пользователь ${userId} отключился`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});