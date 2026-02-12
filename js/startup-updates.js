const STARTUP_UPDATES_KEY = 'schoolcord_startup_updates_hidden_v1';
let startupUpdatesCloseCallback = null;

function shouldShowStartupUpdates() {
  try {
    return localStorage.getItem(STARTUP_UPDATES_KEY) !== '1';
  } catch (e) {
    return true;
  }
}

function dismissStartupUpdates(neverShowAgain = false) {
  if (neverShowAgain) {
    try {
      localStorage.setItem(STARTUP_UPDATES_KEY, '1');
    } catch (e) {
      // Ignore storage failures and continue closing.
    }
  }
  if (typeof hideModal === 'function') {
    hideModal('startupUpdates');
  }
  if (typeof startupUpdatesCloseCallback === 'function') {
    const cb = startupUpdatesCloseCallback;
    startupUpdatesCloseCallback = null;
    cb();
  }
}

function showStartupUpdates(force = false) {
  if (!force && !shouldShowStartupUpdates()) return false;
  if (typeof showModal === 'function') {
    showModal('startupUpdates');
    return true;
  }
  return false;
}

function onStartupUpdatesClosed(callback) {
  startupUpdatesCloseCallback = typeof callback === 'function' ? callback : null;
}

window.dismissStartupUpdates = dismissStartupUpdates;
window.showStartupUpdates = showStartupUpdates;
window.onStartupUpdatesClosed = onStartupUpdatesClosed;
