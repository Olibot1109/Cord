// Voice + WebRTC
function setupCaller(pc, otherUid) {
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
      return db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/offer/${currentUser.uid}/${otherUid}`).set({
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

  const answerRef = db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/answer/${otherUid}/${currentUser.uid}`);
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
  db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/offer/${otherUid}/${currentUser.uid}`).on('value', (snapshot) => {
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
        return db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/answer/${currentUser.uid}/${otherUid}`).set({
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
  const candidateRef = db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/iceCandidates/${otherUid}/${currentUser.uid}`);
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

  const remoteAudio = document.getElementById(`remoteAudio-${otherUid}`);
  if (remoteAudio) {
    remoteAudio.remove();
  }

  const signalPath = `servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals`;
  db.ref(`${signalPath}/offer/${otherUid}/${currentUser.uid}`).off();
  db.ref(`${signalPath}/answer/${otherUid}/${currentUser.uid}`).off();
  db.ref(`${signalPath}/iceCandidates/${otherUid}/${currentUser.uid}`).off();

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
    if (e.candidate) {
      db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/iceCandidates/${currentUser.uid}/${otherUid}`).push({
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
      remoteAudio.muted = false;

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

function joinVoiceChannel(channelName) {
  console.log('[Voice Channel] Attempting to join voice channel:', {
    channelName,
    currentServer,
    currentUserUid: currentUser?.uid
  });

  if (!currentServer) {
    console.error('[Voice Channel] Cannot join voice channel: No current server');
    return;
  }

  getMediaStreamWithFallback()
    .then(stream => {
      console.log('[Voice Channel] Media permissions granted');

      if (inVoiceChannel) {
        console.log('[Voice Channel] Already in voice channel, disconnecting first');
        disconnectVoice();
      }

      localStream = stream;
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
      const videoTracks = localStream.getVideoTracks();
      isCameraOn = videoTracks.length > 0 && videoTracks[0].enabled;
      updateCameraButton();

      currentVoiceChannel = channelName;
      inVoiceChannel = true;

      db.ref(`servers/${currentServer}/voiceChannels/${channelName}/users/${currentUser.uid}`).set({
        username: userProfile.username,
        avatar: userProfile.avatar,
        muted: isMuted,
        deafened: isDeafened,
        joinedAt: Date.now()
      });

      elements.voicePanel.classList.add('active');
      elements.voiceChannelName.textContent = channelName;

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
      showToast('Microphone access is required to join voice channels', 'error');
    });
}

function setupVoiceUsersListener(channelName) {
  db.ref(`servers/${currentServer}/voiceChannels/${channelName}/users`).on('value', snapshot => {
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

      if (!peerConnections[uid]) {
        establishPeerConnection(uid);
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

  if (!inVoiceChannel || !currentServer) {
    console.log('[Voice Channel] Not in a voice channel to disconnect from');
    return;
  }

  db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/users/${currentUser.uid}`).remove()
    .then(() => {
      console.log('[Voice Channel] Successfully removed user from voice channel in database');
    })
    .catch(error => {
      console.error('[Voice Channel] Error removing user from voice channel:', error);
    });

  db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/users`).off();

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  Object.keys(peerConnections).forEach(otherUid => {
    const pc = peerConnections[otherUid];
    if (pc) {
      pc.close();
      db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/iceCandidates/${currentUser.uid}/${otherUid}`).off();
      db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/iceCandidates/${otherUid}/${currentUser.uid}`).off();
      db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/offer/${currentUser.uid}/${otherUid}`).off();
      db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/offer/${otherUid}/${currentUser.uid}`).off();
      db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/answer/${currentUser.uid}/${otherUid}`).off();
      db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/answer/${otherUid}/${currentUser.uid}`).off();
      db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/iceCandidates/${currentUser.uid}/${otherUid}`).remove();
      db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/offer/${currentUser.uid}/${otherUid}`).remove();
      db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/signals/answer/${currentUser.uid}/${otherUid}`).remove();
    }
  });

  peerConnections = {};
  peerCandidates = {};
  peerSessionStart = {};

  inVoiceChannel = false;
  currentVoiceChannel = null;
  isCameraOn = false;
  elements.voicePanel.classList.remove('active');
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
  isMuted = !isMuted;
  const btn = document.getElementById('voiceMuteBtn');
  if (btn) {
    btn.classList.toggle('active', isMuted);
    btn.innerHTML = isMuted ? '<i class="fa-solid fa-microphone-slash"></i>' : '<i class="fa-solid fa-microphone"></i>';
  }

  if (localStream) {
    localStream.getAudioTracks().forEach(track => {
      track.enabled = !isMuted;
    });
  }

  if (inVoiceChannel && currentServer) {
    db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/users/${currentUser.uid}/muted`).set(isMuted);
  }
}

function toggleDeafen() {
  isDeafened = !isDeafened;
  const btn = document.getElementById('voiceDeafenBtn');
  if (btn) btn.classList.toggle('active', isDeafened);

  if (inVoiceChannel && currentServer) {
    db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/users/${currentUser.uid}/deafened`).set(isDeafened);
  }

  updateUserVoiceStatus();
}

function toggleMute() {
  isMuted = !isMuted;

  const btn = document.getElementById('micBtn');
  if (btn) {
    btn.style.color = isMuted ? '#ed4245' : '#b5bac1';
    btn.innerHTML = isMuted ? '<i class="fa-solid fa-microphone-slash"></i>' : '<i class="fa-solid fa-microphone"></i>';
  }

  if (localStream) {
    localStream.getAudioTracks().forEach(track => {
      track.enabled = !isMuted;
    });
  }

  if (inVoiceChannel && currentServer) {
    db.ref(`servers/${currentServer}/voiceChannels/${currentVoiceChannel}/users/${currentUser.uid}/muted`).set(isMuted);
  }

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
