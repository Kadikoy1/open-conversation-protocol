const el = id => document.getElementById(id);
let token = '';
let nextRoom = null;
let after = 0;
let busy = false;

async function api(path, method = 'GET', data) {
  const response = await fetch('/api/conversations' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  return result;
}

function bind(id, event, action) {
  el(id).addEventListener(event, async e => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const controls = [...document.querySelectorAll('button, select')].filter(control => !control.disabled);
    controls.forEach(control => control.disabled = true);
    el('status').textContent = '';
    try { await action(); }
    catch (error) { el('status').textContent = error.message; }
    finally {
      controls.forEach(control => control.disabled = false);
      busy = false;
    }
  });
}

async function loadRooms(append = false) {
  const { conversations, next } = await api(append ? '?after=' + nextRoom : '');
  if (!append) el('rooms').replaceChildren(new Option('Select a conversation', ''));
  for (const conversation of conversations) {
    const option = new Option(conversation.title, conversation.id);
    option.dataset.role = conversation.role;
    el('rooms').append(option);
  }
  nextRoom = next;
  el('more-rooms').hidden = !next;
}

async function read() {
  const conversation = el('rooms').value;
  if (!conversation) return;
  const page = await api('/' + conversation + '/messages?after=' + after);
  for (const message of page.messages) {
    const item = document.createElement('li');
    const author = document.createElement('small');
    author.textContent = message.display_name + ' · ' + message.created_at;
    const text = document.createElement('p');
    text.textContent = message.body;
    item.append(author, text);
    el('messages').append(item);
  }
  after = page.next;
  el('refresh').textContent = page.more ? 'Load more messages' : 'Refresh messages';
}

async function selectRoom() {
  after = 0;
  el('messages').replaceChildren();
  el('body').value = '';
  el('room').hidden = !el('rooms').value;
  el('post').hidden = el('rooms').selectedOptions[0]?.dataset.role === 'reader';
  await read();
}

bind('connect', 'submit', async () => {
  token = el('token').value.trim();
  try { await loadRooms(); }
  catch (error) { token = ''; throw error; }
  el('token').value = '';
  el('connect').hidden = true;
  el('workspace').hidden = false;
  await selectRoom();
});
bind('disconnect', 'click', () => {
  token = '';
  nextRoom = null;
  el('workspace').hidden = true;
  el('connect').hidden = false;
  el('rooms').replaceChildren();
  el('messages').replaceChildren();
  el('body').value = '';
  el('title').value = '';
});
bind('create', 'submit', async () => {
  const conversation = await api('', 'POST', { title: el('title').value });
  const option = new Option(conversation.title, conversation.id, false, true);
  option.dataset.role = 'owner';
  el('rooms').add(option, 1);
  el('title').value = '';
  await selectRoom();
});
bind('rooms', 'change', selectRoom);
bind('more-rooms', 'click', () => loadRooms(true));
bind('refresh', 'click', read);
bind('post', 'submit', async () => {
  await api('/' + el('rooms').value + '/messages', 'POST', { body: el('body').value });
  el('body').value = '';
  await read();
});
