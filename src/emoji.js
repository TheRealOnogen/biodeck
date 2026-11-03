// Custom emojis, shortcodes and jumbo-emoji handling.
const path = require('path');
const fs = require('fs');
const { ROOT_DIR } = require('./paths');
const { escapeHTML } = require('./render/html');

// Custom emojis (emojis.json + public/emojis/)
// Works like themes: drop an image into public/emojis/ and register it in emojis.json (project
// root), an array of { name.
const EMOJIS_FILE = path.join(ROOT_DIR, 'emojis.json');
const EMOJIS_DIR = path.join(ROOT_DIR, 'public', 'emojis');
const CUSTOM_EMOJI_NAME_REGEX = /^[a-z0-9_-]{1,32}$/;
const CUSTOM_EMOJI_EXTS = ['.png', '.gif', '.webp', '.jpg', '.jpeg', '.svg', '.avif', '.apng'];

// ":name:" - not directly after a letter/digit/slash, so "12:30:45" and "https://host/:thing:" are
// left alone.
const CUSTOM_EMOJI_TOKEN_REGEX = /(?<![A-Za-z0-9\/]):([A-Za-z0-9_-]{1,32}):/g;
if (!fs.existsSync(EMOJIS_DIR)) fs.mkdirSync(EMOJIS_DIR, { recursive: true });

let customEmojiCache = new Map();   // lowercased name -> { name, filename, url }
let customEmojiCacheKey = null;
let customEmojiLastCheck = 0;

// Returns the current emoji map. loadCustomEmojis() runs for every rendered post, so the disk is
// only looked at once a second.
function loadCustomEmojis() {
    const now = Date.now();
    if (customEmojiCacheKey !== null && now - customEmojiLastCheck < 1000) return customEmojiCache;
    customEmojiLastCheck = now;

    let jsonMtime = 0, dirMtime = 0;
    try { jsonMtime = fs.statSync(EMOJIS_FILE).mtimeMs; } catch (e) { /* no emojis.json -> no custom emojis */ }
    try { dirMtime = fs.statSync(EMOJIS_DIR).mtimeMs; } catch (e) { /* folder gone -> entries below get skipped */ }
    const key = jsonMtime + ':' + dirMtime;
    if (key === customEmojiCacheKey) return customEmojiCache;
    customEmojiCacheKey = key;

    if (!jsonMtime) { customEmojiCache = new Map(); return customEmojiCache; }
    try {
        const parsed = JSON.parse(fs.readFileSync(EMOJIS_FILE, 'utf8'));
        if (!Array.isArray(parsed)) throw new Error('emojis.json must contain a JSON array');
        const map = new Map();
        parsed.forEach((entry, i) => {
            const where = `emojis.json entry #${i + 1}`;
            const rawName = entry && typeof entry.name === 'string' ? entry.name.trim() : '';
            const filename = entry && (typeof entry.filename === 'string' ? entry.filename : entry.file);
            const name = rawName.toLowerCase();
            if (!CUSTOM_EMOJI_NAME_REGEX.test(name)) {
                return console.warn(`${where}: skipped - "${rawName}" is not a valid name (letters, numbers, _ and - only, no spaces, max 32 characters).`);
            }
            if (typeof filename !== 'string' || !filename || path.basename(filename) !== filename
                || !CUSTOM_EMOJI_EXTS.includes(path.extname(filename).toLowerCase())) {
                return console.warn(`${where} (${name}): skipped - "filename" must be an image file name (${CUSTOM_EMOJI_EXTS.join(', ')}) inside public/emojis/.`);
            }
            let isFile = false;
            try { isFile = fs.statSync(path.join(EMOJIS_DIR, filename)).isFile(); } catch (e) { /* missing */ }
            if (!isFile) return console.warn(`${where} (${name}): skipped - public/emojis/${filename} does not exist.`);
            if (map.has(name)) return console.warn(`${where}: skipped - duplicate name "${name}".`);
            map.set(name, { name, filename, url: '/emojis/' + encodeURIComponent(filename) });
        });
        customEmojiCache = map;
    } catch (e) {
        // Keep serving the last good list so a typo made mid-edit doesn't suddenly turn every
        // custom emoji back into plain ":text:".
        console.error('Failed to load emojis.json, keeping the previous emoji list:', e.message);
    }
    return customEmojiCache;
}

// The image is shown exactly as uploaded: no rounding, border, shadow, filter, padding or cropping.
const CUSTOM_EMOJI_SIZE = '1.5em';
const CUSTOM_EMOJI_SIZE_JUMBO = '3em';
function customEmojiImgHTML(entry, height) {
    const label = escapeHTML(`:${entry.name}:`);
    const h = height || CUSTOM_EMOJI_SIZE;
    const maxW = (parseFloat(h) * 4) + 'em';
    return `<img class="custom-emoji" src="${escapeHTML(entry.url)}" alt="${label}" title="${label}" draggable="false" style="height:${h} !important;width:auto !important;max-width:${maxW} !important;min-width:0 !important;max-height:none !important;object-fit:contain !important;aspect-ratio:auto !important;border-radius:0 !important;border:0 !important;outline:0 !important;box-shadow:none !important;background:none !important;filter:none !important;clip-path:none !important;padding:0 !important;margin:0 0.05em !important;vertical-align:-0.35em;display:inline-block;">`;
}

// "Jumbo" emoji: a message made only of emoji is shown bigger
// Triggers when, ignoring whitespace, the text is nothing but known custom :emojis: and/or ordinary
// Unicode emoji.
const JUMBO_EMOJI_MAX = 27;
const JUMBO_UNICODE_FONT_SIZE = '2.6em';
const UNICODE_EMOJI_REGEX = /(?:\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/gu;
function isEmojiOnlyText(text) {
    if (!text) return false;
    const emojis = loadCustomEmojis();
    let count = 0;
    const rest = String(text)
        .replace(CUSTOM_EMOJI_TOKEN_REGEX, (m, name) => emojis.has(name.toLowerCase()) ? (count++, '') : m)
        .replace(UNICODE_EMOJI_REGEX, () => (count++, ''))
        .replace(/[\s\uFE0F\u200D]+/g, '');
    return count > 0 && count <= JUMBO_EMOJI_MAX && rest === '';
}

// Swaps every known ":name:" in already-escaped text for its <img>.
function replaceCustomEmojis(escapedText, wrap, height) {
    if (!escapedText || escapedText.indexOf(':') === -1) return escapedText;
    const emojis = loadCustomEmojis();
    if (!emojis.size) return escapedText;
    return escapedText.replace(CUSTOM_EMOJI_TOKEN_REGEX, (m, name) => {
        const entry = emojis.get(name.toLowerCase());
        if (!entry) return m;
        const html = customEmojiImgHTML(entry, height);
        return wrap ? wrap(html) : html;
    });
}

// A reaction is stored as plain text; a custom one is just ":name:".
function renderReactionEmojiHTML(emoji) {
    const m = /^:([A-Za-z0-9_-]{1,32}):$/.exec(emoji || '');
    const entry = m && loadCustomEmojis().get(m[1].toLowerCase());
    return entry ? customEmojiImgHTML(entry, '1.25em') : escapeHTML(emoji);
}

// Emoji shortcodes (":smile:" -> 😄)
// The map + typing/autocomplete logic is served as one cacheable script so it isn't repeated inside
// every page's HTML.
const EMOJI_BUILTIN_MAP = {"smile":"😄","smiley":"😃","grin":"😁","grinning":"😀","laughing":"😆","joy":"😂","rofl":"🤣","sweat_smile":"😅","blush":"😊","innocent":"😇","wink":"😉","slight_smile":"🙂","upside_down":"🙃","relieved":"😌","heart_eyes":"😍","smiling_face_with_hearts":"🥰","kissing_heart":"😘","yum":"😋","stuck_out_tongue":"😛","stuck_out_tongue_winking_eye":"😜","zany_face":"🤪","nerd":"🤓","sunglasses":"😎","star_struck":"🤩","partying_face":"🥳","smirk":"😏","unamused":"😒","disappointed":"😞","pensive":"😔","worried":"😟","confused":"😕","slight_frown":"🙁","frowning":"☹️","persevere":"😣","cry":"😢","sob":"😭","triumph":"😤","angry":"😠","rage":"😡","cursing":"🤬","exploding_head":"🤯","flushed":"😳","scream":"😱","fearful":"😨","cold_sweat":"😰","sweat":"😓","hugs":"🤗","thinking":"🤔","shushing_face":"🤫","lying_face":"🤥","neutral_face":"😐","expressionless":"😑","no_mouth":"😶","rolling_eyes":"🙄","grimacing":"😬","sleeping":"😴","sleepy":"😪","drooling_face":"🤤","mask":"😷","nauseated_face":"🤢","vomiting":"🤮","sneezing_face":"🤧","hot_face":"🥵","cold_face":"🥶","woozy_face":"🥴","dizzy_face":"😵","cowboy":"🤠","clown":"🤡","ghost":"👻","skull":"💀","skull_and_crossbones":"☠️","alien":"👽","robot":"🤖","poop":"💩","imp":"👿","smiling_imp":"😈","pleading":"🥺","melting_face":"🫠","salute":"🫡","face_holding_back_tears":"🥹","yawning_face":"🥱","monocle":"🧐","zipper_mouth":"🤐","money_mouth":"🤑","face_with_raised_eyebrow":"🤨","smiling_face_with_tear":"🥲","thumbsup":"👍","+1":"👍","thumbsdown":"👎","-1":"👎","ok_hand":"👌","pinched_fingers":"🤌","v":"✌️","crossed_fingers":"🤞","metal":"🤘","call_me":"🤙","point_left":"👈","point_right":"👉","point_up":"👆","point_down":"👇","raised_hand":"✋","wave":"👋","clap":"👏","raised_hands":"🙌","open_hands":"👐","pray":"🙏","handshake":"🤝","muscle":"💪","fist":"✊","punch":"👊","writing_hand":"✍️","nail_care":"💅","eyes":"👀","eye":"👁️","brain":"🧠","tongue":"👅","lips":"👄","ear":"👂","nose":"👃","facepalm":"🤦","shrug":"🤷","bow":"🙇","100":"💯","heart":"❤️","orange_heart":"🧡","yellow_heart":"💛","green_heart":"💚","blue_heart":"💙","purple_heart":"💜","black_heart":"🖤","white_heart":"🤍","brown_heart":"🤎","broken_heart":"💔","sparkling_heart":"💖","heartpulse":"💗","two_hearts":"💕","revolving_hearts":"💞","heart_exclamation":"❣️","fire":"🔥","sparkles":"✨","star":"⭐","star2":"🌟","boom":"💥","collision":"💥","zap":"⚡","dizzy":"💫","sweat_drops":"💦","dash":"💨","zzz":"💤","anger":"💢","speech_balloon":"💬","thought_balloon":"💭","bulb":"💡","bell":"🔔","no_bell":"🔕","warning":"⚠️","no_entry":"⛔","x":"❌","white_check_mark":"✅","heavy_check_mark":"✔️","question":"❓","exclamation":"❗","grey_question":"❔","infinity":"♾️","recycle":"♻️","peace":"☮️","yin_yang":"☯️","radioactive":"☢️","biohazard":"☣️","dog":"🐶","cat":"🐱","mouse":"🐭","hamster":"🐹","rabbit":"🐰","fox":"🦊","bear":"🐻","panda":"🐼","koala":"🐨","tiger":"🐯","lion":"🦁","cow":"🐮","pig":"🐷","frog":"🐸","monkey":"🐵","see_no_evil":"🙈","hear_no_evil":"🙉","speak_no_evil":"🙊","chicken":"🐔","penguin":"🐧","bird":"🐦","duck":"🦆","eagle":"🦅","owl":"🦉","bat":"🦇","wolf":"🐺","horse":"🐴","unicorn":"🦄","bee":"🐝","bug":"🐛","butterfly":"🦋","snail":"🐌","ladybug":"🐞","spider":"🕷️","scorpion":"🦂","turtle":"🐢","snake":"🐍","lizard":"🦎","octopus":"🐙","squid":"🦑","shrimp":"🦐","crab":"🦀","fish":"🐟","tropical_fish":"🐠","dolphin":"🐬","whale":"🐳","shark":"🦈","crocodile":"🐊","elephant":"🐘","giraffe":"🦒","kangaroo":"🦘","sloth":"🦥","otter":"🦦","dragon":"🐉","t_rex":"🦖","dino":"🦕","sunny":"☀️","cloud":"☁️","rainbow":"🌈","snowflake":"❄️","snowman":"⛄","umbrella":"☂️","ocean":"🌊","earth_americas":"🌎","earth_africa":"🌍","earth_asia":"🌏","moon":"🌙","full_moon":"🌕","new_moon":"🌑","sun_with_face":"🌞","comet":"☄️","rose":"🌹","sunflower":"🌻","tulip":"🌷","cherry_blossom":"🌸","hibiscus":"🌺","seedling":"🌱","evergreen_tree":"🌲","palm_tree":"🌴","cactus":"🌵","four_leaf_clover":"🍀","maple_leaf":"🍁","fallen_leaf":"🍂","mushroom":"🍄","volcano":"🌋","apple":"🍎","green_apple":"🍏","banana":"🍌","grapes":"🍇","watermelon":"🍉","strawberry":"🍓","cherries":"🍒","peach":"🍑","pineapple":"🍍","lemon":"🍋","orange":"🍊","avocado":"🥑","eggplant":"🍆","carrot":"🥕","corn":"🌽","hot_pepper":"🌶️","broccoli":"🥦","potato":"🥔","tomato":"🍅","bread":"🍞","croissant":"🥐","cheese":"🧀","egg":"🥚","bacon":"🥓","hamburger":"🍔","fries":"🍟","pizza":"🍕","hotdog":"🌭","sandwich":"🥪","taco":"🌮","burrito":"🌯","spaghetti":"🍝","ramen":"🍜","sushi":"🍣","rice":"🍚","curry":"🍛","dumpling":"🥟","popcorn":"🍿","doughnut":"🍩","cookie":"🍪","cake":"🎂","cupcake":"🧁","pie":"🥧","chocolate_bar":"🍫","candy":"🍬","lollipop":"🍭","icecream":"🍦","coffee":"☕","tea":"🍵","beer":"🍺","beers":"🍻","wine_glass":"🍷","cocktail":"🍸","champagne":"🍾","milk":"🥛","cup_with_straw":"🥤","boba":"🧋","soccer":"⚽","basketball":"🏀","football":"🏈","baseball":"⚾","tennis":"🎾","volleyball":"🏐","8ball":"🎱","trophy":"🏆","medal":"🏅","dart":"🎯","video_game":"🎮","joystick":"🕹️","game_die":"🎲","chess_pawn":"♟️","puzzle":"🧩","guitar":"🎸","piano":"🎹","drum":"🥁","trumpet":"🎺","violin":"🎻","microphone":"🎤","headphones":"🎧","musical_note":"🎵","notes":"🎶","art":"🎨","clapper":"🎬","tada":"🎉","confetti_ball":"🎊","balloon":"🎈","gift":"🎁","ribbon":"🎀","crown":"👑","gem":"💎","ring":"💍","moneybag":"💰","dollar":"💵","credit_card":"💳","key":"🔑","lock":"🔒","unlock":"🔓","hammer":"🔨","wrench":"🔧","gear":"⚙️","link":"🔗","paperclip":"📎","pushpin":"📌","scissors":"✂️","pencil":"✏️","pen":"🖊️","memo":"📝","book":"📖","books":"📚","newspaper":"📰","calendar":"📅","chart_with_upwards_trend":"📈","chart_with_downwards_trend":"📉","clipboard":"📋","file_folder":"📁","package":"📦","mailbox":"📫","email":"📧","inbox_tray":"📥","outbox_tray":"📤","phone":"📱","telephone":"☎️","computer":"💻","desktop":"🖥️","keyboard":"⌨️","mouse_computer":"🖱️","floppy_disk":"💾","cd":"💿","tv":"📺","camera":"📷","video_camera":"📹","movie_camera":"🎥","battery":"🔋","electric_plug":"🔌","flashlight":"🔦","candle":"🕯️","telescope":"🔭","microscope":"🔬","pill":"💊","syringe":"💉","dna":"🧬","magnet":"🧲","bomb":"💣","shield":"🛡️","dagger":"🗡️","crossed_swords":"⚔️","gun":"🔫","hourglass":"⌛","alarm_clock":"⏰","stopwatch":"⏱️","watch":"⌚","mag":"🔍","mag_right":"🔎","loud_sound":"🔊","mute":"🔇","mega":"📣","loudspeaker":"📢","flag_white":"🏳️","flag_black":"🏴","checkered_flag":"🏁","pirate_flag":"🏴‍☠️","rainbow_flag":"🏳️‍🌈","ua":"🇺🇦","us":"🇺🇸","gb":"🇬🇧","de":"🇩🇪","fr":"🇫🇷","es":"🇪🇸","it":"🇮🇹","jp":"🇯🇵","kr":"🇰🇷","cn":"🇨🇳","ca":"🇨🇦","pl":"🇵🇱","br":"🇧🇷","car":"🚗","taxi":"🚕","bus":"🚌","racing_car":"🏎️","bike":"🚲","motorcycle":"🏍️","train":"🚆","airplane":"✈️","rocket":"🚀","ufo":"🛸","helicopter":"🚁","ship":"🚢","boat":"⛵","anchor":"⚓","house":"🏠","office":"🏢","school":"🏫","hospital":"🏥","castle":"🏰","tent":"⛺","mountain":"⛰️","beach":"🏖️","statue_of_liberty":"🗽","tokyo_tower":"🗼","ferris_wheel":"🎡","roller_coaster":"🎢","baby":"👶","boy":"👦","girl":"👧","man":"👨","woman":"👩","older_man":"👴","older_woman":"👵","santa":"🎅","mage":"🧙","vampire":"🧛","zombie":"🧟","genie":"🧞","fairy":"🧚","ninja":"🥷","detective":"🕵️","astronaut":"🧑‍🚀","angel":"👼","princess":"👸","prince":"🤴","superhero":"🦸","supervillain":"🦹","dancer":"💃","man_dancing":"🕺","runner":"🏃","walking":"🚶","swimmer":"🏊","skier":"⛷️","surfer":"🏄","bath":"🛀","sleeping_accommodation":"🛌","footprints":"👣","busts_in_silhouette":"👥","bust_in_silhouette":"👤","couple":"👫","family":"👪","tshirt":"👕","jeans":"👖","dress":"👗","bikini":"👙","shoe":"👞","sneaker":"👟","high_heel":"👠","boot":"👢","tophat":"🎩","mortar_board":"🎓","crown_hat":"👑","glasses":"👓","dark_sunglasses":"🕶️","lipstick":"💄","arrow_up":"⬆️","arrow_down":"⬇️","arrow_left":"⬅️","arrow_right":"➡️","arrows_counterclockwise":"🔄","repeat":"🔁","red_circle":"🔴","orange_circle":"🟠","yellow_circle":"🟡","green_circle":"🟢","blue_circle":"🔵","purple_circle":"🟣","black_circle":"⚫","white_circle":"⚪","red_square":"🟥","blue_square":"🟦","green_square":"🟩","black_large_square":"⬛","white_large_square":"⬜","diamond":"🔷","small_orange_diamond":"🔸","tm":"™️","copyright":"©️","registered":"®️"};

// This function is never called on the server - emojiShortcodeClient.toString() is sent to the
// browser.
function emojiShortcodeClient(MAP) {
    // Custom emojis (emojis.json)
    // Unlike the built-in ones these are images, so ":name:" is NOT swapped for a character while
    // typing.
    var CUSTOM = Object.create(null);   // name -> image url
    var customList = [];                // [{ name, url }] in emojis.json order
    var customLoadedAt = 0, customLoading = false;
    var NAMES = [];

    function rebuildNames() {
        var seen = Object.create(null);
        NAMES = Object.keys(MAP).concat(customList.map(function (e) { return e.name; }))
            .filter(function (n) { if (seen[n]) return false; seen[n] = true; return true; })
            .sort();
    }

    function setCustom(list) {
        CUSTOM = Object.create(null);
        customList = [];
        (Array.isArray(list) ? list : []).forEach(function (e) {
            if (e && typeof e.name === 'string' && typeof e.url === 'string' && CUSTOM[e.name] === undefined) {
                CUSTOM[e.name] = e.url;
                customList.push({ name: e.name, url: e.url });
            }
        });
        window.CUSTOM_EMOJI_LIST = customList;
        rebuildNames();
    }

    // Re-fetched at most every 30s (on focusing a text box), so an emoji the admin just added shows
    // up without a page reload.
    function loadCustom(force) {
        if (customLoading) return;
        if (!force && customLoadedAt && Date.now() - customLoadedAt < 30000) return;
        customLoading = true;
        fetch('/custom-emojis.json', { cache: 'no-cache' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (list) { if (list) setCustom(list); })
            .catch(function () {})
            .then(function () { customLoading = false; customLoadedAt = Date.now(); });
    }

    function escAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    // HTML for a scrollable row of custom-emoji buttons.
    window.customEmojiPickerHTML = function (btnClass) {
        if (!customList.length) return '';
        var html = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;max-height:136px;overflow-y:auto;">';
        customList.forEach(function (e) {
            html += '<button type="button" class="' + escAttr(btnClass) + '" data-emoji=":' + escAttr(e.name) + ':" title=":' + escAttr(e.name) + ':" ' +
                'style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0 !important;margin:0;box-sizing:border-box;border-radius:50%;border:1px solid var(--post-border-color);background:transparent;cursor:pointer;">' +
                '<img src="' + escAttr(e.url) + '" alt=":' + escAttr(e.name) + ':" draggable="false" style="width:18px;height:18px;object-fit:contain;border-radius:0 !important;border:0 !important;padding:0 !important;margin:0 !important;box-shadow:none !important;filter:none !important;"></button>';
        });
        return html + '</div>';
    };

    rebuildNames();
    loadCustom(true);

    // Shortcodes + autocomplete
    var busy = false;
    var pop = null, popItems = [], popIndex = 0, popTarget = null, popRange = null;

    function isTextTarget(el) {
        if (!el || el.dataset && el.dataset.noEmoji !== undefined) return false;
        if (el.tagName === 'TEXTAREA') return true;
        return el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search') && el.name !== 'username' && el.name !== 'password';
    }

    // Finds a ":partial" token that ends exactly at the caret.
    function currentToken(el) {
        var pos = el.selectionStart;
        if (pos == null || pos !== el.selectionEnd) return null;
        var before = el.value.slice(0, pos);
        var m = /(^|[\s(])(:([a-z0-9_+\-]{1,32}))$/i.exec(before);
        if (!m) return null;
        return { start: pos - m[2].length, end: pos, name: m[3].toLowerCase() };
    }

    function replaceRange(el, start, end, text) {
        busy = true;
        try {
            el.focus();
            el.setSelectionRange(start, end);
            if (typeof el.setRangeText === 'function') el.setRangeText(text, start, end, 'end');
            else { el.value = el.value.slice(0, start) + text + el.value.slice(end); el.setSelectionRange(start + text.length, start + text.length); }
            // Let existing listeners (character counters etc.) know the value changed.
            el.dispatchEvent(new Event('input', { bubbles: true }));
        } finally { busy = false; }
    }

    function closePopup() {
        if (pop) { pop.remove(); pop = null; }
        popItems = []; popTarget = null; popRange = null;
    }

    function renderPopup() {
        if (!pop) return;
        pop.innerHTML = '';
        popItems.forEach(function (name, i) {
            var row = document.createElement('div');
            row.className = 'emoji-ac-row';
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;border-radius:6px;' +
                (i === popIndex ? 'background:rgba(127,127,127,0.25);' : '');
            var ico = document.createElement('span');
            ico.style.cssText = 'font-size:1.25em;width:1.6em;text-align:center;display:inline-flex;align-items:center;justify-content:center;';
            if (CUSTOM[name] !== undefined) {
                var img = document.createElement('img');
                img.src = CUSTOM[name];
                img.alt = '';
                img.style.cssText = 'height:1.1em;width:auto;max-width:1.6em;object-fit:contain;border-radius:0 !important;border:0 !important;padding:0 !important;margin:0 !important;box-shadow:none !important;filter:none !important;';
                ico.appendChild(img);
            } else {
                ico.textContent = MAP[name];
            }
            var lbl = document.createElement('span');
            lbl.textContent = ':' + name + ':';
            row.appendChild(ico); row.appendChild(lbl);
            row.addEventListener('mousedown', function (e) { e.preventDefault(); pick(i); });
            row.addEventListener('mouseenter', function () { popIndex = i; renderPopup(); });
            pop.appendChild(row);
        });
    }

    function positionPopup(el) {
        var r = el.getBoundingClientRect();
        pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 260)) + 'px';
        if (r.top > 260) { pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; pop.style.top = 'auto'; }
        else { pop.style.top = (r.bottom + 4) + 'px'; pop.style.bottom = 'auto'; }
    }

    function openPopup(el, tok, matches) {
        if (!pop) {
            pop = document.createElement('div');
            pop.id = 'emoji-autocomplete';
            pop.style.cssText = 'position:fixed;z-index:10000;min-width:200px;max-width:260px;padding:4px;font-size:0.9em;' +
                'color:var(--text-color);background:var(--popover-bg, #222);border:var(--popover-border, 1px solid rgba(127,127,127,0.4));' +
                'border-radius:var(--popover-border-radius, 8px);box-shadow:0 4px 16px rgba(0,0,0,0.35);';
            document.body.appendChild(pop);
        }
        popItems = matches; popIndex = 0; popTarget = el; popRange = tok;
        renderPopup();
        positionPopup(el);
    }

    function pick(i) {
        var name = popItems[i];
        if (!name || !popTarget) return closePopup();
        var el = popTarget;
        var tok = currentToken(el) || popRange;
        closePopup();
        // Insert the emoji plus a trailing space, like Discord's picker does.
        var text = CUSTOM[name] !== undefined ? ':' + name + ': ' : MAP[name] + ' ';
        replaceRange(el, tok.start, tok.end, text);
    }

    document.addEventListener('input', function (e) {
        if (busy) return;
        var el = e.target;
        if (!isTextTarget(el)) return;
        loadCustom(false);

        // 1) Finished shortcode ":name:" right before the caret -> swap for the emoji.
        var pos = el.selectionStart;
        if (pos != null && pos === el.selectionEnd) {
            var before = el.value.slice(0, pos);
            var m = /(^|[\s(]):([a-z0-9_+\-]{1,32}):$/i.exec(before);
            if (m) {
                var name = m[2].toLowerCase();
                // Custom emoji (wins over a built-in with the same name): leave the ":name:" text
                // alone, it becomes an image once posted.
                if (CUSTOM[name] !== undefined) { closePopup(); return; }
                if (Object.prototype.hasOwnProperty.call(MAP, name)) {
                    closePopup();
                    var start = pos - name.length - 2;
                    replaceRange(el, start, pos, MAP[name]);
                    return;
                }
            }
        }

        // 2) Still typing ":par" -> show suggestions (needs 2+ characters).
        var tok = currentToken(el);
        if (!tok || tok.name.length < 2) return closePopup();
        var starts = [], contains = [];
        for (var i = 0; i < NAMES.length; i++) {
            var n = NAMES[i];
            if (n.indexOf(tok.name) === 0) starts.push(n);
            else if (n.indexOf(tok.name) > 0) contains.push(n);
        }
        var matches = starts.concat(contains).slice(0, 8);
        if (!matches.length) return closePopup();
        openPopup(el, tok, matches);
    });

    // Capture phase so we run before the chat boxes' own "Enter = send" handlers.
    document.addEventListener('keydown', function (e) {
        if (!pop) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); popIndex = (popIndex + 1) % popItems.length; renderPopup(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); popIndex = (popIndex - 1 + popItems.length) % popItems.length; renderPopup(); }
        else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); e.stopImmediatePropagation(); pick(popIndex); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePopup(); }
    }, true);

    document.addEventListener('focusout', function (e) { if (e.target === popTarget) setTimeout(closePopup, 120); });
    window.addEventListener('resize', closePopup);
    document.addEventListener('scroll', function () { if (pop && popTarget) positionPopup(popTarget); }, true);
}

const EMOJI_SHORTCODE_JS = '/* Emoji shortcode + custom emoji support (":smile:" -> 😄) + autocomplete. Served from server.js */\n'
    + '(' + emojiShortcodeClient.toString() + ')(' + JSON.stringify(EMOJI_BUILTIN_MAP) + ');\n';

module.exports = {
    CUSTOM_EMOJI_SIZE_JUMBO,
    EMOJI_SHORTCODE_JS,
    JUMBO_UNICODE_FONT_SIZE,
    UNICODE_EMOJI_REGEX,
    isEmojiOnlyText,
    loadCustomEmojis,
    renderReactionEmojiHTML,
    replaceCustomEmojis,
};
