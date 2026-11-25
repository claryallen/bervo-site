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
