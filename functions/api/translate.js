const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=86400, s-maxage=86400'
};

const TRANSLATION_PROVIDERS = [
    { host: 'https://lingva.ml', path: '/api/v1/auto', kind: 'lingva' },
    { host: 'https://clients5.google.com', path: '/translate_a/t', kind: 'chrome' },
    { host: 'https://translate.googleapis.com', path: '/translate_a/single', kind: 'single' },
    { host: 'https://translate.google.com', path: '/translate_a/single', kind: 'single' }
];

function json(body, status) {
    return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: JSON_HEADERS
    });
}

function providerUrl(provider, language, text) {
    if (provider.kind === 'lingva') {
        return provider.host + provider.path + '/' + encodeURIComponent(language) + '/' + encodeURIComponent(text);
    }
    const upstream = new URL(provider.host + provider.path);
    upstream.searchParams.set('client', provider.kind === 'chrome' ? 'dict-chrome-ex' : 'gtx');
    upstream.searchParams.set('sl', 'auto');
    upstream.searchParams.set('tl', language);
    if (provider.kind === 'single') upstream.searchParams.set('dt', 't');
    upstream.searchParams.set('q', text);
    return upstream.toString();
}

export async function onRequestGet({ request }) {
    const incoming = new URL(request.url);
    const text = incoming.searchParams.get('q') || '';
    const language = incoming.searchParams.get('tl') || '';

    if (!text || text.length > 5000 || !/^[a-z]{2,3}(?:-[A-Z]{2,4})?$/.test(language)) {
        return json({ error: 'Invalid translation request' }, 400);
    }

    let lastStatus = 502;
    for (const provider of TRANSLATION_PROVIDERS) {
        try {
            const response = await fetch(providerUrl(provider, language, text), {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'User-Agent': 'Mozilla/5.0 (compatible; SkyMonitor/1.0; +https://skymonitor.app/)'
                }
            });
            lastStatus = response.status;
            if (!response.ok) continue;
            const body = await response.text();
            const data = JSON.parse(body);
            if (provider.kind === 'lingva') {
                if (!data || !data.translation) continue;
                return json([[[data.translation]]], 200);
            }
            if (provider.kind === 'chrome') {
                const translated = data && data[0] && data[0][0];
                if (!translated) continue;
                return json([[[translated]]], 200);
            }
            return new Response(body, { status: 200, headers: JSON_HEADERS });
        } catch (error) {
            // Try the next provider if the current relay is unavailable.
        }
    }

    return json({ error: 'Translation provider unavailable', upstreamStatus: lastStatus }, 502);
}
