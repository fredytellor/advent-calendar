import { URL as projectUrl } from './config.js';

const preferenceKey = 'advent-calendar:ambient-audio-enabled';
const project = new URL(projectUrl);
const projectRef = /^([a-z0-9-]+)(?:\.storage)?\.supabase\.co$/.exec(project.hostname)?.[1];
const storageOrigins = new Set([project.origin]);
if (projectRef) {
  storageOrigins.add(`https://${projectRef}.supabase.co`);
  storageOrigins.add(`https://${projectRef}.storage.supabase.co`);
}
const audioPath = /^\/storage\/v1\/object\/public\/background-music\/(?:[^/]+\/)*[^/]+\.[mM][pP]3$/;

function supportedAudioUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && storageOrigins.has(url.origin) && !url.username && !url.password &&
        !url.hash && audioPath.test(url.pathname)) return url.href;
  } catch {
    // Ignore malformed and legacy ambient settings.
  }
  return null;
}

function readPreference() {
  try {
    return localStorage.getItem(preferenceKey) !== 'false';
  } catch {
    return true;
  }
}

export function createAmbientMusic(db) {
  const toggle = document.getElementById('ambient-sound');
  let enabled = readPreference();
  let audio;
  let source = null;
  let playing = false;
  let gesture;
  let playbackVersion = 0;
  let refreshVersion = 0;

  function drawToggle() {
    const audible = Boolean(enabled && playing && !audio.paused && !audio.muted);
    const unavailable = Boolean(audio?.error);
    let label = audible ? 'Silenciar música ambiental' : 'Activar música ambiental';
    if (unavailable) label = 'Música ambiental no disponible';
    toggle.hidden = !source;
    toggle.disabled = unavailable;
    toggle.classList.toggle('is-playing', audible);
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }

  function clearGesture() {
    gesture?.abort();
    gesture = undefined;
  }

  function retryOnGesture() {
    if (gesture) return;
    gesture = new AbortController();
    const options = { capture: true, signal: gesture.signal };
    const retry = (event) => {
      if (!event.isTrusted || navigator.userActivation?.isActive === false ||
          toggle.contains(event.target) ||
          (event.type === 'keydown' && (event.repeat || event.key === 'Escape'))) return;
      clearGesture();
      play();
    };
    document.addEventListener('click', retry, options);
    document.addEventListener('keydown', retry, options);
  }

  async function play(allowGestureRetry = false) {
    if (!source || !enabled || audio.error) return;
    const version = ++playbackVersion;
    try {
      await audio.play();
      if (playbackVersion === version) clearGesture();
    } catch (error) {
      if (playbackVersion !== version || !enabled) return;
      if (allowGestureRetry && error.name === 'NotAllowedError') retryOnGesture();
      drawToggle();
    }
  }

  function createAudio() {
    const player = new Audio();
    player.loop = true;
    player.preload = 'none';
    try {
      player.volume = 0.25;
    } catch {
      // Some devices use only their system volume.
    }

    const markSilent = () => {
      playing = false;
      drawToggle();
    };
    player.addEventListener('playing', () => {
      if (!source || !enabled || player.paused) return;
      playing = true;
      clearGesture();
      drawToggle();
    });
    player.addEventListener('pause', () => {
      if (player.paused) markSilent();
    });
    player.addEventListener('waiting', markSilent);
    player.addEventListener('ended', markSilent);
    player.addEventListener('volumechange', drawToggle);
    player.addEventListener('error', () => {
      if (!source || !player.error) return;
      clearGesture();
      markSilent();
    });
    return player;
  }

  function updateSource(url) {
    const next = supportedAudioUrl(url);
    if (next === source) return;

    playbackVersion++;
    clearGesture();
    audio?.pause();
    playing = false;
    source = next;

    if (source) {
      audio ??= createAudio();
      audio.src = source;
      if (enabled) play(true);
    } else if (audio) {
      audio.removeAttribute('src');
      audio.load();
    }
    drawToggle();
  }

  toggle.addEventListener('click', () => {
    if (!source || audio.error) return;
    clearGesture();
    enabled = !playing || audio.paused || audio.muted;
    try {
      localStorage.setItem(preferenceKey, String(enabled));
    } catch {
      // A preference can still be applied for the current page.
    }

    if (enabled) {
      audio.muted = false;
      play();
    } else {
      playbackVersion++;
      audio.pause();
      playing = false;
    }
    drawToggle();
  });

  async function refresh() {
    const version = ++refreshVersion;
    try {
      const { data, error } = await db.from('group_banner').select('background_music_url').eq('id', 1).single();
      if (!error && data && version === refreshVersion) updateSource(data.background_music_url);
    } catch {
      // A temporary configuration error leaves the current track alone.
    }
  }

  return { refresh };
}
