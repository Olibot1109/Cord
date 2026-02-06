// Permissions
function hasPermission(permission) {
  if (isServerOwner()) return true;
  const rolePerms = getRolePermissions(userProfile.role);
  return rolePerms.includes(permission);
}

function isServerOwner() {
  return !!(currentUser && currentServerOwnerId && currentUser.uid === currentServerOwnerId);
}

function getRolePermissions(roleName) {
  if (!roleName) return [];
  const roleData = rolesCache && rolesCache[roleName];
  if (roleData && Array.isArray(roleData.permissions)) {
    return roleData.permissions;
  }
  return DEFAULT_ROLE_PERMISSIONS[roleName] || [];
}

function getRoleColor(role) {
  // Default colors for known roles
  const defaultColors = {
    Owner: '#f0b232',
    Admin: '#f23f43',
    Moderator: '#5865f2',
    Member: '#949ba4',
    System: '#23a559'
  };

  // Try to get dynamic role colors from Firebase
  if (currentServer) {
    const rolesRef = db.ref(`servers/${currentServer}/roles`);
    let roleColor = defaultColors[role];
    
    // Get the color synchronously from the current server data
    rolesRef.once('value').then(snap => {
      const roles = snap.val();
      if (roles && roles[role] && roles[role].color) {
        roleColor = roles[role].color;
      }
    });
    
    return roleColor;
  }

  return defaultColors[role] || '#5865f2';
}

// Channel Permissions
function loadChannelPermissions() {
  const channelSelect = document.getElementById('channelSelect');
  if (!channelSelect) return;
  
  const channelName = channelSelect.value;
  const selectedOption = channelSelect.options[channelSelect.selectedIndex];
  const isVoice = selectedOption ? selectedOption.dataset.type === 'voice' : false;

  if (!channelName) return;

  // Load roles from server
  db.ref(`servers/${currentServer}/roles`).once('value').then(rolesSnap => {
    const roles = rolesSnap.val() || {
      Admin: { permissions: ['manage_server', 'manage_channels', 'manage_messages', 'manage_roles', 'send_messages', 'view_channels', 'mention_everyone'], color: '#f23f43', hoist: true },
      Moderator: { permissions: ['manage_messages', 'send_messages', 'view_channels', 'mention_everyone'], color: '#5865f2', hoist: true },
      Member: { permissions: ['send_messages', 'view_channels'], color: '#949ba4', hoist: false }
    };

    // Load channel permissions
    db.ref(`servers/${currentServer}/channels_data/${channelName}/permissions`).once('value').then(snap => {
      const perms = snap.val() || {};
      
      // Load channel topic and description
      db.ref(`servers/${currentServer}/channels_data/${channelName}/topic`).once('value').then(topicSnap => {
        document.getElementById('channelTopicInput').value = topicSnap.val() || '';
      });

      db.ref(`servers/${currentServer}/channels_data/${channelName}/description`).once('value').then(descSnap => {
        document.getElementById('channelDescriptionInput').value = descSnap.val() || '';
      });

      db.ref(`servers/${currentServer}/channels_data/${channelName}/slowmodeSeconds`).once('value').then(slowSnap => {
        const slowVal = slowSnap.val();
        const slowInput = document.getElementById('channelSlowmodeInput');
        if (slowInput) slowInput.value = slowVal || 0;
      });

      // Generate dynamic view permissions checkboxes
      const viewPermissionsList = document.getElementById('viewPermissionsList');
      viewPermissionsList.innerHTML = '';
      
      // Generate dynamic send permissions checkboxes
      const sendPermissionsList = document.getElementById('sendPermissionsList');
      sendPermissionsList.innerHTML = '';

      Object.keys(roles).forEach(roleName => {
        // View permissions
        const viewLabel = document.createElement('label');
        viewLabel.style.display = 'flex';
        viewLabel.style.alignItems = 'center';
        viewLabel.style.gap = '8px';
        viewLabel.style.cursor = 'pointer';
        viewLabel.innerHTML = `
          <input type="checkbox" id="view${roleName}" data-role="${roleName}" ${(perms.requiredRolesToView || []).includes(roleName) ? 'checked' : ''}>
          <span style="display:flex;align-items:center;gap:4px;">
            <span style="width:12px;height:12px;border-radius:50%;background:${roles[roleName].color};"></span>
            ${roleName}
          </span>
        `;
        viewPermissionsList.appendChild(viewLabel);

        // Send permissions
        const sendLabel = document.createElement('label');
        sendLabel.style.display = 'flex';
        sendLabel.style.alignItems = 'center';
        sendLabel.style.gap = '8px';
        sendLabel.style.cursor = 'pointer';
        sendLabel.innerHTML = `
          <input type="checkbox" id="send${roleName}" data-role="${roleName}" ${(perms.requiredRolesToSend || []).includes(roleName) ? 'checked' : ''}>
          <span style="display:flex;align-items:center;gap:4px;">
            <span style="width:12px;height:12px;border-radius:50%;background:${roles[roleName].color};"></span>
            ${roleName}
          </span>
        `;
        sendPermissionsList.appendChild(sendLabel);
      });
    });
  });
}

function saveChannelPermissions() {
  const channelSelect = document.getElementById('channelSelect');
  if (!channelSelect) return;
  
  const channelName = channelSelect.value;
  const viewRoles = [];
  const sendRoles = [];

  // Collect all view permissions
  const viewCheckboxes = document.querySelectorAll('#viewPermissionsList input[type="checkbox"]');
  viewCheckboxes.forEach(checkbox => {
    if (checkbox.checked) {
      const roleName = checkbox.dataset.role;
      if (roleName) viewRoles.push(roleName);
    }
  });

  // Collect all send permissions
  const sendCheckboxes = document.querySelectorAll('#sendPermissionsList input[type="checkbox"]');
  sendCheckboxes.forEach(checkbox => {
    if (checkbox.checked) {
      const roleName = checkbox.dataset.role;
      if (roleName) sendRoles.push(roleName);
    }
  });

  // Get topic
  const channelTopic = document.getElementById('channelTopicInput').value.trim();
  const slowInput = document.getElementById('channelSlowmodeInput');
  const slowmodeSeconds = slowInput ? Math.max(0, parseInt(slowInput.value, 10) || 0) : 0;

  // Save permissions
  db.ref(`servers/${currentServer}/channels_data/${channelName}/permissions`).set({
    requiredRolesToView: viewRoles,
    requiredRolesToSend: sendRoles
  });

  db.ref(`servers/${currentServer}/channels_data/${channelName}/slowmodeSeconds`).set(slowmodeSeconds);

  // Save topic
  if (channelTopic) {
    db.ref(`servers/${currentServer}/channels_data/${channelName}/topic`).set(channelTopic);
  } else {
    db.ref(`servers/${currentServer}/channels_data/${channelName}/topic`).remove();
  }

  // Update channel header with topic
  const channelTopicElement = document.getElementById('channelTopic');
  if (channelTopicElement) {
    channelTopicElement.textContent = channelTopic;
    document.getElementById('headerDivider').style.display = channelTopic ? 'block' : 'none';
  }

  hideModal('manageChannels');
  showToast('Channel settings saved', 'success');
  loadChannels();
}
