# Data in Dialogue

**An Interactive Atlas of Critical Data Visualization**

<img src="https://infovis.fh-potsdam.de/atlas/src/img/bubbles.svg" width="600" height="200" alt="Three speech bubbles on a gray background, holding a bar chart, a bubble map, and a node-link diagram.">

This growing collection gathers projects and publications about data visualization for critique, deliberation, and empowerment.

Live at **[infovis.fh-potsdam.de/atlas/](https://infovis.fh-potsdam.de/atlas/)** 

---

## The interface

The atlas is a visual interface with three views, each offering a different angle on the collection, and the switcher in the bottom-left corner moves between them (while retaining the item selection, the tag filter, or any free-form search).

| View | What it shows | What it is for |
| --- | --- | --- |
| Map | Every entry at once, placed by keyword similarity | Seeing an overall shape of the field |
| Grid | A masonry of thumbnails, newest first | Browsing the collection along its images |
| List | A chronological reading list, grouped by year | Scrolling along titles and authors |

### Selecting an item

Opening an entry works differently in each of the three views.

On the **map**, selecting an item opens it in the monad view, with it being in the center surrounded by a ring of its most similar entries. Closing it returns to the map view.

In the **grid** and the **list**, the selected item expands its card or row in place, so the entry opens inside the sequence it belongs to rather than replacing it.

### Filtering and finding

- **Tags** (on left, on desktop): alphabetical list of prominent keywords sized by how often they occur among the items in the current view. Hovering previews it as a filter, clicking activates it. On mobile, a search for `#tag` has the same effect.
- **Search** (top right, or `F`) runs across every text field, stemmed, so *visualizing* finds *visualization*. The map layout adjusts to accommodate the results.
- **Shuffle** (bottom right, or `R`) opens a random entry. Hold <kbd>Shift</kbd> for a random walk: a new entry every ten seconds, until anything is pressed.
- **Idle**: left alone on the map for five seconds, the atlas starts pointing at entries by itself, one every five seconds. Any movement cancels it.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> | Switch to map, grid, and list |
| <kbd>F</kbd> or <kbd>⌘/Ctrl</kbd>+<kbd>F</kbd> | Search |
| <kbd>R</kbd> / <kbd>⌥</kbd>+<kbd>Space</kbd> | Random entry |
| <kbd>⇧</kbd>+<kbd>R</kbd> | Random walk |
| <kbd>I</kbd> | About panel |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Step through list / grid |
| <kbd>Space</kbd> | Page list and grid |
| <kbd>Enter</kbd> | Open selected item's URL in new tab |
| <kbd>Esc</kbd> | Back out one step |

### Addresses

Every significant state of the atlas is encoded in the address, so any of it can be linked or reloaded:

```
#about                      the about panel
#list  #grid                a view other than the map
#q:data%20science           a search
#t:feminism                 a tag filter
#i:dignazio2020data         a selected entry
#image                      the lightbox, after an entry
```

Some of these are combined when the context warrants it:
```#list/t:feminism/i:dignazio2020data/image```

### Phones

When the interface is opened it checks if the device has a fine pointer that can hover (mouse or trackpad), and this changes a bit which features are included. On mobile, there are no view transitions, no link canvas on the map, and no tag sidebar; an entry opens in a full-screen detail in every view.

---

## File structure

The atlas is a static website: there are no external dependencies and no framework in use. The repository contains what a web server needs to host it. However, it does need a server because `items.json` is fetched when loaded.

```
index.html          markup for controls and loader for scripts
items.json          the collection (see below)
images/<id>.webp    large image tier
info.md             About panel content, rendered at runtime
feed.xml            RSS, generated alongside items.json
favicon.*           the Data in Dialogue icon
src/
  app/
    core.js         shared state and machinery
    components.js   logic behind buttons and lightbox
    map.js          map, link canvas, search view
    list.js         list view
    grid.js         grid view
    tag.js          tag cloud and curves in list (desktop only)
    item.js         full-screen entry detail (phones only)
    main.js         fetches items.json, starts app (loaded last)
    style.css       the whole stylesheet
  fonts/            Atkinson Hyperlegible Next (variable font)
  img/              logos, speech-bubble drawing, social banner
```

There is no bundler and no module system. These are plain scripts sharing one global scope, inserted by a loader in `index.html` and run in the order listed above, with `main.js` last.

---

## The data: `items.json`

A flat JSON **array** of records, one per entry, such as this:

```json
{
  "id":      "dignazio2020data",
  "title":   "Data Feminism",
  "authors": "Catherine D'Ignazio, Lauren F Klein",
  "source":  "MIT Press",
  "date":    "2020",
  "added":   "2020-05-29",
  "tags":    ["data", "ethics", "feminism", "history", "power"],
  "url":     "https://datafeminism.io",
  "links":   ["battlebaptiste2018web"],
  "text":    "A new way of thinking about data science…",
  "umap_x":  0.6746,
  "umap_y":  0.6949,
  "image":   { "w": 900, "h": 1013, "r": 173, "g": 164, "b": 161,
             "src": "data:image/webp;base64,…" }
}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | ✓ | Citation key. The primary key used in image file name, address (`#i:<id>`) and entries in `links` |
| `title` | string | ✓ | Full title, including any subtitle (see below) |
| `authors` | string | | Creators in one string |
| `source` | string | | Publication, venue and/or institution |
| `date` | string | ✓ | Year of the work |
| `added` | string | ✓ | Day the entry joined the collection, `YYYY-MM-DD`. |
| `tags` | string[] | ✓ | Sorted at load, so display order does not depend on the file |
| `url` | string | ✓ | Hyperlink to the original work |
| `text` | string | ✓ | Quoted abstract or description |
| `umap_x`, `umap_y` | number | ✓ | Map coordinates (`0…1`). Precomputed by UMAP over tag sets |
| `links` | string[] | | Related entries by `id`, meant as direct influence |
| `image` | object | | Image thumbnail and metadata |

### Two derived fields

**Subtitle.** Where a title breaks into a main title and a subtitle (academics love their colon-gerund titles), it is a question of formatting to make it legible as such. So the data file includes the whole string and the split happens when loaded. The first separator present in `": "`, `" - "`, `"? "`, `"! "` wins. `title` stays the full string, which is what alt text, the document title, and the search index want.

**Links.** The `links` array may be written one-directionally, but in the interface it is treated bilaterally, the closure is computed at load, so if A lists B, then B links back to A. Any ids pointing at entries that are not in the file are dropped.

### Two image sizes

| Size | Location | Use |
| --- | --- | --- |
| small | a base64 WebP data URL inlined in `image.src` | Displayed once the JSON is parsed, without requiring a second request |
| large | `images/<id>.webp` | Fetched on demand when an item is opened or hovered |

`image.w` and `image.h` are the large image's dimensions, which reserve its aspect ratio before anything loads. `image.r`, `image.g` and `image.b` are its average color, shown underneath until the picture arrives and when the map is zoomed out. An entry with no `image` is accompanied by a small gray square in every view.

---

## Colophon

Data in Dialogue was conceived and is maintained by <a href="https://mariandoerk.de">Marian Dörk</a>. The interface concept is based on the ideas behind the <a href="#i:doerk2011information">Information Flaneur</a>, <a href="#i:doerk2014monadic">Monadic Exploration</a>, and <a href="#i:brueggemann2020fold">The Fold</a>. All text is set in <a href="https://www.brailleinstitute.org/freefont/">Atkinson Hyperlegible Next</a>. The search relies on the <a href="https://tartarus.org/martin/PorterStemmer/">Porter stemmer</a>, and the map uses <a href="https://umap-learn.readthedocs.io/">UMAP</a> to place entries with similar sets of keywords close to each other.

While the design and curation are my own, the <a href="https://github.com/uclab-potsdam/data-in-dialogue">code</a> of the interface was written with Claude (Opus 4.5–5.5). It began as a personal experiment in prototyping with a large language model. Since then, I have become increasingly uneasy about the immense energy these tools consume and the human labor they make invisible.

This webpage does not track you. It sets no cookies and stores nothing about your visit.

## License

The interface code is available under the [MIT License](LICENSE). The collection itself is not mine to license: each entry quotes an abstract or description and a teaser image from the work it describes, for the purpose of learning and scholarly exchange, with credit and a link to the original source. 

If you know of something that should be added, notice something that needs fixing, or hold the rights to an item whose entry should be changed or removed, please [email me](mailto:marian.doerk@fh-potsdam.de).
