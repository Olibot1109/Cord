function showModal(modalName) {
  const modal = document.getElementById(`${modalName}Modal`);
  if (!modal) return;

  modal.classList.add('active');

  if (modalName === 'invite') {
    if (isOnboarding) {
      forceJoinModal = true;
    }
    setupInviteModal();
  } else if (modalName === 'manageChannels') {
    if (!hasPermission('manage_channels')) {
      showToast('You do not have permission to manage channels', 'error');
      hideModal('manageChannels');
      return;
    }

    // Populate channel select
    const channelSelect = document.getElementById('channelSelect');
    if (!channelSelect) return;
    
    channelSelect.innerHTML = '';

    db.ref(`servers/${currentServer}/channels`).once('value').then(snap => {
      const channels = snap.val() || {};
      Object.keys(channels).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = `# ${name}`;
        opt.dataset.type = 'text';
        channelSelect.appendChild(opt);
      });

      if (Object.keys(channels).length > 0) loadChannelPermissions();
    });

    db.ref(`servers/${currentServer}/voiceChannels`).once('value').then(snap => {
      const channels = snap.val() || {};
      Object.keys(channels).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = `Voice: ${name}`;
        opt.dataset.type = 'voice';
        channelSelect.appendChild(opt);
      });
    });
  } else if (modalName === 'serverSettings') {
    if (!hasPermission('manage_server')) {
      showToast('You do not have permission to manage this server', 'error');
      hideModal('serverSettings');
      return;
    }
    setupServerSettingsModal();
  } else if (modalName === 'roles') {
    if (!hasPermission('manage_roles')) {
      showToast('You do not have permission to manage roles', 'error');
      hideModal('roles');
      return;
    }
    loadRoles();
    setupRoleColorPicker();
  } else if (modalName === 'addFriend') {
    if (elements.directMessagesCategory && !isHomeView) {
      showToast('Go to Home to add friends', 'error');
      hideModal('addFriend');
      return;
    }
  }
}

function backFromCreateServer() {
  hideModal('addServer');
  if (isOnboarding) {
    showModal('welcome');
  }
}

function setupInviteModal() {
  const inviteSection = document.getElementById('inviteSection');
  const joinSection = document.getElementById('joinSection');
  const closeBtn = document.getElementById('inviteCloseBtn');
  const joinBtn = document.getElementById('inviteJoinBtn');
  const backBtn = document.getElementById('inviteBackBtn');
  const title = document.getElementById('inviteModalTitle');
  const subtitle = document.getElementById('inviteModalSubtitle');

  if (currentServer && !isHomeView && !isDiscoveryView) {
    // User is in a server - show invite code and join option
    if (inviteSection) inviteSection.style.display = 'block';
    if (joinSection) joinSection.style.display = 'block';
    if (joinBtn) joinBtn.style.display = 'inline-block';
    if (closeBtn) closeBtn.textContent = forceJoinModal ? 'Disabled' : 'Close';
    if (title) title.textContent = 'Invite Friends';
    if (subtitle) subtitle.textContent = 'Share your server with others';
    if (backBtn) backBtn.style.display = 'none';

    db.ref(`servers/${currentServer}/invite`).once('value').then(snap => {
      let code = snap.val();
      if (!code) {
        code = generateInviteCode();
        db.ref(`servers/${currentServer}/invite`).set(code);
      }
      const inviteCode = document.getElementById('inviteCode');
      if (inviteCode) inviteCode.textContent = code;
    });
  } else {
    // User is not in a server - show only join option
    if (inviteSection) inviteSection.style.display = 'none';
    if (joinSection) joinSection.style.display = 'block';
    if (joinBtn) joinBtn.style.display = 'inline-block';
    if (closeBtn) closeBtn.textContent = forceJoinModal ? 'Disabled' : 'Cancel';
    if (title) title.textContent = 'Join a Server';
    if (subtitle) subtitle.textContent = 'Enter an invite code to join an existing server';
    if (backBtn) backBtn.style.display = isOnboarding ? 'inline-flex' : 'none';
  }

  if (forceJoinModal) {
    if (closeBtn) closeBtn.style.display = 'none';
  } else {
    if (closeBtn) closeBtn.style.display = 'inline-block';
  }
}

function backFromInviteModal() {
  if (!isOnboarding) {
    closeInviteModal();
    return;
  }
  hideModal('invite');
  showModal('welcome');
}

function closeInviteModal() {
  if (forceJoinModal) return;
  hideModal('invite');
  const joinCodeInput = document.getElementById('joinCodeInput');
  if (joinCodeInput) joinCodeInput.value = '';
}

function hideModal(modalName) {
  const modal = document.getElementById(`${modalName}Modal`);
  if (modal) modal.classList.remove('active');
}

function showServerMenu(event) {
  if (isHomeView || !currentServer) return;
  event.stopPropagation();
  const menu = document.getElementById('serverMenu');
  const rect = event.currentTarget.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 5}px`;
  menu.style.left = `${rect.left}px`;
  menu.classList.toggle('active');
}

function generateInviteCode() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

function copyInviteCode() {
  const inviteCode = document.getElementById('inviteCode');
  if (!inviteCode) return;
  
  const code = inviteCode.textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.querySelector('.copy-btn');
    if (btn) {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    }
  });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '<i class="fa-solid fa-check"></i>' : type === 'error' ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-circle-info"></i>'}</span>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

let imageViewerScale = 1;
let imageViewerTranslateX = 0;
let imageViewerTranslateY = 0;
let imageViewerDragging = false;
let imageViewerDragStartX = 0;
let imageViewerDragStartY = 0;
let imageViewerKeyHandlerAttached = false;

function getImageViewerElements() {
  const overlay = document.getElementById('imageViewerOverlay');
  if (!overlay) return null;
  return {
    overlay,
    viewport: document.getElementById('imageViewerViewport'),
    image: document.getElementById('imageViewerImage')
  };
}

function applyImageViewerTransform() {
  const refs = getImageViewerElements();
  if (!refs || !refs.image) return;
  refs.image.style.transform = `translate(${imageViewerTranslateX}px, ${imageViewerTranslateY}px) scale(${imageViewerScale})`;
}

function setImageViewerScale(nextScale) {
  imageViewerScale = Math.max(1, Math.min(6, nextScale));
  if (imageViewerScale <= 1) {
    imageViewerTranslateX = 0;
    imageViewerTranslateY = 0;
  }
  applyImageViewerTransform();
}

function closeImageViewer() {
  const refs = getImageViewerElements();
  if (!refs) return;
  refs.overlay.classList.remove('active');
  document.body.classList.remove('image-viewer-open');
  imageViewerDragging = false;
}

function ensureImageViewer() {
  let refs = getImageViewerElements();
  if (refs) return refs;

  const overlay = document.createElement('div');
  overlay.id = 'imageViewerOverlay';
  overlay.className = 'image-viewer-overlay';
  overlay.innerHTML = `
    <div class="image-viewer-toolbar">
      <button class="image-viewer-btn" id="imageViewerZoomOut" title="Zoom out"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
      <button class="image-viewer-btn" id="imageViewerZoomIn" title="Zoom in"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
      <button class="image-viewer-btn" id="imageViewerReset" title="Reset zoom"><i class="fa-solid fa-arrows-rotate"></i></button>
      <button class="image-viewer-btn close" id="imageViewerClose" title="Close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="image-viewer-viewport" id="imageViewerViewport">
      <img id="imageViewerImage" class="image-viewer-image" alt="">
    </div>
  `;
  document.body.appendChild(overlay);

  refs = getImageViewerElements();
  if (!refs || !refs.viewport || !refs.image) return null;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeImageViewer();
  });

  const zoomInBtn = document.getElementById('imageViewerZoomIn');
  const zoomOutBtn = document.getElementById('imageViewerZoomOut');
  const resetBtn = document.getElementById('imageViewerReset');
  const closeBtn = document.getElementById('imageViewerClose');

  if (zoomInBtn) zoomInBtn.addEventListener('click', () => setImageViewerScale(imageViewerScale + 0.2));
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => setImageViewerScale(imageViewerScale - 0.2));
  if (resetBtn) resetBtn.addEventListener('click', () => setImageViewerScale(1));
  if (closeBtn) closeBtn.addEventListener('click', closeImageViewer);

  refs.viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.12 : -0.12;
    setImageViewerScale(imageViewerScale + step);
  }, { passive: false });

  refs.image.addEventListener('mousedown', (e) => {
    if (imageViewerScale <= 1) return;
    imageViewerDragging = true;
    imageViewerDragStartX = e.clientX - imageViewerTranslateX;
    imageViewerDragStartY = e.clientY - imageViewerTranslateY;
    refs.image.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!imageViewerDragging || imageViewerScale <= 1) return;
    imageViewerTranslateX = e.clientX - imageViewerDragStartX;
    imageViewerTranslateY = e.clientY - imageViewerDragStartY;
    applyImageViewerTransform();
  });

  window.addEventListener('mouseup', () => {
    imageViewerDragging = false;
    if (refs && refs.image) refs.image.classList.remove('dragging');
  });

  if (!imageViewerKeyHandlerAttached) {
    document.addEventListener('keydown', (e) => {
      const active = document.getElementById('imageViewerOverlay')?.classList.contains('active');
      if (!active) return;
      if (e.key === 'Escape') closeImageViewer();
      if (e.key === '+' || e.key === '=') setImageViewerScale(imageViewerScale + 0.2);
      if (e.key === '-') setImageViewerScale(imageViewerScale - 0.2);
      if (e.key === '0') setImageViewerScale(1);
    });
    imageViewerKeyHandlerAttached = true;
  }

  return refs;
}

function openImageViewer(src) {
  if (!src) return;
  const refs = ensureImageViewer();
  if (!refs || !refs.image || !refs.overlay) return;
  imageViewerScale = 1;
  imageViewerTranslateX = 0;
  imageViewerTranslateY = 0;
  refs.image.src = src;
  applyImageViewerTransform();
  refs.overlay.classList.add('active');
  document.body.classList.add('image-viewer-open');
}

// Reactions
const QUICK_REACTIONS = ['👍', '😂', '❤️', '😮', '😢', '🎉'];
const EMOJI_SETS = {
  'Smileys': ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😍','😘','😗','😙','😚','😋','😜','😝','😛','🤪','🤨','🧐','🤓','😎','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😭','😤','😠','😡','🤬','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤭','🤫','🤔','💀','☠️','👻','🤡','💩','🤖'],
  'Gestures': ['👍','👎','👏','🙌','🫶','🙏','🤝','✌️','🤞','🤟','🤘','👌','🤌','👋','🤚','🖐️','✋','👊','✊','🤛','🤜','🫳','🫴','🫱','🫲', '🖕'],
  'Hearts': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝'],
  'Objects': ['🎉','🎊','✨','🔥','💯','✅','❌','⭐','🌟','💡','📌','📎','🧠','💎','🔔','📢','🎮','🎵','🎬','🧨','🎯','🍿','🧃'],
  'Nature': ['🌞','🌝','🌙','⭐','🌈','🌊','🔥','💧','🍀','🌸','🌻','🍁','🌵','🌲','🪵','🪻']
};

function showReactionPicker(e, messageId) {
  if (e) e.stopPropagation();
  const existing = document.querySelector('.reaction-picker');
  if (existing) existing.remove();

  const existingOverlay = document.querySelector('.reaction-picker-overlay');
  if (existingOverlay) existingOverlay.remove();

  const msgEl = document.getElementById(`msg-${messageId}`);
  if (!msgEl) return;

  const overlay = document.createElement('div');
  overlay.className = 'reaction-picker-overlay';
  overlay.addEventListener('click', () => overlay.remove());

  const picker = document.createElement('div');
  picker.className = 'reaction-picker large';
  picker.addEventListener('click', (evt) => evt.stopPropagation());

  const header = document.createElement('div');
  header.className = 'reaction-picker-header';
  header.textContent = 'Pick an emoji';
  picker.appendChild(header);

  const tabs = document.createElement('div');
  tabs.className = 'reaction-picker-tabs';
  picker.appendChild(tabs);

  const grid = document.createElement('div');
  grid.className = 'reaction-picker-grid';
  picker.appendChild(grid);

  const renderCategory = (name) => {
    grid.innerHTML = '';
    const emojis = EMOJI_SETS[name] || [];
    emojis.forEach(emoji => {
      const btn = document.createElement('button');
      btn.className = 'reaction-picker-btn';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        toggleReaction(messageId, emoji);
        overlay.remove();
      });
      grid.appendChild(btn);
    });
  };

  Object.keys(EMOJI_SETS).forEach((name, idx) => {
    const tab = document.createElement('button');
    tab.className = 'reaction-tab' + (idx === 0 ? ' active' : '');
    tab.textContent = name;
    tab.addEventListener('click', () => {
      picker.querySelectorAll('.reaction-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderCategory(name);
    });
    tabs.appendChild(tab);
  });

  renderCategory(Object.keys(EMOJI_SETS)[0]);

  overlay.appendChild(picker);
  document.body.appendChild(overlay);
}

function toggleReaction(messageId, emoji) {
  if (!currentChannel) return;

  const basePath = currentChannelType === 'dm'
    ? `dms/${currentChannel}/messages/${messageId}/reactions`
    : `servers/${currentServer}/channels_data/${currentChannel}/messages/${messageId}/reactions`;

  const reactionsBaseRef = db.ref(basePath);
  const reactionRef = db.ref(`${basePath}/${emoji}/${currentUser.uid}`);

  reactionRef.once('value').then(snap => {
    if (snap.exists()) {
      reactionRef.remove();
      return;
    }

    // Enforce max 5 reactions per user per message
    reactionsBaseRef.once('value').then(allSnap => {
      const allReactions = allSnap.val() || {};
      let userCount = 0;
      Object.values(allReactions).forEach(users => {
        if (users && users[currentUser.uid]) userCount += 1;
      });

      if (userCount >= 5) {
        showToast('You can only add up to 5 reactions on a message', 'error');
        return;
      }

      reactionRef.set(true);
    });
  });
}

function updateMessageReactions(messageId, reactions) {
  const container = document.getElementById(`reactions-${messageId}`);
  if (!container) return;

  container.innerHTML = '';
  const entries = Object.entries(reactions || {});

  entries.forEach(([emoji, users]) => {
    const count = users ? Object.keys(users).length : 0;
    if (count === 0) return;
    const reacted = users && users[currentUser.uid];

    const chip = document.createElement('button');
    chip.className = 'reaction-chip' + (reacted ? ' reacted' : '');
    chip.textContent = `${emoji} ${count}`;
    chip.addEventListener('click', () => toggleReaction(messageId, emoji));
    container.appendChild(chip);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function startPresenceUpdates() {
  setInterval(() => {
    if (!currentUser) return;
    db.ref(`profiles/${currentUser.uid}`).update({
      status: userProfile.status,
      lastSeen: Date.now()
    });
  }, 30000);
}

function compressImageFile(file, options) {
  const opts = {
    maxSize: options?.maxSize || 1024,
    quality: options?.quality ?? 0.7,
    type: options?.type || 'image/jpeg'
  };

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image'));
      img.onload = () => {
        const scale = Math.min(1, opts.maxSize / Math.max(img.width, img.height));
        const targetW = Math.max(1, Math.round(img.width * scale));
        const targetH = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetW, targetH);

        try {
          const dataUrl = canvas.toDataURL(opts.type, opts.quality);
          resolve(dataUrl);
        } catch (err) {
          reject(err);
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
