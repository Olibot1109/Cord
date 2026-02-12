let duplicateServerCleanupInterval = null;
let duplicateServerCleanupRunning = false;

function normalizeServerName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

function getServerCreatedAt(serverData) {
  const createdAt = Number(serverData?.createdAt);
  return Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER;
}

function isMembersOnlyBrokenServer(serverData) {
  if (!serverData || typeof serverData !== 'object' || Array.isArray(serverData)) {
    return false;
  }

  const keys = Object.keys(serverData);
  if (keys.length === 1 && keys[0] === 'members') {
    return true;
  }

  const hasMembers = !!serverData.members && typeof serverData.members === 'object';
  const hasCoreServerData = !!(
    serverData.name ||
    serverData.invite ||
    serverData.ownerId ||
    serverData.createdAt ||
    serverData.channels ||
    serverData.voiceChannels ||
    serverData.roles
  );

  return hasMembers && !hasCoreServerData;
}

function cleanupDuplicateServersByName() {
  if (duplicateServerCleanupRunning || !db) return;
  duplicateServerCleanupRunning = true;

  db.ref('servers').once('value').then(snapshot => {
    const servers = snapshot.val() || {};
    const groupedByName = {};
    const removals = [];

    Object.entries(servers).forEach(([serverId, serverData]) => {
      if (isMembersOnlyBrokenServer(serverData)) {
        removals.push(
          db.ref(`servers/${serverId}`).remove()
            .then(() => {
              console.warn('[Server Cleanup] Removed invalid members-only server:', {
                deletedServerId: serverId
              });
            })
        );
        return;
      }

      if (serverData?.members && typeof serverData.members === 'object') {
        Object.entries(serverData.members).forEach(([uid, memberData]) => {
          if (memberData && typeof memberData === 'object' && Object.prototype.hasOwnProperty.call(memberData, 'bio')) {
            removals.push(
              db.ref(`servers/${serverId}/members/${uid}/bio`).remove()
                .then(() => {
                  console.warn('[Server Cleanup] Removed member bio field:', {
                    serverId,
                    uid
                  });
                })
            );
          }
          if (memberData && typeof memberData === 'object' && Object.prototype.hasOwnProperty.call(memberData, 'status')) {
            removals.push(
              db.ref(`servers/${serverId}/members/${uid}/status`).remove()
                .then(() => {
                  console.warn('[Server Cleanup] Removed member status field:', {
                    serverId,
                    uid
                  });
                })
            );
          }
          if (memberData && typeof memberData === 'object' && Object.prototype.hasOwnProperty.call(memberData, 'lastSeen')) {
            removals.push(
              db.ref(`servers/${serverId}/members/${uid}/lastSeen`).remove()
                .then(() => {
                  console.warn('[Server Cleanup] Removed member lastSeen field:', {
                    serverId,
                    uid
                  });
                })
            );
          }
        });
      }

      const normalizedName = normalizeServerName(serverData?.name);
      if (!normalizedName) return;
      if (!groupedByName[normalizedName]) groupedByName[normalizedName] = [];
      groupedByName[normalizedName].push({
        id: serverId,
        name: serverData.name,
        createdAt: getServerCreatedAt(serverData)
      });
    });

    Object.values(groupedByName).forEach(group => {
      if (group.length < 2) return;

      group.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id.localeCompare(b.id);
      });

      const keep = group[0];
      const duplicates = group.slice(1);

      duplicates.forEach(duplicate => {
        removals.push(
          db.ref(`servers/${duplicate.id}`).remove()
            .then(() => {
              console.warn('[Server Cleanup] Removed duplicate server:', {
                deletedServerId: duplicate.id,
                keptServerId: keep.id,
                name: keep.name
              });
            })
        );
      });
    });

    return Promise.allSettled(removals);
  }).catch(error => {
    console.error('[Server Cleanup] Failed duplicate cleanup:', error);
  }).finally(() => {
    duplicateServerCleanupRunning = false;
  });
}

function startDuplicateServerCleanup() {
  if (duplicateServerCleanupInterval) return;
  cleanupDuplicateServersByName();
  duplicateServerCleanupInterval = setInterval(cleanupDuplicateServersByName, 10000);
}
