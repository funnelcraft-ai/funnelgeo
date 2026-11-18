import re, sys, json, os
SRC = '/tmp/msym/node_modules/@material-symbols/svg-400/rounded'
# App name -> Material Symbols name. Nav icons also get a filled version for the active state.
MAP = {
  'grid': 'space_dashboard', 'dashboard': 'space_dashboard', 'users': 'group', 'sliders': 'tune', 'building': 'apartment',
  'search': 'search', 'plus': 'add', 'check': 'check', 'logout': 'logout', 'upload': 'upload', 'mail': 'mail',
  'globe': 'language', 'arrow': 'arrow_forward', 'play': 'play_arrow', 'refresh': 'refresh', 'chevron': 'chevron_right',
  'target': 'travel_explore', 'link': 'link', 'download': 'download', 'key': 'key', 'gauge': 'speed', 'layers': 'layers',
  'coins': 'payments', 'menu': 'menu', 'menu_open': 'menu_open', 'settings': 'settings', 'expand': 'keyboard_arrow_down', 'close': 'close',
  'up': 'trending_up', 'down': 'trending_down', 'flat': 'trending_flat', 'warning': 'warning', 'error': 'error',
  'ok': 'check_circle', 'spark': 'wand_stars', 'report': 'description', 'visibility': 'visibility', 'bot': 'smart_toy',
  'insights': 'monitoring', 'person': 'person', 'task': 'task_alt', 'schedule': 'schedule', 'open': 'open_in_new',
  'more': 'more_vert', 'account': 'account_circle', 'clients': 'storefront', 'question': 'forum', 'trophy': 'trophy',
  'visits': 'ads_click', 'flag': 'flag', 'edit': 'edit', 'delete': 'delete', 'copy': 'content_copy', 'send': 'send',
  'lock': 'lock', 'bolt': 'bolt', 'cancel': 'cancel', 'info': 'info', 'filter': 'filter_list', 'back': 'arrow_back',
}
FILLED = {'grid', 'dashboard', 'users', 'sliders', 'building', 'target', 'key', 'gauge', 'layers', 'coins', 'settings', 'clients', 'report'}
def path(name):
    s = open(f'{SRC}/{name}.svg').read()
    return re.search(r' d="([^"]+)"', s).group(1)
out = {}
for k, v in MAP.items():
    out[k] = path(v)
    if k in FILLED:
        out[k + '-fill'] = path(v + '-fill')
lines = ['// Generated from Material Symbols Rounded (Apache 2.0) by scripts/gen-icons.py. viewBox 0 -960 960 960.', 'export const SYMBOLS = {']
for k, d in out.items():
    lines.append(f"  '{k}': '{d}',")
lines += ['} as const;', '']
open(sys.argv[1], 'w').write('\n'.join(lines))
print(len(out), 'icons', os.path.getsize(sys.argv[1]), 'bytes')
