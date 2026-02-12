function saveSettings() {
  const usernameInput = document.getElementById('usernameInput');
  const statusSelect = document.getElementById('statusSelect');
  const avatarInput = document.getElementById('avatarInput');
  const bioInput = document.getElementById('bioInput');
  
  const username = usernameInput ? usernameInput.value.trim() : '';
  const status = statusSelect ? statusSelect.value : 'online';
  const avatarFile = avatarInput ? avatarInput.files[0] : null;
  const bio = bioInput ? bioInput.value.trim() : '';
  if (bio.length > LIMITS.bio) {
    showToast(`Bio max ${LIMITS.bio} characters`, 'error');
    return;
  }

  if (username && username !== userProfile.username) {
    // Check uniqueness
    db.ref('users').once('value').then(snap => {
      const users = snap.val() || {};
      const exists = Object.entries(users).some(([uid, name]) => name === username && uid !== currentUser.uid);
      if (exists) {
        showToast('Username already taken', 'error');
        return;
      }

      userProfile.username = username;
      userProfile.status = status;
      userProfile.bio = bio;

      db.ref(`users/${currentUser.uid}`).set(username);
      updateMemberData();
      updateProfileData();
      updateUserDisplay();
      saveCookies();

      if (avatarFile) {
        uploadAvatar(avatarFile);
      } else {
        hideModal('settings');
        showToast('Settings saved', 'success');
      }
    });
  } else {
    userProfile.status = status;
    userProfile.bio = bio;
    if (avatarFile) {
      uploadAvatar(avatarFile);
    } else {
      updateMemberData();
      updateProfileData();
      updateUserDisplay();
      saveCookies();
      hideModal('settings');
      showToast('Settings saved', 'success');
    }
  }
}

function uploadAvatar(file) {
  compressImageFile(file, { maxSize: 256, quality: 0.7, type: 'image/jpeg' })
    .then(dataUrl => {
      userProfile.avatar = dataUrl;
      updateMemberData();
      updateUserDisplay();
      saveCookies();
      hideModal('settings');
      showToast('Avatar updated', 'success');
    })
    .catch(err => {
      showToast('Failed to process avatar: ' + err.message, 'error');
    });
}

const memberProfileCache = {};
const memberProfilePromises = {};

function invalidateCachedProfile(uid) {
  if (!uid) return;
  if (typeof memberProfileCache !== 'undefined') delete memberProfileCache[uid];
  if (typeof memberProfilePromises !== 'undefined') delete memberProfilePromises[uid];
  if (typeof messageProfileCache !== 'undefined') delete messageProfileCache[uid];
  if (typeof messageProfilePromises !== 'undefined') delete messageProfilePromises[uid];
  if (typeof dmPingProfileCache !== 'undefined') delete dmPingProfileCache[uid];
  if (typeof dmPingProfilePromises !== 'undefined') delete dmPingProfilePromises[uid];
}

function getMemberProfile(uid) {
  if (!uid) return Promise.resolve(null);
  if (memberProfileCache[uid]) return Promise.resolve(memberProfileCache[uid]);
  if (memberProfilePromises[uid]) return memberProfilePromises[uid];

  const promise = db.ref(`profiles/${uid}`).once('value').then(snap => {
    const profile = snap.val() || {};
    const data = {
      username: profile.username || 'Unknown',
      avatar: profile.avatar || null,
      bio: profile.bio || '',
      status: profile.status || 'offline',
      lastSeen: profile.lastSeen || 0
    };
    memberProfileCache[uid] = data;
    delete memberProfilePromises[uid];
    return data;
  }).catch(() => {
    delete memberProfilePromises[uid];
    return null;
  });

  memberProfilePromises[uid] = promise;
  return promise;
}

function updateMemberData() {
  if (!currentUser) return;
  const targetServers = new Set(userServers || []);
  if (currentServer) targetServers.add(currentServer);

  targetServers.forEach(serverId => {
    db.ref(`servers/${serverId}/members/${currentUser.uid}`).update({
      username: userProfile.username
    });
  });
  updateProfileData();
}

function updateProfileData() {
  if (!currentUser) return;
  invalidateCachedProfile(currentUser.uid);
  db.ref(`profiles/${currentUser.uid}`).update({
    username: userProfile.username,
    avatar: userProfile.avatar,
    bio: userProfile.bio || '',
    status: userProfile.status,
    lastSeen: Date.now()
  });
  db.ref(`users/${currentUser.uid}`).set(userProfile.username);
}

function loadMemberList() {
  if (!currentServer) return;

  if (memberListRef) {
    memberListRef.off();
  }
  memberListRef = db.ref(`servers/${currentServer}/members`);
  memberListRef.on('value', snapshot => {
    const members = snapshot.val() || {};
    elements.membersContainer.innerHTML = '';

    // Load roles to support custom role grouping
    db.ref(`servers/${currentServer}/roles`).once('value').then(roleSnap => {
      const rolesData = roleSnap.val() || {};
      const ownerId = currentServerOwnerId;

      // Build role order: hoisted custom roles, then Admin/Moderator/Member, then any remaining
      const roleNames = Object.keys(rolesData);
      const hoisted = roleNames.filter(r => rolesData[r]?.hoist);
      const defaults = ['Admin', 'Moderator', 'Member'].filter(r => roleNames.includes(r));
      const hoistedNonDefault = hoisted.filter(r => !defaults.includes(r));
      const rest = roleNames.filter(r => !hoisted.includes(r) && !defaults.includes(r));
      const orderedRoles = [...hoistedNonDefault, ...defaults, ...rest];

      // Group by role
      const roleGroups = {};
      Object.entries(members).forEach(([uid, data]) => {
        if (data.role === 'Owner') {
          db.ref(`servers/${currentServer}/members/${uid}/role`).set('Admin');
          data.role = 'Admin';
        }
        const role = data.role || (currentServerOwnerId && uid === currentServerOwnerId ? 'Admin' : 'Member');
        if (!roleGroups[role]) roleGroups[role] = [];
        roleGroups[role].push({ uid, ...data });
      });

      orderedRoles.forEach(role => {
        const membersList = roleGroups[role] || [];
        if (membersList.length === 0) return;

        const categoryDiv = document.createElement('div');
        categoryDiv.className = 'member-category';
        categoryDiv.innerHTML = `
          <div class="member-category-header">
            ${role} — ${membersList.length}
          </div>
        `;

        membersList.forEach(member => {
          const cachedProfile = memberProfileCache[member.uid];
          if (cachedProfile?.username) member.username = cachedProfile.username;
          if (cachedProfile?.bio) member.bio = cachedProfile.bio;
          member.status = cachedProfile?.status || member.status || 'offline';
          member.lastSeen = cachedProfile?.lastSeen || member.lastSeen || 0;
          const isOnline = !!(member.lastSeen && Date.now() - member.lastSeen < 60000);
          const statusClass = !isOnline ? 'offline' : (member.status === 'idle' ? 'idle' : member.status === 'dnd' ? 'dnd' : '');

          // Check if member is in a voice channel and get voice status (muted/deafened)
          let voiceChannelName = null;
          let isMuted = false;
          let isDeafened = false;
          
          const voiceChannels = db.ref(`servers/${currentServer}/voiceChannels`);
          voiceChannels.once('value').then(snapshot => {
            const channels = snapshot.val() || {};
            Object.entries(channels).forEach(([channelName, channelData]) => {
              if (channelData.users && channelData.users[member.uid]) {
                voiceChannelName = channelName;
                isMuted = channelData.users[member.uid].muted || false;
                isDeafened = channelData.users[member.uid].deafened || false;
              }
            });
            
            // Update member display with voice channel info
            const existingDiv = document.querySelector(`[data-uid="${member.uid}"]`);
            if (existingDiv) {
              const statusText = existingDiv.querySelector('.member-status-text');
              const statusDot = existingDiv.querySelector('.member-status');
            if (statusText) {
              if (voiceChannelName) {
                let statusIndicator = 'Voice';
                if (isMuted) statusIndicator = 'Muted';
                if (isDeafened) statusIndicator = 'Deafened';
                statusText.textContent = `${statusIndicator}: ${voiceChannelName}`;
              } else {
                const currentlyOnline = !!(member.lastSeen && Date.now() - member.lastSeen < 60000);
                statusText.textContent = currentlyOnline ? 'Connect to VC' : 'offline';
              }
            }
              if (statusDot) {
                const currentlyOnline = !!(member.lastSeen && Date.now() - member.lastSeen < 60000);
                const dotClass = !currentlyOnline ? 'offline' : (member.status === 'idle' ? 'idle' : member.status === 'dnd' ? 'dnd' : '');
                statusDot.className = `member-status ${dotClass}`;
              }
            }
          });

          const memberDiv = document.createElement('div');
          memberDiv.className = 'member-item';
          memberDiv.setAttribute('data-uid', member.uid);
          
          // Determine status text
          const statusTextContent = voiceChannelName ? `Voice: ${voiceChannelName}` : (isOnline ? 'Connect to VC' : 'offline');
          
          const ownerBadge = ownerId && member.uid === ownerId ? '<span class="role-badge" style="background:#f0b232"><i class="fa-solid fa-crown" style="margin-right:6px;"></i>OWNER</span>' : '';
          const bioLine = member.bio ? `<div class="member-bio">${escapeHtml(member.bio)}</div>` : '';
          const fallbackInitial = (cachedProfile?.username || member.username || '?').charAt(0).toUpperCase();
          const initialAvatarMarkup = cachedProfile?.avatar ? `<img src="${cachedProfile.avatar}">` : fallbackInitial;
          memberDiv.innerHTML = `
            <div class="member-avatar" data-avatar-for="${member.uid}" style="background:${getRoleColor(member.role)}">
              ${initialAvatarMarkup}
              <div class="member-status ${statusClass}"></div>
            </div>
            <div class="member-info">
              <div class="member-name" data-name-for="${member.uid}">${member.username || 'Unknown'} ${ownerBadge}</div>
              <div class="member-status-text">${statusTextContent}</div>
              <div class="member-bio" data-bio-for="${member.uid}" style="${member.bio ? '' : 'display:none;'}">${escapeHtml(member.bio || '')}</div>
            </div>
          `;
          
          // Click handler for role management / add friend
          memberDiv.style.cursor = 'pointer';
          memberDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            showMemberContextMenu(e, member);
          });
          
          getMemberProfile(member.uid).then(profile => {
            if (!profile) return;
            member.status = profile.status || member.status || 'offline';
            member.lastSeen = profile.lastSeen || member.lastSeen || 0;
            const avatarEl = memberDiv.querySelector(`[data-avatar-for="${member.uid}"]`);
            if (avatarEl && profile.avatar) {
              avatarEl.innerHTML = `<img src="${profile.avatar}">`;
            }
            const nameEl = memberDiv.querySelector(`[data-name-for="${member.uid}"]`);
            if (nameEl && profile.username && profile.username !== member.username) {
              nameEl.innerHTML = `${escapeHtml(profile.username)} ${ownerBadge}`;
              member.username = profile.username;
            }
            const bioEl = memberDiv.querySelector(`[data-bio-for="${member.uid}"]`);
            if (bioEl && profile.bio) {
              bioEl.textContent = profile.bio;
              bioEl.style.display = 'block';
              member.bio = profile.bio;
            }

            const statusDot = memberDiv.querySelector('.member-status');
            if (statusDot) {
              const profileOnline = !!(member.lastSeen && Date.now() - member.lastSeen < 60000);
              const dotClass = !profileOnline ? 'offline' : (member.status === 'idle' ? 'idle' : member.status === 'dnd' ? 'dnd' : '');
              statusDot.className = `member-status ${dotClass}`;
            }

            const statusText = memberDiv.querySelector('.member-status-text');
            if (statusText && !/^(Voice|Muted|Deafened):/.test(statusText.textContent || '')) {
              const profileOnline = !!(member.lastSeen && Date.now() - member.lastSeen < 60000);
              statusText.textContent = profileOnline ? 'Connect to VC' : 'offline';
            }
          });
          
          categoryDiv.appendChild(memberDiv);
        });

        elements.membersContainer.appendChild(categoryDiv);
      });

      // Any members with roles not in rolesData (fallback)
      Object.keys(roleGroups).forEach(role => {
        if (orderedRoles.includes(role)) return;
        const membersList = roleGroups[role] || [];
        if (membersList.length === 0) return;
        const categoryDiv = document.createElement('div');
        categoryDiv.className = 'member-category';
        categoryDiv.innerHTML = `
          <div class="member-category-header">
            ${role} — ${membersList.length}
          </div>
        `;
        membersList.forEach(member => {
          const cachedProfile = memberProfileCache[member.uid];
          if (cachedProfile?.username) member.username = cachedProfile.username;
          const memberDiv = document.createElement('div');
          memberDiv.className = 'member-item';
          memberDiv.setAttribute('data-uid', member.uid);
          const fallbackInitial = (cachedProfile?.username || member.username || '?').charAt(0).toUpperCase();
          const initialAvatarMarkup = cachedProfile?.avatar ? `<img src="${cachedProfile.avatar}">` : fallbackInitial;
          memberDiv.innerHTML = `
            <div class="member-avatar" data-avatar-for="${member.uid}" style="background:${getRoleColor(member.role)}">
              ${initialAvatarMarkup}
              <div class="member-status"></div>
            </div>
            <div class="member-info">
              <div class="member-name" data-name-for="${member.uid}">${member.username || 'Unknown'}</div>
              <div class="member-status-text">${member.status || ''}</div>
            </div>
          `;
          categoryDiv.appendChild(memberDiv);

          getMemberProfile(member.uid).then(profile => {
            if (!profile) return;
            member.status = profile.status || member.status || 'offline';
            member.lastSeen = profile.lastSeen || member.lastSeen || 0;
            const avatarEl = memberDiv.querySelector(`[data-avatar-for="${member.uid}"]`);
            if (avatarEl && profile.avatar) {
              avatarEl.innerHTML = `<img src="${profile.avatar}">`;
            }
            const nameEl = memberDiv.querySelector(`[data-name-for="${member.uid}"]`);
            if (nameEl && profile.username && profile.username !== member.username) {
              nameEl.textContent = profile.username;
              member.username = profile.username;
            }

            const statusDot = memberDiv.querySelector('.member-status');
            if (statusDot) {
              const profileOnline = !!(member.lastSeen && Date.now() - member.lastSeen < 60000);
              const dotClass = !profileOnline ? 'offline' : (member.status === 'idle' ? 'idle' : member.status === 'dnd' ? 'dnd' : '');
              statusDot.className = `member-status ${dotClass}`;
            }

            const statusText = memberDiv.querySelector('.member-status-text');
            if (statusText) {
              const profileOnline = !!(member.lastSeen && Date.now() - member.lastSeen < 60000);
              statusText.textContent = profileOnline ? 'Connect to VC' : 'offline';
            }
          });
        });
        elements.membersContainer.appendChild(categoryDiv);
      });
    });
  });
}

function showMemberContextMenu(e, member) {
  const existingMenu = document.querySelector('.member-context-menu');
  if (existingMenu) existingMenu.remove();

  const menu = document.createElement('div');
  menu.className = 'member-context-menu';
  menu.style.position = 'fixed';
  menu.style.left = `${e.pageX}px`;
  menu.style.top = `${e.pageY}px`;
  menu.style.background = '#313338';
  menu.style.border = '1px solid #1e1f22';
  menu.style.borderRadius = '8px';
  menu.style.padding = '8px';
  menu.style.zIndex = '1001';
  menu.style.minWidth = '180px';
  menu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';

  const canManageRoles = hasPermission('manage_roles');
  const canKickMembers = hasPermission('manage_messages') || hasPermission('manage_server');
  const isSelf = member.uid === currentUser.uid;
  const isOwner = !!(currentServerOwnerId && member.uid === currentServerOwnerId);

  menu.innerHTML = `
    <div class="context-menu-item" data-action="add-friend" style="padding: 8px; cursor: ${isSelf ? 'not-allowed' : 'pointer'}; color: ${isSelf ? '#7f8187' : '#dbdee1'}; border-radius: 4px;">
      <i class="fa-solid fa-user-plus" style="margin-right:6px;"></i> Add Friend
    </div>
    <div class="context-menu-item" data-action="kick-member" style="padding: 8px; cursor: ${(!canKickMembers || isSelf || isOwner) ? 'not-allowed' : 'pointer'}; color: ${(!canKickMembers || isSelf || isOwner) ? '#7f8187' : '#f28b8d'}; border-radius: 4px;">
      <i class="fa-solid fa-user-minus" style="margin-right:6px;"></i> Kick
    </div>
    <div style="height:1px;background:#1e1f22;margin:6px 0;"></div>
    <div style="padding: 6px 8px; font-size: 11px; text-transform: uppercase; color: #7f8187; letter-spacing: 0.6px;">Roles</div>
    <div id="roleMenuItems" style="display:flex;flex-direction:column;gap:2px;"></div>
  `;

  menu.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('mouseenter', () => {
      if (item.style.cursor !== 'not-allowed') {
        item.style.background = '#35363c';
      }
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = 'transparent';
    });
  });

  const addFriendItem = menu.querySelector('[data-action="add-friend"]');
  if (addFriendItem && !isSelf) {
    addFriendItem.addEventListener('click', () => addFriendByUid(member.uid, member.username));
  }
  const kickMemberItem = menu.querySelector('[data-action="kick-member"]');
  if (kickMemberItem && canKickMembers && !isSelf && !isOwner) {
    kickMemberItem.addEventListener('click', () => kickMemberFromServer(member));
  }

  const roleMenuItems = menu.querySelector('#roleMenuItems');
  if (roleMenuItems) {
    if (!canManageRoles) {
      const item = document.createElement('div');
      item.textContent = 'No permission';
      item.style.padding = '8px';
      item.style.color = '#7f8187';
      roleMenuItems.appendChild(item);
    } else {
      db.ref(`servers/${currentServer}/roles`).once('value').then(snap => {
        const roles = snap.val() || {};
        Object.keys(roles).forEach(roleName => {
          const roleItem = document.createElement('div');
          roleItem.className = 'context-menu-item';
          roleItem.style.padding = '8px';
          roleItem.style.cursor = isSelf ? 'not-allowed' : 'pointer';
          roleItem.style.color = isSelf ? '#7f8187' : '#dbdee1';
          roleItem.style.borderRadius = '4px';
          const isActiveRole = member.role === roleName;
          roleItem.innerHTML = `
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${roles[roleName].color || '#5865f2'};margin-right:6px;"></span>
            ${roleName}${isActiveRole ? ' <i class="fa-solid fa-check" style="margin-left:6px;font-size:10px;opacity:0.9;"></i>' : ''}
          `;
          roleItem.addEventListener('mouseenter', () => {
            if (roleItem.style.cursor !== 'not-allowed') {
              roleItem.style.background = '#35363c';
            }
          });
          roleItem.addEventListener('mouseleave', () => {
            roleItem.style.background = 'transparent';
          });
          if (!isSelf) {
            roleItem.addEventListener('click', () => setMemberRole(member, roleName));
          }
          roleMenuItems.appendChild(roleItem);
        });
      });
    }
  }

  document.addEventListener('click', () => {
    menu.remove();
  }, { once: true });

  document.body.appendChild(menu);
}

function kickMemberFromServer(member) {
  if (!currentServer || !member || !member.uid) return;
  if (!hasPermission('manage_messages') && !hasPermission('manage_server')) {
    showToast('You do not have permission to kick members', 'error');
    return;
  }
  if (member.uid === currentUser.uid) {
    showToast('You cannot kick yourself', 'error');
    return;
  }
  if (currentServerOwnerId && member.uid === currentServerOwnerId) {
    showToast('You cannot kick the server owner', 'error');
    return;
  }

  const name = member.username || 'this member';
  if (!confirm(`Kick ${name} from this server?`)) return;

  const updates = {};
  updates[`servers/${currentServer}/members/${member.uid}`] = null;

  db.ref(`servers/${currentServer}/voiceChannels`).once('value').then((snap) => {
    const voiceChannels = snap.val() || {};
    Object.keys(voiceChannels).forEach((channelName) => {
      updates[`servers/${currentServer}/voiceChannels/${channelName}/users/${member.uid}`] = null;
    });
    return db.ref().update(updates);
  }).then(() => {
    const actor = userProfile.username || 'A moderator';
    if (typeof sendSystemMessage === 'function') {
      sendSystemMessage(currentServer, `${name} was kicked by ${actor}.`);
    }
    showToast(`${name} was kicked`, 'success');
    loadMemberList();
  }).catch((err) => {
    showToast('Failed to kick member: ' + err.message, 'error');
  });
}

function setMemberRole(member, roleName) {
  if (!hasPermission('manage_roles')) {
    showToast('You do not have permission to manage roles', 'error');
    return;
  }

  if (member.uid === currentUser.uid) {
    showToast('You cannot change your own role', 'error');
    return;
  }

  db.ref(`servers/${currentServer}/members/${member.uid}/role`).set(roleName)
    .then(() => {
      showToast(`${member.username} is now ${roleName}`, 'success');
      loadMemberList();
    })
    .catch(err => {
      showToast('Failed to update role: ' + err.message, 'error');
    });
}

function toggleMemberList() {
  if (isHomeView) return;
  const isVisible = elements.memberList.style.display !== 'none';
  elements.memberList.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) loadMemberList();
}


function editMessage(key) {
  const msgElement = document.getElementById(`msg-${key}`);
  const textElement = msgElement.querySelector('.message-text');
  const currentText = textElement.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'edit-input';
  input.value = currentText;
  input.style.width = '100%';
  input.style.padding = '8px';
  input.style.border = '1px solid #5865f2';
  input.style.borderRadius = '4px';
  input.style.background = '#35363c';
  input.style.color = '#dbdee1';

  textElement.replaceWith(input);
  input.focus();
  input.select();

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      saveMessageEdit(key, input.value.trim());
    }
  });

  input.addEventListener('blur', () => {
    saveMessageEdit(key, input.value.trim());
  });
}

function saveMessageEdit(key, newText) {
  if (!currentChannel) return;
  
  if (newText && newText.trim() !== '') {
    const path = currentChannelType === 'dm'
      ? `dms/${currentChannel}/messages/${key}/text`
      : `servers/${currentServer}/channels_data/${currentChannel}/messages/${key}/text`;

    db.ref(path).set(newText)
      .then(() => {
        showToast('Message edited successfully', 'success');
      })
      .catch(err => {
        showToast('Failed to edit message: ' + err.message, 'error');
      });
  }
}
