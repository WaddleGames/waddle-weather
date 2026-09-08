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
    var TRANSLATION_ENDPOINT = '/api/translate';
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
    var translationAbortController = null;
    var transactionRunning = false;
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

    var VOLATILE_SELECTOR = '#sync-indicator, #sync-time-display, #station-clock, #threat-updated, #spc-countdown, #turnstile-status, #report-status, #custom-sky-alerts-status, #storm-status-tag, [data-sky-i18n-skip]';

    function shouldSkipElement(element) {
        if (!element || !element.tagName) return true;
        var tag = element.tagName.toLowerCase();
        if (/^(script|style|noscript|template|textarea|select|option|code|pre)$/.test(tag)) return true;
        if (element.matches && element.matches(VOLATILE_SELECTOR)) return true;
        if (element.closest && element.closest(VOLATILE_SELECTOR)) return true;
        if (element.closest && element.closest('input,[contenteditable="true"],.leaflet-container,#map,#reporting-map')) return true;
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

    function parseTranslationResponse(data) {
        return data && data[0]
            ? data[0].map(function (segment) { return segment && segment[0] ? segment[0] : ''; }).join('')
            : '';
    }

    async function translateBatch(texts, language, signal) {
        var results = texts.slice();
        var missing = [];
        texts.forEach(function (text, index) {
            if (!text || language === 'en') return;
            var key = cacheKey(language, text);
            if (Object.prototype.hasOwnProperty.call(cache, key)) {
                results[index] = cache[key];
            } else {
                missing.push({ text: text, index: index });
            }
        });
        if (!missing.length) return results;

        // Keep each upstream request below the endpoint's URL limit while
        // translating many labels in one request instead of one request per DOM node.
        var delimiter = '___SKYMONITOR_BREAK___';
        var chunks = [];
        var currentChunk = [];
        var currentLength = 0;
        missing.forEach(function (item) {
            var nextLength = currentLength + item.text.length +
                (currentChunk.length ? delimiter.length : 0);
            if (currentChunk.length && nextLength > 4200) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentLength = 0;
            }
            currentChunk.push(item);
            currentLength += item.text.length + (currentChunk.length > 1 ? delimiter.length : 0);
        });
        if (currentChunk.length) chunks.push(currentChunk);

        for (var chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
            var chunk = chunks[chunkIndex];
            var text = chunk.map(function (item) { return item.text; }).join(delimiter);
            try {
                var url = TRANSLATION_ENDPOINT +
                    '?client=gtx&sl=auto&tl=' + encodeURIComponent(language) +
                    '&dt=t&q=' + encodeURIComponent(text);
                var response = await fetch(url, signal ? { signal: signal } : undefined);
                if (!response.ok) continue;
                var translated = parseTranslationResponse(await response.json());
                var parts = translated.split('___SKYMONITOR_BREAK___');
                if (chunk.length === 1 && translated) parts = [translated];
                if (parts.length !== chunk.length) continue;
                parts.forEach(function (part, index) {
                    var value = part.replace(/^\s+|\s+$/g, '');
                    if (!value) return;
                    var source = chunk[index];
                    var key = cacheKey(language, source.text);
                    cache[key] = value;
                    results[source.index] = value;
                });
            } catch (e) {
                // Keep the original English text for this batch if it fails.
            }
        }
        return results;
    }

    async function translateText(text, language, signal) {
        return (await translateBatch([text], language, signal))[0];
    }

    async function resolveTranslations(items, language, sourceFor, signal) {
        var unique = [];
        var positions = Object.create(null);
        var itemKeys = new Array(items.length);
        items.forEach(function (item, index) {
            var text = sourceFor(item);
            var key = language + '\u0000' + text;
            itemKeys[index] = key;
            if (!Object.prototype.hasOwnProperty.call(positions, key)) {
                positions[key] = unique.length;
                unique.push(text);
            }
        });
        var translated = await translateBatch(unique, language, signal);
        return itemKeys.map(function (key) { return translated[positions[key]]; });
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

    function isVisibleElement(element) {
        if (!element || !element.isConnected) return false;
        if (element.hidden) return false;
        if (element.offsetWidth || element.offsetHeight || element.getClientRects().length) return true;
        return false;
    }

    function queueRoot(root) {
        if (!root || !root.isConnected || root === document.body) return;
        if (root.closest && root.closest(VOLATILE_SELECTOR)) return;
        if (pendingRoots.indexOf(root) === -1) pendingRoots.push(root);
    }

    function scheduleDynamicTranslation() {
        if (pendingTimer || currentLanguage === 'en' || isApplying || transactionRunning || !pendingRoots.length) return;
        pendingTimer = setTimeout(function () {
            pendingTimer = null;
            var roots = pendingRoots.splice(0);
            applyLanguage(currentLanguage, true, translationEpoch, roots);
        }, 150);
    }

    function observe() {
        if (observer || !document.body || !window.MutationObserver) return;
        observer = new MutationObserver(function (mutations) {
            if (currentLanguage === 'en') return;
            mutations.forEach(function (mutation) {
                if (mutation.type === 'childList' && mutation.addedNodes && mutation.addedNodes.length) {
                    for (var i = 0; i < mutation.addedNodes.length; i++) {
                        var added = mutation.addedNodes[i];
                        queueRoot(added.nodeType === 1 ? added : added.parentElement);
                    }
                } else if (mutation.type === 'attributes' && mutation.target && isVisibleElement(mutation.target)) {
                    // Modal contents are often created while hidden, then shown
                    // by a class/style change without any new child nodes.
                    queueRoot(mutation.target);
                }
            });
            if (pendingRoots.length && !isApplying) scheduleDynamicTranslation();
        });
        // Keep observing during the initial translation transaction so modal
        // content created in that window cannot be missed. Character data and
        // volatile text updates are intentionally not observed.
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
        });
    }

    async function resolveAndApply(nodes, attributes, language, token, signal) {
        if (!nodes.length && !attributes.length) return true;
        var nodeTranslations = await resolveTranslations(nodes, language, function (node) {
            return originalText.get(node) || node.nodeValue;
        }, signal);
        var attributeTranslations = await resolveTranslations(attributes, language, function (item) {
            return item.value;
        }, signal);
        if (token !== undefined && token !== translationEpoch) return false;
        isApplying = true;
        try {
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
        } finally {
            isApplying = false;
        }
        saveCache();
        return true;
    }

    async function applyLanguage(language, dynamicOnly, token, roots) {
        if (!supported(language)) language = 'en';
        if (token !== undefined && token !== translationEpoch) return;
        if (transactionRunning) return;
        transactionRunning = true;
        try {
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
        var seenAttributes = new WeakMap();
        scanRoots.forEach(function (root) {
            if (!root || !root.isConnected) return;
            collectTextNodes(root, dynamicOnly).forEach(function (node) {
                if (!seenNodes.has(node)) {
                    seenNodes.add(node);
                    nodes.push(node);
                }
            });
            collectAttributes(root, dynamicOnly).forEach(function (item) {
                var elementAttributes = seenAttributes.get(item.element) || {};
                if (elementAttributes[item.attribute]) return;
                elementAttributes[item.attribute] = true;
                seenAttributes.set(item.element, elementAttributes);
                attributes.push(item);
            });
        });
        if (dynamicOnly && !nodes.length && !attributes.length) return;

        // Translate visible content first so the page starts changing quickly;
        // hidden modal/info content follows without an English bounce.
        var visibleNodes = [], hiddenNodes = [];
        var visibleAttributes = [], hiddenAttributes = [];
        nodes.forEach(function (node) {
            (isVisibleElement(node.parentElement) ? visibleNodes : hiddenNodes).push(node);
        });
        attributes.forEach(function (item) {
            (isVisibleElement(item.element) ? visibleAttributes : hiddenAttributes).push(item);
        });
        var signal = translationAbortController ? translationAbortController.signal : undefined;
        if (!await resolveAndApply(visibleNodes, visibleAttributes, language, token, signal)) return;
        if (!await resolveAndApply(hiddenNodes, hiddenAttributes, language, token, signal)) return;
        } finally {
            transactionRunning = false;
            if ((token === undefined || token === translationEpoch) && pendingRoots.length && currentLanguage !== 'en') {
                scheduleDynamicTranslation();
            }
        }
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
        if (translationAbortController) translationAbortController.abort();
        translationAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        pendingRoots = [];
        observe();
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
        translationAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        observe();
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