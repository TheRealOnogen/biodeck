// Read-only mode page injector and write guard.
const { renderMessagePage } = require('../render/pages');
const { READ_ONLY_MESSAGE } = require('../site-state');
const siteState = require('../site-state');

// Blocked for EVERYONE (staff included) while read-only mode is on.
const READ_ONLY_NEVER = [
    /^\/register$/,
    /^\/api\/v1\/auth\/register$/,
    /^\/api\/v1\/auth\/register-challenge$/,
    /^\/account\/data-export$/
];

// The only writes regular accounts may still make: signing in/out, read receipts, and switching
// their own theme.
const READ_ONLY_USER_WRITES = [
    /^\/edit\/theme$/,
    /^\/login$/,
    /^\/logout$/,
    /^\/api\/v1\/auth\/(login|code-login|logout)$/,
    /^\/account\/client-code$/,
    /^\/messages\/[^/]+\/(mark-read|presence)$/,
    /^\/api\/v1\/messages\/[^/]+\/mark-read$/,
    /^\/notifications\/mark-read$/
];

function readOnlyNormPath(req) {
    return ((req.path || '/').toLowerCase().replace(/\/+$/, '')) || '/';
}

function readOnlyReject(req, res) {
    if (String(req.headers.accept || '').includes('text/html')) {
        return res.status(403).send(renderMessagePage('Read-only mode', 'Biodeck is in read-only mode',
            `<h3>No changes can be made right now. You can still log in and read your messages.</h3><br><br>
            <button type="button" class="button" style="width: 150px" onclick="history.back();">Go back</button>`));
    }
    return res.status(403).json({ error: READ_ONLY_MESSAGE, code: 'read_only' });
}

// Server-side enforcement. Runs after checkBan, which is what sets req.isAdmin.
function readOnlyWriteGuard(req, res, next) {
    if (!siteState.readOnlyModeEnabled) return next();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const p = readOnlyNormPath(req);
    if (READ_ONLY_NEVER.some(re => re.test(p))) return readOnlyReject(req, res);
    if (req.isAdmin) return next();
    if (READ_ONLY_USER_WRITES.some(re => re.test(p))) return next();
    return readOnlyReject(req, res);
}

// Adds the banner (and, for regular accounts, strips text fields) on full HTML pages.
function readOnlyInjectHTML(html, req) {
    const staff = !!req.isAdmin;
    const p = readOnlyNormPath(req);
    const keepFields = staff || p === '/' || p === '/login' || p === '/register';
    const text = staff
        ? 'Biodeck is in read-only mode: no changes can be made to anything. (Staff accounts can still chat and use the admin tools.)'
        : 'Biodeck is in read-only mode: no changes can be made to anything. You can still log in and read your messages.';
    const banner = `<div id="ro-banner" role="status" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;background:rgb(200,60,60);color:#fff;text-align:center;padding:10px 14px;font-size:0.9em;line-height:1.35;box-sizing:border-box;font-family:'Quicksand',sans-serif;font-weight:600;">${text}</div>`;
    // Pushes the page down by the banner's height so nothing is hidden under it: the page itself
    // gets top padding.
    const shifter = `<script>(function(){
var b=document.getElementById('ro-banner');if(!b)return;
var H=0;
function shift(el){
  if(el.nodeType!==1||el===b||b.contains(el))return;
  var cs=getComputedStyle(el),pos=cs.position;
  if(pos!=='fixed'&&pos!=='sticky')return;
  if(el.getAttribute('data-ro-top')===null){
    var t=parseFloat(cs.top);
    if(isNaN(t)||t>120)return;
    el.setAttribute('data-ro-top',String(t));
  }
  el.style.setProperty('top',(parseFloat(el.getAttribute('data-ro-top'))+H)+'px','important');
}
function scan(root){
  if(root.nodeType!==1)return;
  shift(root);
  var all=root.querySelectorAll('*');
  for(var i=0;i<all.length;i++)shift(all[i]);
}
function fit(){
  // A page can have its own scroll area (the body, or a box near the top of the page) that is
  // as tall as the window. With the banner on top, the bottom of that area ends up off-screen and
  // its last part can't be scrolled to. Shrink any such area so it ends at the window's bottom.
  var vh=window.innerHeight;
  var list=document.querySelectorAll('body,body>*,body>*>*,body>*>*>*');
  var i,el;
  for(i=0;i<list.length;i++){
    el=list[i];
    if(el.getAttribute('data-ro-fit')!==null){el.style.removeProperty('max-height');el.style.removeProperty('min-height');el.removeAttribute('data-ro-fit');}
  }
  var de=document.documentElement,bodyFit=false;
  de.style.removeProperty('overflow-y');
  for(i=0;i<list.length;i++){
    el=list[i];
    if(el===b||b.contains(el))continue;
    var cs=getComputedStyle(el),oy=cs.overflowY;
    if(oy!=='auto'&&oy!=='scroll')continue;
    var r=el.getBoundingClientRect();
    var top=cs.position==='fixed'?r.top:r.top+(window.pageYOffset||0);
    if(r.height>=vh-H-2&&top+r.height>vh+1&&top<vh){
      el.setAttribute('data-ro-fit','1');
      el.style.setProperty('box-sizing','border-box','important');
      // min-height must be cleared too: a theme's min-height:100vh beats max-height, which
      // left the page taller than the window and produced a second (window) scrollbar.
      el.style.setProperty('min-height','0','important');
      el.style.setProperty('max-height',Math.max(120,Math.floor(vh-top))+'px','important');
      if(el===document.body)bodyFit=true;
    }
  }
  // When the body is the page's scroll area, the window itself must not also scroll.
  if(bodyFit&&de.scrollHeight>vh+1)de.style.setProperty('overflow-y','hidden','important');
}
function measure(){
  H=b.offsetHeight;
  var d=document.documentElement;
  d.style.setProperty('box-sizing','border-box','important');
  d.style.setProperty('padding-top',H+'px','important');
  d.style.setProperty('scroll-padding-top',(H+8)+'px');
  fit();
  var done=document.querySelectorAll('[data-ro-top]');
  for(var i=0;i<done.length;i++)shift(done[i]);
}
function init(){try{measure();scan(document.body);}catch(e){}setTimeout(function(){try{measure();}catch(e){}},600);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
window.addEventListener('load',function(){try{measure();scan(document.body);}catch(e){}});
window.addEventListener('resize',function(){try{measure();}catch(e){}});
try{new MutationObserver(function(ms){
  for(var i=0;i<ms.length;i++){var n=ms[i].addedNodes;for(var j=0;j<n.length;j++){try{scan(n[j]);}catch(e){}}}
}).observe(document.body,{childList:true,subtree:true});}catch(e){}
})();<\/script>`;
    const stripper = keepFields ? '' : `<script>(function(){
var SKIP={hidden:1,checkbox:1,radio:1,button:1,submit:1,reset:1,image:1,range:1,color:1};
function strip(){
  var els=document.querySelectorAll('textarea,input,[contenteditable=""],[contenteditable="true"]');
  for(var i=0;i<els.length;i++){
    var el=els[i];
    if(el.tagName==='INPUT'&&SKIP[(el.getAttribute('type')||'text').toLowerCase()])continue;
    var form=el.closest&&el.closest('form');
    if(el.id){var ls=document.querySelectorAll('label[for="'+el.id.replace(/"/g,'')+'"]');for(var j=0;j<ls.length;j++)ls[j].remove();}
    el.remove();
    if(form){var bs=form.querySelectorAll('button[type=submit],input[type=submit]');for(var k=0;k<bs.length;k++)bs[k].remove();}
  }
}
function run(){try{strip();}catch(e){}}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
try{new MutationObserver(run).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}
})();<\/script>`;
    let out = /<body[^>]*>/i.test(html)
        ? html.replace(/<body[^>]*>/i, (m) => m + '\n' + banner)
        : banner + html;
    const idx = out.toLowerCase().lastIndexOf('</body>');
    out = idx >= 0 ? out.slice(0, idx) + shifter + stripper + out.slice(idx) : out + shifter + stripper;
    return out;
}

function readOnlyPageInjector(req, res, next) {
    if (!siteState.readOnlyModeEnabled) return next();
    // Make sure a browser can't answer with a cached copy of the page from before read-only mode.
    if (String(req.headers.accept || '').includes('text/html')) {
        delete req.headers['if-none-match'];
        delete req.headers['if-modified-since'];
    }
    if (req.method === 'HEAD') return next();
    const origWrite = res.write, origEnd = res.end;
    const chunks = [];
    let mode = null; // null = not decided yet, 'pass' or 'buffer'
    const decide = () => {
        if (mode) return mode;
        const ct = String(res.getHeader('Content-Type') || '');
        mode = (/text\/html/i.test(ct) && res.statusCode !== 304 && res.statusCode !== 204
            && !res.getHeader('Content-Encoding') && !res.headersSent) ? 'buffer' : 'pass';
        return mode;
    };
    res.write = function (chunk, enc, cb) {
        if (decide() === 'pass') return origWrite.apply(res, arguments);
        if (typeof enc === 'function') { cb = enc; enc = undefined; }
        if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc || 'utf8'));
        if (typeof cb === 'function') process.nextTick(cb);
        return true;
    };
    res.end = function (chunk, enc, cb) {
        if (decide() === 'pass') return origEnd.apply(res, arguments);
        if (typeof chunk === 'function') { cb = chunk; chunk = null; enc = null; }
        else if (typeof enc === 'function') { cb = enc; enc = null; }
        if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc || 'utf8'));
        res.write = origWrite; res.end = origEnd;
        let body = Buffer.concat(chunks);
        const html = body.toString('utf8');
        if (/<body[\s>]/i.test(html)) {
            body = Buffer.from(readOnlyInjectHTML(html, req), 'utf8');
            res.removeHeader('ETag');
            res.removeHeader('Last-Modified');
            res.setHeader('Cache-Control', 'no-store');
        }
        res.setHeader('Content-Length', body.length);
        return origEnd.call(res, body, cb);
    };
    next();
}

module.exports = { readOnlyPageInjector, readOnlyWriteGuard };
