let mentionListenerRef = null;
let mentionUnreadByServer = {};
let mentionUnreadByChannel = {};
let createServerInProgress = false;
let dmUnreadByUid = {};
let dmUnreadListenerUnsubs = {};
let dmFriendsListenerRef = null;
let dmUnreadHeartbeatTimer = null;
let dmUnreadVisibilityBound = false;
const DM_UNREAD_WINDOW = 100;
const DM_UNREAD_HEARTBEAT_MS = 5 * 60 * 1000;
const dmPingProfileCache = {};
const dmPingProfilePromises = {};
const serverMembershipWatchers = {};
const serverDataWatchers = {};
const serverRailDataById = {};

function unwatchServerMembership(serverId) {
  const watcher = serverMembershipWatchers[serverId];
  if (!watcher) return;
  watcher.ref.off('value', watcher.handler);
  delete serverMembershipWatchers[serverId];
}

function unwatchServerData(serverId) {
  const watcher = serverDataWatchers[serverId];
  if (!watcher) return;
  watcher.nameRef.off('value', watcher.nameHandler);
  watcher.iconRef.off('value', watcher.iconHandler);
  delete serverDataWatchers[serverId];
  delete serverRailDataById[serverId];
}

function handleServerMembershipRemoved(serverId) {
  if (!serverId) return;
  const wasActive = currentServer === serverId;
  if (currentUser?.uid) {
    db.ref(`userServers/${currentUser.uid}/${serverId}`).remove().catch(() => {});
  }
  if (userServers.includes(serverId)) {
    userServers = userServers.filter(s => s !== serverId);
    saveCookies();
    loadUserServers();
  }
  unwatchServerMembership(serverId);
  unwatchServerData(serverId);
  if (wasActive) {
    goHome();
    showToast('You were removed from that server', 'info');
  }
}

function ensureServerMembershipWatcher(serverId) {
  if (!currentUser || !serverId || serverMembershipWatchers[serverId]) return;
  const ref = db.ref(`servers/${serverId}/members/${currentUser.uid}`);
  const handler = (snapshot) => {
    if (snapshot.exists()) return;
    handleServerMembershipRemoved(serverId);
  };
  ref.on('value', handler);
  serverMembershipWatchers[serverId] = { ref, handler };
}

function syncServerMembershipWatchers() {
  const activeIds = new Set(userServers || []);
  Object.keys(serverMembershipWatchers).forEach((serverId) => {
    if (!activeIds.has(serverId)) {
      unwatchServerMembership(serverId);
    }
  });
  activeIds.forEach((serverId) => ensureServerMembershipWatcher(serverId));
}

function ensureServerDataWatcher(serverId) {
  if (!serverId || serverDataWatchers[serverId]) return;
  const nameRef = db.ref(`servers/${serverId}/name`);
  const iconRef = db.ref(`servers/${serverId}/icon`);
  serverRailDataById[serverId] = serverRailDataById[serverId] || { name: 'Server', icon: null };

  const renderServerIcon = () => {
    if (!userServers.includes(serverId)) return;
    const serverData = serverRailDataById[serverId] || {};
    let div = elements.serverList.querySelector(`[data-server="${serverId}"]`);
    if (!div) {
      div = document.createElement('div');
      div.className = 'server-icon' + (serverId === currentServer ? ' active' : '');
      div.setAttribute('data-server', serverId);
      div.onclick = () => selectServer(serverId);
      elements.serverList.appendChild(div);
    }
    div.title = serverData.name || 'Server';

    if (serverData.icon) {
      div.innerHTML = `<img src="${serverData.icon}" alt="" loading="lazy" decoding="async">`;
    } else {
      div.innerHTML = `<span>${(serverData.name || 'S').charAt(0).toUpperCase()}</span>`;
    }
    refreshMentionBadges();
  };

  const nameHandler = (snap) => {
    const val = snap.val();
    serverRailDataById[serverId] = serverRailDataById[serverId] || {};
    serverRailDataById[serverId].name = (typeof val === 'string' && val.trim()) ? val : 'Server';
    renderServerIcon();
  };
  const iconHandler = (snap) => {
    const val = snap.val();
    serverRailDataById[serverId] = serverRailDataById[serverId] || {};
    serverRailDataById[serverId].icon = typeof val === 'string' ? val : null;
    renderServerIcon();
  };

  nameRef.on('value', nameHandler);
  iconRef.on('value', iconHandler);
  serverDataWatchers[serverId] = { nameRef, iconRef, nameHandler, iconHandler };
}

function syncServerDataWatchers() {
  const activeIds = new Set(userServers || []);
  Object.keys(serverDataWatchers).forEach((serverId) => {
    if (!activeIds.has(serverId)) {
      unwatchServerData(serverId);
    }
  });
  activeIds.forEach((serverId) => ensureServerDataWatcher(serverId));
}

function getMentionChannelKey(serverId, channelName) {
  return `${serverId}::${channelName}`;
}

function formatMentionCount(count) {
  const safe = Number(count) || 0;
  if (safe <= 0) return '';
  if (safe > 99) return '99+';
  return String(safe);
}

function refreshMentionBadges() {
  // Server badges
  document.querySelectorAll('.server-icon[data-server]').forEach(serverEl => {
    const serverId = serverEl.getAttribute('data-server');
    const count = mentionUnreadByServer[serverId] || 0;
    let badge = serverEl.querySelector('.server-mention-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'server-mention-badge';
        serverEl.appendChild(badge);
      }
      badge.textContent = formatMentionCount(count);
    } else if (badge) {
      badge.remove();
    }
  });

  // Channel badges (current server text channels only)
  if (currentServer) {
    document.querySelectorAll('.channel-item[data-channel][data-channel-type="text"]').forEach(channelEl => {
      const channelName = channelEl.getAttribute('data-channel');
      const key = getMentionChannelKey(currentServer, channelName);
      const count = mentionUnreadByChannel[key] || 0;
      let badge = channelEl.querySelector('.channel-mention-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'channel-mention-badge';
          channelEl.appendChild(badge);
        }
        badge.textContent = formatMentionCount(count);
      } else if (badge) {
        badge.remove();
      }
    });
  }
}

function startMentionWatcher() {
  if (!currentUser) return;
  if (mentionListenerRef) {
    mentionListenerRef.off();
    mentionListenerRef = null;
  }

  mentionListenerRef = db.ref(`mentions/${currentUser.uid}`);
  mentionListenerRef.on('value', (snapshot) => {
    const root = snapshot.val() || {};
    const nextServerCounts = {};
    const nextChannelCounts = {};

    Object.entries(root).forEach(([serverId, channels]) => {
      let serverCount = 0;
      Object.entries(channels || {}).forEach(([channelName, messages]) => {
        const count = Object.keys(messages || {}).length;
        if (count <= 0) return;
        serverCount += count;
        nextChannelCounts[getMentionChannelKey(serverId, channelName)] = count;
      });
      if (serverCount > 0) {
        nextServerCounts[serverId] = serverCount;
      }
    });

    mentionUnreadByServer = nextServerCounts;
    mentionUnreadByChannel = nextChannelCounts;
    refreshMentionBadges();

    // Auto-read mentions for the channel currently open in UI.
    if (currentChannelType === 'text' && currentServer && currentChannel) {
      const currentKey = getMentionChannelKey(currentServer, currentChannel);
      if ((nextChannelCounts[currentKey] || 0) > 0) {
        markChannelMentionsRead(currentServer, currentChannel);
      }
    }
  });
}

function markChannelMentionsRead(serverId, channelName) {
  if (!currentUser || !serverId || !channelName) return;
  const key = getMentionChannelKey(serverId, channelName);
  const channelCount = mentionUnreadByChannel[key] || 0;
  if (channelCount <= 0) return;

  delete mentionUnreadByChannel[key];
  mentionUnreadByServer[serverId] = Math.max(0, (mentionUnreadByServer[serverId] || 0) - channelCount);
  if (mentionUnreadByServer[serverId] <= 0) {
    delete mentionUnreadByServer[serverId];
  }
  refreshMentionBadges();

  db.ref(`mentions/${currentUser.uid}/${serverId}/${channelName}`).remove().catch((error) => {
    console.error('[Mentions] Failed to mark channel read:', error);
  });
}

function setDmRead(dmId, timestamp = Date.now()) {
  return setDmReadState(dmId, timestamp, '');
}

function setDmReadState(dmId, timestamp = Date.now(), key = '') {
  if (!currentUser || !dmId) return Promise.resolve();
  return db.ref(`dmReads/${currentUser.uid}/${dmId}`).set({
    timestamp: Number(timestamp) || 0,
    key: String(key || '')
  }).catch(() => {});
}

function parseDmReadState(raw) {
  if (raw && typeof raw === 'object') {
    return {
      timestamp: Number(raw.timestamp) || 0,
      key: String(raw.key || '')
    };
  }
  return {
    timestamp: Number(raw) || 0,
    key: ''
  };
}

function isMessageUnreadForReadState(messageTs, messageKey, readState) {
  const ts = Number(messageTs) || 0;
  const key = String(messageKey || '');
  const readTs = Number(readState?.timestamp) || 0;
  const readKey = String(readState?.key || '');
  if (key && readKey) return key > readKey;
  if (ts > readTs) return true;
  if (ts < readTs) return false;
  if (!key || !readKey) return false;
  return key > readKey;
}

function ensureDmReadStateKey(dmId, friendUid, messages, readState) {
  if (!dmId || !friendUid) return Promise.resolve(readState);
  const currentKey = String(readState?.key || '');
  if (currentKey) return Promise.resolve(readState);

  const readTs = Number(readState?.timestamp) || 0;
  if (readTs <= 0) return Promise.resolve(readState);

  let derivedKey = '';
  Object.entries(messages || {}).forEach(([msgKey, msg]) => {
    if (!msg || msg.uid !== friendUid) return;
    const ts = Number(msg.timestamp) || 0;
    if (ts <= readTs && String(msgKey) > derivedKey) {
      derivedKey = String(msgKey);
    }
  });

  if (!derivedKey) return Promise.resolve(readState);
  return setDmReadState(dmId, readTs, derivedKey).then(() => ({
    timestamp: readTs,
    key: derivedKey
  }));
}

function markDmReadToLatest(dmId) {
  if (!currentUser || !dmId) return Promise.resolve();
  const peerUid = dmId.split('_').find(uid => uid !== currentUser.uid) || null;
  return db.ref(`dms/${dmId}/messages`).orderByKey().limitToLast(DM_UNREAD_WINDOW).once('value').then((snapshot) => {
    const messages = snapshot.val() || {};
    let latestTs = 0;
    let latestKey = '';
    Object.entries(messages).forEach(([msgKey, msg]) => {
      const ts = Number(msg?.timestamp) || 0;
      if (peerUid && msg?.uid !== peerUid) return;
      if (String(msgKey) > latestKey || (!latestKey && (ts > latestTs || (ts === latestTs && String(msgKey) > latestKey)))) {
        latestTs = ts;
        latestKey = String(msgKey);
      }
    });
    return setDmReadState(dmId, latestTs || 0, latestKey);
  }).catch(() => {});
}

function clearDmUnreadListeners() {
  Object.values(dmUnreadListenerUnsubs).forEach(unsub => {
    if (typeof unsub === 'function') unsub();
  });
  dmUnreadListenerUnsubs = {};
}

function getDmPingProfile(uid) {
  if (!uid) return Promise.resolve(null);
  if (dmPingProfileCache[uid]) return Promise.resolve(dmPingProfileCache[uid]);
  if (dmPingProfilePromises[uid]) return dmPingProfilePromises[uid];

  const promise = db.ref(`profiles/${uid}`).once('value').then((snap) => {
    const profile = snap.val() || {};
    const data = {
      username: profile.username || 'Unknown',
      avatar: profile.avatar || null
    };
    dmPingProfileCache[uid] = data;
    delete dmPingProfilePromises[uid];
    return data;
  }).catch(() => {
    delete dmPingProfilePromises[uid];
    return null;
  });

  dmPingProfilePromises[uid] = promise;
  return promise;
}

function renderDmServerRail() {
  if (!elements.serverList) return;
  elements.serverList.querySelectorAll('.dm-ping-icon').forEach(el => el.remove());

  const divider = elements.serverList.querySelector('.server-divider');
  if (!divider) return;

  const unreadEntries = Object.entries(dmUnreadByUid)
    .map(([uid, count]) => [uid, Number(count) || 0])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  const parent = divider.parentElement;
  if (!parent) return;
  unreadEntries.slice(0, 8).forEach(([uid, count]) => {
    const icon = document.createElement('div');
    const isActiveDm = currentChannelType === 'dm' && currentDmUser && currentDmUser.uid === uid;
    icon.className = `server-icon dm-ping-icon${isActiveDm ? ' active' : ''}`;
    icon.setAttribute('data-dm-ping-uid', uid);
    icon.title = `${count} unread DM${count === 1 ? '' : 's'}`;
    icon.innerHTML = `
      <span class="dm-ping-fallback">?</span>
      <span class="dm-ping-badge">${formatMentionCount(count)}</span>
    `;
    icon.onclick = () => openDm(uid, { username: dmPingProfileCache[uid]?.username || 'User' });
    parent.insertBefore(icon, divider);

    getDmPingProfile(uid).then((profile) => {
      const target = elements.serverList.querySelector(`.dm-ping-icon[data-dm-ping-uid="${uid}"]`);
      if (!target || !profile) return;
      const fallback = target.querySelector('.dm-ping-fallback');
      if (profile.avatar) {
        target.innerHTML = `
          <img src="${profile.avatar}" alt="" loading="lazy" decoding="async">
          <span class="dm-ping-badge">${formatMentionCount(Number(dmUnreadByUid[uid]) || 0)}</span>
        `;
      } else if (fallback) {
        fallback.textContent = (profile.username || 'U').charAt(0).toUpperCase();
      }
      target.title = `${profile.username || 'User'} • ${Number(dmUnreadByUid[uid]) || 0} unread`;
    });
  });
}

function renderDmUnreadForUser(friendUid) {
  if (!elements.directMessagesList) return;
  const row = elements.directMessagesList.querySelector(`[data-dm-uid="${friendUid}"]`);
  if (!row) return;
  let badge = row.querySelector('.dm-unread-badge');
  const count = Number(dmUnreadByUid[friendUid]) || 0;
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'dm-unread-badge';
      badge.style.cssText = 'min-width:18px;height:18px;border-radius:999px;background:#f23f43;color:#fff;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;';
      const holder = row.querySelector(`[data-dm-meta="${friendUid}"]`);
      if (holder) holder.prepend(badge);
    }
    badge.textContent = formatMentionCount(count);
  } else if (badge) {
    badge.remove();
  }
}

function startDmUnreadWatcher(friendUid) {
  if (!currentUser || !friendUid) return;
  const dmId = getDmId(currentUser.uid, friendUid);
  if (!dmId || dmUnreadListenerUnsubs[friendUid]) return;

  const messagesRef = db.ref(`dms/${dmId}/messages`);
  const messagesQuery = messagesRef.orderByKey().limitToLast(DM_UNREAD_WINDOW);
  const handler = (snapshot) => {
    const messages = snapshot.val() || {};
    db.ref(`dmReads/${currentUser.uid}/${dmId}`).once('value').then(readSnap => {
      const parsedReadState = parseDmReadState(readSnap.val());
      return ensureDmReadStateKey(dmId, friendUid, messages, parsedReadState).then((readState) => ({ readState }));
    }).then(({ readState }) => {
      let unread = 0;
      let latestIncomingTs = Number(readState.timestamp) || 0;
      let latestIncomingKey = String(readState.key || '');
      Object.entries(messages).forEach(([msgKey, msg]) => {
        const ts = Number(msg?.timestamp) || 0;
        const key = String(msgKey || '');
        if (msg && msg.uid === friendUid && (key > latestIncomingKey || (!latestIncomingKey && (ts > latestIncomingTs || (ts === latestIncomingTs && key > latestIncomingKey))))) {
          latestIncomingTs = ts;
          latestIncomingKey = key;
        }
        if (msg && msg.uid !== currentUser.uid && isMessageUnreadForReadState(ts, key, readState)) unread += 1;
      });

      const isOpenDm = currentChannelType === 'dm' && currentChannel === dmId;
      if (isOpenDm) {
        dmUnreadByUid[friendUid] = 0;
        if (latestIncomingTs > readState.timestamp || (latestIncomingTs === readState.timestamp && latestIncomingKey > readState.key)) {
          setDmReadState(dmId, latestIncomingTs, latestIncomingKey);
        }
      } else {
        dmUnreadByUid[friendUid] = unread;
      }
      renderDmUnreadForUser(friendUid);
      renderDmServerRail();
    }).catch(() => {});
  };

  messagesQuery.on('value', handler);
  dmUnreadListenerUnsubs[friendUid] = () => messagesQuery.off('value', handler);
}

function refreshAllDmUnreadNow() {
  if (!currentUser) return Promise.resolve();
  return db.ref(`friends/${currentUser.uid}`).once('value').then((snapshot) => {
    const friends = snapshot.val() || {};
    const friendUids = Object.keys(friends);
    const tasks = friendUids.map((friendUid) => {
      const dmId = getDmId(currentUser.uid, friendUid);
      if (!dmId) return Promise.resolve();
      return Promise.all([
        db.ref(`dms/${dmId}/messages`).orderByKey().limitToLast(DM_UNREAD_WINDOW).once('value'),
        db.ref(`dmReads/${currentUser.uid}/${dmId}`).once('value')
      ]).then(([messagesSnap, readSnap]) => {
        const messages = messagesSnap.val() || {};
        const parsedReadState = parseDmReadState(readSnap.val());
        return ensureDmReadStateKey(dmId, friendUid, messages, parsedReadState).then((readState) => {
          let unread = 0;
          let latestIncomingTs = Number(readState.timestamp) || 0;
          let latestIncomingKey = String(readState.key || '');
          Object.entries(messages).forEach(([msgKey, msg]) => {
            const ts = Number(msg?.timestamp) || 0;
            const key = String(msgKey || '');
            if (msg && msg.uid === friendUid && (key > latestIncomingKey || (!latestIncomingKey && (ts > latestIncomingTs || (ts === latestIncomingTs && key > latestIncomingKey))))) {
              latestIncomingTs = ts;
              latestIncomingKey = key;
            }
            if (msg && msg.uid !== currentUser.uid && isMessageUnreadForReadState(ts, key, readState)) unread += 1;
          });
          const isOpenDm = currentChannelType === 'dm' && currentChannel === dmId;
          if (isOpenDm) {
            dmUnreadByUid[friendUid] = 0;
            if (latestIncomingTs > readState.timestamp || (latestIncomingTs === readState.timestamp && latestIncomingKey > readState.key)) {
              return setDmReadState(dmId, latestIncomingTs, latestIncomingKey);
            }
          } else {
            dmUnreadByUid[friendUid] = unread;
          }
        });
      }).catch(() => {});
    });
    return Promise.all(tasks).then(() => {
      renderDmServerRail();
    });
  }).catch(() => {});
}

function startGlobalDmUnreadWatcher() {
  if (!currentUser) return;
  if (dmFriendsListenerRef) return;

  refreshAllDmUnreadNow();

  if (!dmUnreadHeartbeatTimer) {
    dmUnreadHeartbeatTimer = setInterval(() => {
      if (document.hidden) return;
      refreshAllDmUnreadNow();
    }, DM_UNREAD_HEARTBEAT_MS);
  }
  if (!dmUnreadVisibilityBound) {
    dmUnreadVisibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshAllDmUnreadNow();
      }
    });
    window.addEventListener('focus', () => {
      refreshAllDmUnreadNow();
    });
  }

  dmFriendsListenerRef = db.ref(`friends/${currentUser.uid}`);
  dmFriendsListenerRef.on('value', (snapshot) => {
    const friends = snapshot.val() || {};
    const friendUids = Object.keys(friends);
    const activeFriendSet = new Set(friendUids);

    Object.keys(dmUnreadListenerUnsubs).forEach(uid => {
      if (activeFriendSet.has(uid)) return;
      const unsub = dmUnreadListenerUnsubs[uid];
      if (typeof unsub === 'function') unsub();
      delete dmUnreadListenerUnsubs[uid];
      delete dmUnreadByUid[uid];
    });

    friendUids.forEach(uid => {
      startDmUnreadWatcher(uid);
    });

    renderDmServerRail();
    refreshAllDmUnreadNow();
  });
}

function syncUnreadOnLeavingDm(dmId) {
  if (!dmId) return;
  markDmReadToLatest(dmId).then(() => {
    refreshAllDmUnreadNow();
  });
}

// Server Management
function loadUserServers() {
  elements.serverList.innerHTML = `
    <div class="server-icon home" onclick="goHome()" title="Home"><i class="fa-solid fa-house"></i></div>
    <div class="server-icon home" onclick="goDiscovery()" title="Discovery"><i class="fa-solid fa-compass"></i></div>
    <div class="server-divider"></div>
  `;

  syncServerMembershipWatchers();
  syncServerDataWatchers();

  if (userServers.length === 0) {
    elements.serverList.innerHTML += '<div style="color:#949ba4;text-align:center;padding:20px;font-size:11px;">No servers</div>';
  } else {
    userServers.forEach((serverId) => ensureServerDataWatcher(serverId));
  }

  const addBtn = document.createElement('div');
  addBtn.className = 'server-icon add-server';
  addBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
  addBtn.title = 'Add a Server';
  addBtn.onclick = () => showModal('serverChooser');
  elements.serverList.appendChild(addBtn);

  if (typeof refreshPresenceForServers === 'function') {
    refreshPresenceForServers();
  }
  refreshMentionBadges();
  renderDmServerRail();
}

function goDiscovery() {
  if (currentChannelType === 'dm' && currentChannel) {
    syncUnreadOnLeavingDm(currentChannel);
  } else {
    refreshAllDmUnreadNow();
  }
  currentServer = null;
  currentChannel = null;
  currentChannelType = 'dm';
  currentDmId = null;
  currentDmUser = null;
  isHomeView = false;
  isDiscoveryView = true;
  forceJoinModal = false;
  if (rolesListRef) {
    rolesListRef.off();
    rolesListRef = null;
  }
  rolesCache = {};
  messageListeners.forEach(ref => ref.off());
  messageListeners = [];
  elements.typingIndicator.classList.remove('active');
  if (elements.serverName) elements.serverName.textContent = 'Discovery';
  elements.textChannelsList.innerHTML = '';
  elements.voiceChannelsList.innerHTML = '';
  if (elements.directMessagesList) elements.directMessagesList.innerHTML = '';
  if (elements.friendRequestsList) elements.friendRequestsList.innerHTML = '';

  if (elements.textChannelsList) elements.textChannelsList.parentElement.style.display = 'none';
  if (elements.voiceChannelsList) elements.voiceChannelsList.parentElement.style.display = 'none';
  if (elements.directMessagesCategory) elements.directMessagesCategory.style.display = 'none';
  if (elements.friendRequestsCategory) elements.friendRequestsCategory.style.display = 'none';
  if (elements.discoveryCategory) elements.discoveryCategory.style.display = 'block';

  const inviteBtn = document.getElementById('inviteBtn');
  if (inviteBtn) inviteBtn.style.display = 'none';
  if (elements.addFriendBtn) elements.addFriendBtn.style.display = 'none';
  if (elements.backToChooserBtn) elements.backToChooserBtn.style.display = isOnboarding ? 'inline-flex' : 'none';
  if (elements.discoveryJoinBtn) elements.discoveryJoinBtn.style.display = 'inline-flex';
  if (elements.dmCallBtn) elements.dmCallBtn.style.display = 'none';
  const memberBtn = document.getElementById('memberListBtn');
  if (memberBtn) memberBtn.style.display = 'none';
  if (elements.memberList) elements.memberList.style.display = 'none';

  elements.headerIcon.innerHTML = '<i class="fa-solid fa-compass"></i>';
  elements.currentChannelName.textContent = 'Discovery';
  document.getElementById('headerDivider').style.display = 'none';
  document.getElementById('channelTopic').textContent = '';

  elements.messagesArea.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon"><i class="fa-solid fa-compass"></i></div>
      <h3>Server Discovery</h3>
      <p>Select a server on the left to see details.</p>
    </div>
  `;
  elements.messageInput.disabled = true;
  elements.messageInput.placeholder = 'Discovery';

  document.querySelectorAll('.server-icon').forEach(icon => icon.classList.remove('active'));

  loadDiscoveryList();
}

function backToServerChooser() {
  if (!isOnboarding) {
    goHome();
    return;
  }
  showModal('welcome');
}

function selectServer(serverId) {
  if (!serverId) return;
  if (currentChannelType === 'dm' && currentChannel) {
    syncUnreadOnLeavingDm(currentChannel);
  } else {
    refreshAllDmUnreadNow();
  }

  currentServer = serverId;
  currentChannel = null;
  currentChannelType = 'text';
  currentDmId = null;
  currentDmUser = null;
  isHomeView = false;
  isDiscoveryView = false;
  saveCookies();

  if (rolesListRef) {
    rolesListRef.off();
    rolesListRef = null;
  }
  rolesListRef = db.ref(`servers/${currentServer}/roles`);
  rolesListRef.on('value', (snap) => {
    rolesCache = snap.val() || {};
  });

  setHomeView(false);

  // Update active state
  document.querySelectorAll('.server-icon').forEach(icon => {
    icon.classList.remove('active');
    if (icon.getAttribute('data-server') === serverId) {
      icon.classList.add('active');
    }
  });

  // Load only the fields needed for switching server (avoid full server subtree read).
  Promise.all([
    db.ref(`servers/${serverId}/name`).once('value'),
    db.ref(`servers/${serverId}/ownerId`).once('value'),
    db.ref(`servers/${serverId}/members/${currentUser.uid}`).once('value')
  ]).then(([nameSnap, ownerSnap, memberSnap]) => {
    if (!nameSnap.exists()) {
      // Clean up missing servers from local list
      userServers = userServers.filter(s => s !== serverId);
      unwatchServerMembership(serverId);
      unwatchServerData(serverId);
      saveCookies();
      loadUserServers();
      if (userServers.length === 0) goHome();
      return;
    }

    const serverName = nameSnap.val() || 'Server';
    currentServerOwnerId = ownerSnap.val() || null;

    if (elements.serverName) elements.serverName.textContent = serverName;

    const addChannelServerName = document.getElementById('addChannelServerName');
    if (addChannelServerName) addChannelServerName.textContent = serverName;

    const addVoiceChannelServerName = document.getElementById('addVoiceChannelServerName');
    if (addVoiceChannelServerName) addVoiceChannelServerName.textContent = serverName;

    if (!memberSnap.exists()) {
      handleServerMembershipRemoved(serverId);
      return;
    }

    const memberData = memberSnap.val() || {};
    userProfile.role = memberData.role || 'Member';
    updateUserDisplay();
    loadChannels();
    if (elements.memberList.style.display !== 'none') {
      loadMemberList();
    }
  });
}

function goHome() {
  if (currentChannelType === 'dm' && currentChannel) {
    syncUnreadOnLeavingDm(currentChannel);
  } else {
    refreshAllDmUnreadNow();
  }
  if (isOnboarding && userServers.length === 0) {
    showModal('welcome');
    showToast('Finish setup first', 'error');
    return;
  }
  currentServer = null;
  currentChannel = null;
  currentChannelType = 'dm';
  currentDmId = null;
  currentDmUser = null;
  isHomeView = true;
  isDiscoveryView = false;
  if (rolesListRef) {
    rolesListRef.off();
    rolesListRef = null;
  }
  rolesCache = {};
  messageListeners.forEach(ref => ref.off());
  messageListeners = [];
  elements.typingIndicator.classList.remove('active');
  if (elements.serverName) elements.serverName.textContent = 'Home';
  elements.textChannelsList.innerHTML = '';
  elements.voiceChannelsList.innerHTML = '';
  if (elements.directMessagesList) elements.directMessagesList.innerHTML = '';
  elements.messagesArea.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon"><i class="fa-solid fa-house"></i></div>
      <h3>Direct Messages</h3>
      <p>Select a friend to start chatting, or add a new friend.</p>
    </div>
  `;
  elements.voicePanel.classList.remove('active');
  elements.messageInput.disabled = true;
  elements.messageInput.placeholder = 'Select a friend to send messages';
  if (elements.dmCallBtn) elements.dmCallBtn.style.display = 'none';
  document.querySelectorAll('.server-icon').forEach(icon => icon.classList.remove('active'));
  const homeIcon = document.querySelector('.server-icon.home');
  if (homeIcon) homeIcon.classList.add('active');

  setHomeView(true);
  loadDirectMessages();
}

function setHomeView(isHome) {
  if (elements.textChannelsList) elements.textChannelsList.parentElement.style.display = isHome ? 'none' : 'block';
  if (elements.voiceChannelsList) elements.voiceChannelsList.parentElement.style.display = isHome ? 'none' : 'block';
  if (elements.directMessagesCategory) elements.directMessagesCategory.style.display = isHome ? 'block' : 'none';
  if (elements.friendRequestsCategory) elements.friendRequestsCategory.style.display = isHome ? 'block' : 'none';
  if (elements.discoveryCategory) elements.discoveryCategory.style.display = 'none';

  const inviteBtn = document.getElementById('inviteBtn');
  if (inviteBtn) inviteBtn.style.display = isHome ? 'none' : 'inline-flex';
  if (elements.addFriendBtn) elements.addFriendBtn.style.display = isHome ? 'inline-flex' : 'none';
  if (elements.discoveryJoinBtn) elements.discoveryJoinBtn.style.display = 'none';
  if (elements.backToChooserBtn) elements.backToChooserBtn.style.display = 'none';

  const memberBtn = document.getElementById('memberListBtn');
  if (memberBtn) memberBtn.style.display = isHome ? 'none' : 'inline-flex';
  if (elements.memberList) elements.memberList.style.display = isHome ? 'none' : elements.memberList.style.display;

  if (isHome) {
    elements.headerIcon.innerHTML = '<i class="fa-solid fa-comment-dots"></i>';
    elements.currentChannelName.textContent = 'Direct Messages';
    document.getElementById('headerDivider').style.display = 'none';
    document.getElementById('channelTopic').textContent = '';
  }
}

function loadDirectMessages() {
  if (!currentUser || !elements.directMessagesList) return;

  elements.directMessagesList.innerHTML = '';
  if (elements.friendRequestsList) elements.friendRequestsList.innerHTML = '';
  Object.values(dmProfileListeners).forEach(unsub => {
    if (typeof unsub === 'function') unsub();
  });
  dmProfileListeners = {};
  db.ref(`friends/${currentUser.uid}`).on('value', (snap) => {
    const friends = snap.val() || {};
    elements.directMessagesList.innerHTML = '';

    const friendUids = Object.keys(friends);
    const activeFriendSet = new Set(friendUids);
    Object.keys(dmUnreadListenerUnsubs).forEach(uid => {
      if (activeFriendSet.has(uid)) return;
      const unsub = dmUnreadListenerUnsubs[uid];
      if (typeof unsub === 'function') unsub();
      delete dmUnreadListenerUnsubs[uid];
      delete dmUnreadByUid[uid];
    });
    if (friendUids.length === 0) {
      elements.directMessagesList.innerHTML = '<div style="color:#949ba4;padding:8px 12px;font-size:12px;">No friends yet</div>';
      clearDmUnreadListeners();
      dmUnreadByUid = {};
      renderDmServerRail();
      return;
    }

    friendUids.forEach(uid => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (currentDmUser && currentDmUser.uid === uid ? ' active' : '');
      div.setAttribute('data-dm-uid', uid);
      const unreadCount = Number(dmUnreadByUid[uid]) || 0;
      const unreadBadge = unreadCount > 0
        ? `<span class="dm-unread-badge" style="min-width:18px;height:18px;border-radius:999px;background:#f23f43;color:#fff;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;">${formatMentionCount(unreadCount)}</span>`
        : '';
      div.innerHTML = `
        <span class="channel-icon dm-list-avatar" data-dm-avatar="${uid}">?</span>
        <span class="dm-user-main">
          <span class="dm-user-name" data-uid="${uid}">Loading...</span>
          <span class="dm-user-status-line">
            <span class="dm-user-status-dot offline" data-dm-status-dot="${uid}"></span>
            <span class="dm-user-status-text" data-dm-status-text="${uid}">offline</span>
          </span>
        </span>
        <span style="margin-left:auto;display:flex;align-items:center;gap:6px;" data-dm-meta="${uid}">
          ${unreadBadge}
          <button class="action-btn delete" style="display:none;" data-remove="${uid}" title="Remove Friend"><i class="fa-solid fa-xmark"></i></button>
        </span>
      `;
      div.onclick = () => openDm(uid, { username: div.querySelector(`[data-uid="${uid}"]`).textContent || 'Unknown' });
      div.addEventListener('mouseenter', () => {
        const btn = div.querySelector(`[data-remove="${uid}"]`);
        if (btn) btn.style.display = 'inline-flex';
      });
      div.addEventListener('mouseleave', () => {
        const btn = div.querySelector(`[data-remove="${uid}"]`);
        if (btn) btn.style.display = 'none';
      });
      const removeBtn = div.querySelector(`[data-remove="${uid}"]`);
      if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeFriend(uid);
        });
      }
      elements.directMessagesList.appendChild(div);

      const profileRef = db.ref(`profiles/${uid}`);
      const handler = profileRef.on('value', (profileSnap) => {
        const profile = profileSnap.val() || {};
        const username = profile.username || 'Unknown';
        const nameEl = div.querySelector(`[data-uid="${uid}"]`);
        if (nameEl) nameEl.textContent = username;
        const statusDotEl = div.querySelector(`[data-dm-status-dot="${uid}"]`);
        const statusTextEl = div.querySelector(`[data-dm-status-text="${uid}"]`);
        const rawStatus = String(profile.status || 'offline').toLowerCase();
        const lastSeen = Number(profile.lastSeen || 0);
        const isOnline = !!(lastSeen && (Date.now() - lastSeen < 60000) && rawStatus !== 'offline');
        const statusClass = !isOnline ? 'offline' : (rawStatus === 'idle' ? 'idle' : rawStatus === 'dnd' ? 'dnd' : 'online');
        const statusLabel = statusClass === 'idle'
          ? 'idle'
          : statusClass === 'dnd'
            ? 'do not disturb'
            : statusClass === 'online'
              ? 'online'
              : 'offline';
        if (statusDotEl) {
          statusDotEl.className = `dm-user-status-dot ${statusClass}`;
        }
        if (statusTextEl) {
          statusTextEl.textContent = statusLabel;
        }
        const avatarEl = div.querySelector(`[data-dm-avatar="${uid}"]`);
        if (avatarEl) {
          if (profile.avatar) {
            avatarEl.innerHTML = `<img src="${profile.avatar}" style="width:100%;height:100%;object-fit:cover;" loading="lazy" decoding="async">`;
          } else {
            avatarEl.textContent = username.charAt(0).toUpperCase();
          }
        }
        if (currentDmUser && currentDmUser.uid === uid) {
          currentDmUser.username = username;
          elements.currentChannelName.textContent = username;
          elements.messageInput.placeholder = `Message @${username}`;
        }
      });
      dmProfileListeners[uid] = () => profileRef.off('value', handler);
      startDmUnreadWatcher(uid);
      renderDmUnreadForUser(uid);
    });
    renderDmServerRail();
  });

  // Friend requests
  db.ref(`friendRequests/${currentUser.uid}`).on('value', (snap) => {
    const requests = snap.val() || {};
    if (!elements.friendRequestsList) return;
    elements.friendRequestsList.innerHTML = '';

    const requestUids = Object.keys(requests);
    if (requestUids.length === 0) {
      elements.friendRequestsList.innerHTML = '<div style="color:#949ba4;padding:8px 12px;font-size:12px;">No requests</div>';
      return;
    }

    requestUids.forEach(uid => {
      const req = requests[uid] || {};
      const username = req.username || 'Unknown';
      const div = document.createElement('div');
      div.className = 'channel-item';
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
      div.style.alignItems = 'center';
      div.innerHTML = `
        <span>${username}</span>
        <span style="display:flex;gap:6px;">
          <button class="action-btn" style="padding:4px 8px;" data-action="accept"><i class="fa-solid fa-check"></i></button>
          <button class="action-btn delete" style="padding:4px 8px;" data-action="decline"><i class="fa-solid fa-xmark"></i></button>
        </span>
      `;
      div.querySelector('[data-action="accept"]').addEventListener('click', () => acceptFriendRequest(uid, username));
      div.querySelector('[data-action="decline"]').addEventListener('click', () => declineFriendRequest(uid));
      elements.friendRequestsList.appendChild(div);
    });
  });
}

function removeFriend(targetUid) {
  if (!currentUser || !targetUid) return;
  if (!confirm('Remove this friend?')) return;
  const updates = {};
  updates[`friends/${currentUser.uid}/${targetUid}`] = null;
  updates[`friends/${targetUid}/${currentUser.uid}`] = null;

  db.ref().update(updates).then(() => {
    showToast('Friend removed', 'success');
    if (currentDmUser && currentDmUser.uid === targetUid) {
      currentDmUser = null;
      currentDmId = null;
      elements.messagesArea.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon"><i class="fa-solid fa-comment-dots"></i></div>
          <h3>Direct Messages</h3>
          <p>Select a friend to start chatting.</p>
        </div>
      `;
      elements.messageInput.disabled = true;
      elements.messageInput.placeholder = 'Select a friend to send messages';
    }
    loadDirectMessages();
  }).catch(err => {
    showToast('Failed to remove friend: ' + err.message, 'error');
  });
}

function loadDiscoveryList() {
  if (!elements.discoveryList) return;
  elements.discoveryList.innerHTML = '';

  db.ref('servers').once('value').then(snap => {
    const servers = snap.val() || {};
    const entries = Object.entries(servers).filter(([, data]) => data && data.discoverable);
    if (entries.length === 0) {
      elements.discoveryList.innerHTML = '<div style="color:#949ba4;padding:8px 12px;font-size:12px;">No servers yet</div>';
      return;
    }

    entries.forEach(([serverId, data]) => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (selectedDiscoveryId === serverId ? ' active' : '');
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.gap = '8px';
      div.innerHTML = `
        <div style="width:28px;height:28px;border-radius:8px;background:#2b2d31;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">
          ${data.icon ? `<img src="${data.icon}" style="width:100%;height:100%;object-fit:cover;" loading="lazy" decoding="async">` : `<span style="font-weight:700;color:#dbdee1;">${(data.name || 'S').charAt(0).toUpperCase()}</span>`}
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <div style="font-weight:600;color:#dbdee1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${data.name || 'Server'}</div>
          <div style="color:#949ba4;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${data.description || 'No description'}</div>
        </div>
      `;
      div.onclick = () => showDiscoveryDetails(serverId, data);
      elements.discoveryList.appendChild(div);
    });
  });
}

function showDiscoveryDetails(serverId, data) {
  selectedDiscoveryId = serverId;
  loadDiscoveryList();
  const name = data?.name || 'Server';
  const desc = data?.description || 'No description';
  const memberCount = data?.members ? Object.keys(data.members).length : 0;
  const icon = data?.icon ? `<img src="${data.icon}" style="width:64px;height:64px;border-radius:14px;object-fit:cover;" loading="lazy" decoding="async">` : `<div style="width:64px;height:64px;border-radius:14px;background:#2b2d31;display:flex;align-items:center;justify-content:center;font-weight:700;">${name.charAt(0).toUpperCase()}</div>`;
  elements.messagesArea.innerHTML = `
    <div class="empty-state" style="text-align:left;align-items:flex-start;">
      <div style="display:flex;gap:16px;align-items:center;">
        ${icon}
        <div>
          <h3 style="margin:0;">${name}</h3>
          <p style="margin-top:6px;color:#949ba4;">${desc}</p>
          <p style="margin-top:6px;color:#949ba4;">${memberCount} members</p>
        </div>
      </div>
      <button class="input-btn" style="margin-top:16px;" onclick="joinServerById('${serverId}')">Join Server</button>
    </div>
  `;
}

function openDm(targetUid, profile) {
  if (!currentUser) return;
  if (currentChannelType === 'dm' && currentChannel && currentDmUser && currentDmUser.uid !== targetUid) {
    syncUnreadOnLeavingDm(currentChannel);
  }
  currentServer = null;
  currentDmId = getDmId(currentUser.uid, targetUid);
  currentDmUser = { uid: targetUid, ...(profile || {}) };
  currentChannelType = 'dm';
  currentChannel = currentDmId;
  isHomeView = true;

  setHomeView(true);
  elements.headerIcon.innerHTML = '<i class="fa-solid fa-comment-dots"></i>';
  elements.currentChannelName.textContent = currentDmUser.username || 'Direct Message';
  document.getElementById('headerDivider').style.display = 'none';
  document.getElementById('channelTopic').textContent = '';
  elements.messageInput.disabled = false;
  elements.messageInput.placeholder = `Message @${currentDmUser.username || 'user'}`;
  if (elements.dmCallBtn) elements.dmCallBtn.style.display = 'inline-flex';
  dmUnreadByUid[targetUid] = 0;
  markDmReadToLatest(currentDmId).then(() => {
    refreshAllDmUnreadNow();
  });
  renderDmServerRail();

  loadMessages();
  loadDirectMessages();
}

function getDmId(uidA, uidB) {
  return [uidA, uidB].sort().join('_');
}

function addFriend() {
  const input = document.getElementById('friendUsernameInput');
  const username = input ? input.value.trim() : '';
  if (!username) {
    showToast('Enter a username', 'error');
    return;
  }

  findUserByUsername(username).then(target => {
    if (!target) {
      showToast('User not found', 'error');
      return;
    }
    addFriendByUid(target.uid, target.username);
    if (input) input.value = '';
    hideModal('addFriend');
  });
}

function addFriendByUid(targetUid, username) {
  if (!currentUser) return;
  if (targetUid === currentUser.uid) {
    showToast('You cannot add yourself', 'error');
    return;
  }

  const requestRef = db.ref(`friendRequests/${targetUid}/${currentUser.uid}`);
  const alreadyFriendRef = db.ref(`friends/${currentUser.uid}/${targetUid}`);

  alreadyFriendRef.once('value').then(snap => {
    if (snap.exists()) {
      showToast('You are already friends', 'info');
      return;
    }

    requestRef.once('value').then(reqSnap => {
      if (reqSnap.exists()) {
        showToast('Friend request already sent', 'info');
        return;
      }

      requestRef.set({
        username: userProfile.username,
        timestamp: Date.now()
      }).then(() => {
        showToast(`Friend request sent to ${username || 'user'}`, 'success');
      }).catch(err => {
        showToast('Failed to send request: ' + err.message, 'error');
      });
    });
  });
}

function acceptFriendRequest(fromUid, username) {
  if (!currentUser) return;
  const updates = {};
  updates[`friends/${currentUser.uid}/${fromUid}`] = true;
  updates[`friends/${fromUid}/${currentUser.uid}`] = true;
  updates[`friendRequests/${currentUser.uid}/${fromUid}`] = null;

  db.ref().update(updates).then(() => {
    showToast(`You are now friends with ${username || 'user'}`, 'success');
    loadDirectMessages();
  }).catch(err => {
    showToast('Failed to accept request: ' + err.message, 'error');
  });
}

function declineFriendRequest(fromUid) {
  if (!currentUser) return;
  db.ref(`friendRequests/${currentUser.uid}/${fromUid}`).remove()
    .then(() => {
      showToast('Request declined', 'info');
      loadDirectMessages();
    })
    .catch(err => {
      showToast('Failed to decline request: ' + err.message, 'error');
    });
}

function findUserByUsername(username) {
  const target = username.toLowerCase();

  return db.ref('users').once('value').then(snapshot => {
    const users = snapshot.val() || {};
    let found = null;
    Object.entries(users).some(([uid, name]) => {
      if (name && name.toLowerCase() === target) {
        found = { uid, username: name };
        return true;
      }
      return false;
    });
    return found;
  }).then(found => {
    if (found) return found;
    // Fallback to profiles if users list is missing
    return db.ref('profiles').once('value').then(profileSnap => {
      const profiles = profileSnap.val() || {};
      let foundProfile = null;
      Object.entries(profiles).some(([uid, profile]) => {
        if (profile?.username && profile.username.toLowerCase() === target) {
          foundProfile = { uid, username: profile.username };
          return true;
        }
        return false;
      });
      return foundProfile;
    });
  });
}

function isServerNameTaken(name, excludeServerId = null) {
  const normalizedName = (name || '').trim().toLowerCase();
  if (!normalizedName) return Promise.resolve(false);

  return db.ref('servers').once('value').then(snapshot => {
    const servers = snapshot.val() || {};
    return Object.entries(servers).some(([serverId, data]) => {
      if (excludeServerId && serverId === excludeServerId) return false;
      const existingName = data && typeof data.name === 'string'
        ? data.name.trim().toLowerCase()
        : '';
      return existingName === normalizedName;
    });
  });
}

function setCreateServerPending(pending) {
  createServerInProgress = !!pending;
  const btn = document.getElementById('createServerBtn');
  if (!btn) return;
  if (!btn.dataset.defaultText) {
    btn.dataset.defaultText = btn.textContent || 'Create Server';
  }
  btn.disabled = createServerInProgress;
  btn.textContent = createServerInProgress ? 'Creating...' : btn.dataset.defaultText;
}

function createServer() {
  if (createServerInProgress) return;
  const serverNameInput = document.getElementById('serverNameInput');
  const name = serverNameInput ? serverNameInput.value.trim() : '';
  
  if (!name) {
    showToast('Please enter a server name', 'error');
    return;
  }
  if (name.length > LIMITS.serverName) {
    showToast(`Server name max ${LIMITS.serverName} characters`, 'error');
    return;
  }
  if (userServers.length >= 10) {
    showToast('Server limit reached (10)', 'error');
    return;
  }

  setCreateServerPending(true);

  isServerNameTaken(name).then(taken => {
    if (taken) {
      showToast('A server with that name already exists', 'error');
      setCreateServerPending(false);
      return;
    }

    const serverId = 'server_' + Date.now();
    const serverIconInput = document.getElementById('serverIconInput');
    const file = serverIconInput ? serverIconInput.files[0] : null;

    const finalizeCreation = (iconUrl = null) => {
      const serverData = {
        name: name,
        icon: iconUrl,
        description: '',
        createdAt: Date.now(),
        invite: generateInviteCode(),
        ownerId: currentUser.uid,
        systemChannel: 'general',
        discoverable: false,
        roles: {
          Admin: { permissions: ['manage_server', 'manage_channels', 'manage_messages', 'manage_roles', 'send_messages', 'view_channels', 'mention_everyone', 'use_commands'], color: '#f23f43', hoist: true },
          Moderator: { permissions: ['manage_messages', 'send_messages', 'view_channels', 'mention_everyone', 'use_commands'], color: '#5865f2', hoist: true },
          Member: { permissions: ['send_messages', 'view_channels', 'use_commands'], color: '#949ba4', hoist: false }
        }
      };

      db.ref(`servers/${serverId}`).set(serverData).then(() => {
        const updates = {};
        updates[`servers/${serverId}/channels/general`] = true;
        updates[`servers/${serverId}/channels/welcome`] = true;
        updates[`servers/${serverId}/voiceChannels/General`] = { limit: 0, createdAt: Date.now() };
        updates[`servers/${serverId}/members/${currentUser.uid}`] = {
          username: userProfile.username,
          role: 'Admin',
          joinedAt: Date.now()
        };
        updates[`userServers/${currentUser.uid}/${serverId}`] = true;
        updates[`inviteIndex/${serverData.invite}`] = serverId;
        return db.ref().update(updates);
      }).then(() => {
        sendSystemMessage(serverId, `Welcome to ${name}! This is the beginning of the server.`);

        userServers.push(serverId);
        saveCookies();
        loadUserServers();
        selectServer(serverId);
        hideModal('addServer');
        isOnboarding = false;
        forceJoinModal = false;
        
        if (serverNameInput) serverNameInput.value = '';
        if (serverIconInput) serverIconInput.value = '';
        const serverIconLabel = document.getElementById('serverIconLabel');
        if (serverIconLabel) serverIconLabel.textContent = 'Click to upload server icon';
        
        showToast('Server created successfully!', 'success');
        setCreateServerPending(false);
      }).catch((error) => {
        showToast('Failed to create server: ' + error.message, 'error');
        setCreateServerPending(false);
      });
    };

    if (file) {
      compressImageFile(file, { maxSize: 256, quality: 0.7, type: 'image/jpeg' })
        .then(dataUrl => finalizeCreation(dataUrl))
        .catch(() => finalizeCreation());
    } else {
      finalizeCreation();
    }
  }).catch(err => {
    showToast('Failed to validate server name: ' + err.message, 'error');
    setCreateServerPending(false);
  });
}

function sendSystemMessage(serverId, text) {
  if (!serverId) return;
  db.ref(`servers/${serverId}/systemChannel`).once('value').then(snap => {
    const channel = snap.val() || 'general';
    db.ref(`servers/${serverId}/channels_data/${channel}/messages`).push({
      author: 'System',
      text: text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      role: 'System',
      roleColor: '#23a559',
      uid: 'system',
      timestamp: Date.now()
    });
  });
}

function normalizeInviteCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function joinServerByInviteCode(code, options = {}) {
  const normalizedCode = normalizeInviteCode(code);
  const closeInviteModal = options.closeInviteModal !== false;
  const clearInput = options.clearInput !== false;

  if (!normalizedCode) {
    showToast('Please enter an invite code', 'error');
    return Promise.resolve(false);
  }
  if (!currentUser) {
    showToast('You must be signed in to join a server', 'error');
    return Promise.resolve(false);
  }
  if (userServers.length >= 10) {
    showToast('Server limit reached (10)', 'error');
    return Promise.resolve(false);
  }

  return db.ref(`inviteIndex/${normalizedCode}`).once('value').then((inviteSnap) => {
    let foundServer = inviteSnap.val() || null;
    if (foundServer) return foundServer;
    return db.ref('servers').once('value').then(snapshot => {
      const servers = snapshot.val() || {};
      let fallbackServer = null;
      Object.entries(servers).forEach(([id, data]) => {
        if (fallbackServer) return;
        const invite = normalizeInviteCode(data?.invite);
        if (invite && invite === normalizedCode) fallbackServer = id;
      });
      if (fallbackServer) {
        db.ref(`inviteIndex/${normalizedCode}`).set(fallbackServer).catch(() => {});
      }
      return fallbackServer;
    });
  }).then((foundServer) => {
    if (!foundServer) {
      showToast('Invalid invite code', 'error');
      return false;
    }

    if (userServers.includes(foundServer)) {
      showToast('You are already in this server', 'info');
      selectServer(foundServer);
      return false;
    }

    return db.ref(`servers/${foundServer}`).once('value').then((serverSnap) => {
      const serverData = serverSnap.val() || null;
      const serverInvite = normalizeInviteCode(serverData?.invite || '');
      if (!serverData || serverInvite !== normalizedCode) {
        db.ref(`inviteIndex/${normalizedCode}`).remove().catch(() => {});
        showToast('Invalid invite code', 'error');
        return false;
      }

      return db.ref(`servers/${foundServer}/joinRole`).once('value').then(joinRoleSnap => {
        const joinRole = joinRoleSnap.val() || 'Member';
        const updates = {};
        updates[`servers/${foundServer}/members/${currentUser.uid}`] = {
          username: userProfile.username,
          role: joinRole,
          joinedAt: Date.now()
        };
        updates[`userServers/${currentUser.uid}/${foundServer}`] = true;
        return db.ref().update(updates).then(() => {
          sendSystemMessage(foundServer, `${userProfile.username} joined the server.`);

          userServers.push(foundServer);
          saveCookies();
          loadUserServers();
          selectServer(foundServer);
          if (closeInviteModal) hideModal('invite');
          if (clearInput) {
            const joinCodeInput = document.getElementById('joinCodeInput');
            if (joinCodeInput) joinCodeInput.value = '';
          }
          isOnboarding = false;
          forceJoinModal = false;
          showToast('Successfully joined server!', 'success');
          return true;
        });
      });
    });
  }).catch(error => {
    showToast('Failed to join server: ' + error.message, 'error');
    return false;
  });
}

function joinServer() {
  const joinCodeInput = document.getElementById('joinCodeInput');
  const code = joinCodeInput ? joinCodeInput.value : '';
  joinServerByInviteCode(code, { closeInviteModal: true, clearInput: true });
}

function joinServerById(serverId) {
  if (!serverId || !currentUser) return;
  if (userServers.includes(serverId)) {
    showToast('You are already in this server', 'info');
    selectServer(serverId);
    return;
  }
  if (userServers.length >= 10) {
    showToast('Server limit reached (10)', 'error');
    return;
  }

  db.ref(`servers/${serverId}`).once('value').then(snap => {
    if (!snap.exists()) {
      showToast('Server not found', 'error');
      return;
    }
    const serverData = snap.val() || {};
    if (!serverData.discoverable) {
      showToast('Server is not discoverable', 'error');
      return;
    }

    db.ref(`servers/${serverId}/joinRole`).once('value').then(joinRoleSnap => {
      const joinRole = joinRoleSnap.val() || 'Member';
      const updates = {};
      updates[`servers/${serverId}/members/${currentUser.uid}`] = {
        username: userProfile.username,
        role: joinRole,
        joinedAt: Date.now()
      };
      updates[`userServers/${currentUser.uid}/${serverId}`] = true;
      db.ref().update(updates).then(() => {
        sendSystemMessage(serverId, `${userProfile.username} joined the server.`);

        userServers.push(serverId);
        saveCookies();
        loadUserServers();
        selectServer(serverId);
        showToast('Successfully joined server!', 'success');
        isOnboarding = false;
        forceJoinModal = false;
      });
    });
  });
}

function joinOfficialServer() {
  const code = 'GE83GAOJ';
  if (userServers.length >= 10) {
    return;
  }
  db.ref(`inviteIndex/${code}`).once('value').then((snap) => {
    const indexedServer = snap.val() || null;
    if (indexedServer) return indexedServer;
    return db.ref('servers').once('value').then((snapshot) => {
      const servers = snapshot.val() || {};
      let fallbackServer = null;
      Object.entries(servers).forEach(([id, data]) => {
        if (fallbackServer) return;
        if (normalizeInviteCode(data?.invite) === code) fallbackServer = id;
      });
      if (fallbackServer) {
        db.ref(`inviteIndex/${code}`).set(fallbackServer).catch(() => {});
      }
      return fallbackServer;
    });
  }).then((foundServer) => {
    if (!foundServer || userServers.includes(foundServer)) return;
    const updates = {};
    updates[`servers/${foundServer}/members/${currentUser.uid}`] = {
      username: userProfile.username,
      role: 'Member',
      joinedAt: Date.now()
    };
    updates[`userServers/${currentUser.uid}/${foundServer}`] = true;
    db.ref().update(updates).then(() => {
      userServers.push(foundServer);
      saveCookies();

      if (!currentServer) {
        currentServer = foundServer;
        initializeApp();
      }
    });
  });
}

function leaveServer() {
  if (userServers.length <= 1) {
    showToast('You cannot leave your last server', 'error');
    return;
  }

  if (!confirm('Are you sure you want to leave this server?')) return;

  if (currentUser && currentServerOwnerId && currentUser.uid === currentServerOwnerId) {
    // Owner leaving deletes the server for everyone
    db.ref(`servers/${currentServer}`).remove().then(() => {
      showToast('Server deleted (owner left)', 'success');
      if (currentUser?.uid) {
        db.ref(`userServers/${currentUser.uid}/${currentServer}`).remove().catch(() => {});
      }
      userServers = userServers.filter(s => s !== currentServer);
      saveCookies();
      const newServer = userServers[0];
      if (newServer) {
        selectServer(newServer);
      } else {
        goHome();
      }
    }).catch(err => {
      showToast('Failed to delete server: ' + err.message, 'error');
    });
    return;
  }

  sendSystemMessage(currentServer, `${userProfile.username} left the server.`);

  const serverId = currentServer;
  const updates = {};
  updates[`servers/${serverId}/members/${currentUser.uid}`] = null;
  updates[`userServers/${currentUser.uid}/${serverId}`] = null;
  db.ref().update(updates).then(() => {
    checkAndDeleteServer(serverId);
  });
  userServers = userServers.filter(s => s !== currentServer);
  saveCookies();

  const newServer = userServers[0];
  selectServer(newServer);
  hideModal('serverMenu');
}

function checkAndDeleteServer(serverId) {
  if (!serverId) return;
  db.ref(`servers/${serverId}/members`).once('value').then(snap => {
    const members = snap.val() || {};
    const count = Object.keys(members).length;
    if (count === 0) {
      db.ref(`servers/${serverId}`).remove()
        .then(() => {
          console.log('[Server] Removed empty server:', serverId);
        })
        .catch(err => {
          console.error('[Server] Failed to remove empty server:', err);
        });
    }
  });
}

// Channel Management
