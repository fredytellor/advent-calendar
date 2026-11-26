export const MAX_PHOTOS = 10;
export const PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function memoryPhotos(memory) {
  if (Array.isArray(memory?.photos)) return memory.photos;
  return memory?.photo ? [memory.photo] : [];
}

export async function compressPhoto(file, previewUrl, maxDimension = 1600, quality = 0.8) {
  const image = new Image();
  image.src = previewUrl;
  await image.decode();

  // HTML images use the metadata orientation before canvas draws them.
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);

  const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  let blob = await encode('image/webp');
  if (blob?.type !== 'image/webp') {
    blob = await encode(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png');
  }
  if (!blob || blob.size > 5 * 1024 * 1024) {
    throw new Error('La foto comprimida supera 5 MB o no se pudo convertir.');
  }
  return blob;
}

export const SONG_ERROR = 'Usa un enlace de video de YouTube, youtu.be o YouTube Music.';

export function parseSong(value) {
  const input = value.trim();
  if (!input) return null;

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(SONG_ERROR);
  }

  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error(SONG_ERROR);
  }

  let id;
  if (url.hostname === 'youtu.be') {
    id = /^\/([\w-]+)\/?$/.exec(url.pathname)?.[1];
  } else if (['youtube.com', 'www.youtube.com', 'music.youtube.com'].includes(url.hostname)
      && url.pathname === '/watch' && url.searchParams.getAll('v').length === 1) {
    id = url.searchParams.get('v');
  }

  if (!/^[A-Za-z0-9_-]{11}$/.test(id ?? '')) throw new Error(SONG_ERROR);
  url.protocol = 'https:';
  return { id, url: url.href };
}

let apiPromise;

function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(failed, 10000);

    function failed() {
      clearTimeout(timeout);
      script.remove();
      reject(new Error('No se pudo cargar YouTube.'));
    }

    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      resolve(window.YT);
    };
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = failed;
    document.head.append(script);
  }).catch((error) => {
    apiPromise = undefined;
    throw error;
  });
  return apiPromise;
}

// The YouTube embed requirements allow only one automatic player on a page.
let automaticPlayer;

export function mountYouTubePlayer(container, song, {
  autoplay = false, loop = false, startAt = 0, canAutoplay = () => true, onReady, onStatus,
} = {}) {
  const iframe = document.createElement('iframe');
  iframe.title = 'Reproductor de YouTube';
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin: location.origin,
    playsinline: '1',
    autoplay: '0',
  });
  if (loop) {
    params.set('loop', '1');
    params.set('playlist', song.id);
  }
  if (startAt >= 1) params.set('start', String(Math.floor(startAt)));
  iframe.src = `https://www.youtube.com/embed/${song.id}?${params}`;
  container.append(iframe);

  let active = true;
  let ready = false;
  let unavailable = false;
  let awaitingAutoplay = autoplay && typeof IntersectionObserver === 'function';
  let visible = false;
  let player;
  let playerStates;
  let playRequested = false;
  let pauseRequest;
  let observer;
  let frame;
  let deadline;

  function clearAutomaticPlayback() {
    awaitingAutoplay = false;
    observer?.disconnect();
    document.removeEventListener('visibilitychange', attemptAutoplay);
    cancelAnimationFrame(frame);
    frame = undefined;
  }

  function releaseAutoplay() {
    if (automaticPlayer === iframe) automaticPlayer = undefined;
  }

  function manualPlayback(release = true) {
    clearTimeout(deadline);
    clearAutomaticPlayback();
    if (release) releaseAutoplay();
    onStatus?.('manual');
  }

  function requestPlayback() {
    clearTimeout(deadline);
    deadline = setTimeout(() => manualPlayback(false), 4500);
    playRequested = true;
    player.playVideo();
  }

  function finishPause(confirmed) {
    if (!pauseRequest) return;
    const { timer, resolve } = pauseRequest;
    pauseRequest = undefined;
    clearTimeout(timer);
    resolve(confirmed);
  }

  function sendPause() {
    try {
      const { UNSTARTED, CUED, PAUSED, ENDED } = playerStates;
      const alreadyStopped = !playRequested &&
        [UNSTARTED, CUED, PAUSED, ENDED].includes(player.getPlayerState());
      player.pauseVideo();
      if (alreadyStopped) {
        releaseAutoplay();
        finishPause(true);
      }
    } catch {
      finishPause(false);
    }
  }

  function attemptAutoplay() {
    if (!awaitingAutoplay || !ready || !visible || document.hidden) return;
    if (!canAutoplay()) {
      if (frame === undefined) {
        frame = requestAnimationFrame(() => {
          frame = undefined;
          attemptAutoplay();
        });
      }
      return;
    }
    if (automaticPlayer && automaticPlayer !== iframe) {
      manualPlayback();
      return;
    }
    clearAutomaticPlayback();
    automaticPlayer = iframe;
    requestPlayback();
  }

  if (awaitingAutoplay) {
    observer = new IntersectionObserver(([entry]) => {
      visible = entry.intersectionRatio > 0.5;
      attemptAutoplay();
    }, { threshold: [0, 0.51] });
    observer.observe(iframe);
    document.addEventListener('visibilitychange', attemptAutoplay);
  }

  function changeState(state, states) {
    if (!active || unavailable) return;
    switch (state) {
      case states.PLAYING:
        playRequested = false;
        clearTimeout(deadline);
        clearAutomaticPlayback();
        onStatus?.('playing');
        break;
      case states.PAUSED:
        playRequested = false;
        clearTimeout(deadline);
        clearAutomaticPlayback();
        releaseAutoplay();
        onStatus?.('paused');
        finishPause(true);
        break;
      case states.BUFFERING:
        onStatus?.('buffering');
        break;
      case states.ENDED:
        playRequested = false;
        if (!loop) releaseAutoplay();
        onStatus?.('ready');
        break;
    }
  }

  function fail(status) {
    if (!active) return;
    unavailable = true;
    clearTimeout(deadline);
    clearAutomaticPlayback();
    releaseAutoplay();
    onStatus?.(status);
    finishPause(false);
  }

  loadYouTube().then((YT) => {
    if (!active) return;
    player = new YT.Player(iframe, {
      events: {
        onReady(event) {
          if (!active || unavailable) return;
          ready = true;
          player = event.target;
          playerStates = YT.PlayerState;
          onReady?.(player);
          onStatus?.('ready');
          changeState(player.getPlayerState(), YT.PlayerState);
          if (pauseRequest) sendPause();
          attemptAutoplay();
        },
        onStateChange(event) {
          changeState(event.data, YT.PlayerState);
        },
        onAutoplayBlocked() {
          if (active && !unavailable) {
            playRequested = false;
            manualPlayback();
            finishPause(true);
          }
        },
        onError() {
          fail('unavailable');
        },
      },
    });
  }).catch(() => fail('api-error'));

  return {
    play() {
      if (!active || unavailable || !ready) return;
      finishPause(false);
      clearAutomaticPlayback();
      releaseAutoplay();
      requestPlayback();
    },
    pause() {
      clearTimeout(deadline);
      clearAutomaticPlayback();
      if (!active || unavailable) return Promise.resolve(false);
      if (pauseRequest) return pauseRequest.promise;
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      const timer = setTimeout(() => finishPause(false), 1200);
      pauseRequest = { promise, timer, resolve };
      if (ready) sendPause();
      return promise;
    },
    destroy() {
      if (!active) return;
      active = false;
      clearTimeout(deadline);
      clearAutomaticPlayback();
      releaseAutoplay();
      finishPause(false);
      try {
        if (ready && !unavailable) player.stopVideo();
      } catch {
        // Removing a disconnected iframe also ends its playback.
      }
      try {
        player?.destroy();
      } catch {
        // The iframe may already have been detached.
      } finally {
        iframe.remove();
      }
    },
  };
}

export function mountSong(container, song, autoplay, canAutoplay) {
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const play = document.createElement('button');
  play.type = 'button';
  play.textContent = 'Reproducir canción';
  play.hidden = true;
  const link = document.createElement('a');
  link.href = song.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Abrir canción en YouTube';
  const controls = document.createElement('div');
  controls.className = 'form-actions music-actions';
  controls.append(play, link);

  const player = mountYouTubePlayer(container, song, {
    autoplay,
    canAutoplay,
    onStatus(state) {
      play.hidden = !['manual', 'ready', 'paused'].includes(state);
      const messages = {
        manual: 'Pulsa reproducir para escuchar la canción.',
        unavailable: 'Esta canción no se puede reproducir aquí.',
        'api-error': 'Si el reproductor no carga, abre la canción en YouTube.',
      };
      status.textContent = messages[state] || '';
    },
  });
  play.onclick = player.play;
  container.append(status, controls);
  return player.destroy;
}
