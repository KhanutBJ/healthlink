/**
 * Inject loader: injects inject.js into the page context
 * so it can intercept XHR/fetch API calls made by the admin page.
 */
(() => {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
})();
