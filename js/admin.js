function saveServerSettings() {
  const serverNameInput = document.getElementById('serverSettingsName');
  const serverIconInput = document.getElementById('serverSettingsIcon');
  const systemSelect = document.getElementById('systemMessagesChannel');
  const descInput = document.getElementById('serverSettingsDescription');
  const discoverableInput = document.getElementById('serverDiscoverable');
  
  const newName = serverNameInput.value.trim();
  const iconFile = serverIconInput.files[0];
  const systemChannel = systemSelect ? systemSelect.value : null;
  const description = descInput ? descInput.value.trim() : '';
  const discoverable = discoverableInput ? !!discoverableInput.checked : false;

  if (newName && newName.length > LIMITS.serverName) {
    showToast(`Server name max ${LIMITS.serverName} characters`, 'error');
    return;
  }
  if (description.length > LIMITS.serverDescription) {
    showToast(`Description max ${LIMITS.serverDescription} characters`, 'error');
    return;
  }

  const updates = {};
  if (newName) {
    updates['name'] = newName;
  }
  updates['description'] = description;
  updates['discoverable'] = discoverable;
  if (systemChannel) {
    updates['systemChannel'] = systemChannel;
  }

  if (iconFile) {
    compressImageFile(iconFile, { maxSize: 256, quality: 0.7, type: 'image/jpeg' })
      .then(dataUrl => {
        updates['icon'] = dataUrl;
        return db.ref(`servers/${currentServer}`).update(updates);
      })
      .then(() => {
        elements.serverName.textContent = newName || elements.serverName.textContent;
        loadUserServers();
        hideModal('serverSettings');
        showToast('Server settings saved', 'success');
        serverIconInput.value = '';
        document.getElementById('serverSettingsIconLabel').textContent = 'Click to upload server icon';
      })
      .catch(err => {
        showToast('Failed to update server icon: ' + err.message, 'error');
      });
  } else {
    db.ref(`servers/${currentServer}`).update(updates).then(() => {
      elements.serverName.textContent = newName || elements.serverName.textContent;
      loadUserServers();
      hideModal('serverSettings');
      showToast('Server settings saved', 'success');
    });
  }
}

function setupServerSettingsModal() {
  if (!currentServer) return;

  db.ref(`servers/${currentServer}`).once('value').then(snap => {
    const serverData = snap.val() || {};
    const serverNameInput = document.getElementById('serverSettingsName');
    if (serverNameInput) {
      serverNameInput.value = serverData.name || '';
    }
    const descInput = document.getElementById('serverSettingsDescription');
    if (descInput) {
      descInput.value = serverData.description || '';
    }
    const discoverableInput = document.getElementById('serverDiscoverable');
    if (discoverableInput) {
      discoverableInput.checked = !!serverData.discoverable;
    }

    // Populate system messages channel select
    const systemSelect = document.getElementById('systemMessagesChannel');
    if (systemSelect) {
      systemSelect.innerHTML = '';
      db.ref(`servers/${currentServer}/channels`).once('value').then(channelSnap => {
        const channels = channelSnap.val() || {};
        Object.keys(channels).forEach(name => {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = `# ${name}`;
          systemSelect.appendChild(opt);
        });

        const currentSystem = serverData.systemChannel || 'general';
        systemSelect.value = currentSystem;
      });
    }
  });
}

// Role Management Functions
let selectedRole = null;

function loadRoles() {
  if (!currentServer) return;

  if (rolesListRef) {
    rolesListRef.off();
  }
  rolesListRef = db.ref(`servers/${currentServer}/roles`);
  rolesListRef.on('value', (snap) => {
      const roles = snap.val() || {
        Admin: { permissions: ['manage_server', 'manage_channels', 'manage_messages', 'manage_roles', 'send_messages', 'view_channels', 'mention_everyone'], color: '#f23f43', hoist: true },
        Moderator: { permissions: ['manage_messages', 'send_messages', 'view_channels', 'mention_everyone'], color: '#5865f2', hoist: true },
        Member: { permissions: ['send_messages', 'view_channels'], color: '#949ba4', hoist: false }
      };

    // Load join role select
    const joinRoleSelect = document.getElementById('joinRoleSelect');
    joinRoleSelect.innerHTML = '';
    Object.keys(roles).forEach(roleName => {
      const opt = document.createElement('option');
      opt.value = roleName;
      opt.textContent = roleName;
      joinRoleSelect.appendChild(opt);
    });

    // Load current join role
    db.ref(`servers/${currentServer}/joinRole`).once('value').then(joinSnap => {
      const joinRole = joinSnap.val() || 'Member';
      joinRoleSelect.value = joinRole;
    });

    // Add change event listener for join role select (overwrite to avoid duplicates)
    joinRoleSelect.onchange = setJoinRole;

    // Load roles list
    const rolesList = document.getElementById('rolesList');
    const roleDivMap = {};
    rolesList.innerHTML = '';
    Object.entries(roles).forEach(([roleName, roleData]) => {
      const roleDiv = document.createElement('div');
      roleDiv.className = 'role-item';
      roleDiv.style.display = 'flex';
      roleDiv.style.alignItems = 'center';
      roleDiv.style.gap = '8px';
      roleDiv.style.padding = '12px';
      roleDiv.style.backgroundColor = '#2b2d31';
      roleDiv.style.borderRadius = '8px';
      roleDiv.style.cursor = 'pointer';
      roleDiv.style.border = selectedRole === roleName ? '2px solid #5865f2' : '2px solid transparent';
      
      roleDiv.innerHTML = `
        <div style="width: 24px; height: 24px; border-radius: 50%; background: ${roleData.color};"></div>
        <div style="flex: 1;">
          <div style="font-weight: 600; color: #dbdee1;">${roleName}</div>
          <div style="font-size: 12px; color: #949ba4;">${(roleData.permissions || []).length} permissions</div>
        </div>
        ${roleData.hoist ? '<span style="font-size: 14px;"><i class="fa-solid fa-thumbtack"></i></span>' : ''}
      `;

      roleDiv.addEventListener('click', (e) => selectRoleForEdit(roleName, roleData, e.currentTarget));
      rolesList.appendChild(roleDiv);
      roleDivMap[roleName] = roleDiv;
    });

    // Restore selected role form with last permissions if still exists
    if (selectedRole && roles[selectedRole] && roleDivMap[selectedRole]) {
      selectRoleForEdit(selectedRole, roles[selectedRole], roleDivMap[selectedRole]);
    } else {
      clearEditRole();
    }
  });
}

function setupRoleColorPicker() {
  const editRoleColor = document.getElementById('editRoleColor');
  const editRoleColorPreview = document.getElementById('editRoleColorPreview');
  
  editRoleColor.addEventListener('input', (e) => {
    editRoleColorPreview.style.backgroundColor = e.target.value;
    editRoleColorPreview.textContent = e.target.value;
  });
}

function selectRoleForEdit(roleName, roleData, roleElement) {
  selectedRole = roleName;
  document.getElementById('editRoleTitle').textContent = `Edit Role: ${roleName}`;
  document.getElementById('editRoleName').value = roleName;
  document.getElementById('editRoleColor').value = roleData.color;
  document.getElementById('editRoleColorPreview').style.backgroundColor = roleData.color;
  document.getElementById('editRoleColorPreview').textContent = roleData.color;

  // Set permissions
  const permissionCheckboxMap = {
    permManageServer: 'manage_server',
    permManageChannels: 'manage_channels',
    permManageMessages: 'manage_messages',
    permManageRoles: 'manage_roles',
    permSendMessages: 'send_messages',
    permViewChannels: 'view_channels',
    permMentionEveryone: 'mention_everyone'
  };
  const rolePerms = roleData.permissions || [];
  Object.entries(permissionCheckboxMap).forEach(([checkboxId, perm]) => {
    const checkbox = document.getElementById(checkboxId);
    if (checkbox) {
      checkbox.checked = rolePerms.includes(perm);
    }
  });

  const permHoist = document.getElementById('permHoist');
  if (permHoist) permHoist.checked = !!roleData.hoist;

  // Show/hide delete button (can't delete default roles)
  const deleteBtn = document.getElementById('deleteRoleBtn');
  deleteBtn.style.display = ['Admin', 'Moderator', 'Member'].includes(roleName) ? 'none' : 'inline-block';

  // Highlight selected role in list
  document.querySelectorAll('.role-item').forEach(item => {
    item.style.border = '2px solid transparent';
  });
  if (roleElement) {
    roleElement.style.border = '2px solid #5865f2';
  }
}

function clearEditRole() {
  selectedRole = null;
  document.getElementById('editRoleTitle').textContent = 'Edit Role';
  document.getElementById('editRoleName').value = '';
  document.getElementById('editRoleColor').value = '#5865f2';
  document.getElementById('editRoleColorPreview').style.backgroundColor = '#5865f2';
  document.getElementById('editRoleColorPreview').textContent = '#5865f2';

  const permissions = ['manage_server', 'manage_channels', 'manage_messages', 'manage_roles', 'send_messages', 'view_channels', 'mention_everyone', 'hoist'];
  permissions.forEach(perm => {
    const checkbox = document.getElementById(`perm${perm.charAt(0).toUpperCase() + perm.slice(1)}`);
    if (checkbox) {
      checkbox.checked = false;
    }
  });

  document.getElementById('deleteRoleBtn').style.display = 'none';

  document.querySelectorAll('.role-item').forEach(item => {
    item.style.border = '2px solid transparent';
  });
}

function createNewRole() {
  const roleName = document.getElementById('newRoleName').value.trim();
  const roleColor = document.getElementById('newRoleColor').value;

  if (!roleName) {
    showToast('Please enter a role name', 'error');
    return;
  }
  if (roleName.length > LIMITS.roleName) {
    showToast(`Role name max ${LIMITS.roleName} characters`, 'error');
    return;
  }

  db.ref(`servers/${currentServer}/roles`).once('value').then(snap => {
    const roles = snap.val() || {};
    if (roles[roleName]) {
      showToast('Role name already exists', 'error');
      return;
    }

    const newRole = {
      permissions: ['send_messages', 'view_channels'],
      color: roleColor,
      hoist: false
    };

    db.ref(`servers/${currentServer}/roles/${roleName}`).set(newRole).then(() => {
      showToast(`Role "${roleName}" created successfully`, 'success');
      document.getElementById('newRoleName').value = '';
      document.getElementById('newRoleColor').value = '#5865f2';
      loadRoles();
    }).catch(err => {
      showToast('Failed to create role: ' + err.message, 'error');
    });
  });
}

function saveEditRole() {
  if (!selectedRole) return;

  const newRoleName = document.getElementById('editRoleName').value.trim();
  const newRoleColor = document.getElementById('editRoleColor').value;

  if (!newRoleName) {
    showToast('Please enter a role name', 'error');
    return;
  }
  if (newRoleName.length > LIMITS.roleName) {
    showToast(`Role name max ${LIMITS.roleName} characters`, 'error');
    return;
  }

  // Collect permissions
  const permissions = [];
  const permissionCheckboxMap = {
    permManageServer: 'manage_server',
    permManageChannels: 'manage_channels',
    permManageMessages: 'manage_messages',
    permManageRoles: 'manage_roles',
    permSendMessages: 'send_messages',
    permViewChannels: 'view_channels',
    permMentionEveryone: 'mention_everyone'
  };
  Object.entries(permissionCheckboxMap).forEach(([checkboxId, perm]) => {
    const checkbox = document.getElementById(checkboxId);
    if (checkbox && checkbox.checked) {
      permissions.push(perm);
    }
  });

  // Check hoist permission
  const permHoist = document.getElementById('permHoist');
  const hoist = permHoist && permHoist.checked;

  db.ref(`servers/${currentServer}/roles`).once('value').then(snap => {
    const roles = snap.val() || {};

    // If renaming to an existing role name (different from current)
    if (newRoleName !== selectedRole && roles[newRoleName]) {
      showToast('Role name already exists', 'error');
      return;
    }

    const roleData = {
      permissions: permissions,
      color: newRoleColor,
      hoist: hoist
    };

    const renamePromise = newRoleName !== selectedRole
      ? updateRoleReferences(selectedRole, newRoleName)
      : Promise.resolve();

    renamePromise.then(() => {
      // Update the role
      const oldRoleRef = db.ref(`servers/${currentServer}/roles/${selectedRole}`);
      const newRoleRef = db.ref(`servers/${currentServer}/roles/${newRoleName}`);

      return oldRoleRef.remove().then(() => newRoleRef.set(roleData));
    }).then(() => {
      showToast(`Role "${newRoleName}" updated successfully`, 'success');
      selectedRole = newRoleName;
      loadRoles();
    }).catch(err => {
      showToast('Failed to update role: ' + err.message, 'error');
    });
  });
}

function updateRoleReferences(oldRole, newRole) {
  const updates = [];

  // Update members with old role
  const membersPromise = db.ref(`servers/${currentServer}/members`).once('value').then(membersSnap => {
    const members = membersSnap.val() || {};
    const memberUpdates = [];
    Object.keys(members).forEach(uid => {
      if (members[uid].role === oldRole) {
        memberUpdates.push(db.ref(`servers/${currentServer}/members/${uid}/role`).set(newRole));
        if (uid === currentUser.uid) {
          userProfile.role = newRole;
          updateUserDisplay();
        }
      }
    });
    return Promise.all(memberUpdates);
  });
  updates.push(membersPromise);

  // Update join role if needed
  const joinRolePromise = db.ref(`servers/${currentServer}/joinRole`).once('value').then(joinSnap => {
    const joinRole = joinSnap.val();
    if (joinRole === oldRole) {
      return db.ref(`servers/${currentServer}/joinRole`).set(newRole);
    }
    return Promise.resolve();
  });
  updates.push(joinRolePromise);

  // Update channel permission references
  const channelPermsPromise = db.ref(`servers/${currentServer}/channels_data`).once('value').then(channelsSnap => {
    const channels = channelsSnap.val() || {};
    const channelUpdates = [];
    Object.keys(channels).forEach(channelName => {
      const perms = channels[channelName]?.permissions;
      if (!perms) return;

      const viewRoles = (perms.requiredRolesToView || []).map(role => role === oldRole ? newRole : role);
      const sendRoles = (perms.requiredRolesToSend || []).map(role => role === oldRole ? newRole : role);
      const voiceRoles = (perms.voiceRoles || []).map(role => role === oldRole ? newRole : role);

      channelUpdates.push(
        db.ref(`servers/${currentServer}/channels_data/${channelName}/permissions`).update({
          requiredRolesToView: viewRoles,
          requiredRolesToSend: sendRoles,
          voiceRoles: voiceRoles
        })
      );
    });
    return Promise.all(channelUpdates);
  });
  updates.push(channelPermsPromise);

  return Promise.all(updates);
}

function deleteRole() {
  if (!selectedRole || ['Admin', 'Moderator', 'Member'].includes(selectedRole)) {
    showToast('Cannot delete default roles', 'error');
    return;
  }

  if (!confirm(`Are you sure you want to delete role "${selectedRole}"? Members with this role will be set to Member.`)) {
    return;
  }

  // Update all members with this role to Member
  db.ref(`servers/${currentServer}/members`).once('value').then(membersSnap => {
    const members = membersSnap.val() || {};
    Object.keys(members).forEach(uid => {
      if (members[uid].role === selectedRole) {
        db.ref(`servers/${currentServer}/members/${uid}/role`).set('Member');
      }
    });
  });

  // Delete the role
  db.ref(`servers/${currentServer}/roles/${selectedRole}`).remove().then(() => {
    showToast(`Role "${selectedRole}" deleted`, 'success');
    clearEditRole();
    loadRoles();
  }).catch(err => {
    showToast('Failed to delete role: ' + err.message, 'error');
  });
}

// Join Role Functions
function setJoinRole() {
  const joinRoleSelect = document.getElementById('joinRoleSelect');
  const joinRole = joinRoleSelect.value;

  db.ref(`servers/${currentServer}/joinRole`).set(joinRole).then(() => {
    showToast(`Join role set to "${joinRole}"`, 'success');
  }).catch(err => {
    showToast('Failed to set join role: ' + err.message, 'error');
  });
}

// Override joinServer to use join role
function joinServer() {
  const joinCodeInput = document.getElementById('joinCodeInput');
  const code = joinCodeInput ? joinCodeInput.value.trim().toUpperCase() : '';
  
  if (!code) {
    showToast('Please enter an invite code', 'error');
    return;
  }

  db.ref('servers').once('value').then(snapshot => {
    const servers = snapshot.val() || {};
    let foundServer = null;

    Object.entries(servers).forEach(([id, data]) => {
      if (data.invite === code) foundServer = id;
    });

    if (!foundServer) {
      showToast('Invalid invite code', 'error');
      return;
    }

    if (userServers.includes(foundServer)) {
      showToast('You are already in this server', 'error');
      return;
    }

    // Get join role for this server
    db.ref(`servers/${foundServer}/joinRole`).once('value').then(joinRoleSnap => {
      const joinRole = joinRoleSnap.val() || 'Member';

      db.ref(`servers/${foundServer}/members/${currentUser.uid}`).set({
        username: userProfile.username,
        role: joinRole,
        status: 'online',
        joinedAt: Date.now()
      });

      // Send join message
      sendSystemMessage(foundServer, `${userProfile.username} joined the server.`);

      userServers.push(foundServer);
      saveCookies();
      loadUserServers();
      selectServer(foundServer);
      hideModal('invite');
      isOnboarding = false;
      forceJoinModal = false;
      
      if (joinCodeInput) joinCodeInput.value = '';
      showToast('Successfully joined server!', 'success');
    });
  });
}
