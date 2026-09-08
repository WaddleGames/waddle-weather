/* SkyMonitor interface translation layer.
 *
 * The app is intentionally kept as one static document. This layer translates
 * user-facing text at runtime through the same lightweight Google translation
 * endpoint already used for imported weather alerts, then caches successful
 * results locally. English remains the permanent fallback when a translation
 * is unavailable or the visitor is offline.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'skymonitor_ui_language';
    var CACHE_KEY = 'skymonitor_i18n_cache_v1';
    var CACHE_LIMIT = 1500;
    var TRANSLATION_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
    var RTL_LANGUAGES = { ar: true, he: true };
    var LANGUAGES = [
        { code: 'en', label: 'English' },
        { code: 'es', label: 'Español' },
        { code: 'pt', label: 'Português (Brasil)' },
        { code: 'fr', label: 'Français' },
        { code: 'de', label: 'Deutsch' },
        { code: 'it', label: 'Italiano' },
        { code: 'nl', label: 'Nederlands' },
        { code: 'pl', label: 'Polski' },
        { code: 'tr', label: 'Türkçe' },
        { code: 'ar', label: 'العربية' },
        { code: 'he', label: 'עברית' },
        { code: 'hi', label: 'हिन्दी' },
        { code: 'zh-CN', label: '简体中文' },
        { code: 'ja', label: '日本語' },
        { code: 'ko', label: '한국어' },
        { code: 'ru', label: 'Русский' }
    ];
    var LANGUAGE_CODES = {};
    LANGUAGES.forEach(function (language) { LANGUAGE_CODES[language.code] = true; });

    var currentLanguage = 'en';
    var currentSelection = 'auto';
    var isApplying = false;
    var observer = null;
    var pendingTimer = null;
    var pendingRoots = [];
    var translationEpoch = 0;
    var pendingTranslations = Object.create(null);
    var originalText = new WeakMap();
    var translatedText = new WeakMap();
    var translatedLanguage = new WeakMap();
    var originalAttributes = new WeakMap();
    var translatedAttributes = new WeakMap();
    var cache = loadCache();

    function loadCache() {
        try {
            var parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function saveCache() {
        try {
            var keys = Object.keys(cache);
            while (keys.length > CACHE_LIMIT) {
                delete cache[keys.shift()];
            }
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch (e) {}
    }

    function supported(code) {
        return !!LANGUAGE_CODES[code];
    }

    function resolveLanguage(selection) {
        if (selection && selection !== 'auto' && supported(selection)) return selection;

        var browser = (navigator.language || navigator.userLanguage || 'en').replace('_', '-');
        var exact = browser.toLowerCase();
        if (supported(exact)) return exact;

        var base = exact.split('-')[0];
        if (supported(base)) return base;
        if (base === 'pt') return 'pt';
        if (base === 'zh') return 'zh-CN';
        return 'en';
    }

    function shouldSkipElement(element) {
        if (!element || !element.tagName) return true;
        var tag = element.tagName.toLowerCase();
        if (/^(script|style|noscript|template|textarea|select|option|code|pre)$/.test(tag)) return true;
        if (/^(sync-indicator|sync-time-display|threat-updated|spc-countdown|turnstile-status|report-status|custom-sky-alerts-status|storm-status-tag)$/.test(element.id || '')) return true;
        if (element.closest && element.closest('[data-sky-i18n-skip],input,[contenteditable="true"],.leaflet-container,#map,#reporting-map')) return true;
        return false;
    }

    function shouldTranslateText(value, element) {
        if (!value || !value.trim() || shouldSkipElement(element)) return false;
        var text = value.trim();
        if (text.length < 2 || /^[\d\s.,:%°+\-\/()]+$/.test(text)) return false;
        if (/^(https?:\/\/|mailto:|www\.)/i.test(text) || /@/.test(text)) return false;
        return true;
    }

    function collectTextNodes(root, onlyMissing) {
        var nodes = [];
        if (!root || !document.createTreeWalker) return nodes;
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        var node;
        while ((node = walker.nextNode())) {
            var parent = node.parentElement;
            if (!shouldTranslateText(node.nodeValue, parent)) continue;

            if (!originalText.has(node)) {
                originalText.set(node, node.nodeValue);
            } else if (!isApplying && translatedText.has(node) && node.nodeValue !== translatedText.get(node)) {
                // The app replaced a translated text node with fresh English
                // content. Treat the new value as the source text.
                originalText.set(node, node.nodeValue);
                translatedText.delete(node);
                translatedLanguage.delete(node);
            }
            if (onlyMissing && translatedLanguage.get(node) === currentLanguage) continue;
            nodes.push(node);
        }
        return nodes;
    }

    function collectAttributes(root, onlyMissing) {
        var nodes = [];
        if (!root || !root.querySelectorAll) return nodes;
        var elements = root.querySelectorAll('[aria-label],[title],[placeholder]');
        for (var i = 0; i < elements.length; i++) {
            var element = elements[i];
            if (shouldSkipElement(element)) continue;
            ['aria-label', 'title', 'placeholder'].forEach(function (attribute) {
                if (!element.hasAttribute(attribute)) return;
                var value = element.getAttribute(attribute);
                if (!value || value.length < 2 || /^(https?:\/\/|mailto:)/i.test(value)) return;
                if (!originalAttributes.has(element)) originalAttributes.set(element, {});
                var originals = originalAttributes.get(element);
                if (!(attribute in originals)) originals[attribute] = value;
                var translatedForElement = translatedAttributes.get(element) || {};
                if (onlyMissing && translatedForElement._language === currentLanguage &&
                    translatedForElement[attribute]) return;
                nodes.push({ element: element, attribute: attribute, value: originals[attribute] });
            });
        }
        return nodes;
    }

    function cacheKey(language, text) {
        return language + '|' + text;
    }

    async function translateText(text, language) {
        if (!text || language === 'en') return text;
        var key = cacheKey(language, text);
        if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
        if (pendingTranslations[key]) return pendingTranslations[key];

        var request = (async function () {
            try {
                var url = TRANSLATION_ENDPOINT +
                    '?client=gtx&sl=auto&tl=' + encodeURIComponent(language) +
                    '&dt=t&q=' + encodeURIComponent(text);
                var response = await fetch(url);
                if (!response.ok) return text;
                var data = await response.json();
                var translated = data && data[0]
                    ? data[0].map(function (segment) { return segment && segment[0] ? segment[0] : ''; }).join('')
                    : '';
                if (!translated) return text;
                cache[key] = translated;
                return translated;
            } catch (e) {
                return text;
            } finally {
                delete pendingTranslations[key];
            }
        })();
        pendingTranslations[key] = request;
        return request;
    }

    async function resolveTranslations(items, language, sourceFor) {
        var cursor = 0;
        var results = new Array(items.length);
        async function worker() {
            while (cursor < items.length) {
                var index = cursor++;
                results[index] = await translateText(sourceFor(items[index]), language);
            }
        }
        var workers = [];
        var workerCount = Math.min(8, Math.max(1, items.length));
        for (var i = 0; i < workerCount; i++) workers.push(worker());
        await Promise.all(workers);
        return results;
    }

    function restoreEnglish(root) {
        var nodes = collectTextNodes(root || document.body);
        isApplying = true;
        nodes.forEach(function (node) {
            if (originalText.has(node)) {
                node.nodeValue = originalText.get(node);
                translatedText.delete(node);
                translatedLanguage.delete(node);
            }
        });
        isApplying = false;

        var elements = (root || document).querySelectorAll
            ? (root || document).querySelectorAll('[aria-label],[title],[placeholder]')
            : [];
        for (var i = 0; i < elements.length; i++) {
            var originals = originalAttributes.get(elements[i]);
            if (!originals) continue;
            Object.keys(originals).forEach(function (attribute) {
                elements[i].setAttribute(attribute, originals[attribute]);
            });
        }
    }

    function scheduleDynamicTranslation() {
        if (pendingTimer || currentLanguage === 'en') return;
        pendingTimer = setTimeout(function () {
            pendingTimer = null;
            var roots = pendingRoots.splice(0);
            applyLanguage(currentLanguage, true, translationEpoch, roots);
        }, 250);
    }

    function observe() {
        if (observer || !document.body || !window.MutationObserver) return;
        observer = new MutationObserver(function (mutations) {
            if (isApplying || currentLanguage === 'en') return;
            mutations.forEach(function (mutation) {
                if (mutation.type !== 'childList' || !mutation.addedNodes || !mutation.addedNodes.length) return;
                for (var i = 0; i < mutation.addedNodes.length; i++) {
                    var added = mutation.addedNodes[i];
                    var root = added.nodeType === 1 ? added : added.parentElement;
                    if (root && pendingRoots.indexOf(root) === -1) pendingRoots.push(root);
                }
            });
            if (pendingRoots.length) scheduleDynamicTranslation();
        });
        // Only observe newly-created DOM. Constant text updates such as the
        // sync clock and UPDATING indicator must not enter the translation
        // queue on every refresh.
        observer.observe(document.body, { childList: true, subtree: true });
    }

    async function applyLanguage(language, dynamicOnly, token, roots) {
        if (!supported(language)) language = 'en';
        if (token !== undefined && token !== translationEpoch) return;
        currentLanguage = language;
        document.documentElement.lang = language;
        document.documentElement.dir = RTL_LANGUAGES[language] ? 'rtl' : 'ltr';
        document.documentElement.setAttribute('data-sky-language', language);

        if (language === 'en') {
            restoreEnglish(document.body);
            return;
        }

        var scanRoots = dynamicOnly ? (roots || []) : [document.body];
        var nodes = [];
        var attributes = [];
        var seenNodes = new WeakSet();
        var seenElements = new WeakSet();
        scanRoots.forEach(function (root) {
            if (!root || !root.isConnected) return;
            collectTextNodes(root, dynamicOnly).forEach(function (node) {
                if (!seenNodes.has(node)) {
                    seenNodes.add(node);
                    nodes.push(node);
                }
            });
            collectAttributes(root, dynamicOnly).forEach(function (item) {
                if (!seenElements.has(item.element)) {
                    seenElements.add(item.element);
                    attributes.push(item);
                }
            });
        });
        if (dynamicOnly && !nodes.length && !attributes.length) return;

        // Resolve the entire batch first, then apply it in one DOM transaction.
        // This prevents the page from visibly bouncing between English and the
        // selected language while individual requests finish.
        var nodeTranslations = await resolveTranslations(nodes, language, function (node) {
            return originalText.get(node) || node.nodeValue;
        });
        var attributeTranslations = await resolveTranslations(attributes, language, function (item) {
            return item.value;
        });
        if (token !== undefined && token !== translationEpoch) return;
        isApplying = true;
        nodes.forEach(function (node, index) {
            if (!node || !node.isConnected) return;
            node.nodeValue = nodeTranslations[index];
            translatedText.set(node, nodeTranslations[index]);
            translatedLanguage.set(node, language);
        });
        attributes.forEach(function (item, index) {
            if (!item.element || !item.element.isConnected) return;
            item.element.setAttribute(item.attribute, attributeTranslations[index]);
            var translatedForElement = translatedAttributes.get(item.element) || {};
            translatedForElement[item.attribute] = attributeTranslations[index];
            translatedForElement._language = language;
            translatedAttributes.set(item.element, translatedForElement);
        });
        isApplying = false;
        saveCache();
    }

    function syncSelect() {
        var select = document.getElementById('ui-language-select');
        if (select) select.value = currentSelection;
    }

    function setLanguage(selection) {
        currentSelection = supported(selection) || selection === 'auto' ? selection : 'auto';
        try { localStorage.setItem(STORAGE_KEY, currentSelection); } catch (e) {}
        var resolved = resolveLanguage(currentSelection);
        syncSelect();
        var token = ++translationEpoch;
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        pendingRoots = [];
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        var select = document.getElementById('ui-language-select');
        if (select) select.disabled = true;
        applyLanguage(resolved, false, token).then(function () {
            if (token !== translationEpoch) return;
            if (select) select.disabled = false;
            observe();
            // If the user has chosen to translate alerts into the app language,
            // refresh them only after the interface transaction is complete.
            if (localStorage.getItem('alerts_language') === 'app' &&
                typeof window.setAlertsLanguage === 'function') {
                window.setAlertsLanguage('app');
            }
        });
    }

    function init() {
        try { currentSelection = localStorage.getItem(STORAGE_KEY) || 'auto'; } catch (e) {}
        if (!(supported(currentSelection) || currentSelection === 'auto')) currentSelection = 'auto';
        syncSelect();
        var token = ++translationEpoch;
        applyLanguage(resolveLanguage(currentSelection), false, token).then(function () {
            if (token === translationEpoch) observe();
        });
    }

    window.SkyMonitorI18n = {
        languages: LANGUAGES,
        getLanguage: function () { return currentLanguage; },
        getSelection: function () { return currentSelection; },
        getAlertLanguage: function () {
            var selected = localStorage.getItem('alerts_language') || 'default';
            return selected === 'app' ? currentLanguage : selected;
        },
        translateText: translateText,
        setLanguage: setLanguage
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();