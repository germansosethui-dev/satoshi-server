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
    stats: getDefaultStats()
  };

  // === НАЗНАЧЕНИЕ МОДЕРАТОРОВ ===
  const adminLogins = ['q', 'bogpvp', 'admin', 'Smirkycarp34119'];
  if (adminLogins.includes(username)) {
    users[userId].isAdmin = true;
  }
  // =============================

  res.json({ success: true, message: `Регистрация успешна! Ваш ID: ${userId}`, userId });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const entry = Object.entries(users).find(([_, u]) => u.username === username && u.password === password);
  if (!entry) {
    return res.status(400).json({ success: false, message: 'Неверный логин или пароль' });
  }
  const [userId, userData] = entry;
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
  if (!entry) {
    return res.status(404).json({ success: false, message: 'Игрок не найден' });
  }
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

app.post('/api/send-friend-request', (req, res) => {
  const { fromUserId, toInGameId } = req.body;
  const target = Object.entries(users).find(([_, u]) => u.inGameId === toInGameId);
  if (!target) return res.status(404).json({ success: false, message: 'Игрок не найден' });
  const [toUserId, toUser] = target;
  if (toUserId === fromUserId) return res.status(400).json({ success: false, message: 'Нельзя добавить себя' });
  if (users[fromUserId].friends.includes(toUserId)) return res.status(400).json({ success: false, message: 'Уже в друзьях' });
  if (users[toUserId].pendingRequests.includes(fromUserId)) return res.status(400).json({ success: false, message: 'Заявка уже отправлена' });
  users[toUserId].pendingRequests.push(fromUserId);
  const socketId = userSockets[toUserId];
  if (socketId) io.to(socketId).emit('friendRequest', { from: fromUserId, fromName: users[fromUserId].inGameNick });
  res.json({ success: true });
});

app.post('/api/accept-friend', (req, res) => {
  const { userId, friendId } = req.body;
  if (!users[userId] || !users[friendId]) return res.status(404).json({ success: false });
  const idx = users[userId].pendingRequests.indexOf(friendId);
  if (idx !== -1) users[userId].pendingRequests.splice(idx, 1);
  if (!users[userId].friends.includes(friendId)) users[userId].friends.push(friendId);
  if (!users[friendId].friends.includes(userId)) users[friendId].friends.push(userId);
  const socket1 = userSockets[userId];
  const socket2 = userSockets[friendId];
  if (socket1) io.to(socket1).emit('friendAdded', friendId);
  if (socket2) io.to(socket2).emit('friendAdded', userId);
  res.json({ success: true });
});

app.post('/api/reject-friend', (req, res) => {
  const { userId, friendId } = req.body;
  if (!users[userId]) return res.status(404).json({ success: false });
  const idx = users[userId].pendingRequests.indexOf(friendId);
  if (idx !== -1) users[userId].pendingRequests.splice(idx, 1);
  res.json({ success: true });
});

app.post('/api/remove-friend', (req, res) => {
  const { userId, friendId } = req.body;
  if (!users[userId] || !users[friendId]) return res.status(404).json({ success: false });
  const idx1 = users[userId].friends.indexOf(friendId);
  if (idx1 !== -1) users[userId].friends.splice(idx1, 1);
  const idx2 = users[friendId].friends.indexOf(userId);
  if (idx2 !== -1) users[friendId].friends.splice(idx2, 1);
  res.json({ success: true });
});

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
  const index = party.members.indexOf(userId);
  if (index === -1) return res.json({ success: false, message: 'Вы не в этой пати' });
  party.members.splice(index, 1);
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

app.post('/api/upload-screenshot', upload.single('screenshot'), (req, res) => {
  const { matchId, userId } = req.body;
  if (!req.file) return res.status(400).json({ success: false });
  const match = pendingMatches.find(m => m.id === matchId);
  if (!match) return res.status(404).json({ success: false });
  if (!match.screenshots) match.screenshots = {};
  match.screenshots[userId] = req.file.filename;
  res.json({ success: true, filename: req.file.filename });
});

app.get('/api/pending-matches', (req, res) => {
  res.json(pendingMatches);
});

app.post('/api/resolve-match', (req, res) => {
  const { matchId, winnerId } = req.body;
  const idx = pendingMatches.findIndex(m => m.id === matchId);
  if (idx === -1) return res.status(404).json({ success: false });
  const match = pendingMatches[idx];
  match.participants.forEach(pid => {
    const user = users[pid];
    if (!user) return;
    const modeKey = match.mode;
    const win = (pid === winnerId);
    const stats = user.stats;
    stats[`matches_${modeKey}`] += 1;
    if (win) stats[`wins_${modeKey}`] += 1;
    else stats[`losses_${modeKey}`] += 1;
    if (match.ranked) {
      if (stats[`placement_${modeKey}`] < 3) {
        stats[`placement_${modeKey}`] += 1;
      } else {
        const change = win ? 25 : -25;
        stats[`mmr_${modeKey}`] += change;
        if (stats[`mmr_${modeKey}`] < 0) stats[`mmr_${modeKey}`] = 0;
      }
    }
    stats.matchHistory.unshift({
      mode: match.mode,
      ranked: match.ranked ? 'ранг' : 'обычный',
      map: match.map,
      result: win ? 'Победа' : 'Поражение',
      date: new Date().toLocaleString()
    });
    user.stats = stats;
    const socketId = userSockets[pid];
    if (socketId) io.to(socketId).emit('statsUpdated', user.stats);
  });
  pendingMatches.splice(idx, 1);
  res.json({ success: true });
});

// ------------------ WebSocket ------------------
io.on('connection', (socket) => {
  console.log('Клиент подключился:', socket.id);

  socket.on('auth', (userId) => {
    socketToUser[socket.id] = userId;
    userSockets[userId] = socket.id;
    console.log(`Пользователь ${userId} авторизован`);
    socket.emit('queueUpdate', queues);
    socket.emit('chatHistory', chatMessages.slice(-50));
    const userPrivate = privateMessages.filter(m => m.to === userId || m.from === userId);
    socket.emit('privateHistory', userPrivate.slice(-50));
    const user = users[userId];
    if (user) {
      socket.emit('friendList', { friends: user.friends, requests: user.pendingRequests });
    }
    for (const partyId in parties) {
      if (parties[partyId].members.includes(userId)) {
        socket.emit('partyUpdate', parties[partyId]);
        break;
      }
    }
  });

  socket.on('joinQueue', ({ mode, ranked, partyId }) => {
    const userId = socketToUser[socket.id];
    if (!userId) return;
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
      const maps = ['Sandstone', 'Rust', 'Province', 'Dune', 'Breeze', 'Sakura'];
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
    const neededCount = match.mode === '1v1' ? 2 : match.mode === '2v2' ? 4 : 10;
    console.log(`Приняли матч ${matchId}: ${match.accepted.length}/${neededCount}`);
    if (match.accepted.length === neededCount) {
      match.status = 'lobby';
      console.log('Все приняли, открываем лобби для матча', matchId);
      match.participants.forEach(pid => {
        const sid = userSockets[pid];
        if (sid) {
          io.to(sid).emit('lobbyOpen', { matchId: match.id, mode: match.mode, ranked: match.ranked, map: match.map, participants: match.participants });
        }
      });
    } else {
      socket.emit('matchAccepted', { matchId });
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
      for (const partyId in parties) {
        const party = parties[partyId];
        if (party.members.includes(userId)) {
          party.members = party.members.filter(id => id !== userId);
          if (party.members.length === 0) delete parties[partyId];
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