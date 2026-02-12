const voiceProfileCache = {};
const voiceProfilePromises = {};

function getVoiceProfile(uid) {
  if (!uid) return Promise.resolve(null);
  if (voiceProfileCache[uid]) return Promise.resolve(voiceProfileCache[uid]);
  if (voiceProfilePromises[uid]) return voiceProfilePromises[uid];

  const promise = db.ref(`profiles/${uid}`).once('value').then(snap => {
    const profile = snap.val() || {};
    const data = {
      username: profile.username || 'Unknown',
      avatar: profile.avatar || null
    };
    voiceProfileCache[uid] = data;
    delete voiceProfilePromises[uid];
    return data;
  }).catch(() => {
    delete voiceProfilePromises[uid];
    return null;
  });

  voiceProfilePromises[uid] = promise;
  return promise;
}

function loadChannels() {
  if (!currentServer) return;

  // Clear previous listeners
  messageListeners.forEach(ref => ref.off());
  messageListeners = [];

  // Load text channels
  db.ref(`servers/${currentServer}/channels`).on('value', snapshot => {
    const channels = snapshot.val() || {};
    elements.textChannelsList.innerHTML = '';

    const sortedChannels = Object.keys(channels).sort();
    const lastForServer = lastChannelsByServer[currentServer];

    sortedChannels.forEach(channelName => {
      checkChannelAccess(channelName, 'text').then(hasAccess => {
        const div = document.createElement('div');
        div.className = 'channel-item' + (channelName === currentChannel && currentChannelType === 'text' ? ' active' : '');
        div.setAttribute('data-channel', channelName);
        div.setAttribute('data-channel-type', 'text');
        if (!hasAccess) div.classList.add('locked');

        div.innerHTML = `
          <span class="channel-icon"><i class="fa-solid fa-hashtag"></i></span>
          <span class="channel-name">${channelName}</span>
          <span class="channel-mention-badge" style="display:none;"></span>
        `;

        if (hasAccess) {
          div.onclick = () => switchChannel(channelName, 'text');
        } else {
          div.onclick = () => showToast('You do not have permission to view this channel', 'error');
        }

        elements.textChannelsList.appendChild(div);
        if (typeof refreshMentionBadges === 'function') {
          refreshMentionBadges();
        }
      });
    });

    if (!currentChannel && sortedChannels.length > 0) {
      if (lastForServer && lastForServer.type === 'text' && sortedChannels.includes(lastForServer.name)) {
        checkChannelAccess(lastForServer.name, 'text').then(hasAccess => {
          if (hasAccess && !currentChannel) {
            switchChannel(lastForServer.name, 'text');
          }
        });
      } else {
        // Fallback: pick first accessible channel
        sortedChannels.some(channelName => {
          checkChannelAccess(channelName, 'text').then(hasAccess => {
            if (hasAccess && !currentChannel) {
              switchChannel(channelName, 'text');
            }
          });
          return false;
        });
      }
    }
  });

  // Load voice channels
  db.ref(`servers/${currentServer}/voiceChannels`).on('value', snapshot => {
    const channels = snapshot.val() || {};
    elements.voiceChannelsList.innerHTML = '';
    const lastForServer = lastChannelsByServer[currentServer];

    Object.entries(channels).forEach(([channelName, channelData]) => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (channelName === currentChannel && currentChannelType === 'voice' ? ' active' : '');

      const userCount = channelData.users ? Object.keys(channelData.users).length : 0;
      const limit = channelData.limit || 0;
      const limitText = limit > 0 ? ` (${userCount}/${limit})` : ` (${userCount})`;

      div.innerHTML = `
        <span class="channel-icon"><i class="fa-solid fa-volume-high"></i></span>
        <span>${channelName}${limitText}</span>
      `;

      div.onclick = () => joinVoiceChannel(channelName);

      elements.voiceChannelsList.appendChild(div);

      // Show users in voice channel
      if (channelData.users) {
        const usersDiv = document.createElement('div');
        usersDiv.className = 'voice-users';
        Object.entries(channelData.users).forEach(([uid, userData]) => {
          const userDiv = document.createElement('div');
          userDiv.className = 'voice-user';
          const fallbackInitial = userData.username ? userData.username.charAt(0).toUpperCase() : '?';
          userDiv.innerHTML = `
            <div class="voice-user-avatar" data-voice-avatar-for="${uid}">${userData.avatar ? `<img src="${userData.avatar}">` : fallbackInitial}</div>
            <span data-voice-name-for="${uid}">${userData.username || 'Unknown'}</span>
          `;
          usersDiv.appendChild(userDiv);

          if (!userData.avatar) {
            getVoiceProfile(uid).then(profile => {
              if (!profile) return;
              const avatarEl = userDiv.querySelector(`[data-voice-avatar-for="${uid}"]`);
              if (avatarEl && profile.avatar) {
                avatarEl.innerHTML = `<img src="${profile.avatar}">`;
              }
              const nameEl = userDiv.querySelector(`[data-voice-name-for="${uid}"]`);
              if (nameEl && profile.username && profile.username !== userData.username) {
                nameEl.textContent = profile.username;
              }
            });
          }
        });
        elements.voiceChannelsList.appendChild(usersDiv);
      }
    });

    if (!currentChannel && lastForServer && lastForServer.type === 'voice' && channels[lastForServer.name]) {
      switchChannel(lastForServer.name, 'voice');
    }
  });
}

function checkChannelAccess(channelName, type) {
  return new Promise((resolve) => {
    db.ref(`servers/${currentServer}/channels_data/${channelName}/permissions`).once('value').then(snap => {
      const perms = snap.val() || {};
      const requiredRoles = type === 'text' ? (perms.requiredRolesToView || []) : (perms.voiceRoles || []);
      if (requiredRoles.length === 0) {
        resolve(isServerOwner() || hasPermission('view_channels'));
      } else {
        resolve(isServerOwner() || requiredRoles.includes(userProfile.role));
      }
    });
  });
}

function switchChannel(channelName, type) {
  currentChannel = channelName;
  currentChannelType = type;
  if (type !== 'dm') {
    currentDmId = null;
    currentDmUser = null;
    isHomeView = false;
    setHomeView(false);
  }
  if (currentServer) {
    lastChannelsByServer[currentServer] = { name: channelName, type };
    saveCookies();
  }
  elements.currentChannelName.textContent = channelName;
  elements.headerIcon.innerHTML = type === 'voice' ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-hashtag"></i>';
  elements.messageInput.placeholder = `Message #${channelName}`;
  elements.messageInput.disabled = type !== 'text';
  if (type !== 'text') {
    clearSlowmodeNotice();
  }
  if (elements.dmCallBtn) {
    elements.dmCallBtn.style.display = type === 'dm' ? 'inline-flex' : 'none';
  }

  // Load and display channel topic
  if (type === 'text') {
    db.ref(`servers/${currentServer}/channels_data/${channelName}/topic`).once('value').then(snap => {
      const topic = snap.val() || '';
      document.getElementById('channelTopic').textContent = topic;
      document.getElementById('headerDivider').style.display = topic ? 'block' : 'none';
    });
  }

  // Update UI
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  
  // Find and activate the correct channel item programmatically
  document.querySelectorAll('.channel-item').forEach(el => {
    // Check if this channel item contains the channel name
    if (el.textContent.includes(channelName)) {
      el.classList.add('active');
    }
  });

  if (type === 'text') {
    if (typeof markChannelMentionsRead === 'function') {
      markChannelMentionsRead(currentServer, channelName);
    }
    // Don't hide voice panel if user is in a voice channel
    if (!inVoiceChannel) {
      elements.voicePanel.classList.remove('active');
    }
    loadMessages();
  } else {
    elements.messagesArea.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fa-solid fa-volume-high"></i></div>
        <h3>${channelName}</h3>
        <p>Voice Channel • Click connect to join the conversation</p>
        <button class="input-btn" style="margin-top:16px;" onclick="joinVoiceChannel('${channelName}')">Connect</button>
      </div>
    `;
  }
}

function createChannel() {
  const channelNameInput = document.getElementById('channelNameInput');
  const name = channelNameInput ? channelNameInput.value.trim().toLowerCase().replace(/\s+/g, '-') : '';
  
  if (!name) {
    showToast('Please enter a channel name', 'error');
    return;
  }

  if (!hasPermission('manage_channels')) {
    showToast('You do not have permission to create channels', 'error');
    return;
  }

  db.ref(`servers/${currentServer}/channels/${name}`).set(true).then(() => {
    hideModal('addChannel');
    if (channelNameInput) channelNameInput.value = '';
    showToast(`Channel #${name} created`, 'success');
  });
}

function createVoiceChannel() {
  const voiceChannelNameInput = document.getElementById('voiceChannelNameInput');
  const voiceChannelLimit = document.getElementById('voiceChannelLimit');
  
  const name = voiceChannelNameInput ? voiceChannelNameInput.value.trim() : '';
  const limit = voiceChannelLimit ? parseInt(voiceChannelLimit.value) || 0 : 0;

  if (!name) {
    showToast('Please enter a channel name', 'error');
    return;
  }

  if (!hasPermission('manage_channels')) {
    showToast('You do not have permission to create channels', 'error');
    return;
  }

  db.ref(`servers/${currentServer}/voiceChannels/${name}`).set({
    limit: limit,
    createdAt: Date.now()
  }).then(() => {
    hideModal('addVoiceChannel');
    if (voiceChannelNameInput) voiceChannelNameInput.value = '';
    if (voiceChannelLimit) voiceChannelLimit.value = '';
    showToast(`Voice channel ${name} created`, 'success');
  });
}

function deleteChannel() {
  const channelSelect = document.getElementById('channelSelect');
  const channelName = channelSelect ? channelSelect.value : '';
  
  if (!channelName) return;

  if (channelName === 'general') {
    showToast('Cannot delete the general channel', 'error');
    return;
  }

  if (!confirm(`Are you sure you want to delete #${channelName}?`)) return;

  const selectedOption = channelSelect.options[channelSelect.selectedIndex];
  const isVoice = selectedOption ? selectedOption.dataset.type === 'voice' : false;

  if (isVoice) {
    db.ref(`servers/${currentServer}/voiceChannels/${channelName}`).remove();
  } else {
    db.ref(`servers/${currentServer}/channels/${channelName}`).remove();
    db.ref(`servers/${currentServer}/channels_data/${channelName}`).remove();
  }

  hideModal('manageChannels');
  if (currentChannel === channelName) {
    currentChannel = null;
    loadChannels();
  }
  showToast('Channel deleted', 'success');
}

function toggleCategory(header) {
  const list = header.nextElementSibling;
  const arrowIcon = header.querySelector('span:first-child i');
  if (!list || !arrowIcon) return;
  
  if (list.style.display === 'none') {
    list.style.display = 'block';
    if (arrowIcon) {
      arrowIcon.classList.remove('fa-chevron-right');
      arrowIcon.classList.add('fa-chevron-down');
    }
  } else {
    list.style.display = 'none';
    if (arrowIcon) {
      arrowIcon.classList.remove('fa-chevron-down');
      arrowIcon.classList.add('fa-chevron-right');
    }
  }
}

function openLastTextChannel() {
  if (!currentServer) return;
  if (currentChannelType === 'text' && currentChannel) return;

  const lastForServer = lastChannelsByServer[currentServer];
  if (lastForServer && lastForServer.type === 'text') {
    switchChannel(lastForServer.name, 'text');
    return;
  }

  // Fallback: pick first accessible text channel
  db.ref(`servers/${currentServer}/channels`).once('value').then(snapshot => {
    const channels = snapshot.val() || {};
    const sortedChannels = Object.keys(channels).sort();
    sortedChannels.some(channelName => {
      checkChannelAccess(channelName, 'text').then(hasAccess => {
        if (hasAccess && (!currentChannel || currentChannelType !== 'text')) {
          switchChannel(channelName, 'text');
        }
      });
      return false;
    });
  });
}

// Messaging
