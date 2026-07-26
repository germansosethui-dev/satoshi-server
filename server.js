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
const bans = {};
const mutes = {};
const winHistory = [];
const leaderboardCache = { day: [], week: [], month: [] };
let lastLeaderboardUpdate = 0;
const clans = {};
const drafts = {};
const mapVotes = {};

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
    totalRankedWins: 0, matchHistory: [], avatar: '', streak: 0
  };
}
function getLevelByMmr(mmr) {
  if (mmr >= 2001) return 10; if (mmr >= 1751) return 9; if (mmr >= 1531) return 8;
  if (mmr >= 1351) return 7; if (mmr >= 1201) return 6; if (mmr >= 1051) return 5;
  if (mmr >= 901) return 4; if (mmr >= 751) return 3; if (mmr >= 501) return 2; return 1;
}
function canPlayRanked(userId, mode) {
  const user = users[userId];
  if (!user) return false;
  return user.stats[`placement_${mode}`] >= 3;
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
function broadcastQueueState() { io.emit('queueUpdate', queues); }
function broadcastChatMessage(msg) { io.emit('chatMessage', msg); }
function sendPrivateMessage(toUserId, fromUserId, text) {
  const msg = { from: fromUserId, to: toUserId, text, timestamp: Date.now(), date: new Date().toLocaleString() };
  privateMessages.push(msg);
  if (privateMessages.length > 1000) privateMessages.shift();
  const toSocketId = userSockets[toUserId];
  if (toSocketId) io.to(toSocketId).emit('privateMessage', { from: fromUserId, text, date: msg.date });
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
  const dayAgo = now - 86400000;
  const weekAgo = now - 604800000;
  const monthAgo = now - 2592000000;
  const dayWins = {}, weekWins = {}, monthWins = {};
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
  if (!username || !password || !inGameNick || !inGameId) return res.status(400).json({ success: false, message: 'Все поля обязательны' });
  if (Object.values(users).some(u => u.username === username)) return res.status(400).json({ success: false, message: 'Пользователь с таким логином уже существует' });
  const userId = generateUserId();
  users[userId] = { username, password, inGameNick, inGameId, friends: [], pendingRequests: [], isAdmin: false, clanId: null, stats: getDefaultStats() };
  if (['q','bogpvp','admin','Smirkycarp34119'].includes(username)) users[userId].isAdmin = true;
  res.json({ success: true, message: `Регистрация успешна! Ваш ID: ${userId}`, userId });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const entry = Object.entries(users).find(([_, u]) => u.username === username && u.password === password);
  if (!entry) return res.status(400).json({ success: false, message: 'Неверный логин или пароль' });
  const [userId, userData] = entry;
  if (isBanned(userId)) return res.status(403).json({ success: false, message: `Вы забанены до ${new Date(bans[userId].until).toLocaleString()}. Причина: ${bans[userId].reason}` });
  res.json({ success: true, userData: { id: userId, ...userData, stats: userData.stats } });
});

app.get('/api/user/:id', (req, res) => {
  const user = users[req.params.id];
  if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  res.json({ success: true, userData: { id: req.params.id, ...user, stats: user.stats } });
});

app.get('/api/user-by-gameid/:gameId', (req, res) => {
  const entry = Object.entries(users).find(([_, u]) => u.inGameId === req.params.gameId);
  if (!entry) return res.status(404).json({ success: false, message: 'Игрок не найден' });
  const [userId, userData] = entry;
  res.json({ success: true, userData: { id: userId, ...userData, stats: userData.stats } });
});

app.post('/api/update-stats', (req, res) => {
  const { userId, stats } = req.body;
  if (users[userId]) { users[userId].stats = stats; res.json({ success: true }); }
  else res.status(404).json({ success: false });
});

app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
  const { userId } = req.body;
  if (!req.file) return res.status(400).json({ success: false });
  if (!users[userId]) return res.status(404).json({ success: false });
  users[userId].stats.avatar = '/uploads/' + req.file.filename;
  res.json({ success: true, avatarUrl: users[userId].stats.avatar });
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
  if (users[targetUserId].isAdmin && action !== 'unmute' && action !== 'unban') return res.status(403).json({ success: false, message: 'Нельзя банить/мутить другого администратора' });
  const until = Date.now() + durationHours * 3600000;
  if (action === 'mute') { mutes[targetUserId] = { until, reason }; const sid = userSockets[targetUserId]; if (sid) io.to(sid).emit('muted', { until, reason }); }
  else if (action === 'ban') { bans[targetUserId] = { until, reason }; const sid = userSockets[targetUserId]; if (sid) { io.to(sid).emit('banned', { until, reason }); io.sockets.sockets.get(sid)?.disconnect(); } }
  else return res.status(400).json({ success: false, message: 'Неизвестное действие' });
  res.json({ success: true, message: `${action === 'mute' ? 'Мут' : 'Бан'} применён до ${new Date(until).toLocaleString()}` });
});

app.post('/api/cancel-match', (req, res) => {
  const { adminId, matchId } = req.body;
  if (!users[adminId]?.isAdmin) return res.status(403).json({ success: false, message: 'Недостаточно прав' });
  const idx = pendingMatches.findIndex(m => m.id === matchId);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Матч не найден' });
  const match = pendingMatches[idx];
  if (match.participants.some(pid => pid !== adminId && users[pid]?.isAdmin)) return res.status(403).json({ success: false, message: 'Нельзя отменить матч с другим администратором' });
  pendingMatches.splice(idx, 1);
  match.participants.forEach(pid => { const sid = userSockets[pid]; if (sid) io.to(sid).emit('matchCancelled', { matchId }); });
  res.json({ success: true, message: 'Матч отменён' });
});

app.get('/api/top-players', (req, res) => {
  if (Date.now() - lastLeaderboardUpdate > 300000) updateLeaderboard();
  res.json({ success: true, data: leaderboardCache });
});

app.post('/api/change-nick', (req, res) => {
  const { userId, newNick } = req.body;
  if (!users[userId]) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  if (!newNick?.trim()) return res.status(400).json({ success: false, message: 'Ник не может быть пустым' });
  users[userId].inGameNick = newNick;
  res.json({ success: true });
});

app.get('/api/clan-info', (req, res) => {
  const { userId } = req.query;
  if (!users[userId]) return res.status(404).json({ success: false });
  const clanId = users[userId].clanId;
  if (!clanId) return res.json({ success: true, clan: null });
  const clan = clans[clanId];
  if (!clan) return res.json({ success: true, clan: null });
  const membersData = clan.members.map(mid => { const m = users[mid]; return { id: mid, username: m?.username, inGameNick: m?.inGameNick, avatar: m?.stats.avatar }; });
  res.json({ success: true, clan: { ...clan, members: membersData } });
});

app.post('/api/create-clan', (req, res) => {
  const { userId, clanTag, clanName } = req.body;
  const user = users[userId];
  if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  if (user.clanId) return res.status(400).json({ success: false, message: 'Вы уже состоите в клане' });
  if (!clanTag || clanTag.length > 5) return res.status(400).json({ success: false, message: 'Тег клана до 5 символов' });
  if (!clanName || clanName.length > 32) return res.status(400).json({ success: false, message: 'Название клана до 32 символов' });
  if (!user.isAdmin && user.stats.totalRankedWins < 10) return res.status(400).json({ success: false, message: 'Нужно 10 рейтинговых побед' });
  const clanId = Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  clans[clanId] = { name: clanName, tag: clanTag, ownerId: userId, members: [userId], created: Date.now(), maxMembers: 50 };
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
  if (clan.members.length >= clan.maxMembers) return res.status(400).json({ success: false, message: 'Клан заполнен' });
  clan.members.push(userId);
  user.clanId = clanId;
  res.json({ success: true });
});

app.post('/api/leave-clan', (req, res) => {
  const { userId } = req.body;
  const user = users[userId];
  if (!user?.clanId) return res.status(400).json({ success: false, message: 'Вы не состоите в клане' });
  const clan = clans[user.clanId];
  if (clan) { clan.members = clan.members.filter(mid => mid !== userId); if (!clan.members.length) delete clans[user.clanId]; }
  user.clanId = null;
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
  party.members.forEach(m => { const s = userSockets[m]; if (s) io.to(s).emit('partyUpdate', party); });
  res.json({ success: true });
});

app.post('/api/leave-party', (req, res) => {
  const { partyId, userId } = req.body;
  const party = parties[partyId];
  if (!party) return res.status(404).json({ success: false, message: 'Пати не найдена' });
  const idx = party.members.indexOf(userId);
  if (idx === -1) return res.json({ success: false, message: 'Вы не в этой пати' });
  party.members.splice(idx, 1);
  if (!party.members.length) { delete parties[partyId]; }
  else { if (party.leaderId === userId) party.leaderId = party.members[0]; party.members.forEach(m => { const s = userSockets[m]; if (s) io.to(s).emit('partyUpdate', party); }); }
  res.json({ success: true });
});

// ------------------ WebSocket ------------------
io.on('connection', (socket) => {
  console.log('Клиент подключился:', socket.id);

  socket.on('auth', (userId) => {
    if (isBanned(userId)) { socket.emit('banned', { until: bans[userId].until, reason: bans[userId].reason }); socket.disconnect(); return; }
    socketToUser[socket.id] = userId;
    userSockets[userId] = socket.id;
    socket.emit('queueUpdate', queues);
    socket.emit('chatHistory', chatMessages.slice(-50));
    socket.emit('privateHistory', privateMessages.filter(m => m.to === userId || m.from === userId).slice(-50));
    const user = users[userId];
    if (user) socket.emit('friendList', { friends: user.friends, requests: user.pendingRequests });
    for (const pid in parties) { if (parties[pid].members.includes(userId)) { socket.emit('partyUpdate', parties[pid]); break; } }
  });

  socket.on('joinQueue', ({ mode, ranked, partyId }) => {
    const userId = socketToUser[socket.id];
    if (!userId) return;
    if (isMuted(userId)) { socket.emit('queueError', { message: 'Вы замьючены' }); return; }
    const user = users[userId];
    if (!user) return;
    if (ranked && !canPlayRanked(userId, mode)) { socket.emit('queueError', { message: `Нужно 3 победы в обычном ${mode}` }); return; }
    let participants = [userId];
    if (partyId && parties[partyId]?.members.includes(userId)) participants = parties[partyId].members;
    const key = `${mode}_${ranked ? 'ranked' : 'unranked'}`;
    const queue = queues[key];
    participants.forEach(pid => { if (!queue.some(e => e.userId === pid)) queue.push({ userId: pid, mmr: users[pid].stats[`mmr_${mode}`] }); });
    broadcastQueueState();
    const matchParticipants = findMatchInQueue(mode, ranked);
    if (matchParticipants && matchParticipants.length >= (mode === '1v1' ? 2 : mode === '2v2' ? 4 : 10)) {
      const map = ['Sandstone','Rust','Province','Dune','Breeze'][Math.floor(Math.random()*5)];
      const match = { id: Date.now().toString(), mode, ranked, map, participants: matchParticipants, timestamp: Date.now(), status: 'waiting_accept' };
      pendingMatches.push(match);
      matchParticipants.forEach(pid => { const sid = userSockets[pid]; if (sid) io.to(sid).emit('matchFound', { matchId: match.id, mode, ranked, map, participants: matchParticipants, timeout: 15000 }); });
      setTimeout(() => {
        const m = pendingMatches.find(m => m.id === match.id);
        if (m && m.status === 'waiting_accept') { m.status = 'cancelled'; pendingMatches.splice(pendingMatches.findIndex(m2 => m2.id === match.id), 1); matchParticipants.forEach(pid => { const sid = userSockets[pid]; if (sid) io.to(sid).emit('matchCancelled', { matchId: match.id }); }); }
      }, 15000);
    }
  });

  socket.on('leaveQueue', ({ mode, ranked }) => {
    const userId = socketToUser[socket.id];
    if (!userId) return;
    const queue = queues[`${mode}_${ranked ? 'ranked' : 'unranked'}`];
    const idx = queue.findIndex(e => e.userId === userId);
    if (idx !== -1) { queue.splice(idx, 1); broadcastQueueState(); }
  });

  socket.on('acceptMatch', ({ matchId }) => {
    const match = pendingMatches.find(m => m.id === matchId);
    if (match && match.status === 'waiting_accept') match.status = 'accepted';
  });

  socket.on('declineMatch', ({ matchId }) => {
    const match = pendingMatches.find(m => m.id === matchId);
    if (match && match.status === 'waiting_accept') {
      match.status = 'cancelled';
      pendingMatches.splice(pendingMatches.findIndex(m => m.id === matchId), 1);
      match.participants.forEach(pid => { const sid = userSockets[pid]; if (sid) io.to(sid).emit('matchCancelled', { matchId: match.id }); });
    }
  });

  socket.on('chatMessage', ({ text }) => {
    const userId = socketToUser[socket.id];
    if (!userId || isMuted(userId)) return;
    const user = users[userId];
    const msg = { user: user?.username || userId, text, date: new Date().toISOString() };
    chatMessages.push(msg);
    if (chatMessages.length > 500) chatMessages.shift();
    broadcastChatMessage(msg);
  });

  socket.on('disconnect', () => {
    const userId = socketToUser[socket.id];
    if (userId) {
      delete userSockets[userId];
      delete socketToUser[socket.id];
      for (const key in queues) { const q = queues[key]; const idx = q.findIndex(e => e.userId === userId); if (idx !== -1) { q.splice(idx, 1); broadcastQueueState(); } }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Сервер запущен на порту ' + PORT);
});
