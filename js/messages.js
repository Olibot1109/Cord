let slowmodeTimer = null;
let slowmodeUntil = 0;
const messageProfileCache = {};
const messageProfilePromises = {};
const MESSAGE_LIMIT = 100;
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 8;
const AI_COMMAND_API_KEY = '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';
const AI_COMMAND_MODEL = 'llama-3.3-70b-versatile';
const AI_COMMAND_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
let pendingReplyMessage = null;
const mentionCache = {};
let mentionUsers = [];
let mentionActive = false;
let mentionStartIndex = 0;
let mentionSelectedIndex = 0;
let mentionListenersSet = false;
const SLASH_COMMANDS = [
  { name: 'ai', usage: '/ai <message>', description: 'Ask AI a question' }
];
let slashCommandActive = false;
let slashCommandSelectedIndex = 0;
let slashCommandListenersSet = false;
let slashCommandHideTimer = null;
let typingListenerRef = null;
const messageEmbedCache = {};
const messageEmbedPromises = {};
const pruneTimersByRef = new Map();
const pruneErrorShownByRef = new Set();

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
  const pollBtn = document.getElementById('pollBtn');
  if (pollBtn) {
    pollBtn.disabled = disabled;
  }
  if (disabled) {
    hideSlashCommandDropdown();
  }
  if (disabled) {
    clearReplyComposer();
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
  const refKey = messagesRef?.toString?.() || 'unknown-ref';
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
  }).catch((error) => {
    if (!pruneErrorShownByRef.has(refKey)) {
      pruneErrorShownByRef.add(refKey);
      console.error('[Message Prune] Failed:', { refKey, error });
      showToast('Auto-delete old messages failed here (permissions/offline).', 'error');
    }
  });
}

function schedulePruneMessages(messagesRef, keep = MESSAGE_LIMIT, delayMs = 220) {
  if (!messagesRef) return;
  const refKey = messagesRef?.toString?.() || String(Date.now());
  if (pruneTimersByRef.has(refKey)) return;

  const timer = setTimeout(() => {
    pruneTimersByRef.delete(refKey);
    pruneMessages(messagesRef, keep);
  }, delayMs);

  pruneTimersByRef.set(refKey, timer);
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

function normalizePollOptions(options) {
  const source = Array.isArray(options) ? options : Object.values(options || {});
  return source
    .map(option => ({
      text: String(option?.text || '').trim(),
      votes: option?.votes && typeof option.votes === 'object' ? option.votes : {}
    }))
    .filter(option => option.text.length > 0)
    .slice(0, POLL_MAX_OPTIONS);
}

function buildPollMarkup(messageKey, poll, authorUid) {
  if (!poll || !poll.question) return '';
  const options = normalizePollOptions(poll.options);
  if (options.length < POLL_MIN_OPTIONS) return '';

  const totalVotes = options.reduce((sum, option) => sum + Object.keys(option.votes || {}).length, 0);
  const viewerUid = currentUser?.uid || '';
  const isClosed = !!poll.closed;
  const canManageMessages = typeof hasPermission === 'function' && currentChannelType !== 'dm' && hasPermission('manage_messages');
  const canEndPoll = !isClosed && !!viewerUid && (viewerUid === authorUid || canManageMessages);

  const optionsMarkup = options.map((option, index) => {
    const voteCount = Object.keys(option.votes || {}).length;
    const percent = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
    const voted = !!(viewerUid && option.votes && option.votes[viewerUid]);
    const barWidth = Math.max(percent, voted ? 6 : 0);
    return `
      <button class="poll-option${voted ? ' voted' : ''}${isClosed ? ' closed' : ''}" onclick="votePollOption('${messageKey}', ${index})" type="button">
        <div class="poll-option-fill" style="width:${barWidth}%"></div>
        <div class="poll-option-row">
          <span class="poll-option-text">${escapeHtml(option.text)}</span>
          <span class="poll-option-votes" onclick="showPollVoters(event, '${messageKey}', ${index})" title="View voters">${voteCount} (${percent}%)</span>
        </div>
      </button>
    `;
  }).join('');

  return `
    <div class="message-poll" id="poll-${messageKey}">
      <div class="message-poll-header">${isClosed ? 'Poll Ended' : 'Poll'}</div>
      <div class="message-poll-question">${escapeHtml(String(poll.question || ''))}</div>
      <div class="message-poll-options">${optionsMarkup}</div>
      <div class="message-poll-footer">
        <div class="message-poll-total">${totalVotes} vote${totalVotes === 1 ? '' : 's'}</div>
        ${canEndPoll ? `<button class="poll-end-btn" onclick="endPollMessage('${messageKey}')">End Poll</button>` : ''}
      </div>
    </div>
  `;
}

function getCurrentMessagesRef() {
  if (!currentChannel) return null;
  return currentChannelType === 'dm'
    ? db.ref(`dms/${currentChannel}/messages`)
    : db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages`);
}

function parseSlashCommand(input) {
  const raw = String(input || '').trim();
  if (!raw.startsWith('/')) return null;
  const spaceIndex = raw.indexOf(' ');
  const command = (spaceIndex === -1 ? raw.slice(1) : raw.slice(1, spaceIndex)).toLowerCase();
  const args = (spaceIndex === -1 ? '' : raw.slice(spaceIndex + 1)).trim();
  return { command, args, raw };
}

function requestAiCommandResponse(prompt) {
  return fetch(AI_COMMAND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_COMMAND_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_COMMAND_MODEL,
      messages: [
        { role: 'system', content: 'You are a concise, helpful assistant in a chat app.' },
        { role: 'user', content: prompt }
      ]
    })
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = data?.error?.message || 'AI request failed';
      throw new Error(errorMessage);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content || !String(content).trim()) {
      throw new Error('AI returned an empty response');
    }
    return String(content).trim();
  });
}

function runSlashCommand(text, messagesRef, options = {}) {
  const parsed = parseSlashCommand(text);
  if (!parsed) return Promise.resolve(false);
  if (!messagesRef) return Promise.resolve(true);

  const onHandled = typeof options.onHandled === 'function' ? options.onHandled : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  if (currentChannelType === 'text' && currentServer && !hasPermission('use_commands')) {
    showToast('Your role cannot use commands in this server', 'error');
    onError();
    return Promise.resolve(true);
  }

  if (parsed.command !== 'ai') {
    showToast(`Unknown command: /${parsed.command}`, 'error');
    onError();
    return Promise.resolve(true);
  }
  if (!parsed.args) {
    showToast('Usage: /ai <message>', 'error');
    onError();
    return Promise.resolve(true);
  }

  showToast('AI is thinking...', 'info');
  return requestAiCommandResponse(parsed.args).then(aiText => {
    const aiMessage = {
      author: 'AI',
      text: aiText,
      timestamp: Date.now(),
      uid: currentUser?.uid || 'system',
      isAiResponse: true,
      commandMeta: {
        by: userProfile.username || 'User',
        byUid: currentUser?.uid || null,
        command: parsed.command
      }
    };

    return messagesRef.push(aiMessage).then(() => {
      onHandled();
    });
  }).catch(err => {
    showToast('AI command failed: ' + err.message, 'error');
    onError();
  }).then(() => true);
}

function getReplyComposerElements() {
  return {
    bar: document.getElementById('replyComposer'),
    author: document.getElementById('replyAuthor'),
    snippet: document.getElementById('replySnippet')
  };
}

function clearReplyComposer() {
  pendingReplyMessage = null;
  const refs = getReplyComposerElements();
  if (!refs.bar) return;
  refs.bar.classList.remove('active');
  if (refs.author) refs.author.textContent = '';
  if (refs.snippet) refs.snippet.textContent = '';
}

function extractReplySnippetFromMessage(msg) {
  if (!msg) return '';
  if (msg.poll?.question) return `[Poll] ${msg.poll.question}`;
  if (msg.image) return '[Image]';
  if (msg.text) return String(msg.text).trim().slice(0, 120);
  return '[Message]';
}

function setReplyComposer(messageKey, msg) {
  if (!messageKey || !msg) return;
  pendingReplyMessage = {
    messageId: messageKey,
    uid: msg.uid || null,
    author: msg.author || 'Unknown',
    snippet: extractReplySnippetFromMessage(msg)
  };

  const refs = getReplyComposerElements();
  if (!refs.bar) return;
  if (refs.author) refs.author.textContent = pendingReplyMessage.author;
  if (refs.snippet) refs.snippet.textContent = pendingReplyMessage.snippet || '[Message]';
  refs.bar.classList.add('active');
  if (elements.messageInput) elements.messageInput.focus();
}

function getReplyPayload() {
  if (!pendingReplyMessage || !pendingReplyMessage.messageId) return null;
  return { ...pendingReplyMessage };
}

function escapeReplySnippet(snippet) {
  return escapeHtml(String(snippet || '')).replace(/\n/g, ' ');
}

function buildReplyPreviewMarkup(replyTo) {
  if (!replyTo || !replyTo.messageId) return '';
  const replyAuthor = escapeHtml(String(replyTo.author || 'Unknown'));
  const replySnippet = escapeReplySnippet(replyTo.snippet || '[Message]');
  const targetId = escapeHtml(String(replyTo.messageId));
  return `
    <button class="message-reply-preview" onclick="jumpToRepliedMessage('${targetId}')" type="button">
      <span class="message-reply-author">${replyAuthor}</span>
      <span class="message-reply-snippet">${replySnippet}</span>
    </button>
  `;
}

function buildCommandUsageMarkup(commandMeta) {
  if (!commandMeta || !commandMeta.command) return '';
  const byName = escapeHtml(String(commandMeta.by || 'User'));
  const command = escapeHtml(String(commandMeta.command || ''));
  return `
    <div class="message-command-usage">
      <span class="message-command-user">${byName}</span>
      <span class="message-command-used-text">used</span>
      <span class="message-command-pill">/${command}</span>
    </div>
  `;
}

function jumpToRepliedMessage(messageId) {
  if (!messageId) return;
  const target = document.getElementById(`msg-${messageId}`);
  if (!target) {
    showToast('Original message not found', 'error');
    return;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('reply-target-highlight');
  setTimeout(() => target.classList.remove('reply-target-highlight'), 1400);
}

function trimUrlCandidate(url) {
  if (!url) return '';
  let trimmed = url;
  while (/[.,!?;:]$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  while (trimmed.endsWith(')')) {
    const open = (trimmed.match(/\(/g) || []).length;
    const close = (trimmed.match(/\)/g) || []).length;
    if (close <= open) break;
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function extractFirstMessageUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  const cleaned = trimUrlCandidate(match[0]);
  return cleaned || null;
}

function extractInviteCodeFromText(text) {
  if (!text) return null;
  const trimmed = text.trim();

  if (/^[A-Za-z0-9]{4,16}$/.test(trimmed)) {
    return normalizeInviteCode(trimmed);
  }

  const labeled = trimmed.match(/invite(?:\s*code)?[:\s-]+([A-Za-z0-9]{4,16})/i);
  if (labeled && labeled[1]) {
    return normalizeInviteCode(labeled[1]);
  }

  return null;
}

function formatMessageTextWithLinks(text) {
  if (!text) return '';
  const urlRegex = /https?:\/\/[^\s<>"']+/gi;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    const start = match.index;
    const raw = match[0];
    const cleaned = trimUrlCandidate(raw);

    result += formatMentions(escapeHtml(text.slice(lastIndex, start)));
    if (cleaned) {
      const trailing = raw.slice(cleaned.length);
      const safeUrl = escapeHtml(cleaned);
      result += `<a class="message-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
      if (trailing) {
        result += formatMentions(escapeHtml(trailing));
      }
    } else {
      result += formatMentions(escapeHtml(raw));
    }

    lastIndex = start + raw.length;
  }

  result += formatMentions(escapeHtml(text.slice(lastIndex)));
  return result;
}

function fetchEmbedData(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return Promise.resolve(null);
  }

  const cleanUrl = parsed.href;
  const inviteCode = extractInviteCodeFromUrl(cleanUrl);
  if (inviteCode) {
    return fetchInviteEmbedData(cleanUrl, inviteCode);
  }

  const fallback = {
    url: cleanUrl,
    title: parsed.hostname.replace(/^www\./, ''),
    description: parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '',
    provider: parsed.hostname.replace(/^www\./, ''),
    thumbnail: ''
  };

  return fetch(`https://noembed.com/embed?nowrap=on&maxwidth=640&url=${encodeURIComponent(cleanUrl)}`)
    .then(response => response.ok ? response.json() : null)
    .then(data => {
      if (!data || data.error) return fallback;
      return {
        url: cleanUrl,
        title: data.title || fallback.title,
        description: data.author_name ? `by ${data.author_name}` : (data.description || fallback.description || ''),
        provider: data.provider_name || fallback.provider,
        thumbnail: data.thumbnail_url || ''
      };
    })
    .catch(() => fallback);
}

function normalizeInviteCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractInviteCodeFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return null;
  }

  const fromInviteParam = normalizeInviteCode(parsed.searchParams.get('invite'));
  if (fromInviteParam.length >= 4) return fromInviteParam;

  const fromCodeParam = normalizeInviteCode(parsed.searchParams.get('code'));
  if (fromCodeParam.length >= 4 && /invite|join/i.test(parsed.pathname)) return fromCodeParam;

  const parts = parsed.pathname.split('/').filter(Boolean).map(p => p.trim());
  for (let i = 0; i < parts.length; i++) {
    if (/^(invite|invites|join)$/i.test(parts[i]) && parts[i + 1]) {
      const candidate = normalizeInviteCode(parts[i + 1]);
      if (candidate.length >= 4) return candidate;
    }
  }

  return null;
}

function fetchInviteEmbedData(url, inviteCode) {
  return db.ref('servers').once('value').then(snapshot => {
    const servers = snapshot.val() || {};
    let foundServerId = null;
    let foundServer = null;

    Object.entries(servers).forEach(([serverId, serverData]) => {
      if (foundServerId) return;
      const code = normalizeInviteCode(serverData?.invite);
      if (code && code === inviteCode) {
        foundServerId = serverId;
        foundServer = serverData || {};
      }
    });

    if (!foundServerId || !foundServer) {
      return {
        type: 'server-invite',
        valid: false,
        url,
        inviteCode,
        title: 'Invalid Server Invite',
        description: 'This invite is invalid or expired.',
        provider: 'Server Invite',
        thumbnail: '',
        memberCount: 0
      };
    }

    const members = foundServer.members || {};
    const memberCount = Object.keys(members).length;

    return {
      type: 'server-invite',
      valid: true,
      url,
      inviteCode,
      serverId: foundServerId,
      title: foundServer.name || 'Unnamed Server',
      description: foundServer.description || 'No description',
      provider: 'Server Invite',
      thumbnail: foundServer.icon || '',
      memberCount,
      alreadyMember: !!(members[currentUser?.uid] || userServers.includes(foundServerId))
    };
  }).catch(() => {
    return {
      type: 'server-invite',
      valid: false,
      url,
      inviteCode,
      title: 'Server Invite',
      description: 'Unable to load invite right now.',
      provider: 'Server Invite',
      thumbnail: '',
      memberCount: 0
    };
  });
}

function getEmbedData(url) {
  if (!url) return Promise.resolve(null);
  if (messageEmbedCache[url]) return Promise.resolve(messageEmbedCache[url]);
  if (messageEmbedPromises[url]) return messageEmbedPromises[url];

  const promise = fetchEmbedData(url).then(data => {
    if (data) messageEmbedCache[url] = data;
    delete messageEmbedPromises[url];
    return data;
  }).catch(() => {
    delete messageEmbedPromises[url];
    return null;
  });

  messageEmbedPromises[url] = promise;
  return promise;
}

function buildEmbedMarkup(embed) {
  if (!embed || !embed.url) return '';

  if (embed.type === 'server-invite') {
    const safeTitle = escapeHtml(embed.title || 'Server Invite');
    const safeDescription = escapeHtml(embed.description || '');
    const safeCode = escapeHtml(embed.inviteCode || '');
    const safeMembers = Number.isFinite(embed.memberCount) ? embed.memberCount : 0;
    const memberLabel = safeMembers === 1 ? '1 member' : `${safeMembers} members`;
    const safeMemberLabel = escapeHtml(memberLabel);
    const safeThumbnail = embed.thumbnail ? escapeHtml(embed.thumbnail) : '';
    const safeInitial = escapeHtml((embed.title || 'S').charAt(0).toUpperCase());
    const disabled = !embed.valid || embed.alreadyMember;
    const buttonText = !embed.valid ? 'Invalid Invite' : (embed.alreadyMember ? 'Already Joined' : 'Join Server');

    return `
      <div class="message-embed message-invite-embed">
        <div class="message-invite-header">
          ${safeThumbnail
            ? `<img class="message-invite-icon" src="${safeThumbnail}" alt="">`
            : `<div class="message-invite-icon message-invite-icon-fallback">${safeInitial}</div>`}
          <div class="message-invite-meta">
            <div class="message-embed-provider">Server Invite</div>
            <div class="message-embed-title">${safeTitle}</div>
            <div class="message-embed-description">${safeDescription}</div>
            <div class="message-embed-url">${safeMemberLabel} | Code: ${safeCode}</div>
          </div>
        </div>
        <div class="message-invite-actions">
          <button class="input-btn message-invite-join-btn" data-invite-code="${safeCode}" ${disabled ? 'disabled' : ''}>${buttonText}</button>
        </div>
      </div>
    `;
  }

  const safeUrl = escapeHtml(embed.url);
  const safeTitle = escapeHtml(embed.title || embed.url);
  const safeProvider = embed.provider ? escapeHtml(embed.provider) : '';
  const safeDescription = embed.description ? escapeHtml(embed.description) : '';
  const safeThumbnail = embed.thumbnail ? escapeHtml(embed.thumbnail) : '';

  return `
    <a class="message-embed" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
      ${safeThumbnail ? `<div class="message-embed-media"><img class="message-embed-thumb" src="${safeThumbnail}" alt=""></div>` : ''}
      <div class="message-embed-body">
        ${safeProvider ? `<div class="message-embed-provider">${safeProvider}</div>` : ''}
        <div class="message-embed-title">${safeTitle}</div>
        ${safeDescription ? `<div class="message-embed-description">${safeDescription}</div>` : ''}
        <div class="message-embed-url">${safeUrl}</div>
      </div>
    </a>
  `;
}

function renderMessageEmbed(messageKey, text) {
  const embedContainer = document.getElementById(`msg-embed-${messageKey}`);
  if (!embedContainer) return;
  const url = extractFirstMessageUrl(text);
  const inviteCode = url ? null : extractInviteCodeFromText(text);
  if (!url && !inviteCode) {
    embedContainer.innerHTML = '';
    return;
  }

  let embedPromise;
  if (url) {
    embedPromise = getEmbedData(url);
  } else {
    const key = `invite:${inviteCode}`;
    if (messageEmbedCache[key] && messageEmbedCache[key].type !== 'server-invite') {
      delete messageEmbedCache[key];
      delete messageEmbedPromises[key];
    }
    if (messageEmbedCache[key]) {
      embedPromise = Promise.resolve(messageEmbedCache[key]);
    } else if (messageEmbedPromises[key]) {
      embedPromise = messageEmbedPromises[key];
    } else {
      messageEmbedPromises[key] = fetchInviteEmbedData(key, inviteCode).then(data => {
        if (data) messageEmbedCache[key] = data;
        delete messageEmbedPromises[key];
        return data;
      }).catch(() => {
        delete messageEmbedPromises[key];
        return null;
      });
      embedPromise = messageEmbedPromises[key];
    }
  }

  embedPromise.then(embed => {
    const container = document.getElementById(`msg-embed-${messageKey}`);
    if (!container) return;
    if (embed && embed.type === 'server-invite' && !embed.valid) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = embed ? buildEmbedMarkup(embed) : '';
    bindInviteEmbedActions(container, embed, messageKey, text);
  });
}

function bindInviteEmbedActions(container, embed, messageKey, text) {
  if (!container || !embed || embed.type !== 'server-invite') return;
  const joinBtn = container.querySelector('.message-invite-join-btn');
  if (!joinBtn || joinBtn.disabled) return;

  joinBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    const inviteCode = normalizeInviteCode(joinBtn.dataset.inviteCode);
    if (!inviteCode) return;
    if (typeof joinServerByInviteCode !== 'function') return;

    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining...';

    joinServerByInviteCode(inviteCode, { closeInviteModal: false, clearInput: false }).then(joined => {
      if (joined) {
        joinBtn.textContent = 'Joined';
      } else {
        joinBtn.disabled = false;
        joinBtn.textContent = 'Join Server';
      }

      const url = extractFirstMessageUrl(text);
      const inviteCode = url ? null : extractInviteCodeFromText(text);
      const cacheKey = url || (inviteCode ? `invite:${inviteCode}` : null);
      if (cacheKey) {
        delete messageEmbedCache[cacheKey];
        delete messageEmbedPromises[cacheKey];
      }
      renderMessageEmbed(messageKey, text);
    }).catch(() => {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join Server';
    });
  });
}

function getMentionDropdown() {
  return document.getElementById('mentionDropdown');
}

function getCommandDropdown() {
  return document.getElementById('commandDropdown');
}

function hideSlashCommandDropdown() {
  const dropdown = getCommandDropdown();
  if (dropdown) dropdown.style.display = 'none';
  slashCommandActive = false;
}

function getSlashCommandMatches(query) {
  if (currentChannelType === 'text' && currentServer && !hasPermission('use_commands')) {
    return [];
  }
  const q = String(query || '').toLowerCase();
  return SLASH_COMMANDS.filter(command => command.name.startsWith(q));
}

function renderSlashCommandDropdown(items) {
  const dropdown = getCommandDropdown();
  if (!dropdown) return;
  if (!items || items.length === 0) {
    hideSlashCommandDropdown();
    return;
  }

  dropdown.innerHTML = items.map((command, idx) => {
    const activeClass = idx === slashCommandSelectedIndex ? ' active' : '';
    return `
      <button class="command-item${activeClass}" data-command-index="${idx}" type="button">
        <div class="command-item-main">/${escapeHtml(command.name)}</div>
        <div class="command-item-desc">${escapeHtml(command.description)}</div>
      </button>
    `;
  }).join('');
  dropdown.style.display = 'block';

  dropdown.querySelectorAll('.command-item').forEach(itemEl => {
    itemEl.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const idx = Number(itemEl.dataset.commandIndex || 0);
      const current = getSlashCommandMatches((elements.messageInput?.value || '').trim().slice(1));
      applySlashCommandSelection(current[idx]);
    });
  });
}

function applySlashCommandSelection(command) {
  if (!command || !elements.messageInput) return;
  const input = elements.messageInput;
  const value = input.value;
  const cursor = input.selectionStart || value.length;
  const beforeCursor = value.slice(0, cursor);
  const slashIndex = beforeCursor.lastIndexOf('/');
  if (slashIndex === -1) return;

  const before = value.slice(0, slashIndex);
  const after = value.slice(cursor);
  const insertion = `/${command.name} `;
  const nextValue = `${before}${insertion}${after}`;
  input.value = nextValue;
  const nextCursor = before.length + insertion.length;
  input.setSelectionRange(nextCursor, nextCursor);
  hideSlashCommandDropdown();
  input.focus();
}

function updateSlashCommandSuggestions(inputValue, cursorIndex, keepIndex = false) {
  const dropdown = getCommandDropdown();
  if (!dropdown) return;

  const uptoCursor = inputValue.slice(0, cursorIndex);
  const slashIndex = uptoCursor.lastIndexOf('/');
  if (slashIndex === -1) {
    hideSlashCommandDropdown();
    return;
  }
  if (slashIndex > 0 && !/\s/.test(uptoCursor[slashIndex - 1])) {
    hideSlashCommandDropdown();
    return;
  }

  const query = uptoCursor.slice(slashIndex + 1);
  if (query.includes(' ') || query.includes('\n')) {
    hideSlashCommandDropdown();
    return;
  }

  const matches = getSlashCommandMatches(query);
  if (matches.length === 0) {
    hideSlashCommandDropdown();
    return;
  }

  slashCommandActive = true;
  if (!keepIndex) slashCommandSelectedIndex = 0;
  slashCommandSelectedIndex = Math.max(0, Math.min(slashCommandSelectedIndex, matches.length - 1));
  renderSlashCommandDropdown(matches);
}

function ensureSlashCommandAutocomplete() {
  if (slashCommandListenersSet || !elements.messageInput) return;
  slashCommandListenersSet = true;

  elements.messageInput.addEventListener('input', () => {
    if (slashCommandHideTimer) {
      clearTimeout(slashCommandHideTimer);
      slashCommandHideTimer = null;
    }
    const cursor = elements.messageInput.selectionStart || 0;
    updateSlashCommandSuggestions(elements.messageInput.value, cursor);
  });

  elements.messageInput.addEventListener('keydown', (e) => {
    if (!slashCommandActive) return;
    const dropdown = getCommandDropdown();
    if (!dropdown || dropdown.style.display === 'none') return;
    const visibleItems = dropdown.querySelectorAll('.command-item');
    if (visibleItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashCommandSelectedIndex = Math.min(slashCommandSelectedIndex + 1, visibleItems.length - 1);
      updateSlashCommandSuggestions(elements.messageInput.value, elements.messageInput.selectionStart || 0, true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashCommandSelectedIndex = Math.max(slashCommandSelectedIndex - 1, 0);
      updateSlashCommandSuggestions(elements.messageInput.value, elements.messageInput.selectionStart || 0, true);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const matches = getSlashCommandMatches((elements.messageInput.value.slice(0, elements.messageInput.selectionStart || 0).split('/').pop() || '').trim());
      applySlashCommandSelection(matches[slashCommandSelectedIndex]);
    }
  });

  elements.messageInput.addEventListener('blur', () => {
    slashCommandHideTimer = setTimeout(() => hideSlashCommandDropdown(), 120);
  });
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

function queueMentionNotifications(messageKey, text) {
  if (!currentUser || !currentServer || currentChannelType !== 'text') return Promise.resolve();
  if (!messageKey || !text) return Promise.resolve();

  const rawText = String(text || '');
  const lowerText = rawText.toLowerCase();
  const hasEveryoneMention = /@(everyone|here)\b/i.test(rawText) && hasPermission('mention_everyone');

  return db.ref(`servers/${currentServer}/members`).once('value').then(snapshot => {
    const members = snapshot.val() || {};
    const targets = new Set();

    Object.entries(members).forEach(([uid, member]) => {
      if (!uid || uid === currentUser.uid) return;
      const username = String(member?.username || '').trim();
      if (!username) return;

      if (hasEveryoneMention) {
        targets.add(uid);
        return;
      }

      const mentionToken = `@${username.toLowerCase()}`;
      if (lowerText.includes(mentionToken)) {
        targets.add(uid);
      }
    });

    if (targets.size === 0) return;

    const updates = {};
    targets.forEach((uid) => {
      updates[`mentions/${uid}/${currentServer}/${currentChannel}/${messageKey}`] = {
        timestamp: Date.now(),
        fromUid: currentUser.uid,
        fromUsername: userProfile.username || 'User',
        serverId: currentServer,
        channelName: currentChannel,
        messageId: messageKey
      };
    });

    return db.ref().update(updates);
  }).catch((error) => {
    console.error('[Mentions] Failed to queue mention notifications:', error);
  });
}

function loadMessages() {
  if (!currentChannel) return;

  elements.messagesArea.innerHTML = '';
  clearReplyComposer();
  clearSlowmodeNotice();
  ensureMentionAutocomplete();
  ensureSlashCommandAutocomplete();
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
  schedulePruneMessages(messagesRef);

  // Listen for new messages
  messagesRef.on('child_added', (snap) => {
    const msg = snap.val();
    if (msg) addMessage(snap.key, msg);
    schedulePruneMessages(messagesRef);
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
    const messageEl = document.getElementById(`msg-${snap.key}`);
    if (messageEl && typeof msg.text === 'string') {
      const textEl = messageEl.querySelector('.message-text');
      if (textEl) {
        textEl.innerHTML = formatMessageTextWithLinks(msg.text);
      }
      renderMessageEmbed(snap.key, msg.text);
    }
    if (messageEl && msg.poll) {
      const pollContainer = messageEl.querySelector('.message-poll-container');
      if (pollContainer) {
        pollContainer.innerHTML = buildPollMarkup(snap.key, msg.poll, msg.uid);
      }
    }
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
  const isAiResponse = !!msg.isAiResponse;
  const hasPoll = !!(msg.poll && msg.poll.question && msg.poll.options);
  const canDelete = !isSystem && (msg.uid === currentUser?.uid || (currentChannelType !== 'dm' && hasPermission('manage_messages')));
  const canEdit = !isSystem && !isAiResponse && !hasPoll && msg.uid === currentUser?.uid;

  const roleColor = msg.roleColor || (msg.role && rolesCache?.[msg.role]?.color) || '#5865f2';
  const roleBadge = msg.role && msg.role !== 'Member' && msg.role !== 'System'
    ? `<span class="role-badge" style="background:${roleColor}">${msg.role}</span>`
    : isSystem ? `<span class="role-badge" style="background:#23a559">SYSTEM</span>` : '';

  const displayAuthor = msg.author || 'Unknown';
  const avatarMarkup = msg.avatar
    ? `<img src="${msg.avatar}" style="width:100%;height:100%;object-fit:cover;">`
    : (displayAuthor ? displayAuthor.charAt(0).toUpperCase() : '?');

  let content = '';
  if (hasPoll) {
    content = `<div class="message-poll-container">${buildPollMarkup(key, msg.poll, msg.uid)}</div>`;
  } else if (msg.text) {
    content = `
      <div class="message-text">${formatMessageTextWithLinks(msg.text)}</div>
      <div class="message-embed-container" id="msg-embed-${key}"></div>
    `;
  } else if (msg.image) {
    content = `<img src="${msg.image}" class="message-image message-image-clickable">`;
  }

  const time = msg.time || new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  div.innerHTML = `
    <div class="message-avatar" id="msg-avatar-${key}" style="background:${isSystem || isAiResponse ? '#23a559' : roleColor}">
      ${avatarMarkup}
    </div>
    <div class="message-content">
      ${buildCommandUsageMarkup(msg.commandMeta)}
      <div class="message-header">
        <span class="message-author" id="msg-author-${key}" style="color:${isSystem || isAiResponse ? '#23a559' : '#f2f3f5'}">${escapeHtml(displayAuthor)}</span>
        ${roleBadge}
        <span class="message-timestamp">${time}</span>
      </div>
      ${buildReplyPreviewMarkup(msg.replyTo)}
      ${content}
      <div class="message-reactions" id="reactions-${key}"></div>
    </div>
      <div class="message-actions">
        ${!isSystem ? `<button class="action-btn reply reply-message-btn" data-message-id="${escapeHtml(key)}" title="Reply"><i class="fa-solid fa-reply"></i></button>` : ''}
        ${canEdit ? `<button class="action-btn edit" onclick="editMessage('${key}')" title="Edit"><i class="fa-solid fa-pen"></i></button>` : ''}
        ${canDelete ? `<button class="action-btn delete" onclick="deleteMessage('${key}')" title="Delete"><i class="fa-solid fa-trash"></i></button>` : ''}
        <button class="action-btn react" onclick="showReactionPicker(event, '${key}')" title="React"><i class="fa-regular fa-face-smile"></i></button>
      </div>
  `;

  elements.messagesArea.appendChild(div);
  elements.messagesArea.scrollTop = elements.messagesArea.scrollHeight;

  updateMessageReactions(key, msg.reactions || {});
  if (msg.text) {
    renderMessageEmbed(key, msg.text);
  }
  if (msg.image) {
    const imageEl = div.querySelector('.message-image-clickable');
    if (imageEl) {
      imageEl.addEventListener('click', () => {
        if (typeof openImageViewer === 'function') {
          openImageViewer(msg.image);
        } else {
          window.open(msg.image);
        }
      });
    }
  }
  const replyBtn = div.querySelector('.reply-message-btn');
  if (replyBtn) {
    replyBtn.addEventListener('click', () => setReplyComposer(key, msg));
  }

  if (!isSystem && !isAiResponse && msg.uid && (!msg.avatar || !msg.author)) {
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

function readPollFormData() {
  const questionInput = document.getElementById('pollQuestionInput');
  const optionsInput = document.getElementById('pollOptionsInput');
  const question = (questionInput?.value || '').trim();
  const options = (optionsInput?.value || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, POLL_MAX_OPTIONS);

  return { question, options, questionInput, optionsInput };
}

function clearPollForm() {
  const questionInput = document.getElementById('pollQuestionInput');
  const optionsInput = document.getElementById('pollOptionsInput');
  if (questionInput) questionInput.value = '';
  if (optionsInput) optionsInput.value = '';
}

function createPollMessage() {
  if (!currentChannel) {
    showToast('Select a channel first', 'error');
    return;
  }
  const { question, options, questionInput, optionsInput } = readPollFormData();

  if (!question) {
    showToast('Poll question is required', 'error');
    if (questionInput) questionInput.focus();
    return;
  }
  if (options.length < POLL_MIN_OPTIONS) {
    showToast('Poll needs at least 2 options', 'error');
    if (optionsInput) optionsInput.focus();
    return;
  }

  const pollOptions = options.map(text => ({ text, votes: {} }));
  const messageData = {
    author: userProfile.username,
    timestamp: Date.now(),
    uid: currentUser.uid,
    replyTo: getReplyPayload(),
    poll: {
      question,
      options: pollOptions,
      closed: false
    }
  };

  if (currentChannelType === 'dm') {
    const dmMessagesRef = db.ref(`dms/${currentChannel}/messages`);
    dmMessagesRef.push(messageData)
      .then(() => {
        hideModal('createPoll');
        clearPollForm();
        clearReplyComposer();
        pruneMessages(dmMessagesRef);
      })
      .catch(err => showToast('Failed to send poll: ' + err.message, 'error'));
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
          doSendPoll(slowmodeSeconds);
        });
      } else {
        doSendPoll(0);
      }
    });
  });

  function doSendPoll(slowmodeSeconds) {
    const messagesRef = db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages`);
    messagesRef.push({
      ...messageData,
      role: userProfile.role
    }).then(() => {
      hideModal('createPoll');
      clearPollForm();
      clearReplyComposer();
      db.ref(`servers/${currentServer}/channels_data/${currentChannel}/slowmodeState/${currentUser.uid}`).set(Date.now());
      if (slowmodeSeconds > 0 && !hasPermission('manage_channels')) {
        startSlowmodeCountdown(slowmodeSeconds * 1000);
      }
      pruneMessages(messagesRef);
    }).catch(err => {
      showToast('Failed to send poll: ' + err.message, 'error');
    });
  }
}

function votePollOption(messageKey, optionIndex) {
  const uid = currentUser?.uid;
  if (!uid || !messageKey) return;
  const messagesRef = getCurrentMessagesRef();
  if (!messagesRef) return;
  const pollRef = messagesRef.child(`${messageKey}/poll`);

  pollRef.transaction(poll => {
    if (!poll || !poll.options || poll.closed) return poll;
    const options = normalizePollOptions(poll.options);
    if (optionIndex < 0 || optionIndex >= options.length) return poll;

    let currentVoteIndex = -1;
    options.forEach((option, index) => {
      const votes = option.votes || {};
      if (votes[uid]) currentVoteIndex = index;
      if (votes[uid] && index !== optionIndex) {
        delete votes[uid];
      }
      option.votes = votes;
    });

    if (currentVoteIndex !== optionIndex) {
      if (!options[optionIndex].votes || typeof options[optionIndex].votes !== 'object') {
        options[optionIndex].votes = {};
      }
      options[optionIndex].votes[uid] = true;
    }

    return {
      ...poll,
      options
    };
  }, (error) => {
    if (error) {
      showToast('Failed to vote on poll: ' + error.message, 'error');
    }
  });
}

function getPollVotersModalElements() {
  const overlay = document.getElementById('pollVotersOverlay');
  if (!overlay) return null;
  return {
    overlay,
    title: document.getElementById('pollVotersTitle'),
    subtitle: document.getElementById('pollVotersSubtitle'),
    list: document.getElementById('pollVotersList')
  };
}

function closePollVoters() {
  const refs = getPollVotersModalElements();
  if (!refs) return;
  refs.overlay.classList.remove('active');
}

function ensurePollVotersModal() {
  let refs = getPollVotersModalElements();
  if (refs) return refs;

  const overlay = document.createElement('div');
  overlay.id = 'pollVotersOverlay';
  overlay.className = 'poll-voters-overlay';
  overlay.innerHTML = `
    <div class="poll-voters-modal">
      <div class="poll-voters-header">
        <div class="poll-voters-title-wrap">
          <div class="poll-voters-title" id="pollVotersTitle">Voters</div>
          <div class="poll-voters-subtitle" id="pollVotersSubtitle"></div>
        </div>
        <button class="poll-voters-close" id="pollVotersClose" title="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="poll-voters-list" id="pollVotersList"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  refs = getPollVotersModalElements();
  if (!refs) return null;

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closePollVoters();
  });
  const closeBtn = document.getElementById('pollVotersClose');
  if (closeBtn) closeBtn.addEventListener('click', closePollVoters);

  return refs;
}

function showPollVoters(event, messageKey, optionIndex) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const messagesRef = getCurrentMessagesRef();
  if (!messagesRef || !messageKey) return;

  messagesRef.child(messageKey).once('value').then(snapshot => {
    const messageData = snapshot.val();
    const poll = messageData?.poll;
    const options = normalizePollOptions(poll?.options);
    if (!poll || optionIndex < 0 || optionIndex >= options.length) return;

    const refs = ensurePollVotersModal();
    if (!refs) return;

    const option = options[optionIndex];
    const voters = Object.keys(option.votes || {});

    refs.title.textContent = poll.question || 'Poll voters';
    refs.subtitle.textContent = option.text || `Option ${optionIndex + 1}`;
    refs.list.innerHTML = '<div class="poll-voters-empty">Loading...</div>';
    refs.overlay.classList.add('active');

    if (voters.length === 0) {
      refs.list.innerHTML = '<div class="poll-voters-empty">No votes yet.</div>';
      return;
    }

    Promise.all(voters.map(uid => getMessageProfile(uid).then(profile => ({
      uid,
      username: profile?.username || uid,
      avatar: profile?.avatar || null
    })))).then(items => {
      refs.list.innerHTML = items.map(item => `
        <div class="poll-voter-row">
          <div class="poll-voter-avatar">${item.avatar ? `<img src="${escapeHtml(item.avatar)}" alt="">` : escapeHtml((item.username || '?').charAt(0).toUpperCase())}</div>
          <div class="poll-voter-name">${escapeHtml(item.username)}</div>
        </div>
      `).join('');
    }).catch(() => {
      refs.list.innerHTML = '<div class="poll-voters-empty">Failed to load voters.</div>';
    });
  });
}

function endPollMessage(messageKey) {
  const uid = currentUser?.uid;
  if (!uid || !messageKey) return;
  const messagesRef = getCurrentMessagesRef();
  if (!messagesRef) return;

  const messageRef = messagesRef.child(messageKey);
  messageRef.once('value').then(snapshot => {
    const msg = snapshot.val();
    if (!msg || !msg.poll) return;
    if (msg.poll.closed) return;

    const canManageMessages = typeof hasPermission === 'function' && currentChannelType !== 'dm' && hasPermission('manage_messages');
    const allowed = uid === msg.uid || canManageMessages;
    if (!allowed) {
      showToast('You cannot end this poll', 'error');
      return;
    }

    messageRef.child('poll').update({
      closed: true,
      endedAt: Date.now(),
      endedBy: uid
    }).catch(err => {
      showToast('Failed to end poll: ' + err.message, 'error');
    });
  }).catch(err => {
    showToast('Failed to end poll: ' + err.message, 'error');
  });
}

function sendMessage() {
  if (!currentChannel) return;

  const text = elements.messageInput.value.trim();
  if (!text) return;
  const replyTo = getReplyPayload();

  if (currentChannelType === 'dm') {
    const dmMessagesRef = db.ref(`dms/${currentChannel}/messages`);
    if (text.startsWith('/')) {
      runSlashCommand(text, dmMessagesRef, {
        onHandled: () => {
          elements.messageInput.value = '';
          clearReplyComposer();
          elements.charCount.textContent = '0/2000';
          elements.charCount.className = 'char-count';
          pruneMessages(dmMessagesRef);
        }
      });
      return;
    }

    const messageData = {
      author: userProfile.username,
      text: text,
      timestamp: Date.now(),
      uid: currentUser.uid,
      replyTo
    };

    dmMessagesRef.push(messageData)
      .then(() => {
        elements.messageInput.value = '';
        clearReplyComposer();
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
      const channelMessagesRef = db.ref(`servers/${currentServer}/channels_data/${currentChannel}/messages`);
      if (text.startsWith('/')) {
        runSlashCommand(text, channelMessagesRef, {
          onHandled: () => {
            elements.messageInput.value = '';
            clearReplyComposer();
            elements.charCount.textContent = '0/2000';
            elements.charCount.className = 'char-count';

            clearTimeout(typingTimeout);
            db.ref(`servers/${currentServer}/channels_data/${currentChannel}/typing/${currentUser.uid}`).remove();
            db.ref(`servers/${currentServer}/channels_data/${currentChannel}/slowmodeState/${currentUser.uid}`).set(Date.now());
            if (slowmodeSeconds > 0 && !hasPermission('manage_channels')) {
              startSlowmodeCountdown(slowmodeSeconds * 1000);
            }
            pruneMessages(channelMessagesRef);
          }
        });
        return;
      }

      // Get role color
      db.ref(`servers/${currentServer}/roles/${userProfile.role}`).once('value').then(roleSnap => {
      const roleData = roleSnap.val() || {};
      
      const messageData = {
        author: userProfile.username,
        text: text,
        timestamp: Date.now(),
        role: userProfile.role,
        uid: currentUser.uid,
        replyTo
      };

      const messageRef = channelMessagesRef.push();
      messageRef.set(messageData)
        .then(() => {
          elements.messageInput.value = '';
          clearReplyComposer();
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
          queueMentionNotifications(messageRef.key, text);
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
    const replyTo = getReplyPayload();
    compressImageFile(file, { maxSize: 1024, quality: 0.7, type: 'image/jpeg' })
      .then(dataUrl => {
        const dmMessagesRef = db.ref(`dms/${currentChannel}/messages`);
        return dmMessagesRef.push({
          author: userProfile.username,
          image: dataUrl,
          timestamp: Date.now(),
          uid: currentUser.uid,
          replyTo
        }).then(() => {
          clearReplyComposer();
          return pruneMessages(dmMessagesRef);
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
      const replyTo = getReplyPayload();
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
              uid: currentUser.uid,
              replyTo
            }).then(() => pruneMessages(channelMessagesRef));
          });
        })
        .then(() => {
          clearReplyComposer();
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

  const path = currentChannelType === 'dm'
    ? `dms/${currentChannel}/messages/${key}`
    : `servers/${currentServer}/channels_data/${currentChannel}/messages/${key}`;

  db.ref(path).remove()
    .catch(err => {
      showToast('Failed to delete message: ' + err.message, 'error');
    });
}

// User Management
