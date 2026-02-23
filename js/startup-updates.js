let startupUpdatesCloseCallback = null;

function dismissStartupUpdates() {
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
