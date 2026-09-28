Custom sky boxes for the CCTV viewer.

A sky box is either
  * a folder with six images named px, nx, py, ny, pz, nz (.png, .jpg or .webp):
    px = east (+X), nx = west (-X), py = up, ny = down, pz = south (+Z), nz = north (-Z), or
  * one equirectangular (360 x 180 degree) panorama image, e.g. sunset.jpg.

Optional settings in <name>.json next to it:
  {
    "brightness": 1.0,        // multiplier
    "followDaylight": true,   // darker at night like the normal sky
    "rotateWithSun": false,   // turn with the sun during the day
    "showSun": true,          // draw sun, moon and stars on top
    "showClouds": true
  }

Pick a sky box in the viewer ("Niebo" button) or set it for everybody in
config/cctv/config.json:  "viewer": { "skyboxes": { "minecraft:overworld": "sunset" } }
and run /cctv reload.

sunset.jpg is an example panorama: pick "sunset" in the viewer to try it.
