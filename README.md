# Art Wall

A touchscreen wall of paintings from the National Gallery of Art (NGA). Columns of
paintings fill the screen and scroll vertically, alternating up and down. Touch a
painting to enlarge it with its artist, title, date created, credit line and NGA.gov
address, surrounded by up to 12 visually similar paintings. Touch a similar painting
to move to it.

Static site, no framework. Data comes from the
[NGA open data program](https://github.com/NationalGalleryOfArt/opendata); images are
loaded live from NGA's IIIF image server.

## Deploy (GitHub + Netlify)

1. Push this folder to a GitHub repository.
2. In Netlify: **Add new site → Import an existing project →** pick the repository.
   `netlify.toml` already sets the build command (`npm run build`) and the publish
   folder (`public`).
3. Deploy.

On each deploy Netlify runs `scripts/build-data.mjs`, which downloads the NGA open
data tables, downloads a small thumbnail of each painting, computes visual similarity
and writes `public/data/artworks.json`.

If the build cannot reach NGA's image server, the deploy still succeeds using the
committed data file: the wall and the detail view work, but no similar paintings are
shown. Check the Netlify deploy log for `[build-data] WARNING`.

### Faster, more predictable deploys (optional)

Compute the data once on your own machine and commit it. Netlify then skips the work.

```
npm install
npm run build:data
git add public/data/artworks.json
git commit -m "Add similarity data"
git push
```

Re-run `npm run build:data` whenever you want to pick up changes to NGA's data.

## Run locally

```
npm install
npm run build:data   # optional, adds the similar paintings
npm start            # http://localhost:8080
```

## What is and is not verified

- **Tested:** the layout, scrolling, dragging, tapping, and detail view in headless
  Chrome at 1920×1080, 1080×1920 and 390×844; the similarity pipeline end to end
  against a stand-in image server with synthetic images.
- **Not tested:** anything against NGA's real image server (`api.nga.gov`), which was
  not reachable from the environment this was built in. That covers the thumbnail
  downloads in the build script and the images in the browser.
- **Not tested:** the NGA.gov address pattern
  `https://www.nga.gov/collection/art-object-page.{id}.html`. Search results show NGA
  pages at this pattern, but NGA's current pages use `/artworks/{id}-{title-slug}`.
  Open a few from the app to confirm they resolve. The pattern is one line, `pageUrl`
  in `scripts/build-data.mjs`.

## Which paintings

Objects classified `Painting` in `objects.csv` that have a primary image marked
`openaccess = 1` in `published_images.csv`: 2,916 paintings when this was built
(November 2026). About 1,170 more paintings have images that NGA has not marked open
access; they are left out. `OPEN_ACCESS_ONLY=0` includes them, but check the rights
position before doing that.

## How "visually similar" works

Color and composition only. Each thumbnail is squashed to 32×32 pixels, converted to
CIELAB color, and described by:

- a color histogram (which colors, and how much of each), and
- a 4×4 grid of average colors (where light, dark and color sit in the frame).

The 12 paintings with the closest descriptions are stored for each painting. This
finds paintings with a similar look and tone. It does not understand subject matter:
a dark portrait may be matched with a dark still life. The two weights `W_HIST` and
`W_GRID` in `scripts/build-data.mjs` shift the balance between palette and layout.

## Options

Build (environment variables, set in Netlify under *Site configuration → Environment variables*):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_ARTWORKS` | `4000` | Upper limit; a fixed random sample is taken if more match |
| `CLASSIFICATIONS` | `Painting` | Comma separated, e.g. `Painting,Drawing` |
| `OPEN_ACCESS_ONLY` | `1` | `0` also includes images not marked open access |
| `NEIGHBORS` | `12` | Similar paintings stored per painting |
| `CONCURRENCY` | `6` | Parallel thumbnail downloads |
| `SKIP_SIMILARITY` | unset | `1` writes details only |
| `FORCE` | unset | `1` rebuilds even if similarity data exists |

Display (add to the page address, e.g. `/?kiosk=1&idle=90`):

| Option | Default | Meaning |
| --- | --- | --- |
| `kiosk=1` | off | Shows the NGA.gov address as text, not a link, so visitors cannot leave the wall |
| `idle` | `120` | Seconds without touch before the detail view closes; `0` never |
| `speed` | `28` | Scroll speed in pixels per second |
| `cols` | by width | Force a number of columns |

## Files

```
public/index.html        page
public/css/style.css     styles
public/js/app.js         wall, touch handling, detail view
public/data/artworks.json  generated data
scripts/build-data.mjs   data + similarity build
netlify.toml             Netlify settings
```
