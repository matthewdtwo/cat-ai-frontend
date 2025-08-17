// See ../../src/app.js for source; this is a synchronized copy for static serving.
// (Consider adding a build step or symlink if environment supports it.)

// Cat Classifier Frontend Logic
// Fetch image list from backend, display, allow drag or hotkey classification.

const state = {
  feeders: [],
  images: [], // {id, url, feeder, source, filename}
  index: 0,
  history: [], // stack of {imageId, previousCategory, newCategory}
  currentFeeder: null,
  currentSource: 'cats',
  stats: {},
  categories: [], // {key,label,reference}
  pagination: { offset:0, limit:100, total:0 }
};

const feederSelect = document.getElementById('feederSelect');
const sourceSelect = document.getElementById('sourceSelect');
const thumbnailsEl = document.getElementById('thumbnails');
const mainImage = document.getElementById('mainImage');
const progressEl = document.getElementById('progress');
const categoriesContainer = document.getElementById('categories');

async function api(path, opts={}) {
  const res = await fetch(path, opts);
  if(!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadFeeders() {
  const data = await api('/api/feeders');
  state.feeders = data.feeders;
  feederSelect.innerHTML = state.feeders.map(f => `<option value="${f}">${f}</option>`).join('');
  state.currentFeeder = state.feeders[0];
  await loadCategories();
}

async function loadCategories() {
  const data = await api('/api/categories');
  state.categories = data.categories;
  renderCategories();
  setupDragAndDrop(); // categories re-rendered; re-bind dnd
  await refreshStats();
}

function renderCategories() {
  categoriesContainer.innerHTML = '';
  // assign numeric hotkeys for first N cats, then U / N
  const hotkeyAssignments = [];
  let num = 1;
  state.categories.forEach(cat => {
    let hk = '';
    if(cat.key !== 'unknown' && cat.key !== 'not_a_cat') {
      hk = String(num++);
    } else if(cat.key === 'unknown') hk = 'U';
    else if(cat.key === 'not_a_cat') hk = 'N';
    hotkeyAssignments.push({ key: cat.key, hotkey: hk.toLowerCase() });
    const div = document.createElement('div');
    div.className = 'category';
    div.dataset.category = cat.key;
    if(hk) div.dataset.hotkey = hk.toLowerCase();
    div.innerHTML = `<span>${cat.label}</span>` + (hk?` <span class="hotkey">${hk}</span>`:'');
    if(cat.reference) {
      div.style.backgroundImage = `url(${cat.reference})`;
      div.style.backgroundSize = 'cover';
      div.style.backgroundPosition = 'center';
      div.style.backdropFilter = 'blur(2px)';
      div.style.position = 'relative';
      div.style.color = '#fff';
      div.style.textShadow = '0 0 4px #000';
    }
    categoriesContainer.appendChild(div);
  });
  state.hotkeyMap = Object.fromEntries(hotkeyAssignments.map(h=>[h.hotkey,h.key]));
}

async function loadImages() {
  if(!state.currentFeeder) return;
  const { offset, limit } = state.pagination;
  const url = `/api/images?feeder=${encodeURIComponent(state.currentFeeder)}&source=${encodeURIComponent(state.currentSource)}&offset=${offset}&limit=${limit}`;
  const data = await api(url);
  state.images = data.images;
  state.pagination.total = data.total;
  state.pagination.offset = data.offset; // server may normalize
  state.pagination.limit = data.limit;
  state.index = 0; // reset index when page changes
  renderThumbnails();
  showCurrent();
  await refreshStats();
  renderPageControls();
}

function renderThumbnails() {
  thumbnailsEl.innerHTML = '';
  state.images.forEach((img, i) => {
    const el = document.createElement('img');
  el.src = img.url;
  el.loading = 'lazy';
  el.dataset.id = img.id;
    el.draggable = true;
    el.addEventListener('click', () => { state.index = i; showCurrent(); });
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', img.id); });
    thumbnailsEl.appendChild(el);
  });
  updateProgress();
}

function showCurrent() {
  const img = state.images[state.index];
  if(!img) { mainImage.src=''; return; }
  mainImage.src = img.url;
  mainImage.dataset.id = img.id;
  document.querySelectorAll('.thumbnails img').forEach((el,i)=>{
    el.classList.toggle('active', i === state.index);
  });
  updateProgress();
}

function next(delta=1) {
  if(state.images.length===0) return;
  state.index = (state.index + delta + state.images.length) % state.images.length;
  showCurrent();
}

async function classify(imageId, category) {
  const img = state.images.find(i=>i.id===imageId);
  if(!img) return;
  try {
    await api('/api/classify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ image_id:imageId, category }) });
    state.history.push({ imageId, newCategory: category });
    // Remove image from pending list
    const idx = state.images.findIndex(i=>i.id===imageId);
    if(idx>=0) {
      state.images.splice(idx,1);
      // Remove thumbnail DOM node without rebuilding all
      const thumb = thumbnailsEl.querySelector(`img[data-id="${CSS.escape(imageId)}"]`);
      if(thumb) thumb.remove();
      if(state.index >= state.images.length) state.index = state.images.length-1;
    }
    // Update category count locally (avoid stats round-trip)
    state.stats[category] = (state.stats[category] || 0) + 1;
    updateCategoryCount(category);
    showCurrent();
  } catch(e) {
    console.error(e);
    alert('Classification failed: '+ e.message);
  }
}

async function undo() {
  const last = state.history.pop();
  if(!last) return;
  try {
    await api('/api/undo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ image_id:last.imageId }) });
    // On undo, re-fetch images list for consistency
    await loadImages();
    // Decrement category count (will be corrected by stats refresh inside loadImages, but we can adjust optimistic)
    if(last.newCategory && state.stats[last.newCategory] > 0) {
      state.stats[last.newCategory] -= 1;
      updateCategoryCount(last.newCategory);
    }
  } catch(e) {
    console.error(e);
    alert('Undo failed: '+ e.message);
  }
}

function setupDragAndDrop() {
  document.querySelectorAll('.category').forEach(cat => {
    cat.addEventListener('dragover', e => { e.preventDefault(); cat.classList.add('dragover'); });
    cat.addEventListener('dragleave', ()=>cat.classList.remove('dragover'));
    cat.addEventListener('drop', e => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain') || mainImage.dataset.id;
      cat.classList.remove('dragover');
      classify(id, cat.dataset.category);
      cat.classList.add('assigned');
      setTimeout(()=>cat.classList.remove('assigned'), 800);
    });
    cat.addEventListener('click', ()=>{
      const id = mainImage.dataset.id;
      if(id) classify(id, cat.dataset.category);
    });
  });

  mainImage.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', mainImage.dataset.id);
  });
}

function updateProgress() {
  const remaining = state.images.length;
  if(!remaining) {
    progressEl.textContent = 'No images to classify';
    return;
  }
  const { offset, limit, total } = state.pagination;
  const start = offset + 1;
  const end = offset + state.images.length;
  progressEl.textContent = `Viewing ${state.index+1}/${state.images.length} (Page ${Math.floor(offset/limit)+1}) Range ${start}-${end} of ${total}`;
}

function shuffleImages() {
  for(let i=state.images.length-1; i>0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [state.images[i], state.images[j]] = [state.images[j], state.images[i]];
  }
  state.index = 0;
  renderThumbnails();
  showCurrent();
}

function bindControls() {
  document.getElementById('nextBtn').onclick = ()=> next(+1);
  document.getElementById('prevBtn').onclick = ()=> next(-1);
  const undoBtn = document.getElementById('undoBtn');
  undoBtn.title = 'Undo last (Shift:5, Alt:20)';
  undoBtn.addEventListener('click', (e) => {
    if(e.altKey) multiUndo(20);
    else if(e.shiftKey) multiUndo(5);
    else undo();
  });
  document.getElementById('refreshBtn').onclick = ()=> loadImages();
  document.getElementById('shuffleBtn').onclick = ()=> shuffleImages();
  feederSelect.addEventListener('change', ()=> { state.currentFeeder = feederSelect.value; loadImages(); });
  sourceSelect.addEventListener('change', ()=> { state.currentSource = sourceSelect.value; loadImages(); });

  window.addEventListener('keydown', e => {
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if(e.key === 'ArrowRight' || e.key === ' ') { next(1); e.preventDefault(); }
    else if(e.key === 'ArrowLeft') { next(-1); e.preventDefault(); }
    else if(e.key === 's') { shuffleImages(); }
    else if(e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) {
      if(e.shiftKey) multiUndo(5); else undo();
    }
    else {
      const cat = state.hotkeyMap?.[e.key.toLowerCase()];
      if(cat) { const id = mainImage.dataset.id; if(id) classify(id, cat); }
    }
  });
}

async function refreshStats() {
  try {
    const data = await api('/api/stats');
    state.stats = data.counts;
    // annotate category boxes
    document.querySelectorAll('.category').forEach(cat => {
      const c = cat.dataset.category;
      if(state.stats[c] !== undefined) {
        cat.dataset.count = state.stats[c];
        cat.querySelector('.count')?.remove();
        const span = document.createElement('span');
        span.className = 'count';
        span.style.fontSize = '0.65rem';
        span.style.opacity = '0.6';
        span.textContent = state.stats[c];
        cat.appendChild(span);
      }
    });
  } catch(e) {
    console.warn('Stats failed', e);
  }
}

function updateCategoryCount(catKey) {
  const box = document.querySelector(`.category[data-category="${CSS.escape(catKey)}"]`);
  if(!box) return;
  const existing = box.querySelector('.count');
  if(existing) existing.textContent = state.stats[catKey]; else {
    const span = document.createElement('span');
    span.className = 'count';
    span.style.fontSize = '0.65rem';
    span.style.opacity = '0.6';
    span.textContent = state.stats[catKey];
    box.appendChild(span);
  }
}

async function multiUndo(n) {
  // Bound n to available history
  const toUndo = Math.min(n, state.history.length);
  if(!toUndo) return;
  // Collect last N distinct imageIds (they should already be distinct per classification)
  const batch = state.history.slice(-toUndo).reverse();
  let success = 0;
  for(const entry of batch) {
    try {
      await api('/api/undo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ image_id:entry.imageId }) });
      success++;
    } catch(err) {
      console.warn('Failed undo for', entry.imageId, err);
    }
  }
  // Trim history
  state.history.length = state.history.length - toUndo;
  await loadImages();
  await refreshStats();
  // Optional: simple visual feedback
  progressEl.textContent += ` | Undid ${success}`;
}

async function init() {
  await loadFeeders();
  await loadImages();
  bindControls();
}

function renderPageControls() {
  // Create or update a pagination bar inside topbar or below thumbnails
  let bar = document.getElementById('pageControls');
  if(!bar) {
    bar = document.createElement('div');
    bar.id = 'pageControls';
    bar.style.display = 'flex';
    bar.style.gap = '4px';
    bar.style.flexWrap = 'wrap';
    bar.style.margin = '4px 0';
    const gallery = document.querySelector('.gallery');
    gallery?.insertBefore(bar, document.getElementById('thumbnails'));
  }
  const { offset, limit, total } = state.pagination;
  const currentPage = Math.floor(offset/limit)+1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const disablePrev = offset <= 0;
  const disableNext = offset + limit >= total;
  bar.innerHTML = '';

  function btn(label, action, disabled=false) {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = disabled;
    b.style.padding = '2px 6px';
    b.onclick = action;
    bar.appendChild(b);
  }
  btn('⏮ First', ()=> changePage(0), disablePrev);
  btn('◀ Prev', ()=> changePage(offset - limit), disablePrev);
  btn('Next ▶', ()=> changePage(offset + limit), disableNext);
  btn('Last ⏭', ()=> changePage((totalPages-1)*limit), disableNext);

  // Page / limit indicator
  const info = document.createElement('span');
  info.style.fontSize = '0.7rem';
  info.style.opacity = '0.7';
  info.textContent = `Page ${currentPage}/${totalPages} • Limit ${limit}`;
  bar.appendChild(info);

  // Limit selector
  const sel = document.createElement('select');
  [50,100,200,400].forEach(v=>{
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v + '/page';
    if(v === limit) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.onchange = () => { state.pagination.limit = parseInt(sel.value,10); state.pagination.offset = 0; loadImages(); };
  bar.appendChild(sel);
}

function changePage(newOffset) {
  if(newOffset < 0) newOffset = 0;
  state.pagination.offset = newOffset;
  loadImages();
}

init().catch(err=>{ console.error(err); alert('Init failed: '+ err.message); });
