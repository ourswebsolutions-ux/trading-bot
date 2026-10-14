Application icon: `icon.svg` (source, same geometry as the in-app BrandMark) rendered to `icon.png` (1024×1024).
electron-builder derives the Windows `.ico` and macOS `.icns` from `icon.png`.
Regenerate: `convert -background none icon.svg -resize 1024x1024 icon.png`
