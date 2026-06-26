import { load } from 'cheerio';

import type { Route } from '@/types';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import timezone from '@/utils/timezone';

const baseUrl = 'https://www.nsfc.gov.cn';

export const route: Route = {
    path: '/:path{.+}?',
    name: '通用',
    example: '/nsfc/p1/2857/3202/glkxbgzdt',
    parameters: { path: '页面路径，即 `nsfc.gov.cn/` 之后的部分，**结尾不用带 `.html`**，默认管理科学部「工作动态」' },
    categories: ['government'],
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['www.nsfc.gov.cn/*path'],
            target: '/:path',
        },
    ],
    maintainers: ['fredericky123'],
    url: 'nsfc.gov.cn',
    description: `国家自然科学基金委员会新站栏目列表。路径填页面 URL 中 \`nsfc.gov.cn/\` 之后的部分，**结尾不要带 \`.html\`**（否则 Folo 等阅读器会把它当网页而非订阅源）：

| 栏目 | 路由 |
| --- | --- |
| 管理科学部 工作动态 | \`/nsfc/p1/2857/3202/glkxbgzdt\` |
| 管理科学部 通知公告 | \`/nsfc/p1/2857/3203/glkxbtzgg\` |
| 业务资讯 | \`/nsfc/p1/3381/2822/tzsm1\` |`,
    handler,
};

async function handler(ctx) {
    const { path = 'p1/2857/3202/glkxbgzdt' } = ctx.req.param();

    // Subscription URL is given without a trailing .html (Folo rejects feed URLs
    // that end in .html); add it back here when fetching the real page.
    const cleanPath = path.replace(/\.html$/i, '');
    const currentUrl = `${baseUrl}/${cleanPath}.html`;
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 30;

    const $ = load(
        await ofetch(currentUrl, {
            headers: {
                Referer: baseUrl,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
        })
    );

    const seen = new Set();
    const items = [];

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        let url;
        try {
            url = new URL(href, currentUrl);
        } catch {
            return;
        }
        if (url.hostname !== 'www.nsfc.gov.cn') {
            return;
        }
        // Article pages end in a numeric id, e.g. /p1/3381/2821/123019.html;
        // column/nav pages end in a letter slug, so this skips them.
        if (!/\/p1\/(?:\d+\/)+\d+\.html$/.test(url.pathname)) {
            return;
        }
        const link = url.href;
        if (seen.has(link)) {
            return;
        }

        // Two list templates: date inside the link text ("<title><YYYY-MM-DD>")
        // or in a sibling element. Handle both.
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const inText = text.match(/(\d{4}-\d{2}-\d{2})$/);
        const title = inText ? text.replace(/\s*\d{4}-\d{2}-\d{2}$/, '').trim() : text;
        if (!title) {
            return;
        }

        let dateStr = inText ? inText[1] : '';
        if (!dateStr) {
            const block = $(el).closest('li');
            const m = (block.length ? block : $(el).parent()).text().match(/\d{4}-\d{2}-\d{2}/);
            dateStr = m ? m[0] : '';
        }

        seen.add(link);
        items.push({
            title,
            link,
            pubDate: dateStr ? timezone(parseDate(dateStr), 8) : undefined,
        });
    });

    return {
        title: $('title').first().text().trim() || '国家自然科学基金委员会',
        link: currentUrl,
        item: items.slice(0, limit),
        description: $('title').first().text().trim(),
    };
}
