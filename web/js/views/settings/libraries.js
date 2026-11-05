import { h, icon, clear, setChildren, timeAgo, LIBRARY_ICONS, libraryIcon, typeIcon } from '../../dom.js';
import { api } from '../../api.js';
import { modal, toast, toastError, confirmDialog } from '../../components.js';
import { refreshLibraries } from '../../app.js';
import { render } from '../../router.js';
import { actionButton } from './form.js';

export async function librariesTab(ctx) {
  let { libraries } = await api.get('/api/libraries', { signal: ctx.signal });
  const scanBox = h('div');

  // The order here is the sidebar's and Home's: a library moves up or down one place, saved straight away.
  let moving = false;
  async function move(index, by) {
    if (moving) return;
    moving = true;
    const ids = libraries.map((l) => l.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    try {
      ({ libraries } = await api.put('/api/libraries/order', { ids }));
      renderList();
      // The keys carry on from the same library's button, wherever it went (or its other one, at an end).
      const moved = list.children[index + by]?.querySelectorAll('.order-btns button');
      [...(moved || [])].find((b) => !b.disabled && b.dataset.by === String(by))?.focus()
        ?? [...(moved || [])].find((b) => !b.disabled)?.focus();
      await refreshLibraries();
    } catch (err) {
      toastError(err);
    } finally {
      moving = false;
    }
  }

  const list = h('div.list');
  const renderList = () => setChildren(list, libraries.map((lib, i) => h('div.list-row',
    h('div.order-btns',
      h('button.btn.btn-ghost.btn-icon.btn-sm', {
        type: 'button', 'aria-label': `Move ${lib.name} up`, title: 'Move up', disabled: i === 0, dataset: { by: '-1' }, onClick: () => move(i, -1),
      }, icon('chevronUp', 18)),
      h('button.btn.btn-ghost.btn-icon.btn-sm', {
        type: 'button', 'aria-label': `Move ${lib.name} down`, title: 'Move down', disabled: i === libraries.length - 1, dataset: { by: '1' }, onClick: () => move(i, 1),
      }, icon('chevronDown', 18))),
    icon(libraryIcon(lib), 22),
    h('div.grow',
      h('div.title', lib.name),
      h('div.sub', `${lib.count} ${lib.type === 'movie' ? 'movies' : 'shows'} · scanned ${timeAgo(lib.scannedAt)}`),
      (lib.paths || []).map((p) => h('div.sub.mono', p)),
    ),
    actionButton('Scan', async () => {
      await api.post(`/api/libraries/${lib.id}/scan`);
      toast(`Scanning ${lib.name}`);
      pollScan();
    }, { icon: icon('refresh', 16) }),
    h('button.btn.btn-icon', { 'aria-label': `Edit ${lib.name}`, onClick: () => libraryEditor(lib) }, icon('edit', 18)),
    h('button.btn.btn-icon.btn-danger', {
      'aria-label': `Delete ${lib.name}`,
      onClick: async () => {
        const ok = await confirmDialog({
          title: `Remove “${lib.name}”?`,
          message: 'The library and its watch history are removed from Reelhouse. Your media files are not touched.',
          confirmLabel: 'Remove library',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.del(`/api/libraries/${lib.id}`);
          await refreshLibraries();
          render();
        } catch (err) {
          toastError(err);
        }
      },
    }, icon('trash', 18)),
  )));
  renderList();

  let pollTimer = null;
  async function pollScan() {
    clearTimeout(pollTimer);
    if (ctx.signal.aborted) return;
    try {
      const s = await api.get('/api/scan/status');
      clear(scanBox);
      if (s.running) {
        scanBox.append(h('div.callout', `${s.phase || 'Scanning'}: ${s.libraryName}${s.total ? ` — ${s.done} of ${s.total}` : ''}`,
          s.total ? h('div.bar', h('div', { style: { width: `${(s.done / s.total) * 100}%` } })) : null));
        pollTimer = setTimeout(pollScan, 1500);
      } else if (scanBox.dataset.wasRunning) {
        await refreshLibraries();
        render();
      }
      scanBox.dataset.wasRunning = s.running ? '1' : '';
    } catch {
      // ignore polling errors
    }
  }
  ctx.onCleanup(() => clearTimeout(pollTimer));
  pollScan();

  if (ctx.query.welcome && !libraries.length) setTimeout(() => libraryEditor(null), 50);

  return h('div',
    h('h2', 'Libraries'),
    h('p.lead', 'Point Reelhouse at the folders that hold your movies and TV shows. Their order here, set with the arrows, is the order in the sidebar and on Home.'),
    scanBox,
    ...sameNamedGroups(libraries).map(mergeNotice),
    h('section.panel',
      libraries.length ? list : h('p.hint', { style: { margin: 0 } }, 'No libraries yet.'),
      h('div.panel-actions', { style: { marginTop: '16px' } },
        h('button.btn.btn-primary', { onClick: () => libraryEditor(null) }, icon('plus', 18), 'Add library')),
    ),
    h('section.panel',
      h('h3', 'Naming tips'),
      h('p.desc', 'Reelhouse recognizes common naming schemes. For best results:'),
      h('ul.steps',
        h('li', 'Movies: ', h('code', 'Movies/Movie Title (2010)/Movie Title (2010).mkv')),
        h('li', 'TV: ', h('code', 'TV/Show Name (2019)/Season 01/Show Name - S01E01 - Episode.mkv')),
        h('li', 'Subtitles next to the video: ', h('code', 'Movie Title (2010).en.srt'), ' or ', h('code', '.en.forced.srt')),
        h('li', 'Force a match by adding ', h('code', '{tmdb-603}'), ' to a folder name.'),
      ),
    ),
  );
}

// Libraries with the same name and kind (e.g. two "Movies" on different drives), oldest first: they're meant to be one.
function sameNamedGroups(libraries) {
  const groups = new Map();
  for (const lib of [...libraries].sort((a, b) => a.id - b.id)) {
    const key = `${lib.type}:${lib.name.trim().toLocaleLowerCase()}`;
    groups.set(key, [...(groups.get(key) || []), lib]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

function mergeNotice([keep, ...others]) {
  const what = keep.type === 'movie' ? 'films' : 'shows';
  return h('div.callout',
    h('p', { style: { margin: '0 0 8px' } },
      `You have ${others.length + 1} libraries called “${keep.name}”. Merge them into one so their ${what} show up together`
      + `${keep.type === 'show' ? ' (a show whose folder is on more than one drive becomes one show)' : ''}. Watch history `
      + 'is kept, and anyone who can see one of them can see the merged library.'),
    actionButton(`Merge into one “${keep.name}”`, async () => {
      for (const lib of others) await api.post(`/api/libraries/${lib.id}/merge`, { into: keep.id });
      toast(`Merged into “${keep.name}” — scanning now`);
      await refreshLibraries();
      render();
    }, { icon: icon('check', 16) }));
}

export function libraryEditor(lib) {
  const name = h('input.input', { value: lib?.name || '', placeholder: 'e.g. Movies', id: 'lib-name' });
  let type = lib?.type || 'movie';
  let chosenIcon = lib ? libraryIcon(lib) : typeIcon(type);
  const paths = [...(lib?.paths || [])];
  const typeRow = h('div.btn-row', ['movie', 'show'].map((t) => h(`button.btn${t === type ? '.btn-primary' : ''}`, {
    type: 'button',
    disabled: !!lib,
    onClick: (e) => {
      // Still on the other type's icon: it follows.
      if (chosenIcon === typeIcon(type)) pickIcon(typeIcon(t));
      type = t;
      for (const b of typeRow.children) b.classList.toggle('btn-primary', b === e.currentTarget);
      if (!name.value || ['Movies', 'TV Shows'].includes(name.value)) name.value = t === 'movie' ? 'Movies' : 'TV Shows';
    },
  }, icon(typeIcon(t), 18), t === 'movie' ? 'Movies' : 'TV Shows')));
  // The icon the sidebar (and the apps) show for it: a row of buttons, one of them pressed, as a radio group.
  const iconRow = h('div.icon-picker', { role: 'radiogroup', 'aria-label': 'Icon' }, LIBRARY_ICONS.map(([n, label]) => h('button.icon-choice', {
    type: 'button', role: 'radio', title: label, 'aria-label': label, dataset: { icon: n }, onClick: () => pickIcon(n),
  }, icon(n, 24))));
  function pickIcon(n) {
    chosenIcon = n;
    for (const b of iconRow.children) {
      const on = b.dataset.icon === n;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  pickIcon(chosenIcon);
  iconRow.addEventListener('keydown', (e) => {
    const by = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!by) return;
    e.preventDefault();
    const names = LIBRARY_ICONS.map(([n]) => n);
    const next = names[(names.indexOf(chosenIcon) + by + names.length) % names.length];
    pickIcon(next);
    iconRow.querySelector(`[data-icon="${next}"]`).focus();
  });
  const pathsBox = h('div');
  const renderPaths = () => {
    pathsBox.replaceChildren(...paths.map((p, i) => h('div.path-chip', h('span', p),
      h('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Remove folder', onClick: () => { paths.splice(i, 1); renderPaths(); } }, icon('x', 16)))));
    if (!paths.length) pathsBox.append(h('p.hint', 'No folders added yet.'));
  };
  renderPaths();
  if (!lib) name.value = 'Movies';

  modal({
    title: lib ? `Edit ${lib.name}` : 'Add library',
    body: h('div',
      h('div.field', h('label.field-label', 'Type'), typeRow, lib && h('div.hint', 'The type can’t be changed after creation.')),
      h('div.field', h('label', { for: 'lib-name' }, 'Name'), name),
      h('div.field', h('label.field-label', 'Icon'), iconRow),
      h('div.field', h('label.field-label', 'Folders'), pathsBox,
        h('div', h('button.btn', { type: 'button', onClick: () => folderPicker((p) => { if (!paths.includes(p)) paths.push(p); renderPaths(); }) }, icon('folder', 18), 'Add folder')),
        h('div.hint', 'Films or shows on several drives? Add each drive’s folder here: they show up as one library, and a show with folders on two drives is one show.')),
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: lib ? 'Save' : 'Add library',
        primary: true,
        onClick: async () => {
          if (!paths.length) throw new Error('Add at least one folder');
          let joined = null;
          if (lib) await api.patch(`/api/libraries/${lib.id}`, { name: name.value, icon: chosenIcon, paths });
          else {
            const res = await api.post('/api/libraries', { name: name.value, type, icon: chosenIcon, paths });
            if (res.joined) joined = res.library.name;
          }
          // A library with that name already existed: the folders joined it rather than making a second one.
          toast(joined ? `Added to your “${joined}” library — scanning now` : lib ? 'Library saved' : 'Library added — scanning now');
          await refreshLibraries();
          render();
        },
      },
    ],
  });
}

export function folderPicker(onPick) {
  let current = '';
  const pathInput = h('input.input.mono', { placeholder: 'Type a path, e.g. D:\\Movies or \\\\NAS\\media', spellcheck: 'false' });
  const listEl = h('div.folder-list');
  const load = async (p) => {
    try {
      const r = await api.get(`/api/fs?path=${encodeURIComponent(p)}`);
      current = r.path;
      pathInput.value = r.path;
      setChildren(listEl,
        r.parent != null && r.path ? h('button', { type: 'button', onClick: () => load(r.parent) }, icon('arrowLeft', 18), '..') : null,
        ...r.entries.map((e) => h('button', { type: 'button', onClick: () => load(e.path) }, icon('folder', 18), e.name)),
      );
      if (!r.entries.length && r.path) listEl.append(h('div', { style: { padding: '12px', color: 'var(--text-faint)' } }, 'No subfolders'));
    } catch (err) {
      toastError(err);
    }
  };
  load('');
  modal({
    title: 'Choose a folder',
    body: h('div',
      h('form', { onSubmit: (e) => { e.preventDefault(); load(pathInput.value); } },
        h('div.input-row', { style: { marginBottom: '12px' } }, pathInput, h('button.btn', { type: 'submit' }, 'Go'))),
      listEl,
      h('p.hint', { style: { marginTop: '10px' } }, 'Network shares work too, as long as the account running Reelhouse can read them.'),
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Use this folder',
        primary: true,
        onClick: () => {
          const p = pathInput.value.trim() || current;
          if (!p) throw new Error('Pick a folder first');
          onPick(p);
        },
      },
    ],
  });
}
