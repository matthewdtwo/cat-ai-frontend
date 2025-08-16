from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path
import shutil
import uuid

app = FastAPI(title="Cat Classifier Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ROOT = Path(__file__).resolve().parent.parent / 'public' / 'cat_pics'
CLASSIFIED_ROOT = ROOT / 'classified'
CLASSIFIED_ROOT.mkdir(parents=True, exist_ok=True)

FEEDER_FOLDERS = [
    'dualfeeder/cam1',
    'dualfeeder/cam2',
    'officefeeder1',
    'officefeeder2',
    'studyfeeder'
]

REFERENCE_DIR = ROOT / 'reference'

def _discover_cat_names():
    names = []
    if REFERENCE_DIR.exists():
        for p in sorted(REFERENCE_DIR.iterdir()):
            if p.is_file() and p.suffix.lower() in {'.jpg','.jpeg','.png','.webp','.gif'}:
                stem = p.stem.lower()
                if stem in ('unknown','not_cat'):  # reserved special categories
                    continue
                names.append(stem)
    return names

# Dynamic categories: real cat names from reference images + 'unknown' + 'not_a_cat'
CAT_NAMES = _discover_cat_names()
SPECIAL_CATEGORIES = ['unknown', 'not_a_cat']
VALID_CATEGORIES = set(CAT_NAMES + SPECIAL_CATEGORIES)

class ClassifyRequest(BaseModel):
    image_id: str
    category: str

class UndoRequest(BaseModel):
    image_id: str

# In-memory moves history for undo (non-persistent)
MOVE_HISTORY = []  # list of dicts {image_id, original_path, new_path}

@app.get('/api/feeders')
async def get_feeders():
    feeders = []
    for f in FEEDER_FOLDERS:
        feeder_path = ROOT / f
        if feeder_path.exists():
            feeders.append(f)
    return { 'feeders': feeders }

@app.get('/api/images')
async def list_images(feeder: str, source: str = 'cats', offset: int = 0, limit: int = 200):
    """Return paginated list of image file paths for given feeder and source.

    offset: starting index (0-based)
    limit: max number of images to return (capped to 1000)
    """
    feeder_path = ROOT / feeder / source
    if not feeder_path.exists():
        raise HTTPException(status_code=404, detail='Feeder/source not found')
    exts = {'.jpg','.jpeg','.png','.gif','.webp'}
    all_files = [p for p in sorted(feeder_path.glob('*')) if p.is_file() and p.suffix.lower() in exts]
    total = len(all_files)
    if offset < 0: offset = 0
    limit = max(1, min(limit, 1000))
    slice_files = all_files[offset: offset + limit]
    images = []
    for p in slice_files:
        rel = p.relative_to(ROOT.parent)  # relative to public
        image_id = str(uuid.uuid4()) + '|' + str(p)
        images.append({ 'id': image_id, 'url': '/' + str(rel).replace('\\','/'), 'filename': p.name })
    return { 'images': images, 'total': total, 'offset': offset, 'limit': limit }

def _unique_path(path: Path) -> Path:
    """Return a unique, non-existing path by adding _1, _2, ... if needed."""
    if not path.exists():
        return path
    i = 1
    while True:
        candidate = path.with_name(f"{path.stem}_{i}{path.suffix}")
        if not candidate.exists():
            return candidate
        i += 1

@app.post('/api/classify')
async def classify(req: ClassifyRequest):
    if req.category not in VALID_CATEGORIES:
        raise HTTPException(status_code=400, detail='Invalid category')
    try:
        _uuid_part, orig_path_str = req.image_id.split('|', 1)
    except ValueError:
        raise HTTPException(status_code=400, detail='Bad image id')
    orig_path = Path(orig_path_str)
    if not orig_path.exists():
        raise HTTPException(status_code=404, detail='Original image not found (was it already classified?)')
    target_dir = CLASSIFIED_ROOT / req.category
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = _unique_path(target_dir / orig_path.name)

    # Move instead of copy so source directory is cleaned up.
    try:
        shutil.move(str(orig_path), str(target_path))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Failed to move file: {e}')

    MOVE_HISTORY.append({ 'image_id': req.image_id, 'original_path': orig_path, 'new_path': target_path })
    return { 'status': 'ok', 'stored_at': str(target_path.relative_to(ROOT.parent)), 'moved': True }

@app.post('/api/undo')
async def undo(req: UndoRequest):
    # Find last move with this image id
    for i in range(len(MOVE_HISTORY)-1, -1, -1):
        m = MOVE_HISTORY[i]
        if m['image_id'] == req.image_id:
            new_path = m['new_path']
            orig_path = m['original_path']
            if new_path.exists():
                # Restore to original location; ensure directory exists
                orig_parent = orig_path.parent
                orig_parent.mkdir(parents=True, exist_ok=True)
                restore_path = orig_path if not orig_path.exists() else _unique_path(orig_path)
                try:
                    shutil.move(str(new_path), str(restore_path))
                except Exception as e:
                    raise HTTPException(status_code=500, detail=f'Failed to restore file: {e}')
            MOVE_HISTORY.pop(i)
            return { 'status': 'ok', 'restored_to': str(orig_path) }
    raise HTTPException(status_code=404, detail='No move to undo for image')


@app.get('/api/stats')
async def stats():
    """Return counts of already classified images per category."""
    counts = {}
    for cat in VALID_CATEGORIES:
        cat_dir = CLASSIFIED_ROOT / cat
        if cat_dir.exists():
            counts[cat] = sum(1 for p in cat_dir.iterdir() if p.is_file())
        else:
            counts[cat] = 0
    return { 'counts': counts }

@app.get('/api/categories')
async def list_categories():
    """Return ordered list of category descriptors with optional reference image URLs."""
    categories = []
    # Provide cats in discovered order
    for name in CAT_NAMES:
        ref_path = None
        p = REFERENCE_DIR / f"{name}.jpg"
        if not p.exists():
            # try any extension
            for ext in ['.jpeg','.png','.webp','.gif']:
                alt = REFERENCE_DIR / f"{name}{ext}"
                if alt.exists():
                    p = alt
                    break
        if p.exists():
            rel = p.relative_to(ROOT.parent)
            ref_path = '/' + str(rel).replace('\\','/')
        categories.append({
            'key': name,
            'label': name.capitalize(),
            'reference': ref_path
        })
    # Specials
    # unknown
    unk_ref = None
    unk_file = REFERENCE_DIR / 'unknown.jpg'
    if unk_file.exists():
        unk_ref = '/' + str(unk_file.relative_to(ROOT.parent)).replace('\\','/')
    categories.append({ 'key': 'unknown', 'label': 'Unknown', 'reference': unk_ref })
    # not a cat
    na_ref = None
    na_file = REFERENCE_DIR / 'not_cat.jpg'
    if na_file.exists():
        na_ref = '/' + str(na_file.relative_to(ROOT.parent)).replace('\\','/')
    categories.append({ 'key': 'not_a_cat', 'label': 'Not a Cat', 'reference': na_ref })
    return { 'categories': categories }

# Serve static frontend (index.html) via separate server (e.g., uvicorn) pointing to /public route if needed.
# We mount the entire project root's public folder at '/'.
public_dir = Path(__file__).resolve().parent.parent / 'public'
app.mount('/', StaticFiles(directory=str(public_dir), html=True), name='public')

# To run: uvicorn backend.main:app --reload --port 8000
