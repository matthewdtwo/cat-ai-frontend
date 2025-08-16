# Cat Classifier Front End

This application is a frontend used for identifying cat pictures taken at automatic cat feeders. It is used to sort pictures into one of 7 categories, one for each of the five cats, an unknown, and not a cat.

## UI
It consists of a gallery view on the left, with a main image and thumbnails below. The right of the page has boxes for each cat.
## Functionality
The user can drag the main image to any of the categories on the right (or press a hotkey) to classify the image.
The classified image is copied into `public/cat_pics/classified/<category>`.

Cat names are derived automatically from files in `public/cat_pics/reference/` (filename stem = cat name). Example: `jet.jpg` => category `jet`.

Hotkeys:

Numbers: Assigned sequentially to discovered cat names  
U -> Unknown  
N -> Not a Cat  
Arrow Left/Right -> Navigate images  
Space -> Next  
S -> Shuffle remaining  
Ctrl+Z -> Undo last classification

### Photos directory structure:
Root public/media/cat_pics

reference/ -> The reference images for each cat.

# feeder specific images
dual_feeder/cam1 -> camera 1 on the dual feeder
dual_feeder/cam2 -> camera 2 on the dual feeder
officefeeder1
officefeeder2
studyfeeder

Each feeder-specific folder has two sub folders in it. these have been pre-classified to contain a cat using a separate model.
cats
not_cat

## Backend

A lightweight FastAPI backend (`backend/main.py`) provides:

GET `/api/feeders` -> list available feeder folders that exist.  
GET `/api/images?feeder=<f>&source=cats|not_cat` -> list images for labeling.  
POST `/api/classify` `{ image_id, category }` -> copy original image into `public/cat_pics/classified/<category>/`.  
POST `/api/undo` `{ image_id }` -> remove the last stored copy for that image id.

Image IDs are ephemeral and encode the original absolute path following a UUID prefix.

## Run Locally

Install dependencies (FastAPI + Uvicorn) and start the dev server:

```
python -m venv .venv
source .venv/bin/activate  # Windows (WSL) shown; on cmd use .venv\Scripts\activate
pip install fastapi uvicorn
uvicorn backend.main:app --reload --port 8000
```

Then open: http://localhost:8000/

All static assets (index.html, JS, CSS) are served from `public/` via the FastAPI StaticFiles mount.

## Future Improvements

- Persist classification history (e.g., SQLite) for robust undo / audit.
- Add per-cat reference panel with similarity preview.
- Batch keyboard classification (auto-advance after assignment -- currently implemented by removing image from list).
- Display already-classified counts per category.
- Add filtering or model-assisted pre-suggestions.