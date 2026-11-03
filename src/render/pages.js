// Simple message page renderer.
const { escapeHTML } = require('./html');

// Renders the same box/button chrome used elsewhere (ban/deleted screens, etc.)
function renderMessagePage(title, heading, bodyHTML) {
    return `<!DOCTYPE html>
<html lang="en">
<head><link rel="icon" type="image/x-icon" href="/Biodeck.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300..700&display=swap">
<link rel="stylesheet" href="/theme.css">
</head>
<body>
    <div class="box" style="color: var(--text-color); height: auto; width: 500px; max-width: 90vw; word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; padding: 30px;">
        <h1>${escapeHTML(heading)}</h1><br>
        ${bodyHTML}
    </div>
    <script>
        document.querySelectorAll('.button').forEach(btn => {
            btn.addEventListener('mousedown', () => {
                btn.classList.add('clicked');
                setTimeout(() => btn.classList.remove('clicked'), 150);
            });
        });
    </script>
</body>
</html>`;
}

module.exports = { renderMessagePage };
