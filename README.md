![logo](img/icon128.png)

# New Netflix 1080p

Chrome extension to play Netflix in 1080p and 5.1 as well as other QoL improvements.

# Diagnostic build

Branch `fix/discard-quality-drop` is a local diagnostic build of 1.34.0. It keeps the original bitrate selection. Capture steps, the settings handoff, and the device/fixture boundary are in [docs/diagnostic.md](docs/diagnostic.md).

Unpacked extension ID: `paaingnmhpdddlckkplellcbindblmkd`. Disable the Web Store extension (`mdlbikciddolbenfkgggdegphnhmnfcg`) before loading this one.

# Installation

[Download the extension from the Chrome Webstore](https://chromewebstore.google.com/detail/new-netflix-1080p/mdlbikciddolbenfkgggdegphnhmnfcg)

## Manual Installation

If you can't or don't want to install the extension from the webstore, you can follow these steps:

1. Go to the Releases section and download the latest .crx file
2. Go to the Extensions settings of your Chrome browser and toggle "Developer Mode" in the upper right corner.
3. Drag the downloaded .crx file into the Extensions window to install it

## Manual Installation (Windows)

1. Go to the Releases section and download the latest release's source code as a zip file
2. Unzip the file somewhere where you want to "install" it
3. Go to the Extensions settings of your Chrome browser and toggle "Developer Mode" in the upper right corner.
4. Click on "Load unpacked" in the upper left corner and choose the directory of the unzipped source code from step 2.

# Thanks

This extension would not be possible without the work of serveral other people and their repos:

- https://github.com/truedread/netflix-1080p
- https://github.com/TheGoddessInari/netflix-1080p-firefox
- https://github.com/lkmvip/netflix-4K-DDplus

... and more.
