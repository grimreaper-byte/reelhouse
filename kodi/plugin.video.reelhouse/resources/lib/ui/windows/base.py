# What every Reelhouse screen shares: the sidebar and top bar, opening a screen over the one before (Back closes it;
# Home stays, and the sidebar's Exit leaves), jumping to another place from the sidebar, cards as Kodi list items, a
# message when there's nothing to show, and re-reading what's shown when Reelhouse says something changed.
import os
import threading

import xbmc
import xbmcgui

from ... import utils
from ...api import ApiError
from .. import model

ADDON_PATH = utils.addon().getAddonInfo('path')
MEDIA = os.path.join(ADDON_PATH, 'resources', 'skins', 'Default', 'media', 'reelhouse')

SIDEBAR, SIDEBAR_END = 9000, 9002  # the sidebar's entries from its top, and those kept at its bottom
SIDEBARS = (SIDEBAR, SIDEBAR_END)
SIDEBAR_SHUT = '!Control.HasFocus({}) + !Control.HasFocus({})'.format(SIDEBAR, SIDEBAR_END)
SIDEBAR_TOP, SIDEBAR_FOOT, SIDEBAR_GAP, SIDEBAR_ROW = 132, 24, 16, 78  # where the lists go (sidebar.xml)
RETRY = 90

ACTION_MOVE_LEFT, ACTION_MOVE_RIGHT, ACTION_MOVE_UP, ACTION_MOVE_DOWN = 1, 2, 3, 4
ACTION_SELECT = 7
ACTION_PREVIOUS_MENU, ACTION_NAV_BACK = 10, 92
ACTION_SHOW_INFO = 11
ACTION_CONTEXT_MENU = 117
BACK = (ACTION_PREVIOUS_MENU, ACTION_NAV_BACK)


def icon(name):
    return os.path.join(MEDIA, 'icons', name + '.png')


def texture(name):
    return os.path.join(MEDIA, 'ui', name)


def set_resume(li, position, duration):
    """The progress bar on a card (ListItem.PercentPlayed)."""
    try:
        li.getVideoInfoTag().setResumePoint(float(position), float(duration))
    except AttributeError:  # Kodi 19
        li.setProperty('ResumeTime', str(position))
        li.setProperty('TotalTime', str(duration))


def initials(name):
    return ''.join(p[0] for p in (name or '').split()[:2]).upper()


class Screen(xbmcgui.WindowXML):
    XML = None
    ROOT = False      # Home: the sidebar's jumps start from it
    nav = None        # the sidebar entry lit while this screen shows
    has_page = False  # something has been read for it
    refresher = None  # the thread reading it again by itself (follow_changes)

    @classmethod
    def open(cls, app, **attrs):
        """Shows the screen over the current one until it's closed (Back, or a jump from the sidebar)."""
        window = cls(cls.XML, ADDON_PATH, 'Default', '1080i')
        window.app = app
        window.started = False
        window.closed = False
        window.content_focus = None
        window.last_focus = None
        window.nav_at_end = False   # the entry lit for this screen is in the bottom list (Live TV, Radio)
        window.nav_playing = False  # the sidebar has its Now playing entry
        window.window_id = None
        window.seen_change = app.change_mark()
        for key, value in attrs.items():
            setattr(window, key, value)
        try:
            window.doModal()
        finally:
            window.closed = True
            app.closed(window.window_id)
        del window

    def open_child(self, target):
        self.app.show(target)
        self.after_child()

    def after_child(self):
        """Back from a screen opened over this one: carry on to where the sidebar was asked to go."""
        if self.app.pending is None:
            return
        if not self.ROOT:
            self.close()
            return
        while self.app.pending is not None:
            target, self.app.pending = self.app.pending, None
            if target[0] == 'exit':
                self.close()
                return
            if target[0] != 'home':
                self.app.show(target)

    def back(self, focus):
        end = self.getControl(SIDEBAR_END)
        on_exit = focus == SIDEBAR_END and end.getSelectedPosition() == end.size() - 1  # Exit is last
        step = model.back_step(self.ROOT, focus in SIDEBARS, self.content_focus, on_exit)
        if step == 'page':
            self.setFocusId(self.page_focus())
        elif step == 'sidebar':
            self.setFocusId(SIDEBAR)
        elif step == 'exit':
            end.selectItem(end.size() - 1)
            self.setFocusId(SIDEBAR_END)
        elif step == 'close':
            self.close()

    # ---------- Kodi's calls ----------

    def onInit(self):
        if not self.started:
            self.window_id = xbmcgui.getCurrentWindowId()
            self.app.screens.append(self.window_id)
        self.app.showing(self.window_id)
        if not self.started:
            self.started = True
            self.fill_sidebar()
            self.fill_topbar()
            self.load()
            self.follow_changes()
        elif self.app.change_mark() != self.seen_change:
            self.seen_change = self.app.change_mark()
            self.refresh()
        self.follow_player()

    def onFocus(self, control_id):
        came_from, self.last_focus = self.last_focus, control_id
        if control_id == RETRY:
            return  # goes with its message: the page's place stays for when it has gone
        if control_id not in SIDEBARS:
            self.content_focus = control_id
        elif control_id == SIDEBAR and came_from not in SIDEBARS and self.nav_at_end:
            self.setFocusId(SIDEBAR_END)  # from the page: onto the entry lit for it, kept at the bottom

    def onAction(self, action):
        action_id = action.getId()
        focus = self.getFocusId()
        if action_id in BACK:
            self.back(focus)
            return
        if focus in SIDEBARS and action_id == ACTION_MOVE_RIGHT:
            self.setFocusId(self.page_focus())
            return
        if action_id in (ACTION_CONTEXT_MENU, ACTION_SHOW_INFO) and focus not in SIDEBARS:
            self.on_context(focus)
            return
        self.on_action(action_id, focus)

    def onClick(self, control_id):
        if control_id in SIDEBARS:
            self.sidebar_clicked(control_id)
        elif control_id == RETRY:
            self.clear_message()
            self.load()
        else:
            self.on_click(control_id)

    # ---------- for each screen to fill in ----------

    def load(self):
        pass

    def refresh(self):
        """Reelhouse changed something (a scan, watching on another device): re-read what's shown."""
        self.load()

    def default_focus(self):
        return SIDEBAR

    def page_focus(self):
        """Where the focus goes back to from the sidebar: where it was on the page."""
        return self.content_focus or self.default_focus()

    def on_click(self, control_id):
        pass

    def on_context(self, control_id):
        pass

    def on_action(self, action_id, focus):
        pass

    # ---------- the sidebar and top bar ----------

    def fill_sidebar(self):
        self.nav_playing = self.app.playing()
        top, bottom = self.app.nav_items(self.nav_playing)
        self.nav_at_end = any(key == self.nav for key, _, _, _ in bottom)
        # The bottom list sits on the sidebar's foot, as tall as its entries; the top one has the room above it.
        end_top = 1080 - SIDEBAR_FOOT - len(bottom) * SIDEBAR_ROW
        end = self.getControl(SIDEBAR_END)
        end.setPosition(0, end_top)
        end.setHeight(len(bottom) * SIDEBAR_ROW)
        self.getControl(SIDEBAR).setHeight(end_top - SIDEBAR_GAP - SIDEBAR_TOP)
        self.fill_nav(SIDEBAR, top)
        self.fill_nav(SIDEBAR_END, bottom)

    def follow_player(self):
        """The Now playing entry is there only while something plays: looked at whenever the screen comes back, and every
        second while it shows."""
        playing = self.app.playing()
        if playing != self.nav_playing:
            self.fill_nav(SIDEBAR, self.app.nav_items(playing)[0])
            self.nav_playing = playing

    def has_focus(self, control_id):
        try:
            return self.getFocusId() == control_id
        except RuntimeError:  # nothing has the focus, as a screen comes back
            return False

    def fill_nav(self, control_id, entries):
        items = []
        for key, label, icon_name, count in entries:
            li = xbmcgui.ListItem(label, count, offscreen=True)
            li.setProperty('key', key)
            li.setProperty('icon', icon(icon_name))
            if icon_name in model.ICON_SPOTS:
                li.setProperty('spot', icon(icon_name + '-spot'))  # red over it, whatever colour the icon is
            if key == self.nav:
                li.setProperty('active', 'true')
            items.append(li)
        control = self.getControl(control_id)
        keep = None
        if control.size() and self.has_focus(control_id):
            keep = control.getSelectedItem().getProperty('key')  # filled again while someone's moving along it
        control.reset()
        control.addItems(items)
        control.selectItem(model.nav_position([entry[0] for entry in entries], keep, self.nav))

    def fill_topbar(self):
        user = self.app.user()
        self.setProperty('avatar.letter', (user.get('username') or '?')[:1].upper())
        if user.get('avatar'):
            self.setProperty('avatar', self.app.image(user['avatar'], 120))

    def owner_line(self, li, art, recs):
        """Who set these recordings, under a cover on Everyone's (recording-owner-line.xml)."""
        line = model.owner_line(recs)
        li.setProperty('owner.names', line['names'])
        li.setProperty('owner.letter', line['letter'])
        if line['avatar']:
            art['avatar'] = self.app.image(line['avatar'], 120)

    def sidebar_clicked(self, control_id):
        key = self.getControl(control_id).getSelectedItem().getProperty('key')
        if key == 'settings':
            utils.addon().openSettings()
            return
        if key == 'fullscreen':
            xbmc.executebuiltin('Action(FullScreen)')  # Back in the player comes back to this screen
            return
        target = self.app.target_for(key)
        if key == self.nav:
            self.setFocusId(self.content_focus or self.default_focus())
            return
        self.app.pending = target
        if self.ROOT:
            self.after_child()
        else:
            self.close()

    # ---------- helpers ----------

    def list_item(self, card):
        li = xbmcgui.ListItem(card['label'], card['label2'], offscreen=True)
        art = {}
        for kind, (path, width) in card['art'].items():
            if path:
                art[kind] = self.app.image(path, width)
        li.setArt(art)
        li.setProperty('id', str(card['id']))
        li.setProperty('type', card['type'] or '')
        li.setProperty('title', card.get('title') or '')
        li.setProperty('position', str(card['position'] or 0))
        if card['watched']:
            li.setProperty('watched', 'true')
        if card['badge']:
            li.setProperty('badge', card['badge'])
        if card['play']:
            li.setProperty('play', 'true')
        if card['position'] and card['duration']:
            set_resume(li, card['position'], card['duration'])
        return li

    def fill_list(self, control_id, items):
        """Puts list items in a row, keeping the highlighted one where it was (a refresh)."""
        control = self.getControl(control_id)
        was = control.getSelectedPosition() if control.size() else 0
        control.reset()
        if items:
            control.addItems(items)
            control.selectItem(min(max(was, 0), len(items) - 1))

    def selected(self, control_id):
        li = self.getControl(control_id).getSelectedItem()
        if li is None:
            return None
        return {'id': int(li.getProperty('id') or 0), 'type': li.getProperty('type'), 'play': li.getProperty('play') == 'true',
                'position': float(li.getProperty('position') or 0), 'title': li.getProperty('title')}

    def show_message(self, title, text='', retry=False):
        self.setProperty('message.title', title)
        self.setProperty('message.text', text)
        self.setProperty('message.retry', 'true' if retry else '')
        if retry:
            self.focus_soon(RETRY)

    def clear_message(self):
        on_retry = self.has_focus(RETRY)
        for key in ('message.title', 'message.text', 'message.retry'):
            self.clearProperty(key)
        if on_retry:
            self.setFocusId(self.page_focus())  # the button has gone: nothing would have the focus, and the keys do nothing

    def focus_soon(self, control_id):
        """Focuses something just made to show (a message's button, a list just filled): it can't take the focus until
        Kodi's next frame."""
        for _ in range(20):
            self.setFocusId(control_id)
            if self.has_focus(control_id):
                return
            xbmc.sleep(50)

    def fetch(self, path, failed_title="Reelhouse can't be reached"):
        """GET from Reelhouse; on failure None comes back, and the screen says so (with Try again). Not when it's only
        reading again by itself what it already shows (Reelhouse restarting, say): that stays, the focus with it, and
        it's read again next time, as in the web app."""
        try:
            data = self.app.api.get(path)
        except ApiError as err:
            utils.log('{}: {}'.format(path, err), xbmc.LOGWARNING)
            if not (self.has_page and threading.current_thread() is self.refresher):
                self.show_message(failed_title if err.status is None else 'Something went wrong', str(err), retry=True)
            return None
        self.has_page = True
        self.clear_message()
        return data

    def follow_changes(self):
        """While the screen is the one showing: re-reads it when the service says Reelhouse changed something, keeps the
        sidebar's Now playing entry right, and calls tick() every second."""
        def run():
            self.refresher = threading.current_thread()
            monitor = xbmc.Monitor()
            while not self.closed and not monitor.waitForAbort(1):
                if self.closed or xbmcgui.getCurrentWindowId() != self.window_id:
                    continue
                try:
                    self.follow_player()
                    mark = self.app.change_mark()
                    if mark != self.seen_change:
                        self.seen_change = mark
                        self.refresh()
                    self.tick()
                except Exception as err:  # a screen closing while it refreshes
                    utils.log('refresh failed: {}'.format(err), xbmc.LOGDEBUG)

        thread = threading.Thread(target=run)
        thread.daemon = True
        thread.start()

    def tick(self):
        pass

    def items(self, cards):
        return [self.list_item(c) for c in cards]
