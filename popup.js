import { loadData, saveData, addTile, normalizeUrl, isAddableUrl } from './storage.js';

const $ = s => document.querySelector(s);
const msg = (text, cls) => { $('#msg').textContent = text; $('#msg').className = cls || ''; };

(async () => {
  const data = await loadData();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  $('#title').value = tab?.title || '';
  $('#url').value = tab?.url || '';

  const sel = $('#group');
  for (const g of data.groups) sel.add(new Option(g.name, g.id, false, g.id === data.activeGroup));
  $('#group-row').hidden = data.groups.length < 2;

  if (!isAddableUrl(tab?.url)) {
    msg('Tej strony nie można dodać – wpisz adres ręcznie.', 'err');
    $('#url').value = '';
  }

  // jawny adres – działa też w Operze, która nie pozwala zastąpić nowej karty
  $('#open').onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') }); window.close(); };

  $('#f').onsubmit = async e => {
    e.preventDefault();
    const url = normalizeUrl($('#url').value);
    if (!url) return msg('Nieprawidłowy adres.', 'err');
    const fresh = await loadData();
    const g = fresh.groups.find(x => x.id === sel.value) || fresh.groups[0];
    if (g.tiles.some(t => t.url === url)) return msg(`Ta strona już jest w grupie „${g.name}”.`, 'err');
    addTile(fresh, g.id, { url, title: $('#title').value });
    await saveData(fresh, { syncNow: true });
    $('#add').disabled = true;
    msg('Dodano ✓', 'ok');
    setTimeout(() => window.close(), 700);
  };
})();
