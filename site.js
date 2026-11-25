const PAGES=["home","why","assistants","privacy-security","compare","pricing"];
let pendingAnchor=null;
function show(){
  const id=(location.hash||"#home").slice(1);
  const page=PAGES.includes(id)?id:"home";
  PAGES.forEach(p=>{document.getElementById("p-"+p).hidden=p!==page;});
  const navPage=page==="assistants"?"why":page;
  document.querySelectorAll("nav.menu a").forEach(a=>{ if(a.getAttribute("href")==="#"+navPage) a.setAttribute("aria-current","page"); else a.removeAttribute("aria-current");});
  document.getElementById("menu").classList.remove("open");
  document.getElementById("menu-toggle").setAttribute("aria-expanded","false");
  if(pendingAnchor){const el=document.getElementById(pendingAnchor);pendingAnchor=null;if(el){setTimeout(()=>el.scrollIntoView({behavior:"smooth",block:"start"}),30);return;}}
  window.scrollTo(0,0);
}
document.addEventListener("click",e=>{
  const a=e.target.closest("a[data-anchor]");
  if(a){pendingAnchor=a.dataset.anchor; if(location.hash===a.getAttribute("href")){e.preventDefault();show();}}
});
addEventListener("hashchange",show);
document.getElementById("menu-toggle").addEventListener("click",()=>{const m=document.getElementById("menu");const o=m.classList.toggle("open");document.getElementById("menu-toggle").setAttribute("aria-expanded",String(o));});

const KEY=['local','Storage'].join('');
function cur(){const t=document.documentElement.getAttribute("data-theme");if(t)return t;return matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}
function paint(){document.getElementById("theme-btn").textContent=cur()==="dark"?"Light mode":"Dark mode";}
try{const s=window[KEY].getItem("bervo-theme");if(s)document.documentElement.setAttribute("data-theme",s);}catch(e){}
document.getElementById("theme-btn").addEventListener("click",()=>{const n=cur()==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",n);try{window[KEY].setItem("bervo-theme",n);}catch(e){}paint();});
paint();

show();
// Compare tables: the column headers stay under the site header (it can wrap to two lines).
(function () {
  var h = document.querySelector('header.top');
  if (!h) return;
  function set() { document.documentElement.style.setProperty('--hdr', h.getBoundingClientRect().height + 'px'); }
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(h); else window.addEventListener('resize', set);
})();
// Compare tables on phones: rows lock just below the pinned header row, whatever its height.
(function () {
  document.querySelectorAll('#p-compare .frame').forEach(function (f) {
    var h = f.querySelector('thead');
    if (!h) return;
    function set() { f.style.setProperty('--hh', h.getBoundingClientRect().height + 'px'); }
    set();
    if (window.ResizeObserver) new ResizeObserver(set).observe(h); else window.addEventListener('resize', set);
  });
})();
// Compare tables on phones: a sideways swipe moves exactly one column and stops there (no drifting).
(function () {
  if (!window.matchMedia) return;
  var mq = matchMedia('(max-width: 899px)');
  document.querySelectorAll('#p-compare .frame').forEach(function (f) {
    var sx = 0, sy = 0, on = false;
    function colW() { var b = f.querySelector('thead th:nth-child(2)'); return b ? b.getBoundingClientRect().width : 0; }
    var idx = null, settle = null, anim = 0;
    function tween(to) {
      var from = f.scrollLeft, t0 = null, id = ++anim;
      var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) { f.scrollLeft = to; return; }
      function step(ts) {
        if (id !== anim) return;
        if (t0 === null) t0 = ts;
        var p = Math.min(1, (ts - t0) / 260), e = 1 - Math.pow(1 - p, 3);
        f.scrollLeft = from + (to - from) * e;
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }
    function go(dir) {
      var w = colW(); if (!w) return;
      var n = Math.round((f.scrollWidth - f.clientWidth) / w);
      if (idx === null) idx = Math.round(f.scrollLeft / w);
      idx = Math.max(0, Math.min(n, idx + dir));
      tween(idx * w);
      clearTimeout(settle); settle = setTimeout(function () { idx = null; }, 900);
    }
    f.addEventListener('touchstart', function (e) { if (!mq.matches || e.touches.length !== 1) return; on = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    f.addEventListener('touchend', function (e) {
      if (!on) return; on = false;
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    }, { passive: true });
    f.addEventListener('keydown', function (e) { if (!mq.matches) return; if (e.key === 'ArrowRight') { e.preventDefault(); go(1); } if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); } });
  });
})();
