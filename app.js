import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { URL as projectUrl, KEY, YEAR } from './config.js';
import { compressPhoto, MAX_PHOTOS, memoryPhotos, mountSong, parseSong, PHOTO_TYPES } from './media.js';
import { createBanner } from './banner.js';
import { createAmbientMusic } from './ambient-music.js';

const $ = (id) => document.getElementById(id);
const db = createClient(projectUrl, KEY);
const banner = createBanner(db);
const ambient = createAmbientMusic(db);
const storage = db.storage.from('memories');
const cardStorage = db.storage.from('calendar-cards');
const modal = $('modal');
const memoryContent = $('memory-content');
const detail = $('detail');
const editPanel = $('memory-editor');
const tabList = $('memory-tabs');
const tabs = { preview: $('view-tab'), edit: $('edit-tab') };
const closeButton = $('close');
const photoModal = $('photo-modal');
const fullPhoto = $('full-photo');
const colombiaClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Bogota',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});
const icons = ['🎁', '✦', '🎄', '🔔', '❄', '🦌', '⛄', '✶'];
const dayCards = [];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const heroEasing = 'cubic-bezier(0.22, 1, 0.36, 1)';
let openedDays = 0;
let records = {};
let cardImages = {};
let cardRefreshVersion = 0;
let editor = false;
let accountId;
let refreshVersion = 0;
let view;
let activeCard;
let hero;

function node(tag, text = '', className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, action, className = '') {
  const element = node('button', text, className);
  element.type = 'button';
  element.onclick = action;
  return element;
}

for (let index = 0; index < 27; index++) {
  const bulb = node('i');
  bulb.style.setProperty('--bulb', index % 5);
  $('bulbs').append(bulb);
}
const snow = document.createDocumentFragment();
for (let index = 0; index < 52; index++) {
  const flake = node('i');
  const duration = 14 + Math.random() * 18;
  flake.style.setProperty('--x', `${(index + Math.random()) / 52 * 100}%`);
  flake.style.setProperty('--size', `${1.5 + Math.random() * 2.8}px`);
  flake.style.setProperty('--opacity', `${.15 + Math.random() * .23}`);
  flake.style.setProperty('--duration', `${duration}s`);
  flake.style.setProperty('--delay', `-${Math.random() * duration}s`);
  flake.style.setProperty('--sway', `${Math.random() * 28 - 14}px`);
  flake.style.setProperty('--drift', `${Math.random() * 80 - 40}px`);
  snow.append(flake);
}
$('snow').append(snow);

for (let day = 1; day <= 24; day++) {
  const door = button('', () => openDay(day), 'door');
  const face = node('span', '', 'door-face');
  face.setAttribute('aria-hidden', 'true');
  const icon = node('span', '', 'door-icon');
  face.append(node('span', String(day), 'door-number'), icon);
  door.append(face);
  dayCards.push({ door, face, icon });
  $('days').append(door);
}

function drawDoors() {
  dayCards.forEach((card, index) => {
    const { door, icon } = card;
    const locked = index >= openedDays;
    door.disabled = locked && !editor;
    door.classList.toggle('locked', locked);
    icon.textContent = locked ? '' : icons[index % icons.length];
    const lockLabel = locked ? editor ? ', cerrado al público' : ', cerrado' : '';
    door.setAttribute('aria-label', `${index + 1} de diciembre${lockLabel}`);
    drawCardImage(card, cardImages[index + 1]);
  });
}

function drawCardImage(card, path) {
  if (card.path === path) return;
  card.path = path;
  card.image?.remove();
  card.image = undefined;
  card.face.classList.remove('has-image');
  if (!path) return;

  const image = node('img', '', 'door-image');
  card.image = image;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.onload = () => {
    if (card.image === image) card.face.classList.add('has-image');
  };
  image.onerror = () => {
    if (card.image !== image) return;
    card.face.classList.remove('has-image');
    image.remove();
    card.image = undefined;
    card.path = undefined;
  };
  card.face.prepend(image);
  image.src = cardStorage.getPublicUrl(path).data.publicUrl;
}

async function refreshCards() {
  const version = ++cardRefreshVersion;
  try {
    const { data, error } = await db.from('calendar_cards').select('day,card_image');
    if (error || version !== cardRefreshVersion) return;
    cardImages = Object.fromEntries(data.map(({ day, card_image }) => [day, card_image]));
    drawDoors();
  } catch {
    // Keep the calendar usable with its current card artwork.
  }
}

function updateClock() {
  const parts = Object.fromEntries(colombiaClock.formatToParts(new Date()).map(({ type, value }) => [type, Number(value)]));
  // Compare Colombia wall-clock times on a common timeline, independent of the browser's timezone.
  const now = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const firstDay = Date.UTC(YEAR, 11, 1);
  const dayLength = 86400000;
  const count = Math.max(0, Math.min(24, Math.floor((now - firstDay) / dayLength) + 1));
  const changed = count !== openedDays;
  openedDays = count;
  if (changed && view?.previewBadge) view.previewBadge.hidden = view.day <= count;

  $('progress').value = count;
  $('progress-label').textContent = `${count} de 24 días abiertos`;
  const countdown = $('countdown');
  if (count === 24) {
    $('countdown-label').textContent = 'Calendario completo';
    countdown.hidden = true;
  } else {
    $('countdown-label').textContent = `Próxima apertura · ${count + 1} de diciembre`;
    countdown.hidden = false;
    const seconds = (firstDay + count * dayLength - now) / 1000;
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds / 3600) % 24;
    const minutes = Math.floor(seconds / 60) % 60;
    const remainder = seconds % 60;
    const pad = (number) => String(number).padStart(2, '0');
    countdown.dateTime = `P${days}DT${hours}H${minutes}M${remainder}S`;
    countdown.textContent = `${days ? days + ' d · ' : ''}${pad(hours)}:${pad(minutes)}:${pad(remainder)}`;
  }
  return changed;
}

function endView() {
  const previous = view;
  view = undefined;
  if (photoModal.open) photoModal.close();
  fullPhoto.removeAttribute('src');
  previous?.dispose?.();
  detail.replaceChildren();
  editPanel.replaceChildren();
}

function closeMemory() {
  resetHero();
  if (modal.open) modal.close();
  endView();
  const door = activeCard?.door;
  activeCard = undefined;
  door?.classList.remove('memory-source');
  if (door?.isConnected && !door.disabled) door.focus({ preventScroll: true });
}

function setMemoryControlsDisabled(disabled) {
  closeButton.disabled = disabled;
  tabs.preview.disabled = disabled;
  tabs.edit.disabled = disabled;
}

function setTabStop(mode) {
  for (const [name, tab] of Object.entries(tabs)) tab.tabIndex = name === mode ? 0 : -1;
}

function showMemoryTab(day, mode) {
  if (modal.open) resetHero();
  endView();
  const current = { day, mode };
  view = current;
  $('memory-heading').textContent = `${day} de diciembre`;
  tabList.hidden = !editor;
  detail.hidden = mode !== 'preview';
  editPanel.hidden = mode !== 'edit';

  if (editor) {
    detail.setAttribute('role', 'tabpanel');
    detail.setAttribute('aria-labelledby', tabs.preview.id);
    detail.tabIndex = 0;
  } else {
    detail.removeAttribute('role');
    detail.removeAttribute('aria-labelledby');
    detail.removeAttribute('tabindex');
  }
  for (const [name, tab] of Object.entries(tabs)) {
    tab.setAttribute('aria-selected', String(editor && name === mode));
  }
  setTabStop(mode);
  setMemoryControlsDisabled(false);
  if (!modal.open) modal.showModal();
  modal.scrollTop = 0;
  if (editor) tabs[mode].focus();
  if (mode === 'edit') renderEditor(current);
  else renderMemory(current);
}

function canLeaveMemory() {
  return !view?.saving && (
    !view?.hasChanges?.() || window.confirm('Hay cambios sin guardar. ¿Quieres descartarlos?')
  );
}

function resetAccount(id) {
  accountId = id;
  refreshVersion++;
  editor = false;
  banner.setEditor(false);
  records = {};
  closeMemory();
  drawDoors();
}

async function refresh() {
  let version = ++refreshVersion;
  try {
    const { data: { session }, error: sessionError } = await db.auth.getSession();
    if (version !== refreshVersion) return;
    if (sessionError) throw sessionError;
    const id = session?.user.id ?? null;
    if (id !== accountId) {
      resetAccount(id);
      version = refreshVersion;
    }
    $('login').hidden = !!session;
    $('logout').hidden = !session;

    let canEdit = false;
    if (session) {
      const { data, error } = await db.from('editors').select('id').eq('id', id).maybeSingle();
      if (version !== refreshVersion) return;
      if (error) throw error;
      canEdit = !!data;
    }

    if (editor && !canEdit) {
      closeMemory();
      editor = false;
      banner.setEditor(false);
      records = {};
      drawDoors();
    }

    let query = db.from('memories').select('*');
    if (!canEdit) query = query.lte('day', openedDays);
    const { data, error } = await query;
    if (version !== refreshVersion) return;
    if (error) throw error;
    editor = canEdit;
    banner.setEditor(editor);
    records = Object.fromEntries(data.map((record) => [record.day, record]));
    drawDoors();
    $('status').textContent = session && !editor ? 'Esta cuenta no tiene permiso de edición.' : '';
  } catch {
    if (version === refreshVersion) $('status').textContent = 'No se pudieron cargar los recuerdos. Inténtalo de nuevo en un momento.';
  }
}

function openDay(day) {
  if (modal.open || $('auth').open || (!editor && day > openedDays)) return;
  activeCard = dayCards[day - 1];
  const source = heroEnabled() ? visibleCardRect(activeCard.door) : null;
  if (source) modal.classList.add('memory-entering');

  // Keep the dialog and player setup inside the original activation.
  showMemoryTab(day, editor && !records[day] ? 'edit' : 'preview');
  if (source) {
    activeCard.door.classList.add('memory-source');
    animateMemory(source);
  }
}

function heroEnabled() {
  return !reducedMotion.matches && typeof modal.animate === 'function';
}

function visibleCardRect(door) {
  if (!door?.isConnected || getComputedStyle(door).visibility !== 'visible') return null;
  const bounds = door.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const right = left + (viewport?.width ?? document.documentElement.clientWidth);
  const bottom = top + (viewport?.height ?? document.documentElement.clientHeight);
  if (!bounds.width || !bounds.height || bounds.right <= left || bounds.bottom <= top ||
      bounds.left >= right || bounds.top >= bottom) return null;
  return bounds;
}

function heroTransform(rect, destination) {
  const x = rect.left - destination.left;
  const y = rect.top - destination.top;
  return `translate(${x}px, ${y}px) scale(${rect.width / destination.width}, ${rect.height / destination.height})`;
}

function heroArtwork(cardRect) {
  const art = node('div', '', 'memory-art');
  art.setAttribute('aria-hidden', 'true');
  art.classList.toggle('locked', activeCard.door.classList.contains('locked'));
  art.style.setProperty('--door-color', getComputedStyle(activeCard.door).getPropertyValue('--door-color'));
  art.style.width = `${cardRect.width}px`;
  art.style.height = `${cardRect.height}px`;
  art.style.top = `${modal.scrollTop}px`;
  art.style.left = `${modal.scrollLeft}px`;
  // The inverse dialog transform restores the artwork to the card's proportions.
  art.style.transform = `scale(${modal.clientWidth / cardRect.width}, ${modal.clientHeight / cardRect.height})`;

  const face = activeCard.face.cloneNode(true);
  const image = face.querySelector('img');
  if (image) {
    image.loading = 'eager';
    image.decoding = 'sync';
  }
  art.append(face);
  modal.append(art);
  return art;
}

function animateMemory(cardRect, closingFrom) {
  const closing = Boolean(closingFrom);
  const duration = closing ? 350 : 450;
  modal.classList.add('memory-transition');
  const destination = modal.getBoundingClientRect();
  const expanded = {
    transform: 'translate(0px, 0px) scale(1, 1)',
    borderRadius: getComputedStyle(modal).borderRadius,
    opacity: 1,
  };
  let cardFrame;
  let art;
  if (cardRect) {
    const radius = parseFloat(getComputedStyle(activeCard.door).borderTopLeftRadius);
    const radiusX = radius * destination.width / cardRect.width;
    const radiusY = radius * destination.height / cardRect.height;
    cardFrame = {
      transform: heroTransform(cardRect, destination),
      borderRadius: `${radiusX}px / ${radiusY}px`,
      opacity: 1,
    };
    art = heroArtwork(cardRect);
  }

  const first = closing ? {
    transform: heroTransform(closingFrom.rect, destination),
    borderRadius: closingFrom.radius,
    opacity: 1,
  } : cardFrame;
  const last = closing ? (cardFrame ?? { ...first, opacity: 0 }) : expanded;
  const timing = { duration, easing: heroEasing, fill: 'both' };
  const animations = [
    modal.animate([first, last], timing),
    memoryContent.animate(closing
      ? [{ opacity: closingFrom.contentOpacity }, { opacity: 0, offset: .48 }, { opacity: 0 }]
      : [{ opacity: 0 }, { opacity: 0, offset: .26 }, { opacity: 1 }], timing),
  ];
  if (art) {
    animations.push(art.animate(closing
      ? [{ opacity: closingFrom.artOpacity }, { opacity: 1, offset: .84 }, { opacity: 1 }]
      : [{ opacity: 1 }, { opacity: 1, offset: .12 }, { opacity: 0 }], timing));
  }

  const transition = { closing, art, animations };
  hero = transition;
  if (closing) {
    memoryContent.inert = true;
    modal.classList.add('memory-closing');
  } else {
    // Resolve the backdrop's starting opacity before changing its class.
    getComputedStyle(modal, '::backdrop').getPropertyValue('opacity');
    modal.classList.remove('memory-entering');
  }
  animations[0].finished.then(() => {
    if (hero === transition) settleHero();
  }, () => {});
}

function resetHero() {
  const previous = hero;
  hero = undefined;
  previous?.animations.forEach((animation) => animation.cancel());
  previous?.art?.remove();
  modal.classList.remove('memory-transition', 'memory-entering', 'memory-closing');
  memoryContent.inert = false;
}

function settleHero() {
  if (hero?.closing) closeMemory();
  else if (hero) resetHero();
}

function dismissMemory() {
  if (!modal.open || hero?.closing || !canLeaveMemory()) return;
  if (!heroEnabled()) {
    closeMemory();
    return;
  }

  const from = {
    rect: modal.getBoundingClientRect(),
    radius: getComputedStyle(modal).borderRadius,
    contentOpacity: Number(getComputedStyle(memoryContent).opacity),
    artOpacity: hero?.art ? Number(getComputedStyle(hero.art).opacity) : 0,
  };
  resetHero();
  const source = visibleCardRect(activeCard?.door);
  if (source) activeCard.door.classList.add('memory-source');
  view?.stopSong?.(true);
  animateMemory(source, from);
}

function renderMemory(current) {
  const { day } = current;
  const editorPreview = editor && day > openedDays;
  const previewUrls = editorPreview ? new Set() : null;
  current.dispose = () => {
    current.stopSong?.();
    if (previewUrls) {
      for (const url of previewUrls) URL.revokeObjectURL(url);
    }
  };

  if (editor) {
    current.previewBadge = node('p', 'Vista previa', 'preview-badge');
    current.previewBadge.hidden = !editorPreview;
    detail.append(current.previewBadge);
  }
  const memory = records[day];
  detail.append(
    node('h3', memory?.title || 'Un recuerdo por escribir', 'memory-title'),
    node('p', memory?.description || 'Todavía no hay eventos registrados.', 'description'),
  );
  const photos = memoryPhotos(memory);
  if (photos.length) detail.append(createGallery(photos, memory.title, previewUrls));

  if (memory?.music_url) {
    let song;
    try {
      song = parseSong(memory.music_url);
    } catch {
      // An invalid stored link cannot be embedded.
    }
    if (song) {
      const music = node('section', '', 'music');
      music.append(node('h3', 'Canción del recuerdo'));
      detail.append(music);
      let stopSong = mountSong(music, song, true, () => Number(getComputedStyle(memoryContent).opacity) >= 0.5);
      current.stopSong = (preserveLayout = false) => {
        if (!stopSong) return;
        const frame = preserveLayout && music.querySelector('iframe:not([hidden])');
        if (frame) {
          const placeholder = node('div', '', 'music-frame-placeholder');
          placeholder.style.height = `${frame.offsetHeight}px`;
          frame.before(placeholder);
        }
        stopSong();
        stopSong = undefined;
      };
    }
  }
}

function createGallery(photos, title, previewUrls) {
  const gallery = node('section', '', 'gallery');
  gallery.setAttribute('aria-label', 'Fotografías del recuerdo');
  const stage = node('div', '', 'gallery-stage');
  const image = node('img');
  image.draggable = false;
  const message = node('p');
  message.setAttribute('role', 'status');
  stage.append(image, message);
  const bar = node('div', '', 'gallery-bar');
  const position = node('span');
  position.setAttribute('aria-live', 'polite');
  const prev = button('‹', () => step(-1), 'gallery-arrow');
  prev.setAttribute('aria-label', 'Foto anterior');
  const next = button('›', () => step(1), 'gallery-arrow');
  next.setAttribute('aria-label', 'Foto siguiente');
  const expand = button('Pantalla completa', () => {
    fullPhoto.alt = image.alt;
    fullPhoto.src = image.src;
    photoModal.showModal();
    $('photo-screen').requestFullscreen?.().catch(() => {});
  }, 'small-button');
  const navigation = node('div', '', 'gallery-navigation');
  if (photos.length > 1) navigation.append(prev, position, next);
  bar.append(navigation, expand);
  gallery.append(stage, bar);

  const cache = new Map();
  const current = view;
  let index = 0;
  let renderVersion = 0;

  function step(direction) {
    index = (index + direction + photos.length) % photos.length;
    render();
  }

  function error() {
    image.hidden = true;
    expand.disabled = true;
    message.hidden = false;
    message.textContent = 'No se pudo cargar esta foto.';
  }

  async function render() {
    const version = ++renderVersion;
    const path = photos[index];
    const isCurrent = () => view === current && version === renderVersion;
    position.textContent = `${index + 1} de ${photos.length}`;
    image.hidden = true;
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
    expand.disabled = true;
    message.hidden = false;
    message.textContent = 'Cargando foto…';

    try {
      let entry = cache.get(path);
      if (!entry || entry.expires <= Date.now()) {
        if (previewUrls) {
          // Future editor previews use authenticated downloads.
          const { data, error: storageError } = await storage.download(path);
          if (!isCurrent()) return;
          if (storageError || !data) throw Error();
          const url = URL.createObjectURL(data);
          previewUrls.add(url);
          entry = { url, expires: Infinity };
        } else {
          const { data, error: storageError } = await storage.createSignedUrl(path, 120);
          if (storageError || !data?.signedUrl) throw Error();
          entry = { url: data.signedUrl, expires: Date.now() + 100000 };
        }
        cache.set(path, entry);
      }
      if (!isCurrent()) return;
      image.alt = `Foto ${index + 1} de ${photos.length}${title ? ' · ' + title : ''}`;
      image.onload = () => {
        if (!isCurrent()) return;
        message.hidden = true;
        image.hidden = false;
        expand.disabled = false;
      };
      image.onerror = () => {
        if (!isCurrent()) return;
        cache.delete(path);
        if (previewUrls?.delete(entry.url)) URL.revokeObjectURL(entry.url);
        error();
      };
      image.src = entry.url;
    } catch {
      if (isCurrent()) error();
    }
  }

  if (photos.length > 1) {
    let start;
    stage.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch') start = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    stage.addEventListener('pointercancel', () => { start = undefined; });
    stage.addEventListener('pointerup', (event) => {
      if (start?.id !== event.pointerId) return;
      const x = event.clientX - start.x;
      const y = event.clientY - start.y;
      start = undefined;
      if (Math.abs(x) >= 40 && Math.abs(x) > Math.abs(y) * 1.4) step(x < 0 ? 1 : -1);
    });
    gallery.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? -1 : 1);
    });
  }

  render();
  return gallery;
}

function removeUnusedCardImage(path) {
  if (path) cardStorage.remove([path]).catch(() => {});
}

function createCardEditor(current, saveOnly) {
  const { day } = current;
  let savedPath = cardImages[day] ?? null;
  let file;
  let localPreview;
  let uploadedPath;
  let removed = false;
  let committing = false;
  const hasChanges = () => Boolean(file || removed);

  const section = node('section', '', 'card-editor');
  const heading = node('h3', 'Imagen de la casilla (opcional)');
  heading.id = 'card-editor-heading';
  section.setAttribute('aria-labelledby', heading.id);
  const help = node('p', 'Personaliza la casilla con una imagen decorativa independiente de las fotos del recuerdo.');
  const warning = node('p', 'La imagen será pública antes de que se abra la casilla. Elige una imagen que no revele el recuerdo.', 'card-warning');
  const preview = node('img', '', 'card-preview');
  preview.alt = 'Vista previa de la imagen de la casilla';
  const picker = node('input');
  picker.type = 'file';
  picker.accept = Object.keys(PHOTO_TYPES).join(',');
  const label = node('label', 'Elegir imagen JPG, PNG o WebP');
  label.append(picker);
  const status = node('p', '', 'form-status');
  status.setAttribute('role', 'status');
  const actions = node('div', '', 'form-actions');
  const replace = button('Reemplazar imagen', () => picker.click(), 'small-button');
  const remove = button('Quitar imagen', () => {
    discardDraft();
    removed = Boolean(savedPath);
    status.textContent = '';
    render();
    picker.focus();
  }, 'small-button');
  const save = button('Guardar imagen de la casilla', () => saveOnly(status));
  actions.append(replace, remove, save);
  section.append(heading, help, warning, preview, label, actions, status);

  function discardDraft() {
    if (localPreview) URL.revokeObjectURL(localPreview);
    if (!committing) removeUnusedCardImage(uploadedPath);
    localPreview = undefined;
    uploadedPath = undefined;
    file = undefined;
  }

  function render() {
    const currentPath = removed ? null : savedPath;
    const src = localPreview || (currentPath && cardStorage.getPublicUrl(currentPath).data.publicUrl);
    preview.hidden = !src;
    if (src) preview.src = src;
    else preview.removeAttribute('src');
    replace.hidden = !src;
    remove.hidden = !src;
    save.disabled = !hasChanges();
  }

  preview.onerror = () => {
    preview.hidden = true;
    status.textContent = 'No se pudo mostrar la imagen. Puedes elegir otra.';
  };
  picker.onchange = () => {
    const selected = picker.files[0];
    picker.value = '';
    if (!selected) return;
    if (!Object.hasOwn(PHOTO_TYPES, selected.type)) {
      status.textContent = 'Selecciona una imagen JPG, PNG o WebP.';
      return;
    }
    discardDraft();
    removed = false;
    file = selected;
    localPreview = URL.createObjectURL(file);
    status.textContent = '';
    render();
  };

  async function saveChanges(message, memory = null) {
    if (file && !uploadedPath) {
      message.textContent = 'Comprimiendo la imagen de la casilla…';
      let blob;
      try {
        blob = await compressPhoto(file, localPreview, 600);
      } catch {
        throw new Error('No se pudo comprimir la imagen de la casilla. Elige una imagen válida que quede por debajo de 5 MB.');
      }
      if (view !== current) return false;

      const path = `${day}/${crypto.randomUUID()}.${PHOTO_TYPES[blob.type]}`;
      message.textContent = 'Subiendo la imagen de la casilla…';
      const { error } = await cardStorage.upload(path, blob, { contentType: blob.type, cacheControl: '300' });
      if (error) throw new Error('No se pudo subir la imagen de la casilla. Vuelve a guardar para reintentar.');
      if (view !== current) {
        removeUnusedCardImage(path);
        return false;
      }
      uploadedPath = path;
    }

    const path = uploadedPath ?? null;
    message.textContent = memory ? 'Guardando el recuerdo y la imagen…' : 'Guardando la imagen de la casilla…';
    committing = true;
    try {
      const { data: previousPath, error } = await db.rpc('save_calendar_day', {
        p_day: day,
        p_card_image: path,
        p_memory: memory,
      });
      if (error) {
        const target = memory ? 'el recuerdo y la imagen' : 'la imagen de la casilla';
        throw new Error(`No se pudo guardar ${target}. Comprueba tu conexión y permiso de edición.`);
      }
      if (previousPath !== path) removeUnusedCardImage(previousPath);

      if (view !== current) {
        refreshCards();
        return false;
      }
      savedPath = path;
      uploadedPath = undefined;
      removed = false;
      discardDraft();
      cardRefreshVersion++;
      cardImages[day] = path;
      drawDoors();
      render();
      return true;
    } catch (error) {
      if (view !== current) removeUnusedCardImage(path);
      throw error;
    } finally {
      committing = false;
    }
  }

  render();
  return { section, hasChanges, saveChanges, dispose: discardDraft };
}

function renderEditor(current) {
  const { day } = current;
  const memory = records[day];
  const savedItems = memoryPhotos(memory).map((path) => ({ path }));
  const items = [...savedItems];
  const objectUrls = new Set();
  const card = createCardEditor(current, saveCardOnly);
  current.dispose = () => {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    card.dispose();
  };

  const form = node('form');
  const fields = node('fieldset');
  const title = node('input');
  title.required = true;
  title.value = memory?.title ?? '';
  const description = node('textarea');
  description.rows = 5;
  description.value = memory?.description ?? '';
  const song = node('input');
  song.inputMode = 'url';
  song.value = memory?.music_url ?? '';
  song.oninput = () => song.setCustomValidity('');
  current.hasChanges = () => (
    title.value !== (memory?.title ?? '') ||
    description.value !== (memory?.description ?? '') ||
    song.value !== (memory?.music_url ?? '') ||
    items.length !== savedItems.length ||
    items.some((item, index) => item !== savedItems[index]) ||
    card.hasChanges()
  );
  const file = node('input');
  file.type = 'file';
  file.multiple = true;
  file.accept = Object.keys(PHOTO_TYPES).join(',');
  const list = node('ol', '', 'photo-list');
  const photoHint = node('p', '', 'photo-hint');
  photoHint.id = 'photo-hint';
  file.setAttribute('aria-describedby', photoHint.id);
  const status = node('p', '', 'form-status');
  status.setAttribute('role', 'status');
  const progress = node('progress');
  progress.setAttribute('aria-label', 'Fotos subidas');
  progress.hidden = true;
  const save = node('button', 'Guardar recuerdo');
  save.type = 'submit';
  for (const [name, input] of [
    ['Título', title],
    ['Eventos', description],
    ['Enlace de la canción (opcional)', song],
    ['Añadir fotografías', file],
  ]) {
    const label = node('label', name);
    label.append(input);
    fields.append(label);
  }
  fields.append(photoHint, list, card.section, save);
  form.append(fields, progress, status);
  editPanel.append(form);

  function setSaving(saving) {
    current.saving = saving;
    fields.disabled = saving;
    if (view === current) setMemoryControlsDisabled(saving);
  }

  async function saveCardOnly(cardStatus) {
    if (!editor || current.saving || view !== current || !card.hasChanges()) return;
    setSaving(true);
    try {
      if (await card.saveChanges(cardStatus)) cardStatus.textContent = 'Imagen de la casilla actualizada.';
    } catch (error) {
      cardStatus.textContent = error instanceof Error ? error.message : 'No se pudo guardar la imagen de la casilla.';
    } finally {
      setSaving(false);
    }
  }

  function localUrl(blob) {
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    return url;
  }

  async function preview(item) {
    const { data, error } = await storage.download(item.path);
    if (error || !data || view !== current || !items.includes(item)) return null;
    item.url = localUrl(data);
    return item.url;
  }

  function renderList(focusIndex, focusAction) {
    photoHint.textContent = `${items.length} de ${MAX_PHOTOS} fotos. La primera es la portada. Formatos JPG, PNG y WebP.`;
    list.replaceChildren();
    items.forEach((item, index) => {
      const row = node('li');
      const thumbnail = node('img');
      thumbnail.alt = '';
      thumbnail.hidden = true;
      const caption = node('span', index === 0 ? 'Portada' : `Foto ${index + 1}`);
      const controls = node('div', '', 'photo-actions');
      const move = (direction) => {
        const other = index + direction;
        [items[index], items[other]] = [items[other], items[index]];
        renderList(other, direction < 0 ? 0 : 1);
      };
      const up = button('↑', () => move(-1), 'small-button');
      const down = button('↓', () => move(1), 'small-button');
      const remove = button('Quitar', () => {
        items.splice(index, 1);
        if (item.url) {
          URL.revokeObjectURL(item.url);
          objectUrls.delete(item.url);
        }
        renderList(Math.min(index, items.length - 1), 2);
        if (!items.length) file.focus();
      }, 'small-button');
      up.disabled = index === 0;
      down.disabled = index === items.length - 1;
      up.setAttribute('aria-label', `Subir foto ${index + 1}`);
      down.setAttribute('aria-label', `Bajar foto ${index + 1}`);
      remove.setAttribute('aria-label', `Quitar foto ${index + 1}`);
      controls.append(up, down, remove);
      row.append(thumbnail, caption, controls);
      list.append(row);
      if (index === focusIndex) {
        const actions = [up, down, remove];
        (actions[focusAction].disabled ? actions.find((action) => !action.disabled) : actions[focusAction]).focus();
      }
      item.preview ??= item.url ? Promise.resolve(item.url) : preview(item).catch(() => null);
      const failed = () => {
        if (row.isConnected) {
          thumbnail.hidden = true;
          caption.append(node('small', 'Sin vista previa'));
        }
      };
      thumbnail.onerror = failed;
      item.preview.then((url) => {
        if (!row.isConnected) return;
        if (!url) {
          failed();
          return;
        }
        thumbnail.src = url;
        thumbnail.hidden = false;
      });
    });
  }

  file.onchange = () => {
    const selected = Array.from(file.files);
    file.value = '';
    if (selected.length + items.length > MAX_PHOTOS) {
      status.textContent = `Puedes añadir hasta ${MAX_PHOTOS - items.length} fotos más.`;
      return;
    }
    if (selected.some((photo) => !Object.hasOwn(PHOTO_TYPES, photo.type))) {
      status.textContent = 'Selecciona únicamente fotos JPG, PNG o WebP.';
      return;
    }
    status.textContent = '';
    items.push(...selected.map((photo) => ({ file: photo, url: localUrl(photo) })));
    renderList();
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!editor || current.saving || view !== current) return;

    let musicUrl;
    try {
      musicUrl = parseSong(song.value)?.url ?? null;
    } catch (error) {
      song.setCustomValidity(error.message);
      song.reportValidity();
      status.textContent = error.message;
      return;
    }

    setSaving(true);
    const pending = items.filter((item) => !item.path);
    progress.hidden = pending.length === 0;
    progress.max = Math.max(1, pending.length);
    progress.value = 0;
    try {
      for (const [index, item] of pending.entries()) {
        const position = `${index + 1} de ${pending.length}`;
        status.textContent = `Comprimiendo foto ${position}…`;
        let blob;
        try {
          blob = await compressPhoto(item.file, item.url);
        } catch {
          throw new Error(`No se pudo comprimir la foto «${item.file.name}». Usa una foto válida que quede por debajo de 5 MB.`);
        }
        if (view !== current) return;
        const path = `${day}/${crypto.randomUUID()}.${PHOTO_TYPES[blob.type]}`;
        status.textContent = `Subiendo foto ${position}…`;
        const { error } = await storage.upload(path, blob, { contentType: blob.type });
        if (error) throw new Error(`No se pudo subir la foto «${item.file.name}». Vuelve a guardar para reintentar.`);
        item.path = path;
        progress.value = index + 1;
        if (view !== current) return;
      }

      status.textContent = 'Guardando el recuerdo…';
      const payload = {
        day,
        title: title.value,
        description: description.value,
        photos: items.map((item) => item.path),
        music_url: musicUrl,
      };
      if (card.hasChanges()) {
        if (!await card.saveChanges(status, payload)) return;
      } else {
        const { error } = await db.from('memories').upsert(payload);
        if (error) throw new Error('No se pudo guardar el recuerdo. Comprueba tu conexión y permiso de edición.');
      }
      if (view !== current) return;
      refreshVersion++;
      records[day] = payload;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'No se pudo guardar el recuerdo.';
      return;
    } finally {
      setSaving(false);
      progress.hidden = true;
    }
    showMemoryTab(day, 'preview');
  };

  renderList();
}

for (const [mode, tab] of Object.entries(tabs)) {
  tab.onclick = () => {
    if (!editor || !view || hero?.closing || view.mode === mode) return;
    if (canLeaveMemory()) {
      showMemoryTab(view.day, mode);
    } else {
      setTabStop(view.mode);
      tabs[view.mode].focus();
    }
  };
}

tabList.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const mode = event.key === 'Home' || (event.key !== 'End' && event.target === tabs.edit) ? 'preview' : 'edit';
  setTabStop(mode);
  tabs[mode].focus();
});

tabList.addEventListener('focusout', (event) => {
  if (view && !tabList.contains(event.relatedTarget)) setTabStop(view.mode);
});

closeButton.onclick = dismissMemory;
modal.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeButton.click();
});
modal.addEventListener('close', () => {
  if (!modal.open && (view || activeCard)) closeMemory();
});
window.addEventListener('resize', settleHero);
window.addEventListener('scroll', settleHero, { passive: true });
window.visualViewport?.addEventListener('resize', settleHero);
window.visualViewport?.addEventListener('scroll', settleHero);
reducedMotion.addEventListener('change', settleHero);
$('close-photo').onclick = () => photoModal.close();
photoModal.addEventListener('close', () => {
  if (photoModal.open) return;
  if (document.fullscreenElement === $('photo-screen')) document.exitFullscreen().catch(() => {});
  fullPhoto.removeAttribute('src');
});
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement === $('photo-screen')) {
    $('photo-screen').dataset.fullscreen = 'true';
  } else if ($('photo-screen').dataset.fullscreen) {
    delete $('photo-screen').dataset.fullscreen;
    if (photoModal.open) photoModal.close();
  }
});

$('login').onclick = () => {
  $('authError').textContent = '';
  $('auth').showModal();
};
$('cancel').onclick = () => $('auth').close();
$('logout').onclick = async () => {
  const { error } = await db.auth.signOut();
  if (error) $('status').textContent = 'No se pudo cerrar la sesión. Inténtalo de nuevo.';
};
$('authForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button');
  const data = new FormData(form);
  submit.disabled = true;
  $('authError').textContent = '';
  try {
    const { error } = await db.auth.signInWithPassword({ email: data.get('email'), password: data.get('password') });
    if (error) throw error;
    $('auth').close();
    form.reset();
  } catch {
    $('authError').textContent = 'No se pudo iniciar sesión. Revisa el correo y la contraseña.';
  } finally {
    submit.disabled = false;
  }
};

db.auth.onAuthStateChange((event, session) => {
  const id = session?.user.id ?? null;
  if (event !== 'INITIAL_SESSION' && id !== accountId) resetAccount(id);
  setTimeout(refresh, 0);
});

updateClock();
drawDoors();
refresh();
refreshCards();
banner.refresh();
ambient.refresh();
setInterval(() => {
  if (updateClock()) {
    drawDoors();
    refresh();
  }
}, 1000);
setInterval(() => {
  refresh();
  refreshCards();
  banner.refresh();
  ambient.refresh();
}, 60000);
