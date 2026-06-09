(function () {
  const metaTag = document.querySelector('meta[name="api-base-url"]');
  const configuredBaseUrl = metaTag ? metaTag.getAttribute('content') || '' : '';
  const normalizedBaseUrl = configuredBaseUrl.trim().replace(/\/+$/, '');

  globalThis.API_BASE_URL = normalizedBaseUrl;
  globalThis.buildApiUrl = function buildApiUrl(path) {
    if (!path) {
      return globalThis.API_BASE_URL || '';
    }

    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${globalThis.API_BASE_URL || ''}${normalizedPath}`;
  };
})();
