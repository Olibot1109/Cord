let slowmodeTimer = null;
let slowmodeUntil = 0;
const messageProfileCache = {};
const messageProfilePromises = {};
const MESSAGE_LIMIT = 100;
const mentionCache = {};
let mentionUsers = [];
let mentionActive = false;
let mentionStartIndex = 0;
let mentionSelectedIndex = 0;
let mentionListenersSet = false;
let typingListenerRef = null;

function getMessageProfile(uid) {
  if (!uid) return Promise.resolve(null);
  if (messageProfileCache[uid]) return Promise.resolve(messageProfileCache[uid]);
  if (messageProfilePromises[uid]) return messageProfilePromises[uid];

  const promise = db.ref(`profiles/${uid}`).once('value').then(snap => {
    const profile = snap.val() || {};
    const data = {
      username: profile.username || 'Unknown',
      avatar: profile.avatar || null
    };
    messageProfileCache[uid] = data;
    delete messageProfilePromises[uid];
    return data;
  }).catch(() => {
    delete messageProfilePromises[uid];
    return null;
  });

  messageProfilePromises[uid] = promise;
  return promise;
}

function setSendControlsDisabled(disabled) {
  if (elements.messageInput) {
    elements.messageInput.disabled = disabled;
  }
  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn) {
    sendBtn.disabled = disabled;
  }
}

function clearSlowmodeNotice() {
  if (slowmodeTimer) {
    clearInterval(slowmodeTimer);
    slowmodeTimer = null;
  }
  slowmodeUntil = 0;
  if (elements.slowmodeNotice) {
    elements.slowmodeNotice.textContent = '';
    elements.slowmodeNotice.classList.remove('active');
  }
  const shouldDisable = !(currentChannelType === 'text' || currentChannelType === 'dm');
  setSendControlsDisabled(shouldDisable);
}

function startSlowmodeCountdown(remainingMs) {
  if (!elements.slowmodeNotice) return;

  const targetUntil = Date.now() + remainingMs;
  slowmodeUntil = Math.max(slowmodeUntil, targetUntil);

  if (slowmodeTimer) {
    clearInterval(slowmodeTimer);
  }

  const update = () => {
    const remaining = Math.max(0, slowmodeUntil - Date.now());
    if (remaining <= 0) {
      clearSlowmodeNotice();
      return;
    }
    const seconds = Math.ceil(remaining / 1000);
    elements.slowmodeNotice.textContent = `Slowmode: wait ${seconds}s`;
    elements.slowmodeNotice.classList.add('active');
    setSendControlsDisabled(true);
  };

  update();
  slowmodeTimer = setInterval(update, 250);
}

function pruneMessages(messagesRef, keep = MESSAGE_LIMIT) {
  return messagesRef.once('value').then(snap => {
    const messages = snap.val() || {};
    const items = Object.entries(messages).map(([key, msg]) => {
      const ts = msg && typeof msg === 'object' ? Number(msg.timestamp) || 0 : 0;
      return [ts, key];
    });

    if (items.length <= keep) return;

    items.sort((a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : 1));
    const toDelete = items.slice(0, Math.max(0, items.length - keep));
    const updates = {};
    toDelete.forEach(([, key]) => {
      updates[key] = null;
    });
    if (Object.keys(updates).length > 0) {
      return messagesRef.update(updates);
    }
  }).catch(() => {
    // Ignore prune failures (permissions/offline)
  });
}

function extractMentions(text) {
  if (!text) return [];
  const regex = /@([A-Za-z0-9_]{1,32})/g;
  const found = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    if (name && name !== 'everyone' && name !== 'here') {
      found.add(name);
    }
  }
  return Array.from(found);
}

function formatMentions(text) {
  return text.replace(/@([A-Za-z0-9_]{1,32})/g, (match) => {
    return `<span class="mention-pill">${match}</span>`;
  });
}

function getMentionDropdown() {
  return document.getElementById('mentionDropdown');
}

function setMentionUsersForContext() {
  if (currentChannelType === 'dm') {
    mentionUsers = currentDmUser ? [{ uid: currentDmUser.uid, username: currentDmUser.username || 'User' }] : [];
    return;
  }
  if (!currentServer) {
    mentionUsers = [];
    return;
  }
  db.ref(`servers/${currentServer}/members`).once('value').then(snap => {
    const members = snap.val() || {};
    mentionUsers = Object.entries(members).map(([uid, data]) => ({
      uid,
      username: (data && data.username) || 'Unknown'
    })).sort((a, b) => a.username.localeCompare(b.username));
  });
}

function renderMentionDropdown(items) {
  const dropdown = getMentionDropdown();
  if (!dropdown) return;
  if (!items || items.length === 0) {
    dropdown.style.display = 'none';
    return;
  }
  dropdown.innerHTML = items.map((item, idx) => {
    const initial = item.username ? item.username.charAt(0).toUpperCase() : '?';
    const activeClass = idx === mentionSelectedIndex ? ' active' : '';
    return `
      <div class="mention-item${activeClass}" data-mention-index="${idx}">
        <div class="mention-avatar" data-mention-avatar="${item.uid}">${initial}</div>
        <div>${escapeHtml(item.username || 'Unknown')}</div>
      </div>
    `;
  }).join('');
  dropdown.style.display = 'block';

  dropdown.querySelectorAll('.mention-item').forEach(itemEl => {
    itemEl.addEventListener('click', () => {
      const idx = Number(itemEl.dataset.mentionIndex || 0);
      applyMentionSelection(items[idx]);
    });
  });

  items.forEach(item => {
    if (!item.uid) return;
    getMessageProfile(item.uid).then(profile => {
      if (!profile || !profile.avatar) return;
      const avatarEl = dropdown.querySelector(`[data-mention-avatar="${item.uid}"]`);
      if (avatarEl) {
        avatarEl.innerHTML = `<img src="${profile.avatar}">`;
      }
    });
  });
}

function updateMentionSuggestions(inputValue, cursorIndex, keepIndex = false) {
  const dropdown = getMentionDropdown();
  if (!dropdown) return;
  const uptoCursor = inputValue.slice(0, cursorIndex);
  const atIndex = uptoCursor.lastIndexOf('@');
  if (atIndex === -1) {
    mentionActive = false;
    dropdown.style.display = 'none';
    return;
  }
  if (atIndex > 0 && !/\\s/.test(uptoCursor[atIndex - 1])) {
    mentionActive = false;
    dropdown.style.display = 'none';
    return;
  }
  const query = uptoCursor.slice(atIndex + 1);
  if (query.includes(' ') || query.includes('\\n')) {
    mentionActive = false;
    dropdown.style.display = 'none';
    return;
  }

  mentionActive = true;
  mentionStartIndex = atIndex;
  if (!keepIndex) mentionSelectedIndex = 0;

  const q = query.toLowerCase();
  const items = mentionUsers.filter(u => u.username && u.username.toLowerCase().startsWith(q));
  renderMentionDropdown(items.slice(0, 8));
}

function applyMentionSelection(item) {
  if (!item || !elements.messageInput) return;
  const input = elements.messageInput;
  const value = input.value;
  const cursor = input.selectionStart || value.length;
  const before = value.slice(0, mentionStartIndex);
  const after = value.slice(cursor);
  const insertion = `@${item.username} `;
  const nextValue = `${before}${insertion}${after}`;
  input.value = nextValue;
  const nextCursor = before.length + insertion.length;
  input.setSelectionRange(nextCursor, nextCursor);
  mentionActive = false;
  const dropdown = getMentionDropdown();
  if (dropdown) dropdown.style.display = 'none';
  input.focus();
}

function ensureMentionAutocomplete() {
  if (mentionListenersSet || !elements.messageInput) return;
  mentionListenersSet = true;

  elements.messageInput.addEventListener('input', () => {
    const cursor = elements.messageInput.selectionStart || 0;
    updateMentionSuggestions(elements.messageInput.value, cursor);
  });

  elements.messageInput.addEventListener('keydown', (e) => {
    if (!mentionActive) return;
    const dropdown = getMentionDropdown();
    if (!dropdown || dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionSelectedIndex = Math.min(mentionSelectedIndex + 1, dropdown.querySelectorAll('.mention-item').length - 1);
      updateMentionSuggestions(elements.messageInput.value, elements.messageInput.selectionStart || 0, true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionSelectedIndex = Math.max(mentionSelectedIndex - 1, 0);
      updateMentionSuggestions(elements.messageInput.value, elements.messageInput.selectionStart || 0, true);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const items = dropdown.querySelectorAll('.mention-item');
      const itemEl = items[mentionSelectedIndex];
      if (itemEl) {
        const idx = Number(itemEl.dataset.mentionIndex || 0);
        const filtered = mentionUsers.filter(u => u.username && u.username.toLowerCase().startsWith((elements.messageInput.value.slice(mentionStartIndex + 1, elements.messageInput.selectionStart || 0)).toLowerCase()));
        applyMentionSelection(filtered[idx]);
      }
    }
  });

  elements.messageInput.addEventListener('blur', () => {
    const dropdown = getMentionDropdown();
    if (dropdown) dropdown.style.display = 'none';
    mentionActive = false;
  });
}

function notifyMentions() {
  return;
}

function loadMessages() {
  if (!currentChannel) return;

  elements.messagesArea.innerHTML = '';
  clearSlowmodeNotice();
  ensureMentionAutocomplete();
  setMentionUsersForContext();

  // Remove old listeners
  messageListeners.forEach(ref => ref.off());
  messageListeners = [];
  if (typingListenerRef) {
    typingListenerRef.off();
    typingListenerRef = null;
  }

  const messagesRef = currentChannelType === 'dm'
    ? db.ref(`dms/${currentChannel}/messages`)
    : db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages`);
  messageListeners.push(messagesRef);
  pruneMessages(messagesRef);

  // Listen for new messages
  messagesRef.on('child_added', (snap) => {
    const msg = snap.val();
    if (msg) addMessage(snap.key, msg);
  });

  // Listen for deleted messages
  messagesRef.on('child_removed', (snap) => {
    const msgEl = document.getElementById(`msg-${snap.key}`);
    if (msgEl) msgEl.remove();
  });

  // Listen for edits/reactions
  messagesRef.on('child_changed', (snap) => {
    const msg = snap.val();
    if (!msg) return;
    updateMessageReactions(snap.key, msg.reactions || {});
  });

  // Typing indicator
  if (currentChannelType === 'text') {
    typingListenerRef = db.ref(`servers/${currentServer}/channels_data/${currentChannel}/typing`);
    typingListenerRef.on('value', (snap) => {
      const typers = snap.val() || {};
      const names = Object.values(typers)
        .filter(t => t.timestamp > Date.now() - 5000 && t.username !== userProfile.username)
        .map(t => t.username);

      if (names.length > 0) {
        elements.typingIndicator.classList.add('active');
        const text = names.length === 1 ? `${names[0]} is typing...` :
          names.length === 2 ? `${names[0]} and ${names[1]} are typing...` :
            'Several people are typing...';
        document.getElementById('typingText').textContent = text;
      } else {
        elements.typingIndicator.classList.remove('active');
      }
    });
  } else if (currentChannelType === 'dm') {
    typingListenerRef = db.ref(`dms/${currentChannel}/typing`);
    typingListenerRef.on('value', (snap) => {
      const typers = snap.val() || {};
      const names = Object.values(typers)
        .filter(t => t.timestamp > Date.now() - 5000 && t.username !== userProfile.username)
        .map(t => t.username);

      if (names.length > 0) {
        elements.typingIndicator.classList.add('active');
        const text = names.length === 1 ? `${names[0]} is typing...` :
          names.length === 2 ? `${names[0]} and ${names[1]} are typing...` :
            'Several people are typing...';
        document.getElementById('typingText').textContent = text;
      } else {
        elements.typingIndicator.classList.remove('active');
      }
    });
    if (typeof startDmCallListeners === 'function') {
      startDmCallListeners();
    }
  } else {
    elements.typingIndicator.classList.remove('active');
  }
}

function addMessage(key, msg) {
  const div = document.createElement('div');
  div.className = 'message';
  div.id = `msg-${key}`;

  const isSystem = msg.uid === 'system';
  const canDelete = !isSystem && (msg.uid === currentUser?.uid || (currentChannelType !== 'dm' && hasPermission('manage_messages')));
  const canEdit = !isSystem && msg.uid === currentUser?.uid;

  const roleColor = msg.roleColor || (msg.role && rolesCache?.[msg.role]?.color) || '#5865f2';
  const roleBadge = msg.role && msg.role !== 'Member' && msg.role !== 'System'
    ? `<span class="role-badge" style="background:${roleColor}">${msg.role}</span>`
    : isSystem ? `<span class="role-badge" style="background:#23a559">SYSTEM</span>` : '';

  const displayAuthor = msg.author || 'Unknown';
  const avatarMarkup = msg.avatar
    ? `<img src="${msg.avatar}" style="width:100%;height:100%;object-fit:cover;">`
    : (displayAuthor ? displayAuthor.charAt(0).toUpperCase() : '?');

  let content = '';
  if (msg.text) {
    content = `<div class="message-text">${formatMentions(escapeHtml(msg.text))}</div>`;
  } else if (msg.image) {
    content = `<img src="${msg.image}" class="message-image" onclick="window.open('${msg.image}')" style="cursor:pointer;">`;
  }

  const time = msg.time || new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  div.innerHTML = `
    <div class="message-avatar" id="msg-avatar-${key}" style="background:${isSystem ? '#23a559' : roleColor}">
      ${avatarMarkup}
    </div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-author" id="msg-author-${key}" style="color:${isSystem ? '#23a559' : '#f2f3f5'}">${escapeHtml(displayAuthor)}</span>
        ${roleBadge}
        <span class="message-timestamp">${time}</span>
      </div>
      ${content}
      <div class="message-reactions" id="reactions-${key}"></div>
    </div>
      <div class="message-actions">
        ${canEdit ? `<button class="action-btn edit" onclick="editMessage('${key}')" title="Edit"><i class="fa-solid fa-pen"></i></button>` : ''}
        ${canDelete ? `<button class="action-btn delete" onclick="deleteMessage('${key}')" title="Delete"><i class="fa-solid fa-trash"></i></button>` : ''}
        <button class="action-btn react" onclick="showReactionPicker(event, '${key}')" title="React"><i class="fa-regular fa-face-smile"></i></button>
      </div>
  `;

  elements.messagesArea.appendChild(div);
  elements.messagesArea.scrollTop = elements.messagesArea.scrollHeight;

  updateMessageReactions(key, msg.reactions || {});

  if (!isSystem && msg.uid && (!msg.avatar || !msg.author)) {
    getMessageProfile(msg.uid).then(profile => {
      if (!profile) return;
      const authorEl = document.getElementById(`msg-author-${key}`);
      if (authorEl && (!msg.author || msg.author === 'Unknown')) {
        authorEl.textContent = profile.username;
      }
      if (!msg.avatar && profile.avatar) {
        const avatarEl = document.getElementById(`msg-avatar-${key}`);
        if (avatarEl) {
          avatarEl.innerHTML = `<img src="${profile.avatar}" style="width:100%;height:100%;object-fit:cover;">`;
        }
      }
    });
  }
}

function sendMessage() {
  if (!currentChannel) return;

  const text = elements.messageInput.value.trim();
  if (!text) return;

  if (currentChannelType === 'dm') {
    const messageData = {
      author: userProfile.username,
      text: text,
      timestamp: Date.now(),
      uid: currentUser.uid
    };

    const dmMessagesRef = db.ref(`dms/${currentChannel}/messages`);
    dmMessagesRef.push(messageData)
      .then(() => {
        elements.messageInput.value = '';
        elements.charCount.textContent = '0/2000';
        elements.charCount.className = 'char-count';
        pruneMessages(dmMessagesRef);
      })
      .catch(err => {
        showToast('Failed to send message: ' + err.message, 'error');
      });
    return;
  }

  if (!currentServer || currentChannelType !== 'text') return;

  db.ref(`servers/${currentServer}/channels_data/${currentChannel}/permissions`).once('value').then(permSnap => {
    const perms = permSnap.val() || {};
    const sendRoles = perms.requiredRolesToSend || [];
    
    if (sendRoles.length > 0 && !sendRoles.includes(userProfile.role) && !isServerOwner()) {
      showToast('You do not have permission to send messages here', 'error');
      return;
    }
    if (sendRoles.length === 0 && !hasPermission('send_messages')) {
      showToast('You do not have permission to send messages here', 'error');
      return;
    }

    // Slowmode check
    db.ref(`servers/${currentServer}/channels_data/${currentChannel}/slowmodeSeconds`).once('value').then(slowSnap => {
      const slowmodeSeconds = slowSnap.val() || 0;
      if (slowmodeSeconds > 0 && !hasPermission('manage_channels')) {
        db.ref(`servers/${currentServer}/channels_data/${currentChannel}/slowmodeState/${currentUser.uid}`).once('value').then(stateSnap => {
          const lastSent = stateSnap.val() || 0;
          const now = Date.now();
          const remaining = (lastSent + (slowmodeSeconds * 1000)) - now;
          if (remaining > 0) {
            startSlowmodeCountdown(remaining);
            return;
          }
          doSendMessage(slowmodeSeconds);
        });
      } else {
        doSendMessage(0);
      }
    });

    function doSendMessage(slowmodeSeconds) {
      // Get role color
      db.ref(`servers/${currentServer}/roles/${userProfile.role}`).once('value').then(roleSnap => {
      const roleData = roleSnap.val() || {};
      
      const messageData = {
        author: userProfile.username,
        text: text,
        timestamp: Date.now(),
        role: userProfile.role,
        uid: currentUser.uid
      };

      const channelMessagesRef = db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages`);
      const messageRef = channelMessagesRef.push();
      messageRef.set(messageData)
        .then(() => {
          elements.messageInput.value = '';
          elements.charCount.textContent = '0/2000';
          elements.charCount.className = 'char-count';
          
          // Clear typing indicator
          clearTimeout(typingTimeout);
          db.ref(`servers/${currentServer}/channels_data/${currentChannel}/typing/${currentUser.uid}`).remove();

          // Update slowmode timestamp
          db.ref(`servers/${currentServer}/channels_data/${currentChannel}/slowmodeState/${currentUser.uid}`).set(Date.now());
          if (slowmodeSeconds > 0 && !hasPermission('manage_channels')) {
            startSlowmodeCountdown(slowmodeSeconds * 1000);
          }
          // Pinging disabled
          pruneMessages(channelMessagesRef);
        })
        .catch(err => {
          showToast('Failed to send message: ' + err.message, 'error');
        });
      });
    }
  });
}

function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file || !currentChannel) return;

  if (currentChannelType === 'dm') {
    compressImageFile(file, { maxSize: 1024, quality: 0.7, type: 'image/jpeg' })
      .then(dataUrl => {
        const dmMessagesRef = db.ref(`dms/${currentChannel}/messages`);
        return dmMessagesRef.push({
          author: userProfile.username,
          image: dataUrl,
          timestamp: Date.now(),
          uid: currentUser.uid
        }).then(() => pruneMessages(dmMessagesRef));
      })
      .catch(err => {
        showToast('Failed to send image: ' + err.message, 'error');
      });

    e.target.value = '';
    return;
  }

  if (!currentServer || currentChannelType !== 'text') {
    showToast('Can only send images in text channels', 'error');
    return;
  }

  // Check permissions
  db.ref(`servers/${currentServer}/channels_data/${currentChannel}/permissions`).once('value').then(permSnap => {
    const perms = permSnap.val() || {};
    const sendRoles = perms.requiredRolesToSend || [];
    
    if (sendRoles.length > 0 && !sendRoles.includes(userProfile.role) && !isServerOwner()) {
      showToast('You do not have permission to send images here', 'error');
      return;
    }
    if (sendRoles.length === 0 && !hasPermission('send_messages')) {
      showToast('You do not have permission to send images here', 'error');
      return;
    }

    db.ref(`servers/${currentServer}/channels_data/${currentChannel}/slowmodeSeconds`).once('value').then(slowSnap => {
      const slowmodeSeconds = slowSnap.val() || 0;
      if (slowmodeSeconds > 0 && !hasPermission('manage_channels')) {
        db.ref(`servers/${currentServer}/channels_data/${currentChannel}/slowmodeState/${currentUser.uid}`).once('value').then(stateSnap => {
          const lastSent = stateSnap.val() || 0;
          const now = Date.now();
          const remaining = (lastSent + (slowmodeSeconds * 1000)) - now;
          if (remaining > 0) {
            startSlowmodeCountdown(remaining);
            return;
          }
          doSendImage(slowmodeSeconds);
        });
      } else {
        doSendImage(0);
      }
    });

    function doSendImage(slowmodeSeconds) {
      compressImageFile(file, { maxSize: 1024, quality: 0.7, type: 'image/jpeg' })
        .then(dataUrl => {
          return db.ref(`servers/${currentServer}/roles/${userProfile.role}`).once('value').then(roleSnap => {
            const roleData = roleSnap.val() || {};
            
            const channelMessagesRef = db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages`);
            return channelMessagesRef.push({
              author: userProfile.username,
              image: dataUrl,
              timestamp: Date.now(),
              role: userProfile.role,
              uid: currentUser.uid
            }).then(() => pruneMessages(channelMessagesRef));
          });
        })
        .then(() => {
          db.ref(`servers/${currentServer}/channels_data/${currentChannel}/slowmodeState/${currentUser.uid}`).set(Date.now());
          if (slowmodeSeconds > 0 && !hasPermission('manage_channels')) {
            startSlowmodeCountdown(slowmodeSeconds * 1000);
          }
        })
        .catch(err => {
          showToast('Failed to send image: ' + err.message, 'error');
        });
    }
  });
  
  e.target.value = '';
}

function deleteMessage(key) {
  if (!currentChannel) return;
  
  if (!confirm('Delete this message?')) return;

  const path = currentChannelType === 'dm'
    ? `dms/${currentChannel}/messages/${key}`
    : `servers/${currentServer}/channels_data/${currentChannel}/messages/${key}`;

  db.ref(path).remove()
    .catch(err => {
      showToast('Failed to delete message: ' + err.message, 'error');
    });
}

// User Management
