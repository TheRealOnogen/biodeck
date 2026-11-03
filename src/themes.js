// CSS themes from themes.json (hot-reloaded).
const path = require('path');
const fs = require('fs');
const { ROOT_DIR } = require('./paths');

// CSS theme switcher
// Themes are declared in themes.json (project root) as an array of { name, displayName, file }
// objects.
const THEMES_FILE = path.join(ROOT_DIR, 'themes.json');
const FALLBACK_THEME = { name: 'default', displayName: 'Default', file: 'styles.css' };
let themesCache = null;
let themesCacheMtimeMs = 0;

function loadThemes() {
    try {
        const stat = fs.statSync(THEMES_FILE);
        if (themesCache && stat.mtimeMs === themesCacheMtimeMs) return themesCache;
        const parsed = JSON.parse(fs.readFileSync(THEMES_FILE, 'utf8'));
        if (!Array.isArray(parsed)) throw new Error('themes.json must contain a JSON array');
        const clean = parsed.filter(t => t && typeof t.name === 'string' && t.name.trim()
            && typeof t.displayName === 'string' && t.displayName.trim()
            && typeof t.file === 'string' && t.file.trim());
        if (!clean.some(t => t.name === 'default')) clean.unshift(FALLBACK_THEME);
        themesCache = clean;
        themesCacheMtimeMs = stat.mtimeMs;
        return clean;
    } catch (e) {
        console.error('Failed to load themes.json, falling back to the default theme only:', e.message);
        return [FALLBACK_THEME];
    }
}

function getThemeByName(name) {
    const themes = loadThemes();
    return themes.find(t => t.name === name)
        || themes.find(t => t.name === 'default')
        || themes[0]
        || FALLBACK_THEME;
}

// Resolves a theme's `file` to an absolute path inside public/, refusing to serve anything outside
// that directory.
function resolveThemeCSSPath(theme) {
    const publicDir = path.join(ROOT_DIR, 'public');
    const resolved = path.resolve(publicDir, theme.file);
    if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
        return path.join(publicDir, FALLBACK_THEME.file);
    }
    return resolved;
}

module.exports = { FALLBACK_THEME, getThemeByName, loadThemes, resolveThemeCSSPath };
