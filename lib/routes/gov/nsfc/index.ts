import { load } from 'cheerio';

import type { Route } from '@/types';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import timezone from '@/utils/timezone';

const baseUrl = 'https://www.nsfc.gov.cn';

export const route: Route = {
    path: '/:path{.+}?',
    name: '通用',
    example: '/nsfc/p1/2857/3202/glkxbgzdt.html',
    parameters: { path: '页面路径，即 `nsfc.gov.cn/` 之后的部分，默认管理科学部「工作动态」' },
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
    description: `国家自然科学基金委员会新站栏目列表。路径填页面 URL 中 \`nsfc.gov.cn/\` 之后的部分，例如：

| 栏目 | 路由 |
| --- | --- |
| 管理科学部 工作动态 | \`/nsfc/p1/2857/3202/glkxbgzdt.html\` |
| 管理科学部 通知公告 | \`/nsfc/p1/2857/3203/glkxbtzgg.html\` |
| 通知说明 | \`/nsfc/p1/3381/2822/tzsm1.html\` |`,
    handler,
};

async function handler(ctx) {
    const { path = 'p1/2857/3202/glkxbgzdt.html' } = ctx.req.param();
    const currentUrl = `${baseUrl}/${path}`;
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 30;

    // Single request: the column page is server-rendered.
    const $ = load(await ofetch(currentUrl));

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
        // column/nav pages end in a letter slug (glkxbgzdt.html), so this skips them.
        if (!/\/p1\/(?:\d+\/)+\d+\.html$/.test(url.pathname)) {
            return;
        }
        const link = url.href;
        if (seen.has(link)) {
            return;
        }

        // Link text is "<title><YYYY-MM-DD>" with the date appended at the end.
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})$/);
        const title = text.replace(/\s*\d{4}-\d{2}-\d{2}$/, '').trim();
        if (!title) {
            return;
        }
        seen.add(link);

        items.push({
            title,
            link,
            pubDate: dateMatch ? timezone(parseDate(dateMatch[1]), 8) : undefined,
        });
    });

    return {
        title: $('title').first().text().trim() || '国家自然科学基金委员会',
        link: currentUrl,
        item: items.slice(0, limit),
        description: $('title').first().text().trim(),
    };
}
