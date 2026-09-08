const ideasElement = document.querySelector('#ideas');
const form = document.querySelector('#idea-form');
const message = document.querySelector('#message');
let ideas = [];
let filter = 'all';

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const idea = await api('/api/ideas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: document.querySelector('#title').value,
        description: document.querySelector('#description').value
      })
    });
    ideas.unshift(idea);
    form.reset();
    showMessage('Idea added.');
    render();
  } catch (error) { showMessage(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector('#filters').addEventListener('click', (event) => {
  if (!event.target.dataset.filter) return;
  filter = event.target.dataset.filter;
  document.querySelectorAll('#filters button').forEach((button) => button.classList.toggle('active', button === event.target));
  render();
});

ideasElement.addEventListener('click', async (event) => {
  const vote = event.target.closest('[data-vote]');
  if (!vote) return;
  vote.disabled = true;
  try {
    const updated = await api(`/api/ideas/${vote.dataset.vote}/vote`, { method: 'POST' });
    ideas = ideas.map((idea) => idea._id === updated._id ? updated : idea);
    render();
  } catch (error) { showMessage(error.message, true); }
});

ideasElement.addEventListener('change', async (event) => {
  if (!event.target.matches('[data-status]')) return;
  try {
    const updated = await api(`/api/ideas/${event.target.dataset.status}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: event.target.value })
    });
    ideas = ideas.map((idea) => idea._id === updated._id ? updated : idea);
    render();
  } catch (error) { showMessage(error.message, true); await load(); }
});

async function load() {
  try { ideas = await api('/api/ideas'); render(); }
  catch (error) { ideasElement.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

function render() {
  const visible = ideas.filter((idea) => filter === 'all' || idea.status === filter);
  if (!visible.length) {
    ideasElement.innerHTML = '<div class="empty">No ideas here yet. Be the first to add one.</div>';
    return;
  }
  ideasElement.innerHTML = visible.map((idea) => `
    <article class="panel idea">
      <button class="vote" data-vote="${idea._id}" aria-label="Vote for ${escapeHtml(idea.title)}">
        <span>▲</span><strong>${idea.votes}</strong>
      </button>
      <div class="copy">
        <h2>${escapeHtml(idea.title)}</h2>
        <p>${escapeHtml(idea.description || 'No additional details.')}</p>
      </div>
      <select data-status="${idea._id}" class="status ${idea.status}" aria-label="Idea status">
        ${['planned', 'building', 'shipped'].map((status) => `<option value="${status}" ${status === idea.status ? 'selected' : ''}>${status}</option>`).join('')}
      </select>
    </article>`).join('');
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || body.code || 'Request failed.');
  return body;
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? 'error' : '';
  setTimeout(() => { message.textContent = ''; }, 2500);
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

load();
