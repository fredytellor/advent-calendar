import { URL as projectUrl, KEY } from './config.js';
import { compressPhoto, PHOTO_TYPES } from './media.js';

const bucket = 'group-banner';

async function uploadPhoto(db, path, blob, onProgress) {
  const { data, error } = await db.auth.getSession();
  if (error || !data?.session) throw new Error('Vuelve a iniciar sesión para subir la foto.');

  // The Storage SDK uses fetch. Use its upload endpoint directly to show byte progress.
  const endpoint = new URL(`/storage/v1/object/${bucket}/${path}`, projectUrl);
  await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', endpoint.href);
    request.timeout = 90000;
    request.setRequestHeader('apikey', KEY);
    request.setRequestHeader('Authorization', `Bearer ${data.session.access_token}`);
    const body = new FormData();
    body.append('cacheControl', '300');
    body.append('', blob, path.split('/').at(-1));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total * 100);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
      } else if (request.status === 401 || request.status === 403) {
        reject(new Error('Se necesita una sesión de editor para subir la foto.'));
      } else if (request.status === 413) {
        reject(new Error('La foto supera el límite de 5 MB.'));
      } else {
        reject(new Error('No se pudo subir la foto del banner. Vuelve a intentarlo.'));
      }
    };
    request.onerror = () => reject(new Error('Se interrumpió la conexión al subir la foto.'));
    request.ontimeout = () => reject(new Error('La foto tardó demasiado en subir. Vuelve a intentarlo.'));
    request.send(body);
  });
}

export function createBanner(db) {
  const element = (id) => document.getElementById(id);
  const frame = element('group-banner-frame');
  const edit = element('edit-banner');
  const dialog = element('banner-dialog');
  const form = element('banner-form');
  const picker = element('banner-picker');
  const preview = element('banner-preview');
  const save = element('save-banner');
  const remove = element('remove-banner');
  const cancel = element('cancel-banner');
  const progress = element('banner-progress');
  const status = element('banner-status');
  const storage = db.storage.from(bucket);
  let editor = false;
  let saved;
  let draft;

  function updateBanner(row) {
    if (saved && row.revision < saved.revision) return;
    const previousPath = saved?.image_path;
    const previousImage = frame.querySelector('.banner-image');
    saved = row;
    if (previousPath === row.image_path && previousImage) return;
    previousImage?.remove();
    if (!row.image_path) return;

    const image = new Image();
    image.className = 'banner-image';
    image.alt = 'Fotografía de nuestro grupo de amigos';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.onload = () => image.classList.add('loaded');
    image.onerror = () => image.remove();
    frame.prepend(image);
    image.src = storage.getPublicUrl(row.image_path).data.publicUrl;
  }

  async function refresh() {
    try {
      const { data, error } = await db.from('group_banner').select('image_path,revision').eq('id', 1).single();
      if (error || !data) return false;
      updateBanner(data);
      return true;
    } catch {
      return false;
    }
  }

  function updateControls(current) {
    const blocked = current.loading || current.busy || !current.baseline || current.stale;
    picker.disabled = blocked;
    save.disabled = blocked || (!current.file && !current.removed);
    remove.hidden = !current.baseline?.image_path || current.removed;
    remove.disabled = blocked;
    cancel.disabled = Boolean(current.busy);
  }

  function showPreview(current) {
    const path = current.removed ? null : current.baseline?.image_path;
    const src = current.url || (path && storage.getPublicUrl(path).data.publicUrl);
    preview.classList.remove('loaded');
    preview.hidden = !src;
    if (!src) {
      preview.removeAttribute('src');
      return;
    }
    preview.onload = () => preview.classList.add('loaded');
    preview.onerror = () => {
      preview.classList.remove('loaded');
      if (draft === current && !current.busy) status.textContent = 'No se pudo mostrar la foto. Puedes seleccionar otra.';
    };
    preview.src = src;
  }

  function clearSelection(current) {
    if (current.url) URL.revokeObjectURL(current.url);
    current.url = undefined;
    current.file = undefined;
  }

  function closeEditor() {
    if (draft) clearSelection(draft);
    draft = undefined;
    preview.removeAttribute('src');
    preview.hidden = true;
    if (dialog.open) {
      dialog.close();
      if (editor) edit.focus({ preventScroll: true });
    }
  }

  function setEditor(allowed) {
    editor = allowed;
    edit.hidden = !allowed;
    if (!allowed && draft) closeEditor();
  }

  edit.onclick = async () => {
    if (!editor || dialog.open) return;
    const current = { baseline: saved, loading: true, removed: false, busy: false, stale: false };
    draft = current;
    picker.value = '';
    status.textContent = 'Cargando el banner…';
    progress.hidden = true;
    updateControls(current);
    showPreview(current);
    dialog.showModal();

    await refresh();
    if (draft !== current) return;
    current.baseline = saved;
    current.loading = false;
    updateControls(current);
    showPreview(current);
    status.textContent = saved ? '' : 'No se pudo cargar la configuración del banner. Vuelve a abrir el editor para reintentar.';
  };

  picker.onchange = () => {
    const file = picker.files[0];
    picker.value = '';
    if (!file || !draft) return;
    if (!Object.hasOwn(PHOTO_TYPES, file.type)) {
      status.textContent = 'Selecciona una imagen JPG, PNG o WebP.';
      return;
    }
    clearSelection(draft);
    draft.file = file;
    draft.url = URL.createObjectURL(file);
    draft.removed = false;
    status.textContent = '';
    showPreview(draft);
    updateControls(draft);
  };

  remove.onclick = () => {
    if (!draft?.baseline?.image_path || !window.confirm('¿Quitar la foto actual del banner al guardar?')) return;
    clearSelection(draft);
    draft.removed = true;
    status.textContent = 'La foto se quitará al guardar.';
    showPreview(draft);
    updateControls(draft);
    save.focus();
  };

  cancel.onclick = closeEditor;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!draft?.busy) closeEditor();
  });
  dialog.addEventListener('close', () => {
    if (!dialog.open && draft) closeEditor();
  });

  async function retireUpload(path) {
    try {
      const { data, error } = await db.rpc('retire_group_banner_upload', { p_image_path: path });
      if (!error && data === true) await storage.remove([path]);
    } catch {
      // Cleanup is best-effort when a session or connection expires.
    }
  }

  form.onsubmit = async (event) => {
    event.preventDefault();
    const current = draft;
    if (!editor || !current || save.disabled) return;
    current.busy = true;
    updateControls(current);
    progress.hidden = false;
    progress.removeAttribute('value');
    let stagedPath;
    try {
      if (current.file) {
        status.textContent = 'Comprimiendo la foto…';
        let blob;
        try {
          blob = await compressPhoto(current.file, current.url, 1920, 0.86);
        } catch {
          throw new Error('No se pudo preparar la foto. Elige una imagen válida que quede por debajo de 5 MB.');
        }
        if (draft !== current) return;
        stagedPath = `photo/${crypto.randomUUID()}.${PHOTO_TYPES[blob.type]}`;
        status.textContent = 'Subiendo la foto…';
        progress.value = 0;
        await uploadPhoto(db, stagedPath, blob, (value) => {
          if (draft === current) progress.value = value;
        });
        if (draft !== current) return;
      }

      status.textContent = 'Guardando el banner…';
      progress.removeAttribute('value');
      const { data, error } = await db.rpc('save_group_banner', {
        p_image_path: stagedPath ?? null,
        p_expected_revision: current.baseline.revision,
      });
      if (error?.code === '40001') {
        current.stale = true;
        throw new Error('Otra persona cambió el banner. Cierra y vuelve a abrir el editor para ver la versión actual.');
      }
      if (error || !data) throw new Error('No se pudo guardar el banner. Comprueba tu conexión y vuelve a intentarlo.');

      stagedPath = undefined;
      updateBanner(data);
      if (data.previous_path) storage.remove([data.previous_path]).catch(() => {});
      if (draft === current) closeEditor();
    } catch (error) {
      if (draft === current) status.textContent = error instanceof Error ? error.message : 'No se pudo guardar el banner.';
      refresh();
    } finally {
      if (stagedPath) retireUpload(stagedPath);
      if (draft === current) {
        current.busy = false;
        progress.hidden = true;
        updateControls(current);
      }
    }
  };

  return { refresh, setEditor };
}
