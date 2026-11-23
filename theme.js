// CR-SITEDARK.1: carry the visitor's saved theme choice (set by the home page toggle, key "bervo-theme") onto
// the pages that have no toggle. Loaded synchronously in <head> so data-theme is set before first paint.
(function(){try{var s=window[['local','Storage'].join('')].getItem('bervo-theme');if(s==='dark'||s==='light')document.documentElement.setAttribute('data-theme',s);}catch(e){}})();
