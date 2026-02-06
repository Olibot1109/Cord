// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyA4BYjOa__uKZjOBvS5p_uMxmJ6AMsKcpg",
  authDomain: "chat1-6cc2e.firebaseapp.com",
  databaseURL: "https://chat1-6cc2e-default-rtdb.firebaseio.com",
  projectId: "chat1-6cc2e",
  storageBucket: "chat1-6cc2e.firebasestorage.app",
  messagingSenderId: "771765903902",
  appId: "1:771765903902:web:a6fb2e71b059c20ba7840f"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

// State Management
let currentUser = null;
let currentServer = null;
let currentChannel = 'general';
let currentChannelType = 'text';
let currentVoiceChannel = null;
let currentServerOwnerId = null;
let userProfile = {
  username: 'User' + Math.floor(Math.random() * 10000),
  avatar: null,
  role: 'Member',
  uid: null,
  status: 'online',
  bio: ''
};
let userServers = [];
let inVoiceChannel = false;
let isMuted = false;
let isDeafened = false;
let isCameraOn = false;
let lastChannelsByServer = {};
let localStream = null;
let peerConnections = {};
let peerCandidates = {};
let peerSessionStart = {};
const STUN_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let messageListeners = [];
let typingTimeout = null;
let cameFromWelcome = false;
let isHomeView = false;
let isDiscoveryView = false;
let currentDmId = null;
let currentDmUser = null;
let dmProfileListeners = {};
let memberListRef = null;
let selectedDiscoveryId = null;
let isOnboarding = false;
let forceJoinModal = false;
let rolesListRef = null;
let rolesCache = {};

// DOM Elements
const elements = {
  serverList: document.getElementById('serverList'),
  serverName: document.getElementById('serverName'),
  channelsContainer: document.getElementById('channelsContainer'),
  textChannelsList: document.getElementById('textChannelsList'),
  voiceChannelsList: document.getElementById('voiceChannelsList'),
  directMessagesCategory: document.getElementById('directMessagesCategory'),
  directMessagesList: document.getElementById('directMessagesList'),
  friendRequestsCategory: document.getElementById('friendRequestsCategory'),
  friendRequestsList: document.getElementById('friendRequestsList'),
  discoveryCategory: document.getElementById('discoveryCategory'),
  discoveryList: document.getElementById('discoveryList'),
  messagesArea: document.getElementById('messagesArea'),
  messageInput: document.getElementById('messageInput'),
  currentChannelName: document.getElementById('currentChannelName'),
  headerIcon: document.getElementById('headerIcon'),
  userName: document.getElementById('userName'),
  userStatus: document.getElementById('userStatus'),
  userAvatar: document.getElementById('userAvatar'),
  userAvatarText: document.getElementById('userAvatarText'),
  voicePanel: document.getElementById('voicePanel'),
  voiceChannelName: document.getElementById('voiceChannelName'),
  voiceVideoGrid: document.getElementById('voiceVideoGrid'),
  memberList: document.getElementById('memberList'),
  membersContainer: document.getElementById('membersContainer'),
  typingIndicator: document.getElementById('typingIndicator'),
  charCount: document.getElementById('charCount'),
  addFriendBtn: document.getElementById('addFriendBtn'),
  discoveryJoinBtn: document.getElementById('discoveryJoinBtn'),
  backToChooserBtn: document.getElementById('backToChooserBtn')
};

// Limits
const LIMITS = {
  serverName: 100,
  serverDescription: 200,
  roleName: 50,
  bio: 160
};

const DEFAULT_ROLE_PERMISSIONS = {
  Admin: ['manage_channels', 'manage_messages', 'manage_roles', 'send_messages', 'view_channels'],
  Moderator: ['manage_messages', 'send_messages', 'view_channels'],
  Member: ['send_messages', 'view_channels']
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  startLoadingSequence();
  loadCookies();
  updateUserDisplay();
  setupEventListeners();
  setupFileInputs();

  auth.signInAnonymously().then(user => {
    currentUser = user.user;
    userProfile.uid = currentUser.uid;
    saveCookies();
    updateProfileData();
    
    console.log('[Auth] User signed in successfully:', {
      uid: currentUser.uid,
      userProfile
    });

    // Ensure user exists in global users list
    db.ref(`users/${currentUser.uid}`).once('value').then(snap => {
      if (!snap.exists()) {
        db.ref(`users/${currentUser.uid}`).set(userProfile.username);
      }
    });

    // Check and clean up any existing voice channel presence on sign in
    if (userServers.length > 0) {
      console.log('[Auth] Checking for existing voice channel presence in', userServers.length, 'servers');
      userServers.forEach(serverId => {
        db.ref(`servers/${serverId}/voiceChannels`).once('value')
          .then(snapshot => {
            const voiceChannels = snapshot.val() || {};
            Object.keys(voiceChannels).forEach(channelName => {
              db.ref(`servers/${serverId}/voiceChannels/${channelName}/users/${currentUser.uid}`).once('value')
                .then(userSnap => {
                  if (userSnap.exists()) {
                    console.log('[Auth] Found existing voice channel presence in server', serverId, 'channel', channelName);
                    db.ref(`servers/${serverId}/voiceChannels/${channelName}/users/${currentUser.uid}`).remove()
                      .then(() => {
                        console.log('[Auth] Cleaned up existing voice channel presence');
                      })
                      .catch(error => {
                        console.error('[Auth] Error cleaning up voice channel presence:', error);
                      });
                  }
                });
            });
          });
      });
    }

    if (userServers.length === 0) {
      isOnboarding = true;
      currentServer = null;
      setCookie('lastServer', '', -1);
      showModal('welcome');
    } else {
      isOnboarding = false;
      currentServer = getCookie('lastServer') || userServers[0];
      initializeApp();
    }
  }).catch(error => {
    console.error('[Auth] Authentication failed:', error);
    showToast('Authentication failed: ' + error.message, 'error');
  });
});

async function startLoadingSequence() {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  setTimeout(() => {
    overlay.classList.add('hidden');
  }, 1600);
}

function initializeApp() {
  console.log('[Initialization] Initializing application');
  
  // Ensure voice channel state is properly reset on page load
  inVoiceChannel = false;
  currentVoiceChannel = null;
  isMuted = false;
  isDeafened = false;
  
  console.log('[Initialization] Voice channel state reset:', {
    inVoiceChannel,
    currentVoiceChannel,
    isMuted,
    isDeafened
  });
  
  loadUserServers();
  if (currentServer) {
    selectServer(currentServer);
  }
  startPresenceUpdates();
  
  console.log('[Initialization] Application initialized successfully');
}

function loadCookies() {
  const profile = getCookie('userProfile');
  if (profile) {
    try {
      userProfile = { ...userProfile, ...JSON.parse(profile) };
    } catch (e) { }
  }

  const servers = getCookie('userServers');
  if (servers) {
    try {
      userServers = JSON.parse(servers);
    } catch (e) {
      userServers = [];
    }
  }

  const lastChannels = getCookie('lastChannelsByServer');
  if (lastChannels) {
    try {
      lastChannelsByServer = JSON.parse(lastChannels);
    } catch (e) {
      lastChannelsByServer = {};
    }
  }

  currentServer = getCookie('lastServer') || null;
}

function saveCookies() {
  setCookie('userProfile', JSON.stringify(userProfile), 365);
  setCookie('userServers', JSON.stringify(userServers), 365);
  setCookie('lastChannelsByServer', JSON.stringify(lastChannelsByServer), 365);
  if (currentServer) setCookie('lastServer', currentServer, 365);
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 86400000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires};path=/`;
}

function updateUserDisplay() {
  elements.userName.textContent = userProfile.username;
  elements.userStatus.textContent = userProfile.status.charAt(0).toUpperCase() + userProfile.status.slice(1);

  if (userProfile.avatar) {
    elements.userAvatar.innerHTML = `<img src="${userProfile.avatar}" alt=""><div class="user-status-indicator" id="userStatusIndicator"></div>`;
  } else {
    elements.userAvatarText.textContent = userProfile.username.charAt(0).toUpperCase();
  }

  const usernameInput = document.getElementById('usernameInput');
  const statusSelect = document.getElementById('statusSelect');
  const bioInput = document.getElementById('bioInput');
  if (usernameInput) usernameInput.value = userProfile.username;
  if (statusSelect) statusSelect.value = userProfile.status;
  if (bioInput) bioInput.value = userProfile.bio || '';

  // Update voice status
  updateUserVoiceStatus();
}

function updateUserVoiceStatus() {
  const userVoiceStatus = document.getElementById('userVoiceStatus');
  const leaveBtn = document.getElementById('leaveBtn');
  const micBtn = document.getElementById('micBtn');
  const deafenBtn = document.getElementById('deafenBtn');
  
  console.log('[Voice Status] Updating voice status. inVoiceChannel:', inVoiceChannel, 'currentVoiceChannel:', currentVoiceChannel);
  
  if (inVoiceChannel) {
    let statusText = 'Voice: ' + currentVoiceChannel;
    let statusClass = '';
    
    if (isMuted) {
      statusText = 'Muted: ' + currentVoiceChannel;
      statusClass = 'muted';
    } else if (isDeafened) {
      statusText = 'Deafened: ' + currentVoiceChannel;
      statusClass = 'deafened';
    }
    
    userVoiceStatus.textContent = statusText;
    userVoiceStatus.className = 'user-voice-status ' + statusClass;
    leaveBtn.style.display = 'inline-block';
    micBtn.style.display = 'inline-block';
    deafenBtn.style.display = 'inline-block';
    
    // Update button styles based on status
    micBtn.style.color = isMuted ? '#f23f43' : '';
    deafenBtn.style.color = isDeafened ? '#f23f43' : '';
    
    console.log('[Voice Status] User is in voice channel. Displaying status:', statusText);
  } else {
    userVoiceStatus.textContent = ''; // Hide "Connect to VC" text
    userVoiceStatus.className = 'user-voice-status';
    leaveBtn.style.display = 'none';
    micBtn.style.display = 'none';
    deafenBtn.style.display = 'none';
    
    // Reset button styles
    micBtn.style.color = '';
    deafenBtn.style.color = '';
    
    console.log('[Voice Status] User is not in voice channel. Hiding voice controls.');
  }
}

function setupEventListeners() {
  // Message input
  elements.messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  elements.messageInput.addEventListener('input', (e) => {
    const len = e.target.value.length;
    elements.charCount.textContent = `${len}/2000`;
    elements.charCount.className = 'char-count' + (len > 1800 ? ' warning' : '') + (len >= 2000 ? ' error' : '');

    // Typing indicator
  if (currentServer && currentChannel && currentChannelType === 'text') {
    db.ref(`servers/${currentServer}/channels_data/${currentChannel}/typing/${currentUser.uid}`).set({
      username: userProfile.username,
      timestamp: Date.now()
    });
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        db.ref(`servers/${currentServer}/channels_data/${currentChannel}/typing/${currentUser.uid}`).remove();
      }, 3000);
    }
  });

  // Close dropdowns on click outside
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('serverMenu');
    if (!e.target.closest('.server-header') && menu.classList.contains('active')) {
      menu.classList.remove('active');
    }
  });

  // Before unload
  window.addEventListener('beforeunload', () => {
    if (currentUser) {
      userServers.forEach(serverId => {
        db.ref(`servers/${serverId}/members/${currentUser.uid}/status`).set('offline');
      });
      if (inVoiceChannel && currentServer) {
        db.ref(`servers/${currentServer}/voiceChannels_data/${inVoiceChannel}/users/${currentUser.uid}`).remove();
      }
    }
  });
}

function setupFileInputs() {
  const avatarInput = document.getElementById('avatarInput');
  const serverIconInput = document.getElementById('serverIconInput');

  if (avatarInput) {
    avatarInput.addEventListener('change', (e) => {
      if (e.target.files[0]) {
        const avatarLabel = document.getElementById('avatarLabel');
        if (avatarLabel) avatarLabel.textContent = `Selected: ${e.target.files[0].name}`;
      }
    });
  }

  if (serverIconInput) {
    serverIconInput.addEventListener('change', (e) => {
      if (e.target.files[0]) {
        const serverIconLabel = document.getElementById('serverIconLabel');
        if (serverIconLabel) serverIconLabel.textContent = `Selected: ${e.target.files[0].name}`;
      }
    });
  }

  const imageInput = document.getElementById('imageInput');
  if (imageInput) imageInput.addEventListener('change', handleImageUpload);
}

// Server Management
function loadUserServers() {
  elements.serverList.innerHTML = `
    <div class="server-icon home" onclick="goHome()" title="Home"><i class="fa-solid fa-house"></i></div>
    <div class="server-icon home" onclick="goDiscovery()" title="Discovery"><i class="fa-solid fa-compass"></i></div>
    <div class="server-divider"></div>
  `;

  const serverIds = [...userServers];

  if (userServers.length === 0) {
    elements.serverList.innerHTML += '<div style="color:#949ba4;text-align:center;padding:20px;font-size:11px;">No servers</div>';
  } else {
    userServers.forEach((serverId, index) => {
      const ref = db.ref(`servers/${serverId}`);
      ref.on('value', snap => {
        if (!snap.exists()) {
          // Server deleted: remove from user list and go home if active
          userServers = userServers.filter(s => s !== serverId);
          saveCookies();
          loadUserServers();
          if (currentServer === serverId) {
            goHome();
          }
          return;
        }

        const serverData = snap.val();
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
          div.innerHTML = `<img src="${serverData.icon}" alt="">`;
        } else {
          div.innerHTML = `<span>${(serverData.name || 'S').charAt(0).toUpperCase()}</span>`;
        }
      });
    });
  }

  const addBtn = document.createElement('div');
  addBtn.className = 'server-icon add-server';
  addBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
  addBtn.title = 'Add a Server';
  addBtn.onclick = () => showModal('serverChooser');
  elements.serverList.appendChild(addBtn);
}

function goDiscovery() {
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

  // Load server data
  db.ref(`servers/${serverId}`).once('value').then(snap => {
    if (snap.exists()) {
      const data = snap.val();
      currentServerOwnerId = data.ownerId || null;
      
      if (elements.serverName) elements.serverName.textContent = data.name || 'Server';
      
      const addChannelServerName = document.getElementById('addChannelServerName');
      if (addChannelServerName) addChannelServerName.textContent = data.name || 'Server';
      
      const addVoiceChannelServerName = document.getElementById('addVoiceChannelServerName');
      if (addVoiceChannelServerName) addVoiceChannelServerName.textContent = data.name || 'Server';

      // Ensure member exists
      db.ref(`servers/${serverId}/members/${currentUser.uid}`).once('value').then(memberSnap => {
        if (!memberSnap.exists()) {
          db.ref(`servers/${serverId}/members/${currentUser.uid}`).set({
            username: userProfile.username,
            role: 'Member',
            avatar: userProfile.avatar,
            status: 'online',
            joinedAt: Date.now()
          });
        } else {
          const memberData = memberSnap.val();
          userProfile.role = memberData.role || 'Member';
          updateUserDisplay();
        }
      });

      loadChannels();
      
      if (elements.memberList.style.display !== 'none') {
        loadMemberList();
      }
    } else {
      // Clean up missing servers from local list
      userServers = userServers.filter(s => s !== serverId);
      saveCookies();
      loadUserServers();
      if (userServers.length === 0) goHome();
    }
  });
}

function goHome() {
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
    if (friendUids.length === 0) {
      elements.directMessagesList.innerHTML = '<div style="color:#949ba4;padding:8px 12px;font-size:12px;">No friends yet</div>';
      return;
    }

    friendUids.forEach(uid => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (currentDmUser && currentDmUser.uid === uid ? ' active' : '');
      div.innerHTML = `
        <span class="channel-icon"><i class="fa-solid fa-comment-dots"></i></span>
        <span data-uid="${uid}">Loading...</span>
        <button class="action-btn delete" style="margin-left:auto;display:none;" data-remove="${uid}" title="Remove Friend"><i class="fa-solid fa-xmark"></i></button>
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
        if (currentDmUser && currentDmUser.uid === uid) {
          currentDmUser.username = username;
          elements.currentChannelName.textContent = username;
          elements.messageInput.placeholder = `Message @${username}`;
        }
      });
      dmProfileListeners[uid] = () => profileRef.off('value', handler);
    });
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
          ${data.icon ? `<img src="${data.icon}" style="width:100%;height:100%;object-fit:cover;">` : `<span style="font-weight:700;color:#dbdee1;">${(data.name || 'S').charAt(0).toUpperCase()}</span>`}
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
  const icon = data?.icon ? `<img src="${data.icon}" style="width:64px;height:64px;border-radius:14px;object-fit:cover;">` : `<div style="width:64px;height:64px;border-radius:14px;background:#2b2d31;display:flex;align-items:center;justify-content:center;font-weight:700;">${name.charAt(0).toUpperCase()}</div>`;
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

function createServer() {
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
        Admin: { permissions: ['manage_channels', 'manage_messages', 'manage_roles', 'send_messages', 'view_channels'], color: '#f23f43', hoist: true },
        Moderator: { permissions: ['manage_messages', 'send_messages', 'view_channels'], color: '#5865f2', hoist: true },
        Member: { permissions: ['send_messages', 'view_channels'], color: '#949ba4', hoist: false }
      }
    };

    db.ref(`servers/${serverId}`).set(serverData).then(() => {
      // Create default channels
      db.ref(`servers/${serverId}/channels/general`).set(true);
      db.ref(`servers/${serverId}/channels/welcome`).set(true);

      // Create default voice channel
      db.ref(`servers/${serverId}/voiceChannels/General`).set({ limit: 0, createdAt: Date.now() });

      // Add creator as admin (owner still gets crown + full perms)
      db.ref(`servers/${serverId}/members/${currentUser.uid}`).set({
        username: userProfile.username,
        role: 'Admin',
        avatar: userProfile.avatar,
        status: 'online',
        joinedAt: Date.now()
      });

      // Add welcome message
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
    });
  };

  if (file) {
    compressImageFile(file, { maxSize: 256, quality: 0.7, type: 'image/jpeg' })
      .then(dataUrl => finalizeCreation(dataUrl))
      .catch(() => finalizeCreation());
  } else {
    finalizeCreation();
  }
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

function joinServer() {
  const joinCodeInput = document.getElementById('joinCodeInput');
  const code = joinCodeInput ? joinCodeInput.value.trim().toUpperCase() : '';
  
  if (!code) {
    showToast('Please enter an invite code', 'error');
    return;
  }
  if (userServers.length >= 10) {
    showToast('Server limit reached (10)', 'error');
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

    db.ref(`servers/${foundServer}/members/${currentUser.uid}`).set({
      username: userProfile.username,
      role: 'Member',
      avatar: userProfile.avatar,
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
    
    if (joinCodeInput) joinCodeInput.value = '';
    showToast('Successfully joined server!', 'success');
  });
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
      db.ref(`servers/${serverId}/members/${currentUser.uid}`).set({
        username: userProfile.username,
        role: joinRole,
        avatar: userProfile.avatar,
        status: 'online',
        joinedAt: Date.now()
      });
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
}

function joinOfficialServer() {
  const code = 'GE83GAOJ';
  if (userServers.length >= 10) {
    return;
  }
  db.ref('servers').once('value').then(snapshot => {
    const servers = snapshot.val() || {};
    let foundServer = null;

    Object.entries(servers).forEach(([id, data]) => {
      if (data.invite === code) foundServer = id;
    });

    if (foundServer && !userServers.includes(foundServer)) {
      db.ref(`servers/${foundServer}/members/${currentUser.uid}`).set({
        username: userProfile.username,
        role: 'Member',
        avatar: userProfile.avatar,
        status: 'online',
        joinedAt: Date.now()
      });

      userServers.push(foundServer);
      saveCookies();

      if (!currentServer) {
        currentServer = foundServer;
        initializeApp();
      }
    }
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
  db.ref(`servers/${serverId}/members/${currentUser.uid}`).remove().then(() => {
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
        if (!hasAccess) div.classList.add('locked');

        div.innerHTML = `<span class="channel-icon"><i class="fa-solid fa-hashtag"></i></span><span>${channelName}</span>`;

        if (hasAccess) {
          div.onclick = () => switchChannel(channelName, 'text');
        } else {
          div.onclick = () => showToast('You do not have permission to view this channel', 'error');
        }

        elements.textChannelsList.appendChild(div);
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
          userDiv.innerHTML = `
            <div class="voice-user-avatar">${userData.avatar ? `<img src="${userData.avatar}">` : (userData.username ? userData.username.charAt(0).toUpperCase() : '?')}</div>
            <span>${userData.username || 'Unknown'}</span>
          `;
          usersDiv.appendChild(userDiv);
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
function loadMessages() {
  if (!currentChannel) return;

  elements.messagesArea.innerHTML = '';

  // Remove old listeners
  messageListeners.forEach(ref => ref.off());
  messageListeners = [];

  const messagesRef = currentChannelType === 'dm'
    ? db.ref(`dms/${currentChannel}/messages`)
    : db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages`);
  messageListeners.push(messagesRef);

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

  // Typing indicator (text channels only)
  if (currentChannelType === 'text') {
    db.ref(`servers/${currentServer}/channels_data/${currentChannel}/typing`).on('value', (snap) => {
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
  } else {
    elements.typingIndicator.classList.remove('active');
  }
}

function addMessage(key, msg) {
  const div = document.createElement('div');
  div.className = 'message';
  div.id = `msg-${key}`;

  const isSystem = msg.uid === 'system';
  const canDelete = !isSystem && (msg.uid === currentUser?.uid || hasPermission('manage_messages'));
  const canEdit = !isSystem && msg.uid === currentUser?.uid;

  const roleBadge = msg.role && msg.role !== 'Member' && msg.role !== 'System'
    ? `<span class="role-badge" style="background:${msg.roleColor || '#5865f2'}">${msg.role}</span>`
    : isSystem ? `<span class="role-badge" style="background:#23a559">SYSTEM</span>` : '';

  let content = '';
  if (msg.text) {
    content = `<div class="message-text">${escapeHtml(msg.text)}</div>`;
  } else if (msg.image) {
    content = `<img src="${msg.image}" class="message-image" onclick="window.open('${msg.image}')" style="cursor:pointer;">`;
  }

  const time = msg.time || new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  div.innerHTML = `
    <div class="message-avatar" style="background:${isSystem ? '#23a559' : (msg.roleColor || '#5865f2')}">
      ${msg.avatar ? `<img src="${msg.avatar}" style="width:100%;height:100%;object-fit:cover;">` : (msg.author ? msg.author.charAt(0).toUpperCase() : '?')}
    </div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-author" style="color:${isSystem ? '#23a559' : '#f2f3f5'}">${escapeHtml(msg.author || 'Unknown')}</span>
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
}

function sendMessage() {
  if (!currentChannel) return;

  const text = elements.messageInput.value.trim();
  if (!text) return;

  if (currentChannelType === 'dm') {
    const messageData = {
      author: userProfile.username,
      text: text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now(),
      avatar: userProfile.avatar || null,
      uid: currentUser.uid
    };

    db.ref(`dms/${currentChannel}/messages`).push(messageData)
      .then(() => {
        elements.messageInput.value = '';
        elements.charCount.textContent = '0/2000';
        elements.charCount.className = 'char-count';
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
            showToast(`Slowmode: wait ${Math.ceil(remaining / 1000)}s`, 'error');
            return;
          }
          doSendMessage();
        });
      } else {
        doSendMessage();
      }
    });

    function doSendMessage() {
      // Get role color
      db.ref(`servers/${currentServer}/roles/${userProfile.role}`).once('value').then(roleSnap => {
      const roleData = roleSnap.val() || {};
      
      const messageData = {
        author: userProfile.username,
        text: text,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now(),
        avatar: userProfile.avatar || null,
        role: userProfile.role,
        roleColor: roleData.color || '#5865f2',
        uid: currentUser.uid
      };

      db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages`).push(messageData)
        .then(() => {
          elements.messageInput.value = '';
          elements.charCount.textContent = '0/2000';
          elements.charCount.className = 'char-count';
          
          // Clear typing indicator
          clearTimeout(typingTimeout);
          db.ref(`servers/${currentServer}/channels_data/${currentChannel}/typing/${currentUser.uid}`).remove();

          // Update slowmode timestamp
          db.ref(`servers/${currentServer}/channels_data/${currentChannel}/slowmodeState/${currentUser.uid}`).set(Date.now());
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
        return db.ref(`dms/${currentChannel}/messages`).push({
          author: userProfile.username,
          image: dataUrl,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          timestamp: Date.now(),
          avatar: userProfile.avatar || null,
          uid: currentUser.uid
        });
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
            showToast(`Slowmode: wait ${Math.ceil(remaining / 1000)}s`, 'error');
            return;
          }
          doSendImage();
        });
      } else {
        doSendImage();
      }
    });

    function doSendImage() {
      compressImageFile(file, { maxSize: 1024, quality: 0.7, type: 'image/jpeg' })
        .then(dataUrl => {
          return db.ref(`servers/${currentServer}/roles/${userProfile.role}`).once('value').then(roleSnap => {
            const roleData = roleSnap.val() || {};
            
            return db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages`).push({
              author: userProfile.username,
              image: dataUrl,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              timestamp: Date.now(),
              avatar: userProfile.avatar || null,
              role: userProfile.role,
              roleColor: roleData.color || '#5865f2',
              uid: currentUser.uid
            });
          });
        })
        .then(() => {
          db.ref(`servers/${currentServer}/channels_data/${currentChannel}/slowmodeState/${currentUser.uid}`).set(Date.now());
        })
        .catch(err => {
          showToast('Failed to send image: ' + err.message, 'error');
        });
    }
  });
  
  e.target.value = '';
}

function deleteMessage(key) {
  if (!currentServer || !currentChannel) return;
  
  if (!confirm('Delete this message?')) return;
  
  db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages/${key}`).remove()
    .catch(err => {
      showToast('Failed to delete message: ' + err.message, 'error');
    });
}

// User Management
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

function updateMemberData() {
  if (!currentServer) return;
  db.ref(`servers/${currentServer}/members/${currentUser.uid}`).update({
    username: userProfile.username,
    avatar: userProfile.avatar,
    status: userProfile.status,
    bio: userProfile.bio || ''
  });
  updateProfileData();
}

function updateProfileData() {
  if (!currentUser) return;
  db.ref(`profiles/${currentUser.uid}`).update({
    username: userProfile.username,
    avatar: userProfile.avatar,
    status: userProfile.status,
    bio: userProfile.bio || ''
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
          const isOnline = member.status === 'online' || (member.lastSeen && Date.now() - member.lastSeen < 60000);
          const statusClass = member.status === 'idle' ? 'idle' : member.status === 'dnd' ? 'dnd' : isOnline ? '' : 'offline';

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
            if (statusText) {
              if (voiceChannelName) {
                let statusIndicator = 'Voice';
                if (isMuted) statusIndicator = 'Muted';
                if (isDeafened) statusIndicator = 'Deafened';
                statusText.textContent = `${statusIndicator}: ${voiceChannelName}`;
              } else {
                statusText.textContent = isOnline ? 'Connect to VC' : member.status;
              }
            }
            }
          });

          const memberDiv = document.createElement('div');
          memberDiv.className = 'member-item';
          memberDiv.setAttribute('data-uid', member.uid);
          
          // Determine status text
          const statusTextContent = voiceChannelName ? `Voice: ${voiceChannelName}` : (isOnline ? 'Connect to VC' : member.status);
          
          const ownerBadge = ownerId && member.uid === ownerId ? '<span class="role-badge" style="background:#f0b232"><i class="fa-solid fa-crown" style="margin-right:6px;"></i>OWNER</span>' : '';
          const bioLine = member.bio ? `<div class="member-bio">${escapeHtml(member.bio)}</div>` : '';
          memberDiv.innerHTML = `
            <div class="member-avatar" style="background:${getRoleColor(member.role)}">
              ${member.avatar ? `<img src="${member.avatar}">` : (member.username ? member.username.charAt(0).toUpperCase() : '?')}
              <div class="member-status ${statusClass}"></div>
            </div>
            <div class="member-info">
              <div class="member-name">${member.username || 'Unknown'} ${ownerBadge}</div>
              <div class="member-status-text">${statusTextContent}</div>
              ${bioLine}
            </div>
          `;
          
          // Click handler for role management / add friend
          memberDiv.style.cursor = 'pointer';
          memberDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            showMemberContextMenu(e, member);
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
          const memberDiv = document.createElement('div');
          memberDiv.className = 'member-item';
          memberDiv.setAttribute('data-uid', member.uid);
          memberDiv.innerHTML = `
            <div class="member-avatar" style="background:${getRoleColor(member.role)}">
              ${member.avatar ? `<img src="${member.avatar}">` : (member.username ? member.username.charAt(0).toUpperCase() : '?')}
              <div class="member-status"></div>
            </div>
            <div class="member-info">
              <div class="member-name">${member.username || 'Unknown'}</div>
              <div class="member-status-text">${member.status || ''}</div>
            </div>
          `;
          categoryDiv.appendChild(memberDiv);
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
  const isSelf = member.uid === currentUser.uid;

  menu.innerHTML = `
    <div class="context-menu-item" data-action="add-friend" style="padding: 8px; cursor: ${isSelf ? 'not-allowed' : 'pointer'}; color: ${isSelf ? '#7f8187' : '#dbdee1'}; border-radius: 4px;">
      <i class="fa-solid fa-user-plus" style="margin-right:6px;"></i> Add Friend
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
  if (!currentServer || !currentChannel) return;
  
  if (newText && newText.trim() !== '') {
    db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages/${key}/text`).set(newText)
      .then(() => {
        showToast('Message edited successfully', 'success');
      })
      .catch(err => {
        showToast('Failed to edit message: ' + err.message, 'error');
      });
  }
}

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
        Admin: { permissions: ['manage_channels', 'manage_messages', 'manage_roles', 'send_messages', 'view_channels'], color: '#f23f43', hoist: true },
        Moderator: { permissions: ['manage_messages', 'send_messages', 'view_channels'], color: '#5865f2', hoist: true },
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
    permManageChannels: 'manage_channels',
    permManageMessages: 'manage_messages',
    permManageRoles: 'manage_roles',
    permSendMessages: 'send_messages',
    permViewChannels: 'view_channels'
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

  const permissions = ['manage_channels', 'manage_messages', 'manage_roles', 'send_messages', 'view_channels', 'hoist'];
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
    permManageChannels: 'manage_channels',
    permManageMessages: 'manage_messages',
    permManageRoles: 'manage_roles',
    permSendMessages: 'send_messages',
    permViewChannels: 'view_channels'
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
        avatar: userProfile.avatar,
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
      Admin: { permissions: ['manage_channels', 'manage_messages', 'manage_roles', 'send_messages', 'view_channels'], color: '#f23f43', hoist: true },
      Moderator: { permissions: ['manage_messages', 'send_messages', 'view_channels'], color: '#5865f2', hoist: true },
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

// UI Helpers
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
    if (currentUser && currentServer) {
      db.ref(`servers/${currentServer}/members/${currentUser.uid}`).update({
        status: userProfile.status,
        lastSeen: Date.now()
      });
    }
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
