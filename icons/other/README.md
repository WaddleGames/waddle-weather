# SkyMonitor SVG icon pack

These icons are a cohesive, dark-dashboard weather set created for the attached `index.html`.
They replace the source file's emoji/pictogram accents without depending on an emoji font.

## Install

Copy the `icons/other` directory into the repository so the files live at:

```text
sky-monitor/icons/other/*.svg
```

The SVGs are intentionally standalone and can be used as `<img>` sources, CSS backgrounds, or inline SVGs. Use `width="1em" height="1em"` and `vertical-align:middle` when placing one beside text.

## Mapping

`icon-map.json` contains the direct emoji-to-file mapping found in the source. A few semantically related report types intentionally share one asset because the original UI used the same emoji for them:

- 🌨️ → `snow.svg` for hail, heavy snow, snow squalls, and blizzard conditions
- 🌊 → `water.svg` for flooding / flash flooding
- 🌪️ → `tornado.svg` for tornado / funnel cloud
- 🌫️ → `fog.svg` for fog and dust-storm labels
- 🌑…🌘 → the eight moon-phase assets

The icon preview is included as `icon-preview.html`.
