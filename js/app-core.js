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
let presenceListenerSet = false;

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
  slowmodeNotice: document.getElementById('slowmodeNotice'),
  dmCallBtn: document.getElementById('dmCallBtn'),
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
  Admin: ['manage_server', 'manage_channels', 'manage_messages', 'manage_roles', 'send_messages', 'view_channels', 'mention_everyone'],
  Moderator: ['manage_messages', 'send_messages', 'view_channels', 'mention_everyone'],
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
    setupMentionNotifications();
    ensurePresenceConnectionListener();
    
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
    if (currentChannel && currentChannelType === 'text' && currentServer) {
      db.ref(`servers/${currentServer}/channels_data/${currentChannel}/typing/${currentUser.uid}`).set({
        username: userProfile.username,
        timestamp: Date.now()
      });
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        db.ref(`servers/${currentServer}/channels_data/${currentChannel}/typing/${currentUser.uid}`).remove();
      }, 3000);
    } else if (currentChannel && currentChannelType === 'dm') {
      db.ref(`dms/${currentChannel}/typing/${currentUser.uid}`).set({
        username: userProfile.username,
        timestamp: Date.now()
      });
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        db.ref(`dms/${currentChannel}/typing/${currentUser.uid}`).remove();
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

function setupMentionNotifications() {
  return;
}

function refreshPresenceForServers() {
  if (!currentUser) return;
  (userServers || []).forEach(serverId => {
    const memberRef = db.ref(`servers/${serverId}/members/${currentUser.uid}`);
    if (memberRef.child('status').onDisconnect) {
      memberRef.child('status').onDisconnect().set('offline');
    }
    if (memberRef.child('lastSeen').onDisconnect) {
      memberRef.child('lastSeen').onDisconnect().set(firebase.database.ServerValue.TIMESTAMP);
    }
    memberRef.update({
      status: userProfile.status,
      lastSeen: Date.now()
    });
  });
}

function ensurePresenceConnectionListener() {
  if (presenceListenerSet || !currentUser) return;
  presenceListenerSet = true;
  const connectedRef = db.ref('.info/connected');
  connectedRef.on('value', (snap) => {
    if (snap.val()) {
      refreshPresenceForServers();
    }
  });
}
