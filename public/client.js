// client.js — финальная версия для сервера (без Electron)

const socket = io();
let currentUser = null;
let currentParty = null;
let currentMatch = null;
let matchTimerInterval = null;
let activeModal = null;

// ------------------ DOM элементы ------------------
const loginScreen = document.getElementById('loginScreen');
const mainScreen = document.getElementById('mainScreen');
const authMessage = document.getElementById('authMessage');
const nicknameSpan = document.getElementById('nickname');
const profileStatsDiv = document.getElementById('profileStats');
const matchListUl = document.getElementById('matchList');
const friendsListDiv = document.getElementById('friendsList');
const friendRequestsDiv = document.getElementById('friendRequests');
const chatMessagesDiv = document.getElementById('chatMessages');
const privateChatArea = document.getElementById('privateChatArea');
const partyStatusDiv = document.getElementById('partyStatus');
const partyMembersDiv = document.getElementById('partyMembers');
const partyMembersList = document.getElementById('partyMembersList');
const activeMatchInfoDiv = document.getElementById('activeMatchInfo');
const avatarImg = document.getElementById('avatar');
const streakCountSpan = document.getElementById('streakCount');
const tooltip = document.getElementById('profileTooltip');
const profileInfoIcon = document.getElementById('profileInfoIcon');
const tooltipSiteId = document.getElementById('tooltipSiteId');
const tooltipSiteNick = document.getElementById('tooltipSiteNick');
const tooltipGameId = document.getElementById('tooltipGameId');
const tooltipGameNick = document.getElementById('tooltipGameNick');

// ------------------ Вспомогательные функции ------------------
function escapeHtml(str) {
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

async function apiCall(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

function getUserAvatar(user) {
  if (user && user.avatar && user.avatar !== '') return user.avatar;
  return 'https://via.placeholder.com/40?text=Avatar';
}

function getLevelIcon(level) {
  return `<img src="/images/${level}lvl.png" style="width:24px;height:24px;vertical-align:middle;" alt="lvl ${level}">`;
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

function showNotification(message, type = 'info') {
  const container = document.getElementById('notificationContainer');
  if (!container) {
    const newContainer = document.createElement('div');
    newContainer.id = 'notificationContainer';
    newContainer.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 10px;';
    document.body.appendChild(newContainer);
  }
  const notif = document.createElement('div');
  notif.className = `notification ${type}`;
  notif.innerHTML = message;
  notif.style.cssText = `
    background: #1e293b;
    border-left: 4px solid ${type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#3b82f6'};
    padding: 12px 20px;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    color: white;
    font-size: 14px;
    animation: slideIn 0.3s ease;
  `;
  document.getElementById('notificationContainer').appendChild(notif);
  setTimeout(() => {
    notif.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notif.remove(), 300);
  }, 5000);
}

function leaveAllQueues() {
  const modes = ['1v1', '2v2', '5v5'];
  for (const mode of modes) {
    for (const ranked of [true, false]) {
      leaveQueue(mode, ranked);
    }
  }
}

function updateUI() {
  if (!currentUser) return;
  nicknameSpan.innerText = currentUser.username;
  if (avatarImg) avatarImg.src = getUserAvatar(currentUser);
  if (streakCountSpan) streakCountSpan.innerText = currentUser.stats.streak || 0;

  if (tooltipSiteId) tooltipSiteId.innerText = currentUser.id;
  if (tooltipSiteNick) tooltipSiteNick.innerText = currentUser.username;
  if (tooltipGameId) tooltipGameId.innerText = currentUser.inGameId;
  if (tooltipGameNick) tooltipGameNick.innerText = currentUser.inGameNick;

  const stats = currentUser.stats;
  const level1v1 = getLevelByMmr(stats.mmr_1v1);
  const level2v2 = getLevelByMmr(stats.mmr_2v2);
  const level5v5 = getLevelByMmr(stats.mmr_5v5);

  if (profileStatsDiv) {
    profileStatsDiv.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <h3>1x1 Дуэль</h3>
          <div class="stat-row"><span>MMR:</span> <strong>${stats.mmr_1v1}</strong></div>
          <div class="stat-row"><span>Уровень:</span> ${getLevelIcon(level1v1)}</div>
          <div class="stat-row"><span>Матчи:</span> ${stats.matches_1v1}</div>
          <div class="stat-row"><span>Победы:</span> ${stats.wins_1v1}</div>
          <div class="stat-row"><span>Поражения:</span> ${stats.losses_1v1}</div>
          <div class="stat-row"><span>Винрейт:</span> ${stats.matches_1v1 ? Math.round(stats.wins_1v1 / stats.matches_1v1 * 100) : 0}%</div>
        </div>
        <div class="stat-card">
          <h3>2x2 Напарники</h3>
          <div class="stat-row"><span>MMR:</span> <strong>${stats.mmr_2v2}</strong></div>
          <div class="stat-row"><span>Уровень:</span> ${getLevelIcon(level2v2)}</div>
          <div class="stat-row"><span>Матчи:</span> ${stats.matches_2v2}</div>
          <div class="stat-row"><span>Победы:</span> ${stats.wins_2v2}</div>
          <div class="stat-row"><span>Поражения:</span> ${stats.losses_2v2}</div>
          <div class="stat-row"><span>Винрейт:</span> ${stats.matches_2v2 ? Math.round(stats.wins_2v2 / stats.matches_2v2 * 100) : 0}%</div>
        </div>
        <div class="stat-card">
          <h3>5x5 Соревновательный</h3>
          <div class="stat-row"><span>MMR:</span> <strong>${stats.mmr_5v5}</strong></div>
          <div class="stat-row"><span>Уровень:</span> ${getLevelIcon(level5v5)}</div>
          <div class="stat-row"><span>Матчи:</span> ${stats.matches_5v5}</div>
          <div class="stat-row"><span>Победы:</span> ${stats.wins_5v5}</div>
          <div class="stat-row"><span>Поражения:</span> ${stats.losses_5v5}</div>
          <div class="stat-row"><span>Винрейт:</span> ${stats.matches_5v5 ? Math.round(stats.wins_5v5 / stats.matches_5v5 * 100) : 0}%</div>
        </div>
      </div>
    `;
  }

  if (matchListUl) {
    matchListUl.innerHTML = '';
    if (stats.matchHistory.length === 0) {
      matchListUl.innerHTML = '<li>Нет матчей</li>';
    } else {
      stats.matchHistory.forEach(m => {
        const li = document.createElement('li');
        li.innerHTML = `${m.mode} (${m.ranked}) | ${m.map} | ${m.result} | ${m.date}`;
        matchListUl.appendChild(li);
      });
    }
  }
}

// ------------------ Регистрация / Логин ------------------
async function register(username, password, inGameNick, inGameId) {
  const result = await apiCall('/api/register', 'POST', { username, password, inGameNick, inGameId });
  if (result.success) {
    authMessage.innerText = result.message;
    showLoginForm();
  } else {
    authMessage.innerText = result.message;
  }
}

async function login(username, password) {
  const result = await apiCall('/api/login', 'POST', { username, password });
  if (result.success) {
    currentUser = result.userData;
    if (currentUser.stats && currentUser.stats.avatar) {
      currentUser.avatar = currentUser.stats.avatar;
    }
    updateUI();
    loginScreen.style.display = 'none';
    mainScreen.style.display = 'flex';
    socket.emit('auth', currentUser.id);
    loadFriends();
  } else {
    authMessage.innerText = result.message;
  }
}

// ------------------ Аватарка ------------------
async function uploadAvatar(file) {
  const formData = new FormData();
  formData.append('avatar', file);
  formData.append('userId', currentUser.id);
  const res = await fetch('/api/upload-avatar', { method: 'POST', body: formData });
  const data = await res.json();
  if (data.success) {
    currentUser.avatar = data.avatarUrl;
    currentUser.stats.avatar = data.avatarUrl;
    updateUI();
    await apiCall('/api/update-stats', 'POST', { userId: currentUser.id, stats: currentUser.stats });
    showNotification('Аватарка обновлена', 'success');
  } else {
    showNotification('Ошибка загрузки аватарки', 'error');
  }
}

// ------------------ Друзья ------------------
async function loadFriends() {
  if (!currentUser) return;
  // Мои друзья
  if (friendsListDiv) {
    friendsListDiv.innerHTML = '';
    for (const friendId of currentUser.friends || []) {
      const friend = await apiCall(`/api/user/${friendId}`, 'GET');
      if (friend.success) {
        const div = document.createElement('div');
        div.className = 'friend-item';
        div.innerHTML = `
          <img src="${getUserAvatar(friend.userData)}" class="friend-avatar" data-id="${friendId}">
          <span>${escapeHtml(friend.userData.inGameNick)} (${friend.userData.inGameId})</span>
          <div>
            <button class="invite-friend" data-id="${friendId}">Пригласить в пати</button>
            <button class="pm-friend" data-id="${friendId}" data-nick="${friend.userData.inGameNick}">💬</button>
            <button class="remove-friend" data-id="${friendId}">Удалить</button>
          </div>
        `;
        friendsListDiv.appendChild(div);
      }
    }
  }
  // Входящие заявки
  if (friendRequestsDiv) {
    friendRequestsDiv.innerHTML = '';
    for (const requestId of currentUser.pendingRequests || []) {
      const reqUser = await apiCall(`/api/user/${requestId}`, 'GET');
      if (reqUser.success) {
        const div = document.createElement('div');
        div.className = 'friend-item';
        div.innerHTML = `
          <img src="${getUserAvatar(reqUser.userData)}" class="friend-avatar" data-id="${requestId}">
          <span>${escapeHtml(reqUser.userData.inGameNick)} (${reqUser.userData.inGameId})</span>
          <div>
            <button class="accept-request" data-id="${requestId}">Принять</button>
            <button class="reject-request" data-id="${requestId}">Отклонить</button>
          </div>
        `;
        friendRequestsDiv.appendChild(div);
      }
    }
  }

  // Обработчики
  document.querySelectorAll('.friend-avatar').forEach(avatar => {
    avatar.removeEventListener('click', () => {});
    avatar.addEventListener('click', () => showUserProfile(avatar.getAttribute('data-id')));
    addAvatarHoverTooltip(avatar);
  });
  document.querySelectorAll('.invite-friend').forEach(btn => {
    btn.removeEventListener('click', () => {});
    btn.addEventListener('click', () => inviteToParty(btn.getAttribute('data-id')));
  });
  document.querySelectorAll('.pm-friend').forEach(btn => {
    btn.removeEventListener('click', () => {});
    btn.addEventListener('click', () => {
      const friendId = btn.getAttribute('data-id');
      const friendNick = btn.getAttribute('data-nick');
      openPrivateChatModal(friendId, friendNick);
    });
  });
  document.querySelectorAll('.remove-friend').forEach(btn => {
    btn.removeEventListener('click', () => {});
    btn.addEventListener('click', () => removeFriend(btn.getAttribute('data-id')));
  });
  document.querySelectorAll('.accept-request').forEach(btn => {
    btn.removeEventListener('click', () => {});
    btn.addEventListener('click', () => acceptFriendRequest(btn.getAttribute('data-id')));
  });
  document.querySelectorAll('.reject-request').forEach(btn => {
    btn.removeEventListener('click', () => {});
    btn.addEventListener('click', () => rejectFriendRequest(btn.getAttribute('data-id')));
  });
}

async function removeFriend(friendId) {
  const res = await apiCall('/api/remove-friend', 'POST', { userId: currentUser.id, friendId });
  if (res.success) {
    currentUser.friends = currentUser.friends.filter(id => id !== friendId);
    loadFriends();
    showNotification('Друг удалён', 'success');
  } else {
    showNotification('Ошибка удаления друга', 'error');
  }
}

async function acceptFriendRequest(friendId) {
  const res = await apiCall('/api/accept-friend', 'POST', { userId: currentUser.id, friendId });
  if (res.success) {
    currentUser.friends.push(friendId);
    currentUser.pendingRequests = currentUser.pendingRequests.filter(id => id !== friendId);
    loadFriends();
    showNotification('Заявка принята', 'success');
  } else {
    showNotification('Ошибка', 'error');
  }
}

async function rejectFriendRequest(friendId) {
  const res = await apiCall('/api/reject-friend', 'POST', { userId: currentUser.id, friendId });
  if (res.success) {
    currentUser.pendingRequests = currentUser.pendingRequests.filter(id => id !== friendId);
    loadFriends();
    showNotification('Заявка отклонена', 'info');
  } else {
    showNotification('Ошибка', 'error');
  }
}

async function sendFriendRequest(toUserId) {
  const user = await apiCall(`/api/user/${toUserId}`, 'GET');
  if (user.success) {
    const res = await apiCall('/api/send-friend-request', 'POST', { fromUserId: currentUser.id, toInGameId: user.userData.inGameId });
    if (res.success) showNotification('Заявка отправлена', 'success');
    else showNotification(res.message, 'error');
  } else {
    showNotification('Пользователь не найден', 'error');
  }
}

async function showUserProfile(userId) {
  const user = await apiCall(`/api/user/${userId}`, 'GET');
  if (!user.success) return;
  const data = user.userData;
  const level1v1 = getLevelByMmr(data.stats.mmr_1v1);
  const level2v2 = getLevelByMmr(data.stats.mmr_2v2);
  const level5v5 = getLevelByMmr(data.stats.mmr_5v5);
  const modal = document.createElement('div');
  modal.className = 'modal profile-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Профиль игрока</h3>
      <img src="${getUserAvatar(data)}" style="width:80px;height:80px;border-radius:50%;margin:0 auto;">
      <p><strong>Логин:</strong> ${escapeHtml(data.username)}</p>
      <p><strong>Ник в игре:</strong> ${escapeHtml(data.inGameNick)}</p>
      <p><strong>ID в игре:</strong> ${escapeHtml(data.inGameId)}</p>
      <p><strong>1x1:</strong> MMR ${data.stats.mmr_1v1} ${getLevelIcon(level1v1)}</p>
      <p><strong>2x2:</strong> MMR ${data.stats.mmr_2v2} ${getLevelIcon(level2v2)}</p>
      <p><strong>5x5:</strong> MMR ${data.stats.mmr_5v5} ${getLevelIcon(level5v5)}</p>
      ${userId !== currentUser.id ? `<button id="profileAddFriendBtn">Добавить в друзья</button>` : ''}
      <button class="close-modal">Закрыть</button>
    </div>
  `;
  document.body.appendChild(modal);
  if (userId !== currentUser.id) {
    document.getElementById('profileAddFriendBtn').addEventListener('click', () => {
      sendFriendRequest(userId);
      modal.remove();
    });
  }
  modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
}

// ------------------ Тултип для аватарок ------------------
function addAvatarHoverTooltip(element) {
  let tooltipDiv = null;
  const mouseenterHandler = async () => {
    const userId = element.getAttribute('data-id');
    if (!userId) return;
    const user = await apiCall(`/api/user/${userId}`, 'GET');
    if (!user.success) return;
    const rect = element.getBoundingClientRect();
    tooltipDiv = document.createElement('div');
    tooltipDiv.className = 'avatar-tooltip';
    tooltipDiv.innerHTML = `
      <div><strong>Ник на сайте:</strong> ${escapeHtml(user.userData.username)}</div>
      <div><strong>ID на сайте:</strong> ${user.userData.id}</div>
      <div><strong>Ник в игре:</strong> ${escapeHtml(user.userData.inGameNick)}</div>
      <div><strong>ID в игре:</strong> ${user.userData.inGameId}</div>
    `;
    document.body.appendChild(tooltipDiv);
    tooltipDiv.style.left = `${rect.right + 8}px`;
    tooltipDiv.style.top = `${rect.top}px`;
  };
  const mouseleaveHandler = () => {
    if (tooltipDiv) tooltipDiv.remove();
  };
  element.addEventListener('mouseenter', mouseenterHandler);
  element.addEventListener('mouseleave', mouseleaveHandler);
}

// ------------------ Пати ------------------
async function createParty() {
  const res = await apiCall('/api/create-party', 'POST', { leaderId: currentUser.id });
  if (res.success) {
    currentParty = { id: res.partyId, members: [currentUser.id], leaderId: currentUser.id };
    updatePartyUI();
    showNotification(`Пати создана! Код: ${res.partyId}`, 'success');
  } else {
    showNotification(res.message || 'Не удалось создать пати', 'error');
  }
}

async function joinParty(partyCode) {
  const res = await apiCall('/api/join-party', 'POST', { partyId: partyCode, userId: currentUser.id });
  if (res.success) {
    showNotification('Вы присоединились к пати', 'success');
  } else {
    showNotification(res.message || 'Не удалось присоединиться', 'error');
  }
}

async function leaveParty(partyId) {
  const res = await apiCall('/api/leave-party', 'POST', { partyId, userId: currentUser.id });
  if (res.success) {
    currentParty = null;
    updatePartyUI();
    showNotification('Вы вышли из пати', 'info');
  } else {
    showNotification('Не удалось выйти из пати', 'error');
  }
}

function updatePartyUI() {
  if (partyStatusDiv) {
    if (currentParty) {
      partyStatusDiv.innerHTML = `
        Вы в пати (участников: ${currentParty.members.length}) 
        Код пати: <strong>${currentParty.id}</strong>
        <button id="copyPartyCodeBtn" class="copy-code-btn">📋 Скопировать код</button>
        <button id="leavePartyBtn" class="leave-party-btn">Выйти из пати</button>
      `;
      const copyBtn = document.getElementById('copyPartyCodeBtn');
      if (copyBtn) copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(currentParty.id);
        showNotification('Код пати скопирован', 'success');
      });
      const leaveBtn = document.getElementById('leavePartyBtn');
      if (leaveBtn) leaveBtn.addEventListener('click', () => leaveParty(currentParty.id));
    } else {
      partyStatusDiv.innerHTML = '';
    }
  }
  if (partyMembersDiv) {
    if (!currentParty || currentParty.members.length === 0) {
      partyMembersDiv.style.display = 'none';
      return;
    }
    partyMembersDiv.style.display = 'block';
    if (partyMembersList) partyMembersList.innerHTML = '';
    for (const memberId of currentParty.members) {
      if (memberId === currentUser.id) {
        partyMembersList.innerHTML += `<div><img src="${getUserAvatar(currentUser)}" class="mini-avatar" data-id="${memberId}"> ${escapeHtml(currentUser.inGameNick)} (${currentUser.inGameId}) — Вы</div>`;
      } else {
        apiCall(`/api/user/${memberId}`, 'GET').then(user => {
          if (user.success) {
            const div = document.createElement('div');
            div.innerHTML = `
              <img src="${getUserAvatar(user.userData)}" class="mini-avatar" data-id="${memberId}">
              ${escapeHtml(user.userData.inGameNick)} (${user.userData.inGameId})
              <button class="add-friend-from-party" data-id="${memberId}">Добавить в друзья</button>
            `;
            partyMembersList.appendChild(div);
            div.querySelector('.mini-avatar').addEventListener('click', () => showUserProfile(memberId));
            addAvatarHoverTooltip(div.querySelector('.mini-avatar'));
            div.querySelector('.add-friend-from-party').addEventListener('click', () => sendFriendRequest(memberId));
          }
        });
      }
    }
  }
}

async function inviteToParty(friendId) {
  if (!currentParty) {
    showNotification('Сначала создайте пати', 'error');
    return;
  }
  socket.emit('inviteToParty', { partyId: currentParty.id, targetUserId: friendId });
  showNotification('Приглашение отправлено', 'success');
}

function showPartyInvite(invite) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Приглашение в пати</h3>
      <p>${escapeHtml(invite.fromName)} приглашает вас присоединиться к его пати.</p>
      <button id="acceptInviteBtn">Принять</button>
      <button id="declineInviteBtn">Отклонить</button>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('acceptInviteBtn').addEventListener('click', () => {
    socket.emit('acceptPartyInvite', { partyId: invite.partyId });
    modal.remove();
    showNotification('Вы присоединились к пати', 'success');
  });
  document.getElementById('declineInviteBtn').addEventListener('click', () => modal.remove());
}

// ------------------ Очередь ------------------
let queueState = {};

function updateQueueDisplay() {
  if (!currentUser) return;
  const modes = ['1v1', '2v2', '5v5'];
  for (const mode of modes) {
    for (const ranked of [true, false]) {
      const key = `${mode}_${ranked ? 'ranked' : 'unranked'}`;
      const queue = queueState[key] || [];
      const count = queue.length;
      const needed = mode === '1v1' ? 2 : mode === '2v2' ? 4 : 10;
      const countSpan = document.getElementById(`queue-count-${mode}-${ranked ? 'ranked' : 'unranked'}`);
      if (countSpan) countSpan.innerText = `${count}/${needed}`;
      const statusSpan = document.getElementById(`queue-status-${mode}-${ranked ? 'ranked' : 'unranked'}`);
      if (statusSpan) {
        const inQueue = queue.some(entry => entry.userId === currentUser.id);
        statusSpan.innerText = inQueue ? 'В очереди' : 'Не в очереди';
        const leaveBtn = document.querySelector(`.leave-queue-btn[data-mode="${mode}"][data-ranked="${ranked}"]`);
        if (leaveBtn) {
          leaveBtn.style.display = inQueue ? 'inline-block' : 'none';
        }
      }
    }
  }
}

function joinQueue(mode, ranked) {
  if (!currentUser) return;
  socket.emit('joinQueue', { mode, ranked, partyId: currentParty?.id });
}
function leaveQueue(mode, ranked) {
  if (!currentUser) return;
  socket.emit('leaveQueue', { mode, ranked });
}

// ------------------ Матч ------------------
function showMatchFoundModal(match) {
  const oldModal = document.getElementById('matchFoundModal');
  if (oldModal) oldModal.remove();
  if (matchTimerInterval) clearInterval(matchTimerInterval);

  const modal = document.createElement('div');
  modal.id = 'matchFoundModal';
  modal.className = 'match-found-modal';
  modal.innerHTML = `
    <div class="match-found-content">
      <h2>Матч найден!</h2>
      <p>Режим: ${match.mode} ${match.ranked ? 'Ранговый' : 'Обычный'}</p>
      <p>Карта: ${match.map}</p>
      <div class="participants-list" id="matchParticipantsList"></div>
      <div class="timer">Принять матч через: <span id="matchTimer">15</span> сек</div>
      <div class="match-buttons">
        <button id="modalAcceptBtn">Принять</button>
        <button id="modalDeclineBtn">Отклонить</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  activeModal = modal;

  const participantsContainer = document.getElementById('matchParticipantsList');
  for (const pid of match.participants) {
    apiCall(`/api/user/${pid}`, 'GET').then(user => {
      if (user.success) {
        const div = document.createElement('div');
        div.className = 'participant';
        div.innerHTML = `
          <img src="${getUserAvatar(user.userData)}" class="participant-avatar" data-id="${pid}">
          <span class="participant-name">${escapeHtml(user.userData.inGameNick)} (${user.userData.inGameId})</span>
        `;
        participantsContainer.appendChild(div);
        div.querySelector('.participant-avatar').addEventListener('click', () => showUserProfile(pid));
        addAvatarHoverTooltip(div.querySelector('.participant-avatar'));
      }
    });
  }

  let timeLeft = 15;
  const timerSpan = document.getElementById('matchTimer');
  matchTimerInterval = setInterval(() => {
    timeLeft--;
    if (timerSpan) timerSpan.innerText = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(matchTimerInterval);
      declineMatch(match.matchId);
      modal.remove();
    }
  }, 1000);

  document.getElementById('modalAcceptBtn').addEventListener('click', () => {
    clearInterval(matchTimerInterval);
    acceptMatch(match.matchId);
    modal.remove();
  });
  document.getElementById('modalDeclineBtn').addEventListener('click', () => {
    clearInterval(matchTimerInterval);
    declineMatch(match.matchId);
    modal.remove();
  });
}

function showMatchFound(match) {
  currentMatch = match;
  showMatchFoundModal(match);
}

function acceptMatch(matchId) {
  socket.emit('acceptMatch', { matchId });
}

function declineMatch(matchId) {
  socket.emit('declineMatch', { matchId });
  if (activeMatchInfoDiv) activeMatchInfoDiv.style.display = 'none';
  currentMatch = null;
  if (matchTimerInterval) clearInterval(matchTimerInterval);
}

// ------------------ Лобби ------------------
function openLobby(match) {
  if (matchTimerInterval) clearInterval(matchTimerInterval);
  currentMatch = match;
  const lobbyDiv = document.createElement('div');
  lobbyDiv.id = 'lobbyModal';
  lobbyDiv.className = 'modal';
  lobbyDiv.innerHTML = `
    <div class="modal-content">
      <h3>Лобби матча</h3>
      <p>Режим: ${match.mode} ${match.ranked ? 'Ранговый' : 'Обычный'}</p>
      <p>Карта: ${match.map}</p>
      <div style="background: #0f172a; padding: 10px; border-radius: 8px; margin: 10px 0;">
        <strong>⚠️ Инструкция:</strong> После завершения матча загрузите скриншот итогов (победа/поражение). Модератор проверит и начислит MMR.
      </div>
      <div id="lobbyParticipants" style="margin: 10px 0;"></div>
      <div id="lobbyChatMessages" class="lobby-chat"></div>
      <div class="lobby-input">
        <input type="text" id="lobbyChatInput" placeholder="Чат лобби">
        <button id="lobbySendBtn">Отправить</button>
      </div>
      <div id="screenshotArea">
        <input type="file" id="screenshotUpload" accept="image/*">
        <button id="uploadScreenshotBtn">Загрузить скриншот</button>
      </div>
      <button id="closeLobbyBtn">Закрыть</button>
    </div>
  `;
  document.body.appendChild(lobbyDiv);

  const participantsContainer = document.getElementById('lobbyParticipants');
  participantsContainer.innerHTML = '<h4>Участники:</h4>';
  for (const pid of match.participants) {
    apiCall(`/api/user/${pid}`, 'GET').then(user => {
      if (user.success) {
        const div = document.createElement('div');
        div.style.margin = '5px 0';
        div.innerHTML = `
          <img src="${getUserAvatar(user.userData)}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:8px;cursor:pointer;" class="lobby-avatar" data-id="${pid}">
          ${escapeHtml(user.userData.inGameNick)} (ID: ${user.userData.inGameId})
          ${pid !== currentUser.id ? `<button class="add-friend-lobby" data-id="${pid}">Добавить в друзья</button>` : ''}
        `;
        participantsContainer.appendChild(div);
        const avatar = div.querySelector('.lobby-avatar');
        avatar.addEventListener('click', () => showUserProfile(pid));
        addAvatarHoverTooltip(avatar);
        if (pid !== currentUser.id) {
          div.querySelector('.add-friend-lobby').addEventListener('click', () => sendFriendRequest(pid));
        }
      }
    });
  }

  const lobbyInput = document.getElementById('lobbyChatInput');
  const lobbySend = document.getElementById('lobbySendBtn');
  const uploadBtn = document.getElementById('uploadScreenshotBtn');
  const fileInput = document.getElementById('screenshotUpload');
  const closeBtn = document.getElementById('closeLobbyBtn');

  if (lobbySend) lobbySend.addEventListener('click', () => {
    const text = lobbyInput.value.trim();
    if (text) {
      socket.emit('lobbyChat', { matchId: match.matchId, text });
      lobbyInput.value = '';
    }
  });
  if (uploadBtn) uploadBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('screenshot', file);
    formData.append('matchId', match.matchId);
    formData.append('userId', currentUser.id);
    const res = await fetch('/api/upload-screenshot', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      showNotification('Скриншот загружен', 'success');
    } else {
      showNotification('Ошибка загрузки', 'error');
    }
  });
  if (closeBtn) closeBtn.addEventListener('click', () => {
    leaveAllQueues();
    lobbyDiv.remove();
    currentMatch = null;
  });

  socket.on('lobbyMessage', (msg) => {
    const container = document.getElementById('lobbyChatMessages');
    if (!container) return;
    const div = document.createElement('div');
    div.innerHTML = `<strong>${escapeHtml(msg.from)}:</strong> ${escapeHtml(msg.text)} <small>${msg.date}</small>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  });
}

// ------------------ Чат (глобальный) ------------------
function addChatMessage(msg) {
  const div = document.createElement('div');
  div.className = 'chat-message';
  div.innerHTML = `
    <img src="${getUserAvatar({ avatar: msg.avatar })}" class="chat-avatar" data-id="${msg.userId}" style="cursor:pointer;">
    <strong>${escapeHtml(msg.username)}</strong>:
    <span>${escapeHtml(msg.text)}</span>
    <small>${msg.date}</small>
  `;
  chatMessagesDiv.appendChild(div);
  chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
  const avatar = div.querySelector('.chat-avatar');
  avatar.addEventListener('click', () => showUserProfile(msg.userId));
  addAvatarHoverTooltip(avatar);
}

function sendGlobalChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (text && currentUser) {
    socket.emit('chatMessage', text);
    input.value = '';
  }
}

// ------------------ Личные сообщения (отдельное окно с историей) ------------------
let privateHistory = [];

function openPrivateChatModal(userId, userNick) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 500px;">
      <h3>Личный чат с ${escapeHtml(userNick)}</h3>
      <div id="privateChatMessages" class="chat-messages" style="height: 300px;"></div>
      <div class="chat-input">
        <input type="text" id="privateChatInput" placeholder="Сообщение...">
        <button id="privateChatSendBtn">Отправить</button>
      </div>
      <button id="closePrivateChatBtn">Закрыть</button>
    </div>
  `;
  document.body.appendChild(modal);

  const container = document.getElementById('privateChatMessages');
  const input = document.getElementById('privateChatInput');
  const sendBtn = document.getElementById('privateChatSendBtn');
  const closeBtn = document.getElementById('closePrivateChatBtn');

  // Отображаем историю
  const historyForUser = privateHistory.filter(m => (m.from === userId && m.to === currentUser.id) || (m.from === currentUser.id && m.to === userId));
  container.innerHTML = '';
  historyForUser.forEach(msg => {
    const div = document.createElement('div');
    div.className = 'chat-message';
    if (msg.from === currentUser.id) {
      div.innerHTML = `<strong>Вы:</strong> ${escapeHtml(msg.text)} <small>${msg.date}</small>`;
    } else {
      div.innerHTML = `<strong>${escapeHtml(userNick)}:</strong> ${escapeHtml(msg.text)} <small>${msg.date}</small>`;
    }
    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;

  const addMessage = (text, isFromMe) => {
    const div = document.createElement('div');
    div.className = 'chat-message';
    if (isFromMe) {
      div.innerHTML = `<strong>Вы:</strong> ${escapeHtml(text)} <small>${new Date().toLocaleString()}</small>`;
    } else {
      div.innerHTML = `<strong>${escapeHtml(userNick)}:</strong> ${escapeHtml(text)} <small>${new Date().toLocaleString()}</small>`;
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  };

  const privateHandler = (msg) => {
    if ((msg.from === userId && msg.to === currentUser.id) || (msg.from === currentUser.id && msg.to === userId)) {
      addMessage(msg.text, msg.from === currentUser.id);
      privateHistory.push(msg);
    }
  };
  socket.on('privateMessage', privateHandler);

  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (text) {
      socket.emit('privateMessage', { toUserId: userId, text });
      addMessage(text, true);
      input.value = '';
    }
  });
  input.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendBtn.click(); });

  closeBtn.addEventListener('click', () => {
    socket.off('privateMessage', privateHandler);
    modal.remove();
  });
}

// ------------------ Инициализация UI ------------------
function showLoginForm() {
  document.getElementById('loginForm').style.display = 'block';
  document.getElementById('registerForm').style.display = 'none';
}
function showRegisterForm() {
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('registerForm').style.display = 'block';
}

document.getElementById('doLoginBtn').addEventListener('click', () => {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  login(username, password);
});
document.getElementById('doRegisterBtn').addEventListener('click', () => {
  const username = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value;
  const confirm = document.getElementById('regPasswordConfirm').value;
  const inGameNick = document.getElementById('regInGameNick').value.trim();
  const inGameId = document.getElementById('regInGameId').value.trim();
  if (password !== confirm) {
    authMessage.innerText = 'Пароли не совпадают';
    return;
  }
  register(username, password, inGameNick, inGameId);
});
document.getElementById('showRegisterLink').addEventListener('click', (e) => { e.preventDefault(); showRegisterForm(); });
document.getElementById('showLoginLink').addEventListener('click', (e) => { e.preventDefault(); showLoginForm(); });
document.getElementById('logoutBtn').addEventListener('click', () => location.reload());
document.getElementById('createPartyBtn').addEventListener('click', createParty);
document.getElementById('joinPartyBtn').addEventListener('click', () => {
  const partyCode = document.getElementById('joinPartyCode').value.trim();
  if (partyCode) joinParty(partyCode);
});
document.getElementById('chatSendBtn').addEventListener('click', sendGlobalChat);
document.getElementById('chatInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendGlobalChat(); });

// Загрузка аватарки
const changeAvatarBtn = document.getElementById('changeAvatarBtn');
const avatarUpload = document.getElementById('avatarUpload');
if (changeAvatarBtn) {
  changeAvatarBtn.addEventListener('click', () => {
    avatarUpload.click();
  });
}
if (avatarUpload) {
  avatarUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await uploadAvatar(file);
    }
  });
}

// Тултип для иконки info в профиле
if (profileInfoIcon) {
  profileInfoIcon.addEventListener('mouseenter', () => {
    const rect = profileInfoIcon.getBoundingClientRect();
    if (tooltip) {
      tooltip.style.display = 'block';
      tooltip.style.left = `${rect.right + 8}px`;
      tooltip.style.top = `${rect.top}px`;
    }
  });
  profileInfoIcon.addEventListener('mouseleave', () => {
    if (tooltip) tooltip.style.display = 'none';
  });
}

// Навигация по вкладкам
function setupNavigation() {
  const btns = document.querySelectorAll('.nav-btn');
  const views = {
    play: document.getElementById('playView'),
    profile: document.getElementById('profileView'),
    history: document.getElementById('historyView'),
    friends: document.getElementById('friendsView'),
    chat: document.getElementById('chatView')
  };
  btns.forEach(btn => btn.addEventListener('click', () => {
    const view = btn.getAttribute('data-view');
    btns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    Object.values(views).forEach(v => { if (v) v.style.display = 'none'; });
    if (views[view]) views[view].style.display = 'block';
    if (view === 'friends') loadFriends();
  }));
}
setupNavigation();

// Кнопки очереди
function setupQueueButtons() {
  const joinBtns = document.querySelectorAll('.queue-mode-btn');
  joinBtns.forEach(btn => {
    btn.removeEventListener('click', () => {});
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      const ranked = btn.getAttribute('data-ranked') === 'true';
      if (!currentUser) return;
      joinQueue(mode, ranked);
    });
  });
  const leaveBtns = document.querySelectorAll('.leave-queue-btn');
  leaveBtns.forEach(btn => {
    btn.removeEventListener('click', () => {});
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      const ranked = btn.getAttribute('data-ranked') === 'true';
      if (!currentUser) return;
      leaveQueue(mode, ranked);
    });
  });
}
setupQueueButtons();

// ------------------ Socket события ------------------
socket.on('connect', () => console.log('Socket connected'));
socket.on('queueUpdate', (queues) => {
  queueState = queues;
  updateQueueDisplay();
});
socket.on('matchFound', (match) => showMatchFound(match));
socket.on('matchCancelled', () => {
  if (document.getElementById('matchFoundModal')) document.getElementById('matchFoundModal').remove();
  if (matchTimerInterval) clearInterval(matchTimerInterval);
  if (activeMatchInfoDiv) activeMatchInfoDiv.style.display = 'none';
  currentMatch = null;
  showNotification('Матч отменён, кто-то не принял', 'error');
  leaveAllQueues();
});
socket.on('lobbyOpen', (match) => openLobby(match));
socket.on('statsUpdated', (stats) => {
  currentUser.stats = stats;
  if (stats.avatar) currentUser.avatar = stats.avatar;
  updateUI();
  showNotification('Статистика обновлена', 'success');
  leaveAllQueues();
});
socket.on('friendRequest', (data) => {
  showNotification(`Новая заявка в друзья от ${data.fromName}`, 'info');
  if (currentUser) {
    currentUser.pendingRequests.push(data.from);
    loadFriends();
  }
});
socket.on('friendAdded', (friendId) => {
  if (currentUser && !currentUser.friends.includes(friendId)) {
    currentUser.friends.push(friendId);
    loadFriends();
  }
});
socket.on('partyUpdate', (party) => {
  currentParty = party;
  updatePartyUI();
});
socket.on('partyInvite', (invite) => {
  showNotification(`${invite.fromName} приглашает вас в пати`, 'info');
  showPartyInvite(invite);
});
socket.on('chatMessage', (msg) => {
  addChatMessage(msg);
});
socket.on('chatHistory', (history) => {
  chatMessagesDiv.innerHTML = '';
  history.forEach(msg => addChatMessage(msg));
});
socket.on('privateHistory', (history) => {
  privateHistory = history;
});
socket.on('queueError', (err) => showNotification(err.message, 'error'));