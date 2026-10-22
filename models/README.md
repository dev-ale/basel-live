# Vehicle models

Without anything here, Basel Live draws its own procedural trams and buses. To replace one with a real model,
put the `.glb` files in this folder and list them in `manifest.json`:

```json
{
  "bus": {
    "sections": ["citaro.glb"],
    "credit": "“Mercedes-Benz Citaro” by <author> (CC BY 4.0)",
    "rotate": [90, 0, 0],
    "scale": 1
  }
}
```

- **Keys** are the vehicle types in `vehicles3d.js`: `flexityLong`, `flexityShort`, `combino`, `tango`, `tina`,
  `busArtic`, `bus`.
- **sections**: one file per body section, front first, in metres. Articulated vehicles bend between sections, so a
  Citaro G needs its front and rear halves as two files (`busArtic` has two sections, 11.2 m and 6.9 m).
- **rotate**: degrees around x, then y, then z, so that the nose points to +x and the roof up (+z). glTF is y-up,
  so `[90, 0, 0]` stands a model up; add a z rotation if the nose points elsewhere.
- **credit** is shown in the map attribution. CC BY models must be credited.

Each section is centred on its bounding box and keeps its own materials and textures (no livery recolouring).
