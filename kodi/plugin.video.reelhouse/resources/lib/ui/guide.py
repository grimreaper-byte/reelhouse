# The Live TV guide's geometry and movement, as the web app's guide works (web/js/views/livetv.js), for a screen that
# shows a window of a few channels by two hours. Pure Python, so it's tested without Kodi.
HALF_HOUR = 1800


class Guide(object):
    """Channels and their programmes, and the part on screen: rows [top, top + rows) and times [start, start + span).

    channels: [{'uuid', ...}], events: [{'id', 'channel', 'start', 'stop', ...}] (any order).
    """

    def __init__(self, channels, events, rows, span, start):
        self.channels = channels
        self.rows = rows
        self.span = span
        self.start = start
        self.top = 0
        self.set_events(events)

    def set_events(self, events):
        self.events = sorted(events, key=lambda e: (e['start'], e['stop']))
        self.by_channel = dict((c['uuid'], []) for c in self.channels)
        for e in self.events:
            if e['channel'] in self.by_channel:
                self.by_channel[e['channel']].append(e)
        self.by_id = dict((e['id'], e) for e in self.events)

    # ---------- what's on screen ----------

    def visible_channels(self):
        return self.channels[self.top:self.top + self.rows]

    def blocks(self, channel_uuid, x0, width):
        """The programmes of a channel inside the time window: (event, x, w), clipped to its edges."""
        end = self.start + self.span
        per_second = float(width) / self.span
        out = []
        for e in self.by_channel.get(channel_uuid, []):
            if e['stop'] <= self.start or e['start'] >= end:
                continue
            left = max(e['start'], self.start)
            right = min(e['stop'], end)
            out.append((e, x0 + int(round((left - self.start) * per_second)), int(round((right - left) * per_second))))
        return out

    def x_of(self, t, x0, width):
        """Where a time is across the window (the now line), or None when it's outside."""
        if not self.start <= t < self.start + self.span:
            return None
        return x0 + int(round((t - self.start) * float(width) / self.span))

    # ---------- the highlight ----------

    def first_highlight(self, now):
        """What's on now on the first channel with anything (else its next programme), as the web guide starts."""
        for c in self.channels:
            evs = self.by_channel.get(c['uuid'], [])
            pick = (next((e for e in evs if e['start'] <= now < e['stop']), None)
                    or next((e for e in evs if e['stop'] > max(now, self.start)), None)
                    or (evs[0] if evs else None))
            if pick:
                return pick
        return None

    @staticmethod
    def nearest_at(events, at):
        best, gap = None, None
        for e in events:
            d = e['start'] - at if e['start'] > at else at - e['stop'] if e['stop'] <= at else 0
            if gap is None or d < gap:
                best, gap = e, d
        return best

    def move(self, current, direction, anchor, now):
        """The programme an arrow key goes to from `current` (None at an edge), and the time ↑/↓ keep to.

        ←/→: the programme before or after on the same channel. ↑/↓: the channel above or below, the programme at the
        anchor time (now while it's on, else its start or the window's start), kept while going up and down so the
        highlight doesn't drift.
        """
        if direction in ('left', 'right'):
            row = self.by_channel.get(current['channel'], [])
            i = row.index(current) + (1 if direction == 'right' else -1)
            return (row[i] if 0 <= i < len(row) else None), None
        if anchor is None:
            anchor = now if current['start'] <= now < current['stop'] else max(current['start'], self.start)
        uuids = [c['uuid'] for c in self.channels]
        step = 1 if direction == 'down' else -1
        i = uuids.index(current['channel']) + step
        while 0 <= i < len(uuids):
            target = self.nearest_at(self.by_channel.get(uuids[i], []), anchor)
            if target:
                return target, anchor
            i += step
        return None, anchor

    # ---------- keeping it in sight ----------

    def reveal(self, event, floor=None):
        """Moves the window so the event is in sight: its row, and its start (a long one shows its beginning).

        floor: the earliest start the window may take (the day's start). True when the window moved.
        """
        moved = False
        uuids = [c['uuid'] for c in self.channels]
        row = uuids.index(event['channel'])
        if row < self.top:
            self.top, moved = row, True
        elif row >= self.top + self.rows:
            self.top, moved = row - self.rows + 1, True
        end = self.start + self.span
        if event['start'] < self.start and event['stop'] <= self.start + 15 * 60:
            # Ends near or before the window's start: step back to the half hour it starts in.
            self.start, moved = max(floor or 0, half_hour(event['start'])), True
        elif event['start'] >= end - 15 * 60:
            self.start, moved = half_hour(event['start']) - HALF_HOUR, True
            if floor is not None:
                self.start = max(floor, self.start)
        return moved


def half_hour(t):
    return int(t // HALF_HOUR) * HALF_HOUR
