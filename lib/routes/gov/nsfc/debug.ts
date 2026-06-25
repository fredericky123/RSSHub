import type { Route } from '@/types';

const baseUrl = 'https://www.nsfc.gov.cn';

export const route: Route = {
    path: '/debug/:path{.+}?',
    name: 'Debug',
    example: '/nsfc/debug/p1/2857/3202/glkxbgzdt.html',
    maintainers: ['fredericky123'],
    features: { requireConfig: false, requirePuppeteer: false, antiCrawler: false, supportBT: false, supportPodcast: false, supportScihub: false },
    handler,
};

async function handler(ctx) {
    const { path = 'p1/2857/3202/glkxbgzdt.html' } = ctx.req.param();
    const target = `${baseUrl}/${path}`;

    const started = Date.now();
    const diag: Record<string, unknown> = {
        target,
        vercelRegion: process.env.VERCEL_REGION ?? '(not set / local)',
        nodeVersion: process.version,
    };

    // Raw fetch — do NOT throw on non-2xx, so we can see the real status/body.
    try {
        const res = await fetch(target, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                Referer: baseUrl,
                'Accept-Language': 'zh-CN,zh;q=0.9',
            },
            redirect: 'manual',
        });
        const body = await res.text();
        diag.ok = true;
        diag.status = res.status;
        diag.statusText = res.statusText;
        diag.location = res.headers.get('location');
        diag.server = res.headers.get('server');
        diag.contentType = res.headers.get('content-type');
        diag.bodyLength = body.length;
        diag.bodyHead = body.slice(0, 600);
        diag.hasArticleLinks = /\/p1\/(?:\d+\/)+\d+\.html/.test(body);
    } catch (error) {
        diag.ok = false;
        diag.errorName = (error as Error).name;
        diag.errorMessage = (error as Error).message;
        diag.errorCause = String((error as { cause?: unknown }).cause ?? '');
    }
    diag.elapsedMs = Date.now() - started;

    // Echo the egress IP this function actually uses (what NSFC sees).
    try {
        const ipRes = await fetch('https://api.ipify.org?format=json');
        diag.egressIp = (await ipRes.json()).ip;
    } catch (error) {
        diag.egressIp = `ip-check failed: ${(error as Error).message}`;
    }

    return {
        title: 'NSFC fetch debug',
        link: target,
        item: [
            {
                title: `status=${diag.status ?? diag.errorName} region=${diag.vercelRegion} egress=${diag.egressIp}`,
                description: `<pre>${JSON.stringify(diag, null, 2).replaceAll('<', '&lt;')}</pre>`,
                link: target,
                guid: `nsfc-debug-${started}`,
            },
        ],
    };
}
