# GPX Overlay for Google Maps (Chrome extension)

Draws one or more local GPX files (tracks, routes, waypoints) over Google Maps.
Runs entirely locally: there are no servers, no API keys, and no network requests. Tracks are saved in `chrome.storage.local`.

<img width="1231" height="912" alt="image" src="https://github.com/user-attachments/assets/62cae19d-ef89-4ce5-9ab0-119b082716c4" />

## Install
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open https://www.google.com/maps.

## Use
- Click **Add GPX…** in the panel, or drag and drop `.gpx` files onto the map. You can load many files at once.
- For each track you can toggle it on or off, change its colour, zoom to it (⤢), or remove it (✕). **Fit all** zooms to every visible track.
- Use the sliders to set line width and opacity, and the checkbox to show or hide waypoints.
- **Show KM markers** adds numbered distance markers along each track. The spacing changes with zoom (1, 2, 5, 10 km…) so markers don't crowd together.
- **Show direction arrows** adds arrowheads along each track pointing in the direction of travel.
- **Colour by progress** colours each track from blue (start) through green and yellow to red (end). Later parts of a track are drawn on top, so where a route overlaps itself you can tell which pass is which. KM markers use the same colours.
- **Hover** over a route to see the distance from the start and the percentage of the route completed at that point. Where a route passes the same spot more than once, every pass is listed. With several tracks visible, each track's name is shown.
- The start of a track is marked green and the end red.
- Click the extension's toolbar icon to show or hide the panel.

## Limitations
- The overlay follows the map position in the page URL and is redrawn every time the URL changes, so it tracks live panning and zooming (including scroll-wheel zoom) without hiding.
- Map and satellite views use the same Web Mercator projection, so lines stay aligned in both, and the overlay is redrawn automatically when the map is resized.
- Tilted or rotated 3D views and Street View are not supported. Reset to a flat, north-up view to see the overlay.
- Only `google.com/maps` is supported. To use a country domain, add it to `matches` in `manifest.json`, for example `"https://www.google.co.uk/maps*"`.
