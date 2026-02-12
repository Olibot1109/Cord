// Voice + WebRTC
let voiceUsersRef = null;
let voiceSelfStateRef = null;
let voiceSessionServerId = null;
let voiceJoinInProgress = false;
let remoteVoiceStreams = {};
let muteBeforeDeafen = false;
let voicePanelMinimized = false;

function getActiveVoiceServerId() {
  return voiceSessionServerId || currentServer || null;
}

function getActiveVoiceSignalPath() {
  const serverId = getActiveVoiceServerId();
  if (!serverId || !currentVoiceChannel) return null;
  return `servers/${serverId}/voiceChannels/${currentVoiceChannel}/signals`;
}

function getVoiceConnectionLabel(channelName) {
  const cleanChannel = String(channelName || '').trim() || 'Unknown';
  const serverNameEl = document.getElementById('serverName');
  const serverName = serverNameEl ? String(serverNameEl.textContent || '').trim() : '';
  if (!serverName || serverName === 'Home Server') {
    return cleanChannel;
  }
  return `${serverName} / ${cleanChannel}`;
}

function updateVoicePanelToggleButton() {
  const btn = document.getElementById('voicePanelToggleBtn');
  if (!btn) return;
  if (voicePanelMinimized) {
    btn.title = 'Expand';
    btn.innerHTML = '<i class="fa-solid fa-up-right-and-down-left-from-center"></i>';
  } else {
    btn.title = 'Collapse';
    btn.innerHTML = '<i class="fa-solid fa-window-minimize"></i>';
  }
}

function applyVoicePanelVisibility() {
  const panel = elements.voicePanel;
  if (!panel) return;
  if (!inVoiceChannel) {
    panel.classList.remove('active');
    panel.classList.remove('compact');
    updateVoicePanelToggleButton();
    return;
  }
  panel.classList.add('active');
  panel.classList.toggle('compact', voicePanelMinimized);
  updateVoicePanelToggleButton();
}

function toggleVoicePanelMinimize() {
  if (!inVoiceChannel) return;
  voicePanelMinimized = !voicePanelMinimized;
  applyVoicePanelVisibility();
}

function restoreVoicePanel() {
  if (!inVoiceChannel) return;
  voicePanelMinimized = false;
  applyVoicePanelVisibility();
}

function setupCaller(pc, otherUid) {
  const signalPath = getActiveVoiceSignalPath();
  if (!signalPath) return;
  pc.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: true
  })
    .then(offer => {
      console.log('[WebRTC] Created offer for:', otherUid);
      return pc.setLocalDescription(offer);
    })
    .then(() => {
      console.log('[WebRTC] Local description set (offer) for:', otherUid);
      return db.ref(`${signalPath}/offer/${currentUser.uid}/${otherUid}`).set({
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp,
        timestamp: Date.now()
      });
    })
    .then(() => {
      console.log('[WebRTC] Offer sent to Firebase for:', otherUid);
    })
    .catch(error => {
      console.error('[WebRTC] Error creating/sending offer:', error);
    });

  const answerRef = db.ref(`${signalPath}/answer/${otherUid}/${currentUser.uid}`);
  answerRef.on('value', (snapshot) => {
    const answer = snapshot.val();
    if (!answer) return;
    if (answer.timestamp && peerSessionStart[otherUid] && answer.timestamp < peerSessionStart[otherUid]) {
      return;
    }

    console.log('[WebRTC] Received answer from:', otherUid);

    if (pc.signalingState === 'have-local-offer') {
      pc.setRemoteDescription(new RTCSessionDescription({
        type: answer.type,
        sdp: answer.sdp
      }))
        .then(() => {
          console.log('[WebRTC] Remote description set (answer) for:', otherUid);
          processQueuedCandidates(otherUid, pc);
        })
        .catch(error => {
          console.error('[WebRTC] Error setting remote description (answer):', error);
        });
    } else {
      console.log('[WebRTC] Ignoring answer, not in have-local-offer state. Current state:', pc.signalingState);
    }
  });

  setupIceCandidateListener(pc, otherUid);
}

function setupCallee(pc, otherUid) {
  const signalPath = getActiveVoiceSignalPath();
  if (!signalPath) return;
  db.ref(`${signalPath}/offer/${otherUid}/${currentUser.uid}`).on('value', (snapshot) => {
    const offer = snapshot.val();
    if (!offer || pc.remoteDescription) return;
    if (offer.timestamp && peerSessionStart[otherUid] && offer.timestamp < peerSessionStart[otherUid]) {
      return;
    }

    console.log('[WebRTC] Offer received from:', otherUid);

    pc.setRemoteDescription(new RTCSessionDescription({ type: offer.type, sdp: offer.sdp }))
      .then(() => {
        processQueuedCandidates(otherUid, pc);
        return pc.createAnswer();
      })
      .then(answer => pc.setLocalDescription(answer))
      .then(() => {
        return db.ref(`${signalPath}/answer/${currentUser.uid}/${otherUid}`).set({
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp,
          timestamp: Date.now()
        });
      })
      .then(() => {
        console.log('[WebRTC] Answer sent to:', otherUid);
      })
      .catch(error => {
        console.error('[WebRTC] Error handling offer:', error);
      });
  });

  setupIceCandidateListener(pc, otherUid);
}

function setupIceCandidateListener(pc, otherUid) {
  const signalPath = getActiveVoiceSignalPath();
  if (!signalPath) return;
  const candidateRef = db.ref(`${signalPath}/iceCandidates/${otherUid}/${currentUser.uid}`);
  candidateRef.on('child_added', (snapshot) => {
    const data = snapshot.val();
    if (!data || !data.candidate) return;
    if (data.timestamp && peerSessionStart[otherUid] && data.timestamp < peerSessionStart[otherUid]) {
      return;
    }
    if (pc.signalingState === 'closed') return;

    const candidate = new RTCIceCandidate({
      candidate: data.candidate,
      sdpMid: data.sdpMid,
      sdpMLineIndex: data.sdpMLineIndex
    });

    if (pc.remoteDescription && pc.remoteDescription.type) {
      pc.addIceCandidate(candidate)
        .then(() => {
          console.log('[WebRTC] Added ICE candidate from:', otherUid);
        })
        .catch(error => {
          console.error('[WebRTC] Error adding ICE candidate:', error);
        });
    } else {
      console.log('[WebRTC] Queuing ICE candidate from:', otherUid);
      if (!peerCandidates[otherUid]) peerCandidates[otherUid] = [];
      peerCandidates[otherUid].push(candidate);
    }
  });
}

function processQueuedCandidates(otherUid, pc) {
  if (!peerCandidates[otherUid] || peerCandidates[otherUid].length === 0) return;

  console.log('[WebRTC] Processing', peerCandidates[otherUid].length, 'queued ICE candidates from:', otherUid);

  const candidates = peerCandidates[otherUid];
  peerCandidates[otherUid] = [];

  candidates.forEach(candidate => {
    pc.addIceCandidate(candidate)
      .then(() => console.log('[WebRTC] Added queued ICE candidate from:', otherUid))
      .catch(error => console.error('[WebRTC] Error adding queued ICE candidate:', error));
  });
}

function cleanupPeerConnection(otherUid) {
  console.log('[WebRTC] Cleaning up connection with:', otherUid);

  if (peerConnections[otherUid]) {
    peerConnections[otherUid].close();
    delete peerConnections[otherUid];
  }

  if (peerCandidates[otherUid]) {
    delete peerCandidates[otherUid];
  }
  if (peerSessionStart[otherUid]) {
    delete peerSessionStart[otherUid];
  }
  if (remoteVoiceStreams[otherUid]) {
    delete remoteVoiceStreams[otherUid];
  }

  const remoteAudio = document.getElementById(`remoteAudio-${otherUid}`);
  if (remoteAudio) {
    remoteAudio.remove();
  }

  const serverId = voiceSessionServerId || currentServer;
  const channelName = currentVoiceChannel;
  if (serverId && channelName) {
    const signalPath = `servers/${serverId}/voiceChannels/${channelName}/signals`;
    db.ref(`${signalPath}/offer/${otherUid}/${currentUser.uid}`).off();
    db.ref(`${signalPath}/answer/${otherUid}/${currentUser.uid}`).off();
    db.ref(`${signalPath}/iceCandidates/${otherUid}/${currentUser.uid}`).off();
  }

  const participantEl = document.getElementById(`participant-${otherUid}`);
  if (participantEl) {
    participantEl.remove();
  }
}

function establishPeerConnection(otherUid) {
  console.log('[WebRTC] Establishing connection with:', otherUid);

  if (peerConnections[otherUid]) {
    console.log('[WebRTC] Already connected to:', otherUid);
    return;
  }

  peerSessionStart[otherUid] = Date.now();

  const pc = new RTCPeerConnection(STUN_SERVERS);
  peerConnections[otherUid] = pc;
  peerCandidates[otherUid] = [];

  const tracksToAdd = [];

  if (localStream) {
    localStream.getTracks().forEach(track => {
      if (!tracksToAdd.find(t => t.kind === track.kind)) {
        tracksToAdd.push({ track, stream: localStream });
      }
    });
  }

  tracksToAdd.forEach(({ track, stream }) => {
    try {
      pc.addTrack(track, stream);
      console.log('[WebRTC] Added', track.kind, 'track for:', otherUid);
    } catch (e) {
      console.error('[WebRTC] Error adding track:', e);
    }
  });

  pc.onicecandidate = (e) => {
    const signalPath = getActiveVoiceSignalPath();
    if (!signalPath) return;
    if (e.candidate) {
      db.ref(`${signalPath}/iceCandidates/${currentUser.uid}/${otherUid}`).push({
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
        timestamp: Date.now()
      });
    }
  };

  pc.ontrack = (e) => {
    console.log('[WebRTC] Received', e.track.kind, 'from:', otherUid);

    const stream = e.streams[0];
    if (!stream) {
      console.error('[WebRTC] No stream in track event');
      return;
    }

    remoteVoiceStreams[otherUid] = stream;

    if (e.track.kind === 'video') {
      setTimeout(() => {
        const remoteVideo = document.getElementById(`remoteVideo-${otherUid}`);
        if (remoteVideo) {
          remoteVideo.srcObject = stream;

          const playRemote = () => {
            remoteVideo.play()
              .then(() => console.log('[WebRTC] Remote video playing:', otherUid))
              .catch(err => {
                console.warn('[WebRTC] Remote video autoplay blocked:', err);
                document.addEventListener('click', () => remoteVideo.play(), { once: true });
              });
          };

          playRemote();
          remoteVideo.onloadedmetadata = playRemote;
          setTimeout(playRemote, 100);

          e.track.onunmute = () => {
            console.log('[WebRTC] Remote video unmuted:', otherUid);
            remoteVideo.play().catch(console.error);
          };

          e.track.onmute = () => {
            console.log('[WebRTC] Remote video muted:', otherUid);
          };

          if (!e.track.muted) {
            playRemote();
          }
        } else {
          console.warn('[WebRTC] No video element for:', otherUid);
        }
      }, 50);

    } else if (e.track.kind === 'audio') {
      let remoteAudio = document.getElementById(`remoteAudio-${otherUid}`);
      if (!remoteAudio) {
        remoteAudio = document.createElement('audio');
        remoteAudio.id = `remoteAudio-${otherUid}`;
        remoteAudio.autoplay = true;
        remoteAudio.style.display = 'none';
        document.body.appendChild(remoteAudio);
      }

      remoteAudio.srcObject = stream;
      remoteAudio.muted = !!isDeafened;

      const playAudio = () => {
        remoteAudio.play()
          .then(() => console.log('[WebRTC] Remote audio playing:', otherUid))
          .catch(err => console.warn('[WebRTC] Audio autoplay blocked:', err));
      };

      playAudio();
      setTimeout(playAudio, 100);

      e.track.onunmute = playAudio;
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[WebRTC] Connection state:', otherUid, '-', pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupPeerConnection(otherUid);
    }
  };

  const shouldCreateOffer = currentUser.uid < otherUid;

  if (shouldCreateOffer) {
    setupCaller(pc, otherUid);
  } else {
    setupCallee(pc, otherUid);
  }
}

function getMediaStreamWithFallback() {
  return navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    .catch(err => {
      console.warn('[Voice Channel] Video permission failed, falling back to audio only:', err);
      isCameraOn = false;
      updateCameraButton();
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    });
}

function applyVoiceAudioState() {
  if (localStream) {
    const shouldSendMic = !(isMuted || isDeafened);
    localStream.getAudioTracks().forEach(track => {
      track.enabled = shouldSendMic;
    });
  }

  document.querySelectorAll('audio[id^="remoteAudio-"]').forEach(audioEl => {
    audioEl.muted = !!isDeafened;
  });
}

function syncVoiceControlButtons() {
  const voiceMuteBtn = document.getElementById('voiceMuteBtn');
  if (voiceMuteBtn) {
    voiceMuteBtn.classList.toggle('active', isMuted);
    voiceMuteBtn.innerHTML = isMuted ? '<i class="fa-solid fa-microphone-slash"></i>' : '<i class="fa-solid fa-microphone"></i>';
  }

  const micBtn = document.getElementById('micBtn');
  if (micBtn) {
    micBtn.style.color = isMuted ? '#ed4245' : '#b5bac1';
    micBtn.innerHTML = isMuted ? '<i class="fa-solid fa-microphone-slash"></i>' : '<i class="fa-solid fa-microphone"></i>';
  }

  const voiceDeafenBtn = document.getElementById('voiceDeafenBtn');
  if (voiceDeafenBtn) {
    voiceDeafenBtn.classList.toggle('active', isDeafened);
  }
  const deafenBtn = document.getElementById('deafenBtn');
  if (deafenBtn) {
    deafenBtn.style.color = isDeafened ? '#ed4245' : '';
  }
}

function writeCurrentVoiceState() {
  const serverId = voiceSessionServerId || currentServer;
  if (!inVoiceChannel || !serverId || !currentVoiceChannel || !currentUser?.uid) return;
  db.ref(`servers/${serverId}/voiceChannels/${currentVoiceChannel}/users/${currentUser.uid}/muted`).set(isMuted || isDeafened);
  db.ref(`servers/${serverId}/voiceChannels/${currentVoiceChannel}/users/${currentUser.uid}/deafened`).set(isDeafened);
}

function bindSelfVoiceStateListener(serverId, channelName) {
  if (voiceSelfStateRef) {
    voiceSelfStateRef.off();
    voiceSelfStateRef = null;
  }
  if (!serverId || !channelName || !currentUser?.uid) return;
  voiceSelfStateRef = db.ref(`servers/${serverId}/voiceChannels/${channelName}/users/${currentUser.uid}`);
  voiceSelfStateRef.on('value', (snap) => {
    const state = snap.val();
    if (!state || typeof state !== 'object') return;
    const nextDeafened = !!state.deafened;
    const nextMutedRaw = !!state.muted;
    const nextMuted = nextDeafened ? true : nextMutedRaw;
    if (nextMuted === isMuted && nextDeafened === isDeafened) return;
    isDeafened = nextDeafened;
    isMuted = nextMuted;
    applyVoiceAudioState();
    syncVoiceControlButtons();
    updateUserVoiceStatus();
  });
}

function joinVoiceChannel(channelName) {
  console.log('[Voice Channel] Attempting to join voice channel:', {
    channelName,
    currentServer,
    currentUserUid: currentUser?.uid
  });

  if (isDmCallActive()) {
    showToast('You cannot join a server voice chat while in a DM call', 'error');
    return;
  }

  if (!currentServer) {
    console.error('[Voice Channel] Cannot join voice channel: No current server');
    return;
  }

  if (voiceJoinInProgress) {
    showToast('Joining voice channel...', 'info');
    return;
  }
  voiceJoinInProgress = true;

  const targetServerId = currentServer;
  const channelRef = db.ref(`servers/${targetServerId}/voiceChannels/${channelName}`);

  channelRef.once('value')
    .then(snapshot => {
      const channelData = snapshot.val();
      if (!channelData) {
        throw new Error('VOICE_CHANNEL_NOT_FOUND');
      }
      const users = channelData.users || {};
      const limit = Number(channelData.limit) || 0;
      const currentCount = Object.keys(users).length;
      const alreadyInChannel = !!users[currentUser.uid];
      if (limit > 0 && currentCount >= limit && !alreadyInChannel) {
        throw new Error('VOICE_CHANNEL_FULL');
      }
      return getMediaStreamWithFallback();
    })
    .then(stream => {
      console.log('[Voice Channel] Media permissions granted');

      if (inVoiceChannel) {
        console.log('[Voice Channel] Already in voice channel, disconnecting first');
        disconnectVoice();
      }

      localStream = stream;
      applyVoiceAudioState();
      const videoTracks = localStream.getVideoTracks();
      isCameraOn = videoTracks.length > 0 && videoTracks[0].enabled;
      updateCameraButton();

      voiceSessionServerId = targetServerId;
      currentVoiceChannel = channelName;
      inVoiceChannel = true;
      voicePanelMinimized = true;

      db.ref(`servers/${voiceSessionServerId}/voiceChannels/${channelName}/users/${currentUser.uid}`).set({
        username: userProfile.username,
        muted: isMuted || isDeafened,
        deafened: isDeafened,
        joinedAt: Date.now()
      });

      elements.voiceChannelName.textContent = getVoiceConnectionLabel(channelName);
      applyVoicePanelVisibility();
      syncVoiceControlButtons();

      setupVoiceUsersListener(channelName);
      loadMemberList();
      updateUserVoiceStatus();

      Object.values(peerConnections).forEach(pc => {
        if (!pc || !localStream) return;
        localStream.getTracks().forEach(track => {
          const alreadyAdded = pc.getSenders().some(sender => sender.track && sender.track.kind === track.kind);
          if (!alreadyAdded) {
            pc.addTrack(track, localStream);
          }
        });
      });

      showToast(`Connected to ${channelName}`, 'success');

      // Keep chat focused on last text channel
      openLastTextChannel();
    })
    .catch(error => {
      console.error('Microphone permission error:', error);
      if (error && error.message === 'VOICE_CHANNEL_NOT_FOUND') {
        showToast('Voice channel no longer exists', 'error');
      } else if (error && error.message === 'VOICE_CHANNEL_FULL') {
        showToast('Voice channel is full', 'error');
      } else {
        showToast('Microphone access is required to join voice channels', 'error');
      }
    })
    .finally(() => {
      voiceJoinInProgress = false;
    });
}

function setupVoiceUsersListener(channelName) {
  if (voiceUsersRef) {
    voiceUsersRef.off();
  }
  const serverId = voiceSessionServerId || currentServer;
  if (!serverId) return;
  bindSelfVoiceStateListener(serverId, channelName);

  voiceUsersRef = db.ref(`servers/${serverId}/voiceChannels/${channelName}/users`);
  voiceUsersRef.on('value', snapshot => {
    const users = snapshot.val() || {};
    elements.voiceVideoGrid.innerHTML = '';

    const localTile = document.createElement('div');
    localTile.className = 'voice-video-tile local';
    localTile.innerHTML = `
      <video id="localVideo" autoplay muted playsinline></video>
      <div class="voice-video-label">${userProfile.username} (You)</div>
    `;
    elements.voiceVideoGrid.appendChild(localTile);

    const localVideo = document.getElementById('localVideo');
    if (localVideo && localStream) {
      localVideo.srcObject = localStream;
    }

    Object.entries(users).forEach(([uid, userData]) => {
      if (uid === currentUser.uid) return;

      const div = document.createElement('div');
      div.className = 'voice-video-tile';
      div.id = `participant-${uid}`;

      div.innerHTML = `
        <video id="remoteVideo-${uid}" autoplay playsinline></video>
        <div class="voice-video-label">${userData.username || 'Unknown'}</div>
      `;

      elements.voiceVideoGrid.appendChild(div);
      if (remoteVoiceStreams[uid]) {
        const remoteVideo = document.getElementById(`remoteVideo-${uid}`);
        if (remoteVideo) {
          remoteVideo.srcObject = remoteVoiceStreams[uid];
          remoteVideo.play().catch(() => {});
        }
      }

      if (!peerConnections[uid]) {
        establishPeerConnection(uid);
      }
    });

    Object.keys(peerConnections).forEach(uid => {
      if (!users[uid]) {
        cleanupPeerConnection(uid);
      }
    });
  });
}

function disconnectVoice() {
  console.log('[Voice Channel] Attempting to disconnect from voice channel:', {
    inVoiceChannel,
    currentServer,
    currentVoiceChannel,
    currentUserUid: currentUser?.uid
  });

  const serverId = voiceSessionServerId || currentServer;
  const channelName = currentVoiceChannel;

  if (!inVoiceChannel || !serverId || !channelName) {
    console.log('[Voice Channel] Not in a voice channel to disconnect from');
    return;
  }

  db.ref(`servers/${serverId}/voiceChannels/${channelName}/users/${currentUser.uid}`).remove()
    .then(() => {
      console.log('[Voice Channel] Successfully removed user from voice channel in database');
    })
    .catch(error => {
      console.error('[Voice Channel] Error removing user from voice channel:', error);
    });

  if (voiceUsersRef) {
    voiceUsersRef.off();
    voiceUsersRef = null;
  }
  if (voiceSelfStateRef) {
    voiceSelfStateRef.off();
    voiceSelfStateRef = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  Object.keys(peerConnections).forEach(otherUid => {
    const pc = peerConnections[otherUid];
    if (pc) {
      pc.close();
      db.ref(`servers/${serverId}/voiceChannels/${channelName}/signals/iceCandidates/${currentUser.uid}/${otherUid}`).off();
      db.ref(`servers/${serverId}/voiceChannels/${channelName}/signals/iceCandidates/${otherUid}/${currentUser.uid}`).off();
      db.ref(`servers/${serverId}/voiceChannels/${channelName}/signals/offer/${currentUser.uid}/${otherUid}`).off();
      db.ref(`servers/${serverId}/voiceChannels/${channelName}/signals/offer/${otherUid}/${currentUser.uid}`).off();
      db.ref(`servers/${serverId}/voiceChannels/${channelName}/signals/answer/${currentUser.uid}/${otherUid}`).off();
      db.ref(`servers/${serverId}/voiceChannels/${channelName}/signals/answer/${otherUid}/${currentUser.uid}`).off();
      db.ref(`servers/${serverId}/voiceChannels/${channelName}/signals/iceCandidates/${currentUser.uid}/${otherUid}`).remove();
      db.ref(`servers/${serverId}/voiceChannels/${channelName}/signals/offer/${currentUser.uid}/${otherUid}`).remove();
      db.ref(`servers/${serverId}/voiceChannels/${channelName}/signals/answer/${currentUser.uid}/${otherUid}`).remove();
    }
  });

  peerConnections = {};
  peerCandidates = {};
  peerSessionStart = {};

  inVoiceChannel = false;
  currentVoiceChannel = null;
  voiceSessionServerId = null;
  voicePanelMinimized = false;
  isCameraOn = false;
  remoteVoiceStreams = {};
  applyVoicePanelVisibility();
  if (elements.voiceVideoGrid) {
    elements.voiceVideoGrid.innerHTML = '';
  }
  updateCameraButton();

  console.log('[Voice Channel] Voice channel state after disconnect:', {
    inVoiceChannel,
    currentVoiceChannel
  });

  updateUserVoiceStatus();
}

function toggleVoiceMute() {
  if (isDeafened && isMuted) {
    showToast('Undeafen first to unmute your mic', 'info');
    return;
  }
  isMuted = !isMuted;
  applyVoiceAudioState();
  syncVoiceControlButtons();
  writeCurrentVoiceState();
  updateUserVoiceStatus();
}

function toggleDeafen() {
  const enabling = !isDeafened;
  if (enabling) {
    muteBeforeDeafen = !!isMuted;
    isMuted = true;
  } else {
    isMuted = !!muteBeforeDeafen;
  }
  isDeafened = !isDeafened;
  applyVoiceAudioState();
  syncVoiceControlButtons();
  writeCurrentVoiceState();
  updateUserVoiceStatus();
}

function toggleMute() {
  if (isDeafened && isMuted) {
    showToast('Undeafen first to unmute your mic', 'info');
    return;
  }
  isMuted = !isMuted;
  applyVoiceAudioState();
  syncVoiceControlButtons();
  writeCurrentVoiceState();
  updateUserVoiceStatus();
}

function toggleCamera() {
  if (!localStream) {
    showToast('Join a voice channel first', 'error');
    return;
  }

  const videoTracks = localStream.getVideoTracks();
  if (videoTracks.length === 0) {
    showToast('Camera not available', 'error');
    return;
  }

  isCameraOn = !isCameraOn;
  videoTracks.forEach(track => {
    track.enabled = isCameraOn;
  });

  updateCameraButton();
}

function updateCameraButton() {
  const btn = document.getElementById('voiceVideoBtn');
  if (!btn) return;
  btn.classList.toggle('active', isCameraOn);
  btn.innerHTML = isCameraOn ? '<i class="fa-solid fa-video"></i>' : '<i class="fa-solid fa-video-slash"></i>';
}

// DM Video Calling
let dmCallPc = null;
let dmCallStream = null;
let dmCallPeerUid = null;
let dmCallSessionStart = 0;
let dmIncomingOffer = null;
let dmIncomingDmId = null;
let dmIncomingCallerName = '';
let dmActiveCallId = null;
let dmCallOfferRef = null;
let dmCallAnswerRef = null;
let dmCallIceRef = null;
let dmCallEndedRef = null;
let dmCallMinimized = false;
let dmCallMicOn = true;
let dmCallCameraOn = true;
let dmCallAudioOn = true;
let dmFriendWatcherRef = null;
let dmOfferRefs = {};
let dmMiniDockDragState = {
  active: false,
  pointerId: null,
  offsetX: 0,
  offsetY: 0
};

function getDmIdForUsers(uidA, uidB) {
  if (!uidA || !uidB) return null;
  if (typeof getDmId === 'function') {
    return getDmId(uidA, uidB);
  }
  return [uidA, uidB].sort().join('_');
}

function getCurrentDmCallId() {
  if (dmActiveCallId) return dmActiveCallId;
  if (currentChannel && currentChannelType === 'dm') return currentChannel;
  if (dmIncomingDmId) return dmIncomingDmId;
  return null;
}

function getDmCallBaseRef() {
  const dmId = getCurrentDmCallId();
  if (!dmId) return null;
  return db.ref(`dms/${dmId}/call`);
}

function showDmCallOverlay(show) {
  const overlay = document.getElementById('dmCallOverlay');
  if (!overlay) return;
  overlay.style.display = show && !dmCallMinimized ? 'flex' : 'none';
  const dock = document.getElementById('dmCallMiniDock');
  if (dock) {
    initDmCallMiniDockDrag();
    dock.style.display = show && dmCallMinimized ? 'flex' : 'none';
  }
}

function setDmCallTitle(text) {
  const title = document.getElementById('dmCallTitle');
  if (title) title.textContent = text || 'Video Call';
}

function showDmIncoming(show, name) {
  const incoming = document.getElementById('dmCallIncoming');
  const title = document.getElementById('dmCallIncomingName');
  if (!incoming || !title) return;
  title.textContent = name ? `Incoming video call from ${name}` : 'Incoming video call';
  incoming.style.display = show ? 'block' : 'none';
}

function setDmDockTitle(text) {
  const label = document.getElementById('dmCallMiniTitle');
  if (label) label.textContent = text || 'DM call';
}

function isDmCallActive() {
  return !!(dmCallPc || dmCallStream || dmActiveCallId);
}

function initDmCallMiniDockDrag() {
  const dock = document.getElementById('dmCallMiniDock');
  const handle = document.getElementById('dmCallMiniHandle');
  if (!dock || !handle || dock.dataset.dragReady === '1') return;

  const clampDockToViewport = () => {
    if (dock.style.left === '' && dock.style.top === '') return;
    const rect = dock.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    const nextLeft = Math.min(Math.max(0, rect.left), maxX);
    const nextTop = Math.min(Math.max(0, rect.top), maxY);
    dock.style.left = `${nextLeft}px`;
    dock.style.top = `${nextTop}px`;
    dock.style.right = 'auto';
    dock.style.bottom = 'auto';
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = dock.getBoundingClientRect();
    dmMiniDockDragState.active = true;
    dmMiniDockDragState.pointerId = event.pointerId;
    dmMiniDockDragState.offsetX = event.clientX - rect.left;
    dmMiniDockDragState.offsetY = event.clientY - rect.top;
    dock.classList.add('dragging');
    dock.style.left = `${rect.left}px`;
    dock.style.top = `${rect.top}px`;
    dock.style.right = 'auto';
    dock.style.bottom = 'auto';
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dmMiniDockDragState.active || dmMiniDockDragState.pointerId !== event.pointerId) return;
    const rect = dock.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    const nextLeft = Math.min(Math.max(0, event.clientX - dmMiniDockDragState.offsetX), maxX);
    const nextTop = Math.min(Math.max(0, event.clientY - dmMiniDockDragState.offsetY), maxY);
    dock.style.left = `${nextLeft}px`;
    dock.style.top = `${nextTop}px`;
    dock.style.right = 'auto';
    dock.style.bottom = 'auto';
  });

  const endDrag = (event) => {
    if (dmMiniDockDragState.pointerId !== event.pointerId) return;
    dmMiniDockDragState.active = false;
    dmMiniDockDragState.pointerId = null;
    dock.classList.remove('dragging');
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  };

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', clampDockToViewport);

  dock.dataset.dragReady = '1';
}

function updateDmCallControlButtons() {
  const micBtn = document.getElementById('dmCallMicBtn');
  const camBtn = document.getElementById('dmCallCamBtn');
  const audioBtn = document.getElementById('dmCallAudioBtn');
  if (micBtn) {
    micBtn.classList.toggle('active', !dmCallMicOn);
    micBtn.innerHTML = dmCallMicOn ? '<i class="fa-solid fa-microphone"></i>' : '<i class="fa-solid fa-microphone-slash"></i>';
  }
  if (camBtn) {
    camBtn.classList.toggle('active', !dmCallCameraOn);
    camBtn.innerHTML = dmCallCameraOn ? '<i class="fa-solid fa-video"></i>' : '<i class="fa-solid fa-video-slash"></i>';
  }
  if (audioBtn) {
    audioBtn.classList.toggle('active', !dmCallAudioOn);
    audioBtn.innerHTML = dmCallAudioOn ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-volume-xmark"></i>';
  }
  const remoteVideo = document.getElementById('dmRemoteVideo');
  if (remoteVideo) {
    remoteVideo.muted = !dmCallAudioOn;
  }
}

function setDmCallDefaultsFromStream() {
  dmCallMinimized = false;
  const audioTracks = dmCallStream ? dmCallStream.getAudioTracks() : [];
  const videoTracks = dmCallStream ? dmCallStream.getVideoTracks() : [];
  dmCallMicOn = audioTracks.length === 0 ? true : !!audioTracks[0].enabled;
  dmCallCameraOn = videoTracks.length === 0 ? false : !!videoTracks[0].enabled;
  dmCallAudioOn = true;
  updateDmCallControlButtons();
}

function resetDmCallState() {
  dmIncomingOffer = null;
  dmIncomingDmId = null;
  dmIncomingCallerName = '';
  dmCallPeerUid = null;
  dmCallSessionStart = 0;
  dmActiveCallId = null;
  dmCallMinimized = false;
  if (dmCallPc) {
    dmCallPc.ontrack = null;
    dmCallPc.onicecandidate = null;
    dmCallPc.close();
    dmCallPc = null;
  }
  if (dmCallStream) {
    dmCallStream.getTracks().forEach(track => track.stop());
    dmCallStream = null;
  }
  const localVideo = document.getElementById('dmLocalVideo');
  const remoteVideo = document.getElementById('dmRemoteVideo');
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  dmCallMicOn = true;
  dmCallCameraOn = true;
  dmCallAudioOn = true;
  updateDmCallControlButtons();
  showDmCallOverlay(false);
  showDmIncoming(false);
}

function cleanupDmCallRefs() {
  if (dmCallOfferRef) dmCallOfferRef.off();
  if (dmCallAnswerRef) dmCallAnswerRef.off();
  if (dmCallIceRef) dmCallIceRef.off();
  if (dmCallEndedRef) dmCallEndedRef.off();
  dmCallOfferRef = null;
  dmCallAnswerRef = null;
  dmCallIceRef = null;
  dmCallEndedRef = null;
}

function setupDmIceCandidateListener(otherUid) {
  const baseRef = getDmCallBaseRef();
  if (!baseRef) return;
  baseRef.child('ended').remove();
  dmCallIceRef = baseRef.child('ice').child(otherUid).child(currentUser.uid);
  dmCallIceRef.on('child_added', (snapshot) => {
    const data = snapshot.val();
    if (!data || !data.candidate || !dmCallPc) return;
    if (data.timestamp && dmCallSessionStart && data.timestamp < dmCallSessionStart) return;
    if (dmCallPc.signalingState === 'closed') return;

    const candidate = new RTCIceCandidate({
      candidate: data.candidate,
      sdpMid: data.sdpMid,
      sdpMLineIndex: data.sdpMLineIndex
    });
    if (dmCallPc.remoteDescription && dmCallPc.remoteDescription.type) {
      dmCallPc.addIceCandidate(candidate).catch(() => {});
    } else {
      if (!peerCandidates[otherUid]) peerCandidates[otherUid] = [];
      peerCandidates[otherUid].push(candidate);
    }
  });
}

function processDmQueuedCandidates(otherUid) {
  if (!peerCandidates[otherUid] || peerCandidates[otherUid].length === 0 || !dmCallPc) return;
  const candidates = peerCandidates[otherUid];
  peerCandidates[otherUid] = [];
  candidates.forEach(candidate => {
    dmCallPc.addIceCandidate(candidate).catch(() => {});
  });
}

function listenForDmCallEnd(otherUid) {
  const baseRef = getDmCallBaseRef();
  if (!baseRef) return;
  dmCallEndedRef = baseRef.child('ended');
  dmCallEndedRef.on('value', (snap) => {
    const data = snap.val();
    if (!data || !data.timestamp) return;
    if (dmCallSessionStart && data.timestamp < dmCallSessionStart) return;
    if (data.by && data.by === currentUser.uid) return;
    endDmCall(false);
  });
}

function clearDmOffer(dmId, fromUid) {
  if (!dmId || !fromUid) return Promise.resolve();
  return db.ref(`dms/${dmId}/call/offer/${fromUid}`).remove().catch(() => {});
}

function fetchUsername(uid) {
  if (!uid) return Promise.resolve('User');
  return db.ref(`profiles/${uid}/username`).once('value').then(snap => snap.val() || 'User').catch(() => 'User');
}

function bindDmOfferListener(dmId, friendUid) {
  if (!dmId || !friendUid || !currentUser) return;
  const key = `${dmId}:${friendUid}`;
  if (dmOfferRefs[key]) return;

  const offerRef = db.ref(`dms/${dmId}/call/offer/${friendUid}`);
  const handler = offerRef.on('value', (snap) => {
    const offer = snap.val();
    if (!offer || offer.to !== currentUser.uid) {
      if (dmIncomingDmId === dmId && dmIncomingOffer && dmIncomingOffer.from === friendUid) {
        dmIncomingOffer = null;
        dmIncomingDmId = null;
        dmIncomingCallerName = '';
        showDmIncoming(false);
      }
      return;
    }
    if (isDmCallActive()) return;
    dmIncomingOffer = offer;
    dmIncomingDmId = dmId;
    const knownName = currentDmUser && currentDmUser.uid === friendUid ? (currentDmUser.username || 'User') : '';
    if (knownName) {
      dmIncomingCallerName = knownName;
      showDmIncoming(true, knownName);
    } else {
      fetchUsername(friendUid).then((username) => {
        if (!dmIncomingOffer || dmIncomingOffer.from !== friendUid || dmIncomingDmId !== dmId) return;
        dmIncomingCallerName = username || 'User';
        showDmIncoming(true, dmIncomingCallerName);
      });
    }
  });
  dmOfferRefs[key] = { ref: offerRef, handler };
}

function stopGlobalDmCallListeners() {
  if (dmFriendWatcherRef) {
    dmFriendWatcherRef.off();
    dmFriendWatcherRef = null;
  }
  Object.values(dmOfferRefs).forEach((entry) => {
    if (entry && entry.ref && entry.handler) {
      entry.ref.off('value', entry.handler);
    }
  });
  dmOfferRefs = {};
}

function startGlobalDmCallListeners() {
  if (!currentUser) return;
  if (dmFriendWatcherRef) return;
  dmFriendWatcherRef = db.ref(`friends/${currentUser.uid}`);
  dmFriendWatcherRef.on('value', (snap) => {
    const friends = snap.val() || {};
    const friendUids = Object.keys(friends);
    const activeKeys = new Set();
    friendUids.forEach((friendUid) => {
      const dmId = getDmIdForUsers(currentUser.uid, friendUid);
      if (!dmId) return;
      const key = `${dmId}:${friendUid}`;
      activeKeys.add(key);
      bindDmOfferListener(dmId, friendUid);
    });

    Object.keys(dmOfferRefs).forEach((key) => {
      if (activeKeys.has(key)) return;
      const entry = dmOfferRefs[key];
      if (entry && entry.ref && entry.handler) {
        entry.ref.off('value', entry.handler);
      }
      delete dmOfferRefs[key];
    });
  });
}

function startDmVideoCall() {
  if (!currentUser || currentChannelType !== 'dm' || !currentDmUser?.uid) {
    showToast('Open a DM to start a call', 'error');
    return;
  }
  if (inVoiceChannel) {
    showToast('Leave server voice chat before starting a DM call', 'error');
    return;
  }
  if (dmCallPc) {
    showToast('Call already active', 'info');
    return;
  }
  dmCallPeerUid = currentDmUser.uid;
  dmActiveCallId = currentChannel;
  dmCallSessionStart = Date.now();
  dmIncomingOffer = null;
  dmIncomingDmId = null;
  dmIncomingCallerName = '';
  showDmIncoming(false);
  setDmCallTitle(`Video Call with ${currentDmUser.username || 'User'}`);
  setDmDockTitle(`Call with ${currentDmUser.username || 'User'}`);

  const baseRef = getDmCallBaseRef();
  if (!baseRef) return;

  navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(stream => {
      dmCallStream = stream;
      setDmCallDefaultsFromStream();
      const localVideo = document.getElementById('dmLocalVideo');
      if (localVideo) localVideo.srcObject = stream;

      dmCallPc = new RTCPeerConnection(STUN_SERVERS);
      peerCandidates[dmCallPeerUid] = [];

      stream.getTracks().forEach(track => dmCallPc.addTrack(track, stream));

      dmCallPc.ontrack = (e) => {
        const remoteVideo = document.getElementById('dmRemoteVideo');
        if (remoteVideo) {
          remoteVideo.srcObject = e.streams[0];
          remoteVideo.muted = !dmCallAudioOn;
        }
      };

      dmCallPc.onicecandidate = (e) => {
        if (e.candidate) {
          baseRef.child('ice').child(currentUser.uid).child(dmCallPeerUid).push({
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
            timestamp: Date.now()
          });
        }
      };

      showDmCallOverlay(true);
      listenForDmCallEnd(dmCallPeerUid);

      return dmCallPc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    })
    .then(offer => dmCallPc.setLocalDescription(offer))
    .then(() => {
      return clearDmOffer(dmActiveCallId, dmCallPeerUid);
    })
    .then(() => {
      const offerPayload = {
        type: dmCallPc.localDescription.type,
        sdp: dmCallPc.localDescription.sdp,
        from: currentUser.uid,
        to: dmCallPeerUid,
        timestamp: Date.now()
      };
      return getDmCallBaseRef().child('offer').child(currentUser.uid).set(offerPayload);
    })
    .then(() => {
      const answerRef = getDmCallBaseRef().child('answer').child(currentUser.uid);
      dmCallAnswerRef = answerRef;
      answerRef.on('value', (snapshot) => {
        const answer = snapshot.val();
        if (!answer || answer.from !== dmCallPeerUid) return;
        if (answer.timestamp && dmCallSessionStart && answer.timestamp < dmCallSessionStart) return;
        if (!dmCallPc || dmCallPc.signalingState !== 'have-local-offer') return;
        dmCallPc.setRemoteDescription(new RTCSessionDescription({
          type: answer.type,
          sdp: answer.sdp
        })).then(() => {
          processDmQueuedCandidates(dmCallPeerUid);
        }).catch(() => {});
      });
      setupDmIceCandidateListener(dmCallPeerUid);
    })
    .catch(err => {
      console.error('[DM Call] Failed to start call:', err);
      showToast('Failed to start call', 'error');
      endDmCall(false);
    });
}

function acceptDmCall() {
  if (!dmIncomingOffer || !currentUser) return;
  if (dmCallPc) return;
  const offerToAccept = { ...dmIncomingOffer };
  if (inVoiceChannel) {
    showToast('Leave server voice chat before accepting a DM call', 'error');
    return;
  }
  if (dmIncomingDmId && offerToAccept.from && typeof openDm === 'function') {
    const resolvedName = dmIncomingCallerName || currentDmUser?.username || 'User';
    openDm(offerToAccept.from, { username: resolvedName });
  }

  dmCallPeerUid = offerToAccept.from;
  dmActiveCallId = dmIncomingDmId || getDmIdForUsers(currentUser.uid, dmCallPeerUid);
  dmCallSessionStart = Date.now();
  const callName = dmIncomingCallerName || currentDmUser?.username || 'User';
  setDmCallTitle(`Video Call with ${callName}`);
  setDmDockTitle(`Call with ${callName}`);
  dmIncomingOffer = null;
  dmIncomingDmId = null;
  dmIncomingCallerName = '';
  showDmIncoming(false);
  const baseRef = getDmCallBaseRef();
  if (baseRef) {
    baseRef.child('ended').remove();
    clearDmOffer(dmActiveCallId, dmCallPeerUid);
  }

  navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(stream => {
      dmCallStream = stream;
      setDmCallDefaultsFromStream();
      const localVideo = document.getElementById('dmLocalVideo');
      if (localVideo) localVideo.srcObject = stream;

      dmCallPc = new RTCPeerConnection(STUN_SERVERS);
      peerCandidates[dmCallPeerUid] = [];

      stream.getTracks().forEach(track => dmCallPc.addTrack(track, stream));
      dmCallPc.ontrack = (e) => {
        const remoteVideo = document.getElementById('dmRemoteVideo');
        if (remoteVideo) {
          remoteVideo.srcObject = e.streams[0];
          remoteVideo.muted = !dmCallAudioOn;
        }
      };
      dmCallPc.onicecandidate = (e) => {
        if (e.candidate) {
          getDmCallBaseRef().child('ice').child(currentUser.uid).child(dmCallPeerUid).push({
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
            timestamp: Date.now()
          });
        }
      };

      showDmCallOverlay(true);
      listenForDmCallEnd(dmCallPeerUid);

      return dmCallPc.setRemoteDescription(new RTCSessionDescription({
        type: offerToAccept.type,
        sdp: offerToAccept.sdp
      }));
    })
    .then(() => dmCallPc.createAnswer())
    .then(answer => dmCallPc.setLocalDescription(answer))
    .then(() => {
      return getDmCallBaseRef().child('answer').child(dmCallPeerUid).set({
        type: dmCallPc.localDescription.type,
        sdp: dmCallPc.localDescription.sdp,
        from: currentUser.uid,
        to: dmCallPeerUid,
        timestamp: Date.now()
      });
    })
    .then(() => {
      setupDmIceCandidateListener(dmCallPeerUid);
      processDmQueuedCandidates(dmCallPeerUid);
    })
    .catch(err => {
      console.error('[DM Call] Failed to accept call:', err);
      showToast('Failed to accept call', 'error');
      endDmCall(false);
    });
}

function declineDmCall() {
  if (!dmIncomingOffer) return;
  const dmId = dmIncomingDmId || getDmIdForUsers(currentUser?.uid, dmIncomingOffer.from);
  const baseRef = dmId ? db.ref(`dms/${dmId}/call`) : null;
  if (baseRef && dmIncomingOffer.from) {
    baseRef.child('offer').child(dmIncomingOffer.from).remove();
    baseRef.child('ended').set({
      by: currentUser ? currentUser.uid : 'unknown',
      timestamp: Date.now()
    });
  }
  dmIncomingOffer = null;
  dmIncomingDmId = null;
  dmIncomingCallerName = '';
  showDmIncoming(false);
}

function endDmCall(signalRemote = true) {
  const baseRef = getDmCallBaseRef();
  if (signalRemote && baseRef && dmCallPeerUid && currentUser) {
    baseRef.child('ended').set({
      by: currentUser.uid,
      timestamp: Date.now()
    });
  }
  resetDmCallState();
  cleanupDmCallRefs();
}

function startDmCallListeners() {
  startGlobalDmCallListeners();
}

function toggleDmCallMinimize() {
  if (!isDmCallActive()) return;
  dmCallMinimized = !dmCallMinimized;
  showDmCallOverlay(true);
}

function restoreDmCall() {
  if (!isDmCallActive()) return;
  dmCallMinimized = false;
  showDmCallOverlay(true);
}

function toggleDmCallMute() {
  if (!dmCallStream) return;
  const audioTracks = dmCallStream.getAudioTracks();
  if (audioTracks.length === 0) {
    showToast('Microphone not available', 'error');
    return;
  }
  dmCallMicOn = !dmCallMicOn;
  audioTracks.forEach(track => {
    track.enabled = dmCallMicOn;
  });
  updateDmCallControlButtons();
}

function toggleDmCallCamera() {
  if (!dmCallStream) return;
  const videoTracks = dmCallStream.getVideoTracks();
  if (videoTracks.length === 0) {
    showToast('Camera not available', 'error');
    return;
  }
  dmCallCameraOn = !dmCallCameraOn;
  videoTracks.forEach(track => {
    track.enabled = dmCallCameraOn;
  });
  updateDmCallControlButtons();
}

function toggleDmCallAudio() {
  dmCallAudioOn = !dmCallAudioOn;
  updateDmCallControlButtons();
}
