const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=86400, s-maxage=86400'
};

const TRANSLATION_HOSTS = [
    'https://translate.googleapis.com',
    'https://translate.google.com'
];

function json(body, status) {
    return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: JSON_HEADERS
    });
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
        const upstream = new URL(host + '/translate_a/single');
        upstream.searchParams.set('client', 'gtx');
        upstream.searchParams.set('sl', 'auto');
        upstream.searchParams.set('tl', language);
        upstream.searchParams.set('dt', 't');
        upstream.searchParams.set('q', text);

        try {
            const response = await fetch(upstream.toString(), {
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
            // Try the alternate Google host before returning a gateway error.
        }
    }

    return json({ error: 'Translation provider unavailable', upstreamStatus: lastStatus }, 502);
}
