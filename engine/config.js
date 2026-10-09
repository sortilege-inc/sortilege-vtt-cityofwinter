// engine/config.js — where things are. The one file a deployment edits.
window.VttConfig = {
  system: 'cityofwinter',
  title: 'City of Winter',
  channel: 'sortilege-vtt-cityofwinter',        // BroadcastChannel name (same-machine windows)
  storagePrefix: 'sortilege-vtt-cityofwinter',  // localStorage key prefix
  // The pages, relative to the site root. The site (index.html) is the public face — the rules,
  // the atlas, the traditions; gm/ is the facilitator's table (the directory keeps the family's
  // name so engine ports apply; nothing visible calls it the GM's). The gm/ pages carry
  // <base href="../"> so every path in code and in saved state is root-relative.
  pages: { site: './', gm: 'gm/', table: 'gm/vtt.html', play: 'gm/play.html' },
  // what a fresh browser opens on until a family is created or restored
  defaultCampaign: { name: 'A family', modules: [], books: ['rules', 'atlas', 'cards'] },
  // City of Winter has no GM and no hidden text: the rules are the play surface and every player
  // acts (PLAN.md, D3). So the family's veil before /gm/ is off and the books are open on the site.
  siteBooks: true,
  gmGate: null,
  // the facilitator's table: the stage, the location and the family across; the rail panels behind
  defaultSlots: ['stage', 'location', 'family'],
  regionFallback: ['turn', 'record', 'rules'],
  presets: { Playing: ['stage', 'location', 'family'], Reading: ['rules', 'atlas', 'traditions'] },
  // the GM-only panes have nothing to hold here: there is no prep, no scenes, no threads
  hidePanes: ['overview', 'scenes', 'threads', 'places', 'people', 'tracker', 'scene', 'inspector', 'party', 'log', 'clocks', 'cast'],
  // what the shell calls the one who starts the room
  roleName: 'facilitator',
  // the map library on the Worker (engine/library.js): the facilitator uploads maps to a live
  // instance; none ship in the repo (PLAN.md, D4)
  library: true,
  // The family's Tokens: the publisher's ten picture discs, uploaded to this deployment's library
  // (not in the repo — the art is the publisher's). Ids match CowRules.TOKENS; a token without art
  // shows the character's initial on its colour.
  tokenArt: {
    'crown-a': 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev/library/mv1558oz-qzy3z3-crown-a.png',
    'crown-b': 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev/library/mv1559h7-7wh2g8-crown-b.png',
    'fire-a': 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev/library/mv155a5a-8q9g5k-fire-a.png',
    'fire-b': 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev/library/mv155aur-z8kn6g-fire-b.png',
    'bell-a': 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev/library/mv155bkh-4p32zu-bell-a.png',
    'bell-b': 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev/library/mv155cc9-dy3hpp-bell-b.png',
    'light-a': 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev/library/mv155d4k-s7uebw-light-a.png',
    'light-b': 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev/library/mv155dr6-t2jqyr-light-b.png',
    'pouch-a': 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev/library/mv155ejp-dvr36x-pouch-a.png',
    'pouch-b': 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev/library/mv155f85-3q8uxw-pouch-b.png',
  },
  // The Worker that holds the rooms (M4). Served from localhost the app talks to `wrangler dev`;
  // deployed, to the URL below. Empty = sessions disabled.
  worker: {
    deployed: 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev',
    local: 'http://localhost:8810',
  },
};
window.VttConfig.workerUrl = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? window.VttConfig.worker.local : window.VttConfig.worker.deployed;
