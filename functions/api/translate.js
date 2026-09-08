const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=86400, s-maxage=86400'
};

const TRANSLATION_HOSTS = [
    'https://translate.googleapis.com',
    'https://translate.google.com'
];
const MYMEMORY_HOST = 'https://api.mymemory.translated.net';

function json(body, status) {
    return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: JSON_HEADERS
    });
}

function googleUrl(host, language, text) {
    const upstream = new URL(host + '/translate_a/single');
    upstream.searchParams.set('client', 'gtx');
    upstream.searchParams.set('sl', 'auto');
    upstream.searchParams.set('tl', language);
    upstream.searchParams.set('dt', 't');
    upstream.searchParams.set('q', text);
    return upstream;
}

function myMemoryUrl(language, text) {
    const upstream = new URL(MYMEMORY_HOST + '/get');
    upstream.searchParams.set('q', text);
    upstream.searchParams.set('langpair', 'auto|' + language);
    return upstream;
}

export async function onRequestGet({ request }) {
    const incoming = new URL(request.url);
    const text = incoming.searchParams.get('q') || '';
    const language = incoming.searchParams.get('tl') || '';

    if (!text || text.length > 5000 || !/^[a-z]{2,3}(?:-[A-Z]{2,4})?$/.test(language)) {
        return json({ error: 'Invalid translation request' }, 400);
    }

    let lastStatus = 502;
    for (const host of TRANSLATION_HOSTS) {
        try {
            const response = await fetch(googleUrl(host, language, text).toString(), {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'User-Agent': 'Mozilla/5.0 (compatible; SkyMonitor/1.0; +https://skymonitor.app/)'
                }
            });
            lastStatus = response.status;
            if (response.ok) {
                return new Response(await response.text(), {
                    status: 200,
                    headers: JSON_HEADERS
                });
            }
        } catch (error) {
            // Try the alternate Google host before using the fallback provider.
        }
    }

    // Google may rate-limit shared Cloudflare Pages egress IPs. MyMemory
    // provides the same small JSON shape the client already consumes, so a
    // provider throttle does not turn every interface label into a 502.
    try {
        const response = await fetch(myMemoryUrl(language, text).toString(), {
            headers: { 'Accept': 'application/json' }
        });
        lastStatus = response.status;
        if (response.ok) {
            const data = await response.json();
            const translated = data && data.responseData && data.responseData.translatedText;
            if (translated) {
                return json([[[translated]]], 200);
            }
        }
    } catch (error) {
        // Return a useful gateway error only when every provider fails.
    }

    return json({ error: 'Translation provider unavailable', upstreamStatus: lastStatus }, 502);
}
