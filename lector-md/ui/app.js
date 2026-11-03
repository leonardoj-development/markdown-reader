(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MOBILE_BREAKPOINT = 1000;
  const DEFAULT_FONT_SIZE = 17;
  const MAX_FIND_MATCHES = 500;

  const state = {
    booted: false,
    appInfo: null,
    settings: {
      theme: 'system',
      font_size: DEFAULT_FONT_SIZE,
      sidebar_open: true,
      sidebar_width: 288,
      toc_visible: true,
    },
    recents: [],
    demoAvailable: false,
    folder: null,
    tree: null,
    isDemo: false,
    flatFiles: [],
    filePaths: new Set(),
    activePath: null,
    doc: null,
    expanded: new Set(),
    filter: '',
    tab: 'files',
    history: [],
    historyIndex: -1,
    scrollPositions: new Map(),
    tocVisible: true,
    tocItems: [],
    activeHeading: -1,
    find: { open: false, query: '', matches: [], index: -1, timer: null },
    search: { query: '', running: false, results: [], token: 0 },
    busy: 0,
    readToken: 0,
    folderToken: 0,
    sidebarOpen: true,
    menuTarget: null,
    helpReturnFocus: null,
    lightboxReturnFocus: null,
    scrollTick: false,
    statusTimer: null,
  };

  const els = {};
  const $ = (selector, root = document) => root.querySelector(selector);

  function cacheElements() {
    const ids = [
      'bootScreen', 'app', 'sidebar', 'brandButton', 'menuButton', 'folderCard',
      'folderName', 'folderMeta', 'refreshFolderButton', 'filterInput',
      'clearFilterButton', 'filesTab', 'searchTab', 'documentCount', 'filesPanel',
      'searchPanel', 'tree', 'treeEmpty', 'treeNoMatches', 'clearFilterLink',
      'emptyOpenFolder', 'contentSearchForm', 'contentSearchInput', 'searchStatus',
      'searchResults', 'searchEmpty', 'themeQuickButton', 'themeQuickLabel',
      'helpButton', 'sidebarResizer', 'sidebarScrim', 'sidebarToggle', 'backButton',
      'forwardButton', 'location', 'locationFolder', 'locationFile', 'findButton',
      'tocButton', 'documentMenuButton', 'findBar', 'findInput', 'findCount',
      'findPrevButton', 'findNextButton', 'findCloseButton', 'loadingLine',
      'readingProgress', 'contentArea', 'welcome', 'welcomeOpenButton',
      'welcomeDemoButton', 'welcomeVersion', 'welcomeRecents', 'folderEmpty',
      'folderEmptyTitle', 'folderEmptyText', 'emptyFolderOpenButton',
      'emptyFolderRefreshButton', 'contentGrid', 'reader', 'docMeta',
      'metaReading', 'metaWords', 'metaModified', 'copyPathButton', 'revealButton',
      'content', 'backToTopButton', 'tocPanel', 'tocCount', 'tocList', 'tocEmpty',
      'statusDot', 'statusFolder', 'statusEncoding', 'statusSeparator',
      'statusStats', 'appMenu', 'menuRefreshFolder', 'menuCloseFolder',
      'menuFontSize', 'docMenu', 'menuToggleToc', 'helpModal', 'helpCloseButton',
      'aboutVersion', 'openConfigButton', 'helpDoneButton', 'lightbox',
      'lightboxClose', 'lightboxImage', 'lightboxCaption', 'toast', 'toastIcon',
      'toastMessage', 'openFolderButton',
    ];
    for (const id of ids) els[id] = document.getElementById(id);
  }

  // ---------------------------------------------------------------- utilities
  function makeIcon(name, className = 'icon') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function setIcon(container, name) {
    if (!container) return;
    const use = container.querySelector('use');
    if (use) use.setAttribute('href', `#i-${name}`);
  }

  function fold(text) {
    return String(text ?? '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase();
  }

  function foldWithMap(text) {
    const chars = [];
    const map = [];
    for (let i = 0; i < text.length; i += 1) {
      const folded = fold(text[i]);
      for (const char of folded) {
        chars.push(char);
        map.push(i);
      }
    }
    return { folded: chars.join(''), map };
  }

  function formatNumber(value) {
    try {
      return new Intl.NumberFormat('es-CL').format(value);
    } catch {
      return String(value);
    }
  }

  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function normalizePath(path) {
    return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  }

  function samePath(a, b) {
    return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  class ApiError extends Error {}

  async function call(method, ...args) {
    const api = window.pywebview && window.pywebview.api;
    if (!api) throw new ApiError('La aplicación todavía no está lista.');
    let result;
    try {
      result = await api[method](...args);
    } catch (error) {
      console.error(`API ${method}`, error);
      throw new ApiError('No se pudo comunicar con la aplicación.');
    }
    if (result && result.ok === false) {
      throw new ApiError(result.error || 'Ocurrió un error inesperado.');
    }
    return result;
  }

  function showToast(message, type = 'info') {
    if (!els.toast || !message) return;
    clearTimeout(state.toastTimer);
    els.toast.classList.remove('is-visible', 'is-error', 'is-success');
    els.toast.hidden = false;
    els.toastMessage.textContent = message;
    const iconName = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
    setIcon($('.toast-icon svg', els.toast), iconName);
    els.toast.classList.toggle('is-error', type === 'error');
    els.toast.classList.toggle('is-success', type === 'success');
    requestAnimationFrame(() => els.toast.classList.add('is-visible'));
    state.toastTimer = setTimeout(() => {
      els.toast.classList.remove('is-visible');
      setTimeout(() => {
        if (!els.toast.classList.contains('is-visible')) els.toast.hidden = true;
      }, 220);
    }, type === 'error' ? 4200 : 2800);
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // WebView2 puede bloquear el portapapeles desde file://; se usa el puente.
    }
    try {
      const result = await call('copy_text', text);
      return Boolean(result && result.ok);
    } catch (error) {
      showToast(error.message, 'error');
      return false;
    }
  }

  function setBusy(on) {
    state.busy = Math.max(0, state.busy + (on ? 1 : -1));
    const busy = state.busy > 0;
    els.app.classList.toggle('is-busy', busy);
    els.statusDot.classList.toggle('is-busy', busy);
  }

  function updateWindowTitle(title) {
    const value = title || 'Lector MD';
    document.title = value;
    if (state.booted) call('set_window_title', value).catch(() => {});
  }

  // ------------------------------------------------------------------- boot
  function addBootError(message) {
    const boot = els.bootScreen;
    boot.hidden = false;
    boot.classList.remove('is-hidden');
    const title = $('.boot-name', boot);
    if (title) title.textContent = 'No se pudo iniciar';
    let detail = $('.boot-error', boot);
    if (!detail) {
      detail = document.createElement('p');
      detail.className = 'boot-error';
      boot.appendChild(detail);
      const retry = document.createElement('button');
      retry.className = 'primary-button';
      retry.textContent = 'Reintentar';
      retry.addEventListener('click', () => window.location.reload());
      boot.appendChild(retry);
    }
    detail.textContent = message;
    const progress = $('.boot-progress', boot);
    if (progress) progress.hidden = true;
  }

  function hideBoot() {
    if (!els.bootScreen) return;
    els.bootScreen.classList.add('is-hidden');
    setTimeout(() => {
      if (els.bootScreen.classList.contains('is-hidden')) els.bootScreen.hidden = true;
    }, 400);
  }

  function waitForApi() {
    return new Promise((resolve) => {
      if (window.pywebview && window.pywebview.api) {
        resolve(true);
        return;
      }
      let settled = false;
      const done = (ready) => {
        if (settled) return;
        settled = true;
        resolve(ready);
      };
      window.addEventListener('pywebviewready', () => done(Boolean(window.pywebview && window.pywebview.api)), { once: true });
      setTimeout(() => done(Boolean(window.pywebview && window.pywebview.api)), 9000);
    });
  }

  async function boot() {
    const ready = await waitForApi();
    if (!ready) {
      addBootError('No se pudo conectar con el motor de la aplicación. Cierra y vuelve a abrir Lector MD.');
      return;
    }

    try {
      const data = await call('bootstrap');
      state.appInfo = data.app || null;
      state.recents = Array.isArray(data.recents) ? data.recents : [];
      state.demoAvailable = Boolean(data.demo_available);
      applySettings(data.settings || {}, true);
      renderRecents();
      if (data.app) {
        els.welcomeVersion.textContent = `${data.app.name} ${data.app.version}`;
        els.aboutVersion.textContent = `Versión ${data.app.version} · Windows · WebView2`;
      }
      els.welcomeDemoButton.hidden = !state.demoAvailable;
      state.booted = true;
      hideBoot();

      if (data.initial_folder) {
        await openFolderPath(data.initial_folder, {
          preferredFile: data.initial_file || null,
          remember: Boolean(data.initial_remember),
          fromBoot: true,
          updateRecents: Boolean(data.initial_remember),
        });
      } else {
        showWelcome();
      }
    } catch (error) {
      console.error(error);
      addBootError(error.message || 'No se pudo cargar la aplicación.');
    }
  }

  // ---------------------------------------------------------------- settings
  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function resolvedTheme() {
    return state.settings.theme === 'system' ? systemTheme() : state.settings.theme;
  }

  function applyTheme(theme, persist = false) {
    state.settings.theme = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    document.documentElement.dataset.theme = resolvedTheme();
    updateThemeControls();
    if (persist) saveSettings({ theme: state.settings.theme });
  }

  function updateThemeControls() {
    const resolved = resolvedTheme();
    const next = resolved === 'dark' ? 'claro' : 'oscuro';
    if (els.themeQuickButton) {
      setIcon($('svg', els.themeQuickButton), resolved === 'dark' ? 'moon' : 'sun');
      els.themeQuickButton.title = `Cambiar a tema ${next}`;
    }
    if (els.themeQuickLabel) {
      els.themeQuickLabel.textContent = resolved === 'dark' ? 'Tema oscuro' : 'Tema claro';
    }
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.themeChoice === state.settings.theme);
    });
  }

  function setFontSize(size, persist = true) {
    const value = Math.max(14, Math.min(24, Number(size) || DEFAULT_FONT_SIZE));
    state.settings.font_size = value;
    document.documentElement.style.setProperty('--reading-size', `${value}px`);
    if (els.menuFontSize) els.menuFontSize.textContent = `${value} px`;
    if (persist) saveSettings({ font_size: value });
  }

  function stepFont(delta) {
    setFontSize(state.settings.font_size + delta);
  }

  function applySettings(settings, initial = false) {
    state.settings = { ...state.settings, ...settings };
    state.tocVisible = settings.toc_visible !== false;
    applyTheme(state.settings.theme, false);
    setFontSize(state.settings.font_size, false);
    document.documentElement.style.setProperty(
      '--sidebar-width',
      `${Math.max(240, Math.min(420, Number(state.settings.sidebar_width) || 288))}px`,
    );
    if (initial) {
      const open = isMobile() ? false : settings.sidebar_open !== false;
      setSidebar(open, false);
    }
    updateTocVisibility();
  }

  function saveSettings(patch) {
    call('save_settings', patch).catch((error) => {
      console.warn('No se pudieron guardar los ajustes:', error);
    });
  }

  // ----------------------------------------------------------------- sidebar
  function setSidebar(open, persist = true) {
    state.sidebarOpen = Boolean(open);
    els.app.classList.toggle('sidebar-closed', !state.sidebarOpen);
    els.sidebarScrim.hidden = !(state.sidebarOpen && isMobile());
    if (persist) saveSettings({ sidebar_open: state.sidebarOpen });
  }

  function updateScrimForViewport() {
    els.sidebarScrim.hidden = !(state.sidebarOpen && isMobile());
  }

  function openFolderDialog() {
    chooseFolder();
  }

  // ---------------------------------------------------------------- folders
  async function chooseFolder() {
    closeMenus();
    setBusy(true);
    try {
      const result = await call('choose_folder');
      if (!result || result.cancelled) return;
      await applyFolderResult(result, { remember: true, updateRecents: true });
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openFolderPath(path, options = {}) {
    if (!path) return;
    closeMenus();
    const token = ++state.folderToken;
    setBusy(true);
    try {
      const result = await call('open_folder', path, options.remember !== false);
      if (token !== state.folderToken) return;
      await applyFolderResult(result, options);
    } catch (error) {
      if (token === state.folderToken) showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openDemo() {
    closeMenus();
    setBusy(true);
    try {
      const result = await call('open_demo');
      await applyFolderResult(result, { remember: false, updateRecents: false });
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function applyFolderResult(result, options = {}) {
    if (!result || !result.folder || !result.tree) {
      throw new ApiError('La carpeta no devolvió documentos válidos.');
    }
    state.folder = result.folder;
    state.tree = result.tree;
    state.isDemo = Boolean(result.is_demo);
    state.filter = '';
    state.expanded = new Set();
    state.activePath = null;
    state.doc = null;
    state.history = [];
    state.historyIndex = -1;
    state.tocItems = [];
    state.activeHeading = -1;
    state.scrollPositions.clear();
    closeFind();
    switchTab('files');
    if (els.filterInput) els.filterInput.value = '';
    updateFilterChrome();
    rebuildFlatFiles();
    renderFolderChrome();
    expandAllFolders(state.tree);
    renderTree();

    if (options.updateRecents !== false && !state.isDemo) {
      rememberRecent(state.folder);
    }

    const preferred = options.preferredFile && state.filePaths.has(options.preferredFile)
      ? options.preferredFile
      : null;
    const last = result.last_file && state.filePaths.has(result.last_file) ? result.last_file : null;
    const target = preferred || last || (state.flatFiles[0] ? state.flatFiles[0].path : null);

    if (!target) {
      showFolderEmpty();
      return;
    }
    expandAncestors(target);
    renderTree();
    await openDocument(target, {
      historyMode: 'reset',
      restoreScroll: false,
      closeSidebar: !options.fromBoot,
    });
  }

  async function refreshFolder(showMessage = true) {
    if (!state.folder) {
      await chooseFolder();
      return;
    }
    const active = state.activePath;
    closeMenus();
    setBusy(true);
    try {
      const result = await call('refresh_folder');
      const savedExpanded = new Set(state.expanded);
      state.folder = result.folder;
      state.tree = result.tree;
      state.expanded = savedExpanded;
      expandAllFolders(state.tree);
      rebuildFlatFiles();
      renderFolderChrome();
      renderTree();
      if (active && state.filePaths.has(active)) {
        await openDocument(active, {
          historyMode: 'replace',
          restoreScroll: true,
          force: true,
          closeSidebar: false,
        });
      } else if (state.flatFiles.length) {
        expandAncestors(state.flatFiles[0].path);
        renderTree();
        await openDocument(state.flatFiles[0].path, { historyMode: 'reset', restoreScroll: false });
      } else {
        showFolderEmpty();
      }
      if (showMessage) showToast('Carpeta actualizada.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function rememberRecent(folder) {
    if (!folder) return;
    state.recents = state.recents.filter((item) => !samePath(item.path, folder.path));
    state.recents.unshift({
      path: folder.path,
      name: folder.name,
      opened: new Date().toISOString(),
      available: true,
    });
    state.recents = state.recents.slice(0, 8);
    renderRecents();
  }

  function rebuildFlatFiles() {
    const flat = [];
    function walk(node) {
      for (const child of node.children || []) {
        if (child.type === 'dir') {
          walk(child);
        } else {
          flat.push({
            ...child,
            folder: child.path.includes('/') ? child.path.slice(0, child.path.lastIndexOf('/')) : '',
          });
        }
      }
    }
    if (state.tree) walk(state.tree);
    state.flatFiles = flat;
    state.filePaths = new Set(flat.map((item) => item.path));
  }

  function renderFolderChrome() {
    if (!state.folder) return;
    els.folderCard.hidden = false;
    els.folderName.textContent = state.folder.name;
    const parts = [
      `${formatNumber(state.folder.file_count)} documento${state.folder.file_count === 1 ? '' : 's'}`,
      `${formatNumber(state.folder.folder_count)} carpeta${state.folder.folder_count === 1 ? '' : 's'}`,
    ];
    if (state.isDemo) parts.push('ejemplo');
    if (state.folder.truncated) parts.push('vista parcial');
    els.folderMeta.textContent = parts.join(' · ');
    els.documentCount.textContent = formatNumber(state.folder.file_count);
    els.welcome.hidden = true;
    els.folderEmpty.hidden = true;
    els.treeEmpty.hidden = true;
    els.locationFolder.textContent = state.folder.name;
    els.locationFile.textContent = 'Elige un documento';
    els.location.title = state.folder.path;
    els.menuRefreshFolder.disabled = false;
    els.menuCloseFolder.disabled = false;
    els.statusFolder.textContent = state.isDemo
      ? `Demostración · ${state.folder.name}`
      : `${formatNumber(state.folder.file_count)} documentos · ${formatNumber(state.folder.folder_count)} carpetas`;
    els.statusEncoding.textContent = '';
    els.statusSeparator.hidden = true;
    els.statusStats.textContent = '';
    updateOpenFolderLabels();
    updateWindowTitle(`${state.folder.name} · Lector MD`);
  }

  function updateOpenFolderLabels() {
    const hasFolder = Boolean(state.folder);
    els.menuCloseFolder.hidden = !hasFolder;
    els.menuRefreshFolder.disabled = !hasFolder;
  }

  function showWelcome() {
    state.folder = null;
    state.tree = null;
    state.doc = null;
    state.activePath = null;
    state.flatFiles = [];
    state.filePaths = new Set();
    state.treeItems = [];
    state.tocItems = [];
    state.expanded = new Set();
    state.history = [];
    state.historyIndex = -1;
    state.scrollPositions.clear();
    closeFind();
    closeMenus();
    switchTab('files');
    state.filter = '';
    els.filterInput.value = '';
    els.contentSearchInput.value = '';
    els.searchResults.replaceChildren();
    els.searchStatus.replaceChildren();
    els.searchStatus.classList.remove('is-error');
    els.searchEmpty.hidden = false;
    const searchHint = els.searchEmpty.querySelector('p');
    if (searchHint) {
      searchHint.textContent = 'Encuentra una palabra o frase en todos los documentos de esta carpeta.';
    }
    state.search = { query: '', running: false, results: [], token: state.search.token + 1 };
    els.welcome.hidden = false;
    els.folderEmpty.hidden = true;
    els.contentGrid.hidden = true;
    els.folderCard.hidden = true;
    els.documentCount.textContent = '0';
    els.locationFolder.textContent = 'Biblioteca';
    els.locationFile.textContent = 'Sin documento';
    els.location.title = '';
    els.statusFolder.textContent = 'Listo para leer';
    els.statusEncoding.textContent = '';
    els.statusSeparator.hidden = true;
    els.statusStats.textContent = '';
    els.tree.replaceChildren();
    els.treeEmpty.hidden = false;
    els.treeNoMatches.hidden = true;
    els.content.replaceChildren();
    els.tocList.replaceChildren();
    els.readingProgress.style.width = '0%';
    setDocActionsEnabled(false);
    updateOpenFolderLabels();
    updateNavButtons();
    updateTocVisibility();
    renderRecents();
    updateWindowTitle('Lector MD');
    els.contentArea.scrollTop = 0;
  }

  function showFolderEmpty(message) {
    closeFind();
    els.welcome.hidden = true;
    els.contentGrid.hidden = true;
    els.folderEmpty.hidden = false;
    els.folderEmptyTitle.textContent = `«${state.folder ? state.folder.name : 'La carpeta'}» no tiene documentos Markdown`;
    els.folderEmptyText.textContent = message
      || 'Esta carpeta no contiene archivos .md. Prueba con otra carpeta o recarga si acabas de agregar archivos.';
    els.statusFolder.textContent = 'Sin documentos Markdown';
    els.statusEncoding.textContent = '';
    els.statusSeparator.hidden = true;
    els.statusStats.textContent = '';
    els.readingProgress.style.width = '0%';
    els.contentArea.scrollTop = 0;
    setDocActionsEnabled(false);
    updateTocVisibility();
  }

  // -------------------------------------------------------------------- tree
  function renderTree() {
    els.tree.replaceChildren();
    els.treeNoMatches.hidden = true;
    if (!state.tree) {
      els.treeEmpty.hidden = false;
      els.treeNoMatches.hidden = true;
      return;
    }

    if (state.filter) {
      els.treeEmpty.hidden = true;
      renderFilteredTree();
      return;
    }

    els.treeEmpty.hidden = state.flatFiles.length > 0;
    if (!state.flatFiles.length) return;

    const fragment = document.createDocumentFragment();
    for (const child of state.tree.children || []) {
      fragment.appendChild(renderTreeNode(child, 0));
    }
    els.tree.appendChild(fragment);
    requestAnimationFrame(scrollActiveTreeIntoView);
  }

  function renderTreeNode(node, depth) {
    if (node.type === 'dir') {
      const wrapper = document.createElement('div');
      wrapper.className = 'tree-folder';
      if (state.expanded.has(node.path)) wrapper.classList.add('is-expanded');
      const row = document.createElement('button');
      row.className = 'tree-row';
      row.type = 'button';
      row.dataset.kind = 'dir';
      row.dataset.path = node.path;
      row.style.setProperty('--depth', String(depth));
      row.setAttribute('aria-expanded', state.expanded.has(node.path) ? 'true' : 'false');
      row.appendChild(makeIcon('chevron', 'tree-chevron'));
      row.appendChild(makeIcon('folder', 'folder-icon'));
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = node.name;
      row.appendChild(label);
      if (node.count) {
        const badge = document.createElement('span');
        badge.className = 'tree-badge';
        badge.textContent = formatNumber(node.count);
        row.appendChild(badge);
      }
      wrapper.appendChild(row);
      const children = document.createElement('div');
      children.className = 'tree-children';
      for (const child of node.children || []) {
        children.appendChild(renderTreeNode(child, depth + 1));
      }
      wrapper.appendChild(children);
      return wrapper;
    }

    const row = document.createElement('button');
    row.className = 'tree-row tree-file';
    row.type = 'button';
    row.dataset.kind = 'file';
    row.dataset.path = node.path;
    row.style.setProperty('--depth', String(depth));
    row.title = node.path;
    if (state.activePath && samePath(state.activePath, node.path)) row.classList.add('is-active');
    row.appendChild(makeIcon('file', 'file-icon'));
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name;
    row.appendChild(label);
    return row;
  }

  function renderFilteredTree() {
    const query = fold(state.filter);
    const matches = state.flatFiles.filter((file) => {
      return fold(file.name).includes(query) || fold(file.folder).includes(query) || fold(file.path).includes(query);
    });
    const heading = document.createElement('div');
    heading.className = 'flat-heading';
    const text = document.createElement('span');
    text.textContent = `${formatNumber(matches.length)} coincidencia${matches.length === 1 ? '' : 's'}`;
    heading.appendChild(text);
    els.tree.appendChild(heading);

    if (!matches.length) {
      els.treeNoMatches.hidden = false;
      return;
    }
    els.treeNoMatches.hidden = true;

    for (const file of matches.slice(0, 400)) {
      const row = document.createElement('button');
      row.className = 'tree-row flat-file';
      row.type = 'button';
      row.dataset.kind = 'file';
      row.dataset.path = file.path;
      row.style.setProperty('--depth', '0');
      row.title = file.path;
      if (state.activePath && samePath(state.activePath, file.path)) row.classList.add('is-active');
      row.appendChild(makeIcon('file', 'file-icon'));
      const label = document.createElement('span');
      label.className = 'tree-label';
      const name = document.createElement('span');
      name.className = 'tree-label';
      name.textContent = file.name;
      label.appendChild(name);
      const folder = document.createElement('span');
      folder.className = 'flat-folder';
      folder.textContent = file.folder || 'Raíz de la carpeta';
      label.appendChild(folder);
      row.appendChild(label);
      els.tree.appendChild(row);
    }
  }

  function toggleFolder(path, row) {
    if (state.expanded.has(path)) state.expanded.delete(path);
    else state.expanded.add(path);
    const wrapper = row.closest('.tree-folder');
    if (wrapper) {
      const expanded = state.expanded.has(path);
      wrapper.classList.toggle('is-expanded', expanded);
      row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
  }

  function onTreeClick(event) {
    const row = event.target.closest('.tree-row');
    if (!row) return;
    if (row.dataset.kind === 'dir') {
      toggleFolder(row.dataset.path, row);
      return;
    }
    if (row.dataset.kind === 'file' && row.dataset.path) {
      if (isMobile()) setSidebar(false, false);
      openDocument(row.dataset.path, { closeSidebar: false });
    }
  }

  function expandAncestors(path) {
    const parts = normalizePath(path).split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      state.expanded.add(current);
    }
  }

  function expandAllFolders(node) {
    for (const child of node.children || []) {
      if (child.type === 'dir') {
        state.expanded.add(child.path);
        expandAllFolders(child);
      }
    }
  }

  function syncActiveTree() {
    let activeRow = null;
    els.tree.querySelectorAll('.tree-row').forEach((row) => {
      const active = row.dataset.kind === 'file' && state.activePath && samePath(row.dataset.path, state.activePath);
      row.classList.toggle('is-active', Boolean(active));
      if (active) activeRow = row;
    });
    if (activeRow) {
      const folder = activeRow.closest('.tree-folder');
      if (folder && !folder.classList.contains('is-expanded')) {
        // El documento activo debe quedar visible.
        state.expanded.add(activeRow.dataset.path.split('/').slice(0, -1).join('/'));
      }
    }
    requestAnimationFrame(scrollActiveTreeIntoView);
  }

  function scrollActiveTreeIntoView() {
    const active = els.tree.querySelector('.tree-row.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function updateFilterChrome() {
    const hasFilter = Boolean(els.filterInput.value);
    els.clearFilterButton.hidden = !hasFilter;
    state.filter = els.filterInput.value.trim();
    renderTree();
  }

  // --------------------------------------------------------------- documents
  function setDocActionsEnabled(enabled) {
    for (const button of [els.findButton, els.documentMenuButton, els.copyPathButton, els.revealButton]) {
      if (button) button.disabled = !enabled;
    }
    if (!enabled) {
      els.tocButton.disabled = true;
      els.menuToggleToc.disabled = true;
    }
  }

  async function openDocument(path, options = {}) {
    if (!state.folder || !path) return;
    if (state.activePath && !options.force) state.scrollPositions.set(state.activePath, els.contentArea.scrollTop);
    if (state.activePath && samePath(state.activePath, path) && !options.force) {
      if (options.fragment) scrollToAnchor(options.fragment);
      return;
    }

    const token = ++state.readToken;
    setBusy(true);
    try {
      const doc = await call('read_file', path);
      if (token !== state.readToken) return;
      state.doc = doc;
      state.activePath = doc.path;
      pushHistory(doc.path, options.historyMode || 'push');
      renderDocument(doc);
      if (options.closeSidebar !== false && isMobile()) setSidebar(false, false);

      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (options.fragment) {
        scrollToAnchor(options.fragment);
      } else {
        const saved = options.restoreScroll ? state.scrollPositions.get(doc.path) : 0;
        els.contentArea.scrollTop = saved || 0;
      }
      if (options.findQuery) {
        openFind(options.findQuery);
      }
    } catch (error) {
      if (token === state.readToken) {
        showToast(error.message, 'error');
        if (!state.doc) showFolderEmpty(`No se pudo abrir «${path}». ${error.message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  function renderDocument(doc) {
    els.welcome.hidden = true;
    els.folderEmpty.hidden = true;
    els.contentGrid.hidden = false;
    els.content.innerHTML = doc.html || '';
    els.reader.classList.remove('is-entering');
    void els.reader.offsetWidth;
    els.reader.classList.add('is-entering');

    decorateHeadings();
    decorateCodeBlocks();
    decorateTables();
    decorateImages();
    buildToc();

    els.locationFolder.textContent = doc.folder
      ? `${state.folder.name} / ${doc.folder}`
      : state.folder.name;
    els.locationFile.textContent = doc.name;
    els.location.title = doc.absolute_path || doc.path;
    els.metaReading.textContent = doc.stats.minutes
      ? `${doc.stats.minutes} min de lectura`
      : 'Documento breve';
    els.metaWords.textContent = `${formatNumber(doc.stats.words)} palabra${doc.stats.words === 1 ? '' : 's'}`;
    els.metaModified.textContent = doc.modified_label ? `Modificado ${doc.modified_label}` : '';
    els.statusFolder.textContent = state.folder ? state.folder.name : '';
    els.statusEncoding.textContent = doc.encoding || '';
    els.statusSeparator.hidden = !doc.encoding;
    els.statusStats.textContent = `${formatNumber(doc.stats.words)} palabras · ${doc.stats.minutes} min`;
    els.readingProgress.style.width = '0%';
    setDocActionsEnabled(true);
    const expandedBefore = state.expanded.size;
    expandAncestors(doc.path);
    if (state.expanded.size !== expandedBefore) renderTree();
    updateTocVisibility();
    syncActiveTree();
    updateWindowTitle(`${doc.title || doc.name} · Lector MD`);
    updateFindAvailability();
    closeFind();
  }

  function decorateHeadings() {
    els.content.querySelectorAll('h1[id], h2[id], h3[id], h4[id]').forEach((heading) => {
      if (heading.querySelector('.heading-anchor')) return;
      const anchor = document.createElement('a');
      anchor.className = 'heading-anchor';
      anchor.href = `#${heading.id}`;
      anchor.setAttribute('aria-label', 'Enlace a esta sección');
      anchor.textContent = '#';
      heading.prepend(anchor);
      anchor.addEventListener('click', (event) => {
        event.preventDefault();
        scrollToAnchor(heading.id);
      });
    });
  }

  function decorateCodeBlocks() {
    els.content.querySelectorAll('pre').forEach((pre) => {
      if (pre.closest('.code-block')) return;
      const code = pre.querySelector('code');
      if (!code) return;
      const classes = Array.from(code.classList);
      const languageClass = classes.find((name) => name.startsWith('language-'));
      const language = languageClass ? languageClass.slice('language-'.length) : 'texto';
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      const header = document.createElement('div');
      header.className = 'code-header';
      const label = document.createElement('span');
      label.className = 'code-lang';
      label.textContent = language || 'texto';
      header.appendChild(label);
      const copy = document.createElement('button');
      copy.className = 'code-copy';
      copy.type = 'button';
      copy.appendChild(makeIcon('copy', 'icon'));
      const copyLabel = document.createElement('span');
      copyLabel.textContent = 'Copiar';
      copy.appendChild(copyLabel);
      copy.addEventListener('click', async () => {
        const ok = await copyText(code.innerText);
        if (!ok) return;
        copy.classList.add('is-copied');
        setIcon(copy.querySelector('svg'), 'check');
        copyLabel.textContent = 'Copiado';
        setTimeout(() => {
          copy.classList.remove('is-copied');
          setIcon(copy.querySelector('svg'), 'copy');
          copyLabel.textContent = 'Copiar';
        }, 1600);
      });
      header.appendChild(copy);
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
    });
  }

  function decorateTables() {
    els.content.querySelectorAll('table').forEach((table) => {
      if (table.parentElement && table.parentElement.classList.contains('table-wrap')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'table-wrap';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
  }

  function decorateImages() {
    els.content.querySelectorAll('img').forEach((image) => {
      image.loading = 'lazy';
      image.decoding = 'async';
      image.title = image.alt ? `${image.alt} · clic para ampliar` : 'Clic para ampliar';
      image.tabIndex = 0;
    });
  }

  function buildToc() {
    els.tocList.replaceChildren();
    const headings = Array.from(els.content.querySelectorAll('h1[id], h2[id], h3[id], h4[id]'));
    state.tocItems = [];
    state.activeHeading = -1;

    if (!headings.length) {
      els.tocEmpty.hidden = false;
      els.tocCount.textContent = '';
      state.tocItems = [];
      updateTocVisibility();
      return;
    }

    els.tocEmpty.hidden = true;
    els.tocCount.textContent = String(headings.length);

    headings.forEach((heading, index) => {
      const clone = heading.cloneNode(true);
      clone.querySelectorAll('.heading-anchor').forEach((anchor) => anchor.remove());
      const label = (clone.textContent || '').replace(/\s+/g, ' ').trim() || `Sección ${index + 1}`;
      const link = document.createElement('a');
      link.className = 'toc-link';
      link.href = `#${heading.id}`;
      link.dataset.level = heading.tagName.slice(1);
      link.textContent = label;
      link.title = label;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        scrollToAnchor(heading.id);
      });
      els.tocList.appendChild(link);
      state.tocItems.push({ element: heading, link, id: heading.id });
    });
    updateTocVisibility();
    updateActiveHeading();
  }

  function updateTocVisibility() {
    const available = state.tocItems.length > 0 && Boolean(state.doc);
    const visible = available && state.tocVisible;
    els.tocPanel.hidden = !visible;
    els.tocEmpty.hidden = state.tocItems.length > 0;
    els.contentGrid.classList.toggle('toc-hidden', !visible);
    els.tocButton.disabled = !available;
    els.tocButton.classList.toggle('is-active', visible);
    els.menuToggleToc.disabled = !available;
    els.menuToggleToc.querySelector('span').textContent = visible ? 'Ocultar índice' : 'Mostrar índice';
    els.menuToggleToc.querySelector('use').setAttribute(
      'href',
      visible ? '#i-list' : '#i-list',
    );
  }

  function toggleToc() {
    if (!state.tocItems.length) return;
    state.tocVisible = !state.tocVisible;
    updateTocVisibility();
    saveSettings({ toc_visible: state.tocVisible });
    closeMenus();
  }

  function updateFindAvailability() {
    if (els.findButton) els.findButton.disabled = !state.doc;
  }

  function scrollToAnchor(fragment) {
    if (!fragment) return;
    let id = fragment;
    try {
      id = decodeURIComponent(fragment);
    } catch {
      // usar el valor original
    }
    const target = document.getElementById(id) || document.getElementById(fragment);
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
    const top = els.contentArea.scrollTop;
    if (top > 70) els.contentArea.scrollTop = Math.max(0, top - 70);
  }

  // -------------------------------------------------------------- navigation
  function pushHistory(path, mode) {
    if (mode === 'none') {
      updateNavButtons();
      return;
    }
    if (mode === 'reset') {
      state.history = [path];
      state.historyIndex = 0;
    } else if (mode === 'replace') {
      if (state.historyIndex >= 0) state.history[state.historyIndex] = path;
      else {
        state.history = [path];
        state.historyIndex = 0;
      }
    } else {
      const current = state.history[state.historyIndex];
      if (current && samePath(current, path)) {
        updateNavButtons();
        return;
      }
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push(path);
      if (state.history.length > 80) {
        state.history.shift();
        state.historyIndex = state.history.length - 1;
      } else {
        state.historyIndex = state.history.length - 1;
      }
    }
    updateNavButtons();
  }

  function updateNavButtons() {
    els.backButton.disabled = state.historyIndex <= 0;
    els.forwardButton.disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
  }

  function navigateHistory(delta) {
    if (!state.doc) return;
    const targetIndex = state.historyIndex + delta;
    if (targetIndex < 0 || targetIndex >= state.history.length) return;
    const previous = state.historyIndex;
    state.scrollPositions.set(state.activePath, els.contentArea.scrollTop);
    state.historyIndex = targetIndex;
    const path = state.history[targetIndex];
    openDocument(path, { historyMode: 'none', restoreScroll: true, closeSidebar: false }).catch(() => {
      state.historyIndex = previous;
      updateNavButtons();
    });
  }

  async function reloadDocument() {
    if (!state.activePath) return;
    await openDocument(state.activePath, {
      historyMode: 'replace',
      restoreScroll: true,
      force: true,
      closeSidebar: false,
    });
    showToast('Documento recargado.', 'success');
  }

  async function revealActive() {
    if (!state.doc) return;
    try {
      const result = await call('reveal', state.doc.path);
      if (result.ok) showToast('Mostrando en el Explorador.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function copyActivePath() {
    if (!state.doc) return;
    const ok = await copyText(state.doc.absolute_path || state.doc.path);
    if (ok) showToast('Ruta copiada al portapapeles.', 'success');
  }

  // ------------------------------------------------------------------ search
  function runContentSearch(event) {
    if (event) event.preventDefault();
    const query = els.contentSearchInput.value.trim();
    if (!state.folder) {
      showToast('Abre una carpeta para buscar en su contenido.', 'error');
      return;
    }
    if (query.length < 2) {
      showToast('Escribe al menos dos caracteres para buscar.', 'error');
      els.contentSearchInput.focus();
      return;
    }
    executeContentSearch(query);
  }

  async function executeContentSearch(query) {
    const token = ++state.search.token;
    state.search.running = true;
    state.search.query = query;
    const submit = $('.search-submit', els.contentSearchForm);
    if (submit) submit.disabled = true;
    els.searchEmpty.hidden = true;
    els.searchResults.replaceChildren();
    renderSearchStatus('buscando');
    setBusy(true);
    try {
      const result = await call('search_content', query);
      if (token !== state.search.token) return;
      state.search.results = Array.isArray(result.results) ? result.results : [];
      renderSearchResults(result);
    } catch (error) {
      if (token !== state.search.token) return;
      state.search.results = [];
      renderSearchStatus('error', error.message);
    } finally {
      if (token === state.search.token) {
        state.search.running = false;
        const button = $('.search-submit', els.contentSearchForm);
        if (button) button.disabled = false;
        setBusy(false);
      }
    }
  }

  function renderSearchStatus(mode, message) {
    els.searchStatus.replaceChildren();
    if (mode === 'buscando') {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      const text = document.createElement('span');
      text.textContent = 'Buscando en todos los documentos…';
      els.searchStatus.append(spinner, text);
      return;
    }
    if (mode === 'error') {
      els.searchStatus.textContent = message || 'No se pudo completar la búsqueda.';
      els.searchStatus.classList.add('is-error');
      return;
    }
    els.searchStatus.classList.remove('is-error');
    if (mode === 'results') {
      els.searchStatus.textContent = message;
    } else {
      els.searchStatus.textContent = '';
    }
  }

  function renderSearchResults(result) {
    const results = state.search.results;
    els.searchResults.replaceChildren();
    const files = new Set(results.map((hit) => hit.path));
    if (!results.length) {
      renderSearchStatus('empty', '');
      els.searchEmpty.hidden = false;
      const text = els.searchEmpty.querySelector('p');
      if (text) {
        text.textContent = `No se encontró «${result.query}» en los documentos de esta carpeta.`;
      }
      return;
    }
    els.searchEmpty.hidden = true;
    let status = `${formatNumber(results.length)} resultado${results.length === 1 ? '' : 's'} en ${formatNumber(files.size)} archivo${files.size === 1 ? '' : 's'}`;
    if (result.truncated) status += ' · búsqueda parcial';
    renderSearchStatus('results', status);

    const groups = new Map();
    for (const hit of results) {
      if (!groups.has(hit.path)) groups.set(hit.path, []);
      groups.get(hit.path).push(hit);
    }

    for (const [path, hits] of groups) {
      const group = document.createElement('div');
      group.className = 'result-group';
      const fileRow = document.createElement('div');
      fileRow.className = 'result-file';
      fileRow.appendChild(makeIcon('file', 'file-icon'));
      const fileCopy = document.createElement('div');
      fileCopy.className = 'result-file-copy';
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = hits[0].name;
      const folder = document.createElement('span');
      folder.className = 'result-folder';
      folder.textContent = hits[0].folder || 'Raíz de la carpeta';
      fileCopy.append(name, folder);
      fileRow.appendChild(fileCopy);
      group.appendChild(fileRow);

      for (const hit of hits) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'result-hit';
        button.dataset.path = path;
        button.dataset.query = result.query;
        const line = document.createElement('span');
        line.className = 'result-line';
        line.textContent = `L${hit.line}`;
        const snippet = document.createElement('span');
        snippet.className = 'result-snippet';
        appendHighlighted(snippet, hit.snippet, hit.match_start, hit.match_length);
        button.append(line, snippet);
        group.appendChild(button);
      }
      els.searchResults.appendChild(group);
    }
  }

  function appendHighlighted(container, text, start, length) {
    const safeStart = Math.max(0, Math.min(Number(start) || 0, text.length));
    const safeLength = Math.max(0, Math.min(Number(length) || 0, text.length - safeStart));
    if (!safeLength) {
      container.textContent = text;
      return;
    }
    container.appendChild(document.createTextNode(text.slice(0, safeStart)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(safeStart, safeStart + safeLength);
    container.appendChild(mark);
    container.appendChild(document.createTextNode(text.slice(safeStart + safeLength)));
  }

  // --------------------------------------------------------------- tab state
  function switchTab(tab) {
    state.tab = tab;
    const isFiles = tab === 'files';
    els.filesTab.classList.toggle('is-active', isFiles);
    els.filesTab.setAttribute('aria-selected', isFiles ? 'true' : 'false');
    els.searchTab.classList.toggle('is-active', !isFiles);
    els.searchTab.setAttribute('aria-selected', !isFiles ? 'true' : 'false');
    els.filesPanel.classList.toggle('is-active', isFiles);
    els.filesPanel.hidden = !isFiles;
    els.searchPanel.classList.toggle('is-active', !isFiles);
    els.searchPanel.hidden = isFiles;
    if (!isFiles) {
      requestAnimationFrame(() => els.contentSearchInput.focus());
    }
  }

  // -------------------------------------------------------------------- find
  function openFind(prefill) {
    if (!state.doc) return;
    els.findBar.hidden = false;
    if (typeof prefill === 'string') {
      els.findInput.value = prefill;
      performFind(true);
    } else if (state.find.query) {
      performFind(true);
    }
    requestAnimationFrame(() => {
      els.findInput.focus();
      els.findInput.select();
    });
  }

  function closeFind(clear = true) {
    if (!els.findBar) return;
    els.findBar.hidden = true;
    state.find.open = false;
    clearTimeout(state.find.timer);
    clearFindHighlights();
    state.find.matches = [];
    state.find.index = -1;
    if (clear) {
      els.findInput.value = '';
      state.find.query = '';
      els.findCount.textContent = '0 de 0';
    }
  }

  function clearFindHighlights() {
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete('find-all');
      CSS.highlights.delete('find-current');
    }
  }

  const scheduleFind = debounce(() => performFind(true), 130);

  function performFind(resetIndex = true) {
    if (!state.doc || els.findBar.hidden) return;
    const query = els.findInput.value;
    state.find.query = query;
    clearFindHighlights();
    state.find.matches = [];
    state.find.index = -1;
    els.findCount.classList.remove('is-empty');

    if (!query) {
      els.findCount.textContent = '0 de 0';
      return;
    }

    const matches = collectFindMatches(query);
    state.find.matches = matches;
    if (!matches.length) {
      els.findCount.textContent = 'Sin resultados';
      els.findCount.classList.add('is-empty');
      return;
    }
    state.find.index = resetIndex ? 0 : Math.min(state.find.index, matches.length - 1);
    state.find.index = Math.max(0, state.find.index);
    applyFindHighlights();
    updateFindCount();
    scrollToFindMatch();
  }

  function collectFindMatches(query) {
    const needle = fold(query);
    if (!needle) return [];
    const matches = [];
    const walker = document.createTreeWalker(els.content, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script, style, .heading-anchor')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      const { folded, map } = foldWithMap(node.nodeValue);
      let from = 0;
      while (true) {
        const index = folded.indexOf(needle, from);
        if (index < 0) break;
        const endFold = index + needle.length;
        if (endFold - 1 < map.length && index < map.length) {
          const startOffset = map[index];
          const endOffset = map[endFold - 1] + 1;
          try {
            const range = document.createRange();
            range.setStart(node, startOffset);
            range.setEnd(node, endOffset);
            matches.push({ range, node });
          } catch {
            // Ignorar rangos inválidos.
          }
        }
        from = index + Math.max(1, needle.length);
        if (matches.length >= MAX_FIND_MATCHES) return matches;
      }
      node = walker.nextNode();
    }
    return matches;
  }

  function applyFindHighlights() {
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
    if (state.find.matches.length) {
      CSS.highlights.set('find-all', new Highlight(...state.find.matches.map((match) => match.range)));
    }
    if (state.find.index >= 0 && state.find.matches[state.find.index]) {
      CSS.highlights.set('find-current', new Highlight(state.find.matches[state.find.index].range));
    }
  }

  function updateFindCount() {
    const total = state.find.matches.length;
    if (!total) {
      els.findCount.textContent = 'Sin resultados';
      return;
    }
    els.findCount.textContent = `${state.find.index + 1} de ${total}`;
  }

  function scrollToFindMatch() {
    const match = state.find.matches[state.find.index];
    if (!match) return;
    const rect = match.range.getBoundingClientRect();
    const areaRect = els.contentArea.getBoundingClientRect();
    const relativeTop = rect.top - areaRect.top;
    if (relativeTop < 80 || relativeTop > areaRect.height - 70) {
      els.contentArea.scrollTo({
        top: els.contentArea.scrollTop + relativeTop - areaRect.height / 2,
        behavior: 'smooth',
      });
    }
  }

  function navigateFind(delta) {
    if (!state.find.matches.length) {
      performFind(true);
      return;
    }
    state.find.index = (state.find.index + delta + state.find.matches.length) % state.find.matches.length;
    applyFindHighlights();
    updateFindCount();
    scrollToFindMatch();
  }

  // ------------------------------------------------------------------- menus
  function openMenu(kind) {
    closeMenus();
    const menu = kind === 'app' ? els.appMenu : els.docMenu;
    const button = kind === 'app' ? els.menuButton : els.documentMenuButton;
    if (!menu) return;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    state.menuTarget = kind;
    requestAnimationFrame(() => {
      const first = menu.querySelector('.menu-item:not(:disabled)');
      if (first) first.focus();
    });
  }

  function closeMenus() {
    if (els.appMenu) els.appMenu.hidden = true;
    if (els.docMenu) els.docMenu.hidden = true;
    if (els.menuButton) els.menuButton.setAttribute('aria-expanded', 'false');
    if (els.documentMenuButton) els.documentMenuButton.setAttribute('aria-expanded', 'false');
    state.menuTarget = null;
  }

  function toggleAppMenu() {
    if (state.menuTarget === 'app') closeMenus();
    else openMenu('app');
  }

  function toggleDocMenu() {
    if (!state.doc) return;
    if (state.menuTarget === 'doc') closeMenus();
    else openMenu('doc');
  }

  async function handleAction(action) {
    closeMenus();
    switch (action) {
      case 'open-folder':
        await chooseFolder();
        break;
      case 'refresh-folder':
        await refreshFolder();
        break;
      case 'close-folder':
        closeFolder();
        break;
      case 'help':
        openHelp();
        break;
      case 'quit':
        try { await call('quit_app'); } catch (error) { showToast(error.message, 'error'); }
        break;
      case 'copy-path':
        await copyActivePath();
        break;
      case 'reveal':
        await revealActive();
        break;
      case 'reload-doc':
        await reloadDocument();
        break;
      case 'find':
        openFind();
        break;
      case 'toggle-toc':
        toggleToc();
        break;
      default:
        break;
    }
  }

  function closeFolder() {
    closeMenus();
    call('close_folder').catch(() => {});
    showWelcome();
    showToast('Carpeta cerrada.', 'info');
  }

  // ------------------------------------------------------------------ modals
  function openHelp() {
    if (!els.helpModal) return;
    closeMenus();
    state.helpReturnFocus = document.activeElement;
    els.helpModal.hidden = false;
    requestAnimationFrame(() => els.helpCloseButton.focus());
  }

  function closeHelp() {
    if (!els.helpModal || els.helpModal.hidden) return;
    els.helpModal.hidden = true;
    if (state.helpReturnFocus && typeof state.helpReturnFocus.focus === 'function') {
      state.helpReturnFocus.focus();
    }
    state.helpReturnFocus = null;
  }

  function openLightbox(image) {
    if (!image || !image.src) return;
    state.lightboxReturnFocus = image;
    els.lightboxImage.src = image.src;
    els.lightboxImage.alt = image.alt || '';
    els.lightboxCaption.textContent = image.alt || image.title || '';
    els.lightbox.hidden = false;
    requestAnimationFrame(() => els.lightboxClose.focus());
  }

  function closeLightbox() {
    if (!els.lightbox || els.lightbox.hidden) return;
    els.lightbox.hidden = true;
    els.lightboxImage.src = '';
    if (state.lightboxReturnFocus && typeof state.lightboxReturnFocus.focus === 'function') {
      state.lightboxReturnFocus.focus();
    }
    state.lightboxReturnFocus = null;
  }

  function trapFocus(event, container) {
    if (event.key !== 'Tab' || !container || container.hidden) return;
    const focusable = Array.from(
      container.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])'),
    ).filter((element) => !element.disabled && element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ------------------------------------------------------------------ resize
  let resizeState = null;

  function beginResize(event) {
    if (isMobile() || !state.sidebarOpen) return;
    event.preventDefault();
    resizeState = {
      startX: event.clientX,
      startWidth: els.sidebar.getBoundingClientRect().width,
    };
    els.sidebarResizer.classList.add('is-dragging');
    els.sidebarResizer.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing');
  }

  function moveResize(event) {
    if (!resizeState) return;
    const width = Math.max(240, Math.min(420, resizeState.startWidth + event.clientX - resizeState.startX));
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  }

  function endResize(event) {
    if (!resizeState) return;
    const width = Math.round(els.sidebar.getBoundingClientRect().width);
    resizeState = null;
    els.sidebarResizer.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing');
    try { els.sidebarResizer.releasePointerCapture(event.pointerId); } catch { /* noop */ }
    saveSettings({ sidebar_width: width });
  }

  // ------------------------------------------------------------------ scroll
  function onContentScroll() {
    if (state.scrollTick) return;
    state.scrollTick = true;
    requestAnimationFrame(() => {
      state.scrollTick = false;
      const area = els.contentArea;
      const max = area.scrollHeight - area.clientHeight;
      const ratio = max > 0 ? Math.min(1, Math.max(0, area.scrollTop / max)) : 0;
      els.readingProgress.style.width = `${(ratio * 100).toFixed(2)}%`;
      if (state.doc) state.scrollPositions.set(state.activePath, area.scrollTop);
      updateActiveHeading();
    });
  }

  function updateActiveHeading() {
    if (!state.tocItems.length) return;
    const cutoff = els.contentArea.getBoundingClientRect().top + 95;
    let active = 0;
    for (let i = 0; i < state.tocItems.length; i += 1) {
      const rect = state.tocItems[i].element.getBoundingClientRect();
      if (rect.top <= cutoff) active = i;
      else break;
    }
    if (active === state.activeHeading) return;
    state.activeHeading = active;
    state.tocItems.forEach((item, index) => {
      item.link.classList.toggle('is-active', index === active);
    });
    const activeLink = state.tocItems[active] && state.tocItems[active].link;
    if (activeLink) {
      const linkRect = activeLink.getBoundingClientRect();
      const tocRect = els.tocPanel.getBoundingClientRect();
      if (linkRect.top < tocRect.top + 30 || linkRect.bottom > tocRect.bottom - 20) {
        activeLink.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  // ------------------------------------------------------------------ events
  function bindEvents() {
    els.openFolderButton.addEventListener('click', openFolderDialog);
    els.welcomeOpenButton.addEventListener('click', openFolderDialog);
    els.emptyOpenFolder.addEventListener('click', openFolderDialog);
    els.emptyFolderOpenButton.addEventListener('click', openFolderDialog);
    els.welcomeDemoButton.addEventListener('click', openDemo);
    els.emptyFolderRefreshButton.addEventListener('click', () => refreshFolder());

    els.brandButton.addEventListener('click', toggleAppMenu);
    els.menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleAppMenu();
    });
    els.documentMenuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleDocMenu();
    });

    els.sidebarToggle.addEventListener('click', () => setSidebar(!state.sidebarOpen));
    els.sidebarScrim.addEventListener('click', () => setSidebar(false, false));

    els.backButton.addEventListener('click', () => navigateHistory(-1));
    els.forwardButton.addEventListener('click', () => navigateHistory(1));

    els.filesTab.addEventListener('click', () => switchTab('files'));
    els.searchTab.addEventListener('click', () => switchTab('search'));
    els.tree.addEventListener('click', onTreeClick);
    els.filterInput.addEventListener('input', updateFilterChrome);
    els.filterInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        els.filterInput.value = '';
        updateFilterChrome();
        els.filterInput.blur();
      }
    });
    els.clearFilterButton.addEventListener('click', () => {
      els.filterInput.value = '';
      updateFilterChrome();
      els.filterInput.focus();
    });
    els.clearFilterLink.addEventListener('click', () => {
      els.filterInput.value = '';
      updateFilterChrome();
    });
    els.contentSearchForm.addEventListener('submit', runContentSearch);
    els.searchResults.addEventListener('click', onSearchResultClick);

    els.refreshFolderButton.addEventListener('click', () => refreshFolder());
    els.menuRefreshFolder.addEventListener('click', () => refreshFolder());
    els.copyPathButton.addEventListener('click', copyActivePath);
    els.revealButton.addEventListener('click', revealActive);
    els.backToTopButton.addEventListener('click', () => {
      els.contentArea.scrollTo({ top: 0, behavior: 'smooth' });
    });

    els.findButton.addEventListener('click', () => openFind());
    els.findCloseButton.addEventListener('click', () => closeFind());
    els.findNextButton.addEventListener('click', () => navigateFind(1));
    els.findPrevButton.addEventListener('click', () => navigateFind(-1));
    els.findInput.addEventListener('input', scheduleFind);
    els.findInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        navigateFind(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeFind();
      }
    });

    els.tocButton.addEventListener('click', toggleToc);
    els.themeQuickButton.addEventListener('click', () => {
      applyTheme(resolvedTheme() === 'dark' ? 'light' : 'dark', true);
    });
    els.helpButton.addEventListener('click', openHelp);
    els.menuButton.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenus();
    });

    els.helpCloseButton.addEventListener('click', closeHelp);
    els.helpDoneButton.addEventListener('click', closeHelp);
    els.helpModal.addEventListener('click', (event) => {
      if (event.target === els.helpModal) closeHelp();
    });
    els.openConfigButton.addEventListener('click', async () => {
      try {
        await call('open_data_folder');
      } catch (error) {
        showToast(error.message, 'error');
      }
    });

    els.lightboxClose.addEventListener('click', closeLightbox);
    els.lightbox.addEventListener('click', (event) => {
      if (event.target === els.lightbox) closeLightbox();
    });

    els.content.addEventListener('click', onContentClick);
    els.content.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.prose img')) {
        event.preventDefault();
        openLightbox(event.target);
      }
    });
    els.contentArea.addEventListener('scroll', onContentScroll, { passive: true });

    document.addEventListener('click', (event) => {
      if (!event.target.closest('#appMenu') && !event.target.closest('#menuButton') && !event.target.closest('#brandButton')) {
        if (state.menuTarget === 'app') closeMenus();
      }
      if (!event.target.closest('#docMenu') && !event.target.closest('#documentMenuButton')) {
        if (state.menuTarget === 'doc') closeMenus();
      }
      const actionElement = event.target.closest('[data-action]');
      if (actionElement) {
        event.preventDefault();
        handleAction(actionElement.dataset.action);
      }
      const themeChoice = event.target.closest('[data-theme-choice]');
      if (themeChoice) {
        applyTheme(themeChoice.dataset.themeChoice, true);
      }
      const fontStep = event.target.closest('[data-font-step]');
      if (fontStep) {
        stepFont(Number(fontStep.dataset.fontStep));
        els.menuFontSize.textContent = `${state.settings.font_size} px`;
      }
    });

    els.sidebarResizer.addEventListener('pointerdown', beginResize);
    els.sidebarResizer.addEventListener('pointermove', moveResize);
    els.sidebarResizer.addEventListener('pointerup', endResize);
    els.sidebarResizer.addEventListener('pointercancel', endResize);

    window.addEventListener('resize', updateScrimForViewport);
    document.addEventListener('keydown', onKeyDown);

    if (window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => {
        if (state.settings.theme === 'system') {
          document.documentElement.dataset.theme = resolvedTheme();
          updateThemeControls();
        }
      };
      if (media.addEventListener) media.addEventListener('change', listener);
      else if (media.addListener) media.addListener(listener);
    }
  }

  function onContentClick(event) {
    const image = event.target.closest('.prose img');
    if (image) {
      event.preventDefault();
      openLightbox(image);
      return;
    }
    const anchor = event.target.closest('.prose a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';

    if (anchor.dataset.mdPath) {
      event.preventDefault();
      openDocument(anchor.dataset.mdPath, {
        fragment: anchor.dataset.mdFragment || null,
        closeSidebar: false,
      });
      return;
    }
    if (anchor.dataset.external) {
      event.preventDefault();
      call('open_external', anchor.href).catch((error) => showToast(error.message, 'error'));
      return;
    }
    if (anchor.dataset.filePath) {
      event.preventDefault();
      call('open_external', anchor.dataset.filePath).catch((error) => showToast(error.message, 'error'));
      return;
    }
    if (anchor.dataset.brokenLink) {
      event.preventDefault();
      showToast('El enlace no existe dentro de esta carpeta.', 'error');
      return;
    }
    if (anchor.dataset.folderPath) {
      event.preventDefault();
      call('reveal', anchor.dataset.folderPath).catch((error) => showToast(error.message, 'error'));
      return;
    }
    if (href.startsWith('#')) {
      event.preventDefault();
      scrollToAnchor(href.slice(1));
    }
  }

  function onSearchResultClick(event) {
    const hit = event.target.closest('.result-hit');
    if (!hit) return;
    const path = hit.dataset.path;
    const query = hit.dataset.query || els.contentSearchInput.value.trim();
    if (!path) return;
    if (isMobile()) setSidebar(false, false);
    openDocument(path, { findQuery: query, closeSidebar: false });
  }

  function onKeyDown(event) {
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    const key = event.key;

    if (key === 'Escape') {
      if (!els.lightbox.hidden) { closeLightbox(); return; }
      if (!els.helpModal.hidden) { closeHelp(); return; }
      if (state.menuTarget) { closeMenus(); return; }
      if (!els.findBar.hidden) { closeFind(); return; }
      if (typing) active.blur();
      return;
    }

    if (!els.lightbox.hidden) { trapFocus(event, els.lightbox); return; }
    if (!els.helpModal.hidden) { trapFocus(event, els.helpModal); return; }

    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'o') {
      event.preventDefault();
      chooseFolder();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'b') {
      event.preventDefault();
      setSidebar(!state.sidebarOpen);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'f') {
      event.preventDefault();
      openFind();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (key === '+' || key === '=')) {
      event.preventDefault();
      stepFont(1);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === '-') {
      event.preventDefault();
      stepFont(-1);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === '0') {
      event.preventDefault();
      setFontSize(DEFAULT_FONT_SIZE);
      return;
    }
    if (key === 'F5' || ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'r')) {
      event.preventDefault();
      if (state.activePath) reloadDocument();
      else if (state.folder) refreshFolder();
      return;
    }
    if (event.altKey && key === 'ArrowLeft') {
      event.preventDefault();
      navigateHistory(-1);
      return;
    }
    if (event.altKey && key === 'ArrowRight') {
      event.preventDefault();
      navigateHistory(1);
      return;
    }
    if (!typing && key === '/') {
      event.preventDefault();
      switchTab('files');
      els.filterInput.focus();
      return;
    }
    if (!typing && (key === '?' || (event.shiftKey && key === '/'))) {
      event.preventDefault();
      openHelp();
    }
  }

  // ------------------------------------------------------------------ recents
  function renderRecents() {
    if (!els.welcomeRecents) return;
    els.welcomeRecents.replaceChildren();
    if (!state.recents.length) {
      els.welcomeRecents.hidden = true;
      return;
    }
    els.welcomeRecents.hidden = false;

    const heading = document.createElement('div');
    heading.className = 'recents-heading';
    const title = document.createElement('span');
    title.textContent = 'Carpetas recientes';
    heading.appendChild(title);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'recents-clear text-link';
    clear.textContent = 'Limpiar';
    clear.addEventListener('click', async () => {
      try {
        await call('forget_recents');
        state.recents = [];
        renderRecents();
        showToast('Carpetas recientes eliminadas.', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
    heading.appendChild(clear);
    els.welcomeRecents.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'recents-grid';
    for (const recent of state.recents.slice(0, 6)) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'recent-card';
      const unavailable = recent.available === false;
      card.classList.toggle('is-unavailable', unavailable);
      if (unavailable) card.disabled = true;
      card.title = recent.path;
      const icon = document.createElement('span');
      icon.className = 'recent-icon';
      icon.appendChild(makeIcon('folder', 'icon'));
      const copy = document.createElement('span');
      copy.className = 'recent-copy';
      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = recent.name || recent.path;
      const path = document.createElement('span');
      path.className = 'recent-path';
      path.textContent = unavailable ? `${recent.path} · no disponible` : recent.path;
      copy.append(name, path);
      const arrow = document.createElement('span');
      arrow.className = 'recent-arrow';
      arrow.appendChild(makeIcon('arrow-right', 'icon'));
      card.append(icon, copy, arrow);
      if (!unavailable) {
        card.addEventListener('click', () => openFolderPath(recent.path, { remember: true }));
      }
      grid.appendChild(card);
    }
    els.welcomeRecents.appendChild(grid);
  }

  // -------------------------------------------------------------------- init
  async function init() {
    cacheElements();
    // Tema inmediato para evitar un destello claro en modo oscuro.
    document.documentElement.dataset.theme = systemTheme();
    bindEvents();
    updateThemeControls();
    updateNavButtons();
    setDocActionsEnabled(false);
    updateOpenFolderLabels();
    await boot();
  }

  window.addEventListener('error', (event) => {
    console.error('Error de interfaz:', event.error || event.message);
    window.__lectorErrors = window.__lectorErrors || [];
    window.__lectorErrors.push(String(event.message || event.error || 'Error desconocido'));
    if (!state.booted) addBootError('Ocurrió un error al cargar la interfaz. Revisa la consola para más detalles.');
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('Promesa rechazada:', event.reason);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
