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
  // The Worker that holds the rooms (M4). Served from localhost the app talks to `wrangler dev`;
  // deployed, to the URL below. Empty = sessions disabled.
  worker: {
    deployed: 'https://sortilege-vtt-cityofwinter.sortilege.workers.dev',
    local: 'http://localhost:8810',
  },
};
window.VttConfig.workerUrl = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? window.VttConfig.worker.local : window.VttConfig.worker.deployed;
