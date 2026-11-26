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

export async function compressPhoto(file, previewUrl, maxDimension = 1600) {
  const image = new Image();
  image.src = previewUrl;
  await image.decode();

  // HTML images use the metadata orientation before canvas draws them.
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);

  const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.8));
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

export function mountSong(container, song, autoplay) {
  const iframe = document.createElement('iframe');
  iframe.title = 'Reproductor de YouTube';
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin: location.origin,
    playsinline: '1',
    autoplay: autoplay ? '1' : '0',
  });
  iframe.src = `https://www.youtube.com/embed/${song.id}?${params}`;

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
  container.append(iframe, status, controls);

  let active = true;
  let ready = false;
  let playing = false;
  let unavailable = false;
  let player;
  const timeout = autoplay ? setTimeout(showManual, 4000) : undefined;

  function showManual() {
    if (!active || unavailable || playing) return;
    status.textContent = 'Pulsa reproducir para escuchar la canción.';
    play.hidden = !ready;
  }

  function playbackStarted() {
    playing = true;
    clearTimeout(timeout);
    status.textContent = '';
    play.hidden = true;
  }

  play.onclick = () => {
    if (ready && active && !unavailable) {
      player.unMute();
      player.playVideo();
    }
  };

  loadYouTube().then((YT) => {
    if (!active) return;
    player = new YT.Player(iframe, {
      events: {
        onReady(event) {
          if (!active || unavailable) return;
          ready = true;
          if (event.target.getPlayerState() === YT.PlayerState.PLAYING) playbackStarted();
          else if (status.textContent) showManual();
        },
        onStateChange(event) {
          if (!active || unavailable) return;
          if (event.data === YT.PlayerState.PLAYING) playbackStarted();
        },
        onAutoplayBlocked() {
          playing = false;
          showManual();
        },
        onError() {
          if (!active) return;
          unavailable = true;
          clearTimeout(timeout);
          play.hidden = true;
          iframe.hidden = true;
          status.textContent = 'Esta canción no se puede reproducir aquí.';
        },
      },
    });
  }).catch(() => {
    if (!active) return;
    clearTimeout(timeout);
    status.textContent = 'Si el reproductor no carga, abre la canción en YouTube.';
  });

  return () => {
    active = false;
    clearTimeout(timeout);
    try {
      if (ready && !unavailable) player?.stopVideo();
    } catch {
      // The player may already have disconnected.
    }
    try {
      player?.destroy();
    } catch {
      // Removing the iframe also ends playback.
    }
    iframe.remove();
  };
}
