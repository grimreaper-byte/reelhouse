// Settings → Languages: the sound track and the subtitles films and episodes start with, for everyone, in the web
// app, the Android app and Kodi (the server sends them as defaults.audio and defaults.subtitles).
import { h, languageName } from '../../dom.js';
import { panel, selectField, saveButton, loadSettings } from './form.js';

const MODES = {
  off: 'Off, forced ones too: turned on in the player when wanted',
  forced: 'Only a file’s forced subtitles (the parts in another language)',
  foreign: 'In the preferred language when the sound is in another language',
  always: 'Always in the preferred language',
};

export async function languagesTab(ctx) {
  const { settings: s, options } = await loadSettings(ctx.signal);
  const ids = options.languages || [];
  const named = ids.map((id) => ({ id, label: languageName(id) || id }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const metadataOwn = ids.find((id) => id === String(s.metadataLanguage || '').toLowerCase().split(/[-_]/)[0]) || 'en';

  const audio = selectField('Preferred audio language', [{ id: '', label: 'The file’s default track' }, ...named], s.audioLanguage || '', {
    hint: 'A film or episode with a sound track in this language plays that one; others play their default track. '
      + 'Someone can still pick another track in the player. A browser can only play a file’s default track, so a file '
      + 'whose default is in another language is converted for it, with the picture copied as it is (light work).',
  });
  const mode = selectField('When a film or episode starts', (options.subtitleModes || Object.keys(MODES))
    .map((id) => ({ id, label: MODES[id] || id })), s.subtitleMode || 'forced', {
    hint: 'Forced subtitles are those for the parts in another language, shown by themselves for the sound playing. '
      + 'With Off, nothing shows until someone turns subtitles on in the player.',
  });
  const subtitleLanguage = selectField('Preferred subtitle language', [
    { id: '', label: `Same as the metadata language (${languageName(metadataOwn) || metadataOwn})` },
    ...named,
  ], s.subtitleLanguage || '', {
    hint: 'Used by the choices above that turn subtitles on, when a file has subtitles in it (a full track before one '
      + 'for the deaf and hard of hearing), and first when someone turns subtitles on with C in the web player.',
  });

  return h('div',
    h('h2', 'Languages'),
    h('p.lead', 'The sound track and subtitles films and episodes start with, for everyone: in the web app, the Android app and Kodi. A choice made in the player carries on to the next episode. Live TV channels play as they come and start without subtitles.'),
    panel('Audio', null, audio.el,
      h('div.panel-actions', saveButton('Save', () => ({ audioLanguage: audio.value })))),
    panel('Subtitles', null, mode.el, subtitleLanguage.el,
      h('div.panel-actions', saveButton('Save', () => ({ subtitleMode: mode.value, subtitleLanguage: subtitleLanguage.value })))),
  );
}
