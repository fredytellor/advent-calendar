import { mountSong, mountYouTubePlayer, parseSong } from './media.js';

const preferenceKey = 'advent-calendar:ambient-music';
const unavailableStates = ['unavailable', 'api-error'];
const playbackStatus = {
  loading: 'Cargando…',
  ready: 'Lista para reproducir',
  buffering: 'Cargando música…',
  playing: 'Reproduciendo',
  paused: 'En pausa',
  manual: 'Pulsa Reproducir para escuchar la música.',
  unavailable: 'Esta canción no se puede reproducir aquí.',
  'api-error': 'No se pudo conectar con el reproductor.',
};

function readPreferences() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(preferenceKey));
  } catch {
    // Playback controls still work when storage is unavailable.
  }
  const volume = stored?.volume;
  return {
    volume: Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : 25,
    muted: stored?.muted === true,
    paused: stored?.paused === true,
  };
}

function canonicalUrl(song) {
  if (!song) return null;
  const hostname = new URL(song.url).hostname === 'music.youtube.com' ? 'music.youtube.com' : 'www.youtube.com';
  return `https://${hostname}/watch?v=${song.id}`;
}

export function createAmbientMusic(db) {
  const element = (id) => document.getElementById(id);
  const widget = element('ambient-widget');
  const toggle = element('ambient-toggle');
  const panel = element('ambient-panel');
  const playerBox = element('ambient-player');
  const play = element('ambient-play');
  const mute = element('ambient-mute');
  const volume = element('ambient-volume');
  const status = element('ambient-status');
  const source = element('ambient-source');
  const configure = element('configure-ambient');
  const dialog = element('ambient-dialog');
  const form = element('ambient-form');
  const input = element('ambient-url');
  const preview = element('ambient-preview');
  const previewBox = element('ambient-preview-player');
  const save = element('ambient-save');
  const remove = element('ambient-remove');
  const cancel = element('ambient-cancel');
  const configStatus = element('ambient-config-status');
  const preferences = readPreferences();
  let editor = false;
  let savedUrl;
  let refreshVersion = 0;
  let track;
  let expanded = false;
  let closing = false;
  let draft;
  let stopPreview;
  let previewId;

  function remember(next) {
    if (Object.keys(next).every((key) => preferences[key] === next[key])) return;
    Object.assign(preferences, next);
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    } catch {
      // The preferences remain available for the current page.
    }
  }

  function drawControls() {
    const playback = track?.state ?? 'loading';
    const disabled = !track?.api || unavailableStates.includes(playback);
    play.disabled = mute.disabled = volume.disabled = disabled;
    play.textContent = playback === 'playing' || playback === 'buffering' ? 'Pausar música' : 'Reproducir música';
    mute.textContent = preferences.muted ? 'Activar sonido' : 'Silenciar';
    volume.value = preferences.volume;
    status.textContent = playbackStatus[playback];
    source.hidden = !unavailableStates.includes(playback);
  }

  function applyAudioSettings(current) {
    if (!current?.api) return;
    current.settingsSent = Date.now();
    current.api.setVolume(preferences.volume);
    if (preferences.muted) current.api.mute();
    else current.api.unMute();
  }

  function syncNativeAudioSettings(current) {
    if (!expanded || track !== current || Date.now() - current.settingsSent < 1800) return;
    const level = current.api.getVolume();
    const muted = current.api.isMuted();
    if (!Number.isInteger(level) || level < 0 || level > 100 || typeof muted !== 'boolean') return;
    if (level !== preferences.volume || muted !== preferences.muted) {
      remember({ volume: level, muted });
      drawControls();
    }
  }

  function setExpanded(open) {
    expanded = open;
    panel.classList.toggle('is-open', open);
    panel.inert = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }

  function releasePlayer(current, preservePosition = false) {
    clearInterval(current.sync);
    if (preservePosition) {
      try {
        const seconds = current.api?.getCurrentTime();
        if (Number.isFinite(seconds)) current.position = seconds;
      } catch {
        // A disconnected player may no longer report its position.
      }
    }
    current.controller?.destroy();
    current.controller = undefined;
    current.api = undefined;
    current.state = 'loading';
  }

  function mountTrack(current) {
    if (current.controller) return;
    const autoplay = !current.mounted && !preferences.paused;
    current.mounted = true;
    drawControls();
    current.controller = mountYouTubePlayer(playerBox, current.song, {
      autoplay,
      loop: true,
      startAt: current.position,
      canAutoplay: () => expanded && !closing && Number(getComputedStyle(panel).opacity) >= 0.85,
      onReady(api) {
        if (track !== current) return;
        current.api = api;
        applyAudioSettings(current);
        current.sync = setInterval(() => syncNativeAudioSettings(current), 1200);
      },
      onStatus(state) {
        if (track !== current) return;
        current.state = state;
        if (state === 'playing') {
          current.hasPlayed = true;
          remember({ paused: false });
        }
        if (state === 'paused' && current.hasPlayed && expanded && !closing) remember({ paused: true });
        if (unavailableStates.includes(state)) clearInterval(current.sync);
        drawControls();
      },
    });
  }

  function updateSong(url) {
    savedUrl = url;
    let song;
    try {
      song = parseSong(url ?? '');
    } catch {
      song = null;
    }
    if (song && track?.song.id === song.id) {
      source.href = song.url;
      return;
    }
    if (track) {
      releasePlayer(track);
      track = undefined;
    }
    widget.hidden = !song;
    if (!song) {
      setExpanded(false);
      return;
    }
    track = { song, state: 'loading' };
    source.href = song.url;
    if (expanded && !closing) mountTrack(track);
  }

  async function refresh() {
    const version = ++refreshVersion;
    try {
      const { data, error } = await db.from('group_banner').select('background_music_url').eq('id', 1).single();
      if (!error && data && version === refreshVersion) updateSong(data.background_music_url);
    } catch {
      // Keep the current player during a temporary configuration error.
    }
  }

  async function collapsePanel() {
    if (!expanded || closing) return;
    closing = true;
    toggle.focus({ preventScroll: true });
    panel.inert = true;
    const current = track;
    if (current?.controller) {
      const paused = await current.controller.pause();
      // If the embed cannot confirm a pause, remove it before hiding the panel.
      if (!paused && track === current) releasePlayer(current, true);
    }
    setExpanded(false);
    closing = false;
  }

  toggle.onclick = () => {
    if (closing || !track) return;
    if (expanded) {
      collapsePanel();
    } else {
      setExpanded(true);
      mountTrack(track);
    }
  };
  widget.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !expanded) return;
    event.preventDefault();
    collapsePanel();
  });

  play.onclick = () => {
    if (!track?.api) return;
    if (track.state === 'playing' || track.state === 'buffering') {
      remember({ paused: true });
      track.controller.pause();
    } else {
      remember({ paused: false });
      track.controller.play();
    }
  };
  mute.onclick = () => {
    remember({ muted: !preferences.muted });
    applyAudioSettings(track);
    drawControls();
  };
  volume.oninput = () => {
    remember({ volume: volume.valueAsNumber });
    applyAudioSettings(track);
  };

  function discardPreview() {
    stopPreview?.();
    stopPreview = undefined;
    previewId = undefined;
    previewBox.replaceChildren();
    previewBox.hidden = true;
  }

  function closeEditor() {
    draft = undefined;
    discardPreview();
    if (dialog.open) {
      dialog.close();
      if (editor) configure.focus({ preventScroll: true });
    }
  }

  function setEditor(allowed) {
    editor = allowed;
    configure.hidden = !allowed;
    if (!allowed && draft) closeEditor();
  }

  function drawEditor() {
    const blocked = draft.loading || draft.busy || draft.baseline === undefined || draft.stale;
    input.disabled = preview.disabled = save.disabled = remove.disabled = blocked;
    remove.hidden = !draft.baseline;
    cancel.disabled = draft.busy;
  }

  configure.onclick = async () => {
    if (!editor || dialog.open) return;
    const current = { baseline: savedUrl, loading: true, busy: false, stale: false, removalConfirmed: false };
    draft = current;
    input.value = savedUrl ?? '';
    configStatus.textContent = 'Cargando la configuración…';
    drawEditor();
    dialog.showModal();
    await refresh();
    if (draft !== current) return;
    current.baseline = savedUrl;
    current.loading = false;
    input.value = savedUrl ?? '';
    configStatus.textContent = savedUrl === undefined ? 'No se pudo cargar la configuración. Vuelve a abrir el editor.' : '';
    drawEditor();
  };

  input.oninput = () => {
    discardPreview();
    draft.removalConfirmed = false;
    configStatus.textContent = '';
  };
  preview.onclick = () => {
    try {
      const song = parseSong(input.value);
      if (song && song.id === previewId) return;
      discardPreview();
      if (!song) {
        configStatus.textContent = 'Introduce el enlace de una canción.';
        return;
      }
      if (track?.song.id === song.id) {
        configStatus.textContent = 'Puedes escuchar la canción actual en el reproductor ambiental.';
        return;
      }
      configStatus.textContent = '';
      previewBox.hidden = false;
      stopPreview = mountSong(previewBox, song, false);
      previewId = song.id;
    } catch (error) {
      configStatus.textContent = error.message;
    }
  };
  remove.onclick = () => {
    if (!window.confirm('¿Quitar la música ambiental al guardar?')) return;
    discardPreview();
    draft.removalConfirmed = true;
    input.value = '';
    configStatus.textContent = 'La canción se quitará al guardar.';
  };
  cancel.onclick = closeEditor;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!draft?.busy) closeEditor();
  });
  dialog.addEventListener('close', () => {
    if (!dialog.open && draft) closeEditor();
  });

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!editor || !draft || save.disabled) return;
    const current = draft;
    let url;
    try {
      url = canonicalUrl(parseSong(input.value));
    } catch (error) {
      configStatus.textContent = error.message;
      return;
    }
    if (!url && current.baseline && !current.removalConfirmed &&
        !window.confirm('¿Quitar la música ambiental?')) return;

    current.busy = true;
    drawEditor();
    configStatus.textContent = 'Guardando la música ambiental…';
    try {
      const { error } = await db.rpc('save_background_music', {
        p_url: url,
        p_expected_url: current.baseline,
      });
      if (error?.code === '40001') {
        current.stale = true;
        refresh();
        throw new Error('Otra persona cambió la música ambiental. Cierra y vuelve a abrir el editor.');
      }
      if (error) throw new Error('No se pudo guardar la música ambiental.');

      refreshVersion++;
      if (draft === current) closeEditor();
      updateSong(url);
    } catch (error) {
      if (draft === current) configStatus.textContent = error.message || 'No se pudo guardar la música ambiental.';
    } finally {
      if (draft === current) {
        current.busy = false;
        drawEditor();
      }
    }
  };

  return { refresh, setEditor };
}
